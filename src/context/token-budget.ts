/**
 * Hybrid CJK + Latin token estimator & deterministic priority budget trimmer.
 */

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) {
      cjk++;
    } else {
      other += ch.length;
    }
  }
  return Math.ceil(cjk * 1.45 + other / 3.8);
}

export interface BudgetedItem<T> {
  item: T;
  text: string;
  score: number;
  priority: number;
  pinned?: boolean;
  lowBudgetPriority?: boolean;
}

/**
 * Select items within a token budget deterministically:
 *  1. `pinned` (`ignore_budget`) items always go first.
 *  2. Normal items sorted by `(score desc, priority desc)`.
 *  3. `lowBudgetPriority` (`@@ignore_on_max_context`) items go last and drop first when tight.
 */
export function selectWithinTokenBudget<T>(
  candidates: BudgetedItem<T>[],
  budgetTokens: number,
): { selected: T[]; usedTokens: number; droppedCount: number } {
  const pinned = candidates.filter((c) => c.pinned);
  const normal = candidates
    .filter((c) => !c.pinned && !c.lowBudgetPriority)
    .sort((a, b) => b.score - a.score || b.priority - a.priority);
  const low = candidates
    .filter((c) => !c.pinned && c.lowBudgetPriority)
    .sort((a, b) => b.score - a.score || b.priority - a.priority);

  const selected: T[] = [];
  let used = 0;
  let dropped = 0;

  for (const c of pinned) {
    selected.push(c.item);
    used += estimateTokens(c.text);
  }

  for (const c of [...normal, ...low]) {
    const cost = estimateTokens(c.text);
    if (used + cost <= budgetTokens) {
      selected.push(c.item);
      used += cost;
    } else {
      dropped++;
    }
  }

  return { selected, usedTokens: used, droppedCount: dropped };
}
