import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  customerId: z.string().min(1),
  zip5: z.string().min(5),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const { jobId } = await enqueueJob({
      type: "ERP_VERIFY_CUSTOMER",
      routeKey: "ERP_VERIFY_CUSTOMER",
      payload: {
        customerId: body.customerId.trim().toUpperCase(),
        zip5: body.zip5.replace(/\D/g, "").slice(0, 5),
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP customer verify job" }, { status: 500 });
  }
}
