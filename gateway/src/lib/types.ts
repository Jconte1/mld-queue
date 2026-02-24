export type VendorId = "specbooks";

export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "CREATE_OPPORTUNITY"
  | "UPDATE_OPPORTUNITY";

export type JobStatus = "queued" | "processing" | "succeeded" | "failed";

export type JobMessage = {
  jobId: string;
  vendorId: VendorId;
  type: JobType;
  customerId?: string;
  opportunityId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  requestedAt: string;
};

export type EnqueueInput = {
  type: JobType;
  customerId?: string;
  opportunityId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  routeKey: string;
};
