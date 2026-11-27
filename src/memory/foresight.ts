/**
 * EverMemOS ForesightStore: ranks open Chekhov's Guns / promises / countdowns
 * by relevance to current scene + urgency of linked progress clocks.
 */

import type { ForesightHook, SessionRpState } from "../types.js";

export function selectActiveForesights(
  state: SessionRpState,
  recentText: string,
  limit = 3,
): ForesightHook[] {
  const lower = recentText.toLowerCase();
  const scored: Array<{ hook: ForesightHook; score: number }> = [];

  for (const hook of state.foresights.values()) {
    if (hook.status !== "open") continue;
    let score = 1;
    for (const ent of hook.entities) {
      if (ent && lower.includes(ent.toLowerCase())) {
        score += 4;
      }
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
