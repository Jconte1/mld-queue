import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { fetchOrderReadyReportRows } from "@/lib/erp/acumatica";
import { jsonError } from "@/lib/erp/http";

export async function GET(req: Request) {
  try {
    assertInternalBearer(req);
    const rows = await fetchOrderReadyReportRows();
    return NextResponse.json({ rows });
  } catch (error) {
    return jsonError(error);
  }
}
