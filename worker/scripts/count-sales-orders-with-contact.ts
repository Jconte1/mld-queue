import "dotenv/config";
import {
  ServiceBusAdministrationClient,
  ServiceBusClient,
  type ServiceBusReceivedMessage,
} from "@azure/service-bus";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../prisma/generated/client";
import { AcumaticaClient } from "../src/lib/acumaticaClient";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";
import type { JobMessage } from "../src/types";

const JOB_TYPE = "ERP_COUNT_OPEN_SALES_ORDERS_WITH_CONTACT";
const DEFAULT_STATUSES = ["Open", "Back Order", "Shipping", "On Hold but Approved"];
const DEFAULT_EXCLUDED_ORDER_TYPES = ["QT"];
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_STORED_ERROR_CHARS = 60000;

type ParsedArgs = {
  endpoint: "read" | "delivery-sales-order";
  statuses: string[];
  excludedOrderTypes: string[];
  pageSize: number;
  maxPages: number;
  preferServerCount: boolean;
  timeoutMs: number;
  queueName: string | null;
};

function readArg(name: string): string | null {
  const argv = process.argv.slice(2);
  const inline = argv.find((value) => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);

  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) return next;
  }

  return null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function readStringList(name: string, fallback: string[]): string[] {
  const raw = readArg(name);
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

function readPositiveInt(name: string, fallback: number, max: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function parseEndpoint(): ParsedArgs["endpoint"] {
  const raw = String(readArg("endpoint") || "read").trim().toLowerCase();
  if (["delivery", "delivery-sales-order", "deliverysalesorder"].includes(raw)) {
    return "delivery-sales-order";
  }
  return "read";
}

function parseArgs(): ParsedArgs {
  return {
    endpoint: parseEndpoint(),
    statuses: readStringList("statuses", DEFAULT_STATUSES),
    excludedOrderTypes: readStringList("excluded-order-types", DEFAULT_EXCLUDED_ORDER_TYPES),
    pageSize: readPositiveInt("page-size", 500, 1000),
    maxPages: readPositiveInt("max-pages", 10000, 100000),
    preferServerCount: !hasFlag("no-server-count"),
    timeoutMs: readPositiveInt("timeout-ms", DEFAULT_TIMEOUT_MS, 60 * 60 * 1000),
    queueName: readArg("queue-name"),
  };
}

function toPrismaJsonValue(value: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function temporaryQueueName(): string {
  return `mld-one-time-so-contact-count-${Date.now()}-${randomUUID().slice(0, 8)}`.toLowerCase();
}

async function createTemporaryQueue(adminClient: ServiceBusAdministrationClient): Promise<string> {
  const queueName = temporaryQueueName();
  await adminClient.createQueue(queueName, {
    defaultMessageTimeToLive: "PT30M",
    lockDuration: "PT5M",
    maxDeliveryCount: 5,
  });
  return queueName;
}

async function waitForOwnMessage(
  receiver: ReturnType<ServiceBusClient["createReceiver"]>,
  jobId: string,
  timeoutMs: number
): Promise<ServiceBusReceivedMessage> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const messages = await receiver.receiveMessages(5, {
      maxWaitTimeInMs: Math.max(1, Math.min(5000, remainingMs)),
    });

    for (const message of messages) {
      const body = message.body as Partial<JobMessage> | undefined;
      if (body?.jobId === jobId) return message;
      await receiver.abandonMessage(message);
    }
  }

  throw new Error(`Timed out waiting for queued count job ${jobId}`);
}

async function createJob(payload: Record<string, unknown>): Promise<string> {
  const jobId = randomUUID();
  type JobCreateData = Parameters<typeof prisma.job.create>[0]["data"];

  await prisma.job.create({
    data: {
      id: jobId,
      vendorId: "specbooks",
      type: JOB_TYPE as JobCreateData["type"],
      status: "queued",
      payload: toPrismaJsonValue(payload),
    },
  });

  return jobId;
}

async function markProcessing(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "processing" },
  });
}

async function markSuccess(jobId: string, result: unknown): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      result: toPrismaJsonValue(result),
      error: null,
    },
  });
}

async function markFailure(jobId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: "failed",
      error: message.slice(0, MAX_STORED_ERROR_CHARS),
      result: toPrismaJsonValue({ error: message }),
    },
  });
}

async function processCountMessage(
  receiver: ReturnType<ServiceBusClient["createReceiver"]>,
  message: ServiceBusReceivedMessage,
  fallbackPayload: Record<string, unknown>
): Promise<unknown> {
  const body = message.body as Partial<JobMessage> | undefined;
  const jobId = body?.jobId;
  if (!jobId) throw new Error("Queued message is missing jobId");

  await markProcessing(jobId);

  try {
    const acumaticaClient = new AcumaticaClient();
    const result = await acumaticaClient.countOpenSalesOrdersWithContact(
      body.payload ?? fallbackPayload
    );
    await markSuccess(jobId, result);
    await receiver.completeMessage(message);
    return result;
  } catch (error) {
    await markFailure(jobId, error);
    await receiver.completeMessage(message);
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const payload: Record<string, unknown> = {
    endpoint: args.endpoint,
    statuses: args.statuses,
    excludedOrderTypes: args.excludedOrderTypes,
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    preferServerCount: args.preferServerCount,
  };

  const adminClient = args.queueName
    ? null
    : new ServiceBusAdministrationClient(env.serviceBusConnectionString);
  const queueName = args.queueName ?? (await createTemporaryQueue(adminClient!));
  const temporaryQueue = !args.queueName;
  const serviceBusClient = new ServiceBusClient(env.serviceBusConnectionString);
  const sender = serviceBusClient.createSender(queueName);
  const receiver = serviceBusClient.createReceiver(queueName, { receiveMode: "peekLock" });
  const jobId = await createJob(payload);
  const messageBody: JobMessage = {
    jobId,
    vendorId: "specbooks",
    type: JOB_TYPE,
    payload,
    requestedAt: new Date().toISOString(),
  };

  try {
    console.log(
      JSON.stringify(
        {
          step: "queued-read-only-sales-order-contact-count",
          jobId,
          jobType: JOB_TYPE,
          queueName,
          temporaryQueue,
          endpoint: args.endpoint,
          statuses: args.statuses,
          excludedOrderTypes: args.excludedOrderTypes,
          pageSize: args.pageSize,
          preferServerCount: args.preferServerCount,
        },
        null,
        2
      )
    );

    await sender.sendMessages({
      messageId: jobId,
      body: messageBody,
      applicationProperties: {
        vendorId: "specbooks",
        type: JOB_TYPE,
      },
      timeToLive: 30 * 60 * 1000,
    });

    const message = await waitForOwnMessage(receiver, jobId, args.timeoutMs);
    const result = await processCountMessage(receiver, message, payload);

    console.log(
      JSON.stringify(
        {
          step: "completed-read-only-sales-order-contact-count",
          jobId,
          jobType: JOB_TYPE,
          queueName,
          temporaryQueue,
          result,
          rowDetailsPrinted: false,
          acumaticaWritesPerformed: false,
        },
        null,
        2
      )
    );
  } finally {
    await sender.close().catch(() => undefined);
    await receiver.close().catch(() => undefined);
    await serviceBusClient.close().catch(() => undefined);

    if (temporaryQueue && adminClient) {
      await adminClient.deleteQueue(queueName).catch((error) => {
        console.error(
          JSON.stringify({
            warning: "temporary-queue-delete-failed",
            queueName,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      });
    }

    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    JSON.stringify(
      {
        error: "sales-order-contact-count-failed",
        details: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
