import { AsyncLocalStorage } from "node:async_hooks";

export type RequestTrace = {
  requestId: string;
  operation: string;
  method: string;
  route: string;
  correlationId?: string;
  vercelRequestId?: string;
  stage: string;
  jobId?: string;
};

export const requestContext = new AsyncLocalStorage<RequestTrace>();
