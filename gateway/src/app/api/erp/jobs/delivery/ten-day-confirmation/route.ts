import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const TEN_DAY_CONFIRMATION_REASON = "delivery_group_cleared";

const bodySchema = z
  .object({
    orderType: z.string().trim().min(1),
    orderNumber: z.string().trim().min(1),
    dryRun: z.boolean().optional().default(true),
    reason: z.literal(TEN_DAY_CONFIRMATION_REASON).optional().default(TEN_DAY_CONFIRMATION_REASON),
    deliveryDate: z.string().trim().min(1).optional(),
    sourceInterval: z.string().trim().min(1).optional(),
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
      dryRun: body.dryRun,
      reason: body.reason,
    };

    const deliveryDate = body.deliveryDate?.trim();
    if (deliveryDate) payload.deliveryDate = deliveryDate;
    const sourceInterval = body.sourceInterval?.trim();
    if (sourceInterval) payload.sourceInterval = sourceInterval;

    const { jobId } = await enqueueJob({
      type: "ERP_UPDATE_DELIVERY_TEN_DAY_CONFIRMATION",
      routeKey: "ERP_UPDATE_DELIVERY_TEN_DAY_CONFIRMATION",
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
      { error: "Failed to enqueue delivery ten-day confirmation job", details: message },
      { status: 500 }
    );
  }
}
