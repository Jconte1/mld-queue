export type VendorId = "specbooks";

export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "CREATE_OPPORTUNITY"
  | "UPDATE_OPPORTUNITY"
  | "ERP_GET_ORDER_HEADER"
  | "ERP_GET_PAYMENT_INFO"
  | "ERP_GET_INVENTORY_DETAILS";

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
