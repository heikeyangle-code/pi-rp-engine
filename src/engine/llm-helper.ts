/**
 * Unified, provider-neutral LLM helper for Pi's official `ctx.modelRegistry`.
 *
 * Uses `ctx.modelRegistry.streamSimple(model, context, options).result()` when available
 * (recommended by Pi docs for provider-neutral options like `maxTokens` and `signal`),
 * and cleanly falls back to `ctx.modelRegistry.complete(model, context, options)`.
 * Always supplies `timestamp` on `UserMessage` to match `@earendil-works/pi-ai` `Context`.
 */

import type { PiContentBlock, PiExtensionContext } from "../types.js";

export interface RegistryLlmRequest {
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
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

export function canCompleteWithRegistry(ctx: PiExtensionContext): boolean {
  const reg = ctx.modelRegistry;
  if (!reg || !ctx.model) return false;
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

  if (typeof reg.streamSimple === "function") {
    const stream = reg.streamSimple(model, context, options);
    const finalMsg = await stream.result();
    return extractTextFromResponse(finalMsg);
  }

  if (typeof reg.complete === "function") {
    const resp = await reg.complete(model, context, options);
    return extractTextFromResponse(resp);
  }

  return "";
}
