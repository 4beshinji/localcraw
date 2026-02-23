import type { Message } from "./client.ts";
import type { LLMClient } from "./client.ts";
import type { Config } from "../config/index.ts";

/** Approximate token count using char/4 heuristic */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content) + 4; // role overhead
  }
  if (Array.isArray(msg.content)) {
    return (
      msg.content.reduce((sum, part) => {
        if (part.type === "text") return sum + estimateTokens(part.text);
        return sum + 10;
      }, 0) + 4
    );
  }
  return 10;
}

export function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Compress conversation history when it exceeds the threshold.
 * Keeps the system message and the last `keepRecentTurns` user/assistant pairs intact.
 * The middle portion is summarized by the LLM.
 */
export async function compressIfNeeded(
  messages: Message[],
  client: LLMClient,
  config: Config
): Promise<Message[]> {
  const { maxTokens, compressionThreshold, keepRecentTurns } = config.context;
  const threshold = Math.floor(maxTokens * compressionThreshold);
  const current = totalTokens(messages);

  if (current <= threshold) return messages;

  // Separate system message
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversational = messages.filter((m) => m.role !== "system");

  // Keep last N turns (user + assistant pairs = 2 * keepRecentTurns)
  const keepCount = keepRecentTurns * 2;
  if (conversational.length <= keepCount) return messages;

  const toCompress = conversational.slice(0, conversational.length - keepCount);
  const toKeep = conversational.slice(conversational.length - keepCount);

  // Build summary prompt
  const historyText = toCompress
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `${role}: ${content}`;
    })
    .join("\n\n");

  const summaryMessages: Message[] = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Summarize the following conversation history concisely, preserving key facts, decisions, and context. Output only the summary.",
    },
    {
      role: "user",
      content: `Please summarize this conversation:\n\n${historyText}`,
    },
  ];

  let summary = "";
  try {
    const result = await client.chat(summaryMessages, undefined, false);
    summary = result.content;
  } catch {
    // If summarization fails, just truncate
    summary = "[Earlier conversation history truncated due to context limits]";
  }

  const summaryMessage: Message = {
    role: "assistant",
    content: `[Summary of earlier conversation]\n${summary}`,
  };

  return [...systemMessages, summaryMessage, ...toKeep];
}
