const required = [
  "SPECBOOKS_API_KEY",
  "AZURE_SERVICEBUS_CONNECTION_STRING",
  "SPECBOOKS_QUEUE_NAME",
  "DATABASE_URL"
] as const;

function getEnv(name: (typeof required)[number]): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

for (const name of required) {
  getEnv(name);
}

export const env = {
  specbooksApiKey: getEnv("SPECBOOKS_API_KEY"),
  serviceBusConnectionString: getEnv("AZURE_SERVICEBUS_CONNECTION_STRING"),
  queueName: getEnv("SPECBOOKS_QUEUE_NAME"),
  maxRequestBytes: Number(process.env.MAX_REQUEST_BYTES ?? 102_400),
  maxStringLength: Number(process.env.MAX_STRING_LENGTH ?? 2_048),
  rateLimitWindowSeconds: Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60),
  rateLimitByRoute: {
    GET_CUSTOMER: Number(process.env.RATE_LIMIT_GET_CUSTOMER ?? 30),
    GET_OPPORTUNITY: Number(process.env.RATE_LIMIT_GET_OPPORTUNITY ?? 30),
    CREATE_OPPORTUNITY: Number(process.env.RATE_LIMIT_CREATE_OPPORTUNITY ?? 20),
    UPDATE_OPPORTUNITY: Number(process.env.RATE_LIMIT_UPDATE_OPPORTUNITY ?? 20)
  }
};
