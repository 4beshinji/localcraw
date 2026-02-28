import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { createBotContext, createRunner, type BotContext } from "./setup.ts";
import type { AgentRunner, RunOptions } from "../agent/runner.ts";

const MAX_MSG_LEN = 2000;
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

/** Split text into chunks that respect the Discord message length limit */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MSG_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", MAX_MSG_LEN);
    if (splitIdx < MAX_MSG_LEN / 2) splitIdx = MAX_MSG_LEN;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

function buildSessionId(
  channelId: string,
  userId: string,
  threadId?: string
): string {
  const scope = threadId ?? channelId;
  return `discord-${scope}-${userId}`;
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

export async function startDiscordBot(opts: { hems?: boolean }): Promise<void> {
  const ctx = createBotContext(opts);
  const cfg = ctx.config.discord;
  if (!cfg) throw new Error("Discord config not found. Set DISCORD_TOKEN and DISCORD_CLIENT_ID.");

  const cache = new RunnerCache();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  // ── Register slash command ──────────────────────────────────────────────────
  if (cfg.slashCommand) {
    const rest = new REST({ version: "10" }).setToken(cfg.token);
    const command = new SlashCommandBuilder()
      .setName("chat")
      .setDescription("Chat with localcraw agent")
      .addStringOption((o) =>
        o.setName("message").setDescription("Your message").setRequired(true)
      );

    try {
      await rest.put(Routes.applicationCommands(cfg.clientId), {
        body: [command.toJSON()],
      });
      console.log("[discord] Slash command /chat registered");
    } catch (err) {
      console.error("[discord] Failed to register slash command:", err);
    }
  }

  // ── Slash command handler ───────────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "chat") return;

    const ci = interaction as ChatInputCommandInteraction;
    const userMsg = ci.options.getString("message", true);
    const sessionId = buildSessionId(
      ci.channelId,
      ci.user.id,
      ci.channel?.isThread() ? ci.channelId : undefined
    );

    // Guild filtering
    if (cfg.allowedGuilds.length > 0 && ci.guildId && !cfg.allowedGuilds.includes(ci.guildId)) {
      await ci.reply({ content: "This bot is not enabled for this server.", ephemeral: true });
      return;
    }

    await ci.deferReply();

    await withLock(sessionId, async () => {
      const runner = getOrCreateRunner(cache, ctx, sessionId);
      let buffer = "";
      const toolOutputs: string[] = [];

      // Batch update timer
      let batchTimer: ReturnType<typeof setInterval> | null = null;
      const startBatch = () => {
        batchTimer = setInterval(async () => {
          if (buffer) {
            const display = buffer.slice(0, MAX_MSG_LEN - 50) + (buffer.length > MAX_MSG_LEN - 50 ? "..." : "");
            try { await ci.editReply(display); } catch { /* ignore rate limits */ }
          }
        }, BATCH_INTERVAL_MS);
      };

      const runOpts: RunOptions = {
        onToken: (t) => { buffer += t; },
        onToolCall: (name) => { toolOutputs.push(`\`${name}\``); },
        onToolResult: (name, result, success) => {
          const status = success ? "ok" : "err";
          const preview = result.slice(0, 100) + (result.length > 100 ? "..." : "");
          toolOutputs.push(`-# ${name} (${status}): ${preview}`);
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

      // Append tool output summary
      if (toolOutputs.length > 0) {
        buffer += "\n" + toolOutputs.join("\n");
      }

      // Send final response
      const chunks = splitMessage(buffer || "(no response)");
      try {
        await ci.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await ci.followUp(chunks[i]);
        }
      } catch (err) {
        console.error("[discord] Failed to send reply:", err);
      }
    });
  });

  // ── Mention reply handler ───────────────────────────────────────────────────
  if (cfg.mentionReply) {
    client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot) return;
      if (!client.user) return;
      if (!message.mentions.has(client.user)) return;

      // Guild filtering
      if (cfg.allowedGuilds.length > 0 && message.guildId && !cfg.allowedGuilds.includes(message.guildId)) {
        return;
      }

      const userMsg = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim();
      if (!userMsg) return;

      const sessionId = buildSessionId(
        message.channelId,
        message.author.id,
        message.channel.isThread() ? message.channelId : undefined
      );

      // Show typing indicator (not available on PartialGroupDMChannel)
      const ch = message.channel;
      const canType = "sendTyping" in ch && typeof ch.sendTyping === "function";
      const typingInterval = setInterval(() => {
        if (canType) (ch as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }, 5000);
      if (canType) (ch as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});

      await withLock(sessionId, async () => {
        const runner = getOrCreateRunner(cache, ctx, sessionId);
        let buffer = "";
        const toolOutputs: string[] = [];

        const runOpts: RunOptions = {
          onToken: (t) => { buffer += t; },
          onToolCall: (name) => { toolOutputs.push(`\`${name}\``); },
          onToolResult: (name, result, success) => {
            const status = success ? "ok" : "err";
            const preview = result.slice(0, 100) + (result.length > 100 ? "..." : "");
            toolOutputs.push(`-# ${name} (${status}): ${preview}`);
          },
        };

        try {
          await runner.run(userMsg, runOpts);
        } catch (err) {
          buffer = `Error: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          clearInterval(typingInterval);
        }

        if (toolOutputs.length > 0) {
          buffer += "\n" + toolOutputs.join("\n");
        }

        const chunks = splitMessage(buffer || "(no response)");
        try {
          await message.reply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            if ("send" in message.channel && typeof message.channel.send === "function") {
              await (message.channel as { send: (c: string) => Promise<unknown> }).send(chunks[i]);
            }
          }
        } catch (err) {
          console.error("[discord] Failed to send mention reply:", err);
        }
      });
    });
  }

  // ── Login ───────────────────────────────────────────────────────────────────
  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] Bot ready as ${c.user.tag}`);
  });

  await client.login(cfg.token);

  // Graceful shutdown
  const shutdown = () => {
    console.log("[discord] Shutting down...");
    client.destroy();
    ctx.memory.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
