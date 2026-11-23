import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, tracePayload, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { env } from "@/lib/env";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCoalescedOpportunityUpdate, enqueueJob } from "@/lib/jobs";
import {
  parseJsonBodyWithLimit,
  parseJsonObjectBodyWithLimit,
  updateOpportunitySchema,
} from "@/lib/validation";

async function getOpportunity(req: Request, { params }: { params: Promise<{ opportunityId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    traceStage("validation");
    const { opportunityId } = await params;
    tracePayload({ opportunityId });

    if (!opportunityId) {
      return NextResponse.json({ error: "opportunityId is required" }, { status: 400 });
    }

    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "GET_OPPORTUNITY");
    traceStage("enqueue");

    const { jobId } = await enqueueJob({
      type: "GET_OPPORTUNITY",
      opportunityId,
      routeKey: "GET_OPPORTUNITY"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    traceRequestError(error);
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}

async function updateOpportunity(req: Request, { params }: { params: Promise<{ opportunityId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    traceStage("validation");
    const { opportunityId } = await params;

    if (!opportunityId) {
      return NextResponse.json({ error: "opportunityId is required" }, { status: 400 });
    }

    const { parsed } = env.specbooksOpportunityPassthrough
      ? await parseJsonObjectBodyWithLimit(req, { requireNonEmpty: true })
      : await parseJsonBodyWithLimit(req, updateOpportunitySchema);

    tracePayload({ ...parsed, opportunityId });
    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "UPDATE_OPPORTUNITY");
    traceStage("enqueue");
    const payload = parsed as Record<string, unknown>;
    // Path param is authoritative; ignore body-supplied OpportunityID in passthrough mode.
    if ("OpportunityID" in payload) {
      delete payload.OpportunityID;
    }

    const { jobId } = await enqueueCoalescedOpportunityUpdate(
      opportunityId,
      payload
    );

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    traceRequestError(error);
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}

export const GET = withSpecbooksRequest("GET_OPPORTUNITY", getOpportunity, "/api/specbooks/opportunities/[opportunityId]");
export const PATCH = withSpecbooksRequest("UPDATE_OPPORTUNITY", updateOpportunity, "/api/specbooks/opportunities/[opportunityId]");
