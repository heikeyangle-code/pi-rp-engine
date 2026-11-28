/**
 * Bi-Temporal Fact Ledger (Zep / Graphiti pattern):
 *  - World validity axis: `validFromTurn` .. `validUntilTurn` (null = currently true in-world).
 *  - Transaction axis: `ingestedAtTurn` + optional `eventTimeLabel`.
 *  - Entity-aware conflict candidate retrieval (`selectFactsForConflictCheck`) ensures
 *    a Turn-3 fact is STILL retrieved and invalidated if contradicted at Turn-150!
 */

import type { BiTemporalFact, SessionRpState } from "../types.js";
import { evaluateGate, isFactVisibleToActor } from "../engine/gates.js";

/** Return currently valid facts (`validFromTurn <= state.turn` and not invalidated) that pass physical EraGate checks. */
export function getActiveFacts(state: SessionRpState): BiTemporalFact[] {
  const out: BiTemporalFact[] = [];
  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn !== null) continue;
    if (fact.validFromTurn > state.turn) continue;
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

function extractMatchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  // Latin words (>= 3 chars)
  const latin = lower.match(/[a-z0-9_]{3,}/g);
  if (latin) {
    for (const w of latin) tokens.add(w);
  }
  // 2-char uppercase/alphanumeric tokens (e.g. HP, AI, MP, XP, 2B)
  const shortUpper = text.match(/(?<![A-Za-z0-9_])[A-Z0-9]{2}(?![A-Za-z0-9_])/g);
  if (shortUpper) {
    for (const w of shortUpper) tokens.add(w.toLowerCase());
  }
  // CJK bigrams & short runs
  const cjkRuns = lower.match(/[\u4e00-\u9fff]{2,}/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length <= 4) tokens.add(run);
      for (let i = 0; i < run.length - 1; i++) {
        tokens.add(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

/**
 * Select active facts for Sidecar contradiction checking:
 *  1) Always include the `recentLimit` newest active facts (default 10).
 *  2) Also score ALL remaining older active facts by entity & token overlap with `queryText`
 *     (and current location / present NPCs), returning up to `entityLimit` (default 15) best matches.
 *
 * This eliminates the Turn-15 blind spot so early-campaign facts can still be superseded at Turn 150+.
 */
export function selectFactsForConflictCheck(
  state: SessionRpState,
  queryText: string,
  recentLimit = 10,
  entityLimit = 15,
): BiTemporalFact[] {
  const active = getActiveFacts(state);
  if (active.length <= recentLimit) return active;

  const recent = active.slice(0, recentLimit);
  const older = active.slice(recentLimit);
  const queryLower = `${queryText}\n${state.location}\n${state.presentNpcs.join(" ")}`.toLowerCase();
  const queryTokens = extractMatchTokens(`${queryText}\n${state.location}\n${state.presentNpcs.join(" ")}`);

  const scored: Array<{ fact: BiTemporalFact; score: number }> = [];
  for (const fact of older) {
    let score = 0;
    // Strong boost for exact entity hit in queryText
    for (const ent of fact.entities) {
      const e = ent.trim().toLowerCase();
      if (e.length >= 2 && queryLower.includes(e)) {
        score += 4;
      }
    }
    // Secondary boost for statement lexical overlap
    const stmtTokens = extractMatchTokens(fact.statement);
    let overlap = 0;
    for (const t of stmtTokens) {
      if (queryTokens.has(t)) overlap++;
    }
    if (overlap > 0) {
      score += Math.min(4, overlap * 0.6);
    }
    if (score > 0) {
      scored.push({ fact, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.fact.validFromTurn - a.fact.validFromTurn);
  const matchedOlder = scored.slice(0, entityLimit).map((x) => x.fact);
  return [...recent, ...matchedOlder];
}

/**
 * Select active facts for Zone 3 injection:
 *  1) Newest active facts + entity/token-matched older facts (`selectFactsForConflictCheck`).
 *  2) ALWAYS preserve active FANToM secret facts that form live blind spots for currently `presentNpcs`
 *     (up to 6 extra), so an early secret NEVER leaks at Turn 100 just because >12 newer facts exist!
 */
export function selectFactsForZone3(
  state: SessionRpState,
  queryText: string,
  recentLimit = 8,
  entityLimit = 6,
): BiTemporalFact[] {
  const picked = selectFactsForConflictCheck(state, queryText, recentLimit, entityLimit);
  if (state.presentNpcs.length === 0) return picked;

  const seenIds = new Set(picked.map((f) => f.id));
  const extraSecrets: BiTemporalFact[] = [];
  for (const fact of getActiveFacts(state)) {
    if (seenIds.has(fact.id) || fact.witnessIds === "public") continue;
    const hidesFromPresent = state.presentNpcs.some((npc) => !isFactVisibleToActor(fact, npc));
    if (hidesFromPresent) {
      extraSecrets.push(fact);
      seenIds.add(fact.id);
      if (extraSecrets.length >= 6) break;
    }
  }
  return [...picked, ...extraSecrets];
}
