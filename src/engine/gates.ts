/**
 * Physical Era / Milestone Gates (NCP-Bench / TimeChara) & Epistemic Visibility Filter (FANToM).
 * Locked lore/facts are physically excluded in code before reaching the LLM payload.
 */

import type { BiTemporalFact, GateCondition, SessionRpState } from "../types.js";

export function evaluateGate(gate: GateCondition | undefined, state: SessionRpState): boolean {
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
    const present = new Set(state.presentNpcs.map((n) => n.toLowerCase()));
    const allPresent = gate.requiredNpcPresent.every((req) => present.has(req.toLowerCase()));
    if (!allPresent) return false;
  }
  if (gate.statChecks && gate.statChecks.length > 0) {
    for (const check of gate.statChecks) {
      const targetKey = check.key.toLowerCase();
      let matchedVal: number | undefined;
      if (check.actorId) {
        const targetActor = check.actorId.toLowerCase();
        for (const [actor, stats] of Object.entries(state.stats)) {
          if (actor.toLowerCase() !== targetActor) continue;
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

/** Check whether a specific NPC can epistemically know a given fact. */
export function isFactVisibleToActor(fact: BiTemporalFact, actorId: string): boolean {
  if (fact.witnessIds === "public") return true;
  const target = actorId.toLowerCase();
  return fact.witnessIds.some((w) => w.toLowerCase() === target);
}

/**
 * Partition active facts into:
 *  - `known`: public facts or facts witnessed by at least one present NPC
 *  - `blindSpots`: facts witnessed by someone else, annotated with which present NPCs DO NOT know them
 */
export function partitionEpistemicFacts(
  facts: BiTemporalFact[],
  presentNpcs: string[],
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
    const ignorant = presentNpcs.filter((npc) => !isFactVisibleToActor(fact, npc));
    if (ignorant.length === 0) {
      known.push(fact);
    } else {
      blindSpots.push({ fact, ignorantNpcs: ignorant });
    }
  }

  return { known, blindSpots };
}
