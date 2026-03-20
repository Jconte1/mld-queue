import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCreateStockItemWithIdempotency, enqueueJob } from "@/lib/jobs";
import { log } from "@/lib/logger";
import { createStockItemSchema, parseJsonBodyWithLimit } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || null;

    const { parsed } = await parseJsonBodyWithLimit(req, createStockItemSchema);

    await assertRouteWithinRateLimit("specbooks", "CREATE_STOCK_ITEM");

    let jobId: string;
    if (idempotencyKey) {
      ({ jobId } = await enqueueCreateStockItemWithIdempotency(
        parsed as Record<string, unknown>,
        idempotencyKey
      ));
    } else {
      ({ jobId } = await enqueueJob({
        type: "CREATE_STOCK_ITEM",
        payload: parsed as Record<string, unknown>,
        routeKey: "CREATE_STOCK_ITEM",
      }));
      log("info", "gateway_idempotency_not_provided", {
        endpoint: "CREATE_STOCK_ITEM",
        mode: "non_idempotent",
        jobId,
      });
    }

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
