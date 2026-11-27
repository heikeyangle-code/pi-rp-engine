/**
 * Three-Zone KV-Cache Zero-Fragmentation Context Assembler.
 *
 * Strict Invariants:
 *  - Zone 1 (before_agent_start): 100% byte-identical across turns. Contains ONLY static protocol,
 *    preset Zone 1 prompts, card system_prompt, description, personality, scenario, 100% verbatim
 *    mes_example, initial persona, and constant lore sorted deterministically. ZERO timestamps,
 *    turn numbers, dynamic stats, or dynamic lore.
 *  - Zone 2 (Append-Only history): NEVER mutates `messages[0 .. n-2]` (except non-destructive
 *    filtering of user-hidden entry IDs when `/rp hide` is active).
 *  - Zone 3 (Transient tail frame via `context` hook): Attached ONLY to the final message of the
 *    outbound copy (never persisted to JSONL), with deterministic JSON key ordering.
 */

import type {
  CompiledCard,
  CompiledLoreEntry,
  CompiledPreset,
  PersonaProfile,
  PiContentBlock,
  PiMessage,
  SessionRpState,
} from "../types.js";
import { evaluateMacros } from "../parser/macros.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import { partitionEpistemicFacts } from "../engine/gates.js";
import { selectActiveForesights } from "../memory/foresight.js";

const ENGINE_PROTOCOL_COMPACT = `[RP Engine Protocol]
- You are the sole narrative writer for this interactive world. Maintain consistent literary voice, character psychology, and pacing.
- Authoritative world state (stats, inventory, clocks, era gates, bi-temporal facts) is maintained deterministically by code and provided in <rp_state_frame> at the end of the turn. Never fabricate impossible stat/item changes or print legacy HTML status bars.
- Regular dialogue/emotional turns require ZERO tool calls — write the narrative directly.
- Invoke tools ONLY when genuinely needed: \`rp_roll_check\` for uncertain checks, \`rp_state_patch\` when items/stats/location/clocks materially change, \`rp_fact_commit\` for major new/invalidated facts or foresights, \`rp_recall\` for deep archive lookups, \`rp_era_advance\` for major act transitions, and \`rp_npc_deliberate\` only for strict hidden-information NPC plotting.`;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
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
  const macroCtx = { charName, userName: initialPersona.name };
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
    const coCtx = { charName: coName, userName: initialPersona.name };
    const parts: string[] = [`# Co-Character: ${coName}`];
    if (co.frozen.description.trim()) parts.push(evaluateMacros(co.frozen.description, coCtx));
    if (co.frozen.personality.trim()) parts.push(`## Personality\n${evaluateMacros(co.frozen.personality, coCtx)}`);
    sections.push(parts.join("\n\n"));
  }

  // 5. 100% Verbatim mes_example (NEVER truncated or summarized)
  if (card.frozen.mesExample.trim()) {
    sections.push(`## Dialogue Examples\n${evaluateMacros(card.frozen.mesExample, macroCtx)}`);
  }

  // 6. Initial Persona (mid-session persona changes go into Zone 3 so Zone 1 stays frozen!)
  if (initialPersona.description.trim()) {
    sections.push(`## Player Persona: ${initialPersona.name}\n${initialPersona.description.trim()}`);
  } else {
    sections.push(`## Player Persona: ${initialPersona.name}`);
  }

  // 7. Constant (blue-light) static lore entries in deterministic order
  const loreById = new Map(card.loreBook.entries.map((e) => [e.id, e]));
  const constantBlocks: string[] = [];
  for (const id of card.frozen.constantLoreIds) {
    const entry = loreById.get(id);
    if (!entry || !entry.enabled || !entry.content.trim()) continue;
    constantBlocks.push(`### ${entry.title}\n${evaluateMacros(entry.content, macroCtx)}`);
  }
  if (constantBlocks.length > 0) {
    sections.push(`## Core World Lore\n${constantBlocks.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Build Zone 3 Transient Tail Frame (appended ONLY to the final outbound message, never persisted).
 */
export function buildZone3TransientTail(options: {
  card: CompiledCard;
  state: SessionRpState;
  preset?: CompiledPreset | null;
  recalledLore: CompiledLoreEntry[];
  recentText: string;
}): string {
  const { card, state, preset, recalledLore, recentText } = options;
  const charName = card.identity.nickname || card.identity.name;
  const flatVars: Record<string, number | string | boolean> = {};
  for (const [actor, stats] of Object.entries(state.stats)) {
    for (const [k, v] of Object.entries(stats)) {
      flatVars[k] = v;
      flatVars[`${actor}.${k}`] = v;
    }
  }
  const macroCtx = {
    charName,
    userName: state.currentPersona.name,
    vars: flatVars,
    worldTime: state.worldTimeLabel,
    worldDate: `Day ${state.day}`,
  };

  const parts: string[] = [];

  // 1. Deterministic <rp_state_frame>
  const compactState: Record<string, unknown> = {
    era: state.era,
    turn: state.turn,
    time: state.worldTimeLabel,
    location: state.location || undefined,
    presentNpcs: state.presentNpcs.length > 0 ? state.presentNpcs : undefined,
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

  // 3. Recalled Lore + Active Bi-Temporal Facts (with Epistemic Blind Spots) + Foresight Hooks
  const recalledSections: string[] = [];

  if (recalledLore.length > 0) {
    const loreText = recalledLore
      .map((e) => `[${e.title}] ${evaluateMacros(e.content, macroCtx)}`)
      .join("\n");
    recalledSections.push(`## World Lore\n${loreText}`);
  }

  const activeFacts = getActiveFacts(state).slice(0, 12);
  if (activeFacts.length > 0) {
    const { known, blindSpots } = partitionEpistemicFacts(activeFacts, state.presentNpcs);
    if (known.length > 0) {
      recalledSections.push(
        `## Established Facts\n${known.map((f) => `- [T${f.validFromTurn}] ${f.statement}`).join("\n")}`,
      );
    }
    if (blindSpots.length > 0) {
      recalledSections.push(
        `## Epistemic Blind Spots (DO NOT leak to ignorant NPCs)\n${blindSpots
          .map((b) => `- ${b.fact.statement} [Unaware: ${b.ignorantNpcs.join(", ")}]`)
          .join("\n")}`,
      );
    }
  }

  const activeForesights = selectActiveForesights(state, recentText, 3);
  if (activeForesights.length > 0) {
    recalledSections.push(
      `## Open Foresights\n${activeForesights.map((h) => `- ${h.summary} (hint: ${h.triggerHint})`).join("\n")}`,
    );
  }

  if (recalledSections.length > 0) {
    parts.push(`<rp_recalled_context>\n${recalledSections.join("\n\n")}\n</rp_recalled_context>`);
  }

  // 4. Active Director Notes (/rp note)
  if (state.notes.length > 0) {
    const noteLines = state.notes.map((n) => `- ${n.text}`).join("\n");
    parts.push(`<rp_director_note>\n${noteLines}\n</rp_director_note>`);
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
 * Non-destructively filter hidden messages & attach Zone 3 ONLY to the last message copy.
 * Guarantees Zone 2 (`messages[0 .. n-2]`) is never mutated.
 */
export function attachZone3ToMessages(
  messages: PiMessage[],
  zone3Text: string,
  hiddenEntryIds: Set<string>,
): PiMessage[] {
  const filtered =
    hiddenEntryIds.size > 0
      ? messages.filter((m) => {
          const entryId = typeof m.entryId === "string" ? m.entryId : typeof m.id === "string" ? m.id : null;
          return !entryId || !hiddenEntryIds.has(entryId);
        })
      : messages.slice();

  if (!zone3Text.trim() || filtered.length === 0) return filtered;

  const out = filtered.slice();
  const lastIdx = out.length - 1;
  const last = out[lastIdx]!;

  if (typeof last.content === "string") {
    out[lastIdx] = {
      ...last,
      content: `${last.content}\n\n${zone3Text}`,
    };
  } else if (Array.isArray(last.content)) {
    const blocks: PiContentBlock[] = [...last.content, { type: "text", text: `\n\n${zone3Text}` }];
    out[lastIdx] = {
      ...last,
      content: blocks,
    };
  }

  return out;
}

/** Extract plain text from the last N messages for lore/foresight recall. */
export function extractRecentMessagesText(messages: PiMessage[], depth = 4): string {
  const slice = messages.slice(-Math.max(1, depth));
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
