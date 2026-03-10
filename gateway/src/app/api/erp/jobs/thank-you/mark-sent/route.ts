import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const payload = (await req.json().catch(() => ({}))) as {
      orderNbr?: string;
      orderType?: string | null;
    };

    const orderNbr = String(payload.orderNbr || "").trim().toUpperCase();
    const orderTypeRaw = String(payload.orderType || "").trim().toUpperCase();
    const orderType = orderTypeRaw || null;

    if (!orderNbr) {
      return NextResponse.json({ error: "orderNbr is required" }, { status: 400 });
    }

    const { jobId } = await enqueueJob({
      type: "ERP_MARK_THANK_YOU_SENT",
      routeKey: "ERP_MARK_THANK_YOU_SENT",
      payload: {
        orderNbr,
        orderType,
      },
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "Failed to enqueue ERP thank-you mark-sent job" }, { status: 500 });
  }
}
