import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { fetchAddressContactRows } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

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
    const baid = body.baid.trim().toUpperCase();
    const orderNbrs = body.orderNbrs.map((n) => n.trim().toUpperCase()).filter(Boolean);
    const rows = await fetchAddressContactRows(
      baid,
      orderNbrs,
      body.cutoffLiteral,
      Boolean(body.useOrderBy),
      body.pageSize ?? 500
    );
    return NextResponse.json({ rows });
  } catch (error) {
    return jsonError(error);
  }
}
