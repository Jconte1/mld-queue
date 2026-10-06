import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const { jobId } = await enqueueJob({
      type: "ERP_SYNC_ACTIVE_VENDORS",
      routeKey: "ERP_SYNC_ACTIVE_VENDORS",
      payload: {},
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      {
        error: "Failed to enqueue active vendor sync",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
