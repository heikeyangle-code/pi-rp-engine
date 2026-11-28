/**
 * EverMemOS ForesightStore: ranks open Chekhov's Guns / promises / countdowns
 * by relevance to current scene + urgency of linked progress clocks.
 */

import type { ForesightHook, SessionRpState } from "../types.js";

function extractForesightTokens(text: string): Set<string> {
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

export function selectActiveForesights(
  state: SessionRpState,
  recentText: string,
  limit = 3,
): ForesightHook[] {
  const lower = recentText.toLowerCase();
  const recentTokens = extractForesightTokens(recentText);
  const scored: Array<{ hook: ForesightHook; score: number }> = [];

  for (const hook of state.foresights.values()) {
    if (hook.status !== "open") continue;
    let score = 1;
    for (const ent of hook.entities) {
      const trimmed = ent.trim();
      if (trimmed.length >= 2 && lower.includes(trimmed.toLowerCase())) {
        score += 4;
      }
    }
    const hintTokens = extractForesightTokens(`${hook.summary} ${hook.triggerHint}`);
    let overlap = 0;
    for (const t of hintTokens) {
      if (recentTokens.has(t)) overlap++;
    }
    if (overlap > 0) {
      score += Math.min(3.5, overlap * 0.7);
    }
    if (hook.dueClockId) {
      const clock = state.clocks[hook.dueClockId];
      if (clock && clock.max > 0) {
        score += (clock.value / clock.max) * 5;
      }
    }
    // Slight recency / aging balance so long-planted hooks resurface
    const age = Math.max(0, state.turn - hook.plantedTurn);
    score += Math.min(age * 0.15, 2.0);
    scored.push({ hook, score });
  }

  scored.sort((a, b) => b.score - a.score || a.hook.id.localeCompare(b.hook.id));
  return scored.slice(0, limit).map((s) => s.hook);
}
