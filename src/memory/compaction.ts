/**
 * EverMemOS MemScene Compaction (`session_before_compact`) & Inter-Act Montage generator.
 * Summarizes older turns into compact narrative scenes without duplicating L1 facts/stats.
 */

import type { SessionRpState } from "../types.js";
import { getActiveFacts } from "./bitemporal.js";

export function buildMemSceneCompactionSummary(
  state: SessionRpState,
  droppedMessagesSummary?: string,
): string {
  const lines: string[] = [
    `# MemScene Summary (${state.era} · ${state.worldTimeLabel} · Turn ${state.turn})`,
  ];

  if (state.location) {
    lines.push(`- Current Location: ${state.location}${state.presentNpcs.length ? ` (Present: ${state.presentNpcs.join(", ")})` : ""}`);
  }

  const milestones = Array.from(state.milestones);
  if (milestones.length > 0) {
    lines.push(`- Unlocked Milestones: ${milestones.join(", ")}`);
  }

  if (state.beliefs.length > 0) {
    const recentBeliefs = state.beliefs.slice(-6);
    lines.push("## Key Character Belief Shifts (DREAM ABC)");
    for (const b of recentBeliefs) {
      lines.push(`- ${b.actorId} → ${b.target} [T${b.turn}]: ${b.activatingEvent} ⇒ ${b.belief}`);
    }
  }

  const openForesights = Array.from(state.foresights.values()).filter((h) => h.status === "open");
  if (openForesights.length > 0) {
    lines.push("## Unresolved Foresights");
    for (const h of openForesights.slice(0, 6)) {
      lines.push(`- ${h.summary} (trigger: ${h.triggerHint})`);
    }
  }

  const activeCount = getActiveFacts(state).length;
  lines.push(`- Note: ${activeCount} authoritative bi-temporal facts & all L1 stats/inventory remain live in <rp_state_frame>.`);

  if (droppedMessagesSummary?.trim()) {
    lines.push(`## Condensed Narrative Beats\n${droppedMessagesSummary.trim()}`);
  }

  return lines.join("\n");
}
