import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { fetchOrderSummariesRows } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

function parseBool(v: string | null, fallback = false) {
  if (!v) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(v.trim().toLowerCase());
}

export async function GET(req: Request) {
  try {
    assertInternalBearer(req);
    const url = new URL(req.url);
    const baid = (url.searchParams.get("baid") || "").trim().toUpperCase();
    if (!baid) {
      return NextResponse.json({ error: "baid is required", code: "BAD_REQUEST" }, { status: 400 });
    }
    const pageSize = Number(url.searchParams.get("pageSize") || 250);
    const maxPages = Number(url.searchParams.get("maxPages") || 50);
    const useOrderBy = parseBool(url.searchParams.get("useOrderBy"), false);

    const rows = await fetchOrderSummariesRows(baid, pageSize, maxPages, useOrderBy);
    return NextResponse.json({ rows });
  } catch (error) {
    return jsonError(error);
  }
}
