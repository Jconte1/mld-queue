import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { enqueueJob } from "@/lib/jobs";

const bodySchema = z.object({
  baid: z.string().min(1),
  orderNbrs: z.array(z.string().min(1)).default([]),
  cutoffLiteral: z.string().optional().nullable(),
  useOrderBy: z.boolean().optional(),
  pageSize: z.number().int().positive().optional(),
  chunkSize: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const { jobId } = await enqueueJob({
      type: "ERP_GET_ADDRESS_CONTACT",
      routeKey: "ERP_GET_ADDRESS_CONTACT",
      payload: {
        baid: body.baid.trim().toUpperCase(),
        orderNbrs: body.orderNbrs.map((n) => n.trim().toUpperCase()).filter(Boolean),
        cutoffLiteral: body.cutoffLiteral ?? null,
        useOrderBy: Boolean(body.useOrderBy),
        pageSize: body.pageSize ?? 500,
        chunkSize: body.chunkSize ?? 40,
      },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to enqueue ERP address-contact job" }, { status: 500 });
  }
}
