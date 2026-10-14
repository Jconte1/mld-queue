export function jobRetryDecision(
  transient: boolean,
  type: string,
  deliveryCount: number,
  maxAttempts: number
): { retry: boolean; exhausted: boolean; attempt: number } {
  const attempt = Math.max(0, deliveryCount) + 1;
  const eligible = transient && type !== "ERP_PUT_SALES_INVOICE";
  return { retry: eligible && attempt < maxAttempts,
    exhausted: eligible && attempt >= maxAttempts, attempt };
}
