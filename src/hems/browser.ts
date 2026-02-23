/**
 * Playwright-based browser manager.
 * Provides persistent browser instance for control_browser and HEMS_BROWSER_CHECKERS.
 */
import { chromium, type Browser, type Page } from "playwright";

export interface BrowserCheckerConfig {
  name: string;
  url: string;
  js_script: string;
  interval: number; // seconds
}

export interface BrowserCheckerResult {
  unread_count: number;
  summary: string;
}

export class HemsBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private browserLock = false;

  async launch(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    const context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page = await context.newPage();
    console.log("[browser] Chromium launched");
  }

  async navigate(url: string, timeoutMs = 15000): Promise<void> {
    await this.ensureLaunched();
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async eval(javascript: string, timeoutMs = 10000): Promise<unknown> {
    await this.ensureLaunched();
    return await this.page!.evaluate(javascript);
  }

  async getUrl(): Promise<string> {
    await this.ensureLaunched();
    return this.page!.url();
  }

  async getTitle(): Promise<string> {
    await this.ensureLaunched();
    return this.page!.title();
  }

  /** Run a browser checker: navigate to URL, evaluate JS script, return result */
  async runChecker(cfg: BrowserCheckerConfig): Promise<BrowserCheckerResult> {
    // Mutex — prevent concurrent browser sessions
    if (this.browserLock) {
      throw new Error("Browser is busy with another checker");
    }
    this.browserLock = true;
    try {
      await this.navigate(cfg.url, 20000);
      // Wait for page to settle
      await this.page!.waitForTimeout(2000);
      const raw = await this.page!.evaluate(cfg.js_script);
      if (raw && typeof raw === "object" && "unread_count" in raw) {
        return raw as BrowserCheckerResult;
      }
      return { unread_count: 0, summary: String(raw) };
    } finally {
      this.browserLock = false;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  private async ensureLaunched(): Promise<void> {
    if (!this.browser || !this.page) await this.launch();
  }

  get isRunning(): boolean {
    return !!this.browser;
  }
}
