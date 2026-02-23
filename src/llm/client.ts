import OpenAI from "openai";
import type { Config } from "../config/index.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

export type Message = ChatCompletionMessageParam;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  nativeToolCalls: boolean;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private contextSize: number;
  private _supportsToolCalling: boolean | null = null;

  constructor(config: Config) {
    const baseURL = this.resolveBaseUrl(config);
    this.client = new OpenAI({
      baseURL,
      apiKey: config.provider.apiKey ?? "ollama",
    });
    this.model = config.provider.model;
    this.contextSize = config.provider.contextSize;
  }

  private resolveBaseUrl(config: Config): string {
    if (config.provider.type === "ollama") {
      return config.provider.baseUrl + "/v1";
    }
    return config.provider.baseUrl;
  }

  get modelName(): string {
    return this.model;
  }

  get maxContextSize(): number {
    return this.contextSize;
  }

  async supportsToolCalling(): Promise<boolean> {
    if (this._supportsToolCalling !== null) return this._supportsToolCalling;
    try {
      await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: "ping" }],
        tools: [
          {
            type: "function",
            function: {
              name: "test",
              description: "test",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        max_tokens: 5,
      });
      this._supportsToolCalling = true;
    } catch {
      this._supportsToolCalling = false;
    }
    return this._supportsToolCalling;
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    useNativeTools = true,
    onToken?: (token: string) => void
  ): Promise<LLMResponse> {
    const openAITools = tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: useNativeTools && openAITools?.length ? openAITools : undefined,
      tool_choice:
        useNativeTools && openAITools?.length ? "auto" : undefined,
      stream: true,
    });

    let content = "";
    const toolCallsMap: Record<
      number,
      { id: string; name: string; argumentsStr: string }
    > = {};
    let nativeToolCalls = false;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        onToken?.(delta.content);
      }

      if (delta.tool_calls) {
        nativeToolCalls = true;
        for (const tc of delta.tool_calls) {
          if (!toolCallsMap[tc.index]) {
            toolCallsMap[tc.index] = {
              id: tc.id ?? `tc_${tc.index}`,
              name: tc.function?.name ?? "",
              argumentsStr: "",
            };
          }
          if (tc.function?.name) {
            toolCallsMap[tc.index].name = tc.function.name;
          }
          if (tc.function?.arguments) {
            toolCallsMap[tc.index].argumentsStr += tc.function.arguments;
          }
          if (tc.id) {
            toolCallsMap[tc.index].id = tc.id;
          }
        }
      }
    }

    const toolCalls = nativeToolCalls
      ? Object.values(toolCallsMap).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: (() => {
            try {
              return JSON.parse(tc.argumentsStr);
            } catch {
              return {};
            }
          })(),
        }))
      : undefined;

    return { content, toolCalls, nativeToolCalls };
  }
}
