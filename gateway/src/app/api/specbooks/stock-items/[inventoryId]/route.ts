import { NextResponse } from "next/server";
import { assertSpecbooksApiKey } from "@/lib/auth";
import { assertRouteWithinRateLimit } from "@/lib/rateLimit";
import { enqueueJob } from "@/lib/jobs";

export async function GET(req: Request, { params }: { params: Promise<{ inventoryId: string }> }) {
  try {
    assertSpecbooksApiKey(req);

    const { inventoryId } = await params;
    const { searchParams } = new URL(req.url);
    const idsFromPath = String(inventoryId || "")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
    const inventoryIdsQuery = String(searchParams.get("inventoryIds") || "");
    const idsFromQuery = inventoryIdsQuery
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
    const ids = Array.from(new Set([...idsFromPath, ...idsFromQuery]));
    if (!ids.length) {
      return NextResponse.json({ error: "inventoryId is required" }, { status: 400 });
    }
    if (ids.length > 200) {
      return NextResponse.json({ error: "Too many inventoryIds (max 200)" }, { status: 400 });
    }

    await assertRouteWithinRateLimit("specbooks", "GET_STOCK_ITEM");

    const { jobId } = await enqueueJob({
      type: "GET_STOCK_ITEM",
      payload: { inventoryIds: ids },
      routeKey: "GET_STOCK_ITEM"
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return NextResponse.json({ error: "Failed to enqueue job" }, { status: 500 });
  }
}
