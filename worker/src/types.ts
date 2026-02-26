export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "CREATE_OPPORTUNITY"
  | "UPDATE_OPPORTUNITY"
  | "ERP_GET_ORDER_HEADER"
  | "ERP_GET_PAYMENT_INFO"
  | "ERP_GET_INVENTORY_DETAILS"
  | "ERP_GET_ORDER_SUMMARIES"
  | "ERP_GET_ORDER_SUMMARIES_DELTA"
  | "ERP_GET_ADDRESS_CONTACT"
  | "ERP_GET_ORDER_LAST_MODIFIED"
  | "ERP_GET_ORDER_READY_REPORT"
  | "ERP_GET_CLOSEOUT_INVENTORY_REPORT"
  | "ERP_VERIFY_CUSTOMER";

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
