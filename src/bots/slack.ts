import { App } from "@slack/bolt";
import { createBotContext, createRunner, type BotContext } from "./setup.ts";
import type { AgentRunner, RunOptions } from "../agent/runner.ts";

const MAX_MSG_LEN = 4000;
const RUNNER_CACHE_MAX = 100;
const BATCH_INTERVAL_MS = 1500;

/** LRU runner cache keyed by session ID */
class RunnerCache {
  private map = new Map<string, AgentRunner>();
  private order: string[] = [];

  get(key: string): AgentRunner | undefined {
    return this.map.get(key);
  }

  set(key: string, runner: AgentRunner): void {
    if (this.map.has(key)) {
      this.order = this.order.filter((k) => k !== key);
    } else if (this.map.size >= RUNNER_CACHE_MAX) {
      const evict = this.order.shift()!;
      this.map.delete(evict);
    }
    this.map.set(key, runner);
    this.order.push(key);
  }
}

/** Per-session promise chain to prevent concurrent runs */
const sessionLocks = new Map<string, Promise<void>>();

function withLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(sessionId, next);
  return next;
}

/** Split text into chunks respecting Slack's message length limit */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", MAX_MSG_LEN);
    if (splitIdx < MAX_MSG_LEN / 2) splitIdx = MAX_MSG_LEN;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

function buildSessionId(
  threadTs: string | undefined,
  channelId: string,
  userId: string
): string {
  const scope = threadTs ?? channelId;
  return `slack-${scope}-${userId}`;
}

function getOrCreateRunner(
  cache: RunnerCache,
  ctx: BotContext,
  sessionId: string
): AgentRunner {
  let runner = cache.get(sessionId);
  if (!runner) {
    runner = createRunner(ctx, sessionId);
    cache.set(sessionId, runner);
  }
  return runner;
}

/** Strip bot mention from message text */
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

async function handleMessage(
  ctx: BotContext,
  cache: RunnerCache,
  app: App,
  channelId: string,
  threadTs: string | undefined,
  userId: string,
  text: string,
  respondInThreads: boolean
): Promise<void> {
  const userMsg = stripMention(text);
  if (!userMsg) return;

  const sessionId = buildSessionId(threadTs, channelId, userId);
  const replyThreadTs = respondInThreads ? (threadTs ?? undefined) : undefined;

  // Post "Thinking..." placeholder
  let placeholderTs: string | undefined;
  try {
    const result = await app.client.chat.postMessage({
      channel: channelId,
      text: "_Thinking..._",
      thread_ts: replyThreadTs,
    });
    placeholderTs = result.ts as string | undefined;
    // If this started a new thread, use the placeholder as the thread_ts
    if (!replyThreadTs && respondInThreads && placeholderTs) {
      // future messages in this exchange go to this thread
    }
  } catch (err) {
    console.error("[slack] Failed to post placeholder:", err);
  }

  const effectiveThreadTs = replyThreadTs ?? placeholderTs;

  await withLock(sessionId, async () => {
    const runner = getOrCreateRunner(cache, ctx, sessionId);
    let buffer = "";
    const toolOutputs: string[] = [];

    // Batch update timer
    let batchTimer: ReturnType<typeof setInterval> | null = null;
    const startBatch = () => {
      if (!placeholderTs) return;
      batchTimer = setInterval(async () => {
        if (buffer) {
          const display = buffer.slice(0, MAX_MSG_LEN - 50) + (buffer.length > MAX_MSG_LEN - 50 ? "..." : "");
          try {
            await app.client.chat.update({
              channel: channelId,
              ts: placeholderTs!,
              text: display,
            });
          } catch { /* ignore rate limits */ }
        }
      }, BATCH_INTERVAL_MS);
    };

    const runOpts: RunOptions = {
      onToken: (t) => { buffer += t; },
      onToolCall: (name) => { toolOutputs.push(`\`${name}\``); },
      onToolResult: (name, result, success) => {
        const status = success ? "ok" : "err";
        const preview = result.slice(0, 100) + (result.length > 100 ? "..." : "");
        toolOutputs.push(`> ${name} (${status}): ${preview}`);
      },
    };

    try {
      startBatch();
      await runner.run(userMsg, runOpts);
    } catch (err) {
      buffer = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (batchTimer) clearInterval(batchTimer);
    }

    // Append tool output summary as blockquote
    if (toolOutputs.length > 0) {
      buffer += "\n" + toolOutputs.join("\n");
    }

    const finalText = buffer || "(no response)";
    const chunks = splitMessage(finalText);

    try {
      // Update the placeholder with the first chunk
      if (placeholderTs) {
        await app.client.chat.update({
          channel: channelId,
          ts: placeholderTs,
          text: chunks[0],
        });
      } else {
        await app.client.chat.postMessage({
          channel: channelId,
          text: chunks[0],
          thread_ts: effectiveThreadTs,
        });
      }

      // Send remaining chunks as follow-up messages in the thread
      for (let i = 1; i < chunks.length; i++) {
        await app.client.chat.postMessage({
          channel: channelId,
          text: chunks[i],
          thread_ts: effectiveThreadTs,
        });
      }
    } catch (err) {
      console.error("[slack] Failed to send reply:", err);
    }
  });
}

export async function startSlackBot(opts: { hems?: boolean }): Promise<void> {
  const ctx = createBotContext(opts);
  const cfg = ctx.config.slack;
  if (!cfg) throw new Error("Slack config not found. Set SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.");

  const cache = new RunnerCache();
  const respondInThreads = cfg.respondInThreads;

  const app = new App({
    token: cfg.botToken,
    appToken: cfg.appToken,
    signingSecret: cfg.signingSecret,
    socketMode: true,
  });

  // ── app_mention: @bot in channels ───────────────────────────────────────────
  app.event("app_mention", async ({ event }) => {
    await handleMessage(
      ctx,
      cache,
      app,
      event.channel,
      event.thread_ts ?? event.ts,
      event.user,
      event.text,
      respondInThreads
    );
  });

  // ── message.im: direct messages ────────────────────────────────────────────
  app.event("message", async ({ event }) => {
    // Only handle DMs (im type), skip bot messages and subtypes
    if (event.channel_type !== "im") return;
    if ("bot_id" in event && event.bot_id) return;
    if ("subtype" in event && event.subtype) return;
    if (!("text" in event) || !event.text) return;
    if (!("user" in event) || !event.user) return;

    await handleMessage(
      ctx,
      cache,
      app,
      event.channel,
      event.thread_ts ?? undefined,
      event.user,
      event.text,
      respondInThreads
    );
  });

  await app.start();
  console.log("[slack] Bot ready (Socket Mode)");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[slack] Shutting down...");
    await app.stop();
    ctx.memory.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
