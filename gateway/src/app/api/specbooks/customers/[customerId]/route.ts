import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, tracePayload, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

async function getCustomer(req: Request, { params }: { params: Promise<{ customerId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    traceStage("validation");
    const { customerId } = await params;
    tracePayload({ customerId });
    if (!customerId) {
      return NextResponse.json({ error: "customerId is required" }, { status: 400 });
    }

    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "GET_CUSTOMER");
    traceStage("enqueue");

    const { jobId } = await enqueueJob({
      type: "GET_CUSTOMER",
      customerId,
      routeKey: "GET_CUSTOMER"
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

export const GET = withSpecbooksRequest("GET_CUSTOMER", getCustomer, "/api/specbooks/customers/[customerId]");
