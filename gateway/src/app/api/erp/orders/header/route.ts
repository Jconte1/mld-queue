import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { fetchOrderHeaderByOrderNbr } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

export async function GET(req: Request) {
  try {
    assertInternalBearer(req);
    const url = new URL(req.url);
    const orderNbr = (url.searchParams.get("orderNbr") || "").trim().toUpperCase();
    if (!orderNbr) {
      return NextResponse.json({ error: "orderNbr is required", code: "BAD_REQUEST" }, { status: 400 });
    }

    const row = await fetchOrderHeaderByOrderNbr(orderNbr);
    if (!row) {
      return NextResponse.json({ found: false, row: null });
    }
    return NextResponse.json({ found: true, row });
  } catch (error) {
    return jsonError(error);
  }
}
