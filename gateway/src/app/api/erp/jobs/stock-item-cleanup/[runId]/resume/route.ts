import { NextResponse } from "next/server";
import { assertInternalBearer } from "@/lib/auth";
import { resumeStockItemCleanupRun } from "@/lib/stockItemCleanup";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    assertInternalBearer(req);
    const { runId } = await params;
    const resumed = await resumeStockItemCleanupRun(runId);

    if (!resumed) {
      return NextResponse.json({ error: "StockItem cleanup run not found" }, { status: 404 });
    }

    return NextResponse.json(resumed, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      {
        error: "Failed to resume StockItem cleanup run",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
