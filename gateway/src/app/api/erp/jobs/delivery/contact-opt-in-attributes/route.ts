import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const falseOnly = z.literal(false);

const bodySchema = z
  .object({
    contactId: z.string().trim().min(1),
    smsOptIn: falseOnly.optional(),
    emailOptIn: falseOnly.optional(),
    phoneCallOptIn: falseOnly.optional(),
    source: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    dryRun: z.boolean().optional().default(true),
  })
  .strict()
  .refine(
    (body) =>
      body.smsOptIn === false || body.emailOptIn === false || body.phoneCallOptIn === false,
    {
      message: "At least one opt-in field must be supplied and must be exactly false",
      path: ["smsOptIn"],
    }
  );

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
      contactId: body.contactId.trim(),
      source: body.source.trim(),
      reason: body.reason.trim(),
      dryRun: body.dryRun,
    };

    if (body.smsOptIn === false) payload.smsOptIn = false;
    if (body.emailOptIn === false) payload.emailOptIn = false;
    if (body.phoneCallOptIn === false) payload.phoneCallOptIn = false;

    const { jobId } = await enqueueJob({
      type: "ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES",
      routeKey: "ERP_UPDATE_DELIVERY_CONTACT_OPT_IN_ATTRIBUTES",
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
      { error: "Failed to enqueue delivery Contact opt-in attribute job", details: message },
      { status: 500 }
    );
  }
}
