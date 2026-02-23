import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { getSessionsDir } from "../config/index.ts";
import type { Message } from "../llm/client.ts";


export interface SessionEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class Session {
  readonly id: string;
  private filePath: string;
  private _messages: Message[] = [];

  constructor(id?: string) {
    this.id = id ?? randomUUID();
    this.filePath = join(getSessionsDir(), `${this.id}.jsonl`);

    if (id && existsSync(this.filePath)) {
      this.load();
    }
  }

  get messages(): Message[] {
    return this._messages;
  }

  addMessage(message: Message): void {
    this._messages.push(message);
    this.appendEvent({
      type: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      timestamp: new Date().toISOString(),
    });
  }

  logToolCall(name: string, args: Record<string, unknown>): void {
    this.appendEvent({
      type: "tool_call",
      content: JSON.stringify({ name, args }),
      timestamp: new Date().toISOString(),
    });
  }

  logToolResult(name: string, result: string, success: boolean): void {
    this.appendEvent({
      type: "tool_result",
      content: result,
      timestamp: new Date().toISOString(),
      metadata: { name, success },
    });
  }

  private appendEvent(event: SessionEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n", "utf-8");
  }

  private load(): void {
    const raw = readFileSync(this.filePath, "utf-8");
    const events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as SessionEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is SessionEvent => e !== null);

    for (const event of events) {
      if (event.type === "user") {
        this._messages.push({ role: "user", content: event.content });
      } else if (event.type === "assistant") {
        this._messages.push({ role: "assistant", content: event.content });
      }
    }
  }

  static listSessions(): Array<{ id: string; date: string }> {
    const dir = getSessionsDir();
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({
        id: f.replace(".jsonl", ""),
        date: statSync(join(dir, f)).mtime.toISOString(),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
}
