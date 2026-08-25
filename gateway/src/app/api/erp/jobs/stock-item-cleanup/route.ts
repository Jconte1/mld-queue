import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { createStockItemCleanupRun } from "@/lib/stockItemCleanup";

const rawRowSchema = z.record(z.unknown());

const bodySchema = z
  .object({
    dryRun: z.boolean().optional().default(true),
    writeMode: z.boolean().optional().default(false),
    maxItems: z.number().int().positive().max(10).optional().default(10),
    maxInFlight: z.number().int().positive().max(1).optional().default(1),
    delayMs: z.number().int().min(0).max(60_000).optional().default(0),
    candidatePoolSize: z.number().int().positive().max(100).optional(),
    inventoryIds: z.array(z.string().trim().min(1)).optional(),
    rows: z.array(rawRowSchema).optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json().catch(() => ({})));
    const run = await createStockItemCleanupRun(body);

    return NextResponse.json(run, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    return NextResponse.json(
      {
        error: "Failed to create StockItem cleanup run",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
