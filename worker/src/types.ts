export type JobType =
  | "GET_CUSTOMER"
  | "GET_OPPORTUNITY"
  | "GET_CONTACT"
  | "GET_STOCK_ITEM"
  | "GET_ITEM_CLASS"
  | "CREATE_OPPORTUNITY"
  | "CREATE_STOCK_ITEM"
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
  | "ERP_GET_THANK_YOU_REPORT"
  | "ERP_MARK_THANK_YOU_SENT"
  | "ERP_VERIFY_CUSTOMER"
  | "ERP_PUT_SALES_INVOICE";

export type JobMessage = {
  jobId: string;
  vendorId: "specbooks" | "service_fusion";
  type: JobType;
  customerId?: string;
  opportunityId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  requestedAt: string;
};
