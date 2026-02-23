/**
 * HEMS service orchestrator.
 * Manages metrics collection, service checkers, MQTT publishing, and HTTP API.
 */
import { getPcSnapshot } from "./metrics.ts";
import { ServiceCheckerManager } from "./services.ts";
import { HemsMqttPublisher } from "./mqtt.ts";
import { HemsApiServer } from "./server.ts";
import { HemsBrowser } from "./browser.ts";
import type { FullConfig } from "./config.ts";

export class HemsService {
  private publisher: HemsMqttPublisher;
  private checker: ServiceCheckerManager;
  private apiServer: HemsApiServer;
  private browser: HemsBrowser | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  private processTimer: NodeJS.Timeout | null = null;
  private startTime = Date.now();
  private lastSnapshot: Awaited<ReturnType<typeof getPcSnapshot>> | null = null;

  constructor(private config: FullConfig) {
    const hems = config.hems;

    this.publisher = new HemsMqttPublisher(hems);

    // Initialize browser if browser checkers are configured
    if (hems.browserCheckers.length > 0) {
      this.browser = new HemsBrowser();
      console.log(`[hems] Browser checkers configured: ${hems.browserCheckers.map((c) => c.name).join(", ")}`);
    }

    this.checker = new ServiceCheckerManager(
      hems,
      (status, prev) => {
        this.publisher.publishServiceStatus(status);
        this.apiServer.updateServiceStatus(status);

        if (
          status.available &&
          prev?.available &&
          status.unread_count > (prev?.unread_count ?? 0)
        ) {
          this.publisher.publishServiceEvent(
            status.name,
            prev.unread_count,
            status.unread_count,
            status.summary
          );
        }
      },
      this.browser ?? undefined
    );

    this.apiServer = new HemsApiServer(hems);
    if (this.browser) {
      this.apiServer.setBrowser(this.browser);
    }
  }

  async start(): Promise<void> {
    console.log("[hems] Starting HEMS service…");

    // Connect MQTT
    try {
      await this.publisher.connect();
    } catch (err) {
      console.warn(`[hems] MQTT connection failed: ${err}. Continuing without MQTT.`);
    }

    // Launch browser if needed
    if (this.browser) {
      try {
        await this.browser.launch();
        console.log("[hems] Browser ready");
      } catch (err) {
        console.warn(`[hems] Browser launch failed: ${err}. Browser features disabled.`);
        this.browser = null;
        this.apiServer.setBrowser(null as unknown as HemsBrowser);
      }
    }

    // Start HTTP API server
    await this.apiServer.listen();

    // Initial metrics collection
    await this.collectMetrics();

    // Schedule metrics collection
    const metricsIntervalMs = this.config.hems.metrics.interval * 1000;
    this.metricsTimer = setInterval(() => void this.collectMetrics(), metricsIntervalMs);

    const processIntervalMs = this.config.hems.metrics.processInterval * 1000;
    this.processTimer = setInterval(() => void this.collectProcesses(), processIntervalMs);

    // Start service checkers
    this.checker.start();

    console.log("[hems] Service started");
  }

  private async collectMetrics(): Promise<void> {
    try {
      const snapshot = await getPcSnapshot();
      this.lastSnapshot = snapshot;
      this.publisher.publishPcMetrics(snapshot);
      this.apiServer.updateSnapshot(snapshot);

      const uptime = Math.floor((Date.now() - this.startTime) / 1000);
      this.publisher.publishBridgeStatus(uptime);

      const { cpuHighThreshold, memHighThreshold, gpuTempHighThreshold, diskHighThreshold } =
        this.config.hems.metrics;

      if (snapshot.cpu.usage_percent >= cpuHighThreshold) {
        this.publisher.publishThresholdEvent("cpu_high", {
          usage_percent: snapshot.cpu.usage_percent,
        });
      }
      if (snapshot.memory.percent >= memHighThreshold) {
        this.publisher.publishThresholdEvent("memory_high", {
          percent: snapshot.memory.percent,
        });
      }
      if (snapshot.gpu && snapshot.gpu.temp_c >= gpuTempHighThreshold) {
        this.publisher.publishThresholdEvent("gpu_hot", { temp_c: snapshot.gpu.temp_c });
      }
      for (const disk of snapshot.disk) {
        if (disk.percent >= diskHighThreshold) {
          this.publisher.publishThresholdEvent("disk_low", {
            mount: disk.mount,
            percent: disk.percent,
          });
        }
      }
    } catch (err) {
      console.error("[hems] Metrics collection error:", err);
    }
  }

  private async collectProcesses(): Promise<void> {
    if (!this.lastSnapshot) return;
    this.publisher.publishProcesses(this.lastSnapshot.processes);
  }

  async stop(): Promise<void> {
    console.log("[hems] Stopping…");
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    if (this.processTimer) clearInterval(this.processTimer);
    this.checker.stop();
    this.publisher.disconnect();
    if (this.browser) await this.browser.close();
    await this.apiServer.close();
    console.log("[hems] Stopped");
  }
}
