import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  orderType: z.string().min(1),
  orderNumber: z.string().min(1),
  confirmedVia: z.string().min(1),
  confirmedWith: z.string().min(1),
  deliveryConfirmationId: z.string().min(1),
  deliveryGroupId: z.string().min(1),
  deliveryDate: z.string().min(1),
  source: z.string().min(1),
  dryRun: z.literal(true),
  note: z.string().min(1).optional(),
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
      orderType: body.orderType.trim().toUpperCase(),
      orderNumber: body.orderNumber.trim().toUpperCase(),
      confirmedVia: body.confirmedVia.trim(),
      confirmedWith: body.confirmedWith.trim(),
      deliveryConfirmationId: body.deliveryConfirmationId.trim(),
      deliveryGroupId: body.deliveryGroupId.trim(),
      deliveryDate: body.deliveryDate.trim(),
      source: body.source.trim(),
      dryRun: true,
    };
    const note = body.note?.trim();
    if (note) payload.note = note;

    const { jobId } = await enqueueJob({
      type: "ERP_UPDATE_DELIVERY_CONFIRMATION_ATTRIBUTES",
      routeKey: "ERP_UPDATE_DELIVERY_CONFIRMATION_ATTRIBUTES",
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
      { error: "Failed to enqueue delivery confirmation attributes job", details: message },
      { status: 500 }
    );
  }
}
