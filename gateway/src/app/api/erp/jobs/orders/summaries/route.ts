import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  baid: z.string().min(1),
  pageSize: z.number().int().positive().optional(),
  maxPages: z.number().int().positive().optional(),
  useOrderBy: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const { jobId } = await enqueueJob({
      type: "ERP_GET_ORDER_SUMMARIES",
      routeKey: "ERP_GET_ORDER_SUMMARIES",
      payload: {
        baid: body.baid.trim().toUpperCase(),
        pageSize: body.pageSize ?? 250,
        maxPages: body.maxPages ?? 50,
        useOrderBy: Boolean(body.useOrderBy),
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP order summaries job" }, { status: 500 });
  }
}
