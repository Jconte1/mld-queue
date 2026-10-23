export function isStockItemNotFoundResult(type: string, result: unknown): boolean {
  if (type !== "GET_STOCK_ITEM" || !result || typeof result !== "object" || Array.isArray(result)) return false;
  const outcome = result as { name?: unknown; status?: unknown };
  return outcome.name === "StockItemNotFoundError" && outcome.status === 404;
}

// Keep the partner's existing create-on-missing contract independent of DB classification.
export function jobForPolling<T extends { type: string; status: string; result: unknown }>(job: T): T {
  return job.status === "succeeded" && isStockItemNotFoundResult(job.type, job.result)
    ? { ...job, status: "failed" }
    : job;
}
