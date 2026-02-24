import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCreateWithIdempotency } from "@/lib/jobs";
import { createOpportunitySchema, parseJsonBodyWithLimit } from "@/lib/validation";

export async function POST(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    const idempotencyKey = req.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
    }

    const { parsed } = await parseJsonBodyWithLimit(req, createOpportunitySchema);

    await assertRouteWithinRateLimit("specbooks", "CREATE_OPPORTUNITY");

    const { jobId } = await enqueueCreateWithIdempotency(
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