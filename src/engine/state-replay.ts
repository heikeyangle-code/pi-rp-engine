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
  PhysicalSnapshot,
  PiMessage,
  PiSessionEntry,
  RpTxEntry,
  SessionRpState,
  TxAuditRecord,
} from "../types.js";
import { computeCheckedStatValue, normalizeCfsmAxisDef } from "./cfsm.js";
import { evaluateGate } from "./gates.js";
import { canonicalizeActorName, canonicalizePairBondActors, sanitizeNpcList } from "./entity-hygiene.js";

export const RP_ENTRY_TYPE = "rp:tx";
const MAX_AUDIT_LOG = 24;

const auditSeqMap = new WeakMap<SessionRpState, number>();

function nextAuditSeq(state: SessionRpState): number {
  const next = (auditSeqMap.get(state) ?? 0) + 1;
  auditSeqMap.set(state, next);
  return next;
}


/**
 * Deterministic Cascade Engine:
 * Automatically promotes armed Storylets whose gate conditions just became satisfied
 * without spending any extra LLM tokens.
 */
function getHygieneCtx(state: SessionRpState) {
  const known = new Set<string>();
  for (const c of state.activeCharacters) if (c.trim()) known.add(c.trim());
  for (const a of Object.keys(state.voiceAnchors)) if (a.trim()) known.add(a.trim());
  for (const a of Object.keys(state.cfsmDefs)) if (a.trim()) known.add(a.trim());
  for (const a of Object.keys(state.cfsmStates)) if (a.trim()) known.add(a.trim());
  return {
    knownCharacterNames: known,
    personaName: state.currentPersona?.name,
  };
}

function runStoryletCascade(state: SessionRpState, recordAudit: boolean): void {
  for (const [id, st] of state.storylets.entries()) {
    if (st.status !== "armed") continue;
    if (!st.gate) continue;
    if (evaluateGate(st.gate, state)) {
      state.storylets.set(id, { ...st, status: "triggered" });
      if (recordAudit) {
        pushAudit(state, {
          summary: `🎬 剧情解锁: ${st.title}`,
          source: "system",
        });
      }
    }
  }
}

function isUndoTx(tx: RpTxEntry): boolean {
  const rec = tx as { reason?: string; note?: string };
  return rec.reason === "undo" || rec.note === "undo";
}

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
    initialLocation: "",
    voiceAnchors: {},
    physicalState: {},
    spatialNotes: "",
    npcAgendas: {},
    pairBonds: {},
    auditLog: [],
    antiGodmoding: true,
    sceneTension: 3,
    slopCounts: {},
    conditions: {},
    lastRoll: null,
  };
}

function resetWorldStateInPlace(state: SessionRpState): void {
  const fresh = createInitialRpState();
  Object.assign(state, fresh);
  auditSeqMap.set(state, 0);
}

function pushAudit(state: SessionRpState, rec: Omit<TxAuditRecord, "id" | "turn">): void {
  state.auditLog.push({
    id: `tx_${state.turn}_${nextAuditSeq(state)}`,
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
        state.personaChangedMidSession = false;
      } else if (state.initialPersona) {
        const isOriginal =
          state.initialPersona.id === tx.persona.id &&
          state.initialPersona.name === tx.persona.name &&
          state.initialPersona.description === tx.persona.description;
        state.personaChangedMidSession = !isOriginal;
      } else if (state.initialPersona === null && state.turn > 0) {
        state.initialPersona = { ...state.currentPersona };
        const isOriginal =
          state.initialPersona.id === tx.persona.id &&
          state.initialPersona.name === tx.persona.name &&
          state.initialPersona.description === tx.persona.description;
        state.personaChangedMidSession = !isOriginal;
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
        for (const ag of Object.values(state.npcAgendas)) {
          if (typeof ag.etaTurns === "number" && ag.etaTurns > 0) {
            ag.etaTurns = Math.max(0, ag.etaTurns - 1);
            if (ag.etaTurns === 0) {
              state.lastMeaningfulProgressTurn = state.turn;
              pushAudit(state, {
                summary: `🕸 幕后日程达成: ${ag.actorId}「${ag.goal.slice(0, 22)}」`,
                source: "system",
              });
            }
          }
        }
        // Auto-tick & expire timed conditions (Buff/Debuff)
        for (const [cid, cond] of Object.entries(state.conditions)) {
          if (cond.remainingTurns !== null) {
            const nextRem = cond.remainingTurns - 1;
            if (nextRem <= 0) {
              delete state.conditions[cid];
              pushAudit(state, {
                summary: `✨ 状态解除: ${cond.actorId}·${cond.label}`,
                source: "system",
              });
            } else {
              state.conditions[cid] = { ...cond, remainingTurns: nextRem };
            }
          }
        }
      }
      if (tx.dayDelta) state.day += tx.dayDelta;
      if (tx.worldTimeLabel !== undefined) state.worldTimeLabel = tx.worldTimeLabel;
      else if (tx.dayDelta) state.worldTimeLabel = `第 ${state.day} 天`;
      if (tx.phase !== undefined) state.phase = tx.phase;
      if (tx.beatDelta > 0) runStoryletCascade(state, true);
      break;

    case "location_set": {
      const prevLoc = state.location;
      const prevNpcs = [...state.presentNpcs];
      if (!state.initialLocation && tx.location.trim()) {
        state.initialLocation = tx.location.trim();
      }
      state.location = tx.location;
      state.presentNpcs = sanitizeNpcList(tx.presentNpcs, getHygieneCtx(state));
      if (!isUndoTx(tx) && (prevLoc !== tx.location || prevNpcs.join("|") !== tx.presentNpcs.join("|"))) {
        const isInitialHydration = state.turn === 0 && !prevLoc && prevNpcs.length === 0;
        if (!isInitialHydration) {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `地点: ${tx.location || "(空)"}${tx.presentNpcs.length ? ` [${tx.presentNpcs.join("、")}]` : ""}`,
            source: "tool",
            undoTx: { kind: "location_set", location: prevLoc, presentNpcs: prevNpcs, reason: "undo" } as RpTxEntry,
          });
          runStoryletCascade(state, true);
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
      if (!isUndoTx(tx) && prev !== tx.value) {
        if (!(state.turn === 0 && !hadPrev)) {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `Flag ${tx.flag} = ${tx.value ? "开" : "关"}`,
            source: "tool",
            undoTx: { kind: "flag_set", flag: tx.flag, value: prev, reason: "undo" } as RpTxEntry,
          });
          runStoryletCascade(state, true);
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
      if (!isUndoTx(tx)) {
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
        if (src !== "system" && !isUndoTx(tx)) {
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
          // Vital threshold auto-condition cascade (HP/SAN <= 20% max -> auto-attach condition; > 30% -> auto-clear)
          const bounds = state.statBounds[tx.actorId]?.[tx.key];
          if (typeof checked.clampedValue === "number" && bounds?.max && bounds.max > 0) {
            const isHp = /^(?:hp|生命|生命值|血量|体力|体力值)$/i.test(tx.key);
            const isSan = /^(?:san|理智|理智值|精神|精神值)$/i.test(tx.key);
            if (isHp || isSan) {
              const condLabel = isHp ? "重伤濒危" : "理智动摇";
              const condId = `${tx.actorId.toLowerCase()}::${condLabel}`;
              const ratio = checked.clampedValue / bounds.max;
              if (ratio <= 0.2 && !state.conditions[condId]) {
                state.conditions[condId] = {
                  id: condId,
                  actorId: tx.actorId,
                  label: condLabel,
                  effect: `${tx.key} 跌破警戒线 (${checked.clampedValue}/${bounds.max})`,
                  remainingTurns: null,
                  appliedTurn: state.turn,
                };
                pushAudit(state, { summary: `⚡ 危机触发: ${tx.actorId}·${condLabel}`, source: "system" });
              } else if (ratio > 0.3 && state.conditions[condId]) {
                delete state.conditions[condId];
                pushAudit(state, { summary: `✨ 危机解除: ${tx.actorId}·${condLabel}`, source: "system" });
              }
            }
          }
          runStoryletCascade(state, true);
        }
      }
      break;
    }

    case "inventory_patch": {
      if (!state.inventory[tx.actorId]) state.inventory[tx.actorId] = {};
      const prevVal = state.inventory[tx.actorId]![tx.item] ?? 0;
      const nextVal = Math.max(0, prevVal + tx.delta);
      const appliedDelta = nextVal - prevVal;
      if (nextVal <= 0) {
        delete state.inventory[tx.actorId]![tx.item];
      } else {
        state.inventory[tx.actorId]![tx.item] = nextVal;
      }
      const src = inferSourceFromReason(tx.note);
      if (src !== "system" && !isUndoTx(tx) && appliedDelta !== 0) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `物品 ${tx.actorId}·${tx.item} ${appliedDelta > 0 ? `+${appliedDelta}` : appliedDelta}`,
          source: src,
          undoTx: { kind: "inventory_patch", actorId: tx.actorId, item: tx.item, delta: -appliedDelta, note: "undo" },
        });
      }
      break;
    }

    case "progress_clock": {
      const prev = state.clocks[tx.clockId];
      const prevVal = prev?.value ?? 0;
      const wasCompleted = Boolean(prev?.completed);
      const max = tx.max > 0 ? tx.max : prev?.max ?? 4;
      const val = Math.min(max, Math.max(0, prevVal + tx.delta));
      const appliedDelta = val - prevVal;
      const nowCompleted = tx.completed ?? val >= max;
      const onComplete = tx.onComplete ?? prev?.onComplete;
      const label = tx.label || prev?.label || tx.clockId;
      state.clocks[tx.clockId] = {
        clockId: tx.clockId,
        label,
        value: val,
        max,
        completed: nowCompleted,
        ...(onComplete ? { onComplete } : {}),
      };
      if (!isUndoTx(tx) && appliedDelta !== 0 && !(state.turn === 0 && !prev)) {
        state.lastMeaningfulProgressTurn = state.turn;
        const cascadeNotes: string[] = [];
        if (!wasCompleted && nowCompleted) {
          if (onComplete?.setFlags) {
            for (const [fKey, fVal] of Object.entries(onComplete.setFlags)) {
              state.flags[fKey] = Boolean(fVal);
              cascadeNotes.push(`🚩${fKey}=${fVal ? "开" : "关"}`);
            }
          }
          if (onComplete?.triggerStoryletId) {
            const st = state.storylets.get(onComplete.triggerStoryletId);
            if (st && st.status === "armed") {
              state.storylets.set(st.id, { ...st, status: "triggered" });
              cascadeNotes.push(`🎬${st.title}`);
            }
          }
          for (const hook of state.foresights.values()) {
            if (hook.status === "open" && hook.dueClockId === tx.clockId) {
              cascadeNotes.push(`⚠伏笔到期:${hook.summary.slice(0, 16)}`);
            }
          }
          if (onComplete?.note) {
            cascadeNotes.push(onComplete.note);
          }
        }
        const suffix = cascadeNotes.length > 0 ? ` → ${cascadeNotes.join(" · ")}` : "";
        pushAudit(state, {
          summary: `时钟 ${label} ${val}/${max}${nowCompleted && !wasCompleted ? " 满格" : ""}${suffix}`,
          source: "tool",
          undoTx: {
            kind: "progress_clock",
            clockId: tx.clockId,
            label,
            delta: -appliedDelta,
            max,
            completed: wasCompleted,
            onComplete,
            reason: "undo",
          } as RpTxEntry,
        });
        if (!wasCompleted && nowCompleted) {
          runStoryletCascade(state, true);
        }
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
      if (!isUndoTx(tx) && !stamped.id.startsWith("fact_init_")) {
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
        if (!isUndoTx(tx)) {
          state.lastMeaningfulProgressTurn = state.turn;
          pushAudit(state, {
            summary: `失效事实 ${existing.statement.slice(0, 30)}`,
            source: inferSourceFromReason(tx.reason),
            undoTx: {
              kind: "fact_add",
              fact: { ...existing, validUntilTurn: null, supersededBy: undefined },
              reason: "undo",
            } as RpTxEntry,
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
      if (!isUndoTx(tx) && !id.startsWith("belief_init_")) {
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
        if (!isUndoTx(tx)) {
          state.lastMeaningfulProgressTurn = state.turn;
        }
        const pe = nextStorylet.postEffects;
        if (pe?.setFlags) {
          for (const [flag, val] of Object.entries(pe.setFlags)) {
            state.flags[flag] = val;
          }
        }
        if (pe?.nextObjective && pe.nextObjective.trim()) {
          state.sceneObjective = pe.nextObjective.trim();
        }
        if (nextStorylet.title.trim()) {
          state.milestones.add(nextStorylet.title.trim());
        }
        if (!isUndoTx(tx)) {
          pushAudit(state, {
            summary: `剧情卡完成: ${nextStorylet.title}`,
            source: "sidecar",
            undoTx: prevStorylet
              ? ({ kind: "storylet_upsert", storylet: prevStorylet, reason: "undo" } as RpTxEntry)
              : undefined,
          });
          runStoryletCascade(state, true);
        }
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
      if (tx.hook.status === "paid_off" && prevHook?.status !== "paid_off" && !isUndoTx(tx)) {
        const ms = tx.hook.summary.trim().slice(0, 32);
        if (ms) state.milestones.add(ms);
        pushAudit(state, { summary: `🔖 伏笔回收: ${tx.hook.summary.slice(0, 28)}`, source: "tool" });
        runStoryletCascade(state, true);
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

    case "voice_anchor_upsert": {
      const actor = tx.anchor.actorId.trim();
      if (!actor) break;
      state.voiceAnchors[actor] = {
        actorId: actor,
        speechSamples: tx.anchor.speechSamples.map((x) => x.trim()).filter(Boolean).slice(0, 4),
        backbone: tx.anchor.backbone.trim(),
        tabooBehaviors: tx.anchor.tabooBehaviors?.trim() || undefined,
      };
      break;
    }

    case "voice_anchor_delete":
      delete state.voiceAnchors[tx.actorId];
      break;

    case "physical_patch": {
      const actor = tx.snapshot.actorId.trim();
      if (actor) {
        const prev = state.physicalState[actor] ? { ...state.physicalState[actor]! } : undefined;
        const prevSpatial = state.spatialNotes;
        const cleanedSnapshot: Partial<PhysicalSnapshot> = {};
        for (const [k, v] of Object.entries(tx.snapshot)) {
          if (v !== undefined) {
            (cleanedSnapshot as Record<string, unknown>)[k] = v;
          }
        }
        const merged: PhysicalSnapshot = {
          ...(prev ?? { actorId: actor, updatedTurn: state.turn }),
          ...cleanedSnapshot,
          actorId: actor,
          updatedTurn: tx.snapshot.updatedTurn ?? state.turn,
        };
        state.physicalState[actor] = merged;
        if (tx.spatialNotes !== undefined) state.spatialNotes = tx.spatialNotes.trim();
        if (!isUndoTx(tx)) {
          const details = [merged.attire, merged.condition, merged.holding, merged.position].filter(Boolean).join(" / ");
          pushAudit(state, {
            summary: `状态外貌 ${actor}: ${details.slice(0, 42) || "更新"}`,
            source: inferSourceFromReason(tx.reason),
            undoTx: prev
              ? { kind: "physical_patch", snapshot: prev, spatialNotes: prevSpatial, reason: "undo" }
              : undefined,
          });
        }
      } else if (tx.spatialNotes !== undefined) {
        state.spatialNotes = tx.spatialNotes.trim();
      }
      break;
    }

    case "agenda_upsert": {
      const actor = canonicalizeActorName(tx.agenda.actorId, getHygieneCtx(state));
      if (!actor || actor === "player") break;
      const prev = state.npcAgendas[actor] ? { ...state.npcAgendas[actor]! } : undefined;
      state.npcAgendas[actor] = { ...tx.agenda, actorId: actor };
      if (!isUndoTx(tx)) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `日程 ${actor}: ${tx.agenda.currentActivity.slice(0, 32)}`,
          source: "sidecar",
          undoTx: prev
            ? ({ kind: "agenda_upsert", agenda: prev, reason: "undo" } as RpTxEntry)
            : { kind: "agenda_delete", actorId: actor },
        });
      }
      break;
    }

    case "agenda_delete":
      delete state.npcAgendas[tx.actorId];
      break;

    case "pair_bond_upsert": {
      const canon = canonicalizePairBondActors(tx.bond.actorA, tx.bond.actorB, getHygieneCtx(state));
      if (!canon) break;
      const { id, actorA, actorB } = canon;
      const prev = state.pairBonds[id] ? { ...state.pairBonds[id]! } : undefined;
      const tension = Math.max(-100, Math.min(100, Math.round(tx.bond.tension)));
      state.pairBonds[id] = { ...tx.bond, id, actorA, actorB, tension };
      if (!isUndoTx(tx)) {
        state.lastMeaningfulProgressTurn = state.turn;
        const bondEffects: string[] = [];
        const riftFlag = `关系破裂:${actorA}↔${actorB}`;
        const alliesFlag = `深度羁绊:${actorA}↔${actorB}`;
        if (tension <= -60 && !state.flags[riftFlag]) {
          state.flags[riftFlag] = true;
          state.flags[alliesFlag] = false;
          bondEffects.push(`🚩${riftFlag}`);
        } else if (tension >= 60 && !state.flags[alliesFlag]) {
          state.flags[alliesFlag] = true;
          state.flags[riftFlag] = false;
          bondEffects.push(`🚩${alliesFlag}`);
        }
        pushAudit(state, {
          summary: `关系 ${actorA}↔${actorB}: ${tx.bond.stance} (${tension})${bondEffects.length ? ` → ${bondEffects.join(" ")}` : ""}`,
          source: "sidecar",
          undoTx: prev
            ? ({ kind: "pair_bond_upsert", bond: prev, reason: "undo" } as RpTxEntry)
            : { kind: "pair_bond_delete", id },
        });
        if (bondEffects.length > 0) runStoryletCascade(state, true);
      }
      break;
    }

    case "pair_bond_delete":
      delete state.pairBonds[tx.id];
      break;

    case "lore_runtime":
      state.loreSticky = { ...tx.sticky };
      state.loreCooldown = { ...tx.cooldown };
      state.loreConsumedOneShots = new Set(tx.consumedOneShots);
      break;

    case "anti_godmoding_set":
      state.antiGodmoding = Boolean(tx.enabled);
      break;

    case "tension_set":
      if (typeof tx.value === "number" && Number.isFinite(tx.value)) {
        state.sceneTension = Math.max(0, Math.min(10, Math.round(tx.value)));
      }
      break;

    case "condition_upsert": {
      const id = tx.condition.id.trim();
      if (!id) break;
      const prev = state.conditions[id] ? { ...state.conditions[id]! } : undefined;
      state.conditions[id] = { ...tx.condition, id };
      if (!isUndoTx(tx)) {
        state.lastMeaningfulProgressTurn = state.turn;
        const ttl = tx.condition.remainingTurns !== null ? `(${tx.condition.remainingTurns}轮)` : "";
        pushAudit(state, {
          summary: `⚡ 状态 ${tx.condition.actorId}·${tx.condition.label}${ttl}`,
          source: "tool",
          undoTx: prev
            ? ({ kind: "condition_upsert", condition: prev, reason: "undo" } as RpTxEntry)
            : ({ kind: "condition_remove", id, reason: "undo" } as RpTxEntry),
        });
      }
      break;
    }

    case "condition_remove": {
      const prev = state.conditions[tx.id] ? { ...state.conditions[tx.id]! } : undefined;
      if (!prev) break;
      delete state.conditions[tx.id];
      if (!isUndoTx(tx)) {
        state.lastMeaningfulProgressTurn = state.turn;
        pushAudit(state, {
          summary: `✨ 解除状态 ${prev.actorId}·${prev.label}`,
          source: "tool",
          undoTx: { kind: "condition_upsert", condition: prev, reason: "undo" } as RpTxEntry,
        });
      }
      break;
    }

    case "roll_record": {
      state.lastRoll = { ...tx.roll, rolls: [...tx.roll.rolls], keptRolls: [...tx.roll.keptRolls] };
      if (!isUndoTx(tx)) {
        if (tx.roll.critical === "nat_min") {
          state.sceneTension = Math.min(10, (state.sceneTension ?? 3) + 2);
        } else if (tx.roll.critical === "nat_max") {
          state.sceneTension = Math.min(10, (state.sceneTension ?? 3) + 1);
        }
        const badge =
          tx.roll.critical === "nat_max"
            ? "大成功★"
            : tx.roll.critical === "nat_min"
              ? "大失败✖"
              : tx.roll.success === true
                ? "成功✓"
                : tx.roll.success === false
                  ? "失败✗"
                  : "";
        pushAudit(state, {
          summary: `🎲 检定 ${tx.roll.expression}→${tx.roll.total}${tx.roll.dc !== undefined ? `/DC${tx.roll.dc}` : ""}${badge ? ` ${badge}` : ""}${tx.roll.reason ? ` (${tx.roll.reason.slice(0, 16)})` : ""}`,
          source: tx.roll.source === "manual" ? "user" : "tool",
        });
      }
      break;
    }
  }
}

/**
 * Deterministically replay the full L1 world state strictly from THIS session's branch.
 * NEVER auto-activates from project-level config! Only explicit `bind` in this branch activates RP mode.
 */
export function replayBranchState(branch: PiSessionEntry[]): SessionRpState {
  const state = createInitialRpState();
  auditSeqMap.set(state, 0);

  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== RP_ENTRY_TYPE) continue;
    const data = entry.data as RpTxEntry | undefined;
    if (!data || typeof data !== "object" || typeof data.kind !== "string") continue;
    applyRpTx(state, data);
  }

  return state;
}
