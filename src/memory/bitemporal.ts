/**
 * Bi-Temporal Fact Ledger (Zep / Graphiti pattern):
 *  - Active facts have `validUntilTurn === null`.
 *  - Invalidating a fact marks `validUntilTurn = currentTurn` & optional `supersededBy`
 *    without deleting historical records, preventing old/new contradictions in Zone 3.
 */

import type { BiTemporalFact, SessionRpState } from "../types.js";
import { evaluateGate } from "../engine/gates.js";

/** Return currently valid facts that also pass physical EraGate checks. */
export function getActiveFacts(state: SessionRpState): BiTemporalFact[] {
  const out: BiTemporalFact[] = [];
  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn !== null) continue;
    if (!evaluateGate(fact.gate, state)) continue;
    out.push(fact);
  }
  out.sort((a, b) => b.validFromTurn - a.validFromTurn || a.id.localeCompare(b.id));
  return out;
}

/** Return historical (invalidated) facts for explicit `rp_recall` archive queries. */
export function getHistoricalFacts(state: SessionRpState): BiTemporalFact[] {
  const out: BiTemporalFact[] = [];
  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn === null) continue;
    if (!evaluateGate(fact.gate, state)) continue;
    out.push(fact);
  }
  out.sort((a, b) => (b.validUntilTurn ?? 0) - (a.validUntilTurn ?? 0) || a.id.localeCompare(b.id));
  return out;
}
