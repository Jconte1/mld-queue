import { ServiceBusClient, ServiceBusReceivedMessage, ProcessErrorArgs } from "@azure/service-bus";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../prisma/generated/client";
import { prisma } from "./lib/prisma";
import { env } from "./lib/env";
import { log } from "./lib/logger";
import { AcumaticaClient, isTransientError } from "./lib/acumaticaClient";
import { Semaphore, TokenBucket } from "./lib/throttle";
import type { JobMessage } from "./types";

const serviceBusClient = new ServiceBusClient(env.serviceBusConnectionString);
const receiver = serviceBusClient.createReceiver(env.queueName, { receiveMode: "peekLock" });
const sender = serviceBusClient.createSender(env.queueName);

const acumaticaClient = new AcumaticaClient();

const vendorSemaphore = new Semaphore(env.vendorMaxConcurrency);
const globalSemaphore = new Semaphore(env.globalMaxConcurrency);
const vendorBucket = new TokenBucket(env.vendorMaxRpm);
const globalBucket = new TokenBucket(env.globalMaxRpm);

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

async function markProcessing(jobId: string) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "processing"
    }
  });
}

async function markSuccess(jobId: string, result: unknown) {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      result: toPrismaJsonValue(result),
      error: null
    }
  });
}

async function markFailure(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "failed",
      error: message.slice(0, 4000)
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enqueueUpdateFollowUp(opportunityId: string): Promise<void> {
  const jobId = randomUUID();

  await prisma.job.create({
    data: {
      id: jobId,
      vendorId: "specbooks",
      type: "UPDATE_OPPORTUNITY",
      status: "queued",
      entityKey: opportunityId
    }
  });

  const body: JobMessage = {
    jobId,
    vendorId: "specbooks",
    type: "UPDATE_OPPORTUNITY",
    opportunityId,
    requestedAt: new Date().toISOString()
  };

  await sender.sendMessages({
    messageId: jobId,
    body,
    applicationProperties: {
      vendorId: "specbooks",
      type: "UPDATE_OPPORTUNITY"
    }
  });

  await prisma.opportunityUpdateBuffer.update({
    where: { opportunityId },
    data: { lastJobId: jobId }
  });

  log("info", "coalesced_update_followup_enqueued", {
    opportunityId,
    jobId
  });
}

async function getLatestDebouncedPayload(opportunityId: string): Promise<{ payload: Record<string, unknown>; updatedAt: Date } | null> {
  let waitIterations = 0;
  let totalWaitMs = 0;
  while (true) {
    const row = await prisma.opportunityUpdateBuffer.findUnique({
      where: { opportunityId },
      select: { latestPayload: true, updatedAt: true, pending: true }
    });

    if (!row) {
      return null;
    }

    if (!row.pending) {
      return null;
    }

    const ageMs = Date.now() - row.updatedAt.getTime();
    if (ageMs >= env.updateCoalesceWindowMs) {
      if (waitIterations > 0) {
        log("info", "coalesced_update_debounce_wait_completed", {
          opportunityId,
          waitIterations,
          totalWaitMs
        });
      }
      return {
        payload: row.latestPayload as Record<string, unknown>,
        updatedAt: row.updatedAt
      };
    }

    const sleepMs = Math.max(env.updateCoalesceWindowMs - ageMs, 25);
    waitIterations += 1;
    totalWaitMs += sleepMs;
    await sleep(sleepMs);
  }
}

async function processCoalescedOpportunityUpdate(
  opportunityId: string,
  fallbackPayload?: Record<string, unknown>
): Promise<unknown> {
  const latest = await getLatestDebouncedPayload(opportunityId);

  if (!latest) {
    if (!fallbackPayload) {
      throw new Error(`No buffered payload found for opportunityId=${opportunityId}`);
    }
    return acumaticaClient.updateOpportunity(opportunityId, fallbackPayload);
  }

  const { payload, updatedAt } = latest;
  log("info", "coalesced_update_processing", {
    opportunityId,
    updatedAt: updatedAt.toISOString()
  });
  const result = await acumaticaClient.updateOpportunity(opportunityId, payload);

  const settled = await prisma.opportunityUpdateBuffer.updateMany({
    where: {
      opportunityId,
      pending: true,
      updatedAt
    },
    data: {
      pending: false
    }
  });

  if (settled.count === 0) {
    log("warn", "coalesced_update_superseded_requeue", {
      opportunityId
    });
    await enqueueUpdateFollowUp(opportunityId);
  }

  return result;
}

async function processJob(message: JobMessage): Promise<unknown> {
  switch (message.type) {
    case "GET_CUSTOMER":
      if (!message.customerId) throw new Error("customerId is required");
      return acumaticaClient.getCustomer(message.customerId);

    case "GET_OPPORTUNITY":
      if (!message.opportunityId) throw new Error("opportunityId is required");
      return acumaticaClient.getOpportunity(message.opportunityId);

    case "CREATE_OPPORTUNITY":
      if (!message.payload) throw new Error("payload is required");
      return acumaticaClient.createOpportunity(message.payload);

    case "UPDATE_OPPORTUNITY":
      if (!message.opportunityId) throw new Error("opportunityId is required");
      return processCoalescedOpportunityUpdate(message.opportunityId, message.payload);

    case "ERP_GET_ORDER_HEADER": {
      const orderNbr = String(message.payload?.orderNbr || "").trim().toUpperCase();
      if (!orderNbr) throw new Error("orderNbr is required");
      const row = await acumaticaClient.fetchOrderHeaderByOrderNbr(orderNbr);
      return { found: Boolean(row), row };
    }

    case "ERP_GET_PAYMENT_INFO": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const orderNbrs = Array.isArray(message.payload?.orderNbrs)
        ? (message.payload?.orderNbrs as unknown[])
            .map((v) => String(v || "").trim().toUpperCase())
            .filter(Boolean)
        : [];
      if (!baid) throw new Error("baid is required");
      return { rows: await acumaticaClient.fetchPaymentInfoRows(baid, orderNbrs) };
    }

    case "ERP_GET_INVENTORY_DETAILS": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const orderNbrs = Array.isArray(message.payload?.orderNbrs)
        ? (message.payload?.orderNbrs as unknown[])
            .map((v) => String(v || "").trim().toUpperCase())
            .filter(Boolean)
        : [];
      if (!baid) throw new Error("baid is required");
      return { rows: await acumaticaClient.fetchInventoryDetailsRows(baid, orderNbrs) };
    }

    case "ERP_GET_ORDER_SUMMARIES": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const pageSize = Number(message.payload?.pageSize ?? 250);
      const maxPages = Number(message.payload?.maxPages ?? 50);
      const useOrderBy = Boolean(message.payload?.useOrderBy);
      if (!baid) throw new Error("baid is required");
      return { rows: await acumaticaClient.fetchOrderSummariesRows(baid, pageSize, maxPages, useOrderBy) };
    }

    case "ERP_GET_ORDER_SUMMARIES_DELTA": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const since = String(message.payload?.since || "").trim();
      const pageSize = Number(message.payload?.pageSize ?? 250);
      const maxPages = Number(message.payload?.maxPages ?? 50);
      const useOrderBy = Boolean(message.payload?.useOrderBy);
      if (!baid || !since) throw new Error("baid and since are required");
      return { rows: await acumaticaClient.fetchOrderSummariesDeltaRows(baid, since, pageSize, maxPages, useOrderBy) };
    }

    case "ERP_GET_ADDRESS_CONTACT": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const orderNbrs = Array.isArray(message.payload?.orderNbrs)
        ? (message.payload?.orderNbrs as unknown[])
            .map((v) => String(v || "").trim().toUpperCase())
            .filter(Boolean)
        : [];
      const cutoffLiteral = message.payload?.cutoffLiteral ? String(message.payload.cutoffLiteral) : null;
      const useOrderBy = Boolean(message.payload?.useOrderBy);
      const pageSize = Number(message.payload?.pageSize ?? 500);
      if (!baid) throw new Error("baid is required");
      return { rows: await acumaticaClient.fetchAddressContactRows(baid, orderNbrs, cutoffLiteral, useOrderBy, pageSize) };
    }

    case "ERP_GET_ORDER_LAST_MODIFIED": {
      const baid = String(message.payload?.baid || "").trim().toUpperCase();
      const orderNbr = String(message.payload?.orderNbr || "").trim().toUpperCase();
      if (!baid || !orderNbr) throw new Error("baid and orderNbr are required");
      const lastModified = await acumaticaClient.fetchOrderLastModifiedRaw(baid, orderNbr);
      return { lastModified };
    }

    case "ERP_GET_ORDER_READY_REPORT": {
      return { rows: await acumaticaClient.fetchOrderReadyReportRows() };
    }

    case "ERP_VERIFY_CUSTOMER": {
      const customerId = String(message.payload?.customerId || "").trim().toUpperCase();
      const zip5 = String(message.payload?.zip5 || "").replace(/\D/g, "").slice(0, 5);
      if (!customerId || zip5.length !== 5) throw new Error("customerId and zip5 are required");
      const matched = await acumaticaClient.verifyCustomerByZip(customerId, zip5);
      return { ok: true, matched };
    }

    default:
      throw new Error(`Unsupported job type: ${(message as { type?: string }).type ?? "unknown"}`);
  }
}

async function handleMessage(received: ServiceBusReceivedMessage): Promise<void> {
  const startedAt = Date.now();
  const message = received.body as JobMessage;

  if (!message?.jobId || !message?.type || !message?.vendorId) {
    throw new Error("Invalid queue message shape");
  }

  log("info", "job_received", {
    jobId: message.jobId,
    type: message.type,
    vendorId: message.vendorId,
    deliveryCount: received.deliveryCount ?? null
  });

  await markProcessing(message.jobId);

  const globalSemaphoreWaitStart = Date.now();
  await globalSemaphore.acquire();
  const globalSemaphoreWaitMs = Date.now() - globalSemaphoreWaitStart;

  const vendorSemaphoreWaitStart = Date.now();
  await vendorSemaphore.acquire();
  const vendorSemaphoreWaitMs = Date.now() - vendorSemaphoreWaitStart;

  try {
    const globalBucketWaitStart = Date.now();
    await globalBucket.take();
    const globalBucketWaitMs = Date.now() - globalBucketWaitStart;

    const vendorBucketWaitStart = Date.now();
    await vendorBucket.take();
    const vendorBucketWaitMs = Date.now() - vendorBucketWaitStart;

    if (
      globalSemaphoreWaitMs > 250 ||
      vendorSemaphoreWaitMs > 250 ||
      globalBucketWaitMs > 250 ||
      vendorBucketWaitMs > 250
    ) {
      log("warn", "throttle_wait_observed", {
        jobId: message.jobId,
        type: message.type,
        globalSemaphoreWaitMs,
        vendorSemaphoreWaitMs,
        globalBucketWaitMs,
        vendorBucketWaitMs,
        limits: {
          globalMaxConcurrency: env.globalMaxConcurrency,
          vendorMaxConcurrency: env.vendorMaxConcurrency,
          globalMaxRpm: env.globalMaxRpm,
          vendorMaxRpm: env.vendorMaxRpm
        }
      });
    }

    const result = await processJob(message);
    await markSuccess(message.jobId, result);
    await receiver.completeMessage(received);

    log("info", "job_succeeded", {
      jobId: message.jobId,
      vendorId: message.vendorId,
      type: message.type,
      durationMs: Date.now() - startedAt,
      outcome: "succeeded"
    });
  } catch (error) {
    const transient = isTransientError(error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (transient) {
      log("warn", "job_retry_scheduled", {
        jobId: message.jobId,
        type: message.type,
        deliveryCount: received.deliveryCount ?? null,
        error: errorMessage
      });
      await prisma.job.update({
        where: { id: message.jobId },
        data: {
          status: "queued",
          error: errorMessage.slice(0, 4000)
        }
      });
      await receiver.abandonMessage(received);
    } else {
      await markFailure(message.jobId, error);

      if (message.type === "UPDATE_OPPORTUNITY" && message.opportunityId) {
        await prisma.opportunityUpdateBuffer.updateMany({
          where: { opportunityId: message.opportunityId },
          data: { pending: false }
        });
      }

      await receiver.completeMessage(received);
    }

    log("error", "job_failed", {
      jobId: message.jobId,
      vendorId: message.vendorId,
      type: message.type,
      durationMs: Date.now() - startedAt,
      outcome: "failed",
      retryable: transient,
      error: errorMessage
    });
  } finally {
    vendorSemaphore.release();
    globalSemaphore.release();
  }
}

function handleError(args: ProcessErrorArgs): void {
  log("error", "service_bus_processor_error", {
    error: args.error.message,
    entityPath: args.entityPath,
    namespace: args.fullyQualifiedNamespace
  });
}

export async function startWorker(): Promise<void> {
  receiver.subscribe(
    {
      processMessage: handleMessage,
      processError: async (args) => handleError(args)
    },
    {
      autoCompleteMessages: false,
      maxConcurrentCalls: env.globalMaxConcurrency
    }
  );

  log("info", "worker_started", {
    queue: env.queueName,
    vendorMaxConcurrency: env.vendorMaxConcurrency,
    vendorMaxRpm: env.vendorMaxRpm,
    globalMaxConcurrency: env.globalMaxConcurrency,
    globalMaxRpm: env.globalMaxRpm,
    updateCoalesceWindowMs: env.updateCoalesceWindowMs
  });
}
