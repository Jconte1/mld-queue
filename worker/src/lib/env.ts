const required = [
  "AZURE_SERVICEBUS_CONNECTION_STRING",
  "SPECBOOKS_QUEUE_NAME",
  "DATABASE_URL",
  "ACUMATICA_BASE_URL",
  "ACUMATICA_CLIENT_ID",
  "ACUMATICA_CLIENT_SECRET",
  "ACUMATICA_USERNAME",
  "ACUMATICA_PASSWORD"
] as const;

function getEnv(name: (typeof required)[number]): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

for (const name of required) {
  getEnv(name);
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || undefined;
}

function endpointVersion(name: string) {
  return optionalEnv(name) || optionalEnv("ACUMATICA_ENDPOINT_VERSION") || "24.200.001";
}

export const env = {
  serviceBusConnectionString: getEnv("AZURE_SERVICEBUS_CONNECTION_STRING"),
  queueName: process.env.MLD_QUEUE_WORKER_QUEUE_NAME?.trim() || getEnv("SPECBOOKS_QUEUE_NAME"),
  acumaticaBaseUrl: getEnv("ACUMATICA_BASE_URL"),
  acumaticaClientId: getEnv("ACUMATICA_CLIENT_ID"),
  acumaticaClientSecret: getEnv("ACUMATICA_CLIENT_SECRET"),
  acumaticaUsername: getEnv("ACUMATICA_USERNAME"),
  acumaticaPassword: getEnv("ACUMATICA_PASSWORD"),
  acumaticaEndpointName: optionalEnv("ACUMATICA_ENDPOINT_NAME") ?? "CustomEndpoint",
  acumaticaEndpointVersion: endpointVersion("ACUMATICA_ENDPOINT_VERSION"),
  acumaticaCustomerEntity: optionalEnv("ACUMATICA_CUSTOMER_ENTITY") ?? "Customer",
  acumaticaOpportunityEntity: optionalEnv("ACUMATICA_OPPORTUNITY_ENTITY") ?? "Opportunity",
  acumaticaContactEntity: optionalEnv("ACUMATICA_CONTACT_ENTITY") ?? "Contact",
  acumaticaStockItemEntity: optionalEnv("ACUMATICA_STOCK_ITEM_ENTITY") ?? "StockItem",
  acumaticaItemClassEntity: optionalEnv("ACUMATICA_ITEM_CLASS_ENTITY") ?? "ItemClass",
  acumaticaVendorEntity: optionalEnv("ACUMATICA_VENDOR_ENTITY") ?? "Vendor",
  acumaticaSalesInvoiceEntity: optionalEnv("ACUMATICA_SALES_INVOICE_ENTITY") ?? "SalesInvoice",
  acumaticaStockItemEndpointName: optionalEnv("ACUMATICA_STOCK_ITEM_ENDPOINT_NAME") ?? "CustomEndpoint",
  acumaticaStockItemEndpointVersion: endpointVersion("ACUMATICA_STOCK_ITEM_ENDPOINT_VERSION"),
  acumaticaDeliveryEndpointName: process.env.ACUMATICA_DELIVERY_ENDPOINT_NAME?.trim() || "Delivery",
  acumaticaDeliveryEndpointVersion: endpointVersion("ACUMATICA_DELIVERY_ENDPOINT_VERSION"),
  acumaticaDeliverySalesOrderEndpointName:
    process.env.ACUMATICA_DELIVERY_SALES_ORDER_ENDPOINT_NAME?.trim() || "DeliverySalesOrder",
  acumaticaDeliverySalesOrderEndpointVersion:
    endpointVersion("ACUMATICA_DELIVERY_SALES_ORDER_ENDPOINT_VERSION"),
  acumaticaOpportunityExpand: process.env.ACUMATICA_OPPORTUNITY_EXPAND ?? "Products,Address",
  vendorMaxConcurrency: Number(process.env.VENDOR_MAX_CONCURRENCY ?? 8),
  vendorMaxRpm: Number(process.env.VENDOR_MAX_RPM ?? 90),
  globalMaxConcurrency: Number(process.env.GLOBAL_MAX_CONCURRENCY ?? 12),
  globalMaxRpm: Number(process.env.GLOBAL_MAX_RPM ?? 200),
  updateCoalesceWindowMs: Number(process.env.UPDATE_COALESCE_WINDOW_MS ?? 5000),
  stockItemMaxBatchSize: Number(process.env.MAX_STOCK_ITEM_BATCH_SIZE ?? 25),
  acumaticaRequestTimeoutMs: Number(process.env.ACUMATICA_REQUEST_TIMEOUT_MS ?? 30000),
  port: Number(process.env.PORT ?? 8080)
};
