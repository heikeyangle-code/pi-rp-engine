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
 *    recalled lore + Memory Book chapters (with preset `wiFormat` & dynamic `outlet` expansion),
 *    bi-temporal facts with FANToM blind spots, open foresights, condition-gated Storylets,
 *    optional Inner Monologue cue, Director Pacing & notes, preset tail prompts, `depth_prompt`,
 *    and `post_history_instructions`.
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
import { selectRelevantBeliefs } from "../memory/graph-ppr.js";
import type { NarrativeHealthReport } from "../engine/stagnation.js";
import { estimateTokens } from "./token-budget.js";

function fnv1aSeed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const ENGINE_PROTOCOL_COMPACT = `[RP Engine Protocol]
- You are the sole narrative writer for this interactive world. Maintain consistent literary voice, given-circumstance character psychology, and organic pacing.
- Authoritative world state (stats, inventory, clocks, era gates, flags, bi-temporal facts, character beliefs) is maintained deterministically by code and provided in <rp_state_frame> & <rp_recalled_context> at the end of the turn. Never fabricate impossible stat/item changes or print legacy HTML status bars.
- Regular dialogue/emotional turns require ZERO tool calls — write the narrative directly.
- Invoke tools ONLY when genuinely needed: \`rp_roll_check\` for uncertain checks, \`rp_state_patch\` when items/stats/location/clocks/CFSM materially change, \`rp_fact_commit\` for major new/invalidated facts, DREAM belief shifts, or foresights, \`rp_recall\` for deep archive lookups, \`rp_era_advance\` for major act transitions, and \`rp_npc_deliberate\` only for strict hidden-information NPC plotting.`;

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

function collectStaticOutlets(card: CompiledCard, macroCtx: MacroContext): Record<string, string> {
  const outlets: Record<string, string> = {};
  for (const e of card.loreBook.entries) {
    if (e.enabled && e.constant && e.position === 7 && e.outletName && e.content.trim()) {
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
        return wiFormat.replace(/\{0\}/g, `[${e.title}]\n${body}`);
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
}): string {
  const { card, extraCastCards = [], preset, initialPersona } = options;
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
  const staticOutlets = collectStaticOutlets(card, baseMacroCtx);
  const macroCtx: MacroContext = { ...baseMacroCtx, outlets: staticOutlets };

  const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
  const constantEntries = card.frozen.constantLoreIds
    .map((id) => loreById.get(id))
    .filter((e): e is CompiledLoreEntry => Boolean(e && e.enabled && e.content.trim()));

  const loreBeforeChar = constantEntries.filter((e) => e.position === 0);
  const loreAfterChar = constantEntries.filter((e) => e.position === 1);
  const loreBeforeExample = constantEntries.filter((e) => e.position === 5);
  const loreAfterExample = constantEntries.filter((e) => e.position === 6);

  const sections: string[] = [];

  // 1. Compact engine protocol
  sections.push(ENGINE_PROTOCOL_COMPACT);

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
  recentText: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  narrativeHealth?: NarrativeHealthReport;
}): string {
  const {
    card,
    extraCastCards = [],
    state,
    preset,
    recalledLore,
    recalledMemoryBooks = [],
    recentText,
    lastUserMessage,
    lastCharMessage,
    narrativeHealth,
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

  // Collect dynamic outlet entries (position=7)
  const dynamicOutlets: Record<string, string> = {};
  const normalRecalledLore: CompiledLoreEntry[] = [];
  for (const e of recalledLore) {
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

  const parts: string[] = [];

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
  };
  parts.push(`<rp_state_frame>\n${stableStringify(compactState)}\n</rp_state_frame>`);

  // 2. Mid-session persona switch notice (keeps Zone 1 frozen)
  if (state.personaChangedMidSession) {
    const pDesc = state.currentPersona.description.trim();
    parts.push(
      `<rp_persona_update>\nCurrent player persona is now: ${state.currentPersona.name}${pDesc ? ` — ${pDesc}` : ""}\n</rp_persona_update>`,
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
          return wiFmt.replace(/\{0\}/g, `[${e.title}] ${body}`);
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
    const { known, blindSpots } = partitionEpistemicFacts(activeFacts, state.presentNpcs);
    if (known.length > 0) {
      recalledSections.push(
        `## Established Facts\n${known.map((f) => `- [T${f.validFromTurn}] ${f.statement}`).join("\n")}`,
      );
    }
    if (blindSpots.length > 0) {
      recalledSections.push(
        `## Epistemic Access Boundaries (List-First Isolation: characters listed below CANNOT know, hear, or act on these facts)\n${blindSpots
          .map((b) => `- [HIDDEN FROM: ${b.ignorantNpcs.join(", ")}] ${b.fact.statement}`)
          .join("\n")}`,
      );
    }
  }

  // RoleMemo DualMem Character Beliefs (query-relevant ranking by present NPCs + entity/token overlap + recency)
  if (state.beliefs.length > 0) {
    const relevantBeliefs = selectRelevantBeliefs(state, recentText, 6);
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
      `## Open Foresights\n${activeForesights.map((h) => `- ${h.summary}${h.triggerHint ? ` (hint: ${h.triggerHint})` : ""}`).join("\n")}`,
    );
  }

  if (recalledSections.length > 0) {
    parts.push(`<rp_recalled_context>\n${recalledSections.join("\n\n")}\n</rp_recalled_context>`);
  }

  // 4. Optional Director Pacing, Active Storylets, Genuine Narrative Health Guards & Active Director Notes
  const pacingCue = PACING_HINTS[state.pacingMode];
  const activeStorylets = evaluateActiveStorylets(state);
  const noteLines = [
    ...(state.sceneObjective ? [`- Scene Objective: ${state.sceneObjective}`] : []),
    ...activeStorylets.map((s) => `- [Triggered Storylet · ${s.title}] ${s.triggerPrompt}`),
    ...(pacingCue ? [`- ${pacingCue}`] : []),
    ...(narrativeHealth?.antiRepetitionCue ? [`- ${narrativeHealth.antiRepetitionCue}`] : []),
    ...(narrativeHealth?.antiStagnationCue ? [`- ${narrativeHealth.antiStagnationCue}`] : []),
    ...state.notes.map((n) => `- ${n.text}`),
  ];
  if (noteLines.length > 0) {
    parts.push(`<rp_director_note>\n${noteLines.join("\n")}\n</rp_director_note>`);
  }

  // 4b. Optional Inner Monologue cue (styled cleanly by Markdown transformer)
  if (state.innerMonologue) {
    parts.push(
      `<rp_monologue_cue>\nBefore the visible narrative prose, briefly include 1-2 intimate sentences of the focal character's unspoken inner monologue wrapped in <thought>...</thought>. Keep it deeply in-character and never leak out-of-world meta commentary.\n</rp_monologue_cue>`,
    );
  }

  // 5. Preset Zone 3 tail prompts (sorted by depth desc)
  if (preset && preset.zone3Prompts.length > 0) {
    for (const p of preset.zone3Prompts) {
      const evaluated = evaluateMacros(p.content, macroCtx).trim();
      if (evaluated) parts.push(evaluated);
    }
  }

  // 6. Card depth_prompt & post_history_instructions (100% preserved at highest recency position)
  if (card.tailInstructions.depthPrompt?.content.trim()) {
    parts.push(evaluateMacros(card.tailInstructions.depthPrompt.content, macroCtx).trim());
  }
  if (card.tailInstructions.postHistoryInstructions.trim()) {
    parts.push(evaluateMacros(card.tailInstructions.postHistoryInstructions, macroCtx).trim());
  }

  return parts.join("\n\n");
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

  if (typeof target.content === "string") {
    out[targetIdx] = {
      ...target,
      content: `${target.content}\n\n${zone3Text}`,
    };
  } else if (Array.isArray(target.content)) {
    const blocks: PiContentBlock[] = [...target.content, { type: "text", text: `\n\n${zone3Text}` }];
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
