export function customerStateErrorSummary(error: string | null | undefined): string {
  if (!error) return "";
  const jsonStart = error.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(error.slice(jsonStart));
      if (typeof body.error === "string") return `${error.slice(0, jsonStart).trim()}: ${body.error}`.slice(0, 4000);
    } catch { /* Keep the plain error if the provider body is not JSON. */ }
  }
  return error.slice(0, 4000);
}

export function csvLine(values: unknown[]): string {
  return values.map(value => {
    let text = value === null || value === undefined ? "" : String(value);
    // Spreadsheet contents/provider errors must not become Excel formulas.
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(",") + "\r\n";
}

export function customerStateJobOutcome(job: { status: string; error: string | null; result: unknown }) {
  const result = job.result && typeof job.result === "object" ? job.result as Record<string, unknown> : {};
  if (job.status === "failed") return { outcome: "failed", error: customerStateErrorSummary(job.error) || "Queue job failed", result };
  const outcome = typeof result.status === "string" ? result.status : "unknown";
  if (!["updated", "already_correct", "would_update", "skipped_address_changed", "skipped_state_changed"].includes(outcome)) {
    return { outcome: "failed", error: `Unexpected worker result: ${outcome}`, result };
  }
  return { outcome, error: "", result };
}
