/**
 * L1 On-Demand One-Click AI Deep Card Analyzer (`/rp analyze`).
 *
 * Performs a single structured extraction pass (inspired by NCP-Bench 2026 & Mem0 2026) over a
 * compiled card's prose (`description`, `personality`, `scenario`, `first_mes`, and lorebook index)
 * to produce a universal `CardWorldProfile`:
 *  - Detects `archetype` and which optional modules (`stats`, `inventory`, `clocks`, `stages`) fit.
 *  - Extracts implicit spatio-temporal anchors (`initialLocation`, `initialTime`, `initialStage`, `initialPresentNpcs`).
 *  - Extracts implicit starting items (`initialInventory`) and numeric stats (`initialStats`) from prose.
 *  - Proposes character psychological/relationship `CfsmAxisDef` axes.
 *  - Builds an `entityAliases` map to boost 2-hop PPR recall on plain-text lorebooks.
 *  - Suggests physical `GateCondition` locks for late-game / spoiler lorebook entries.
 */

import { canCompleteWithRegistry, completeWithRegistry } from "../engine/llm-helper.js";
import type {
  CardArchetype,
  CardWorldProfile,
  CfsmAxisDef,
  CompiledCard,
  GateCondition,
  PiExtensionContext,
  SalvagedVariable,
} from "../types.js";

const VALID_ARCHETYPES = new Set<CardArchetype>([
  "companion",
  "slice-of-life",
  "rpg-sandbox",
  "mystery",
  "epic-saga",
  "ensemble",
]);

export interface AnalyzeCardResult {
  profile: CardWorldProfile;
  initialStats: SalvagedVariable[];
}

export function buildAnalyzePrompt(card: CompiledCard): { systemPrompt: string; userPrompt: string } {
  const loreIndex = card.loreBook.entries
    .slice(0, 60)
    .map((e) => `- [${e.id}] ${e.title}${e.keys.length ? ` (keys: ${e.keys.slice(0, 5).join(", ")})` : ""}: ${e.content.slice(0, 90).replace(/\s+/g, " ")}`)
    .join("\n");

  const systemPrompt =
    `You are a universal RP world-profile analyzer. Inspect the character card and return ONLY strict JSON (no markdown commentary) with this schema:\n` +
    `{\n` +
    `  "archetype": "companion" | "slice-of-life" | "rpg-sandbox" | "mystery" | "epic-saga" | "ensemble",\n` +
    `  "modules": { "stats": boolean, "inventory": boolean, "clocks": boolean, "stages": boolean },\n` +
    `  "initialLocation": string | null,\n` +
    `  "initialTime": string | null,\n` +
    `  "initialStage": string | null,\n` +
    `  "initialPresentNpcs": string[],\n` +
    `  "initialInventory": [{ "item": string, "count": number }],\n` +
    `  "initialStats": [{ "key": string, "initialValue": number|string|boolean, "min"?: number, "max"?: number }],\n` +
    `  "suggestedCfsmAxes": [{ "axis": string, "states": string[], "initial": string }],\n` +
    `  "entityAliases": { "CanonicalName": ["Alias1", "Alias2"] },\n` +
    `  "suggestedLoreGates": [{ "entryId": string, "requiredEra"?: string, "minTurn"?: number, "reason": string }]\n` +
    `}\n` +
    `Rules:\n` +
    `- Only enable modules genuinely fitting this card. For pure 1v1 romance/companion/slice-of-life cards, set stages=false and inventory=false unless explicitly warranted.\n` +
    `- Set initialStage ONLY if the card truly has multi-act/era/chapter/phase progression; otherwise null.\n` +
    `- Extract concrete starting items mentioned in scenario/first_mes into initialInventory.\n` +
    `- Only propose suggestedLoreGates for lorebook entries that clearly contain late-game spoilers, later eras, or hidden mysteries.`;

  const userPrompt = [
    `# Card: ${card.identity.name}${card.identity.nickname ? ` (${card.identity.nickname})` : ""}`,
    card.frozen.description ? `## Description\n${card.frozen.description.slice(0, 2200)}` : "",
    card.frozen.personality ? `## Personality\n${card.frozen.personality.slice(0, 1000)}` : "",
    card.frozen.scenario ? `## Scenario\n${card.frozen.scenario.slice(0, 1200)}` : "",
    card.greetings.firstMes ? `## First Message\n${card.greetings.firstMes.slice(0, 1800)}` : "",
    loreIndex ? `## Lorebook Index (${card.loreBook.entries.length} entries)\n${loreIndex}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, userPrompt };
}

export function parseAnalyzeResponse(rawText: string, card: CompiledCard): AnalyzeCardResult | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
  if (!jsonMatch) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]!) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rawArchetype = typeof parsed.archetype === "string" ? (parsed.archetype as CardArchetype) : "companion";
  const archetype: CardArchetype = VALID_ARCHETYPES.has(rawArchetype) ? rawArchetype : "companion";

  const rawModules = (parsed.modules && typeof parsed.modules === "object" ? parsed.modules : {}) as Record<string, unknown>;
  const modules = {
    stats: Boolean(rawModules.stats),
    inventory: Boolean(rawModules.inventory),
    clocks: Boolean(rawModules.clocks),
    stages: Boolean(rawModules.stages),
  };

  const optStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, 48) : undefined;

  const initialPresentNpcs = Array.isArray(parsed.initialPresentNpcs)
    ? parsed.initialPresentNpcs.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
    : [];

  const initialInventory: Array<{ item: string; count: number }> = [];
  if (Array.isArray(parsed.initialInventory)) {
    for (const entry of parsed.initialInventory) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const item = typeof rec.item === "string" ? rec.item.trim() : "";
      const count = typeof rec.count === "number" && Number.isFinite(rec.count) ? Math.max(1, Math.round(rec.count)) : 1;
      if (item && item.length <= 40) initialInventory.push({ item, count });
    }
  }

  const initialStats: SalvagedVariable[] = [];
  if (Array.isArray(parsed.initialStats)) {
    for (const entry of parsed.initialStats) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      const key = typeof rec.key === "string" ? rec.key.trim() : "";
      const val = rec.initialValue;
      if (!key || (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean")) continue;
      initialStats.push({
        key,
        initialValue: val,
        min: typeof rec.min === "number" ? rec.min : undefined,
        max: typeof rec.max === "number" ? rec.max : undefined,
        source: "first_mes",
      });
    }
  }

  const suggestedCfsmAxes: CfsmAxisDef[] = [];
  if (Array.isArray(parsed.suggestedCfsmAxes)) {
    for (const ax of parsed.suggestedCfsmAxes) {
      if (!ax || typeof ax !== "object") continue;
      const rec = ax as Record<string, unknown>;
      const axis = typeof rec.axis === "string" ? rec.axis.trim() : "";
      const states = Array.isArray(rec.states) ? rec.states.map((s) => String(s).trim()).filter(Boolean) : [];
      const initial = typeof rec.initial === "string" && states.includes(rec.initial.trim()) ? rec.initial.trim() : states[0];
      if (axis && states.length >= 2 && initial) {
        suggestedCfsmAxes.push({ axis, states, initial });
      }
    }
  }

  const entityAliases: Record<string, string[]> = {};
  if (parsed.entityAliases && typeof parsed.entityAliases === "object" && !Array.isArray(parsed.entityAliases)) {
    for (const [canon, vals] of Object.entries(parsed.entityAliases as Record<string, unknown>)) {
      const cleanCanon = canon.trim();
      if (!cleanCanon || !Array.isArray(vals)) continue;
      const list = vals.map((v) => String(v).trim()).filter((v) => v.length >= 2 && v.length <= 36);
      if (list.length > 0) entityAliases[cleanCanon] = Array.from(new Set(list));
    }
  }

  const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
  const suggestedLoreGates: CardWorldProfile["suggestedLoreGates"] = [];
  if (Array.isArray(parsed.suggestedLoreGates)) {
    for (const g of parsed.suggestedLoreGates) {
      if (!g || typeof g !== "object") continue;
      const rec = g as Record<string, unknown>;
      const entryId = typeof rec.entryId === "string" ? rec.entryId.trim() : "";
      const lore = loreById.get(entryId);
      if (!lore) continue;
      const gate: GateCondition = {};
      if (typeof rec.requiredEra === "string" && rec.requiredEra.trim()) gate.requiredEra = rec.requiredEra.trim();
      if (typeof rec.minTurn === "number" && Number.isFinite(rec.minTurn) && rec.minTurn > 0) gate.minTurn = Math.round(rec.minTurn);
      if (Object.keys(gate).length === 0) continue;
      suggestedLoreGates.push({
        entryId,
        title: lore.title,
        gate,
        reason: typeof rec.reason === "string" ? rec.reason.trim() : "LLM detected late-game content",
      });
    }
  }

  const profile: CardWorldProfile = {
    archetype,
    modules,
    initialLocation: optStr(parsed.initialLocation),
    initialTime: optStr(parsed.initialTime),
    initialStage: modules.stages ? optStr(parsed.initialStage) : undefined,
    initialPresentNpcs,
    initialInventory,
    suggestedCfsmAxes,
    entityAliases,
    suggestedLoreGates,
    source: "llm-analyzed",
  };

  return { profile, initialStats };
}

/** Merge analyzed `entityAliases` and confirmed `suggestedLoreGates` into a compiled card in place. */
export function applyAnalyzedProfileToCard(card: CompiledCard, profile: CardWorldProfile, applyGates = true): void {
  card.worldProfile = profile;

  // Propagate entity aliases into card identity & matching lorebook entries for richer 2-hop PPR recall
  for (const [canon, aliases] of Object.entries(profile.entityAliases)) {
    if (
      canon.toLowerCase() === card.identity.name.toLowerCase() ||
      (card.identity.nickname && canon.toLowerCase() === card.identity.nickname.toLowerCase())
    ) {
      card.identity.aliases = Array.from(new Set([...card.identity.aliases, ...aliases]));
    }
    const canonLower = canon.toLowerCase();
    for (const entry of card.loreBook.entries) {
      const mentionsCanon =
        entry.entities.some((e) => e.toLowerCase() === canonLower) ||
        entry.title.toLowerCase().includes(canonLower) ||
        entry.content.toLowerCase().includes(canonLower);
      if (mentionsCanon) {
        entry.entities = Array.from(new Set([...entry.entities, canon, ...aliases]));
      }
    }
  }

  if (applyGates) {
    const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
    for (const sg of profile.suggestedLoreGates) {
      const entry = loreById.get(sg.entryId);
      if (!entry) continue;
      entry.gate = { ...(entry.gate ?? {}), ...sg.gate };
    }
  }
}

/** Execute one-click LLM analysis of a compiled card via Pi's `ctx.modelRegistry.complete`. */
export async function analyzeCardWithModel(
  ctx: PiExtensionContext,
  card: CompiledCard,
): Promise<AnalyzeCardResult | null> {
  if (!canCompleteWithRegistry(ctx)) return null;
  const { systemPrompt, userPrompt } = buildAnalyzePrompt(card);
  const rawText = await completeWithRegistry(ctx, ctx.model, {
    systemPrompt,
    userPrompt,
    maxTokens: 1200,
    signal: ctx.signal,
  });
  if (!rawText) return null;
  return parseAnalyzeResponse(rawText, card);
}
