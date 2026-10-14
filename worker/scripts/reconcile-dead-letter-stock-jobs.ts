import "dotenv/config";
import { ServiceBusClient } from "@azure/service-bus";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/lib/env";

async function main() {
  const apply = process.env.RECONCILE_DEAD_LETTER_APPLY === "true";
  const jobs = await prisma.job.findMany({ where: { type: "CREATE_STOCK_ITEM", status: "queued" } });
  const byId = new Map(jobs.map(job => [job.id, job]));
  const serviceBus = new ServiceBusClient(env.serviceBusConnectionString);
  const receiver = serviceBus.createReceiver(env.queueName, { subQueueType: "deadLetter" });
  const failures = new Map<string, { reason: string; description: string; deliveryCount: number }>();
  let scanned = 0;
  try {
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await receiver.peekMessages(200);
      scanned += page.length;
      for (const message of page) {
        const id = message.body?.jobId;
        if (byId.has(id) && message.deadLetterReason === "MaxDeliveryCountExceeded") {
          failures.set(id, { reason: message.deadLetterReason,
            description: message.deadLetterErrorDescription ?? "",
            deliveryCount: message.deliveryCount ?? 0 });
        }
      }
      if (!page.length || failures.size === byId.size) break;
    }
  } finally {
    await receiver.close();
    await serviceBus.close();
  }
  let updatedCount = 0;
  if (apply && failures.size) {
    const updates = await prisma.$transaction([...failures].map(([id, failure]) => {
      const job = byId.get(id)!;
      return prisma.job.updateMany({
        where: { id, status: "queued", updatedAt: job.updatedAt },
        data: { status: "failed", error: `Retries exhausted after ${failure.deliveryCount} deliveries: ${job.error ?? failure.description}`.slice(0, 60000),
          result: { name: "JobRetriesExhaustedError", retriesExhausted: true,
            error: job.error, attempt: failure.deliveryCount,
            deadLetterReason: failure.reason, deadLetterErrorDescription: failure.description,
            reconciledAt: new Date().toISOString() } },
      });
    }));
    updatedCount = updates.reduce((count, update) => count + update.count, 0);
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", scanned,
    queuedStockJobs: jobs.length, matchedDeadLetters: failures.size, updatedCount,
    jobsNotFoundInDeadLetters: jobs.filter(job => !failures.has(job.id)).map(job => job.id),
    deadLetterMessagesUnchanged: true }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
