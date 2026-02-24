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

export const env = {
  serviceBusConnectionString: getEnv("AZURE_SERVICEBUS_CONNECTION_STRING"),
  queueName: getEnv("SPECBOOKS_QUEUE_NAME"),
  acumaticaBaseUrl: getEnv("ACUMATICA_BASE_URL"),
  acumaticaClientId: getEnv("ACUMATICA_CLIENT_ID"),
  acumaticaClientSecret: getEnv("ACUMATICA_CLIENT_SECRET"),
  acumaticaUsername: getEnv("ACUMATICA_USERNAME"),
  acumaticaPassword: getEnv("ACUMATICA_PASSWORD"),
  acumaticaEndpointName: process.env.ACUMATICA_ENDPOINT_NAME ?? "Default",
  acumaticaEndpointVersion: process.env.ACUMATICA_ENDPOINT_VERSION ?? "24.200.001",
  acumaticaCustomerEntity: process.env.ACUMATICA_CUSTOMER_ENTITY ?? "Customer",
  acumaticaOpportunityEntity: process.env.ACUMATICA_OPPORTUNITY_ENTITY ?? "Opportunity",
  acumaticaOpportunityExpand: process.env.ACUMATICA_OPPORTUNITY_EXPAND ?? "Details",
  vendorMaxConcurrency: Number(process.env.VENDOR_MAX_CONCURRENCY ?? 8),
  vendorMaxRpm: Number(process.env.VENDOR_MAX_RPM ?? 90),
  globalMaxConcurrency: Number(process.env.GLOBAL_MAX_CONCURRENCY ?? 12),
  globalMaxRpm: Number(process.env.GLOBAL_MAX_RPM ?? 200),
  updateCoalesceWindowMs: Number(process.env.UPDATE_COALESCE_WINDOW_MS ?? 5000),
  port: Number(process.env.PORT ?? 8080)
};
