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

export const ConfigSchema = z.object({
  provider: ProviderSchema.default({}),
  toolCalling: ToolCallingSchema.default({}),
  docker: DockerSchema.default({}),
  memory: MemorySchema.default({}),
  context: ContextSchema.default({}),
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

export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return cfg;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON5.parse(raw);
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
