import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/index.ts";
import type { Message } from "../llm/client.ts";
import type { Config } from "../config/index.ts";
import type { MemoryStore } from "../memory/store.ts";
import { loadSkills, selectRelevantSkills } from "../skills/loader.ts";
import { compressIfNeeded } from "../llm/compress.ts";
import type { LLMClient } from "../llm/client.ts";

const AGENT_FILE_PATHS = [
  join(process.cwd(), "AGENTS.md"),
  join(getConfigDir(), "AGENTS.md"),
];

const SOUL_FILE_PATHS = [
  join(process.cwd(), "SOUL.md"),
  join(getConfigDir(), "SOUL.md"),
];

function loadOptionalFile(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function buildSystemPrompt(
  userQuery: string,
  config: Config,
  memories: Array<{ content: string }>,
  reactToolInstructions?: string
): string {
  const parts: string[] = [];

  // Agent identity
  const agentsDoc = loadOptionalFile(AGENT_FILE_PATHS);
  if (agentsDoc) {
    parts.push(agentsDoc);
  } else {
    parts.push(
      "You are a helpful AI assistant running locally. You help users with tasks using available tools."
    );
  }

  // Soul/personality
  const soulDoc = loadOptionalFile(SOUL_FILE_PATHS);
  if (soulDoc) {
    parts.push("\n## Personality\n" + soulDoc);
  }

  // Relevant skills
  const allSkills = loadSkills();
  const relevantSkills = selectRelevantSkills(userQuery, allSkills);
  if (relevantSkills.length > 0) {
    parts.push(
      "\n## Relevant Skills\n" +
        relevantSkills.map((s) => `### ${s.name}\n${s.content}`).join("\n\n")
    );
  }

  // Memory context
  if (memories.length > 0) {
    parts.push(
      "\n## Relevant Memories\n" + memories.map((m) => `- ${m.content}`).join("\n")
    );
  }

  // ReAct tool instructions (appended when not using native tool calling)
  if (reactToolInstructions) {
    parts.push("\n" + reactToolInstructions);
  }

  return parts.join("\n");
}

export async function buildContextMessages(
  conversationHistory: Message[],
  userQuery: string,
  config: Config,
  client: LLMClient,
  memoryStore: MemoryStore,
  reactToolInstructions?: string
): Promise<Message[]> {
  // Search memory for relevant context
  let memories: Array<{ content: string }> = [];
  try {
    memories = await memoryStore.search(userQuery);
  } catch {
    // Memory search failure is non-fatal
  }

  const systemContent = buildSystemPrompt(
    userQuery,
    config,
    memories,
    reactToolInstructions
  );

  const systemMessage: Message = {
    role: "system",
    content: systemContent,
  };

  // Build full message list
  const allMessages: Message[] = [systemMessage, ...conversationHistory];

  // Compress if needed
  const compressed = await compressIfNeeded(allMessages, client, config);

  return compressed;
}
