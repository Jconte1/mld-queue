import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const { jobId } = await enqueueJob({
      type: "ERP_GET_THANK_YOU_REPORT",
      routeKey: "ERP_GET_THANK_YOU_REPORT",
      payload: {},
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Failed to enqueue ERP thank-you report job" }, { status: 500 });
  }
}
