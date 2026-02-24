export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "CREATE_OPPORTUNITY"
  | "UPDATE_OPPORTUNITY";

export type JobMessage = {
  jobId: string;
  vendorId: "specbooks";
  type: JobType;
  customerId?: string;
  opportunityId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  requestedAt: string;
};