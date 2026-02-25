import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  baid: z.string().min(1),
  orderNbr: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const { jobId } = await enqueueJob({
      type: "ERP_GET_ORDER_LAST_MODIFIED",
      routeKey: "ERP_GET_ORDER_LAST_MODIFIED",
      payload: {
        baid: body.baid.trim().toUpperCase(),
        orderNbr: body.orderNbr.trim().toUpperCase(),
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP last-modified job" }, { status: 500 });
  }
}
