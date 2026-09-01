import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs";

const intervals = ["180", "90", "60", "42", "30", "14", "12", "10", "2"] as const;

const orderScopeSchema = z.object({
  orderType: z.string().trim().min(1),
  orderNumber: z.string().trim().min(1),
});

const bodySchema = z.object({
  interval: z.enum(intervals),
  runDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().trim().min(1).default("America/Denver"),
  expectedLocalTime: z.string().trim().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
  manualRun: z.boolean(),
  schedulerRunId: z.string().trim().min(1),
  lockKey: z.string().trim().min(1),
  send: z.literal(true),
  confirmationPhrase: z.string().trim().min(1),
  requestedBy: z.enum(["vercel-cron", "manual"]),
  orderScope: orderScopeSchema.optional(),
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
      interval: body.interval,
      runDate: body.runDate,
      timezone: body.timezone,
      expectedLocalTime: body.expectedLocalTime,
      manualRun: body.manualRun,
      schedulerRunId: body.schedulerRunId,
      lockKey: body.lockKey,
      send: body.send,
      confirmationPhrase: body.confirmationPhrase,
      requestedBy: body.requestedBy,
    };
    if (body.orderScope) {
      payload.orderScope = {
        orderType: body.orderScope.orderType.trim().toUpperCase(),
        orderNumber: body.orderScope.orderNumber.trim().toUpperCase(),
      };
    }

    const { jobId } = await enqueueJob({
      type: "RUN_DELIVERY_INTERVAL_SCHEDULED",
      routeKey: "RUN_DELIVERY_INTERVAL_SCHEDULED",
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
      { error: "Failed to enqueue delivery scheduled interval job", details: message },
      { status: 500 }
    );
  }
}
