/**
 * Optional Zero-Dependency Hybrid Semantic Embedding Recall (BM25 + Cosine Vector RRF).
 *
 * Bridges the lexical-semantic gap highlighted in MRBench (2026) & KDD 2026 RoleplayAgent Survey
 * (e.g. metaphors, paraphrases, and indirect references with zero keyword overlap).
 *
 * - Works with ANY OpenAI-compatible `/v1/embeddings` endpoint (OpenAI, SiliconFlow, local Ollama).
 * - Strict 3.5s timeout + graceful silent fallback to pure BM25 when disabled or unreachable.
 * - Content-hashed Float32Array LRU vector cache avoids re-embedding unchanged rounds or lore entries.
 */

import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "../types.js";

const MAX_CACHE_ENTRIES = 2048;
const EMBEDDING_BATCH_SIZE = 32;
const vectorCache = new Map<string, Float32Array>();

function cacheKey(endpoint: string, model: string, text: string): string {
  const hash = createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
  return `${endpoint}|${model}|${hash}`;
}

function lruGet(key: string): Float32Array | undefined {
  const hit = vectorCache.get(key);
  if (!hit) return undefined;
  // Promote to most-recently-used position
  vectorCache.delete(key);
  vectorCache.set(key, hit);
  return hit;
}

function lruSet(key: string, vec: Float32Array): void {
  if (vectorCache.has(key)) {
    vectorCache.delete(key);
  }
  vectorCache.set(key, vec);
  if (vectorCache.size > MAX_CACHE_ENTRIES) {
    const oldest = vectorCache.keys().next().value;
    if (oldest) vectorCache.delete(oldest);
  }
}

export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Reciprocal Rank Fusion (RRF, k=60): fuses BM25 ranked IDs and semantic vector ranked IDs
 * into a unified ranking without needing fragile score-scale calibration.
 */
export function reciprocalRankFusion<T extends string | number>(
  bm25Ranked: T[],
  semanticRanked: T[],
  k = 60,
): Array<{ id: T; score: number }> {
  const scores = new Map<T, number>();
  bm25Ranked.forEach((id, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });
  semanticRanked.forEach((id, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Batch-embed texts via an OpenAI-compatible `/embeddings` endpoint with LRU content caching
 * and automatic 32-text chunking.
 * Returns null cleanly if config is disabled, invalid, timed out, or errored.
 */
export async function embedTexts(
  config: EmbeddingConfig | undefined,
  texts: string[],
  timeoutMs = 3500,
): Promise<Array<Float32Array | null> | null> {
  if (!config?.enabled || !config.endpoint.trim() || !config.model.trim() || texts.length === 0) {
    return null;
  }

  const endpoint = config.endpoint.trim();
  const model = config.model.trim();
  const results: Array<Float32Array | null> = new Array(texts.length).fill(null);
  const missingIndices: number[] = [];
  const missingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const trimmed = (texts[i] ?? "").trim().slice(0, 1800);
    if (!trimmed) continue;
    const key = cacheKey(endpoint, model, trimmed);
    const cached = lruGet(key);
    if (cached) {
      results[i] = cached;
    } else {
      missingIndices.push(i);
      missingTexts.push(trimmed);
    }
  }

  if (missingTexts.length === 0) return results;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey?.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }

    for (let offset = 0; offset < missingTexts.length; offset += EMBEDDING_BATCH_SIZE) {
      const batchTexts = missingTexts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const batchIndices = missingIndices.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: batchTexts }),
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      if (!Array.isArray(json?.data)) return null;

      const rows: Array<{ index?: number; embedding?: number[] }> = json.data;
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        if (!row || !Array.isArray(row.embedding) || row.embedding.length === 0) continue;
        const pos = typeof row.index === "number" ? row.index : j;
        const origIdx = batchIndices[pos];
        const text = batchTexts[pos];
        if (origIdx === undefined || !text) continue;
        const vec = Float32Array.from(row.embedding);
        results[origIdx] = vec;
        lruSet(cacheKey(endpoint, model, text), vec);
      }
    }
    return results;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Rank candidate documents by cosine similarity against `query` (returns indices sorted desc). */
export async function rankBySemanticSimilarity(
  config: EmbeddingConfig | undefined,
  query: string,
  documents: string[],
  minSimilarity = 0.25,
): Promise<Array<{ index: number; similarity: number }> | null> {
  if (!config?.enabled || !query.trim() || documents.length === 0) return null;
  const vectors = await embedTexts(config, [query, ...documents]);
  if (!vectors || !vectors[0]) return null;
  const qVec = vectors[0];
  const scored: Array<{ index: number; similarity: number }> = [];
  for (let i = 0; i < documents.length; i++) {
    const dVec = vectors[i + 1];
    if (!dVec) continue;
    const sim = cosineSimilarity(qVec, dVec);
    if (sim >= minSimilarity) {
      scored.push({ index: i, similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored;
}
