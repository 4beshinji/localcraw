import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Config } from "../config/index.ts";
import { getEmbedding, cosineSimilarity, bm25Score } from "./embed.ts";

export interface Memory {
  id: number;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface MemoryRow {
  id: number;
  content: string;
  embedding: Uint8Array | null;
  created_at: string;
  metadata: string;
}

export class MemoryStore {
  private db: DatabaseSync;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    const dbPath = config.memory.dbPath;

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    `);
  }

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<number> {
    const embedding = await getEmbedding(content, this.config);
    const embeddingBlob = embedding ? Buffer.from(embedding.buffer) : null;

    const stmt = this.db.prepare(
      "INSERT INTO memories (content, embedding, metadata) VALUES (?, ?, ?)"
    );
    const result = stmt.run(content, embeddingBlob, JSON.stringify(metadata));
    return result.lastInsertRowid as number;
  }

  async search(query: string): Promise<Memory[]> {
    const { maxResults, similarityThreshold } = this.config.memory;

    const rows = this.db
      .prepare("SELECT id, content, embedding, created_at, metadata FROM memories")
      .all() as unknown as MemoryRow[];

    if (rows.length === 0) return [];

    const queryEmbedding = await getEmbedding(query, this.config);

    const scored = rows.map((row) => {
      let vectorScore = 0;
      if (queryEmbedding && row.embedding) {
        const buf = row.embedding instanceof Uint8Array
          ? row.embedding.buffer
          : (row.embedding as Buffer).buffer;
        const stored = new Float32Array(buf);
        vectorScore = cosineSimilarity(queryEmbedding, stored);
      }

      const textScore = bm25Score(query, row.content);
      const normalizedText = Math.min(textScore / 10, 1);

      const score = queryEmbedding
        ? 0.6 * vectorScore + 0.4 * normalizedText
        : normalizedText;

      return { row, score };
    });

    return scored
      .filter((s) => s.score >= (queryEmbedding ? similarityThreshold * 0.6 : 0.01))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => ({
        id: s.row.id,
        content: s.row.content,
        createdAt: s.row.created_at,
        metadata: (() => {
          try {
            return JSON.parse(s.row.metadata) as Record<string, unknown>;
          } catch {
            return {};
          }
        })(),
      }));
  }

  getAll(limit = 100): Memory[] {
    const rows = this.db
      .prepare(
        "SELECT id, content, created_at, metadata FROM memories ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as unknown as Array<Omit<MemoryRow, "embedding">>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      metadata: (() => {
        try {
          return JSON.parse(r.metadata) as Record<string, unknown>;
        } catch {
          return {};
        }
      })(),
    }));
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}
