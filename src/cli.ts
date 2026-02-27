#!/usr/bin/env tsx
import { createInterface } from "readline";
import { program } from "commander";
import { loadConfig } from "./config/index.ts";
import { loadHemsConfig } from "./hems/config.ts";
import { LLMClient } from "./llm/client.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { readFileTool, writeFileTool, listDirTool, searchFilesTool } from "./tools/filesystem.ts";
import { createShellTool } from "./tools/shell.ts";
import { webFetchTool } from "./tools/web.ts";
import { pcStatusTool, pcProcessesTool } from "./tools/hems/pc.ts";
import { createMqttTools } from "./tools/hems/mqtt.ts";
import { createHaTools } from "./tools/hems/ha.ts";
import { MemoryStore } from "./memory/store.ts";
import { Session } from "./agent/session.ts";
import { AgentRunner } from "./agent/runner.ts";
import { HemsService } from "./hems/service.ts";

program
  .name("localcraw")
  .description("Local LLM agent - minimal OpenClaw implementation")
  .version("0.1.0");

// ── chat command ──────────────────────────────────────────────────────────────
program
  .command("chat")
  .description("Start an interactive chat session with the agent")
  .option("-m, --message <msg>", "Send a single message (one-shot mode)")
  .option("-s, --session <id>", "Resume an existing session by ID")
  .option("--hems", "Load HEMS tools (PC metrics, MQTT, Home Assistant)")
  .action(async (opts: { message?: string; session?: string; hems?: boolean }) => {
    const config = opts.hems ? loadHemsConfig() : loadConfig();
    const client = new LLMClient(config);
    const memory = new MemoryStore(config);
    const session = new Session(opts.session);

    const registry = new ToolRegistry();
    registry.register(readFileTool);
    registry.register(writeFileTool);
    registry.register(listDirTool);
    registry.register(searchFilesTool);
    registry.register(createShellTool(config, process.cwd()));
    registry.register(webFetchTool);

    // HEMS-specific tools
    if (opts.hems) {
      const hemsCfg = (config as ReturnType<typeof loadHemsConfig>).hems;
      registry.register(pcStatusTool);
      registry.register(pcProcessesTool);
      for (const t of createMqttTools(hemsCfg)) registry.register(t);
      for (const t of createHaTools(hemsCfg.homeAssistant)) registry.register(t);
    }

    const runner = new AgentRunner(config, client, registry, memory, session);

    if (opts.message) {
      // One-shot mode
      await runOnce(runner, opts.message);
      memory.close();
      return;
    }

    // Interactive mode
    console.log(`localcraw v0.1.0 — model: ${config.provider.model}`);
    console.log(`Session: ${session.id}`);
    console.log('Type "exit" or Ctrl+C to quit.\n');

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const ask = (): void => {
      rl.question("You: ", async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          ask();
          return;
        }
        if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
          console.log("Goodbye!");
          memory.close();
          rl.close();
          return;
        }

        try {
          process.stdout.write("Assistant: ");
          await runner.run(trimmed, {
            onToken: (t) => process.stdout.write(t),
            onToolCall: (name, args) => {
              process.stdout.write(`\n[Tool: ${name}(${JSON.stringify(args)})]\n`);
            },
            onToolResult: (name, result, success) => {
              const status = success ? "✓" : "✗";
              const preview = result.slice(0, 200) + (result.length > 200 ? "…" : "");
              process.stdout.write(`[${status} ${name}]: ${preview}\n`);
            },
          });
          process.stdout.write("\n\n");
        } catch (err) {
          console.error("\n[Error]", err instanceof Error ? err.message : err);
        }

        ask();
      });
    };

    rl.on("close", () => {
      memory.close();
      process.exit(0);
    });

    ask();
  });

async function runOnce(runner: AgentRunner, message: string): Promise<void> {
  let output = "";
  await runner.run(message, {
    onToken: (t) => {
      output += t;
    },
    onToolCall: (name, args) => {
      console.error(`[Tool: ${name}(${JSON.stringify(args)})]`);
    },
    onToolResult: (name, result, success) => {
      const status = success ? "✓" : "✗";
      const preview = result.slice(0, 200) + (result.length > 200 ? "…" : "");
      console.error(`[${status} ${name}]: ${preview}`);
    },
  });
  console.log(output);
}

// ── hems command ──────────────────────────────────────────────────────────────
const hemsCmd = program.command("hems").description("HEMS service commands");

hemsCmd
  .command("serve")
  .description("Run localcraw as openclaw-bridge replacement (metrics + API server)")
  .action(async () => {
    const config = loadHemsConfig();
    const service = new HemsService(config);

    const shutdown = async () => {
      await service.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    await service.start();
    console.log("Press Ctrl+C to stop.");
  });

hemsCmd
  .command("status")
  .description("Show current PC metrics snapshot")
  .action(async () => {
    const { getPcSnapshot } = await import("./hems/metrics.ts");
    const snapshot = await getPcSnapshot();
    console.log(JSON.stringify(snapshot, null, 2));
  });

// ── bot command ──────────────────────────────────────────────────────────────
const botCmd = program.command("bot").description("Run chat bot adapters");

botCmd
  .command("discord")
  .description("Start Discord bot")
  .option("--hems", "Load HEMS tools")
  .action(async (opts: { hems?: boolean }) => {
    // Overlay env vars onto config for Discord
    overlayBotEnv();
    const { startDiscordBot } = await import("./bots/discord.ts");
    await startDiscordBot({ hems: opts.hems });
  });

botCmd
  .command("slack")
  .description("Start Slack bot")
  .option("--hems", "Load HEMS tools")
  .action(async (opts: { hems?: boolean }) => {
    overlayBotEnv();
    const { startSlackBot } = await import("./bots/slack.ts");
    await startSlackBot({ hems: opts.hems });
  });

/** Push well-known env vars into config env so loadConfig picks them up */
function overlayBotEnv(): void {
  // Discord
  if (process.env.DISCORD_TOKEN) {
    process.env.LOCALCRAW_DISCORD_TOKEN = process.env.DISCORD_TOKEN;
  }
  if (process.env.DISCORD_CLIENT_ID) {
    process.env.LOCALCRAW_DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
  }
  // Slack
  if (process.env.SLACK_BOT_TOKEN) {
    process.env.LOCALCRAW_SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  }
  if (process.env.SLACK_APP_TOKEN) {
    process.env.LOCALCRAW_SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
  }
  if (process.env.SLACK_SIGNING_SECRET) {
    process.env.LOCALCRAW_SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  }
}

// ── config command ────────────────────────────────────────────────────────────
program
  .command("config")
  .description("Show current configuration")
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

// ── memory command ────────────────────────────────────────────────────────────
const memCmd = program.command("memory").description("Manage agent memories");

memCmd
  .command("search <query>")
  .description("Search memories")
  .action(async (query: string) => {
    const config = loadConfig();
    const store = new MemoryStore(config);
    const results = await store.search(query);
    if (results.length === 0) {
      console.log("No memories found.");
    } else {
      results.forEach((m, i) => {
        console.log(`\n[${i + 1}] (id=${m.id}, ${m.createdAt})`);
        console.log(m.content);
      });
    }
    store.close();
  });

memCmd
  .command("list")
  .description("List recent memories")
  .option("-n, --limit <n>", "Number of memories to show", "20")
  .action((opts: { limit: string }) => {
    const config = loadConfig();
    const store = new MemoryStore(config);
    const memories = store.getAll(parseInt(opts.limit, 10));
    if (memories.length === 0) {
      console.log("No memories stored.");
    } else {
      memories.forEach((m) => {
        console.log(`\n[id=${m.id}] ${m.createdAt}`);
        console.log(m.content.slice(0, 300) + (m.content.length > 300 ? "…" : ""));
      });
    }
    store.close();
  });

memCmd
  .command("delete <id>")
  .description("Delete a memory by ID")
  .action((id: string) => {
    const config = loadConfig();
    const store = new MemoryStore(config);
    store.delete(parseInt(id, 10));
    console.log(`Deleted memory ${id}`);
    store.close();
  });

program.parse();
