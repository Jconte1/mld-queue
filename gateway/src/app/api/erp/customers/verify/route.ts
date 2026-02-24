import { NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalBearer } from "@/lib/auth";
import { verifyCustomerByZip } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

const bodySchema = z.object({
  customerId: z.string().min(1),
  zip5: z.string().min(5),
});

export async function POST(req: Request) {
  try {
    assertInternalBearer(req);
    const body = bodySchema.parse(await req.json());
    const customerId = body.customerId.trim().toUpperCase();
    const zip5 = body.zip5.replace(/\D/g, "").slice(0, 5);
    const matched = await verifyCustomerByZip(customerId, zip5);
    return NextResponse.json({ ok: true, matched });
  } catch (error) {
    return jsonError(error);
  }
}
