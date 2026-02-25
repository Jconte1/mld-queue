import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  baid: z.string().min(1),
  orderNbrs: z.array(z.string().min(1)).default([]),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const { jobId } = await enqueueJob({
      type: "ERP_GET_INVENTORY_DETAILS",
      routeKey: "ERP_GET_INVENTORY_DETAILS",
      payload: {
        baid: body.baid.trim().toUpperCase(),
        orderNbrs: body.orderNbrs.map((v) => v.trim().toUpperCase()).filter(Boolean),
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP inventory-details job" }, { status: 500 });
  }
}

