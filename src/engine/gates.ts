/**
 * Physical Era / Milestone Gates (NCP-Bench / TimeChara) & Epistemic Visibility Filter (FANToM).
 * Upgraded with EntityRegistry alias canonicalization so nicknames/epithets never cause false blind spots or secret leaks!
 */

import type { BiTemporalFact, GateCondition, SessionRpState } from "../types.js";
import type { EntityRegistry } from "../memory/entity-registry.js";

export function evaluateGate(
  gate: GateCondition | undefined,
  state: SessionRpState,
  registry?: EntityRegistry,
): boolean {
  if (!gate) return true;

  if (gate.minTurn !== undefined && state.turn < gate.minTurn) {
    return false;
  }
  if (gate.everyNTurns !== undefined && gate.everyNTurns > 0) {
    if (state.turn === 0 || state.turn % gate.everyNTurns !== 0) {
      return false;
    }
  }
  if (gate.requiredEra !== undefined && state.era !== gate.requiredEra) {
    return false;
  }
  if (gate.requiredMilestones && gate.requiredMilestones.length > 0) {
    for (const m of gate.requiredMilestones) {
      if (!state.milestones.has(m) && !state.flags[m]) return false;
    }
  }
  if (gate.requiredFlags && gate.requiredFlags.length > 0) {
    for (const f of gate.requiredFlags) {
      if (!state.flags[f]) return false;
    }
  }
  if (gate.forbiddenFlags && gate.forbiddenFlags.length > 0) {
    for (const f of gate.forbiddenFlags) {
      if (state.flags[f]) return false;
    }
  }
  if (gate.requiredLocations && gate.requiredLocations.length > 0) {
    const loc = state.location.toLowerCase();
    const matched = gate.requiredLocations.some((req) => loc.includes(req.toLowerCase()));
    if (!matched) return false;
  }
  if (gate.requiredNpcPresent && gate.requiredNpcPresent.length > 0) {
    const norm = (n: string) => (registry ? registry.resolveCanonical(n).toLowerCase() : n.toLowerCase());
    const present = new Set(state.presentNpcs.map(norm));
    const allPresent = gate.requiredNpcPresent.every((req) => present.has(norm(req)));
    if (!allPresent) return false;
  }
  if (gate.statChecks && gate.statChecks.length > 0) {
    for (const check of gate.statChecks) {
      const targetKey = check.key.toLowerCase();
      let matchedVal: number | undefined;
      if (check.actorId) {
        const targetActor = registry
          ? registry.resolveCanonical(check.actorId).toLowerCase()
          : check.actorId.toLowerCase();
        for (const [actor, stats] of Object.entries(state.stats)) {
          const actorNorm = registry ? registry.resolveCanonical(actor).toLowerCase() : actor.toLowerCase();
          if (actorNorm !== targetActor && actor.toLowerCase() !== check.actorId.toLowerCase()) continue;
          for (const [k, v] of Object.entries(stats)) {
            if (k.toLowerCase() === targetKey && typeof v === "number") {
              matchedVal = v;
              break;
            }
          }
          if (matchedVal !== undefined) break;
        }
      } else {
        for (const stats of Object.values(state.stats)) {
          for (const [k, v] of Object.entries(stats)) {
            if (k.toLowerCase() === targetKey && typeof v === "number") {
              matchedVal = v;
              break;
            }
          }
          if (matchedVal !== undefined) break;
        }
      }
      if (matchedVal === undefined) return false;
      if (check.gte !== undefined && matchedVal < check.gte) return false;
      if (check.lte !== undefined && matchedVal > check.lte) return false;
    }
  }

  return true;
}

/** Check whether a specific NPC (or any of their aliases) can epistemically know a given fact. */
export function isFactVisibleToActor(
  fact: BiTemporalFact,
  actorId: string,
  registry?: EntityRegistry,
): boolean {
  if (fact.witnessIds === "public") return true;
  if (registry) {
    return fact.witnessIds.some((w) => registry.sameEntity(w, actorId));
  }
  const target = actorId.toLowerCase();
  return fact.witnessIds.some((w) => w.toLowerCase() === target);
}

/**
 * Partition active facts into:
 *  - `known`: public facts or facts witnessed by every present NPC (alias-aware!)
 *  - `blindSpots`: facts witnessed by someone else, annotated with which present NPCs DO NOT know them
 */
export function partitionEpistemicFacts(
  facts: BiTemporalFact[],
  presentNpcs: string[],
  registry?: EntityRegistry,
): {
  known: BiTemporalFact[];
  blindSpots: Array<{ fact: BiTemporalFact; ignorantNpcs: string[] }>;
} {
  const known: BiTemporalFact[] = [];
  const blindSpots: Array<{ fact: BiTemporalFact; ignorantNpcs: string[] }> = [];

  for (const fact of facts) {
    if (fact.witnessIds === "public" || presentNpcs.length === 0) {
      known.push(fact);
      continue;
    }
    const ignorant = presentNpcs.filter((npc) => !isFactVisibleToActor(fact, npc, registry));
    if (ignorant.length === 0) {
      known.push(fact);
    } else {
      blindSpots.push({ fact, ignorantNpcs: ignorant });
    }
  }

  return { known, blindSpots };
}
