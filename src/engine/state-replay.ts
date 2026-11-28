/**
 * 100% Session-Only Deterministic Event Sourcing Replay for Pi Session Tree (JSONL DAG).
 *
 * v3 Enhancements:
 *  - Full event-sourced replay for Memory Books (`memory_book_upsert/delete`),
 *    Dynamic Storylets (`storylet_upsert/delete`), Scene Objective (`scene_objective_set`),
 *    Fact updates (`fact_update`), DualMem Beliefs (`belief_update/remove`),
 *    and Inner Monologue / Preset Sampling toggles.
 *  - Automatic CFSM adjacent transition enforcement via `normalizeCfsmAxisDef`.
 *  - Deterministic reversible Audit Log (`state.auditLog`, last 24 records with exact `undoTx`)
 *    so any AI/Sidecar mutation can be reverted with 1 click!
 */

import * as crypto from "node:crypto";
import type {
  PersonaProfile,
  PiMessage,
  PiSessionEntry,
  RpTxEntry,
  SessionRpState,
  TxAuditRecord,
} from "../types.js";
import { computeCheckedStatValue, normalizeCfsmAxisDef } from "./cfsm.js";

export const RP_ENTRY_TYPE = "rp:tx";
const MAX_AUDIT_LOG = 24;

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
    responseLength: "standard",
    narrativePov: "auto",
    bannedPhrases: [],
    loreTokenBudget: 1800,
    sidecarModel: undefined,
    innerMonologue: false,
    applyPresetSampling: false,
    initialPersona: null,
    currentPersona: { ...DEFAULT_PERSONA },
    personaChangedMidSession: false,
    archetype: "companion",
    modules: { stats: true, inventory: true, clocks: true, stages: false },
    turn: 0,
    beat: 0,
    day: 1,
    worldTimeLabel: "",
    phase: "",
    era: "",
    sceneObjective: "",
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
    memoryBooks: new Map(),
    storylets: new Map(),
    foresights: new Map(),
    notes: [],
    hiddenEntryIds: new Set<string>(),
    hiddenFingerprints: new Set<string>(),
    loreOverrides: {},
    loreSticky: {},
    loreCooldown: {},
    loreConsumedOneShots: new Set<string>(),
    lastMeaningfulProgressTurn: 0,
    auditLog: [],
  };
}

function resetWorldStateInPlace(state: SessionRpState): void {
  const fresh = createInitialRpState();
  Object.assign(state, fresh);
}

function pushAudit(state: SessionRpState, rec: Omit<TxAuditRecord, "id" | "turn">): void {
  state.auditLog.push({
    id: `tx_${state.turn}_${state.auditLog.length}`,
    turn: state.turn,
    ...rec,
  });
  if (state.auditLog.length > MAX_AUDIT_LOG) {
    state.auditLog.splice(0, state.auditLog.length - MAX_AUDIT_LOG);
  }
}

function inferSourceFromReason(reason?: string): TxAuditRecord["source"] {
  if (!reason) return "tool";
  if (reason.startsWith("sidecar")) return "sidecar";
  if (reason.startsWith("panel") || reason.startsWith("manual") || reason === "undo") return "user";
  if (reason.startsWith("salvaged") || reason.startsWith("profile") || reason.startsWith("llm_analyze")) return "system";
  return "tool";
}

export function applyRpTx(state: SessionRpState, tx: RpTxEntry): void {
  switch (tx.kind) {
    case "bind": {
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
      resetWorldStateInPlace(state);
      break;

    case "preset_set":
      state.presetId = tx.presetId;
      break;

    case "config_patch":
      if (tx.hudMode !== undefined) state.hudMode = tx.hudMode;
      if (tx.settlementMode !== undefined) state.settlementMode = tx.settlementMode;
      if (tx.pacingMode !== undefined) state.pacingMode = tx.pacingMode;
      if (tx.responseLength !== undefined) state.responseLength = tx.responseLength;
      if (tx.narrativePov !== undefined) state.narrativePov = tx.narrativePov;
      if (tx.bannedPhrases !== undefined) state.bannedPhrases = [...tx.bannedPhrases];
      if (tx.rawPassthrough !== undefined) state.rawPassthrough = tx.rawPassthrough;
      if (tx.loreTokenBudget !== undefined) state.loreTokenBudget = tx.loreTokenBudget;
      if (tx.sidecarModel !== undefined) state.sidecarModel = tx.sidecarModel || undefined;
      if (tx.innerMonologue !== undefined) state.innerMonologue = tx.innerMonologue;
      if (tx.applyPresetSampling !== undefined) state.applyPresetSampling = tx.applyPresetSampling;
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
      if (tx.beatDelta > 0) {
        state.turn += 1;
        state.beat += tx.beatDelta;
        state.notes = state.notes
          .map((n) => (n.remainingTurns === null ? n : { ...n, remainingTurns: n.remainingTurns - 1 }))
          .filter((n) => n.remainingTurns === null || n.remainingTurns > 0);
      }
      if (tx.dayDelta) state.day += tx.dayDelta;
      if (tx.worldTimeLabel !== undefined) state.worldTimeLabel = tx.worldTimeLabel;
      else if (tx.dayDelta) state.worldTimeLabel = `第 ${state.day} 天`;
      if (tx.phase !== undefined) state.phase = tx.phase;
      break;

    case "location_set": {
      const prevLoc = state.location;
      const prevNpcs = [...state.presentNpcs];
      state.location = tx.location;
      state.presentNpcs = [...tx.presentNpcs];
      if (prevLoc !== tx.location || prevNpcs.join("|") !== tx.presentNpcs.join("|")) {
        const isInitialHydration = state.turn === 0 && !prevLoc && prevNpcs.length === 0;
        if (!isInitialHydration) {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `地点: ${tx.location || "(空)"}${tx.presentNpcs.length ? ` [${tx.presentNpcs.join("、")}]` : ""}`,
            source: "tool",
            undoTx: { kind: "location_set", location: prevLoc, presentNpcs: prevNpcs },
          });
        }
      }
      break;
    }

    case "scene_objective_set":
      if (state.sceneObjective !== tx.objective && tx.objective.trim()) {
        state.lastMeaningfulProgressTurn = state.turn;
      }
      state.sceneObjective = tx.objective;
      break;

    case "flag_set": {
      const hadPrev = Object.prototype.hasOwnProperty.call(state.flags, tx.flag);
      const prev = Boolean(state.flags[tx.flag]);
      state.flags[tx.flag] = tx.value;
      if (prev !== tx.value) {
        if (!(state.turn === 0 && !hadPrev)) {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `Flag ${tx.flag} = ${tx.value ? "开" : "关"}`,
            source: "tool",
            undoTx: { kind: "flag_set", flag: tx.flag, value: prev },
          });
        }
      }
      break;
    }

    case "cfsm_define": {
      const normalized = normalizeCfsmAxisDef(tx.def);
      if (!state.cfsmDefs[tx.actorId]) state.cfsmDefs[tx.actorId] = {};
      state.cfsmDefs[tx.actorId]![normalized.axis] = normalized;
      if (!state.cfsmStates[tx.actorId]) state.cfsmStates[tx.actorId] = {};
      if (!state.cfsmStates[tx.actorId]![normalized.axis]) {
        state.cfsmStates[tx.actorId]![normalized.axis] = {
          actorId: tx.actorId,
          axis: normalized.axis,
          state: normalized.initial,
          updatedTurn: state.turn,
        };
      }
      break;
    }

    case "cfsm_transition": {
      if (!state.cfsmStates[tx.actorId]) state.cfsmStates[tx.actorId] = {};
      const prev = state.cfsmStates[tx.actorId]![tx.axis]?.state ?? tx.from;
      state.cfsmStates[tx.actorId]![tx.axis] = {
        actorId: tx.actorId,
        axis: tx.axis,
        state: tx.to,
        updatedTurn: tx.turn,
        reason: tx.reason,
      };
      if (tx.reason !== "undo") {
        if (prev !== tx.to) state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `心态 ${tx.actorId}.${tx.axis}: ${prev} → ${tx.to}`,
          source: inferSourceFromReason(tx.reason),
          undoTx: {
            kind: "cfsm_transition",
            actorId: tx.actorId,
            axis: tx.axis,
            from: tx.to,
            to: prev,
            reason: "undo",
            turn: state.turn,
          },
        });
      }
      break;
    }

    case "stat_patch": {
      if (!state.stats[tx.actorId]) state.stats[tx.actorId] = {};
      const hadPrev = Object.prototype.hasOwnProperty.call(state.stats[tx.actorId]!, tx.key);
      const prevVal = state.stats[tx.actorId]![tx.key];
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
        const src = inferSourceFromReason(tx.reason);
        if (src !== "system" && tx.reason !== "undo") {
          if (!hadPrev || prevVal !== checked.clampedValue) {
            state.lastMeaningfulProgressTurn = state.turn;
          }
          pushAudit(state, {
            summary: `数值 ${tx.actorId}.${tx.key}: ${hadPrev ? String(prevVal) : "∅"} → ${String(checked.clampedValue)}`,
            source: src,
            undoTx: hadPrev
              ? { kind: "stat_patch", actorId: tx.actorId, key: tx.key, op: "set", value: prevVal!, reason: "undo" }
              : undefined,
          });
        }
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
      const src = inferSourceFromReason(tx.note);
      if (src !== "system" && tx.note !== "undo") {
        if (tx.delta !== 0) state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `物品 ${tx.actorId}·${tx.item} ${tx.delta > 0 ? `+${tx.delta}` : tx.delta}`,
          source: src,
          undoTx: { kind: "inventory_patch", actorId: tx.actorId, item: tx.item, delta: -tx.delta, note: "undo" },
        });
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
      if (tx.delta !== 0 && !(state.turn === 0 && !prev)) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `时钟 ${state.clocks[tx.clockId]!.label} ${val}/${max}`,
          source: "tool",
          undoTx: { kind: "progress_clock", clockId: tx.clockId, label: state.clocks[tx.clockId]!.label, delta: -tx.delta, max },
        });
      }
      break;
    }

    case "fact_add": {
      const stamped = {
        ...tx.fact,
        entities: [...tx.fact.entities],
        ingestedAtTurn: tx.fact.ingestedAtTurn ?? state.turn,
        eventTimeLabel: tx.fact.eventTimeLabel ?? (state.worldTimeLabel || undefined),
      };
      state.facts.set(stamped.id, stamped);
      if (!stamped.id.startsWith("fact_init_")) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `+事实 ${stamped.statement.slice(0, 32)}`,
          source: stamped.id.startsWith("fact_manual") ? "user" : "sidecar",
          undoTx: { kind: "fact_invalidate", factId: stamped.id, validUntilTurn: state.turn, reason: "undo" },
        });
      }
      break;
    }

    case "fact_update": {
      const existing = state.facts.get(tx.factId);
      if (existing) {
        state.facts.set(tx.factId, {
          ...existing,
          statement: tx.statement !== undefined ? tx.statement : existing.statement,
          witnessIds: tx.witnessIds !== undefined ? tx.witnessIds : existing.witnessIds,
          entities: tx.entities !== undefined ? [...tx.entities] : existing.entities,
        });
      }
      break;
    }

    case "fact_invalidate": {
      const existing = state.facts.get(tx.factId);
      if (existing) {
        state.facts.set(tx.factId, {
          ...existing,
          validUntilTurn: tx.validUntilTurn,
          supersededBy: tx.supersededBy,
        });
        if (tx.reason !== "undo") {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `失效事实 ${existing.statement.slice(0, 30)}`,
            source: inferSourceFromReason(tx.reason),
            undoTx: { kind: "fact_add", fact: { ...existing, validUntilTurn: null, supersededBy: undefined } },
          });
        }
      }
      break;
    }

    case "belief_update": {
      const id = tx.id ?? `belief_${tx.turn}_${state.beliefs.length}`;
      const existingIdx = state.beliefs.findIndex((b) => b.id && b.id === id);
      const record = {
        id,
        actorId: tx.actorId,
        target: tx.target,
        activatingEvent: tx.activatingEvent,
        belief: tx.belief,
        subjectiveInsight: tx.subjectiveInsight,
        emotionalTone: tx.emotionalTone,
        turn: tx.turn,
      };
      if (existingIdx >= 0) {
        state.beliefs[existingIdx] = record;
      } else {
        state.beliefs.push(record);
      }
      if (!id.startsWith("belief_init_")) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `印象 ${tx.actorId}→${tx.target}: ${tx.belief.slice(0, 26)}`,
          source: "sidecar",
          undoTx: { kind: "belief_remove", id },
        });
      }
      break;
    }

    case "belief_remove": {
      if (tx.id) {
        state.beliefs = state.beliefs.filter((b) => b.id !== tx.id);
      } else if (typeof tx.index === "number" && tx.index >= 0 && tx.index < state.beliefs.length) {
        state.beliefs.splice(tx.index, 1);
      }
      break;
    }

    case "memory_book_upsert":
      state.memoryBooks.set(tx.entry.id, {
        ...tx.entry,
        entities: [...tx.entry.entities],
        keywords: [...tx.entry.keywords],
        turnRange: [tx.entry.turnRange[0], tx.entry.turnRange[1]],
      });
      break;

    case "memory_book_delete":
      state.memoryBooks.delete(tx.entryId);
      break;

    case "storylet_upsert": {
      const prevStorylet = state.storylets.get(tx.storylet.id);
      const nextStorylet = {
        ...tx.storylet,
        postEffects: tx.storylet.postEffects
          ? {
              setFlags: tx.storylet.postEffects.setFlags ? { ...tx.storylet.postEffects.setFlags } : undefined,
              nextObjective: tx.storylet.postEffects.nextObjective,
            }
          : undefined,
      };
      state.storylets.set(nextStorylet.id, nextStorylet);
      // Automatically apply Storylet postconditions upon transitioning into completed
      if (nextStorylet.status === "completed" && prevStorylet?.status !== "completed") {
        state.lastMeaningfulProgressTurn = state.turn;
        const pe = nextStorylet.postEffects;
        if (pe?.setFlags) {
          for (const [flag, val] of Object.entries(pe.setFlags)) {
            state.flags[flag] = val;
          }
        }
        if (pe?.nextObjective && pe.nextObjective.trim()) {
          state.sceneObjective = pe.nextObjective.trim();
        }
        pushAudit(state, {
          summary: `剧情卡完成: ${nextStorylet.title}`,
          source: "sidecar",
          undoTx: prevStorylet ? { kind: "storylet_upsert", storylet: prevStorylet } : undefined,
        });
      }
      break;
    }

    case "storylet_delete":
      state.storylets.delete(tx.storyletId);
      break;

    case "foresight_upsert": {
      const prevHook = state.foresights.get(tx.hook.id);
      state.foresights.set(tx.hook.id, { ...tx.hook, entities: [...tx.hook.entities] });
      if (!tx.hook.id.startsWith("hook_init_") || (prevHook && prevHook.status !== tx.hook.status)) {
        state.lastMeaningfulProgressTurn = state.turn;
      }
      break;
    }

    case "era_advance":
      state.era = tx.toEra;
      state.modules.stages = true;
      state.lastMeaningfulProgressTurn = state.turn;
      for (const m of tx.milestoneUnlocked) {
        state.milestones.add(m);
      }
      break;

    case "profile_apply":
      state.archetype = tx.archetype;
      state.modules = { ...tx.modules };
      if (tx.initialStage && !state.era) state.era = tx.initialStage;
      if (tx.initialTime && !state.worldTimeLabel) state.worldTimeLabel = tx.initialTime;
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
