/**
 * L1 One-Click LLM Card Deep Analyzer (`/rp analyze`) — v4 World-Class 7-Dimension Narrative Extractor.
 *
 * Designed to elevate BOTH pure-text literary cards and hybrid/variable cards into full living worlds:
 *  1) Spatio-temporal & Scene Objective: archetype, modules, location, time, stage, objective, present NPCs
 *  2) Multi-Actor Variables & Inventory: player/world/NPC stats with bounds, semantic notes, categories & items
 *  3) Multi-Actor CFSM Emotional/Relationship State Machines: step-by-step transition graphs per character
 *  4) RoleMemo DualMem Initial Beliefs: initial character impressions & psychological subtext
 *  5) FANToM Epistemic Facts & Hidden Secrets: public facts vs secret facts with strict `witnessIds` blind spots
 *  6) EverMemOS Foresights: planted Chekhov's guns, mysteries, and ticking hooks
 *  7) Condition-Gated Storylets (QBN) & Clocks: plot twists with `GateCondition` (incl. `statChecks`) & `postEffects`,
 *     plus entity aliases & spoiler lore gates.
 *
 * Permanently cached into `card.compiled.json` (`card.worldProfile` + merged `salvagedStateSchema`)
 * so every new session hydrates the full structured world in <2ms with 0 repeat LLM cost!
 */

import type {
  CardArchetype,
  CardWorldProfile,
  CfsmAxisDef,
  CompiledCard,
  GateCondition,
  PiExtensionContext,
  SalvagedVariable,
  StoryletEntry,
  VoiceAnchor,
  WorldProfileModules,
} from "../types.js";
import { completeWithRegistry, extractJsonObject, resolveSidecarModel } from "../engine/llm-helper.js";
import { normalizeCfsmAxisDef } from "../engine/cfsm.js";

const VALID_ARCHETYPES = new Set<CardArchetype>([
  "companion",
  "slice-of-life",
  "rpg-sandbox",
  "mystery",
  "epic-saga",
  "ensemble",
]);

const VALID_VAR_CATEGORIES = new Set<NonNullable<SalvagedVariable["category"]>>([
  "stat",
  "inventory",
  "clock",
  "flag",
  "anchor",
]);

export interface AnalyzeCardResult {
  profile: CardWorldProfile;
  initialStats: SalvagedVariable[];
}

function parseGateFromRaw(r: Record<string, unknown>): GateCondition | undefined {
  const gate: GateCondition = {};
  if (Array.isArray(r.requiredFlags)) {
    const flags = r.requiredFlags.map((x) => String(x).trim()).filter(Boolean);
    if (flags.length > 0) gate.requiredFlags = flags;
  }
  if (Array.isArray(r.forbiddenFlags)) {
    const flags = r.forbiddenFlags.map((x) => String(x).trim()).filter(Boolean);
    if (flags.length > 0) gate.forbiddenFlags = flags;
  }
  if (typeof r.minTurn === "number" && r.minTurn > 0) gate.minTurn = Math.trunc(r.minTurn);
  if (typeof r.requiredEra === "string" && r.requiredEra.trim()) gate.requiredEra = r.requiredEra.trim();
  if (Array.isArray(r.requiredLocations)) {
    const locs = r.requiredLocations.map((x) => String(x).trim()).filter(Boolean);
    if (locs.length > 0) gate.requiredLocations = locs;
  }
  if (Array.isArray(r.requiredNpcPresent)) {
    const npcs = r.requiredNpcPresent.map((x) => String(x).trim()).filter(Boolean);
    if (npcs.length > 0) gate.requiredNpcPresent = npcs;
  }
  if (Array.isArray(r.statChecks)) {
    const checks: NonNullable<GateCondition["statChecks"]> = [];
    for (const c of r.statChecks) {
      if (!c || typeof c !== "object") continue;
      const cr = c as Record<string, unknown>;
      const key = typeof cr.key === "string" && cr.key.trim() ? cr.key.trim() : "";
      const gte = typeof cr.gte === "number" ? cr.gte : undefined;
      const lte = typeof cr.lte === "number" ? cr.lte : undefined;
      if (!key || (gte === undefined && lte === undefined)) continue;
      const actorId = typeof cr.actorId === "string" && cr.actorId.trim() ? cr.actorId.trim() : undefined;
      checks.push({ actorId, key, gte, lte });
    }
    if (checks.length > 0) gate.statChecks = checks;
  }
  return Object.keys(gate).length > 0 ? gate : undefined;
}


/**
 * L0 Zero-LLM Voice & Backbone Anchor Extractor (ContextEcho / Three-Years-ST mitigation):
 * Pulls 2-3 verbatim quoted dialogue samples from mes_example/first_mes + a concise backbone summary
 * so EVERY card immediately gets anti-drift voice anchoring without waiting for `/rp analyze`.
 */
export function extractHeuristicVoiceAnchor(card: CompiledCard): VoiceAnchor | null {
  const actorId = (card.identity.nickname || card.identity.name || "").trim();
  if (!actorId) return null;

  const samples: string[] = [];
  const seen = new Set<string>();
  const sources = [card.frozen.mesExample, card.greetings.firstMes];
  const quoteRe = /[「“"]([^「」“”"\n]{6,68})[」”"]/g;
  for (const src of sources) {
    if (!src) continue;
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(src)) !== null) {
      const q = m[1]!.replace(/\s+/g, " ").trim();
      if (!q || seen.has(q) || /^\[/.test(q)) continue;
      seen.add(q);
      samples.push(q);
      if (samples.length >= 3) break;
    }
    if (samples.length >= 3) break;
  }

  const rawPersonality = (card.frozen.personality || card.frozen.description || "")
    .replace(/\s+/g, " ")
    .trim();
  const backbone = rawPersonality
    ? rawPersonality.split(/[。！？.!?;；]/).filter((x) => x.trim().length >= 6).slice(0, 2).join("；").slice(0, 120)
    : "";

  if (samples.length === 0 && !backbone) return null;
  return {
    actorId,
    speechSamples: samples,
    backbone: backbone || `严格保持「${actorId}」原有立场、防备心与说话口吻，绝不无端讨好或退化成通用 AI 腔。`,
  };
}

export function buildAnalyzePrompt(card: CompiledCard): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are a world-class interactive fiction & roleplay structural architect.
Inspect the character card (whether it is a pure-text literary card or a card with explicit variables) and extract a complete, faithful 7-dimension narrative blueprint.
Return ONLY a strict JSON object (no markdown fences, no commentary) matching this schema:
{
  "archetype": "companion" | "slice-of-life" | "rpg-sandbox" | "mystery" | "epic-saga" | "ensemble",
  "modules": { "stats": boolean, "inventory": boolean, "clocks": boolean, "stages": boolean },
  "initialLocation": string | null,
  "initialTime": string | null,
  "initialStage": string | null,
  "initialObjective": string | null,
  "initialPresentNpcs": string[],
  "initialInventory": [{ "actorId": "player" | "<npcName>", "item": string, "count": number }],
  "initialStats": [
    {
      "actorId": "player" | "world" | "<npcName>",
      "key": string,
      "initialValue": number | string | boolean,
      "category": "stat" | "flag" | "anchor",
      "min": number | null,
      "max": number | null,
      "note": string | null
    }
  ],
  "suggestedCfsmAxes": [
    {
      "actorId": "<npcName>",
      "axis": string,
      "states": string[],
      "initial": string,
      "transitions": { "<state>": ["<nextState>"] } | null
    }
  ],
  "initialBeliefs": [
    {
      "actorId": "<npcName>",
      "target": "player" | "<npcName>",
      "activatingEvent": string,
      "belief": string,
      "subjectiveInsight": string,
      "emotionalTone": string
    }
  ],
  "initialFacts": [
    {
      "statement": string,
      "entities": string[],
      "witnessIds": "public" | string[]
    }
  ],
  "initialForesights": [
    {
      "summary": string,
      "triggerHint": string,
      "entities": string[]
    }
  ],
  "initialStorylets": [
    {
      "title": string,
      "triggerPrompt": string,
      "gate": {
        "minTurn": number | null,
        "requiredFlags": string[],
        "forbiddenFlags": string[],
        "requiredLocations": string[],
        "requiredNpcPresent": string[],
        "statChecks": [{ "actorId": string | null, "key": string, "gte": number | null, "lte": number | null }]
      },
      "postEffects": { "setFlags": { "<flag>": boolean }, "nextObjective": string | null },
      "oneTime": boolean
    }
  ],
  "initialClocks": [{ "clockId": string, "label": string, "value": number, "max": number }],
  "voiceAnchors": [
    {
      "actorId": "<npcName>",
      "speechSamples": ["<verbatim short dialogue line 1>", "<line 2>"],
      "backbone": "<core non-negotiable stance / self-interest / anti-sycophancy boundary>",
      "tabooBehaviors": "<what this character would NEVER do out of character>"
    }
  ],
  "entityAliases": { "<canonicalName>": ["<alias1>", "<alias2>"] },
  "suggestedLoreGates": [
    {
      "entryId": string,
      "requiredFlags": string[],
      "minTurn": number | null,
      "requiredEra": string | null,
      "statChecks": [{ "actorId": string | null, "key": string, "gte": number | null, "lte": number | null }],
      "reason": string
    }
  ]
}
Strict Quality Rules:
1. PURE-TEXT CARD INTELLIGENCE: Even if the card has zero explicit numeric status bars, carefully identify implied trackable narrative states (e.g. affection/trust/suspicion/sanity/favor/money/health/clothing/mood), unspoken secrets, foreshadowed mysteries, character inner attitudes, and natural turning points described in the prose.
2. FAITHFULNESS & ZERO BLOAT: Stay 100% loyal to the card's actual genre. Do NOT invent RPG HP/MP/inventory/clocks for a pure romantic slice-of-life card unless genuinely present in the text. Keep every list crisp and high-signal (e.g. 2-8 stats, 1-4 CFSM axes, 1-4 initial beliefs, 2-6 key facts/secrets, 1-4 foresights, 1-3 storylets, 0-3 clocks).
3. MULTI-ACTOR PRECISION: Assign exact "actorId" ("player", "world", or specific character name) to every stat, inventory item, and CFSM axis. If L0 salvaged variables are provided below, refine their actorId/bounds/notes instead of duplicating them.
4. BIPOLAR SCALES: For affection/trust/reputation/suspicion, allow negative min (e.g. -100..100) when appropriate; never force negative initial values to 0.
5. EPISTEMIC SECRETS (FANToM): If a character hides a secret, true identity, or hidden agenda from the player or another NPC, record it in "initialFacts" with witnessIds listing ONLY who knows (e.g. ["<npcName>"]) instead of "public"!
6. STEPWISE CFSM: Order states gradually (e.g. ["戒备","试探","信任","依恋"]) so relationships evolve organically.
7. SPOILER LORE GATES: Only gate lorebook entries that contain genuine late-game twists, secret identities, or sealed truths.
8. LANGUAGE: Write all extracted labels, beliefs, facts, foresights, and storylets in the primary language of the character card.`;

  // Prioritize constant, high-priority, and spoiler-candidate entries up to 140 entries within a smart budget
  const prioritizedLore = [...card.loreBook.entries]
    .sort((a, b) => Number(b.constant) - Number(a.constant) || b.priority - a.priority)
    .slice(0, 140);

  let loreChars = 0;
  const maxLoreChars = 9000;
  const loreLines: string[] = [];
  for (const e of prioritizedLore) {
    const excerptLen = e.constant ? 240 : 140;
    const line = `- id="${e.id}" title="${e.title}" keys=[${e.keys.slice(0, 6).join(", ")}] constant=${e.constant}: ${e.content
      .replace(/\s+/g, " ")
      .slice(0, excerptLen)}`;
    if (loreChars + line.length > maxLoreChars) break;
    loreLines.push(line);
    loreChars += line.length + 1;
  }

  const salvagedSummary =
    card.salvagedStateSchema.length > 0
      ? card.salvagedStateSchema
          .slice(0, 40)
          .map(
            (v) =>
              `- [${v.actorId ?? card.identity.name}] (${v.category ?? "stat"}) ${v.key} = ${JSON.stringify(v.initialValue)}${
                v.min !== undefined || v.max !== undefined ? ` [${v.min ?? ""}..${v.max ?? ""}]` : ""
              }${v.note ? ` // ${v.note}` : ""}`,
          )
          .join("\n")
      : "";

  const altGreetingsSummary =
    card.greetings.alternates.length > 0
      ? card.greetings.alternates
          .slice(0, 3)
          .map((g, i) => `Alt Greeting #${i + 1}: ${g.replace(/\s+/g, " ").slice(0, 500)}`)
          .join("\n")
      : "";

  const userPrompt = [
    `Card Name: ${card.identity.name}${card.identity.nickname ? ` (nickname: ${card.identity.nickname})` : ""}`,
    card.meta.tags.length ? `Tags: ${card.meta.tags.join(", ")}` : "",
    card.frozen.description ? `Description:\n${card.frozen.description.slice(0, 5500)}` : "",
    card.frozen.personality ? `Personality:\n${card.frozen.personality.slice(0, 2200)}` : "",
    card.frozen.scenario ? `Scenario:\n${card.frozen.scenario.slice(0, 2600)}` : "",
    card.greetings.firstMes ? `First Message:\n${card.greetings.firstMes.slice(0, 3200)}` : "",
    altGreetingsSummary ? `Alternate Greetings Preview:\n${altGreetingsSummary}` : "",
    salvagedSummary ? `Already Extracted L0 Variables (${card.salvagedStateSchema.length} total):\n${salvagedSummary}` : "",
    loreLines.length > 0 ? `Lorebook Entries (${loreLines.length}/${card.loreBook.entries.length} shown):\n${loreLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { systemPrompt, userPrompt };
}

export function parseAnalyzeResponse(rawText: string, card: CompiledCard): AnalyzeCardResult | null {
  const parsed = extractJsonObject<Record<string, unknown>>(rawText);
  if (!parsed) return null;

  const archetype: CardArchetype =
    typeof parsed.archetype === "string" && VALID_ARCHETYPES.has(parsed.archetype as CardArchetype)
      ? (parsed.archetype as CardArchetype)
      : card.worldProfile?.archetype ?? "companion";

  const rawMod = (parsed.modules && typeof parsed.modules === "object" ? parsed.modules : {}) as Record<string, unknown>;
  const fallbackMods = card.worldProfile?.modules ?? { stats: false, inventory: false, clocks: false, stages: false };
  const modules: WorldProfileModules = {
    stats: typeof rawMod.stats === "boolean" ? rawMod.stats : fallbackMods.stats,
    inventory: typeof rawMod.inventory === "boolean" ? rawMod.inventory : fallbackMods.inventory,
    clocks: typeof rawMod.clocks === "boolean" ? rawMod.clocks : fallbackMods.clocks,
    stages: typeof rawMod.stages === "boolean" ? rawMod.stages : fallbackMods.stages,
  };

  const asOptStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const initialPresentNpcs = Array.isArray(parsed.initialPresentNpcs)
    ? parsed.initialPresentNpcs.map((x) => String(x).trim()).filter(Boolean)
    : [];

  const initialInventory: Array<{ actorId?: string; item: string; count: number }> = [];
  if (Array.isArray(parsed.initialInventory)) {
    for (const row of parsed.initialInventory) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const item = asOptStr(r.item);
      const count = typeof r.count === "number" && r.count > 0 ? Math.trunc(r.count) : 1;
      const actorId = asOptStr(r.actorId);
      if (item) initialInventory.push({ actorId, item, count });
    }
  }

  const initialStats: SalvagedVariable[] = [];
  if (Array.isArray(parsed.initialStats)) {
    for (const row of parsed.initialStats) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const key = asOptStr(r.key);
      const val = r.initialValue;
      if (!key || (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean")) continue;
      const rawMin = typeof r.min === "number" ? r.min : undefined;
      const rawMax = typeof r.max === "number" ? r.max : undefined;
      const safeMin = typeof val === "number" && rawMin !== undefined && val < rawMin ? val : rawMin;
      const safeMax = typeof val === "number" && rawMax !== undefined && val > rawMax ? val : rawMax;
      const rawCat = asOptStr(r.category) as SalvagedVariable["category"] | undefined;
      const category = rawCat && VALID_VAR_CATEGORIES.has(rawCat) ? rawCat : "stat";
      initialStats.push({
        key,
        initialValue: val,
        actorId: asOptStr(r.actorId) ?? card.identity.name,
        category,
        min: safeMin,
        max: safeMax,
        note: asOptStr(r.note),
        source: "llm_analyze",
      });
    }
  }

  const suggestedCfsmAxes: Array<CfsmAxisDef & { actorId?: string }> = [];
  if (Array.isArray(parsed.suggestedCfsmAxes)) {
    for (const row of parsed.suggestedCfsmAxes) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const axis = asOptStr(r.axis);
      const states = Array.isArray(r.states) ? r.states.map((s) => String(s).trim()).filter(Boolean) : [];
      const initial = asOptStr(r.initial) ?? states[0];
      const transitions =
        r.transitions && typeof r.transitions === "object" && !Array.isArray(r.transitions)
          ? (r.transitions as Record<string, string[]>)
          : undefined;
      if (axis && states.length >= 2 && initial) {
        suggestedCfsmAxes.push({
          ...normalizeCfsmAxisDef({ axis, states, initial, transitions }),
          actorId: asOptStr(r.actorId) ?? card.identity.name,
        });
      }
    }
  }

  const initialBeliefs: NonNullable<CardWorldProfile["initialBeliefs"]> = [];
  if (Array.isArray(parsed.initialBeliefs)) {
    for (const row of parsed.initialBeliefs) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const actorId = asOptStr(r.actorId) ?? card.identity.name;
      const target = asOptStr(r.target) ?? "player";
      const belief = asOptStr(r.belief);
      if (!belief) continue;
      initialBeliefs.push({
        actorId,
        target,
        activatingEvent: asOptStr(r.activatingEvent) ?? "初始设定",
        belief,
        subjectiveInsight: asOptStr(r.subjectiveInsight),
        emotionalTone: asOptStr(r.emotionalTone),
      });
    }
  }

  const initialFacts: NonNullable<CardWorldProfile["initialFacts"]> = [];
  if (Array.isArray(parsed.initialFacts)) {
    for (const row of parsed.initialFacts) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const statement = asOptStr(r.statement);
      if (!statement) continue;
      const entities = Array.isArray(r.entities) ? r.entities.map((e) => String(e).trim()).filter(Boolean) : [];
      const witnessIds: string[] | "public" =
        r.witnessIds === "public"
          ? "public"
          : Array.isArray(r.witnessIds)
            ? r.witnessIds.map((w) => String(w).trim()).filter(Boolean)
            : "public";
      initialFacts.push({
        statement,
        entities,
        witnessIds: Array.isArray(witnessIds) && witnessIds.length === 0 ? "public" : witnessIds,
      });
    }
  }

  const initialForesights: NonNullable<CardWorldProfile["initialForesights"]> = [];
  if (Array.isArray(parsed.initialForesights)) {
    for (const row of parsed.initialForesights) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const summary = asOptStr(r.summary);
      if (!summary) continue;
      const triggerHint = asOptStr(r.triggerHint) ?? "剧情推进至关键转折时";
      const entities = Array.isArray(r.entities) ? r.entities.map((e) => String(e).trim()).filter(Boolean) : [];
      initialForesights.push({ summary, triggerHint, entities });
    }
  }

  const initialStorylets: NonNullable<CardWorldProfile["initialStorylets"]> = [];
  if (Array.isArray(parsed.initialStorylets)) {
    for (const row of parsed.initialStorylets) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const title = asOptStr(r.title);
      const triggerPrompt = asOptStr(r.triggerPrompt);
      if (!title || !triggerPrompt) continue;
      const gate =
        r.gate && typeof r.gate === "object" && !Array.isArray(r.gate)
          ? parseGateFromRaw(r.gate as Record<string, unknown>)
          : undefined;
      let postEffects: StoryletEntry["postEffects"];
      if (r.postEffects && typeof r.postEffects === "object" && !Array.isArray(r.postEffects)) {
        const pe = r.postEffects as Record<string, unknown>;
        const setFlags: Record<string, boolean> = {};
        if (pe.setFlags && typeof pe.setFlags === "object" && !Array.isArray(pe.setFlags)) {
          for (const [fk, fv] of Object.entries(pe.setFlags as Record<string, unknown>)) {
            if (fk.trim() && typeof fv === "boolean") setFlags[fk.trim()] = fv;
          }
        }
        const nextObjective = asOptStr(pe.nextObjective);
        if (Object.keys(setFlags).length > 0 || nextObjective) {
          postEffects = {
            setFlags: Object.keys(setFlags).length > 0 ? setFlags : undefined,
            nextObjective,
          };
        }
      }
      initialStorylets.push({
        title,
        triggerPrompt,
        gate,
        postEffects,
        oneTime: typeof r.oneTime === "boolean" ? r.oneTime : true,
      });
    }
  }

  const initialClocks: NonNullable<CardWorldProfile["initialClocks"]> = [];
  if (Array.isArray(parsed.initialClocks)) {
    for (const row of parsed.initialClocks) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const label = asOptStr(r.label);
      const clockId = asOptStr(r.clockId) ?? (label ? label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_") : "");
      const max = typeof r.max === "number" && r.max >= 2 ? Math.trunc(r.max) : 6;
      const value = typeof r.value === "number" && r.value >= 0 ? Math.min(max, Math.trunc(r.value)) : 0;
      if (label && clockId) initialClocks.push({ clockId, label, value, max });
    }
  }

  const entityAliases: Record<string, string[]> = {};
  if (parsed.entityAliases && typeof parsed.entityAliases === "object" && !Array.isArray(parsed.entityAliases)) {
    for (const [k, v] of Object.entries(parsed.entityAliases as Record<string, unknown>)) {
      if (!k.trim() || !Array.isArray(v)) continue;
      const aliases = v.map((x) => String(x).trim()).filter(Boolean);
      if (aliases.length > 0) entityAliases[k.trim()] = aliases;
    }
  }

  const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
  const suggestedLoreGates: CardWorldProfile["suggestedLoreGates"] = [];
  if (Array.isArray(parsed.suggestedLoreGates)) {
    for (const row of parsed.suggestedLoreGates) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const entryId = asOptStr(r.entryId);
      if (!entryId || !loreById.has(entryId)) continue;
      const gate = parseGateFromRaw(r);
      if (!gate) continue;
      suggestedLoreGates.push({
        entryId,
        title: loreById.get(entryId)!.title,
        gate,
        reason: asOptStr(r.reason) ?? "spoiler_protection",
      });
    }
  }

  // Auto-enable stats/inventory/clocks modules if concrete items were extracted
  if (initialStats.length > 0) modules.stats = true;
  if (initialInventory.length > 0) modules.inventory = true;
  if (initialClocks.length > 0) modules.clocks = true;

  return {
    profile: {
      archetype,
      modules,
      initialLocation: asOptStr(parsed.initialLocation),
      initialTime: asOptStr(parsed.initialTime),
      initialStage: modules.stages ? asOptStr(parsed.initialStage) : undefined,
      initialObjective: asOptStr(parsed.initialObjective),
      initialPresentNpcs,
      initialInventory,
      initialStats: initialStats.length > 0 ? initialStats : undefined,
      suggestedCfsmAxes,
      initialBeliefs: initialBeliefs.length > 0 ? initialBeliefs : undefined,
      initialFacts: initialFacts.length > 0 ? initialFacts : undefined,
      initialForesights: initialForesights.length > 0 ? initialForesights : undefined,
      initialStorylets: initialStorylets.length > 0 ? initialStorylets : undefined,
      initialClocks: initialClocks.length > 0 ? initialClocks : undefined,
      voiceAnchors: (() => {
        const out: VoiceAnchor[] = [];
        if (Array.isArray(parsed.voiceAnchors)) {
          for (const row of parsed.voiceAnchors) {
            if (!row || typeof row !== "object") continue;
            const r = row as Record<string, unknown>;
            const actorId = asOptStr(r.actorId);
            const backbone = asOptStr(r.backbone);
            const speechSamples = Array.isArray(r.speechSamples)
              ? r.speechSamples.map((x) => String(x).trim()).filter(Boolean).slice(0, 3)
              : [];
            if (!actorId || (!backbone && speechSamples.length === 0)) continue;
            out.push({
              actorId,
              speechSamples,
              backbone: backbone ?? "",
              tabooBehaviors: asOptStr(r.tabooBehaviors),
            });
          }
        }
        return out.length > 0 ? out : undefined;
      })(),
      entityAliases,
      suggestedLoreGates,
      source: "llm-analyzed",
    },
    initialStats,
  };
}

/**
 * Permanently apply an analyzed WorldProfile to a CompiledCard in place:
 *  - Saves all 7 extracted dimensions into `card.worldProfile`
 *  - Merges `initialStats` into `card.salvagedStateSchema` (deduplicated by `actorId::key`)
 *  - Propagates `entityAliases` to card identity & lorebook entities
 *  - Optionally attaches `suggestedLoreGates` to spoiler lorebook entries
 */
export function applyAnalyzedProfileToCard(
  card: CompiledCard,
  profile: CardWorldProfile,
  applySpoilerGates = true,
  extraInitialStats?: SalvagedVariable[],
): void {
  const mergedStatsInput = extraInitialStats ?? profile.initialStats ?? [];
  card.worldProfile = {
    ...profile,
    initialStats: mergedStatsInput.length > 0 ? mergedStatsInput : profile.initialStats,
  };

  // Merge LLM-analyzed stats into salvagedStateSchema without losing L0 explicit variables
  if (mergedStatsInput.length > 0) {
    const byKey = new Map<string, SalvagedVariable>();
    for (const v of card.salvagedStateSchema) {
      const id = `${(v.actorId ?? card.identity.name).toLowerCase()}::${v.key.toLowerCase()}`;
      byKey.set(id, v);
    }
    for (const v of mergedStatsInput) {
      const id = `${(v.actorId ?? card.identity.name).toLowerCase()}::${v.key.toLowerCase()}`;
      const existing = byKey.get(id);
      if (existing) {
        // Enrich existing L0 variable with LLM bounds/note/category if missing, never overwrite explicit L0 initialValue
        byKey.set(id, {
          ...existing,
          actorId: existing.actorId ?? v.actorId,
          category: existing.category ?? v.category,
          min: existing.min ?? v.min,
          max: existing.max ?? v.max,
          note: existing.note ?? v.note,
        });
      } else {
        byKey.set(id, { ...v });
      }
    }
    card.salvagedStateSchema = Array.from(byKey.values());
  }

  const charAliases = new Set(card.identity.aliases);
  for (const [canonical, aliases] of Object.entries(profile.entityAliases)) {
    if (canonical.toLowerCase() === card.identity.name.toLowerCase()) {
      for (const a of aliases) charAliases.add(a);
    }
    for (const entry of card.loreBook.entries) {
      const hasCanonical =
        entry.entities.some((e) => e.toLowerCase() === canonical.toLowerCase()) ||
        entry.title.toLowerCase().includes(canonical.toLowerCase());
      if (hasCanonical) {
        const merged = new Set(entry.entities);
        merged.add(canonical);
        for (const a of aliases) merged.add(a);
        entry.entities = Array.from(merged);
      }
    }
  }
  card.identity.aliases = Array.from(charAliases);

  if (applySpoilerGates) {
    const byId = new Map(card.loreBook.entries.map((e) => [e.id, e]));
    for (const g of profile.suggestedLoreGates) {
      const entry = byId.get(g.entryId);
      if (entry && !entry.gate) {
        entry.gate = { ...g.gate };
      }
    }
  }
}

/** Run the L1 LLM deep analysis using Pi's official ModelRegistry (preferring `sidecarModel` if configured). */
export async function analyzeCardWithModel(
  ctx: PiExtensionContext,
  card: CompiledCard,
  sidecarModelKey?: string,
): Promise<AnalyzeCardResult | null> {
  const model = resolveSidecarModel(ctx, sidecarModelKey);
  const { systemPrompt, userPrompt } = buildAnalyzePrompt(card);
  const raw = await completeWithRegistry(ctx, model, {
    systemPrompt,
    userPrompt,
    maxTokens: 2800,
    signal: ctx.signal,
  });
  return parseAnalyzeResponse(raw, card);
}
