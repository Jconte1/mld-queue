import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCreateStockItemWithIdempotency } from "@/lib/jobs";
import { createStockItemSchema, parseJsonBodyWithLimit } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
    }

    const { parsed } = await parseJsonBodyWithLimit(req, createStockItemSchema);

    await assertRouteWithinRateLimit("specbooks", "CREATE_STOCK_ITEM");

    const { jobId } = await enqueueCreateStockItemWithIdempotency(
      parsed as Record<string, unknown>,
      idempotencyKey
    );

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
