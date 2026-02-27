import { loadConfig, type Config } from "../config/index.ts";
import { loadHemsConfig } from "../hems/config.ts";
import { LLMClient } from "../llm/client.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { readFileTool, writeFileTool, listDirTool, searchFilesTool } from "../tools/filesystem.ts";
import { createShellTool } from "../tools/shell.ts";
import { webFetchTool } from "../tools/web.ts";
import { pcStatusTool, pcProcessesTool } from "../tools/hems/pc.ts";
import { createMqttTools } from "../tools/hems/mqtt.ts";
import { createHaTools } from "../tools/hems/ha.ts";
import { MemoryStore } from "../memory/store.ts";
import { Session } from "../agent/session.ts";
import { AgentRunner } from "../agent/runner.ts";

export interface BotContext {
  config: Config;
  client: LLMClient;
  memory: MemoryStore;
  registry: ToolRegistry;
}

export function createBotContext(opts: { hems?: boolean } = {}): BotContext {
  const config = opts.hems ? loadHemsConfig() : loadConfig();
  const client = new LLMClient(config);
  const memory = new MemoryStore(config);

  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listDirTool);
  registry.register(searchFilesTool);
  registry.register(createShellTool(config, process.cwd()));
  registry.register(webFetchTool);

  if (opts.hems) {
    const hemsCfg = (config as ReturnType<typeof loadHemsConfig>).hems;
    registry.register(pcStatusTool);
    registry.register(pcProcessesTool);
    for (const t of createMqttTools(hemsCfg)) registry.register(t);
    for (const t of createHaTools(hemsCfg.homeAssistant)) registry.register(t);
  }

  return { config, client, memory, registry };
}

export function createRunner(ctx: BotContext, sessionId: string): AgentRunner {
  const session = new Session(sessionId);
  return new AgentRunner(ctx.config, ctx.client, ctx.registry, ctx.memory, session);
}
