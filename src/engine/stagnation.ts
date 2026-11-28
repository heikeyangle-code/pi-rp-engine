/**
 * Real Narrative Stagnation & Prose-Loop Detector (replaces mechanical `turn % 5 === 0` cues).
 *
 * Measures three concrete, zero-LLM-cost signals:
 *  1. Lexical N-gram Repetition (`repetitionScore`, 0..1): Jaccard overlap of CJK bigrams & Latin words
 *     between consecutive recent assistant replies. Detects genuine LLM parroting / phrase looping.
 *  2. World-State Stagnation (`stagnantTurns`): Turns elapsed since the last meaningful world progression
 *     (location change, fact committed, belief shifted, clock advanced, storylet/milestone/stat/item change).
 *     Disabled automatically when `settlementMode === "off"` to prevent false positives.
 *  3. Dynamic Runtime SlopTracker (`detectRuntimeSlop`): Counts repeated 3-5 char CJK idioms and
 *     2-3 word English clichés appearing across >= 2 of the last 4 assistant turns (arXiv 2611.01284).
 *
 * Only emits a targeted Director nudge when real repetition or real stagnation is detected!
 */

import type { PiMessage, SessionRpState } from "../types.js";
import { tokenizeHybrid } from "../memory/graph-ppr.js";

export interface RuntimeSlopResult {
  phrases: string[];
  counts: Record<string, number>;
  cue: string | null;
}

export interface NarrativeHealthReport {
  repetitionScore: number;
  stagnantTurns: number;
  antiRepetitionCue: string | null;
  antiStagnationCue: string | null;
  runtimeSlopPhrases?: string[];
  runtimeSlopCue?: string | null;
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

const CJK_BOUNDARY_PARTICLES = new Set(
  Array.from("的了着过吗呢吧啊哦嗯地得和与或但而却就也都还又在把被让给向对从到这那他她它你我们是有不"),
);

const EN_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "was", "were", "are",
  "his", "her", "its", "their", "your", "you", "she", "they", "him", "but", "not",
  "into", "onto", "over", "under", "about", "just", "like", "what", "when", "where",
  "who", "how", "can", "could", "would", "should", "will", "had", "has", "been", "being",
  "out", "off", "all", "one", "two", "there", "here", "then", "than", "only", "very",
  "some", "more", "most", "other", "such", "down", "back", "still", "even", "before",
  "after", "through", "between", "around", "against", "without", "within", "along",
  "across", "behind", "toward", "towards", "said", "says", "asked", "replied",
  "to", "of", "in", "on", "at", "by", "as", "is", "it", "an", "or", "if", "so", "up", "no",
]);

const EN_BOUNDARY_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for",
  "with", "as", "is", "are", "was", "were", "that", "this", "it", "he", "she", "they",
]);

/**
 * Dynamic Runtime SlopTracker:
 * Counts repeated 3-5 char CJK idioms & 2-3 word English clichés appearing across >= 2
 * of the last 4 assistant turns, returning concise avoidance cues only for phrases
 * actually repeating in THIS session.
 */
export function detectRuntimeSlop(recentAssistantTexts: string[], ignoreTerms: string[] = []): RuntimeSlopResult {
  const ignoreSet = new Set(ignoreTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2));
  const turns = recentAssistantTexts
    .slice(-4)
    .map((t) => t.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, "").trim())
    .filter((t) => t.length >= 16);

  if (turns.length < 2) {
    return { phrases: [], counts: {}, cue: null };
  }

  const turnFreq = new Map<string, number>();
  const totalFreq = new Map<string, number>();

  for (const text of turns) {
    const seenInTurn = new Set<string>();

    // 1. CJK 3-5 char idioms/phrases
    const cjkRuns = text.match(/[\u4e00-\u9fff]{3,}/g) ?? [];
    for (const run of cjkRuns) {
      const maxLen = Math.min(5, run.length);
      for (let len = 3; len <= maxLen; len++) {
        for (let i = 0; i <= run.length - len; i++) {
          const gram = run.slice(i, i + len);
          if (CJK_BOUNDARY_PARTICLES.has(gram[0]!) || CJK_BOUNDARY_PARTICLES.has(gram[len - 1]!)) {
            continue;
          }
          let isProperNoun = false;
          for (const term of ignoreSet) {
            if (term.includes(gram) || gram.includes(term)) {
              isProperNoun = true;
              break;
            }
          }
          if (isProperNoun) continue;
          // Skip if more than half the characters are ultra-common particles
          let particleCount = 0;
          for (const ch of gram) {
            if (CJK_BOUNDARY_PARTICLES.has(ch)) particleCount++;
          }
          if (particleCount > Math.floor(len / 2)) continue;

          totalFreq.set(gram, (totalFreq.get(gram) ?? 0) + 1);
          seenInTurn.add(gram);
        }
      }
    }

    // 2. English 2-3 word phrases
    const lower = text.toLowerCase();
    const enSegments = lower.split(/[^a-z'\s]+/);
    for (const seg of enSegments) {
      const words = seg.trim().split(/\s+/).filter((w) => w.length >= 2);
      if (words.length < 2) continue;
      for (let len = 2; len <= 3; len++) {
        for (let i = 0; i <= words.length - len; i++) {
          const slice = words.slice(i, i + len);
          if (EN_BOUNDARY_WORDS.has(slice[0]!) || EN_BOUNDARY_WORDS.has(slice[len - 1]!)) {
            continue;
          }
          if (slice.every((w) => EN_STOPWORDS.has(w))) continue;
          const gram = slice.join(" ");
          totalFreq.set(gram, (totalFreq.get(gram) ?? 0) + 1);
          seenInTurn.add(gram);
        }
      }
    }

    for (const gram of seenInTurn) {
      turnFreq.set(gram, (turnFreq.get(gram) ?? 0) + 1);
    }
  }

  // Keep only phrases appearing in >= 2 distinct recent assistant turns
  const candidates: Array<{ phrase: string; turns: number; total: number }> = [];
  for (const [phrase, tCount] of turnFreq.entries()) {
    if (tCount >= 2) {
      candidates.push({ phrase, turns: tCount, total: totalFreq.get(phrase) ?? tCount });
    }
  }

  if (candidates.length === 0) {
    return { phrases: [], counts: {}, cue: null };
  }

  // Prefer longer phrases when they subsume shorter fragments with equal or lower turn frequency
  candidates.sort((a, b) => b.phrase.length - a.phrase.length || b.turns - a.turns || b.total - a.total);
  const deduped: Array<{ phrase: string; turns: number; total: number }> = [];
  for (const cand of candidates) {
    const subsumed = deduped.some(
      (kept) => kept.phrase.includes(cand.phrase) && kept.turns >= cand.turns,
    );
    if (!subsumed) {
      deduped.push(cand);
    }
  }

  deduped.sort((a, b) => b.turns - a.turns || b.total - a.total || b.phrase.length - a.phrase.length);
  const top = deduped.slice(0, 6);
  const phrases = top.map((x) => x.phrase);
  const counts: Record<string, number> = {};
  for (const item of top) {
    counts[item.phrase] = item.total;
  }

  const cue =
    phrases.length > 0
      ? `Runtime SlopTracker: Avoid repeating these recurring session phrases: ${phrases.join(" / ")}.`
      : null;

  return { phrases, counts, cue };
}

/**
 * Compute real narrative health across recent assistant replies and world-state delta.
 */
export function evaluateNarrativeHealth(
  state: SessionRpState,
  messages: PiMessage[],
  ignoreTerms: string[] = [],
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

  // 2. Real plot-stagnation detection: NEVER false-alarm when prose is fresh & moving forward!
  // Only warn when BOTH state is unchanged AND prose overlap is rising (>=0.30 for >=6 turns), OR >=10 turns with zero state shift.
  const isPlotDriven = state.archetype !== "companion" && state.archetype !== "slice-of-life";
  const isTrulyStagnant =
    (stagnantTurns >= 6 && repetitionScore >= 0.30) ||
    stagnantTurns >= 10;
  const antiStagnationCue =
    state.settlementMode !== "off" && isPlotDriven && state.pacingMode !== "relaxed" && state.turn >= 6 && isTrulyStagnant
      ? `Anti-stagnation cue: ${stagnantTurns} turns have elapsed with no concrete world shift. Surface an organic complication, subtle clue, NPC initiative, or consequence tied to the current scene objective.`
      : null;

  // 3. Dynamic Runtime SlopTracker (tracks actual repeating phrases in THIS session)
  const combinedIgnore = [
    ...ignoreTerms,
    ...state.presentNpcs,
    ...(state.location ? [state.location] : []),
    ...(state.currentPersona?.name ? [state.currentPersona.name] : []),
  ];
  const runtimeSlop = detectRuntimeSlop(recentAssistant, combinedIgnore);
  state.slopCounts = { ...runtimeSlop.counts };

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
    runtimeSlopPhrases: runtimeSlop.phrases,
    runtimeSlopCue: runtimeSlop.cue,
    nudge,
    status,
  };
}

const COMMON_SLOP_WATCHLIST = [
  "眼底闪过一丝",
  "空气仿佛凝固",
  "喉结滚动",
  "嘴角勾起一抹",
  "指节发白",
  "心头一震",
  "莫名其妙地",
  "shiver down",
  "couldn't help but",
  "a testament to",
  "let out a breath",
];

/** Detect stock AI clichés actually repeating (>= 2 occurrences) across recent assistant replies. */
export function detectRepeatedCliches(recentText: string): string[] {
  if (!recentText) return [];
  const lower = recentText.toLowerCase();
  const hits: string[] = [];
  for (const phrase of COMMON_SLOP_WATCHLIST) {
    const p = phrase.toLowerCase();
    const first = lower.indexOf(p);
    if (first !== -1 && lower.indexOf(p, first + p.length) !== -1) {
      hits.push(phrase);
    }
  }
  return hits.slice(0, 6);
}
