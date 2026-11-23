import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

async function getItemClasses(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "GET_ITEM_CLASS");
    traceStage("enqueue");

    const { jobId } = await enqueueJob({
      type: "GET_ITEM_CLASS",
      payload: {},
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

export const GET = withSpecbooksRequest("GET_ITEM_CLASS", getItemClasses, "/api/specbooks/item-classes");
