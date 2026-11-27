/**
 * Deterministic Event Sourcing Replay for Pi Session Tree (JSONL DAG).
 *
 * Scanning `ctx.sessionManager.getBranch()` and replaying `rp:tx` / `rp:bind` / `rp:persona` /
 * `rp:note` / `rp:hide` / `rp:cast` entries guarantees that branching or rewinding in Pi's
 * native Session Tree rolls back 100% of L1 state (stats, inventory, CFSM, eras, bi-temporal
 * facts, foresights, sticky/cooldown lore runtime) with zero desync.
 */

import type {
  PersonaProfile,
  PiSessionEntry,
  ProjectWorldConfig,
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

export function createInitialRpState(): SessionRpState {
  return {
    active: false,
    explicitlyUnbound: false,
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
    loreSticky: {},
    loreCooldown: {},
    loreConsumedOneShots: new Set<string>(),
  };
}

export function applyRpTx(state: SessionRpState, tx: RpTxEntry): void {
  switch (tx.kind) {
    case "bind":
      state.active = true;
      state.explicitlyUnbound = false;
      state.cardId = tx.cardId;
      state.cardSlug = tx.cardSlug;
      state.cardSource = tx.cardSource;
      state.worldDir = tx.worldDir;
      state.greetingIndex = tx.greetingIndex;
      state.activeCharacters = [...tx.activeCharacters];
      if (tx.presetId !== undefined) state.presetId = tx.presetId;
      if (tx.rawPassthrough !== undefined) state.rawPassthrough = tx.rawPassthrough;
      break;

    case "unbind":
      state.active = false;
      state.explicitlyUnbound = true;
      break;

    case "preset_set":
      state.presetId = tx.presetId;
      break;

    case "config_patch":
      if (tx.hudMode !== undefined) state.hudMode = tx.hudMode;
      if (tx.settlementMode !== undefined) state.settlementMode = tx.settlementMode;
      if (tx.rawPassthrough !== undefined) state.rawPassthrough = tx.rawPassthrough;
      if (tx.loreTokenBudget !== undefined) state.loreTokenBudget = tx.loreTokenBudget;
      if (tx.sidecarModel !== undefined) state.sidecarModel = tx.sidecarModel;
      break;

    case "persona_set":
      if (state.initialPersona === null && state.turn === 0) {
        state.initialPersona = { ...tx.persona };
      } else if (state.initialPersona && state.initialPersona.name !== tx.persona.name) {
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
      break;

    case "cast_set":
      state.activeCharacters = [...tx.slugs];
      break;

    case "clock_tick":
      state.turn += 1;
      state.beat += tx.beatDelta;
      if (tx.dayDelta) state.day += tx.dayDelta;
      if (tx.worldTimeLabel !== undefined) state.worldTimeLabel = tx.worldTimeLabel;
      else if (tx.dayDelta) state.worldTimeLabel = `Day ${state.day}`;
      if (tx.phase !== undefined) state.phase = tx.phase;
      // Decrement TTL on temporary director notes
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
 * Deterministically replay the full L1 world state from a Pi session branch.
 * Respects binding priority:
 *  1. Explicit session branch `rp:tx` bind/unbind takes highest precedence.
 *  2. If no explicit bind/unbind on branch, falls back to project `.pi/rp/world.json`.
 *  3. Otherwise stays dormant (`active: false`).
 */
export function replayBranchState(
  branch: PiSessionEntry[],
  projectConfig?: { worldDir: string; config: ProjectWorldConfig } | null,
): SessionRpState {
  const state = createInitialRpState();

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== RP_ENTRY_TYPE) continue;
    const data = entry.data as RpTxEntry | undefined;
    if (!data || typeof data !== "object" || typeof data.kind !== "string") continue;
    applyRpTx(state, data);
  }

  // Fallback to project-level auto-binding when session has no explicit bind or unbind
  if (!state.active && !state.explicitlyUnbound && projectConfig?.config.defaultCardSlug) {
    const cfg = projectConfig.config;
    state.active = true;
    state.cardSlug = cfg.defaultCardSlug;
    state.cardId = cfg.defaultCardSlug;
    state.cardSource = "project";
    state.worldDir = projectConfig.worldDir;
    state.activeCharacters = cfg.activeCharacters ? [...cfg.activeCharacters] : [cfg.defaultCardSlug];
    if (cfg.defaultPresetId) state.presetId = cfg.defaultPresetId;
    if (cfg.rawPassthrough !== undefined) state.rawPassthrough = cfg.rawPassthrough;
    if (cfg.hudMode) state.hudMode = cfg.hudMode;
    if (cfg.settlementMode) state.settlementMode = cfg.settlementMode;
    if (cfg.loreTokenBudget) state.loreTokenBudget = cfg.loreTokenBudget;
  }

  return state;
}
