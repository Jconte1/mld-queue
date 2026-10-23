export function jobFailureStatus(type: string | undefined, error: unknown): "failed" | "succeeded" {
  return type === "GET_STOCK_ITEM" && error instanceof Error &&
    error.name === "StockItemNotFoundError" && (error as Error & { status?: number }).status === 404
    ? "succeeded"
    : "failed";
}
