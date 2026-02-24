import { NextResponse } from "next/server";

export function jsonError(error: unknown) {
  if (error instanceof Response) {
    return error;
  }

  const status = (error as { status?: number } | undefined)?.status;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 400) {
    return NextResponse.json({ error: message, code: "BAD_REQUEST" }, { status: 400 });
  }
  if (status === 401 || status === 403) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (status === 404) {
    return NextResponse.json({ error: message || "Not found", code: "NOT_FOUND" }, { status: 404 });
  }
  if (status === 429) {
    return NextResponse.json({ error: "Rate limited", code: "RATE_LIMITED" }, { status: 429 });
  }
  if (status && status >= 500) {
    return NextResponse.json({ error: "Upstream ERP failure", code: "UPSTREAM_ERROR" }, { status: 502 });
  }

  return NextResponse.json({ error: "Internal server error", code: "INTERNAL_ERROR", details: message }, { status: 500 });
}
