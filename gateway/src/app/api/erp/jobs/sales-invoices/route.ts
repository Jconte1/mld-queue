import { NextResponse } from "next/server";
import { z } from "zod";

import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  payload: z.record(z.string(), z.unknown()),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());

    const { jobId } = await enqueueJob({
      vendorId: "service_fusion",
      type: "ERP_PUT_SALES_INVOICE",
      routeKey: "ERP_PUT_SALES_INVOICE",
      payload: {
        payload: body.payload,
      },
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP sales-invoice job" }, { status: 500 });
  }
}
