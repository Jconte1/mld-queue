import "dotenv/config";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ServiceBusClient } from "@azure/service-bus";
import { readCustomerStateWorkbook } from "./lib/customer-state-workbook";
import type { JobMessage } from "../src/types";
import { csvLine, customerStateJobOutcome } from "./lib/customer-state-report";

const TYPE = "ERP_CORRECT_CUSTOMER_STATE";
const CONFIRM = "APPLY CUSTOMER STATE CORRECTIONS";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function positive(value: string | undefined, fallback: number, name: string, max: number) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`Invalid --${name}`);
  return number;
}

async function main() {
  const { values } = parseArgs({ options: {
    file: { type: "string" }, sheet: { type: "string", default: "Data" },
    inspect: { type: "boolean" }, preview: { type: "boolean" }, apply: { type: "boolean" },
    confirm: { type: "string" }, "queue-name": { type: "string" }, "customer-id": { type: "string" },
    limit: { type: "string" }, "spacing-ms": { type: "string" }, "timeout-seconds": { type: "string" },
    "run-id": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values.file) throw new Error("--file is required");
  if ([values.inspect, values.preview, values.apply].filter(Boolean).length > 1) throw new Error("Choose inspect, preview, or apply");
  if (values.apply && values.confirm !== CONFIRM) throw new Error(`--apply requires --confirm "${CONFIRM}"`);
  const file = path.resolve(values.file);
  const workbookHash = hash(await readFile(file));
  // Validate the whole workbook before limiting or enqueueing anything.
  const all = await readCustomerStateWorkbook(file, values.sheet);
  const requestedId = values["customer-id"]?.trim().toUpperCase();
  const filtered = requestedId ? all.filter(row => row.customerId === requestedId) : all;
  if (!filtered.length) throw new Error("Requested customer not found in workbook");
  const rows = filtered.slice(0, positive(values.limit, filtered.length, "limit", 100000));
  const spacing = positive(values["spacing-ms"], 10000, "spacing-ms", 600000);
  if (spacing < 1000) throw new Error("--spacing-ms must be at least 1000");
  const timeout = positive(values["timeout-seconds"], 300, "timeout-seconds", 3600) * 1000;
  const mode = values.apply ? "apply" : values.preview ? "preview" : "inspect";
  const expectedStates: Record<string, number> = {};
  for (const row of rows) expectedStates[row.expectedState] = (expectedStates[row.expectedState] ?? 0) + 1;
  console.log(JSON.stringify({ phase: "workbook_validated", mode, worksheet: values.sheet, workbookRows: all.length,
    selectedRows: rows.length, expectedStates, workbookHash, writesToAcumatica: mode === "apply" }, null, 2));
  if (mode === "inspect") return;

  const queue = values["queue-name"]?.trim();
  if (!queue) throw new Error("--queue-name is required: choose the queue consumed by the rebuilt worker");
  const connection = process.env.AZURE_SERVICEBUS_CONNECTION_STRING;
  if (!connection || !process.env.DATABASE_URL) throw new Error("DATABASE_URL and AZURE_SERVICEBUS_CONNECTION_STRING are required");
  const runId = values["run-id"]?.trim() || (mode === "preview" ? `preview-${Date.now()}-${randomUUID().slice(0, 8)}` : "default");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("Invalid --run-id");
  const reportDir = path.resolve("reports/customer-state-fix");
  await mkdir(reportDir, { recursive: true });
  const report = path.join(reportDir, `${mode}-${Date.now()}-${randomUUID()}.jsonl`);
  const csvReport = report.replace(/\.jsonl$/, ".csv");
  await appendFile(csvReport, "\uFEFF" + csvLine(["BA Number", "Source Row", "Original State", "Expected State", "Before State", "After State", "Outcome", "Error", "Job ID", "Reused Job"]));
  const writeCsv = (values: unknown[]) => appendFile(csvReport, csvLine(values));
  const write = async (row: unknown) => appendFile(report, `${JSON.stringify(row)}\n`);
  await write({ phase: "started", mode, workbookHash, queue, runId, selectedRows: rows.length, field: "MainContact.Address.State" });
  console.log(JSON.stringify({ phase: "queue_run_starting", queue, report, csvReport, runId, concurrency: 1, spacingMs: spacing }));
  const { prisma } = await import("../src/lib/prisma");
  const bus = new ServiceBusClient(connection);
  const sender = bus.createSender(queue);
  const counts: Record<string, number> = {};
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    // Fail before enqueue if DB migration/client has not been prepared.
    await prisma.$queryRaw`SELECT 'ERP_CORRECT_CUSTOMER_STATE'::"JobType"`;
    for (const row of rows) {
      if (interrupted) break;
      const jobId = `customer-state-${hash(`${workbookHash}:${values.sheet}:${mode}:${runId}:${queue}:${row.customerId}`).slice(0, 40)}`;
      const payload = { customerId: row.customerId, originalState: row.originalState, expectedState: row.expectedState,
        address: row.address, apply: mode === "apply" };
      let job = await prisma.job.findUnique({ where: { id: jobId } });
      let reusedJob = Boolean(job);
      if (!job) {
        let created = false;
        // Unique deterministic ID makes repeat invocations reuse the same queued job.
        try {
          job = await prisma.job.create({ data: { id: jobId, vendorId: "specbooks", type: TYPE,
            entityKey: row.customerId, status: "queued", payload } });
          created = true;
        } catch (error) {
          job = await prisma.job.findUnique({ where: { id: jobId } });
          if (!job) throw error;
          reusedJob = true;
        }
        // Only the creator sends; an existing queued job must not be duplicated.
        if (created) {
          const message: JobMessage = { jobId, vendorId: "specbooks", type: TYPE, payload, requestedAt: new Date().toISOString() };
          await sender.sendMessages({ messageId: jobId, body: message, applicationProperties: { vendorId: "specbooks", type: TYPE } });
        }
      }
      const deadline = Date.now() + timeout;
      while (job.status === "queued" || job.status === "processing") {
        if (Date.now() >= deadline || interrupted) {
          await write({ customerId: row.customerId, sourceRow: row.sourceRow, jobId, phase: "waiting_stopped", status: job.status });
          await writeCsv([row.customerId, row.sourceRow, row.originalState, row.expectedState, "", "", "pending_unknown", "Stopped waiting; queued job may still execute", jobId, reusedJob]);
          throw new Error(`Stopped waiting for ${jobId}; no further jobs queued. The existing job may still execute. Inspect it before retrying.`);
        }
        await sleep(2000);
        job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      }
      await write({ customerId: row.customerId, sourceRow: row.sourceRow, jobId, reusedJob, status: job.status, result: job.result, error: job.error });
      const { outcome, error, result } = customerStateJobOutcome(job);
      await writeCsv([row.customerId, row.sourceRow, row.originalState, row.expectedState,
        result.beforeState, result.afterState, outcome, error, jobId, reusedJob]);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      console.log(JSON.stringify({ customerId: row.customerId, sourceRow: row.sourceRow, jobId, reusedJob, outcome }));
      await sleep(spacing);
    }
    const phase = interrupted ? "interrupted" : counts.failed ? "completed_with_errors" : "completed";
    await write({ phase, counts, csvReport });
    console.log(JSON.stringify({ ok: !interrupted && !counts.failed, phase, counts, report, csvReport }, null, 2));
    if (interrupted || counts.failed) process.exitCode = 1;
  } catch (error) {
    await write({ phase: "failed", counts, error: error instanceof Error ? error.message : "Unknown failure" });
    console.error(JSON.stringify({ ok: false, phase: "failed", counts, report, csvReport }));
    throw error;
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await sender.close(); await bus.close(); await prisma.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Customer state correction failed"); process.exitCode = 1; });
