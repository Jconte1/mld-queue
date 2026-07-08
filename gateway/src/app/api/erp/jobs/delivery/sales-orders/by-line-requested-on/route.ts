import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  requestedOn: z.string().min(1),
  excludedOrderTypes: z.array(z.string().min(1)).optional(),
  allowedShipVia: z.array(z.string().min(1)).optional(),
  allowedStatuses: z.array(z.string().min(1)).optional(),
});

function deliveryQueueName() {
  if (!env.deliveryQueueName) {
    throw new Error("Delivery queue is not configured");
  }
  return env.deliveryQueueName;
}

function normalizedArray(values: string[] | undefined) {
  return values?.map((value) => value.trim()).filter(Boolean);
}

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const payload: Record<string, unknown> = {
      requestedOn: body.requestedOn.trim(),
    };
    const excludedOrderTypes = normalizedArray(body.excludedOrderTypes);
    const allowedShipVia = normalizedArray(body.allowedShipVia);
    const allowedStatuses = normalizedArray(body.allowedStatuses);

    if (excludedOrderTypes) payload.excludedOrderTypes = excludedOrderTypes;
    if (allowedShipVia) payload.allowedShipVia = allowedShipVia;
    if (allowedStatuses) payload.allowedStatuses = allowedStatuses;

    const { jobId } = await enqueueJob({
      type: "ERP_FIND_DELIVERY_SALES_ORDERS_BY_LINE_REQUESTED_ON",
      routeKey: "ERP_FIND_DELIVERY_SALES_ORDERS_BY_LINE_REQUESTED_ON",
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
      { error: "Failed to enqueue delivery SalesOrder lookup job", details: message },
      { status: 500 }
    );
  }
}
