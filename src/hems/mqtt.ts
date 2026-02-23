import mqtt from "mqtt";
import type { HemsConfig } from "./config.ts";
import type { PcSnapshot } from "./metrics.ts";
import type { ServiceStatus } from "./services.ts";

export class HemsMqttPublisher {
  private client: mqtt.MqttClient | null = null;
  private prefix: string;
  private connected = false;

  constructor(private cfg: HemsConfig) {
    this.prefix = cfg.mqtt.topicPrefix;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.cfg.mqtt.broker, {
        username: this.cfg.mqtt.user,
        password: this.cfg.mqtt.password,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
      });

      this.client.on("connect", () => {
        this.connected = true;
        console.log(`[MQTT] Connected to ${this.cfg.mqtt.broker}`);
        resolve();
      });

      this.client.on("error", (err) => {
        if (!this.connected) reject(err);
        else console.error("[MQTT] Error:", err.message);
      });

      this.client.on("offline", () => {
        this.connected = false;
        console.warn("[MQTT] Disconnected, reconnecting…");
      });
    });
  }

  private publish(topic: string, payload: unknown): void {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `${this.prefix}/${topic}`,
      JSON.stringify(payload),
      { retain: false, qos: 0 }
    );
  }

  publishPcMetrics(snapshot: PcSnapshot): void {
    this.publish("pc/metrics/cpu", {
      usage_percent: snapshot.cpu.usage_percent,
      core_count: snapshot.cpu.core_count,
      load_1m: snapshot.cpu.load_1m,
    });
    this.publish("pc/metrics/memory", {
      used_gb: snapshot.memory.used_gb,
      total_gb: snapshot.memory.total_gb,
      percent: snapshot.memory.percent,
    });
    if (snapshot.gpu) {
      this.publish("pc/metrics/gpu", snapshot.gpu);
    }
    this.publish("pc/metrics/disk", { partitions: snapshot.disk });
    this.publish("pc/metrics/temperature", snapshot.temperature);
  }

  publishProcesses(processes: PcSnapshot["processes"]): void {
    this.publish("pc/processes/top", { processes });
  }

  publishBridgeStatus(uptime: number): void {
    this.publish("pc/bridge/status", { connected: true, uptime_s: uptime });
  }

  publishThresholdEvent(
    event: "cpu_high" | "memory_high" | "gpu_hot" | "disk_low",
    data: Record<string, unknown>
  ): void {
    this.publish(`pc/events/${event}`, data);
    console.log(`[MQTT] Threshold event: pc/events/${event}`, data);
  }

  publishServiceStatus(status: ServiceStatus): void {
    this.publish(`services/${status.name}/status`, status);
  }

  publishServiceEvent(
    name: string,
    prevCount: number,
    newCount: number,
    summary: string
  ): void {
    this.publish(`services/${name}/event`, {
      type: "unread_increased",
      name,
      prev_count: prevCount,
      new_count: newCount,
      summary,
    });
    console.log(`[MQTT] Service event: ${name} unread ${prevCount} → ${newCount}`);
  }

  disconnect(): void {
    this.client?.end();
  }
}
