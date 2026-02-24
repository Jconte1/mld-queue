import { randomUUID } from "node:crypto";
import { Prisma } from "../../../prisma/generated/client";
import { log } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getQueueSender } from "@/lib/serviceBus";
import type { EnqueueInput, JobMessage } from "@/lib/types";

const VENDOR_ID = "specbooks";

async function sendQueueMessage(messageBody: JobMessage): Promise<void> {
  const startedAt = Date.now();
  await getQueueSender().sendMessages({
    messageId: messageBody.jobId,
    body: messageBody,
    applicationProperties: {
      vendorId: VENDOR_ID,
      type: messageBody.type
    }
  });
  log("info", "gateway_job_enqueued", {
    jobId: messageBody.jobId,
    type: messageBody.type,
    vendorId: messageBody.vendorId,
    durationMs: Date.now() - startedAt
  });
}

export async function enqueueJob(input: EnqueueInput): Promise<{ jobId: string }> {
  const jobId = randomUUID();

  await prisma.job.create({
    data: {
      id: jobId,
      vendorId: VENDOR_ID,
      type: input.type,
      status: "queued",
      entityKey: input.customerId ?? input.opportunityId ?? null,
      payload: input.payload ?? null
    }
  });

  const messageBody: JobMessage = {
    jobId,
    vendorId: VENDOR_ID,
    type: input.type,
    customerId: input.customerId,
    opportunityId: input.opportunityId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    requestedAt: new Date().toISOString()
  };

  try {
    await sendQueueMessage(messageBody);
  } catch (error) {
    log("error", "gateway_job_enqueue_failed", {
      jobId,
      type: input.type,
      error: error instanceof Error ? error.message : String(error)
    });
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "Failed to enqueue"
      }
    });
    throw error;
  }

  return { jobId };
}

export async function enqueueCreateWithIdempotency(payload: Record<string, unknown>, idempotencyKey: string): Promise<{ jobId: string; reused: boolean }> {
  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      vendorId_key: {
        vendorId: VENDOR_ID,
        key: idempotencyKey
      }
    },
    select: { jobId: true }
  });

  if (existing) {
    log("info", "gateway_idempotency_reused", {
      vendorId: VENDOR_ID,
      idempotencyKey,
      jobId: existing.jobId
    });
    return { jobId: existing.jobId, reused: true };
  }

  const jobId = randomUUID();

  try {
    await prisma.$transaction([
      prisma.job.create({
        data: {
          id: jobId,
          vendorId: VENDOR_ID,
          type: "CREATE_OPPORTUNITY",
          status: "queued",
          payload
        }
      }),
      prisma.idempotencyKey.create({
        data: {
          vendorId: VENDOR_ID,
          key: idempotencyKey,
          jobId
        }
      })
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.idempotencyKey.findUnique({
        where: {
          vendorId_key: {
            vendorId: VENDOR_ID,
            key: idempotencyKey
          }
        },
        select: { jobId: true }
      });

      if (winner) {
        log("info", "gateway_idempotency_race_reused", {
          vendorId: VENDOR_ID,
          idempotencyKey,
          jobId: winner.jobId
        });
        return { jobId: winner.jobId, reused: true };
      }
    }

    throw error;
  }

  const messageBody: JobMessage = {
    jobId,
    vendorId: VENDOR_ID,
    type: "CREATE_OPPORTUNITY",
    idempotencyKey,
    payload,
    requestedAt: new Date().toISOString()
  };

  try {
    await sendQueueMessage(messageBody);
  } catch (error) {
    log("error", "gateway_job_enqueue_failed", {
      jobId,
      type: "CREATE_OPPORTUNITY",
      error: error instanceof Error ? error.message : String(error)
    });
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : "Failed to enqueue"
      }
    });
    throw error;
  }

  return { jobId, reused: false };
}

export async function enqueueCoalescedOpportunityUpdate(
  opportunityId: string,
  payload: Record<string, unknown>
): Promise<{ jobId: string; reused: boolean }> {
  let shouldEnqueue = false;
  let jobId = "";

  await prisma.$transaction(async (tx) => {
    const existingBuffer = await tx.opportunityUpdateBuffer.findUnique({
      where: { opportunityId },
      select: { pending: true, lastJobId: true }
    });

    if (existingBuffer?.pending && existingBuffer.lastJobId) {
      jobId = existingBuffer.lastJobId;
      log("info", "gateway_coalesced_update_reused", {
        opportunityId,
        jobId
      });
      await tx.opportunityUpdateBuffer.update({
        where: { opportunityId },
        data: {
          latestPayload: payload
        }
      });
      return;
    }

    jobId = randomUUID();
    shouldEnqueue = true;
    log("info", "gateway_coalesced_update_new_job", {
      opportunityId,
      jobId
    });

    if (existingBuffer) {
      await tx.opportunityUpdateBuffer.update({
        where: { opportunityId },
        data: {
          latestPayload: payload,
          pending: true,
          lastJobId: jobId
        }
      });
    } else {
      await tx.opportunityUpdateBuffer.create({
        data: {
          opportunityId,
          latestPayload: payload,
          pending: true,
          lastJobId: jobId
        }
      });
    }

    await tx.job.create({
      data: {
        id: jobId,
        vendorId: VENDOR_ID,
        type: "UPDATE_OPPORTUNITY",
        status: "queued",
        entityKey: opportunityId
      }
    });
  });

  if (!shouldEnqueue) {
    return { jobId, reused: true };
  }

  const messageBody: JobMessage = {
    jobId,
    vendorId: VENDOR_ID,
    type: "UPDATE_OPPORTUNITY",
    opportunityId,
    requestedAt: new Date().toISOString()
  };

  try {
    await sendQueueMessage(messageBody);
  } catch (error) {
    log("error", "gateway_job_enqueue_failed", {
      jobId,
      type: "UPDATE_OPPORTUNITY",
      opportunityId,
      error: error instanceof Error ? error.message : String(error)
    });
    await prisma.$transaction([
      prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : "Failed to enqueue"
        }
      }),
      prisma.opportunityUpdateBuffer.update({
        where: { opportunityId },
        data: {
          pending: false
        }
      })
    ]);
    throw error;
  }

  return { jobId, reused: false };
}

export async function getJobById(jobId: string) {
  return prisma.job.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      vendorId: true,
      type: true,
      status: true,
      result: true,
      error: true,
      createdAt: true,
      updatedAt: true
    }
  });
}
