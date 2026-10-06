import "dotenv/config";

import { ServiceBusClient } from "@azure/service-bus";
import { randomUUID } from "node:crypto";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";
import type { JobMessage } from "../src/types";

const JOB_TYPE = "ERP_SYNC_ACTIVE_VENDORS" as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

async function waitForJob(jobId: string): Promise<void> {
  while (true) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true, result: true, error: true },
    });
    if (!job) throw new Error(`Vendor sync job disappeared: ${jobId}`);

    if (job.status === "succeeded") {
      console.log(JSON.stringify({ ok: true, jobId, status: job.status, result: job.result }, null, 2));
      return;
    }
    if (job.status === "failed") {
      throw new Error(job.error || `Vendor sync job failed: ${jobId}`);
    }

    console.log(JSON.stringify({ phase: "waiting", jobId, status: job.status }));
    await sleep(3000);
  }
}

async function main(): Promise<void> {
  const jobId = randomUUID();
  await prisma.job.create({
    data: {
      id: jobId,
      vendorId: "specbooks",
      type: JOB_TYPE,
      status: "queued",
      entityKey: "active-vendors",
      payload: {},
    },
  });

  const serviceBus = new ServiceBusClient(env.serviceBusConnectionString);
  const sender = serviceBus.createSender(env.queueName);
  try {
    const message: JobMessage = {
      jobId,
      vendorId: "specbooks",
      type: JOB_TYPE,
      payload: {},
      requestedAt: new Date().toISOString(),
    };
    await sender.sendMessages({
      messageId: jobId,
      body: message,
      applicationProperties: { vendorId: "specbooks", type: JOB_TYPE },
    });
  } catch (error) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: "failed", error: cleanError(error) },
    });
    throw error;
  } finally {
    await sender.close();
    await serviceBus.close();
  }

  console.log(JSON.stringify({ ok: true, phase: "enqueued", jobId, queue: env.queueName }, null, 2));
  await waitForJob(jobId);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: cleanError(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
