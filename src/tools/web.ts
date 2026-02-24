import type { Tool, ToolResult } from "./registry.ts";

// Fix-10: Block SSRF to internal/private IP ranges and link-local addresses
const BLOCKED_HOSTNAMES = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|fd[0-9a-f]{2}:|fc[0-9a-f]{2}:)$/i;

function isSsrfTarget(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return BLOCKED_HOSTNAMES.test(hostname);
  } catch {
    return false;
  }
}

// Fix-11: Maximum raw response body size (10 MB) to prevent OOM
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

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
      new URL(url); // validate URL
    } catch {
      return { success: false, output: "", error: `Invalid URL: ${url}` };
    }

    // Fix-10: Block SSRF to internal/private network ranges
    if (isSsrfTarget(url)) {
      return { success: false, output: "", error: `Blocked: URL targets a private/internal address` };
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

      // Fix-11: Limit response body size to prevent OOM
      const contentLength = parseInt(res.headers.get("content-length") ?? "0", 10);
      if (contentLength > MAX_RESPONSE_BYTES) {
        return { success: false, output: "", error: `Response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES})` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const rawBytes = await res.arrayBuffer();
      if (rawBytes.byteLength > MAX_RESPONSE_BYTES) {
        return { success: false, output: "", error: `Response too large (${rawBytes.byteLength} bytes, max ${MAX_RESPONSE_BYTES})` };
      }
      const rawText = new TextDecoder().decode(rawBytes);

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
