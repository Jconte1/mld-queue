import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

export async function GET(req: Request, { params }: { params: Promise<{ customerId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    const { customerId } = await params;
    if (!customerId) {
      return NextResponse.json({ error: "customerId is required" }, { status: 400 });
    }

    await assertRouteWithinRateLimit("specbooks", "GET_CUSTOMER");

    const { jobId } = await enqueueJob({
      type: "GET_CUSTOMER",
      customerId,
      routeKey: "GET_CUSTOMER"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}