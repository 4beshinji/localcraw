import type { Config } from "../config/index.ts";

/**
 * Get embeddings from Ollama embedding API.
 * Falls back to null if embeddings are unavailable.
 */
export async function getEmbedding(
  text: string,
  config: Config
): Promise<Float32Array | null> {
  if (!config.memory.useEmbeddings) return null;

  const url = config.provider.baseUrl.replace(/\/v1$/, "") + "/api/embeddings";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.provider.embedModel,
        prompt: text,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { embedding?: number[] };
    if (!data.embedding) return null;

    return new Float32Array(data.embedding);
  } catch {
    return null;
  }
}

/** Cosine similarity between two float32 vectors */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** BM25-inspired simple term frequency scoring */
export function bm25Score(query: string, document: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const docLower = document.toLowerCase();
  const docTerms = docLower.split(/\s+/);
  const docLen = docTerms.length;
  const avgDocLen = 100; // assumed average
  const k1 = 1.5;
  const b = 0.75;

  let score = 0;
  for (const term of queryTerms) {
    const tf = docTerms.filter((t) => t === term).length;
    if (tf === 0) continue;
    // Simplified BM25 without IDF (single document scoring)
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)));
    score += tfNorm;
  }
  return score;
}
