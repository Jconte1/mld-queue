import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const contactSchema = z
  .object({
    displayName: z.string().optional().nullable(),
    companyName: z.string().optional().nullable(),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
  })
  .optional();

const bodySchema = z.object({
  orderType: z.string().min(1),
  orderNumber: z.string().min(1),
  deliveryConfirmationId: z.string().min(1),
  deliveryGroupId: z.string().min(1),
  originalDeliveryDate: z.string().min(1),
  requestedDeliveryDate: z.string().min(1),
  lineNumbers: z.array(z.coerce.number().int().positive()).min(1),
  source: z.enum(["WEBPAGE", "SMS"]),
  dryRun: z.boolean().default(true),
  requestedAt: z.string().min(1).optional(),
  requestedBy: contactSchema,
  note: z.string().min(1).optional(),
});

function deliveryQueueName() {
  if (!env.deliveryQueueName) {
    throw new Error("Delivery queue is not configured");
  }
  return env.deliveryQueueName;
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function normalizeLineNumbers(values: number[]) {
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function requestedByPayload(contact: z.infer<typeof contactSchema>) {
  if (!contact) return undefined;

  const payload: Record<string, string> = {};
  for (const key of ["displayName", "companyName", "firstName", "lastName", "email", "phone"]) {
    const value = clean(contact[key as keyof typeof contact]);
    if (value) payload[key] = value;
  }

  return Object.keys(payload).length ? payload : undefined;
}

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const payload: Record<string, unknown> = {
      orderType: body.orderType.trim().toUpperCase(),
      orderNumber: body.orderNumber.trim().toUpperCase(),
      deliveryConfirmationId: body.deliveryConfirmationId.trim(),
      deliveryGroupId: body.deliveryGroupId.trim(),
      originalDeliveryDate: body.originalDeliveryDate.trim(),
      requestedDeliveryDate: body.requestedDeliveryDate.trim(),
      lineNumbers: normalizeLineNumbers(body.lineNumbers),
      source: body.source,
      dryRun: body.dryRun,
      requestedAt: body.requestedAt?.trim() || new Date().toISOString(),
    };
    const requestedBy = requestedByPayload(body.requestedBy);
    const note = body.note?.trim();
    if (requestedBy) payload.requestedBy = requestedBy;
    if (note) payload.note = note;

    const { jobId } = await enqueueJob({
      type: "ERP_UPDATE_DELIVERY_REQUESTED_DATE",
      routeKey: "ERP_UPDATE_DELIVERY_REQUESTED_DATE",
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
      { error: "Failed to enqueue delivery requested-date job", details: message },
      { status: 500 }
    );
  }
}
