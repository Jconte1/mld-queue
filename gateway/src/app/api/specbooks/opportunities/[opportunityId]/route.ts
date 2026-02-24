import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueCoalescedOpportunityUpdate, enqueueJob } from "@/lib/jobs";
import { parseJsonBodyWithLimit, updateOpportunitySchema } from "@/lib/validation";

export async function GET(req: Request, { params }: { params: Promise<{ opportunityId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    const { opportunityId } = await params;

    if (!opportunityId) {
      return NextResponse.json({ error: "opportunityId is required" }, { status: 400 });
    }

    await assertRouteWithinRateLimit("specbooks", "GET_OPPORTUNITY");

    const { jobId } = await enqueueJob({
      type: "GET_OPPORTUNITY",
      opportunityId,
      routeKey: "GET_OPPORTUNITY"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ opportunityId: string }> }) {
  try {
    assertSpecbooksApiKey(req);
    const { opportunityId } = await params;

    if (!opportunityId) {
      return NextResponse.json({ error: "opportunityId is required" }, { status: 400 });
    }

    const { parsed } = await parseJsonBodyWithLimit(req, updateOpportunitySchema);

    await assertRouteWithinRateLimit("specbooks", "UPDATE_OPPORTUNITY");

    const { jobId } = await enqueueCoalescedOpportunityUpdate(
      opportunityId,
      parsed as Record<string, unknown>
    );

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
