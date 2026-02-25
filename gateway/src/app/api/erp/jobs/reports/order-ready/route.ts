import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const { jobId } = await enqueueJob({
      type: "ERP_GET_ORDER_READY_REPORT",
      routeKey: "ERP_GET_ORDER_READY_REPORT",
      payload: {},
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Failed to enqueue ERP order-ready report job" }, { status: 500 });
  }
}
