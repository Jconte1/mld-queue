import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const PAYMENT_ENFORCEMENT_REASON = "payment_not_received_by_deadline";

const bodySchema = z
  .object({
    orderType: z.string().trim().min(1),
    orderNumber: z.string().trim().min(1),
    reason: z.literal(PAYMENT_ENFORCEMENT_REASON),
    dryRun: z.boolean().optional().default(true),
    deliveryDate: z.string().trim().min(1).optional(),
    amountDueAtTrigger: z.union([z.string().trim().min(1), z.number()]).optional(),
    paymentDeadline: z.string().trim().min(1).optional(),
  })
  .strict();

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
      orderType: body.orderType.trim().toUpperCase(),
      orderNumber: body.orderNumber.trim().toUpperCase(),
      reason: body.reason,
      dryRun: body.dryRun,
    };

    const deliveryDate = body.deliveryDate?.trim();
    if (deliveryDate) payload.deliveryDate = deliveryDate;
    if (body.amountDueAtTrigger !== undefined) payload.amountDueAtTrigger = body.amountDueAtTrigger;
    const paymentDeadline = body.paymentDeadline?.trim();
    if (paymentDeadline) payload.paymentDeadline = paymentDeadline;

    const { jobId } = await enqueueJob({
      type: "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD",
      routeKey: "ERP_UPDATE_DELIVERY_PREPAYMENT_HOLD",
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
      { error: "Failed to enqueue delivery prepayment hold job", details: message },
      { status: 500 }
    );
  }
}
