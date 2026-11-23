import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, tracePayload, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { env } from "@/lib/env";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCreateWithIdempotency, enqueueJob } from "@/lib/jobs";
import { log } from "@/lib/logger";
import {
  createOpportunitySchema,
  parseJsonBodyWithLimit,
  parseJsonObjectBodyWithLimit,
} from "@/lib/validation";

async function createOpportunity(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() || null;

    traceStage("validation");
    const { parsed } = env.specbooksOpportunityPassthrough
      ? await parseJsonObjectBodyWithLimit(req, { requireNonEmpty: true })
      : await parseJsonBodyWithLimit(req, createOpportunitySchema);

    tracePayload(parsed);
    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "CREATE_OPPORTUNITY");
    traceStage("enqueue");

    let jobId: string;
    if (idempotencyKey) {
      ({ jobId } = await enqueueCreateWithIdempotency(
        parsed as Record<string, unknown>,
        idempotencyKey
      ));
    } else {
      ({ jobId } = await enqueueJob({
        type: "CREATE_OPPORTUNITY",
        payload: parsed as Record<string, unknown>,
        routeKey: "CREATE_OPPORTUNITY",
      }));
      log("info", "gateway_idempotency_not_provided", {
        endpoint: "CREATE_OPPORTUNITY",
        mode: "non_idempotent",
        jobId,
      });
    }

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    traceRequestError(error);
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}

export const POST = withSpecbooksRequest("CREATE_OPPORTUNITY", createOpportunity);
