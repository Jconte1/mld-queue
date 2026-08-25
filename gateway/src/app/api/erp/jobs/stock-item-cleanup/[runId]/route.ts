import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { getStockItemCleanupRun } from "@/lib/stockItemCleanup";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    assertInternalBearer(req);
    const { runId } = await params;
    const run = await getStockItemCleanupRun(runId);

    if (!run) {
      return NextResponse.json({ error: "StockItem cleanup run not found" }, { status: 404 });
    }

    return NextResponse.json(run, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      {
        error: "Failed to fetch StockItem cleanup run",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
