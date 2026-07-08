import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  orderNbr: z.string().min(1),
  orderType: z.string().min(1).optional(),
});

function deliveryQueueName() {
  if (!env.deliveryQueueName) {
    throw new Error("Delivery queue is not configured");
  }
  return env.deliveryQueueName;
}

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const payload: Record<string, unknown> = {
      orderNbr: body.orderNbr.trim().toUpperCase(),
    };
    const orderType = body.orderType?.trim().toUpperCase();
    if (orderType) payload.orderType = orderType;

    const { jobId } = await enqueueJob({
      type: "ERP_GET_DELIVERY_SALES_ORDER_FULL",
      routeKey: "ERP_GET_DELIVERY_SALES_ORDER_FULL",
      queueName: deliveryQueueName(),
      payload,
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to enqueue delivery SalesOrder full job", details: message },
      { status: 500 }
    );
  }
}
