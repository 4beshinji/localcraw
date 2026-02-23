import { ImapFlow } from "imapflow";
import { Octokit } from "@octokit/rest";
import type { HemsConfig, } from "./config.ts";
import type { HemsBrowser } from "./browser.ts";

export interface ServiceStatus {
  name: string;
  available: boolean;
  unread_count: number;
  summary: string;
  details: string;
  error: string | null;
  last_check: string;
}

// ── Gmail ──────────────────────────────────────────────────────────────────────

export async function checkGmail(cfg: HemsConfig["gmail"]): Promise<ServiceStatus> {
  const base: ServiceStatus = {
    name: "gmail",
    available: false,
    unread_count: 0,
    summary: "",
    details: "",
    error: null,
    last_check: new Date().toISOString(),
  };

  if (!cfg.enabled || !cfg.email || !cfg.appPassword) {
    return { ...base, error: "Gmail not configured" };
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: cfg.email, pass: cfg.appPassword },
    logger: false,
  });

  try {
    await client.connect();
    const mailbox = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { unseen: true });
      const unread = status.unseen ?? 0;

      // Fetch subjects of up to 5 recent unread messages
      const subjects: string[] = [];
      if (unread > 0) {
        for await (const msg of client.fetch(
          { seen: false },
          { envelope: true },
          { uid: true }
        )) {
          subjects.push(msg.envelope?.subject ?? "(no subject)");
          if (subjects.length >= 5) break;
        }
      }

      base.available = true;
      base.unread_count = unread;
      base.summary = unread > 0
        ? `${unread} unread: ${subjects.slice(0, 3).join(", ")}${subjects.length > 3 ? "…" : ""}`
        : "No unread messages";
      base.details = subjects.join("\n");
    } finally {
      mailbox.release();
    }
    await client.logout();
    return base;
  } catch (err) {
    return { ...base, error: String(err) };
  }
}

// ── GitHub ─────────────────────────────────────────────────────────────────────

export async function checkGitHub(cfg: HemsConfig["github"]): Promise<ServiceStatus> {
  const base: ServiceStatus = {
    name: "github",
    available: false,
    unread_count: 0,
    summary: "",
    details: "",
    error: null,
    last_check: new Date().toISOString(),
  };

  if (!cfg.enabled || !cfg.token) {
    return { ...base, error: "GitHub not configured" };
  }

  try {
    const octokit = new Octokit({ auth: cfg.token });
    const { data } = await octokit.activity.listNotificationsForAuthenticatedUser({
      all: false,
      per_page: 50,
    });

    const unread = data.filter((n) => n.unread).length;
    const repos = [...new Set(data.filter((n) => n.unread).map((n) => n.repository.name))];
    const subjects = data
      .filter((n) => n.unread)
      .slice(0, 5)
      .map((n) => `[${n.repository.name}] ${n.subject.title}`);

    base.available = true;
    base.unread_count = unread;
    base.summary = unread > 0
      ? `${unread} notifications in: ${repos.slice(0, 3).join(", ")}`
      : "No unread notifications";
    base.details = subjects.join("\n");
    return base;
  } catch (err) {
    return { ...base, error: String(err) };
  }
}

// ── Browser checker ──────────────────────────────────────────────────────────

export async function checkBrowser(
  cfg: HemsConfig["browserCheckers"][number],
  browser: HemsBrowser
): Promise<ServiceStatus> {
  const base: ServiceStatus = {
    name: cfg.name,
    available: false,
    unread_count: 0,
    summary: "",
    details: "",
    error: null,
    last_check: new Date().toISOString(),
  };
  try {
    const result = await browser.runChecker(cfg);
    base.available = true;
    base.unread_count = result.unread_count;
    base.summary = result.summary;
    return base;
  } catch (err) {
    return { ...base, error: String(err) };
  }
}

// ── Service checker manager ───────────────────────────────────────────────────

export class ServiceCheckerManager {
  private statuses: Map<string, ServiceStatus> = new Map();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private cfg: HemsConfig,
    private onUpdate: (status: ServiceStatus, prev?: ServiceStatus) => void,
    private browser?: HemsBrowser
  ) {}

  start(): void {
    if (this.cfg.gmail.enabled) {
      this.scheduleCheck("gmail", () => checkGmail(this.cfg.gmail), this.cfg.gmail.interval);
    }
    if (this.cfg.github.enabled) {
      this.scheduleCheck("github", () => checkGitHub(this.cfg.github), this.cfg.github.interval);
    }
    if (this.browser && this.cfg.browserCheckers.length > 0) {
      for (const checkerCfg of this.cfg.browserCheckers) {
        this.scheduleCheck(
          checkerCfg.name,
          () => checkBrowser(checkerCfg, this.browser!),
          checkerCfg.interval
        );
      }
    }
  }

  private scheduleCheck(
    name: string,
    check: () => Promise<ServiceStatus>,
    intervalSec: number
  ): void {
    const run = async () => {
      const status = await check().catch((err) => ({
        name,
        available: false,
        unread_count: 0,
        summary: "",
        details: "",
        error: String(err),
        last_check: new Date().toISOString(),
      }));
      const prev = this.statuses.get(name);
      this.statuses.set(name, status);
      this.onUpdate(status, prev);
    };

    // Run immediately, then on interval
    void run();
    const timer = setInterval(() => void run(), intervalSec * 1000);
    this.timers.push(timer);
  }

  getStatus(name: string): ServiceStatus | undefined {
    return this.statuses.get(name);
  }

  getAllStatuses(): ServiceStatus[] {
    return Array.from(this.statuses.values());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
