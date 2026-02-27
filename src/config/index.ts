import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import JSON5 from "json5";

const ProviderSchema = z.object({
  type: z.enum(["ollama", "vllm", "openai"]).default("ollama"),
  baseUrl: z.string().default("http://localhost:11434"),
  model: z.string().default("qwen2.5:14b"),
  embedModel: z.string().default("nomic-embed-text"),
  contextSize: z.number().int().positive().default(8192),
  apiKey: z.string().optional(),
});

const ToolCallingSchema = z.object({
  mode: z.enum(["native", "react", "auto"]).default("auto"),
  retries: z.number().int().min(0).max(10).default(3),
});

const DockerSchema = z.object({
  enabled: z.boolean().default(true),
  image: z.string().default("ubuntu:22.04"),
  memoryLimit: z.string().default("512m"),
  cpuLimit: z.string().default("1.0"),
  timeoutSec: z.number().int().positive().default(30),
  network: z.boolean().default(false),
});

const MemorySchema = z.object({
  dbPath: z.string().default("~/.localcraw/memory.sqlite"),
  maxResults: z.number().int().positive().default(5),
  similarityThreshold: z.number().min(0).max(1).default(0.7),
  useEmbeddings: z.boolean().default(true),
});

const ContextSchema = z.object({
  maxTokens: z.number().int().positive().default(6000),
  compressionThreshold: z.number().min(0).max(1).default(0.75),
  keepRecentTurns: z.number().int().positive().default(4),
});

const DiscordSchema = z.object({
  token: z.string(),
  clientId: z.string(),
  slashCommand: z.boolean().default(true),
  mentionReply: z.boolean().default(true),
  allowedGuilds: z.array(z.string()).default([]),
});

const SlackSchema = z.object({
  botToken: z.string(),
  appToken: z.string(),
  signingSecret: z.string(),
  respondInThreads: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  provider: ProviderSchema.default({}),
  toolCalling: ToolCallingSchema.default({}),
  docker: DockerSchema.default({}),
  memory: MemorySchema.default({}),
  context: ContextSchema.default({}),
  discord: DiscordSchema.optional(),
  slack: SlackSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const CONFIG_DIR = join(homedir(), ".localcraw");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/** Build partial discord/slack objects from env vars, returning undefined if no relevant vars are set */
function overlayBotEnvVars(parsed: Record<string, unknown>): void {
  const dToken = process.env.LOCALCRAW_DISCORD_TOKEN ?? process.env.DISCORD_TOKEN;
  const dClientId = process.env.LOCALCRAW_DISCORD_CLIENT_ID ?? process.env.DISCORD_CLIENT_ID;
  if (dToken && dClientId) {
    parsed.discord = {
      ...(typeof parsed.discord === "object" && parsed.discord != null ? parsed.discord : {}),
      token: dToken,
      clientId: dClientId,
    };
  }

  const sBot = process.env.LOCALCRAW_SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
  const sApp = process.env.LOCALCRAW_SLACK_APP_TOKEN ?? process.env.SLACK_APP_TOKEN;
  const sSec = process.env.LOCALCRAW_SLACK_SIGNING_SECRET ?? process.env.SLACK_SIGNING_SECRET;
  if (sBot && sApp && sSec) {
    parsed.slack = {
      ...(typeof parsed.slack === "object" && parsed.slack != null ? parsed.slack : {}),
      botToken: sBot,
      appToken: sApp,
      signingSecret: sSec,
    };
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_PATH)) {
    const base: Record<string, unknown> = {};
    overlayBotEnvVars(base);
    const cfg = ConfigSchema.parse(base);
    // Only write defaults (without bot secrets) to disk
    const { discord: _d, slack: _s, ...rest } = cfg;
    writeFileSync(CONFIG_PATH, JSON.stringify(rest, null, 2));
    cfg.memory.dbPath = expandHome(cfg.memory.dbPath);
    return cfg;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON5.parse(raw);
    overlayBotEnvVars(parsed);
    const cfg = ConfigSchema.parse(parsed);
    cfg.memory.dbPath = expandHome(cfg.memory.dbPath);
    return cfg;
  } catch (err) {
    console.error("Config parse error, using defaults:", err);
    return defaultConfig();
  }
}

export function getConfigDir(): string {
  ensureConfigDir();
  return CONFIG_DIR;
}

export function getSessionsDir(): string {
  const d = join(CONFIG_DIR, "sessions");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
