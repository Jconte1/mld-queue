import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { fetchOrderSummariesDeltaRows } from "@/lib/erp/acumatica";
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
    const since = (url.searchParams.get("since") || "").trim();
    if (!baid || !since) {
      return NextResponse.json({ error: "baid and since are required", code: "BAD_REQUEST" }, { status: 400 });
    }

    const pageSize = Number(url.searchParams.get("pageSize") || 250);
    const maxPages = Number(url.searchParams.get("maxPages") || 50);
    const useOrderBy = parseBool(url.searchParams.get("useOrderBy"), false);

    const rows = await fetchOrderSummariesDeltaRows(baid, since, pageSize, maxPages, useOrderBy);
    return NextResponse.json({ rows });
  } catch (error) {
    return jsonError(error);
  }
}
