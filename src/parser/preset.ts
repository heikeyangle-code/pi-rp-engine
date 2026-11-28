/**
 * SillyTavern OpenAI / Chat Completion Preset Compiler.
 *
 * Maps ST Prompt Manager (`prompts[]` + `prompt_order[]` + `injection_position` + `injection_depth`)
 * into pi-rp-engine's Three-Zone KV-Cache Architecture with ZERO prefix invalidation:
 *  - Prompts ordered BEFORE `chatHistory` (and relative `injection_position === 0`) -> Zone 1 (Frozen Prefix)
 *  - Prompts ordered AFTER `chatHistory` OR `injection_position === 1` (@D depth) -> Zone 3 (Transient Tail,
 *    sorted by `injection_depth` descending so depth=0 sits closest to generation)
 *  - Utility prompts (`continue_nudge_prompt`, `impersonation_prompt`, `new_chat_prompt`, `wi_format`)
 *    -> directly power `/rp c` and `/rp act`.
 *  - Sampling hints (`temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `max_tokens`)
 *    -> preserved in `CompiledPreset.sampling`.
 */

import * as crypto from "node:crypto";
import type { CompiledPreset, CompiledPresetPrompt } from "../types.js";
import { sanitizeFrontendShell } from "./sanitizer.js";

const MARKER_IDENTIFIERS = new Set([
  "worldInfoBefore",
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
]);

function normalizeRole(raw: unknown): "system" | "user" | "assistant" {
  if (raw === "user" || raw === "assistant" || raw === "system") return raw;
  return "system";
}

function optNum(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function compileSillyTavernPreset(
  rawJson: Record<string, unknown>,
  options: { name?: string; rawPassthrough?: boolean } = {},
): CompiledPreset {
  const warnings: string[] = [];
  const rawPrompts = Array.isArray(rawJson.prompts)
    ? rawJson.prompts.filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
    : [];

  const byId = new Map<string, Record<string, unknown>>();
  for (const p of rawPrompts) {
    const id = typeof p.identifier === "string" ? p.identifier : "";
    if (id) byId.set(id, p);
  }

  // Resolve effective prompt_order: prefer character_id 100001 (active dummy), then 100000 (default), then last.
  const rawOrderGroups = Array.isArray(rawJson.prompt_order)
    ? rawJson.prompt_order.filter((g): g is Record<string, unknown> => Boolean(g && typeof g === "object"))
    : [];

  const chosenGroup =
    rawOrderGroups.find((g) => g.character_id === 100001) ??
    rawOrderGroups.find((g) => g.character_id === 100000) ??
    rawOrderGroups[rawOrderGroups.length - 1];

  const orderedEntries: Array<{ identifier: string; enabled: boolean }> = [];
  if (chosenGroup && Array.isArray(chosenGroup.order)) {
    for (const item of chosenGroup.order) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        const id = typeof rec.identifier === "string" ? rec.identifier : "";
        if (id) {
          const promptObj = byId.get(id);
          const enabled =
            typeof rec.enabled === "boolean"
              ? rec.enabled
              : typeof promptObj?.enabled === "boolean"
                ? promptObj.enabled
                : true;
          orderedEntries.push({ identifier: id, enabled });
        }
      }
    }
  } else {
    for (const p of rawPrompts) {
      const id = typeof p.identifier === "string" ? p.identifier : "";
      if (id) {
        orderedEntries.push({
          identifier: id,
          enabled: typeof p.enabled === "boolean" ? p.enabled : true,
        });
      }
    }
  }

  const zone1Prompts: CompiledPresetPrompt[] = [];
  const zone3Prompts: CompiledPresetPrompt[] = [];
  let seenChatHistory = false;
  let strippedCount = 0;

  orderedEntries.forEach((entry, idx) => {
    if (entry.identifier === "chatHistory") {
      seenChatHistory = true;
      return;
    }
    if (!entry.enabled) return;

    const promptObj = byId.get(entry.identifier);
    if (!promptObj) return;
    if (promptObj.marker === true || MARKER_IDENTIFIERS.has(entry.identifier)) return;

    const rawContent = typeof promptObj.content === "string" ? promptObj.content : "";
    if (!rawContent.trim()) return;

    const { cleaned, stripped } = sanitizeFrontendShell(
      rawContent,
      `preset:${entry.identifier}`,
      options.rawPassthrough,
    );
    strippedCount += stripped.length;
    if (!cleaned.trim()) return;

    const injPos = typeof promptObj.injection_position === "number" ? promptObj.injection_position : 0;
    const injDepth = typeof promptObj.injection_depth === "number" ? promptObj.injection_depth : 0;
    const injOrder = typeof promptObj.injection_order === "number" ? promptObj.injection_order : idx;
    const isJailbreakOrTail =
      injPos === 1 ||
      seenChatHistory ||
      entry.identifier === "jailbreak";

    const compiled: CompiledPresetPrompt = {
      identifier: entry.identifier,
      name: typeof promptObj.name === "string" ? promptObj.name : entry.identifier,
      role: normalizeRole(promptObj.role),
      content: cleaned,
      zone: isJailbreakOrTail ? "zone3" : "zone1",
      depth: injPos === 1 ? injDepth : 0,
      order: injOrder,
    };

    if (compiled.zone === "zone1") {
      zone1Prompts.push(compiled);
    } else {
      zone3Prompts.push(compiled);
    }
  });

  // Zone 3 prompts sorted by depth descending (depth=0 sits closest to generation)
  zone3Prompts.sort((a, b) => b.depth - a.depth || a.order - b.order);

  const explicitName =
    options.name?.trim() ||
    (typeof rawJson.name === "string" && rawJson.name.trim()) ||
    "";
  const presetName = explicitName || "Imported Preset";

  const slugFromName = explicitName
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id =
    slugFromName ||
    `preset-${crypto.createHash("sha1").update(JSON.stringify(rawJson)).digest("hex").slice(0, 8)}`;

  return {
    id,
    name: presetName,
    zone1Prompts,
    zone3Prompts,
    utilityPrompts: {
      newChat: typeof rawJson.new_chat_prompt === "string" ? rawJson.new_chat_prompt : undefined,
      continueNudge: typeof rawJson.continue_nudge_prompt === "string" ? rawJson.continue_nudge_prompt : undefined,
      impersonation: typeof rawJson.impersonation_prompt === "string" ? rawJson.impersonation_prompt : undefined,
      wiFormat: typeof rawJson.wi_format === "string" ? rawJson.wi_format : undefined,
    },
    sampling: {
      temperature: optNum(rawJson.temperature),
      topP: optNum(rawJson.top_p),
      topK: optNum(rawJson.top_k),
      frequencyPenalty: optNum(rawJson.frequency_penalty),
      presencePenalty: optNum(rawJson.presence_penalty),
      maxTokens: optNum(rawJson.openai_max_tokens) ?? optNum(rawJson.max_tokens) ?? optNum(rawJson.max_length),
      maxContext: optNum(rawJson.openai_max_context) ?? optNum(rawJson.max_context),
    },
    strippedCount,
    warnings,
  };
}
