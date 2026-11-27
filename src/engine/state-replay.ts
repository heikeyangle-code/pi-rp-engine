/**
 * 100% Session-Only Deterministic Event Sourcing Replay for Pi Session Tree (JSONL DAG).
 *
 * Strict Lifecycle Guarantees:
 *  1. ZERO cross-session pollution: RP mode ONLY activates inside a session whose branch
 *     contains an explicit active `rp:tx` `bind` event. Other sessions in the same project
 *     or directory stay 100% dormant (0 tokens, 0 tools changed, 0 UI).
 *  2. Clean re-bind: binding a card cleanly resets all transient world state so nothing leaks
 *     from a previous character/story in the same session.
 *  3. Complete exit: `unbind` resets ALL RP state fields back to a pristine dormant state.
 *  4. Tree rewind/fork: replaying `ctx.sessionManager.getBranch()` restores 100% of stats,
 *     inventory, CFSM, eras, bi-temporal facts, beliefs, foresights, sticky/cooldown, notes,
 *     lore overrides, and hidden floors deterministically.
 */

import * as crypto from "node:crypto";
import type {
  PersonaProfile,
  PiMessage,
  PiSessionEntry,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { computeCheckedStatValue } from "./cfsm.js";

export const RP_ENTRY_TYPE = "rp:tx";

const DEFAULT_PERSONA: PersonaProfile = {
  id: "default",
  name: "旅人",
  description: "",
};

/** Compute a deterministic fingerprint for a PiMessage so `/rp hide` works on AgentMessage[] without entryId. */
export function computeMessageFingerprint(msg: Pick<PiMessage, "role" | "content" | "timestamp">): string {
  const text =
    typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
            .map((b) => b.text)
            .join("")
        : "";
  const head = text.trim().slice(0, 160);
  const ts = typeof msg.timestamp === "number" ? String(msg.timestamp) : "";
  return crypto.createHash("sha1").update(`${msg.role}|${ts}|${head}`).digest("hex").slice(0, 16);
}

export function createInitialRpState(): SessionRpState {
  return {
    active: false,
    cardId: null,
    cardSlug: null,
    cardSource: null,
    worldDir: null,
    greetingIndex: 0,
    activeCharacters: [],
    presetId: null,
    rawPassthrough: false,
    hudMode: "minimal",
    settlementMode: "tool-assisted",
    pacingMode: "balanced",
    loreTokenBudget: 1800,
    sidecarModel: undefined,
    initialPersona: null,
    currentPersona: { ...DEFAULT_PERSONA },
    personaChangedMidSession: false,
    turn: 0,
    beat: 0,
    day: 1,
    worldTimeLabel: "Day 1",
    phase: "opening",
    era: "Act I",
    milestones: new Set<string>(),
    flags: {},
    location: "",
    presentNpcs: [],
    stats: {},
    statBounds: {},
    inventory: {},
    cfsmDefs: {},
    cfsmStates: {},
    clocks: {},
    facts: new Map(),
    beliefs: [],
    foresights: new Map(),
    notes: [],
    hiddenEntryIds: new Set<string>(),
    hiddenFingerprints: new Set<string>(),
    loreOverrides: {},
    loreSticky: {},
    loreCooldown: {},
    loreConsumedOneShots: new Set<string>(),
  };
}

function resetWorldStateInPlace(state: SessionRpState): void {
  const fresh = createInitialRpState();
  Object.assign(state, fresh);
}

export function applyRpTx(state: SessionRpState, tx: RpTxEntry): void {
  switch (tx.kind) {
    case "bind": {
      // Clean reset of prior story state before binding new card
      const prevPersona = state.initialPersona ?? (state.currentPersona.id !== "default" ? state.currentPersona : null);
      resetWorldStateInPlace(state);
      state.active = true;
      state.cardId = tx.cardId;
      state.cardSlug = tx.cardSlug;
      state.cardSource = tx.cardSource;
      state.worldDir = tx.worldDir;
      state.greetingIndex = tx.greetingIndex;
      state.activeCharacters = [...tx.activeCharacters];
      if (tx.presetId !== undefined) state.presetId = tx.presetId;
      if (tx.rawPassthrough !== undefined) state.rawPassthrough = tx.rawPassthrough;
      const chosenPersona = tx.persona ?? prevPersona;
      if (chosenPersona) {
        state.initialPersona = { ...chosenPersona };
        state.currentPersona = { ...chosenPersona };
      }
      break;
    }

    case "unbind":
      // Complete exit: wipe every trace of RP state so session returns to 100% pure dormant state
      resetWorldStateInPlace(state);
      break;

    case "preset_set":
      state.presetId = tx.presetId;
      break;

    case "config_patch":
      if (tx.hudMode !== undefined) state.hudMode = tx.hudMode;
      if (tx.settlementMode !== undefined) state.settlementMode = tx.settlementMode;
      if (tx.pacingMode !== undefined) state.pacingMode = tx.pacingMode;
      if (tx.rawPassthrough !== undefined) state.rawPassthrough = tx.rawPassthrough;
      if (tx.loreTokenBudget !== undefined) state.loreTokenBudget = tx.loreTokenBudget;
      if (tx.sidecarModel !== undefined) state.sidecarModel = tx.sidecarModel;
      break;

    case "persona_set":
      if (state.initialPersona === null && state.turn === 0) {
        state.initialPersona = { ...tx.persona };
      } else if (
        state.initialPersona &&
        (state.initialPersona.name !== tx.persona.name ||
          state.initialPersona.description !== tx.persona.description)
      ) {
        state.personaChangedMidSession = true;
      } else if (state.initialPersona === null && state.turn > 0) {
        state.initialPersona = { ...state.currentPersona };
        state.personaChangedMidSession = true;
      }
      state.currentPersona = { ...tx.persona };
      break;

    case "note_set": {
      const idx = state.notes.findIndex((n) => n.id === tx.note.id);
      if (idx >= 0) {
        state.notes[idx] = { ...tx.note };
      } else {
        state.notes.push({ ...tx.note });
      }
      break;
    }

    case "note_clear":
      if (tx.noteId) {
        state.notes = state.notes.filter((n) => n.id !== tx.noteId);
      } else {
        state.notes = [];
      }
      break;

    case "hide_toggle":
      for (const id of tx.entryIds) {
        if (tx.hidden) state.hiddenEntryIds.add(id);
        else state.hiddenEntryIds.delete(id);
      }
      for (const fp of tx.fingerprints ?? []) {
        if (tx.hidden) state.hiddenFingerprints.add(fp);
        else state.hiddenFingerprints.delete(fp);
      }
      break;

    case "cast_set":
      state.activeCharacters = [...tx.slugs];
      break;

    case "lore_toggle":
      state.loreOverrides[tx.entryId] = tx.enabled;
      break;

    case "clock_tick":
      state.turn += 1;
      state.beat += tx.beatDelta;
      if (tx.dayDelta) state.day += tx.dayDelta;
      if (tx.worldTimeLabel !== undefined) state.worldTimeLabel = tx.worldTimeLabel;
      else if (tx.dayDelta) state.worldTimeLabel = `Day ${state.day}`;
      if (tx.phase !== undefined) state.phase = tx.phase;
      state.notes = state.notes
        .map((n) => (n.remainingTurns === null ? n : { ...n, remainingTurns: n.remainingTurns - 1 }))
        .filter((n) => n.remainingTurns === null || n.remainingTurns > 0);
      break;

    case "location_set":
      state.location = tx.location;
      state.presentNpcs = [...tx.presentNpcs];
      break;

    case "flag_set":
      state.flags[tx.flag] = tx.value;
      break;

    case "cfsm_define":
      if (!state.cfsmDefs[tx.actorId]) state.cfsmDefs[tx.actorId] = {};
      state.cfsmDefs[tx.actorId]![tx.def.axis] = { ...tx.def };
      if (!state.cfsmStates[tx.actorId]) state.cfsmStates[tx.actorId] = {};
      if (!state.cfsmStates[tx.actorId]![tx.def.axis]) {
        state.cfsmStates[tx.actorId]![tx.def.axis] = {
          actorId: tx.actorId,
          axis: tx.def.axis,
          state: tx.def.initial,
          updatedTurn: state.turn,
        };
      }
      break;

    case "cfsm_transition":
      if (!state.cfsmStates[tx.actorId]) state.cfsmStates[tx.actorId] = {};
      state.cfsmStates[tx.actorId]![tx.axis] = {
        actorId: tx.actorId,
        axis: tx.axis,
        state: tx.to,
        updatedTurn: tx.turn,
        reason: tx.reason,
      };
      break;

    case "stat_patch": {
      if (!state.stats[tx.actorId]) state.stats[tx.actorId] = {};
      if (tx.min !== undefined || tx.max !== undefined) {
        if (!state.statBounds[tx.actorId]) state.statBounds[tx.actorId] = {};
        state.statBounds[tx.actorId]![tx.key] = {
          min: tx.min ?? state.statBounds[tx.actorId]![tx.key]?.min,
          max: tx.max ?? state.statBounds[tx.actorId]![tx.key]?.max,
        };
      }
      const checked = computeCheckedStatValue(state, tx.actorId, tx.key, tx.op, tx.value, tx.min, tx.max);
      if (checked.ok && checked.clampedValue !== undefined) {
        state.stats[tx.actorId]![tx.key] = checked.clampedValue;
      }
      break;
    }

    case "inventory_patch": {
      if (!state.inventory[tx.actorId]) state.inventory[tx.actorId] = {};
      const next = (state.inventory[tx.actorId]![tx.item] ?? 0) + tx.delta;
      if (next <= 0) {
        delete state.inventory[tx.actorId]![tx.item];
      } else {
        state.inventory[tx.actorId]![tx.item] = next;
      }
      break;
    }

    case "progress_clock": {
      const prev = state.clocks[tx.clockId];
      const max = tx.max > 0 ? tx.max : prev?.max ?? 4;
      const val = Math.min(max, Math.max(0, (prev?.value ?? 0) + tx.delta));
      state.clocks[tx.clockId] = {
        clockId: tx.clockId,
        label: tx.label || prev?.label || tx.clockId,
        value: val,
        max,
        completed: tx.completed ?? val >= max,
      };
      break;
    }

    case "fact_add":
      state.facts.set(tx.fact.id, { ...tx.fact, entities: [...tx.fact.entities] });
      break;

    case "fact_invalidate": {
      const existing = state.facts.get(tx.factId);
      if (existing) {
        state.facts.set(tx.factId, {
          ...existing,
          validUntilTurn: tx.validUntilTurn,
          supersededBy: tx.supersededBy,
        });
      }
      break;
    }

    case "belief_update":
      state.beliefs.push({
        actorId: tx.actorId,
        target: tx.target,
        activatingEvent: tx.activatingEvent,
        belief: tx.belief,
        turn: tx.turn,
      });
      break;

    case "foresight_upsert":
      state.foresights.set(tx.hook.id, { ...tx.hook, entities: [...tx.hook.entities] });
      break;

    case "era_advance":
      state.era = tx.toEra;
      for (const m of tx.milestoneUnlocked) {
        state.milestones.add(m);
      }
      break;

    case "lore_runtime":
      state.loreSticky = { ...tx.sticky };
      state.loreCooldown = { ...tx.cooldown };
      state.loreConsumedOneShots = new Set(tx.consumedOneShots);
      break;
  }
}

/**
 * Deterministically replay the full L1 world state strictly from THIS session's branch.
 * NEVER auto-activates from project-level config! Only explicit `bind` in this branch activates RP mode.
 */
export function replayBranchState(branch: PiSessionEntry[]): SessionRpState {
  const state = createInitialRpState();

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== RP_ENTRY_TYPE) continue;
    const data = entry.data as RpTxEntry | undefined;
    if (!data || typeof data !== "object" || typeof data.kind !== "string") continue;
    applyRpTx(state, data);
  }

  return state;
}
