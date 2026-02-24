import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { fetchPaymentInfoRows } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

const bodySchema = z.object({
  baid: z.string().min(1),
  orderNbrs: z.array(z.string().min(1)).default([]),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const baid = body.baid.trim().toUpperCase();
    const orderNbrs = body.orderNbrs.map((n) => n.trim().toUpperCase()).filter(Boolean);
    const rows = await fetchPaymentInfoRows(baid, orderNbrs);
    return NextResponse.json({ rows });
  } catch (error) {
    return jsonError(error);
  }
}
