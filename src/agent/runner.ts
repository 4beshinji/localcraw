import type { Config } from "../config/index.ts";
import type { LLMClient, Message, ToolDefinition } from "../llm/client.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { Session } from "./session.ts";
import { buildContextMessages } from "./context.ts";
import {
  parseReActToolCalls,
  hasReActToolCall,
  stripReActMarkup,
  buildReActToolInstructions,
} from "../llm/toolcall.ts";

export interface RunOptions {
  onToken?: (token: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string, success: boolean) => void;
}

export class AgentRunner {
  private useNativeTools: boolean | null = null;

  constructor(
    private config: Config,
    private client: LLMClient,
    private tools: ToolRegistry,
    private memory: MemoryStore,
    private session: Session
  ) {}

  private async resolveToolMode(): Promise<boolean> {
    if (this.useNativeTools !== null) return this.useNativeTools;
    if (this.config.toolCalling.mode === "native") {
      this.useNativeTools = true;
    } else if (this.config.toolCalling.mode === "react") {
      this.useNativeTools = false;
    } else {
      // auto: detect capability
      this.useNativeTools = await this.client.supportsToolCalling();
    }
    return this.useNativeTools;
  }

  async run(userInput: string, opts: RunOptions = {}): Promise<string> {
    const nativeTools = await this.resolveToolMode();
    const toolDefs: ToolDefinition[] = this.tools.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const reactInstructions = !nativeTools
      ? buildReActToolInstructions(toolDefs)
      : undefined;

    // Add user message to session history
    const userMessage: Message = { role: "user", content: userInput };
    this.session.addMessage(userMessage);

    // Agent loop
    let loopCount = 0;
    const maxLoops = 10;
    let finalResponse = "";

    while (loopCount < maxLoops) {
      loopCount++;

      // Build context
      const contextMessages = await buildContextMessages(
        this.session.messages,
        userInput,
        this.config,
        this.client,
        this.memory,
        reactInstructions
      );

      // LLM call
      const response = await this.client.chat(
        contextMessages,
        toolDefs,
        nativeTools,
        opts.onToken
      );

      const { content, toolCalls, nativeToolCalls } = response;

      // Check for tool calls
      const hasNativeCall = nativeToolCalls && toolCalls && toolCalls.length > 0;
      const hasReAct = !nativeToolCalls && hasReActToolCall(content);

      if (!hasNativeCall && !hasReAct) {
        // No tool calls - this is the final response
        finalResponse = content;

        // Add assistant response to session
        this.session.addMessage({ role: "assistant", content });

        break;
      }

      // Process tool calls
      const callsToProcess = hasNativeCall
        ? toolCalls!
        : parseReActToolCalls(content).map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          }));

      // Add assistant message with tool calls
      if (hasNativeCall) {
        this.session.addMessage({
          role: "assistant",
          content,
        });
      } else {
        // For ReAct, add the thinking part (without markup)
        const thinking = stripReActMarkup(content);
        if (thinking) {
          this.session.addMessage({ role: "assistant", content: thinking });
        }
      }

      // Execute tools and collect results
      for (const call of callsToProcess) {
        opts.onToolCall?.(call.name, call.arguments);
        this.session.logToolCall(call.name, call.arguments);

        const result = await this.tools.execute(call.name, call.arguments);
        const resultText = result.success
          ? result.output
          : `Error: ${result.error ?? "unknown error"}`;

        opts.onToolResult?.(call.name, resultText, result.success);
        this.session.logToolResult(call.name, resultText, result.success);

        // Add tool result to conversation
        if (nativeTools && hasNativeCall) {
          const toolResultMessage: Message = {
            role: "tool",
            tool_call_id: call.id,
            content: resultText,
          };
          this.session.addMessage(toolResultMessage);
        } else {
          // For ReAct, inject as assistant observation
          const observationMessage: Message = {
            role: "user",
            content: `<tool_result>\n${resultText}\n</tool_result>`,
          };
          this.session.addMessage(observationMessage);
        }
      }

      // Continue loop to get next LLM response
    }

    if (loopCount >= maxLoops) {
      finalResponse =
        "I reached the maximum number of tool call iterations. Here is where I stopped: " +
        finalResponse;
    }

    // Extract and save memories from this conversation
    await this.extractAndSaveMemory(userInput, finalResponse);

    return finalResponse;
  }

  private async extractAndSaveMemory(
    userInput: string,
    response: string
  ): Promise<void> {
    // Simple heuristic: save meaningful exchanges as memories
    // A more sophisticated approach would use LLM to decide what to remember
    const combined = `User: ${userInput}\nAssistant: ${response}`;
    if (combined.length > 50 && combined.length < 2000) {
      try {
        await this.memory.add(combined, {
          type: "conversation",
          session: this.session.id,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Memory save failure is non-fatal
      }
    }
  }
}
