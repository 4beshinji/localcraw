import mqtt from "mqtt";
import type { Tool, ToolResult } from "../registry.ts";
import type { HemsConfig } from "../../hems/config.ts";

/** Shared MQTT client for agent tool use (separate from publisher) */
let sharedClient: mqtt.MqttClient | null = null;
const subscriptions: Map<string, string[]> = new Map(); // topic → received messages

function getClient(cfg: HemsConfig): mqtt.MqttClient {
  if (!sharedClient) {
    sharedClient = mqtt.connect(cfg.mqtt.broker, {
      username: cfg.mqtt.user,
      password: cfg.mqtt.password,
      reconnectPeriod: 5000,
    });
    sharedClient.on("message", (topic, payload) => {
      const msgs = subscriptions.get(topic) ?? [];
      msgs.push(payload.toString());
      // Keep last 10 messages per topic
      subscriptions.set(topic, msgs.slice(-10));
    });
  }
  return sharedClient;
}

export function createMqttTools(cfg: HemsConfig): Tool[] {
  return [
    {
      name: "mqtt_publish",
      description: "Publish a message to an HEMS MQTT topic",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "MQTT topic (e.g. hems/pc/command)" },
          payload: { type: "string", description: "JSON or string payload" },
        },
        required: ["topic", "payload"],
      },
      async execute(args): Promise<ToolResult> {
        const topic = args.topic as string;
        const payload = args.payload as string;
        try {
          const client = getClient(cfg);
          await new Promise<void>((resolve, reject) => {
            client.publish(topic, payload, (err) => (err ? reject(err) : resolve()));
          });
          return { success: true, output: `Published to ${topic}` };
        } catch (err) {
          return { success: false, output: "", error: String(err) };
        }
      },
    },

    {
      name: "mqtt_subscribe",
      description: "Subscribe to an HEMS MQTT topic and return recent messages",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "MQTT topic or pattern (e.g. hems/pc/metrics/#)" },
          wait_ms: { type: "string", description: "How long to wait for messages in ms (default: 2000)" },
        },
        required: ["topic"],
      },
      async execute(args): Promise<ToolResult> {
        const topic = args.topic as string;
        const waitMs = parseInt((args.wait_ms as string) ?? "2000", 10) || 2000;
        try {
          const client = getClient(cfg);
          if (!subscriptions.has(topic)) {
            subscriptions.set(topic, []);
            client.subscribe(topic);
          }
          // Wait for messages
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          const msgs = subscriptions.get(topic) ?? [];
          if (msgs.length === 0) {
            return { success: true, output: `No messages received on ${topic} within ${waitMs}ms` };
          }
          return {
            success: true,
            output: `${msgs.length} message(s) on ${topic}:\n${msgs.join("\n")}`,
          };
        } catch (err) {
          return { success: false, output: "", error: String(err) };
        }
      },
    },
  ];
}
