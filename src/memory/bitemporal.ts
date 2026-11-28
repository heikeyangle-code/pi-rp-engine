/**
 * Bi-Temporal Fact Ledger (Zep / Graphiti pattern):
 *  - World validity axis: `validFromTurn` .. `validUntilTurn` (null = currently true in-world).
 *  - Transaction axis: `ingestedAtTurn` + optional `eventTimeLabel`.
 *  - Upgraded with EntityRegistry alias awareness & generous modern Zone 3 selection limits (14 recent + 12 matched + 12 secrets).
 */

import type { BiTemporalFact, SessionRpState } from "../types.js";
import { evaluateGate, isFactVisibleToActor } from "../engine/gates.js";
import type { EntityRegistry } from "./entity-registry.js";

/** Return currently valid facts (`validFromTurn <= state.turn` and not invalidated) that pass physical EraGate checks. */
export function getActiveFacts(state: SessionRpState, registry?: EntityRegistry): BiTemporalFact[] {
  const out: BiTemporalFact[] = [];
  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn !== null) continue;
    if (fact.validFromTurn > state.turn) continue;
    if (!evaluateGate(fact.gate, state, registry)) continue;
    out.push(fact);
  }
  out.sort((a, b) => b.validFromTurn - a.validFromTurn || a.id.localeCompare(b.id));
  return out;
}

/** Return historical (invalidated) facts for explicit `rp_recall` archive queries. */
export function getHistoricalFacts(state: SessionRpState, registry?: EntityRegistry): BiTemporalFact[] {
  const out: BiTemporalFact[] = [];
  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn === null) continue;
    if (!evaluateGate(fact.gate, state, registry)) continue;
    out.push(fact);
  }
  out.sort((a, b) => (b.validUntilTurn ?? 0) - (a.validUntilTurn ?? 0) || a.id.localeCompare(b.id));
  return out;
}

function extractMatchTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9_]{3,}/g);
  if (latin) {
    for (const w of latin) tokens.add(w);
  }
  const shortUpper = text.match(/(?<![A-Za-z0-9_])[A-Z0-9]{2}(?![A-Za-z0-9_])/g);
  if (shortUpper) {
    for (const w of shortUpper) tokens.add(w.toLowerCase());
  }
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
 * Select active facts for Sidecar contradiction checking (generous modern defaults: 16 recent + 20 older entity-matched).
 */
export function selectFactsForConflictCheck(
  state: SessionRpState,
  queryText: string,
  recentLimit = 16,
  entityLimit = 20,
  registry?: EntityRegistry,
): BiTemporalFact[] {
  const active = getActiveFacts(state, registry);
  if (active.length <= recentLimit) return active;

  const recent = active.slice(0, recentLimit);
  const older = active.slice(recentLimit);
  const expanded = registry ? registry.expandQueryForRecall(queryText).expandedText : queryText;
  const queryLower = `${expanded}\n${state.location}\n${state.presentNpcs.join(" ")}`.toLowerCase();
  const queryTokens = extractMatchTokens(queryLower);

  const scored: Array<{ fact: BiTemporalFact; score: number }> = [];
  for (const fact of older) {
    let score = 0;
    for (const ent of fact.entities) {
      const e = ent.trim().toLowerCase();
      if (e.length >= 2 && queryLower.includes(e)) {
        score += 4;
      } else if (registry) {
        const canon = registry.resolveCanonical(ent).toLowerCase();
        if (canon.length >= 2 && queryLower.includes(canon)) score += 4;
      }
    }
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
 * Select active facts for Zone 3 injection (generous modern defaults: 14 recent + 12 entity-matched + up to 12 live FANToM secrets).
 */
export function selectFactsForZone3(
  state: SessionRpState,
  queryText: string,
  recentLimit = 14,
  entityLimit = 12,
  registry?: EntityRegistry,
): BiTemporalFact[] {
  const picked = selectFactsForConflictCheck(state, queryText, recentLimit, entityLimit, registry);
  if (state.presentNpcs.length === 0) return picked;

  const seenIds = new Set(picked.map((f) => f.id));
  const extraSecrets: BiTemporalFact[] = [];
  for (const fact of getActiveFacts(state, registry)) {
    if (seenIds.has(fact.id) || fact.witnessIds === "public") continue;
    const hidesFromPresent = state.presentNpcs.some((npc) => !isFactVisibleToActor(fact, npc, registry));
    if (hidesFromPresent) {
      extraSecrets.push(fact);
      seenIds.add(fact.id);
      if (extraSecrets.length >= 12) break;
    }
  }
  return [...picked, ...extraSecrets];
}

/**
 * Detect high-overlap older active facts contradicted by a newly committed statement
 * (e.g. same core entity + numeric/revision cue like "实为/改为/其实/已死/不再/并非").
 */
export function findSupersededFactsForStatement(
  state: SessionRpState,
  newStatement: string,
  newEntities: string[],
  registry?: EntityRegistry,
): BiTemporalFact[] {
  const revisionCue = /(?:实为|其实是|实际上|改为|已改|并非|不再|其实有|共有|已经死|已死|已毁|真相|修正|推翻|actually|now\s+is|no\s+longer)/i;
  if (!revisionCue.test(newStatement)) return [];

  const newTokens = extractMatchTokens(newStatement);
  const normNewEnts = new Set(
    newEntities.map((e) => (registry ? registry.resolveCanonical(e).toLowerCase() : e.toLowerCase())),
  );
  const superseded: BiTemporalFact[] = [];

  for (const fact of getActiveFacts(state, registry)) {
    const factEnts = fact.entities.map((e) => (registry ? registry.resolveCanonical(e).toLowerCase() : e.toLowerCase()));
    const sharedEnt = factEnts.some((e) => normNewEnts.has(e) || newStatement.toLowerCase().includes(e));
    if (!sharedEnt) continue;

    const oldTokens = extractMatchTokens(fact.statement);
    let overlap = 0;
    for (const t of oldTokens) {
      if (newTokens.has(t)) overlap++;
    }
    const overlapRatio = oldTokens.size > 0 ? overlap / Math.min(oldTokens.size, newTokens.size) : 0;
    if (overlap >= 2 && overlapRatio >= 0.35 && fact.statement.trim() !== newStatement.trim()) {
      superseded.push(fact);
    }
  }
  return superseded.slice(0, 3);
}
