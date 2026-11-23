import { NextResponse } from "next/server";
import { withSpecbooksRequest, traceStage, tracePayload, traceRequestError } from "@/lib/specbooksRequestTrace";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

async function getContact(req: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    traceStage("validation");
    const { contactId } = await params;
    tracePayload({ contactId });
    if (!contactId) {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 });
    }

    traceStage("rate_limit");
    await assertRouteWithinRateLimit("specbooks", "GET_CONTACT");
    traceStage("enqueue");

    const { jobId } = await enqueueJob({
      type: "GET_CONTACT",
      payload: { contactId },
      routeKey: "GET_CONTACT"
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

export const GET = withSpecbooksRequest("GET_CONTACT", getContact, "/api/specbooks/contacts/[contactId]");

