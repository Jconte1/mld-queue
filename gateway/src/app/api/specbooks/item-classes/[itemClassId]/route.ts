import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, tracePayload, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

async function getItemClass(req: Request, { params }: { params: Promise<{ itemClassId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    traceStage("validation");
    const { itemClassId } = await params;
    tracePayload({ itemClassId });
    if (!itemClassId) {
      return NextResponse.json({ error: "itemClassId is required" }, { status: 400 });
    }

    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "GET_ITEM_CLASS");
    traceStage("enqueue");

    const { jobId } = await enqueueJob({
      type: "GET_ITEM_CLASS",
      payload: { itemClassId },
      routeKey: "GET_ITEM_CLASS"
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

export const GET = withSpecbooksRequest("GET_ITEM_CLASS", getItemClass, "/api/specbooks/item-classes/[itemClassId]");

