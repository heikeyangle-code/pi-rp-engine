/**
 * Unified, provider-neutral LLM helper for Pi's official `ctx.modelRegistry`.
 *
 * v3 Hardening:
 *  - Strips reasoning/CoT tags (`<think>`, `<thinking>`, `<reasoning>`) before downstream parsing.
 *  - Provides balanced-brace JSON extraction (`extractJsonObject`) immune to thinking braces or multiple code blocks.
 *  - Exposes `resolveSidecarModel` & `listRegistryModels` for selecting dedicated fast/cheap sidecar models.
 *  - Prefers `ctx.modelRegistry.streamSimple(model, context, options).result()` and cleanly falls back to `.complete()`.
 */

import type { PiContentBlock, PiExtensionContext, PiModelDescriptor } from "../types.js";

export interface RegistryLlmRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** If true (default), strip `<think>...</think>` blocks from returned text. */
  stripThinking?: boolean;
}

/** Strip model reasoning blocks (`<think>`, `<thinking>`, `<reasoning>`) safely without losing actual output. */
export function stripThinkingBlocks(raw: string): string {
  if (!raw) return "";
  let text = raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking\s*>/gi, "")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning\s*>/gi, "");

  // Handle unclosed leading `<think>` if a model ran out of tokens mid-thought
  const unclosedIdx = text.search(/<(?:think|thinking|reasoning)\b[^>]*>/i);
  if (unclosedIdx >= 0) {
    const before = text.slice(0, unclosedIdx).trim();
    if (before) text = before;
  }
  return text.trim();
}

/**
 * Balanced-brace JSON object extractor.
 * Strips `<think>` blocks first, tries fenced ```json blocks first, then walks balanced `{ ... }`
 * candidates from last-to-first / first-to-last so stray prose braces NEVER break JSON.parse!
 */
export function extractJsonObject<T = Record<string, unknown>>(raw: string): T | null {
  const cleaned = stripThinkingBlocks(raw);
  if (!cleaned) return null;

  // 1. Try direct parse first
  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as T;
  } catch {
    // continue
  }

  // 2. Try fenced ```json ... ``` blocks
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(cleaned)) !== null) {
    const body = fm[1]?.trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    } catch {
      // try next block
    }
  }

  // 3. Scan for balanced `{ ... }` objects respecting string literals & escapes
  const candidates: string[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(cleaned.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  // Prefer the largest valid JSON object (avoids tiny incidental `{}` snippets in prose)
  candidates.sort((a, b) => b.length - a.length);
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    } catch {
      // continue
    }
  }

  return null;
}

function extractTextFromResponse(resp: { content?: PiContentBlock[]; text?: string } | null | undefined): string {
  if (!resp) return "";
  if (typeof resp.text === "string" && resp.text.trim()) return resp.text;
  if (Array.isArray(resp.content)) {
    return resp.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** List available models from Pi's official `ctx.modelRegistry` in `"provider/id"` format. */
export function listRegistryModels(ctx: PiExtensionContext): Array<{ key: string; label: string; isFastHint: boolean; model: PiModelDescriptor }> {
  const reg = ctx.modelRegistry;
  if (!reg) return [];
  const rawList =
    (typeof reg.getAvailable === "function" ? reg.getAvailable() : undefined) ??
    (typeof reg.getAll === "function" ? reg.getAll() : undefined) ??
    [];

  const out: Array<{ key: string; label: string; isFastHint: boolean; model: PiModelDescriptor }> = [];
  const seen = new Set<string>();
  for (const m of rawList) {
    if (!m || typeof m !== "object") continue;
    const provider = typeof m.provider === "string" ? m.provider : "";
    const id = typeof m.id === "string" ? m.id : "";
    if (!provider || !id) continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isFastHint = /(?:flash|mini|haiku|nano|lite|fast|deepseek-chat|small|turbo|8b|7b|4o-mini)/i.test(id);
    const name = typeof m.name === "string" && m.name && m.name !== id ? ` (${m.name})` : "";
    out.push({ key, label: `${key}${name}`, isFastHint, model: m });
  }

  // Sort fast/cheap sidecar-friendly models first
  out.sort((a, b) => Number(b.isFastHint) - Number(a.isFastHint) || a.key.localeCompare(b.key));
  return out;
}

/** Resolve the configured sidecar model (`provider/id`), falling back cleanly to `ctx.model`. */
export function resolveSidecarModel(ctx: PiExtensionContext, sidecarModelKey?: string): unknown {
  if (sidecarModelKey && ctx.modelRegistry?.find) {
    const slashIdx = sidecarModelKey.indexOf("/");
    if (slashIdx > 0) {
      const provider = sidecarModelKey.slice(0, slashIdx);
      const id = sidecarModelKey.slice(slashIdx + 1);
      const found = ctx.modelRegistry.find(provider, id);
      if (found) return found;
    }
  }
  return ctx.model;
}

export function canCompleteWithRegistry(ctx: PiExtensionContext, explicitModel?: unknown): boolean {
  const reg = ctx.modelRegistry;
  const targetModel = explicitModel ?? ctx.model;
  if (!reg || !targetModel) return false;
  return typeof reg.streamSimple === "function" || typeof reg.complete === "function";
}

export async function completeWithRegistry(
  ctx: PiExtensionContext,
  model: unknown,
  req: RegistryLlmRequest,
): Promise<string> {
  const reg = ctx.modelRegistry;
  if (!reg || !model) return "";

  const context = {
    systemPrompt: req.systemPrompt,
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: req.userPrompt }],
        timestamp: Date.now(),
      },
    ],
  };

  const options: Record<string, unknown> = {};
  if (typeof req.maxTokens === "number") options.maxTokens = req.maxTokens;
  if (req.signal ?? ctx.signal) options.signal = req.signal ?? ctx.signal;

  let raw = "";
  if (typeof reg.streamSimple === "function") {
    const stream = reg.streamSimple(model, context, options);
    const finalMsg = await stream.result();
    raw = extractTextFromResponse(finalMsg);
  } else if (typeof reg.complete === "function") {
    const resp = await reg.complete(model, context, options);
    raw = extractTextFromResponse(resp);
  }

  return req.stripThinking === false ? raw : stripThinkingBlocks(raw);
}
