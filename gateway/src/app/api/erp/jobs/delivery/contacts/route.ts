import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  contactId: z.string().min(1),
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

    const { jobId } = await enqueueJob({
      type: "ERP_GET_DELIVERY_CONTACT",
      routeKey: "ERP_GET_DELIVERY_CONTACT",
      queueName: deliveryQueueName(),
      payload: {
        contactId: body.contactId.trim(),
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to enqueue delivery Contact lookup job", details: message },
      { status: 500 }
    );
  }
}
