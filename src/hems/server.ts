/**
 * HEMS HTTP API server — drop-in replacement for openclaw-bridge.
 * Exposes the same endpoints the HEMS brain expects.
 */
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import type { HemsConfig } from "./config.ts";
import type { PcSnapshot } from "./metrics.ts";
import type { ServiceStatus } from "./services.ts";
import type { HemsBrowser } from "./browser.ts";

const execFileAsync = promisify(execFile);

// Dangerous command patterns (mirrors HEMS sanitizer.py)
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+of=\/dev\//,
  /shutdown/,
  /reboot/,
  /chmod\s+777\s+\//,
  /:\(\)\{\s*:\|:&\s*\}/, // fork bomb
  />\s*\/dev\/(sd[a-z]|nvme)/,
];

function isSafeCommand(cmd: string): boolean {
  return !DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export class HemsApiServer {
  private server: ReturnType<typeof createServer>;
  private startTime = Date.now();
  private latestSnapshot: PcSnapshot | null = null;
  private serviceStatuses: Map<string, ServiceStatus> = new Map();
  private browser: HemsBrowser | null = null;

  constructor(private cfg: HemsConfig) {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }

  setBrowser(browser: HemsBrowser): void {
    this.browser = browser;
  }

  updateSnapshot(snapshot: PcSnapshot): void {
    this.latestSnapshot = snapshot;
  }

  updateServiceStatus(status: ServiceStatus): void {
    this.serviceStatuses.set(status.name, status);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS for brain container
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (url === "/health" && method === "GET") {
        json(res, 200, {
          status: "ok",
          uptime_s: Math.floor((Date.now() - this.startTime) / 1000),
          snapshot_available: !!this.latestSnapshot,
        });
        return;
      }

      if (url === "/api/pc/status" && method === "GET") {
        if (!this.latestSnapshot) {
          json(res, 503, { success: false, error: "Metrics not yet collected" });
          return;
        }
        json(res, 200, {
          success: true,
          result: JSON.stringify({
            cpu_percent: this.latestSnapshot.cpu.usage_percent,
            memory_percent: this.latestSnapshot.memory.percent,
            gpu_percent: this.latestSnapshot.gpu?.usage_percent ?? 0,
            bridge_connected: true,
            disk: this.latestSnapshot.disk,
          }),
        });
        return;
      }

      if (url === "/api/pc/processes" && method === "GET") {
        json(res, 200, {
          success: true,
          result: JSON.stringify(this.latestSnapshot?.processes ?? []),
        });
        return;
      }

      if (url === "/api/services/status" && method === "GET") {
        json(res, 200, {
          success: true,
          services: Array.from(this.serviceStatuses.values()),
        });
        return;
      }

      if (url === "/api/pc/command" && method === "POST") {
        const body = await readBody(req);
        let parsed: { command?: string; timeout?: number };
        try {
          parsed = JSON.parse(body);
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
          return;
        }

        const command = parsed.command ?? "";
        const timeoutMs = (parsed.timeout ?? this.cfg.metrics.interval * 3) * 1000;

        if (!command) {
          json(res, 400, { success: false, error: "command is required" });
          return;
        }

        if (!isSafeCommand(command)) {
          json(res, 403, { success: false, error: "Command blocked by safety filter" });
          console.warn(`[server] Blocked dangerous command: ${command}`);
          return;
        }

        try {
          const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
            timeout: timeoutMs,
            maxBuffer: 512 * 1024,
          });
          const output = [stdout, stderr].filter(Boolean).join("\n");
          json(res, 200, { success: true, result: output || "(no output)" });
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          json(res, 200, {
            success: false,
            result: [e.stdout, e.stderr].filter(Boolean).join("\n"),
            error: e.message ?? String(err),
          });
        }
        return;
      }

      if (url === "/api/pc/notify" && method === "POST") {
        const body = await readBody(req);
        let parsed: { title?: string; body?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
          return;
        }

        const title = parsed.title ?? "HEMS";
        const message = parsed.body ?? "";

        // Try common notification methods
        const notifyCmds = [
          `notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}"`,
          `osascript -e 'display notification "${message}" with title "${title}"'`,
        ];

        for (const cmd of notifyCmds) {
          try {
            await execFileAsync("sh", ["-c", cmd], { timeout: 5000 });
            json(res, 200, { success: true, result: "Notification sent" });
            return;
          } catch {
            continue;
          }
        }
        json(res, 200, { success: false, error: "No notification method available" });
        return;
      }

      // Browser endpoints — Playwright (Chromium)
      if (url.startsWith("/api/pc/browser/") && method === "POST") {
        if (!this.browser) {
          json(res, 503, { success: false, error: "Browser not initialized (HEMS_BROWSER_CHECKERS not configured or Chromium unavailable)" });
          return;
        }
        const body = await readBody(req);
        let parsed: Record<string, string> = {};
        try {
          if (body) parsed = JSON.parse(body);
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
          return;
        }

        const action = url.replace("/api/pc/browser/", "");
        try {
          switch (action) {
            case "navigate": {
              if (!parsed.url) { json(res, 400, { success: false, error: "url required" }); return; }
              await this.browser.navigate(parsed.url);
              json(res, 200, { success: true, result: `Navigated to ${parsed.url}` });
              break;
            }
            case "eval": {
              if (!parsed.javascript) { json(res, 400, { success: false, error: "javascript required" }); return; }
              const result = await this.browser.eval(parsed.javascript);
              json(res, 200, { success: true, result: JSON.stringify(result) });
              break;
            }
            case "get_url": {
              const currentUrl = await this.browser.getUrl();
              json(res, 200, { success: true, result: currentUrl });
              break;
            }
            case "get_title": {
              const title = await this.browser.getTitle();
              json(res, 200, { success: true, result: title });
              break;
            }
            default:
              json(res, 404, { success: false, error: `Unknown browser action: ${action}` });
          }
        } catch (err) {
          json(res, 200, { success: false, error: String(err) });
        }
        return;
      }

      if (url === "/api/pc/process/kill" && method === "POST") {
        const body = await readBody(req);
        let parsed: { pid?: number };
        try {
          parsed = JSON.parse(body);
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
          return;
        }
        const pid = parsed.pid;
        if (!pid) {
          json(res, 400, { success: false, error: "pid is required" });
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          json(res, 200, { success: true, result: `Sent SIGTERM to pid ${pid}` });
        } catch (err) {
          json(res, 200, { success: false, error: String(err) });
        }
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  }

  listen(): Promise<void> {
    const { port, host } = this.cfg.server;
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        console.log(`[server] HEMS API listening on http://${host}:${port}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
