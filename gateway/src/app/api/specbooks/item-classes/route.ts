import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

export async function GET(req: Request) {
  try {
    assertSpecbooksApiKey(req);

    await assertRouteWithinRateLimit("specbooks", "GET_ITEM_CLASS");

    const { jobId } = await enqueueJob({
      type: "GET_ITEM_CLASS",
      payload: {},
      routeKey: "GET_ITEM_CLASS"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
