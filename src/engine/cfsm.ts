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

export function validateCfsmTransition(
  state: SessionRpState,
  actorId: string,
  axis: string,
  to: string,
): ValidationResult {
  const def: CfsmAxisDef | undefined = state.cfsmDefs[actorId]?.[axis];
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
  const current = state.cfsmStates[actorId]?.[axis]?.state ?? def.initial;
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
