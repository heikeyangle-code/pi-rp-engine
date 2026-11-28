/**
 * Real Narrative Stagnation & Prose-Loop Detector (replaces mechanical `turn % 5 === 0` cues).
 *
 * Measures two concrete, zero-LLM-cost signals:
 *  1. Lexical N-gram Repetition (`repetitionScore`, 0..1): Jaccard overlap of CJK bigrams & Latin words
 *     between consecutive recent assistant replies. Detects genuine LLM parroting / phrase looping.
 *  2. World-State Stagnation (`stagnantTurns`): Turns elapsed since the last meaningful world progression
 *     (location change, fact committed, belief shifted, clock advanced, storylet/milestone/stat/item change).
 *
 * Only emits a targeted Director nudge when real repetition or real stagnation is detected!
 */

import type { PiMessage, SessionRpState } from "../types.js";
import { tokenizeHybrid } from "../memory/graph-ppr.js";

export interface NarrativeHealthReport {
  repetitionScore: number;
  stagnantTurns: number;
  antiRepetitionCue: string | null;
  antiStagnationCue: string | null;
  nudge: string | null;
  status: "healthy" | "repeating" | "stagnant";
}

function extractAssistantText(msg: PiMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Compute real narrative health across recent assistant replies and world-state delta.
 */
export function evaluateNarrativeHealth(
  state: SessionRpState,
  messages: PiMessage[],
): NarrativeHealthReport {
  const recentAssistant = messages
    .filter((m) => m.role === "assistant" && m.customType !== "rp:ooc" && m.customType !== "rp:event")
    .slice(-4)
    .map((m) => extractAssistantText(m).replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, "").trim())
    .filter((t) => t.length >= 24);

  let maxOverlap = 0;
  if (recentAssistant.length >= 2) {
    const tokenSets = recentAssistant.map((t) => tokenizeHybrid(t));
    const latest = tokenSets[tokenSets.length - 1]!;
    for (let i = 0; i < tokenSets.length - 1; i++) {
      const sim = jaccardSimilarity(latest, tokenSets[i]!);
      if (sim > maxOverlap) maxOverlap = sim;
    }
  }

  const repetitionScore = Number(maxOverlap.toFixed(3));
  const stagnantTurns = Math.max(0, state.turn - (state.lastMeaningfulProgressTurn ?? 0));

  // 1. Real prose-loop detection (applies to ALL card types — nobody likes repetitive AI parroting!)
  const antiRepetitionCue =
    repetitionScore >= 0.42
      ? "Anti-repetition cue: Recent narration shows high phrasing overlap. Vary sentence rhythm, avoid repeating prior gestures/metaphors, and move the immediate beat forward with fresh concrete action or dialogue."
      : null;

  // 2. Real plot-stagnation detection (only on plot-driven cards when pacing is balanced/dramatic)
  const isPlotDriven = state.archetype !== "companion" && state.archetype !== "slice-of-life";
  const antiStagnationCue =
    isPlotDriven && state.pacingMode !== "relaxed" && state.turn >= 4 && stagnantTurns >= 4
      ? `Anti-stagnation cue: ${stagnantTurns} turns have elapsed with no concrete world shift. Surface an organic complication, subtle clue, NPC initiative, or consequence tied to the current scene objective.`
      : null;

  const status: NarrativeHealthReport["status"] = antiRepetitionCue
    ? "repeating"
    : antiStagnationCue
      ? "stagnant"
      : "healthy";

  const nudge = [antiRepetitionCue, antiStagnationCue].filter(Boolean).join(" ") || null;

  return {
    repetitionScore,
    stagnantTurns,
    antiRepetitionCue,
    antiStagnationCue,
    nudge,
    status,
  };
}
