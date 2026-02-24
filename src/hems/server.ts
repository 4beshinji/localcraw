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

// API token for authenticating privileged endpoints.
// Set HEMS_API_TOKEN env var; if unset, privileged endpoints are disabled.
const API_TOKEN = process.env.HEMS_API_TOKEN ?? "";

// Whether browser eval endpoint is allowed (opt-in, disabled by default).
const ALLOW_BROWSER_EVAL = process.env.HEMS_ALLOW_BROWSER_EVAL === "true";

// Rate limiting: max requests per window per IP
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Dangerous command patterns (mirrors HEMS sanitizer.py)
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//i,
  /mkfs/i,
  /dd\s+of=\/dev\//i,
  /shutdown/i,
  /reboot/i,
  /chmod\s+777\s+\//i,
  /:\(\)\{\s*:\|:&\s*\}/, // fork bomb
  />\s*\/dev\/(sd[a-z]|nvme)/i,
];

function isSafeCommand(cmd: string): boolean {
  return !DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

/** Verify Bearer token for privileged endpoints. */
function isAuthenticated(req: IncomingMessage): boolean {
  if (!API_TOKEN) return false; // no token configured → all privileged endpoints disabled
  const auth = req.headers["authorization"] ?? "";
  return auth === `Bearer ${API_TOKEN}`;
}

// Fix-7: Maximum request body size to prevent DoS via large payloads
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.resume(); // drain remaining data
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
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

function addSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("X-XSS-Protection", "1; mode=block");
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

    // Security headers on all responses
    addSecurityHeaders(res);

    // Rate limiting
    const ip = String(req.socket.remoteAddress ?? "unknown");
    if (!checkRateLimit(ip)) {
      json(res, 429, { success: false, error: "Too many requests" });
      return;
    }

    // CORS — restrict to configured origin or localhost by default
    const allowedOrigin = process.env.HEMS_CORS_ORIGIN ?? "http://localhost";
    const requestOrigin = req.headers["origin"] ?? "";
    const corsOrigin =
      requestOrigin === allowedOrigin || requestOrigin === "" ? requestOrigin || allowedOrigin : "";
    if (corsOrigin) res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Vary", "Origin");
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
        // Fix-1: Require authentication; if no token configured, endpoint is disabled
        if (!API_TOKEN) {
          json(res, 503, { success: false, error: "Command endpoint disabled: HEMS_API_TOKEN not configured" });
          return;
        }
        if (!isAuthenticated(req)) {
          json(res, 401, { success: false, error: "Unauthorized" });
          return;
        }

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

        // Sanitize: limit length and strip control characters
        const title = (parsed.title ?? "HEMS").slice(0, 256).replace(/[\x00-\x1f]/g, "");
        const message = (parsed.body ?? "").slice(0, 1024).replace(/[\x00-\x1f]/g, "");

        // Fix-2: Use execFile with argument array — no shell interpolation, injection-safe
        const notifyMethods: Array<() => Promise<void>> = [
          () => execFileAsync("notify-send", [title, message], { timeout: 5000 }).then(() => {}),
          // osascript: build safe argument string using JSON.stringify to escape
          () => execFileAsync("osascript", [
            "-e",
            `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
          ], { timeout: 5000 }).then(() => {}),
        ];

        for (const tryNotify of notifyMethods) {
          try {
            await tryNotify();
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
              // Fix-3: eval is disabled by default; require both token auth and opt-in env var
              if (!ALLOW_BROWSER_EVAL) {
                json(res, 403, { success: false, error: "Browser eval disabled. Set HEMS_ALLOW_BROWSER_EVAL=true to enable." });
                return;
              }
              if (!isAuthenticated(req)) {
                json(res, 401, { success: false, error: "Unauthorized" });
                return;
              }
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
        // Fix-1 auth also applies here
        if (!API_TOKEN) {
          json(res, 503, { success: false, error: "Kill endpoint disabled: HEMS_API_TOKEN not configured" });
          return;
        }
        if (!isAuthenticated(req)) {
          json(res, 401, { success: false, error: "Unauthorized" });
          return;
        }

        const body = await readBody(req);
        let parsed: { pid?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          json(res, 400, { success: false, error: "Invalid JSON" });
          return;
        }

        // Fix-2: Validate pid is a positive integer above system PID threshold
        const rawPid = parsed.pid;
        const pid = typeof rawPid === "number" ? Math.trunc(rawPid) : NaN;
        if (!Number.isFinite(pid) || pid <= 0) {
          json(res, 400, { success: false, error: "pid must be a positive integer" });
          return;
        }
        // Block killing critical system/service processes (PID <= 100 heuristic)
        if (pid <= 100) {
          json(res, 403, { success: false, error: "Cannot kill system processes (pid <= 100)" });
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
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      json(res, status, { error: String(err) });
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
