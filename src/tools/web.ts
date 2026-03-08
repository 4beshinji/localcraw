import type { Tool, ToolResult } from "./registry.ts";

/** Very lightweight HTML → plain text extraction */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return its text content",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      maxChars: {
        type: "string",
        description: "Maximum characters to return (default: 4000)",
      },
    },
    required: ["url"],
  },
  async execute(args): Promise<ToolResult> {
    const url = args.url as string;
    const maxChars = parseInt((args.maxChars as string) ?? "4000", 10) || 4000;

    if (!url) return { success: false, output: "", error: "url is required" };

    try {
      const parsed = new URL(url);

      // SSRF protection: block internal/private network access
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { success: false, output: "", error: `Blocked protocol: ${parsed.protocol} (only http/https allowed)` };
      }

      const hostname = parsed.hostname.toLowerCase();
      const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal", "169.254.169.254"];
      if (blockedHosts.includes(hostname) || hostname.endsWith(".local") || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
        return { success: false, output: "", error: "Blocked: access to internal/private network addresses is not allowed" };
      }
    } catch {
      return { success: false, output: "", error: `Invalid URL: ${url}` };
    }

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; localcraw/0.1; +https://github.com/localcraw)",
          Accept: "text/html,application/xhtml+xml,text/plain,*/*",
        },
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });

      if (!res.ok) {
        return {
          success: false,
          output: "",
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const rawText = await res.text();

      let text: string;
      if (contentType.includes("html")) {
        text = htmlToText(rawText);
      } else {
        text = rawText;
      }

      const truncated = text.slice(0, maxChars);
      const suffix =
        text.length > maxChars
          ? `\n\n[Content truncated at ${maxChars} chars, total ${text.length}]`
          : "";

      return { success: true, output: truncated + suffix };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};
