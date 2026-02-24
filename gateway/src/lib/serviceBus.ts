import { ServiceBusClient, ServiceBusSender } from "@azure/service-bus";
import { env } from "@/lib/env";

let client: ServiceBusClient | null = null;
let sender: ServiceBusSender | null = null;

export function getQueueSender(): ServiceBusSender {
  if (!client) {
    client = new ServiceBusClient(env.serviceBusConnectionString);
  }
  if (!sender) {
    sender = client.createSender(env.queueName);
  }
  return sender;
}
