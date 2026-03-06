import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

export async function GET(req: Request, { params }: { params: Promise<{ contactId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    const { contactId } = await params;
    if (!contactId) {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 });
    }

    await assertRouteWithinRateLimit("specbooks", "GET_CONTACT");

    const { jobId } = await enqueueJob({
      type: "GET_CONTACT",
      payload: { contactId },
      routeKey: "GET_CONTACT"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}

