import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { fetchOrderLastModifiedRaw } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

export async function GET(req: Request) {
  try {
    assertInternalBearer(req);
    const url = new URL(req.url);
    const baid = (url.searchParams.get("baid") || "").trim().toUpperCase();
    const orderNbr = (url.searchParams.get("orderNbr") || "").trim().toUpperCase();
    if (!baid || !orderNbr) {
      return NextResponse.json({ error: "baid and orderNbr are required", code: "BAD_REQUEST" }, { status: 400 });
    }
    const lastModified = await fetchOrderLastModifiedRaw(baid, orderNbr);
    return NextResponse.json({ lastModified });
  } catch (error) {
    return jsonError(error);
  }
}
