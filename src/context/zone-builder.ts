/**
 * Three-Zone KV-Cache Zero-Fragmentation Context Assembler (v3).
 *
 * Strict Invariants:
 *  - Zone 1 (`before_agent_start`): 100% byte-identical across turns. Respects SillyTavern
 *    positional constant lore (`before_char`=0, `after_char`=1, `before_example`=5, `after_example`=6)
 *    plus static `outlet` (position=7) expansion, 100% verbatim `mes_example`, card `system_prompt`,
 *    co-cast profiles, and initial persona. ZERO timestamps, turn numbers, or dynamic stats.
 *  - Zone 2 (Append-Only history): NEVER mutates `messages[0 .. n-2]`. Supports non-destructive
 *    floor hiding via both `entryId` AND deterministic message fingerprints so `/rp hide` works
 *    reliably on Pi SDK's `AgentMessage[]`.
 *  - Zone 3 (Transient tail frame via `context` hook): Attached ONLY to the final user message
 *    (or final message if none) of the outbound copy — NEVER persisted to JSONL. Includes:
 *    `<rp_state_frame>` (with scene objective, milestones & flags), RoleMemo DualMem beliefs,
 *    recalled lore + Zone 3 constant lore (position 2/3/4) + Memory Book chapters (with preset
 *    `wiFormat` & dynamic `outlet` expansion), bi-temporal facts with FANToM blind spots, open
 *    foresights, condition-gated Storylets, optional Inner Monologue cue, Director Pacing & notes,
 *    preset tail prompts, `depth_prompt`, and `post_history_instructions`.
 */

import { createHash } from "node:crypto";
import type {
  CompiledCard,
  CompiledLoreEntry,
  CompiledPreset,
  MemoryBookEntry,
  PacingMode,
  PersonaProfile,
  PiContentBlock,
  PiMessage,
  SessionRpState,
  StoryletEntry,
} from "../types.js";
import { evaluateMacros, type MacroContext } from "../parser/macros.js";
import { computeMessageFingerprint } from "../engine/state-replay.js";
import { selectFactsForZone3 } from "../memory/bitemporal.js";
import { evaluateGate, partitionEpistemicFacts } from "../engine/gates.js";
import { selectActiveForesights } from "../memory/foresight.js";
import {
  formatEncounterFrame,
  formatLocalTopology,
  selectDueCommitments,
  selectFactionPressures,
} from "../engine/world-sim.js";
import { selectRelevantBeliefs } from "../memory/graph-ppr.js";
import { detectRepeatedCliches, detectRuntimeSlop, type NarrativeHealthReport } from "../engine/stagnation.js";
import { estimateTokens } from "./token-budget.js";
import { extractHeuristicVoiceAnchor } from "../parser/analyzer.js";

function fnv1aSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildEngineProtocol(activeToolNames?: string[]): string {
  const active = activeToolNames ? new Set(activeToolNames) : null;
  const has = (name: string) => (active ? active.has(name) : true);
  const hasWriteTools = has("rp_state_patch") || has("rp_fact_commit");
  const hasRoll = has("rp_roll_check");
  const hasRecall = has("rp_recall") || has("rp_history_recall");

  if (!hasWriteTools && !hasRoll && !hasRecall) {
    return `[RP Engine Protocol · Pure Chat]
- You are the sole narrative writer for this interactive world. Write pure, immersive literary prose with consistent character psychology, concrete sensory grounding, and organic pacing.
- NEVER output raw XML/JSON state tags, markdown status bars, HTML widgets, or meta commentary in your narrative reply.`;
  }

  const lines: string[] = [
    hasWriteTools ? "[RP Engine Protocol]" : "[RP Engine Protocol · Prose-First]",
    "- You are the sole narrative writer for this interactive world. Maintain consistent literary voice, given-circumstance character psychology, and organic pacing.",
    "- Authoritative world state (stats, inventory, clocks, flags, conditions, storylets, bi-temporal facts, character beliefs, and latest dice roll) is maintained deterministically by code and provided in <rp_state_frame> & <rp_recalled_context> at the end of the turn. Never fabricate impossible stat/item changes or print legacy HTML status bars.",
  ];

  if (hasRoll) {
    lines.push(
      "- **Dice Check Rule**: Whenever the player attempts a risky, uncertain, contested, stealth, persuasion, deception, perception, lockpicking, crafting, or combat action where failure is meaningfully possible, ALWAYS call `rp_roll_check` FIRST (passing `stat_key` if a matching stat exists, plus `dc` and `reason`) before narrating the outcome. Honor the exact returned roll & critical result — never invent dice rolls in prose.",
    );
  }

  const toolHints: string[] = [];
  if (has("rp_state_patch")) {
    toolHints.push(
      "`rp_state_patch` when location/NPCs/stats/inventory/flags/clocks/conditions/CFSM change or an active Storylet finishes (`completed_storylets`)",
    );
  }
  if (has("rp_fact_commit")) {
    toolHints.push("`rp_fact_commit` for major new/invalidated facts, character belief shifts, or planted/resolved foresights");
  }
  if (has("rp_recall")) {
    toolHints.push("`rp_recall` to search/read worldbook or archived facts");
  }
  if (has("rp_history_recall")) {
    toolHints.push("`rp_history_recall` to recall exact earlier dialogue turns");
  }
  if (has("rp_era_advance")) {
    toolHints.push("`rp_era_advance` for major chapter/act/time-skip transitions");
  }
  if (has("rp_npc_deliberate")) {
    toolHints.push("`rp_npc_deliberate` only for strict hidden-information multi-NPC plotting");
  }
  if (toolHints.length > 0) {
    lines.push(`- Active tools (skip on pure casual chat, invoke promptly when triggered): ${toolHints.join("; ")}.`);
  }
  if (hasWriteTools) {
    lines.push(
      "- Prose-first zero-interruption sync: Write uninterrupted literary prose FIRST. Whenever location, present NPCs, time, stage, scene objective, stats, items, flags, clocks, facts, beliefs, foresights, physical state, or major choice consequences change, append a compact `[[RP_DELTA]]...[[/RP_DELTA]]` block at the very end (stripped from display; omit on pure banter turns). Keys: `loc: 地点 | NPC1, NPC2`, `time:`, `stage:`, `obj:`, `stat: 角色.键 +N`, `inv: player.物 ±N`, `flag: 键=true`, `clock: ID +1`, `storylet_done: ID`, `fact: 内容 [witness: ...]`, `fact_off: ID`, `belief: A->B: 信念 | 诱因`, `hook: 伏笔 | 提示`, `hook_done: ID`, `echo: 选择 -> 潜在后果 [weight: high]`, `promise: A->B: 承诺 | due: TN`, `route: 地A<->地B | 耗时`, `faction: 势力 standing=±N heat=+1`, `spread: factID -> NPC`, `encounter: 名称 | stakes=...` / `encounter_end`, `phys: 角色 | outfit=... | pose=... | held=...`.",
    );
  }
  if (!hasWriteTools) {
    lines.push("- World state bookkeeping runs silently in the background; NEVER output raw XML/JSON state tags or status widgets.");
  }
  return lines.join("\n");
}

const PACING_HINTS: Record<PacingMode, string | null> = {
  relaxed: "Pacing cue: Keep scenes gentle, atmospheric, and character-driven; let quiet moments breathe without forcing artificial conflict.",
  balanced: null,
  dramatic: "Pacing cue: Maintain taut narrative momentum — advance active clocks, surface tensions organically, and end beats with compelling hooks for player agency.",
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "object") {
    if (value === null) return "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const rec = value as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys
      .filter((k) => rec[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic 12-char SHA-256 fingerprint of Zone 1 prefix for KV-Cache stability verification. */
export function computeZone1Hash(zone1Text: string): string {
  return createHash("sha256").update(zone1Text, "utf8").digest("hex").slice(0, 12);
}

/** Estimate total tokens across a message array (Zone 2 history). */
export function computeMessagesTokens(messages: PiMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += estimateTokens(m.content) + 4;
    } else if (Array.isArray(m.content)) {
      total += 4;
      for (const b of m.content) {
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
          total += estimateTokens(b.text);
        }
      }
    }
  }
  return total;
}

/** Evaluate armed/triggered storylets whose gate conditions currently match the world state. */
export function evaluateActiveStorylets(state: SessionRpState): StoryletEntry[] {
  const active: StoryletEntry[] = [];
  for (const s of state.storylets.values()) {
    if (s.status === "completed") continue;
    if (s.status === "triggered") {
      active.push(s);
      continue;
    }
    if (s.status === "armed" && evaluateGate(s.gate, state)) {
      active.push(s);
    }
  }
  return active;
}

function collectStaticOutlets(
  card: CompiledCard,
  macroCtx: MacroContext,
  loreOverrides?: Record<string, boolean>,
): Record<string, string> {
  const outlets: Record<string, string> = {};
  for (const e of card.loreBook.entries) {
    const effectiveEnabled = loreOverrides?.[e.id] ?? e.enabled;
    if (effectiveEnabled && e.constant && e.position === 7 && e.outletName && e.content.trim()) {
      const prev = outlets[e.outletName];
      const rendered = evaluateMacros(e.content, macroCtx).trim();
      outlets[e.outletName] = prev ? `${prev}\n${rendered}` : rendered;
    }
  }
  return outlets;
}

function formatLoreEntries(
  entries: CompiledLoreEntry[],
  macroCtx: MacroContext,
  wiFormat?: string,
): string {
  return entries
    .map((e) => {
      const body = evaluateMacros(e.content, macroCtx).trim();
      if (!body) return "";
      if (wiFormat && wiFormat.includes("{0}")) {
        return wiFormat.replace(/\{0\}/g, () => `[${e.title}]\n${body}`);
      }
      return `### ${e.title}\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build Zone 1 Frozen Prefix (100% deterministic, byte-identical across turns for max KV-Cache hit).
 */
export function buildZone1FrozenPrefix(options: {
  card: CompiledCard;
  extraCastCards?: CompiledCard[];
  preset?: CompiledPreset | null;
  initialPersona: PersonaProfile;
  loreOverrides?: Record<string, boolean>;
  activeToolNames?: string[];
}): string {
  const { card, extraCastCards = [], preset, initialPersona, loreOverrides, activeToolNames } = options;
  const charName = card.identity.nickname || card.identity.name;
  const groupMembers = [charName, ...extraCastCards.map((c) => c.identity.nickname || c.identity.name)];
  // Stable per-session deterministic seed ensures {{random}} / {{roll}} in Zone 1 NEVER break KV-Cache!
  const zone1Seed = fnv1aSeed(`${card.id}:${initialPersona.name}`);
  const baseMacroCtx: MacroContext = {
    charName,
    userName: initialPersona.name,
    personaDescription: initialPersona.description,
    groupMembers,
    deterministicSeed: zone1Seed,
  };
  const staticOutlets = collectStaticOutlets(card, baseMacroCtx, loreOverrides);
  const macroCtx: MacroContext = { ...baseMacroCtx, outlets: staticOutlets };

  const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
  const constantEntries = card.frozen.constantLoreIds
    .map((id) => loreById.get(id))
    .filter((e): e is CompiledLoreEntry => {
      if (!e || !e.content.trim()) return false;
      const effectiveEnabled = loreOverrides?.[e.id] ?? e.enabled;
      return effectiveEnabled;
    });

  const loreBeforeChar = constantEntries.filter((e) => e.position === 0);
  const loreAfterChar = constantEntries.filter((e) => e.position === 1);
  const loreBeforeExample = constantEntries.filter((e) => e.position === 5);
  const loreAfterExample = constantEntries.filter((e) => e.position === 6);

  const sections: string[] = [];

  // 1. Dynamic engine protocol synced 1:1 with active tools (zero ghost tools, crystal-clear dice trigger rule)
  sections.push(buildEngineProtocol(activeToolNames));

  // 2. Preset Zone 1 prompts (before chatHistory)
  if (preset && preset.zone1Prompts.length > 0) {
    const presetText = preset.zone1Prompts
      .map((p) => evaluateMacros(p.content, macroCtx))
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
    if (presetText) sections.push(presetText);
  }

  // 3. Card system_prompt (100% preserved)
  if (card.frozen.systemPrompt.trim()) {
    sections.push(evaluateMacros(card.frozen.systemPrompt, macroCtx));
  }

  // 3b. Constant World Info BEFORE char (position=0)
  if (loreBeforeChar.length > 0) {
    sections.push(`## World Lore (Core)\n${formatLoreEntries(loreBeforeChar, macroCtx, preset?.utilityPrompts.wiFormat)}`);
  }

  // 4. Primary Character Core (description + personality + scenario)
  const charParts: string[] = [`# Character: ${charName}`];
  if (card.frozen.description.trim()) {
    charParts.push(evaluateMacros(card.frozen.description, macroCtx));
  }
  if (card.frozen.personality.trim()) {
    charParts.push(`## Personality\n${evaluateMacros(card.frozen.personality, macroCtx)}`);
  }
  if (card.frozen.scenario.trim()) {
    charParts.push(`## Scenario\n${evaluateMacros(card.frozen.scenario, macroCtx)}`);
  }
  sections.push(charParts.join("\n\n"));

  // 4b. Multi-character cast cards (if `/rp cast add` added co-stars)
  for (const co of extraCastCards) {
    const coName = co.identity.nickname || co.identity.name;
    const coCtx: MacroContext = {
      charName: coName,
      userName: initialPersona.name,
      personaDescription: initialPersona.description,
      groupMembers,
      deterministicSeed: fnv1aSeed(`${co.id}:${initialPersona.name}`),
    };
    const parts: string[] = [`# Co-Character: ${coName}`];
    if (co.frozen.description.trim()) parts.push(evaluateMacros(co.frozen.description, coCtx));
    if (co.frozen.personality.trim()) parts.push(`## Personality\n${evaluateMacros(co.frozen.personality, coCtx)}`);
    if (co.frozen.mesExample.trim()) parts.push(`## Dialogue Examples\n${evaluateMacros(co.frozen.mesExample, coCtx)}`);
    sections.push(parts.join("\n\n"));
  }

  // 4c. Constant World Info AFTER char (position=1)
  if (loreAfterChar.length > 0) {
    sections.push(`## Core World Lore\n${formatLoreEntries(loreAfterChar, macroCtx, preset?.utilityPrompts.wiFormat)}`);
  }

  // 5a. Constant World Info BEFORE examples (position=5)
  if (loreBeforeExample.length > 0) {
    sections.push(formatLoreEntries(loreBeforeExample, macroCtx, preset?.utilityPrompts.wiFormat));
  }

  // 5. 100% Verbatim mes_example (NEVER truncated or summarized)
  if (card.frozen.mesExample.trim()) {
    sections.push(`## Dialogue Examples\n${evaluateMacros(card.frozen.mesExample, macroCtx)}`);
  }

  // 5b. Constant World Info AFTER examples (position=6)
  if (loreAfterExample.length > 0) {
    sections.push(formatLoreEntries(loreAfterExample, macroCtx, preset?.utilityPrompts.wiFormat));
  }

  // 6. Initial Persona (mid-session persona changes go into Zone 3 so Zone 1 stays frozen!)
  if (initialPersona.description.trim()) {
    sections.push(`## Player Persona: ${initialPersona.name}\n${initialPersona.description.trim()}`);
  } else {
    sections.push(`## Player Persona: ${initialPersona.name}`);
  }

  return sections.join("\n\n");
}

/**
 * Build Zone 3 Transient Tail Frame (appended ONLY to the outbound request tail, never persisted).
 */
export function buildZone3TransientTail(options: {
  card: CompiledCard;
  extraCastCards?: CompiledCard[];
  state: SessionRpState;
  preset?: CompiledPreset | null;
  recalledLore: CompiledLoreEntry[];
  recalledMemoryBooks?: MemoryBookEntry[];
  budgetDroppedLore?: Array<{ title: string; tokens?: number }>;
  recentText: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  narrativeHealth?: NarrativeHealthReport;
  maxZone3Tokens?: number;
}): string {
  const {
    card,
    extraCastCards = [],
    state,
    preset,
    recalledLore,
    recalledMemoryBooks = [],
    budgetDroppedLore = [],
    recentText,
    lastUserMessage,
    lastCharMessage,
    narrativeHealth,
    maxZone3Tokens,
  } = options;
  const charName = card.identity.nickname || card.identity.name;
  const groupMembers = [charName, ...extraCastCards.map((c) => c.identity.nickname || c.identity.name)];

  const flatVars: Record<string, number | string | boolean> = {};
  for (const [actor, stats] of Object.entries(state.stats)) {
    for (const [k, v] of Object.entries(stats)) {
      flatVars[k] = v;
      flatVars[`${actor}.${k}`] = v;
    }
  }

  // Include constant lore entries with Zone 3 positions (2=an_top, 3=an_bottom, 4=in_chat/@D)
  // so ST @D constant entries are never silently dropped!
  const zone3ConstantLore = card.loreBook.entries.filter((e) => {
    const effectiveEnabled = state.loreOverrides[e.id] ?? e.enabled;
    return (
      effectiveEnabled &&
      e.constant &&
      (e.position === 2 || e.position === 3 || e.position === 4) &&
      e.content.trim().length > 0 &&
      evaluateGate(e.gate, state)
    );
  });

  // Collect dynamic outlet entries (position=7) and deduplicate Zone 3 constant + recalled lore
  const dynamicOutlets: Record<string, string> = {};
  const normalRecalledLore: CompiledLoreEntry[] = [];
  const seenLoreIds = new Set<string>();
  for (const e of [...zone3ConstantLore, ...recalledLore]) {
    if (seenLoreIds.has(e.id)) continue;
    seenLoreIds.add(e.id);
    if (e.position === 7 && e.outletName) {
      const prev = dynamicOutlets[e.outletName];
      dynamicOutlets[e.outletName] = prev ? `${prev}\n${e.content}` : e.content;
    } else {
      normalRecalledLore.push(e);
    }
  }

  const macroCtx: MacroContext = {
    charName,
    userName: state.currentPersona.name,
    personaDescription: state.currentPersona.description,
    groupMembers,
    vars: flatVars,
    outlets: dynamicOutlets,
    worldTime: state.worldTimeLabel,
    worldDate: `Day ${state.day}`,
    lastUserMessage,
    lastCharMessage,
  };

  // Track sections with priority (1 = essential / never drop, 2 = important, 3 = droppable first under tight budget)
  const sections: Array<{ text: string; priority: 1 | 2 | 3 }> = [];
  const pushSection = (text: string, priority: 1 | 2 | 3) => {
    if (text) sections.push({ text, priority });
  };

  // 1. Deterministic <rp_state_frame>
  const activeFlags = Object.entries(state.flags)
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k)
    .sort();
  const sortedMilestones = Array.from(state.milestones).sort();

  const compactState: Record<string, unknown> = {
    stage: state.era || undefined,
    turn: state.turn,
    time: state.worldTimeLabel || undefined,
    location: state.location || undefined,
    adjacentRoutes: formatLocalTopology(state) || undefined,
    objective: state.sceneObjective || undefined,
    presentNpcs: state.presentNpcs.length > 0 ? state.presentNpcs : undefined,
    milestones: sortedMilestones.length > 0 ? sortedMilestones : undefined,
    flags: activeFlags.length > 0 ? activeFlags : undefined,
    clocks:
      Object.keys(state.clocks).length > 0
        ? Object.values(state.clocks)
            .sort((a, b) => a.clockId.localeCompare(b.clockId))
            .map((c) => `${c.label}:${c.value}/${c.max}${c.completed ? "(done)" : ""}`)
        : undefined,
    stats: Object.keys(state.stats).length > 0 ? state.stats : undefined,
    inventory: Object.keys(state.inventory).length > 0 ? state.inventory : undefined,
    cfsm:
      Object.keys(state.cfsmStates).length > 0
        ? Object.fromEntries(
            Object.keys(state.cfsmStates)
              .sort()
              .map((actor) => [
                actor,
                Object.fromEntries(
                  Object.keys(state.cfsmStates[actor]!)
                    .sort()
                    .map((axis) => [axis, state.cfsmStates[actor]![axis]!.state]),
                ),
              ]),
          )
        : undefined,
    conditions:
      Object.keys(state.conditions).length > 0
        ? Object.values(state.conditions)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(
              (c) =>
                `${c.actorId}:${c.label}${c.remainingTurns !== null ? `(${c.remainingTurns}t)` : ""}${c.effect ? `[${c.effect}]` : ""}`,
            )
        : undefined,
    lastRoll:
      state.lastRoll && state.turn - state.lastRoll.turn <= 1
        ? `${state.lastRoll.actor ? `${state.lastRoll.actor} ` : ""}${state.lastRoll.expression}=${state.lastRoll.total}${state.lastRoll.dc !== undefined ? `/DC${state.lastRoll.dc}` : ""}${state.lastRoll.critical === "nat_max" ? " CRITICAL_SUCCESS" : state.lastRoll.critical === "nat_min" ? " CRITICAL_FAILURE" : state.lastRoll.success === true ? " SUCCESS" : state.lastRoll.success === false ? " FAILURE" : ""}${state.lastRoll.reason ? ` (${state.lastRoll.reason})` : ""}`
        : undefined,
  };
  pushSection(`<rp_state_frame>\n${stableStringify(compactState)}\n</rp_state_frame>`, 1);

  // 1b. Last-round state delta highlight (ported from dsh-tavern foreground-variable-changes.js)
  const recentAudit = state.auditLog
    .filter((a) => a.turn >= Math.max(0, state.turn - 1) && a.summary.trim().length > 0)
    .slice(-3);
  if (recentAudit.length > 0) {
    pushSection(
      `<rp_recent_changes>\nRecent state changes (write this turn respecting these latest values):\n${recentAudit
        .map((a) => `- [T${a.turn}] ${a.summary}`)
        .join("\n")}\n</rp_recent_changes>`,
      3,
    );
  }

  // 1c. Unified Drama Director (<rp_drama_beat>): converges active Storylets, filled Clocks,
  //     matured NPC Agendas, due Foresights, critical Dice Rolls, and extreme Bond tension
  //     into ONE high-salience narrative beat so every subsystem visibly drives the story.
  const dramaBeats: string[] = [];
  const activeStoryletsForBeat = evaluateActiveStorylets(state);
  for (const st of activeStoryletsForBeat.slice(0, 2)) {
    dramaBeats.push(
      `[STORYLET id="${st.id}"] ${st.title}: ${st.triggerPrompt} (Once played out, record \`storylet_done: ${st.id}\` in [[RP_DELTA]])`,
    );
  }
  // Soft + Hard Hybrid Storylet Director (Drama Llama / Magnet)
  if (activeStoryletsForBeat.length === 0 && state.storylets.size > 0 && state.turn >= 4) {
    const recentLow = (recentText ?? "").toLowerCase();
    const locLow = (state.location ?? "").toLowerCase();
    let bestSoft: { st: StoryletEntry; score: number } | null = null;
    for (const st of state.storylets.values()) {
      if (st.status !== "armed") continue;
      if (st.gate?.minTurn !== undefined && state.turn < st.gate.minTurn) continue;
      if (st.gate?.forbiddenFlags?.some((f) => Boolean(state.flags[f]))) continue;
      let score = 0;
      if (state.turn >= 18) score += 40;
      else if (state.turn >= 12) score += 30;
      else if (state.turn >= 6) score += 18;
      const rawText = `${st.title} ${st.triggerPrompt}`;
      const kwSet = new Set<string>();
      for (const m of rawText.match(/[a-zA-Z]{4,}/g) ?? []) kwSet.add(m.toLowerCase());
      for (const run of rawText.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
        for (let i = 0; i <= run.length - 2 && kwSet.size < 20; i++) {
          kwSet.add(run.slice(i, i + 2));
        }
      }
      let hits = 0;
      for (const kl of kwSet) {
        if (recentLow.includes(kl) || locLow.includes(kl)) hits += 1;
      }
      score += Math.min(45, hits * 15);
      if (st.gate?.requiredFlags?.some((f) => Boolean(state.flags[f]))) score += 20;
      if (score >= 55 && (!bestSoft || score > bestSoft.score)) {
        bestSoft = { st, score };
      }
    }
    if (bestSoft) {
      dramaBeats.push(
        `[STORYLET READY id="${bestSoft.st.id}"] ${bestSoft.st.title}: ${bestSoft.st.triggerPrompt} (Weave organically when natural; mark \`storylet_done: ${bestSoft.st.id}\` once played out)`,
      );
    }
  }
  // Choice Consequence Echoes
  if (state.consequences.size > 0) {
    const recentLow = `${recentText ?? ""} ${state.location} ${state.presentNpcs.join(" ")}`.toLowerCase();
    for (const echo of state.consequences.values()) {
      if (echo.status !== "pending") continue;
      const age = state.turn - echo.plantedTurn;
      if (age < 3) continue;
      const entityHit = echo.entities.some((e) => e && recentLow.includes(e.toLowerCase()));
      const highWeightDue = echo.weight === "high" && age >= 8;
      if (entityHit || highWeightDue) {
        dramaBeats.push(
          `[CONSEQUENCE ECHO id="${echo.id}" from T${echo.plantedTurn}] Past choice "${echo.choice}" -> ripple: ${echo.consequence} (Mark \`echo_done: ${echo.id}\` once surfaced)`,
        );
      }
    }
  }
  for (const clk of Object.values(state.clocks)) {
    if (clk.completed && (clk.completedTurn === undefined || state.turn - clk.completedTurn <= 1)) {
      dramaBeats.push(`[CLOCK FULL id="${clk.clockId}"] "${clk.label}" (${clk.value}/${clk.max}) has reached fruition — depict its consequence!`);
    }
  }
  for (const ag of Object.values(state.npcAgendas)) {
    if (ag.etaTurns === 0) {
      dramaBeats.push(`[OFF-SCREEN AGENDA MATURED] ${ag.actorId} has completed "${ag.goal}" (${ag.currentActivity}) — let the ripple surface in-scene!`);
    }
  }
  for (const hook of state.foresights.values()) {
    if (hook.status !== "open") continue;
    const clockDue = Boolean(hook.dueClockId && state.clocks[hook.dueClockId]?.completed);
    const longOverdue = state.turn - hook.plantedTurn >= 10;
    if (clockDue || longOverdue) {
      dramaBeats.push(`[FORESIGHT DUE id="${hook.id}"] "${hook.summary}"${hook.triggerHint ? ` (hint: ${hook.triggerHint})` : ""} — weave a payoff or escalation naturally.`);
    }
  }
  if (state.lastRoll && state.turn - state.lastRoll.turn <= 1 && state.lastRoll.critical) {
    const critLabel = state.lastRoll.critical === "nat_max" ? "CRITICAL SUCCESS" : "CRITICAL FAILURE";
    dramaBeats.push(`[DICE ${critLabel}] ${state.lastRoll.expression}=${state.lastRoll.total}${state.lastRoll.reason ? ` (${state.lastRoll.reason})` : ""} — make this dramatic swing unmistakable!`);
  }
  for (const pb of Object.values(state.pairBonds)) {
    if (pb.lastCrisisTurn !== undefined && state.turn - pb.lastCrisisTurn > 1) continue;
    if (pb.tension <= -60) {
      dramaBeats.push(`[RELATIONSHIP RIFT] ${pb.actorA} ↔ ${pb.actorB} (${pb.stance}, tension ${pb.tension}) is at breaking point.`);
    } else if (pb.tension >= 60) {
      dramaBeats.push(`[DEEP BOND] ${pb.actorA} ↔ ${pb.actorB} (${pb.stance}, tension +${pb.tension}) strongly influences their loyalties.`);
    }
  }
  for (const prom of selectDueCommitments(state)) {
    dramaBeats.push(
      `[COMMITMENT DUE id="${prom.id}"] ${prom.actor} promised ${prom.target}: "${prom.promise}"${prom.dueLabel ? ` (${prom.dueLabel})` : ""} — honor, negotiate, or conspicuously break it (mark \`promise_done:\` / \`promise_broken:\` in [[RP_DELTA]]).`,
    );
  }
  for (const fac of selectFactionPressures(state)) {
    dramaBeats.push(
      `[FACTION PRESSURE] ${fac.name} (standing ${fac.standing}, heat ${fac.heat}/6${fac.note ? `, ${fac.note}` : ""}) — let faction agents, rumors, or scrutiny press in organically.`,
    );
  }
  if (dramaBeats.length > 0) {
    pushSection(
      `<rp_drama_beat>\nActive world-state triggers to weave naturally into this turn:\n${dramaBeats.slice(0, 6).map((b) => `- ${b}`).join("\n")}\n</rp_drama_beat>`,
      1,
    );
  }
  const encFrame = formatEncounterFrame(state.encounter);
  if (encFrame) {
    pushSection(encFrame, 1);
  }

  // 2. Mid-session persona switch notice (keeps Zone 1 frozen)
  if (state.personaChangedMidSession) {
    const pDesc = state.currentPersona.description.trim();
    pushSection(
      `<rp_persona_update>\nCurrent player persona is now: ${state.currentPersona.name}${pDesc ? ` — ${pDesc}` : ""}\n</rp_persona_update>`,
      1,
    );
  }

  // 3. Recalled Lore + Memory Books + Bi-Temporal Facts (with Epistemic Blind Spots) + RoleMemo DualMem Beliefs + Foresights
  const recalledSections: string[] = [];

  if (normalRecalledLore.length > 0) {
    const wiFmt = preset?.utilityPrompts.wiFormat;
    const loreText = normalRecalledLore
      .map((e) => {
        const body = evaluateMacros(e.content, macroCtx).trim();
        if (!body) return "";
        if (wiFmt && wiFmt.includes("{0}")) {
          return wiFmt.replace(/\{0\}/g, () => `[${e.title}] ${body}`);
        }
        return `[${e.title}] ${body}`;
      })
      .filter(Boolean)
      .join("\n");
    if (loreText) recalledSections.push(`## World Lore\n${loreText}`);
  }

  if (recalledMemoryBooks.length > 0) {
    const bookText = recalledMemoryBooks
      .map((b) => `- [${b.title} | T${b.turnRange[0]}-T${b.turnRange[1]}] ${b.summary}`)
      .join("\n");
    recalledSections.push(`## Archived Story Chapters (Memory Books)\n${bookText}`);
  }

  const activeFacts = selectFactsForZone3(state, recentText, 8, 6);
  if (activeFacts.length > 0) {
    const epistemicActors = state.presentNpcs.length > 0 ? state.presentNpcs : (charName ? [charName] : []);
    const { known, blindSpots } = partitionEpistemicFacts(activeFacts, epistemicActors);
    if (known.length > 0) {
      recalledSections.push(
        `## Established Facts\n${known.map((f) => `- [${f.id} | T${f.validFromTurn}] ${f.statement}`).join("\n")}`,
      );
    }
    if (blindSpots.length > 0) {
      recalledSections.push(
        `## Epistemic Access Boundaries (List-First Isolation: characters listed below CANNOT know, hear, or act on these facts)\n${blindSpots
          .map((b) => `- [${b.fact.id}] [HIDDEN FROM: ${b.ignorantNpcs.join(", ")}] ${b.fact.statement}`)
          .join("\n")}`,
      );
    }
  }

  // RoleMemo DualMem Character Beliefs with HEART-Bench Per-Character Perspective Filtering:
  // Avoid mixing off-screen characters' private beliefs into present characters' decision context!
  if (state.beliefs.length > 0) {
    const presentSet = new Set(state.presentNpcs.map((n) => n.toLowerCase()));
    const recentLower = recentText.toLowerCase();
    const relevantBeliefs = selectRelevantBeliefs(state, recentText, 8)
      .filter((b) => {
        if (presentSet.size === 0) return true;
        const actorLower = b.actorId.toLowerCase();
        if (presentSet.has(actorLower) || actorLower === charName.toLowerCase()) return true;
        return recentLower.includes(actorLower);
      })
      .slice(0, 6);
    if (relevantBeliefs.length > 0) {
      recalledSections.push(
        `## Character Beliefs (DREAM ABC) · DualMem\n${relevantBeliefs
          .map((b) => {
            const tone = b.emotionalTone ? ` [${b.emotionalTone}]` : "";
            const subtext = b.subjectiveInsight ? ` | inner subtext: ${b.subjectiveInsight}` : "";
            return `- ${b.actorId} → ${b.target} [T${b.turn}]: ${b.belief}${tone} (because: ${b.activatingEvent})${subtext}`;
          })
          .join("\n")}`,
      );
    }
  }

  const activeForesights = selectActiveForesights(state, recentText, 3);
  if (activeForesights.length > 0) {
    recalledSections.push(
      `## Open Foresights\n${activeForesights.map((h) => `- [${h.id}] ${h.summary}${h.triggerHint ? ` (hint: ${h.triggerHint})` : ""}`).join("\n")}`,
    );
  }

  if (recalledSections.length > 0) {
    pushSection(`<rp_recalled_context>\n${recalledSections.join("\n\n")}\n</rp_recalled_context>`, 1);
  }

  // 3b. Lightweight Worldbook Title Hints for budget-dropped entries (<=256 tokens, ported from dsh-tavern)
  if (budgetDroppedLore.length > 0) {
    const seenTitles = new Set<string>();
    const hintTitles: string[] = [];
    let usedHintTokens = 28;
    for (const item of budgetDroppedLore) {
      const title = Array.from(String(item.title || "").trim()).slice(0, 80).join("");
      if (!title || seenTitles.has(title)) continue;
      const cost = estimateTokens(title) + 2;
      if (usedHintTokens + cost > 256 || hintTitles.length >= 12) break;
      seenTitles.add(title);
      hintTitles.push(title);
      usedHintTokens += cost;
    }
    if (hintTitles.length > 0) {
      pushSection(
        `<lorebook_title_hints>\n可能用到的世界书条目（超出预算未自动展开，如需细节可调用 rp_recall(action="read", query="标题") 按需查阅）：${hintTitles.join("、")}\n</lorebook_title_hints>`,
        3,
      );
    }
  }

  // 3c. Dynamic Scene Physical State & Spatial Occlusion (attire / wounds / holding / position)
  const presentLowerSet = new Set([
    ...state.presentNpcs.map((n) => n.toLowerCase()),
    state.currentPersona.name.toLowerCase(),
    "player",
  ]);
  const visiblePhysical = Object.values(state.physicalState).filter(
    (ps) => state.presentNpcs.length === 0 || presentLowerSet.has(ps.actorId.toLowerCase()) || ps.actorId.toLowerCase() === charName.toLowerCase(),
  );
  if (visiblePhysical.length > 0 || state.spatialNotes.trim()) {
    const physLines = visiblePhysical.slice(0, 6).map((ps) => {
      const attrs = [
        ps.attire ? `attire=${ps.attire}` : null,
        ps.condition ? `condition=${ps.condition}` : null,
        ps.holding ? `holding=${ps.holding}` : null,
        ps.position ? `position=${ps.position}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      return `- ${ps.actorId}: ${attrs}`;
    });
    if (state.spatialNotes.trim()) {
      physLines.push(`- Space/Occlusion: ${state.spatialNotes.trim()}`);
    }
    pushSection(
      `<rp_physical_scene>\nRespect physical continuity, line-of-sight, and audio occlusion (no teleportation or telepathic eavesdropping):\n${physLines.join("\n")}\n</rp_physical_scene>`,
      1,
    );
  }

  // 3d. Living World: Off-Screen NPC Agendas & NPC<->NPC Pair Bonds (narrator-only awareness)
  const isLivingWorldArchetype =
    state.archetype === "ensemble" || state.archetype === "epic-saga" || state.archetype === "mystery";
  const agendaList = Object.values(state.npcAgendas).slice(0, 5);
  const relevantBonds = Object.values(state.pairBonds)
    .filter(
      (b) =>
        state.presentNpcs.length === 0 ||
        presentLowerSet.has(b.actorA.toLowerCase()) ||
        presentLowerSet.has(b.actorB.toLowerCase()),
    )
    .slice(0, 5);
  const allowLivingWorld =
    isLivingWorldArchetype || extraCastCards.length > 0 || agendaList.length > 0 || relevantBonds.length > 0;
  if (allowLivingWorld && (agendaList.length > 0 || relevantBonds.length > 0)) {
    const lwLines: string[] = [];
    for (const ag of agendaList) {
      const etaTag =
        ag.etaTurns === 0
          ? " [DUE/ARRIVING NOW]"
          : typeof ag.etaTurns === "number" && ag.etaTurns > 0
            ? ` [ETA: ${ag.etaTurns}t]`
            : "";
      lwLines.push(`- Off-screen Agenda (${ag.actorId}${etaTag}): ${ag.currentActivity} (goal: ${ag.goal})`);
    }
    for (const bond of relevantBonds) {
      lwLines.push(`- NPC Bond (${bond.actorA} <-> ${bond.actorB}): ${bond.stance} (tension ${bond.tension}) — ${bond.note}`);
    }
    pushSection(
      `<rp_living_world>\nBackground world continuity (off-screen agendas are narrator-only; never let ignorant present NPCs know them until revealed):\n${lwLines.join("\n")}\n</rp_living_world>`,
      3,
    );
  }

  // 3e. ContextEcho Voice & Backbone Anchors (Anti-Drift + Anti-Sycophancy, <=90 tokens for focal characters)
  const anchorEntries = Object.values(state.voiceAnchors).filter(
    (a) =>
      state.presentNpcs.length === 0 ||
      presentLowerSet.has(a.actorId.toLowerCase()) ||
      a.actorId.toLowerCase() === charName.toLowerCase(),
  );
  const profileVoiceAnchors = card.worldProfile?.voiceAnchors ?? [];
  if (anchorEntries.length === 0 && profileVoiceAnchors.length > 0) {
    for (const a of profileVoiceAnchors) {
      if (
        state.presentNpcs.length === 0 ||
        presentLowerSet.has(a.actorId.toLowerCase()) ||
        a.actorId.toLowerCase() === charName.toLowerCase()
      ) {
        anchorEntries.push(a);
      }
    }
  }
  const hasExplicitVoiceAnchors =
    Object.keys(state.voiceAnchors).length > 0 || profileVoiceAnchors.length > 0;
  if (anchorEntries.length === 0 && (state.turn >= 12 || hasExplicitVoiceAnchors)) {
    const fallbackAnchor = extractHeuristicVoiceAnchor(card);
    if (fallbackAnchor) anchorEntries.push(fallbackAnchor);
  }
  if (anchorEntries.length > 0) {
    const vaLines = anchorEntries.slice(0, 3).map((a) => {
      const quotes = a.speechSamples.length > 0 ? ` | voice: ${a.speechSamples.slice(0, 2).map((q) => `“${q}”`).join(" / ")}` : "";
      const taboo = a.tabooBehaviors ? ` | never: ${a.tabooBehaviors}` : "";
      return `- ${a.actorId}: ${a.backbone}${quotes}${taboo}`;
    });
    pushSection(
      `<rp_voice_anchors>\nMaintain distinct character speech cadence and non-negotiable backbone (never flatten into generic AI tone or unearned compliance):\n${vaLines.join("\n")}\n</rp_voice_anchors>`,
      1,
    );
  }

  // 4. Optional Director Pacing, Active Storylets, Genuine Narrative Health Guards & Active Director Notes
  const pacingCue = PACING_HINTS[state.pacingMode];
  const lengthCue =
    state.responseLength === "concise"
      ? "Length cue: Keep this reply crisp and punchy (~200-350 chars / 2-3 short paragraphs)."
      : state.responseLength === "novel"
        ? "Length cue: Write an immersive novel-length scene (~650-1000 chars) rich in concrete sensory detail and subtext."
        : null;
  const povCue =
    state.narrativePov === "second"
      ? "POV cue: Narrate strictly in second person (你/you) for the player's perspective."
      : state.narrativePov === "third"
        ? "POV cue: Narrate in literary third person."
        : state.narrativePov === "first_char"
          ? "POV cue: Narrate from the character's first-person perspective."
          : null;
  const runtimeSlopHits =
    narrativeHealth?.runtimeSlopPhrases ??
    (recentText ? detectRuntimeSlop(recentText.split(/\n{2,}/)).phrases : []);
  const autoSlopHits = detectRepeatedCliches(recentText);
  const combinedBans = Array.from(
    new Set([...(state.bannedPhrases ?? []), ...runtimeSlopHits, ...autoSlopHits]),
  ).slice(0, 12);
  const banCue =
    combinedBans.length > 0
      ? `Avoid repeating these overused phrases/clichés: ${combinedBans.join(" / ")}.`
      : null;
  const activeStorylets = evaluateActiveStorylets(state);
  const pointInTimeOverride =
    state.turn >= 4 &&
    ((state.initialLocation && state.location && state.location !== state.initialLocation) || state.era.trim().length > 0)
      ? "Continuity override: Current <rp_state_frame> location, time, and physical state strictly supersede any opening-scene situation written in the static character card."
      : null;
  const trimmedUser = (lastUserMessage ?? "").trim();
  const shortInputCue =
    trimmedUser.length > 0 &&
    trimmedUser.length <= 16 &&
    !trimmedUser.startsWith("[OOC") &&
    state.responseLength !== "concise"
      ? "Mobile brief-input cue: The player sent a short cue; maintain full literary prose depth, sensory grounding, and proactive scene momentum rather than mirroring brevity."
      : null;

  // Anti-Godmoding Guard (default ON)
  const antiGodmodingCue =
    state.antiGodmoding !== false
      ? evaluateMacros(
          "Player Agency: NEVER speak, think, decide, or perform decisive actions for {{user}}; leave clear space for {{user}} to react.",
          macroCtx,
        )
      : null;

  // Anti-Sycophancy Friction Rule (fires when any present NPC is guarded/hostile in CFSM or has negative affinity)
  const activeNpcLowerSet = new Set(
    (state.presentNpcs.length > 0 ? state.presentNpcs : [charName]).map((n) => n.toLowerCase()),
  );
  const GUARDED_CFSM_RE = /guarded|wary|hostile|suspicious|cold|distrust|antagonistic|戒备|敌对|冷淡|警惕|怀疑|敌意|防备/i;
  const AFFINITY_STAT_RE = /affection|affinity|trust|favor|favour|bond|relation|liking|loyalty|friendship|respect|好感|信任|亲密|关系|友善|信赖|忠诚/i;
  let hasGuardedPresentNpc = false;
  for (const [actor, axes] of Object.entries(state.cfsmStates)) {
    if (!activeNpcLowerSet.has(actor.toLowerCase())) continue;
    for (const rec of Object.values(axes)) {
      if (GUARDED_CFSM_RE.test(rec.state)) {
        hasGuardedPresentNpc = true;
        break;
      }
    }
    if (hasGuardedPresentNpc) break;
  }
  if (!hasGuardedPresentNpc) {
    for (const [actor, statMap] of Object.entries(state.stats)) {
      if (!activeNpcLowerSet.has(actor.toLowerCase())) continue;
      for (const [k, v] of Object.entries(statMap)) {
        if (typeof v === "number" && v < 0 && AFFINITY_STAT_RE.test(k)) {
          hasGuardedPresentNpc = true;
          break;
        }
      }
      if (hasGuardedPresentNpc) break;
    }
  }
  const antiSycophancyCue = hasGuardedPresentNpc
    ? "Character Resistance: Present character(s) remain guarded/hostile — do NOT soften prematurely or agree easily; require earned trust or tangible leverage."
    : null;

  // Multi-NPC Spotlight Director (avoids "polite conference call" syndrome when 2+ NPCs are present)
  const hasManualSpotlight = state.notes.some((n) => /spotlight|焦点|聚焦/i.test(n.text));
  let spotlightCue: string | null = null;
  if (state.presentNpcs.length >= 2 && !hasManualSpotlight) {
    const talkMap = new Map<string, number>();
    for (const c of [card, ...extraCastCards]) {
      const t = typeof c.identity.talkativeness === "number" ? c.identity.talkativeness : 0.5;
      talkMap.set(c.identity.name.toLowerCase(), t);
      if (c.identity.nickname) talkMap.set(c.identity.nickname.toLowerCase(), t);
      for (const al of c.identity.aliases ?? []) {
        talkMap.set(al.toLowerCase(), t);
      }
    }
    const n = state.presentNpcs.length;
    const userMsgLower = (lastUserMessage ?? "").toLowerCase();
    const ranked = state.presentNpcs.map((npc, idx) => {
      const talk = talkMap.get(npc.toLowerCase()) ?? 0.5;
      const slot = (idx + state.turn) % n;
      const rotBoost = slot === 0 ? 0.45 : slot === 1 ? 0.2 : 0;
      const mentionedBoost = userMsgLower && userMsgLower.includes(npc.toLowerCase()) ? 2.0 : 0;
      return { npc, score: talk + rotBoost + mentionedBoost, idx };
    });
    ranked.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const focalCount = n >= 3 ? 2 : 1;
    const focalNpcs = ranked.slice(0, focalCount).map((r) => r.npc);
    spotlightCue = `Spotlight Director: Focus active dialogue and reactions primarily on ${focalNpcs.join(" & ")} this turn; keep other present NPCs brief or reactive rather than taking equal turns.`;
  }

  const staleObjectiveCue =
    state.sceneObjective && state.turn >= 5 && state.turn - (state.objectiveUpdatedTurn ?? 0) >= 6
      ? "Scene objective/stage refresh: If the immediate goal or chapter has moved past the recorded scene objective/stage, update `obj:` and `stage:` in [[RP_DELTA]]."
      : null;

  const noteLines = [
    ...(antiGodmodingCue ? [`- ${antiGodmodingCue}`] : []),
    ...(staleObjectiveCue ? [`- ${staleObjectiveCue}`] : []),
    ...(antiSycophancyCue ? [`- ${antiSycophancyCue}`] : []),
    ...(spotlightCue ? [`- ${spotlightCue}`] : []),
    ...(pointInTimeOverride ? [`- ${pointInTimeOverride}`] : []),
    ...(shortInputCue ? [`- ${shortInputCue}`] : []),
    ...(pacingCue ? [`- ${pacingCue}`] : []),
    ...(lengthCue ? [`- ${lengthCue}`] : []),
    ...(povCue ? [`- ${povCue}`] : []),
    ...(banCue ? [`- ${banCue}`] : []),
    ...(narrativeHealth?.antiRepetitionCue ? [`- ${narrativeHealth.antiRepetitionCue}`] : []),
    ...(narrativeHealth?.antiStagnationCue ? [`- ${narrativeHealth.antiStagnationCue}`] : []),
    ...state.notes.map((n) => `- ${n.text}`),
  ];
  if (noteLines.length > 0) {
    pushSection(`<rp_director_note>\n${noteLines.join("\n")}\n</rp_director_note>`, 1);
  }

  // 4b. Optional Inner Monologue cue (styled cleanly by Markdown transformer)
  if (state.innerMonologue) {
    pushSection(
      `<rp_monologue_cue>\nBefore the visible narrative prose, briefly include 1-2 intimate sentences of the focal character's unspoken inner monologue wrapped in <thought>...</thought>. Keep it deeply in-character and never leak out-of-world meta commentary.\n</rp_monologue_cue>`,
      1,
    );
  }

  // 5. Preset Zone 3 tail prompts (sorted by depth desc)
  if (preset && preset.zone3Prompts.length > 0) {
    for (const p of preset.zone3Prompts) {
      const evaluated = evaluateMacros(p.content, macroCtx).trim();
      if (evaluated) pushSection(evaluated, 1);
    }
  }

  // 6. Card depth_prompt & post_history_instructions (100% preserved at highest recency position)
  if (card.tailInstructions.depthPrompt?.content.trim()) {
    pushSection(evaluateMacros(card.tailInstructions.depthPrompt.content, macroCtx).trim(), 1);
  }
  if (card.tailInstructions.postHistoryInstructions.trim()) {
    pushSection(evaluateMacros(card.tailInstructions.postHistoryInstructions, macroCtx).trim(), 1);
  }

  // Enforce a total Zone 3 token budget cap by dropping lower-priority optional sections first
  const loreTokenBudget = state.loreTokenBudget || 1800;
  const zone3Cap = maxZone3Tokens ?? Math.max(2200, Math.min(3600, loreTokenBudget + 1200));
  let totalTokens = sections.reduce((sum, s) => sum + estimateTokens(s.text), 0);
  if (totalTokens > zone3Cap) {
    const keepFlags = sections.map(() => true);
    for (const dropPrio of [3, 2] as const) {
      for (let i = sections.length - 1; i >= 0 && totalTokens > zone3Cap; i--) {
        if (keepFlags[i] && sections[i]!.priority === dropPrio) {
          keepFlags[i] = false;
          totalTokens -= estimateTokens(sections[i]!.text);
        }
      }
    }
    return sections
      .filter((_, idx) => keepFlags[idx])
      .map((s) => s.text)
      .join("\n\n");
  }

  return sections.map((s) => s.text).join("\n\n");
}

/**
 * Non-destructively filter hidden messages (matching entryId OR deterministic fingerprint)
 * & attach Zone 3 ONLY to the very last message of the outbound copy.
 * Guarantees Zone 2 prefix history objects are NEVER mutated (even during tool-call loops).
 */
export function attachZone3ToMessages(
  messages: PiMessage[],
  zone3Text: string,
  hiddenEntryIds: Set<string>,
  hiddenFingerprints?: Set<string>,
): PiMessage[] {
  const hasHides = hiddenEntryIds.size > 0 || (hiddenFingerprints?.size ?? 0) > 0;
  const filtered = hasHides
    ? messages.filter((m) => {
        const entryId = typeof m.entryId === "string" ? m.entryId : typeof m.id === "string" ? m.id : null;
        if (entryId && hiddenEntryIds.has(entryId)) return false;
        if (hiddenFingerprints && hiddenFingerprints.size > 0) {
          const fp = computeMessageFingerprint(m);
          if (hiddenFingerprints.has(fp)) return false;
        }
        return true;
      })
    : messages.slice();

  if (!zone3Text.trim() || filtered.length === 0) return filtered;

  const out = filtered.slice();
  // STRICT KV-CACHE INVARIANT: ALWAYS attach Zone 3 to the VERY LAST message (`out[out.length - 1]`),
  // even if it is a `toolResult` inside a multi-step tool loop. NEVER jump backwards to mutate
  // an earlier `user` message — doing so invalidates the entire `user + toolCall + toolResult` prefix cache!
  const targetIdx = out.length - 1;
  const target = out[targetIdx]!;

  // Because `context` attaches Zone 3 only transiently (never mutating stored user messages),
  // a trailing `toolResult` has NO Zone 3 on the earlier user turn. Attach the full transient
  // Zone 3 strictly to `out[last]` so KV-Cache on prior messages stays 100% intact AND the model
  // retains recalled lore, facts/blind spots, voice anchors, and director rules when writing prose!
  const payloadToAttach = zone3Text;

  if (typeof target.content === "string") {
    out[targetIdx] = {
      ...target,
      content: `${target.content}\n\n${payloadToAttach}`,
    };
  } else if (Array.isArray(target.content)) {
    const blocks: PiContentBlock[] = [...target.content, { type: "text", text: `\n\n${payloadToAttach}` }];
    out[targetIdx] = {
      ...target,
      content: blocks,
    };
  }

  return out;
}

/**
 * Extract plain text from the last N in-character messages for lore/foresight recall.
 * Explicitly skips `rp:ooc` and `rp:event` auxiliary cards so meta chatter never pollutes scanDepth!
 */
export function extractRecentMessagesText(messages: PiMessage[], depth = 4): string {
  const inWorld = messages.filter(
    (m) => m.customType !== "rp:ooc" && m.customType !== "rp:event" && m.role !== "toolResult",
  );
  const slice = inWorld.slice(-Math.max(1, depth));
  const chunks: string[] = [];
  for (const m of slice) {
    if (typeof m.content === "string") {
      chunks.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
          chunks.push(b.text);
        }
      }
    }
  }
  return chunks.join("\n");
}
