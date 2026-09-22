import "dotenv/config";

import { ServiceBusClient } from "@azure/service-bus";
import { randomUUID } from "node:crypto";

import { Prisma } from "../../prisma/generated/client";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/prisma";
import type { JobMessage } from "../src/types";

const JOB_TYPE = "ERP_BACKFILL_SALES_ORDER_CONTACTS_RUN" as const;
const CHILD_JOB_TYPE = "ERP_BACKFILL_SALES_ORDER_CONTACT" as const;
const APPLY_CONFIRMATION = "RUN SALES ORDER CONTACT BACKFILL";

type Args = {
  apply: boolean;
  confirm: string | null;
  wait: boolean;
  limit: number | null;
  pageSize: number;
  maxPages: number;
  spacingMs: number;
  orderTypes: string[] | null;
  orderType: string | null;
  orderNumber: string | null;
};

function argValue(name: string): string | null {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3).trim() || null;
  const index = args.indexOf(`--${name}`);
  const next = index >= 0 ? args[index + 1] : null;
  return next && !next.startsWith("--") ? next.trim() || null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function positiveInt(name: string, fallback: number, max: number): number {
  const parsed = Number(argValue(name));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.trunc(parsed), max) : fallback;
}

function parseArgs(): Args {
  const limitRaw = argValue("limit");
  const limit = limitRaw ? Number(limitRaw) : null;
  if (limitRaw && (!Number.isInteger(limit) || Number(limit) <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const orderTypesRaw = argValue("order-types");
  return {
    apply: hasFlag("apply"),
    confirm: argValue("confirm"),
    wait: hasFlag("wait"),
    limit,
    pageSize: positiveInt("page-size", 100, 500),
    maxPages: positiveInt("max-pages", 1000, 10000),
    spacingMs: positiveInt("spacing-ms", 10_000, 60_000),
    orderTypes: orderTypesRaw
      ? orderTypesRaw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean)
      : null,
    orderType: argValue("order-type")?.toUpperCase() ?? null,
    orderNumber: argValue("order-number")?.toUpperCase() ?? null,
  };
}

function jsonValue(value: unknown): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (value === null || value === undefined) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}

async function waitForRun(parentJobId: string): Promise<void> {
  let parentFinished = false;
  while (true) {
    const parent = await prisma.job.findUnique({
      where: { id: parentJobId },
      select: { status: true, result: true, error: true },
    });
    if (!parent) throw new Error("Parent backfill job disappeared");
    if (parent.status === "failed") throw new Error(parent.error || "Parent backfill job failed");
    if (parent.status === "succeeded") parentFinished = true;

    const grouped = await prisma.job.groupBy({
      by: ["status"],
      where: { type: CHILD_JOB_TYPE, entityKey: parentJobId },
      _count: { _all: true },
    });
    const statusCounts = Object.fromEntries(grouped.map((group) => [group.status, group._count._all]));
    const active = (statusCounts.queued ?? 0) + (statusCounts.processing ?? 0);
    console.log(JSON.stringify({
      phase: "monitoring",
      parentJobId,
      parentStatus: parent.status,
      children: statusCounts,
      sensitiveValuesPrinted: false,
    }));

    if (parentFinished && active === 0) {
      const childRows = await prisma.job.findMany({
        where: { type: CHILD_JOB_TYPE, entityKey: parentJobId },
        select: { status: true, result: true },
      });
      const outcomes: Record<string, number> = {};
      for (const child of childRows) {
        const result = child.result as { status?: unknown; reason?: unknown } | null;
        const outcome = child.status === "failed"
          ? "failed"
          : result?.status === "skipped"
            ? `skipped:${String(result.reason ?? "unknown")}`
            : String(result?.status ?? child.status);
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      }
      console.log(JSON.stringify({
        ok: (statusCounts.failed ?? 0) === 0,
        phase: "completed",
        parentJobId,
        parentResult: parent.result,
        childStatusCounts: statusCounts,
        outcomes,
        sensitiveValuesPrinted: false,
      }, null, 2));
      return;
    }
    await sleep(5000);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.apply && args.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm "${APPLY_CONFIRMATION}"`);
  }
  if ((args.orderType && !args.orderNumber) || (!args.orderType && args.orderNumber)) {
    throw new Error("--order-type and --order-number must be supplied together");
  }

  const parentJobId = randomUUID();
  const payload: Record<string, unknown> = {
    apply: args.apply,
    limit: args.limit,
    pageSize: args.pageSize,
    maxPages: args.maxPages,
    spacingMs: args.spacingMs,
    orderTypes: args.orderTypes,
    orderType: args.orderType,
    orderNumber: args.orderNumber,
  };
  await prisma.job.create({
    data: {
      id: parentJobId,
      vendorId: "specbooks",
      type: JOB_TYPE,
      status: "queued",
      entityKey: args.apply ? "sales-order-contact-backfill:apply" : "sales-order-contact-backfill:preview",
      payload: jsonValue(payload),
    },
  });

  const serviceBus = new ServiceBusClient(env.serviceBusConnectionString);
  const sender = serviceBus.createSender(env.queueName);
  try {
    const message: JobMessage = {
      jobId: parentJobId,
      vendorId: "specbooks",
      type: JOB_TYPE,
      payload,
      requestedAt: new Date().toISOString(),
    };
    await sender.sendMessages({
      messageId: parentJobId,
      body: message,
      applicationProperties: { vendorId: "specbooks", type: JOB_TYPE },
    });
  } catch (error) {
    await prisma.job.update({
      where: { id: parentJobId },
      data: { status: "failed", error: cleanError(error), result: jsonValue({ enqueueFailed: true }) },
    });
    throw error;
  } finally {
    await sender.close();
    await serviceBus.close();
  }

  console.log(JSON.stringify({
    ok: true,
    phase: "parent_enqueued",
    parentJobId,
    mode: args.apply ? "apply" : "preview",
    queue: env.queueName,
    wait: args.wait,
    sensitiveValuesPrinted: false,
  }, null, 2));

  if (args.wait) await waitForRun(parentJobId);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, phase: "failed", error: cleanError(error), sensitiveValuesPrinted: false }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
