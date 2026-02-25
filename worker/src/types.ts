export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "CREATE_OPPORTUNITY"
  | "UPDATE_OPPORTUNITY"
  | "ERP_GET_ORDER_HEADER"
  | "ERP_GET_PAYMENT_INFO"
  | "ERP_GET_INVENTORY_DETAILS";

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
