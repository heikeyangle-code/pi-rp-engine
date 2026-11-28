/**
 * Deterministic CFSM (Codified Finite-State Machine) & numeric/inventory boundary validator.
 * Prevents LLM hallucination from mutating stats out of bounds, creating negative inventory,
 * or jumping across illegal CFSM transition edges.
 */

import type { CfsmAxisDef, SessionRpState } from "../types.js";

export interface ValidationResult {
  ok: boolean;
  error?: string;
  clampedValue?: number | string | boolean;
}

function findCaseInsensitiveKey<T>(obj: Record<string, T> | undefined, target: string): string | undefined {
  if (!obj) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, target)) return target;
  const lower = target.trim().toLowerCase();
  return Object.keys(obj).find((k) => k.trim().toLowerCase() === lower);
}

/**
 * Build default step-by-step bidirectional adjacency transitions for an ordered state list
 * (e.g. ["陌生", "熟悉", "信任", "亲密"] -> each state can only move to adjacent states,
 * preventing 1-turn jumps from "敌对" straight to "死心塌地").
 */
export function buildAdjacentTransitions(states: string[]): Record<string, string[]> {
  const transitions: Record<string, string[]> = {};
  for (let i = 0; i < states.length; i++) {
    const curr = states[i]!;
    const neighbors: string[] = [];
    if (i > 0) neighbors.push(states[i - 1]!);
    if (i + 1 < states.length) neighbors.push(states[i + 1]!);
    transitions[curr] = neighbors;
  }
  return transitions;
}

/** Normalize a CFSM axis definition, auto-generating adjacent transitions if omitted. */
export function normalizeCfsmAxisDef(def: CfsmAxisDef): CfsmAxisDef {
  const uniqueStates = Array.from(new Set(def.states.map((s) => s.trim()).filter(Boolean)));
  const initial = uniqueStates.includes(def.initial) ? def.initial : uniqueStates[0] ?? def.initial;
  const hasExplicitTransitions =
    def.transitions &&
    typeof def.transitions === "object" &&
    Object.keys(def.transitions).length > 0;
  return {
    axis: def.axis.trim(),
    states: uniqueStates,
    initial,
    transitions: hasExplicitTransitions
      ? def.transitions
      : uniqueStates.length >= 2
        ? buildAdjacentTransitions(uniqueStates)
        : undefined,
  };
}

export function validateCfsmTransition(
  state: SessionRpState,
  actorId: string,
  axis: string,
  to: string,
): ValidationResult {
  const defActorKey = findCaseInsensitiveKey(state.cfsmDefs, actorId);
  const defAxisKey = defActorKey ? findCaseInsensitiveKey(state.cfsmDefs[defActorKey], axis) : undefined;
  const def: CfsmAxisDef | undefined =
    defActorKey && defAxisKey ? state.cfsmDefs[defActorKey]?.[defAxisKey] : undefined;
  if (!def) {
    // Ad-hoc axis allowed if no formal schema was registered
    return { ok: true };
  }
  if (!def.states.includes(to)) {
    return {
      ok: false,
      error: `Invalid CFSM state "${to}" for ${actorId}.${axis}; allowed: [${def.states.join(", ")}]`,
    };
  }
  const stateActorKey = findCaseInsensitiveKey(state.cfsmStates, defActorKey!) ?? defActorKey!;
  const stateAxisKey = findCaseInsensitiveKey(state.cfsmStates[stateActorKey], defAxisKey!) ?? defAxisKey!;
  const current = state.cfsmStates[stateActorKey]?.[stateAxisKey]?.state ?? def.initial;
  if (def.transitions) {
    const allowedNext = def.transitions[current] ?? [];
    if (current !== to && !allowedNext.includes(to)) {
      return {
        ok: false,
        error: `Illegal CFSM transition ${actorId}.${axis}: "${current}" -> "${to}" (allowed: [${allowedNext.join(", ")}])`,
      };
    }
  }
  return { ok: true };
}

export function computeCheckedStatValue(
  state: SessionRpState,
  actorId: string,
  key: string,
  op: "set" | "add",
  value: number | string | boolean,
  min?: number,
  max?: number,
): ValidationResult {
  const existingBounds = state.statBounds[actorId]?.[key];
  const effMin = min ?? existingBounds?.min;
  const effMax = max ?? existingBounds?.max;

  if (op === "add") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, error: `stat_patch op="add" requires a finite number for ${actorId}.${key}` };
    }
    const prev = state.stats[actorId]?.[key];
    const base = typeof prev === "number" ? prev : 0;
    let next = base + value;
    if (effMin !== undefined) next = Math.max(effMin, next);
    if (effMax !== undefined) next = Math.min(effMax, next);
    return { ok: true, clampedValue: next };
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, error: `Non-finite numeric value for ${actorId}.${key}` };
    }
    let next = value;
    if (effMin !== undefined) next = Math.max(effMin, next);
    if (effMax !== undefined) next = Math.min(effMax, next);
    return { ok: true, clampedValue: next };
  }

  return { ok: true, clampedValue: value };
}

export function validateInventoryPatch(
  state: SessionRpState,
  actorId: string,
  item: string,
  delta: number,
): ValidationResult {
  if (!item.trim()) {
    return { ok: false, error: "Inventory item name cannot be empty" };
  }
  if (!Number.isInteger(delta) || delta === 0) {
    return { ok: false, error: `Inventory delta must be a non-zero integer, got ${delta}` };
  }
  const current = state.inventory[actorId]?.[item] ?? 0;
  const next = current + delta;
  if (next < 0) {
    return {
      ok: false,
      error: `Insufficient "${item}" for ${actorId}: have ${current}, tried delta ${delta}`,
    };
  }
  return { ok: true, clampedValue: next };
}
