import { ServiceBusClient, ServiceBusSender } from "@azure/service-bus";
import { env } from "@/lib/env";

let client: ServiceBusClient | null = null;
const senders = new Map<string, ServiceBusSender>();

export function getQueueSender(queueName = env.queueName): ServiceBusSender {
  if (!client) {
    client = new ServiceBusClient(env.serviceBusConnectionString);
  }

  const existing = senders.get(queueName);
  if (existing) {
    return existing;
  }

  const sender = client.createSender(queueName);
  senders.set(queueName, sender);
  return sender;
}
