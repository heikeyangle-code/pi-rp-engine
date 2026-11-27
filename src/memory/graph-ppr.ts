/**
 * Zero-dependency local HippoRAG 2 (2-hop Personalized PageRank) + BM25 + Official SillyTavern
 * World Info engine:
 *  - Inline `/pattern/flags` regex keys (even when `useRegex: false`, matching ST `world-info.js`)
 *  - Full 4-way `selectiveLogic` (`AND_ANY`, `AND_ALL`, `NOT_ANY`, `NOT_ALL`)
 *  - Independent CCV3 `excludeKeys` (never clobbers `selectiveLogic`)
 *  - Per-entry `scanDepthOverride` (`@@scan_depth N`)
 *  - Exact `sticky` / `cooldown` / `oneShot` lifecycle (including `sticky === 0 && cooldown > 0`!)
 *  - `group` / `groupOverride` / `groupWeight` / `useGroupScoring` + deterministic `probability`
 *  - Respects live `state.loreOverrides` toggles from `/rp panel`
 *  - Couples active bi-temporal facts & open foresights into the seed entity context
 */

import type { CompiledLoreEntry, PiMessage, SessionRpState } from "../types.js";
import { evaluateGate } from "../engine/gates.js";
import { parseInlineRegexKey, isSafeRegexPattern } from "../parser/lore-compiler.js";
import { selectWithinTokenBudget } from "../context/token-budget.js";
import { getActiveFacts } from "./bitemporal.js";

/** Tokenize mixed Chinese/English text into CJK bigrams + lowercased Latin words. */
export function tokenizeHybrid(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();

  const wordRe = /[a-z0-9_]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(lower)) !== null) {
    tokens.push(m[0]!);
  }

  const cjkRe = /[\u4e00-\u9fff]+/g;
  while ((m = cjkRe.exec(lower)) !== null) {
    const run = m[0]!;
    if (run.length === 1) {
      tokens.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  return tokens;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMsgText(m: PiMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * Match a single World Info key against haystack following official SillyTavern `world-info.js`:
 *  - Inline `/pattern/flags` is ALWAYS evaluated as RegExp (guarded for ReDoS), even when `useRegex: false`.
 *  - When `useRegex: true`, bare keys are compiled as RegExp (respecting `caseSensitive`).
 *  - When `matchWholeWords: true`, applies word-boundary checks for ASCII/alphanumeric words.
 */
export function matchWorldInfoKey(haystack: string, key: string, entry: CompiledLoreEntry): boolean {
  if (!key) return false;

  const inline = parseInlineRegexKey(key);
  if (inline) {
    if (isSafeRegexPattern(key)) {
      try {
        const flags = inline.flags || (entry.caseSensitive ? "" : "i");
        return new RegExp(inline.pattern, flags).test(haystack);
      } catch {
        // Fallback to literal
      }
    }
  } else if (entry.useRegex && isSafeRegexPattern(key)) {
    try {
      return new RegExp(key, entry.caseSensitive ? "" : "i").test(haystack);
    } catch {
      // Fallback to literal
    }
  }

  if (entry.matchWholeWords && /^[a-zA-Z0-9_\-']+$/.test(key)) {
    const re = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegExp(key)}(?![a-zA-Z0-9_])`, entry.caseSensitive ? "" : "i");
    return re.test(haystack);
  }
  if (entry.caseSensitive) {
    return haystack.includes(key);
  }
  return haystack.toLowerCase().includes(key.toLowerCase());
}

/** Evaluate World Info primary + 4-way secondary selectiveLogic + independent CCV3 excludeKeys. */
export function matchesWorldInfoKeys(haystack: string, entry: CompiledLoreEntry): boolean {
  if (entry.keys.length === 0) return false;

  // CCV3 @@exclude_keys: hard-blocks activation if any excluded key appears
  if (entry.excludeKeys.length > 0 && entry.excludeKeys.some((k) => matchWorldInfoKey(haystack, k, entry))) {
    return false;
  }

  const primaryHit = entry.keys.some((k) => matchWorldInfoKey(haystack, k, entry));
  if (!primaryHit) return false;

  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return true;
  }

  const secHits = entry.secondaryKeys.map((k) => matchWorldInfoKey(haystack, k, entry));
  switch (entry.selectiveLogic) {
    case "AND_ANY":
      return secHits.some(Boolean);
    case "AND_ALL":
      return secHits.every(Boolean);
    case "NOT_ANY":
      return !secHits.some(Boolean);
    case "NOT_ALL":
      return !secHits.every(Boolean);
  }
}

/** Deterministic PRNG in [0, 100) from seed string so replays/tests are reproducible. */
function deterministicPercent(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

export interface RecallResult {
  selected: CompiledLoreEntry[];
  activatedIds: string[];
  nextSticky: Record<string, number>;
  nextCooldown: Record<string, number>;
  nextConsumedOneShots: string[];
  usedTokens: number;
  droppedCount: number;
}

/**
 * Local BM25 + 2-hop Personalized PageRank Entity Graph Recall with full SillyTavern World Info semantics.
 */
export function recallLoreWithGraphPpr(options: {
  entries: CompiledLoreEntry[];
  state: SessionRpState;
  recentText: string;
  messages?: PiMessage[];
  defaultScanDepth?: number;
  tokenBudget: number;
  manualQuery?: string;
}): RecallResult {
  const { entries, state, recentText, messages, defaultScanDepth = 4, tokenBudget, manualQuery } = options;
  const isManual = Boolean(manualQuery);
  const queryText = isManual ? manualQuery! : recentText;

  // Cache per-depth message slices when messages[] is supplied (supports @@scan_depth N)
  const depthTextCache = new Map<number, string>();
  const getHaystackForEntry = (entry: CompiledLoreEntry): string => {
    if (isManual || !messages || messages.length === 0 || !entry.scanDepthOverride) {
      return queryText;
    }
    const d = Math.max(1, entry.scanDepthOverride);
    let cached = depthTextCache.get(d);
    if (cached === undefined) {
      cached = messages.slice(-d).map(extractMsgText).join("\n");
      depthTextCache.set(d, cached);
    }
    return cached;
  };
  void defaultScanDepth;

  // 1. Filter eligible dynamic entries (live loreOverrides + physical EraGate + cooldown + oneShot)
  const eligible = entries.filter((e) => {
    const effectiveEnabled = state.loreOverrides[e.id] ?? e.enabled;
    if (!effectiveEnabled || !e.content) return false;
    if (e.constant && !isManual) return false;
    if (e.manualRecallOnly && !isManual) return false;
    if (!evaluateGate(e.gate, state)) return false;
    if (!isManual && state.loreConsumedOneShots.has(e.id)) return false;
    if (!isManual && (state.loreCooldown[e.id] ?? 0) > 0) return false;
    return true;
  });

  if (eligible.length === 0) {
    return {
      selected: [],
      activatedIds: [],
      nextSticky: { ...state.loreSticky },
      nextCooldown: { ...state.loreCooldown },
      nextConsumedOneShots: Array.from(state.loreConsumedOneShots),
      usedTokens: 0,
      droppedCount: 0,
    };
  }

  // 2. Build local BM25 index over eligible entries
  const docTokens = new Map<string, string[]>();
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const e of eligible) {
    const toks = tokenizeHybrid(`${e.title} ${e.keys.join(" ")} ${e.content}`);
    docTokens.set(e.id, toks);
    totalLen += toks.length;
    const uniq = new Set(toks);
    for (const t of uniq) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const avgLen = Math.max(1, totalLen / eligible.length);
  const queryTokens = tokenizeHybrid(queryText);

  const bm25Scores = new Map<string, number>();
  const N = eligible.length;
  const k1 = 1.2;
  const b = 0.75;

  for (const e of eligible) {
    const toks = docTokens.get(e.id)!;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const qt of queryTokens) {
      const f = tf.get(qt) ?? 0;
      if (f === 0) continue;
      const docFreq = df.get(qt) ?? 1;
      const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / avgLen))));
    }
    bm25Scores.set(e.id, score);
  }

  // 3. Build lightweight Entity -> Entry adjacency graph & run 2-hop Personalized PageRank
  const entityToEntries = new Map<string, Set<string>>();
  const entryToEntities = new Map<string, Set<string>>();
  const eligibleById = new Map(eligible.map((e) => [e.id, e]));

  for (const e of eligible) {
    const ents = new Set<string>();
    for (const ent of e.entities) {
      const norm = ent.toLowerCase();
      ents.add(norm);
      if (!entityToEntries.has(norm)) entityToEntries.set(norm, new Set());
      entityToEntries.get(norm)!.add(e.id);
    }
    entryToEntities.set(e.id, ents);
  }

  const allEntityNames = Array.from(entityToEntries.keys());
  for (const e of eligible) {
    if (e.noGraphSpread) continue;
    const lowerContent = e.content.toLowerCase();
    const ents = entryToEntities.get(e.id)!;
    for (const ent of allEntityNames) {
      if (ent.length >= 2 && lowerContent.includes(ent)) {
        ents.add(ent);
        entityToEntries.get(ent)!.add(e.id);
      }
    }
  }

  // Seed entity scores from queryText + presentNpcs + current location + recently touched fact entities
  const recentFactEntities = getActiveFacts(state)
    .slice(0, 6)
    .flatMap((f) => f.entities)
    .filter((ent) => ent && queryText.toLowerCase().includes(ent.toLowerCase()));
  const seedContext = `${queryText}\n${state.location}\n${state.presentNpcs.join(" ")}\n${recentFactEntities.join(" ")}`.toLowerCase();
  const seedEntities = new Map<string, number>();
  for (const ent of allEntityNames) {
    if (seedContext.includes(ent)) {
      seedEntities.set(ent, 1.0);
    }
  }

  // Pre-evaluate direct key hits & sticky status so regex-triggered entries ALSO seed 2-hop PPR!
  const directHitMap = new Map<string, boolean>();
  const stickyActiveMap = new Map<string, boolean>();
  for (const e of eligible) {
    const haystack = getHaystackForEntry(e);
    directHitMap.set(e.id, matchesWorldInfoKeys(haystack, e));
    stickyActiveMap.set(e.id, !isManual && (state.loreSticky[e.id] ?? 0) > 0);
  }

  // 2-hop PPR power iteration: (Entity + Direct/Sticky Triggers) -> Entry -> Entity -> Entry
  const pprEntryScores = new Map<string, number>();
  const damping = 0.85;
  const hop1Entry = new Map<string, number>();

  for (const [ent, weight] of seedEntities.entries()) {
    const neighbors = entityToEntries.get(ent);
    if (!neighbors || neighbors.size === 0) continue;
    const share = weight / neighbors.size;
    for (const entryId of neighbors) {
      hop1Entry.set(entryId, (hop1Entry.get(entryId) ?? 0) + share);
    }
  }
  for (const e of eligible) {
    if (directHitMap.get(e.id) || stickyActiveMap.get(e.id)) {
      hop1Entry.set(e.id, (hop1Entry.get(e.id) ?? 0) + 1.0);
    }
  }

  if (hop1Entry.size > 0) {
    for (const [id, s] of hop1Entry.entries()) {
      pprEntryScores.set(id, s);
    }

    const hop2Entity = new Map<string, number>();
    for (const [entryId, weight] of hop1Entry.entries()) {
      const entry = eligibleById.get(entryId);
      if (!entry || entry.noGraphSpread) continue;
      const ents = entryToEntities.get(entryId);
      if (!ents || ents.size === 0) continue;
      const share = (weight * damping) / ents.size;
      for (const ent of ents) {
        hop2Entity.set(ent, (hop2Entity.get(ent) ?? 0) + share);
      }
    }
    for (const [ent, weight] of hop2Entity.entries()) {
      const neighbors = entityToEntries.get(ent);
      if (!neighbors || neighbors.size === 0) continue;
      const share = weight / neighbors.size;
      for (const entryId of neighbors) {
        pprEntryScores.set(entryId, (pprEntryScores.get(entryId) ?? 0) + share * 0.65);
      }
    }
  }

  // 4. Combine direct key match, sticky, staticPrebound, BM25, and 2-hop PPR
  const activated: Array<{ entry: CompiledLoreEntry; score: number; directTrigger: boolean }> = [];

  for (const e of eligible) {
    const haystack = getHaystackForEntry(e);
    const isStickyActive = stickyActiveMap.get(e.id) ?? false;
    const directHit = directHitMap.get(e.id) ?? false;
    const ppr = pprEntryScores.get(e.id) ?? 0;
    const bm25 = bm25Scores.get(e.id) ?? 0;

    // Hard-enforce @@exclude_keys and NOT_ANY / NOT_ALL even for PPR & BM25 recall
    if (!isStickyActive && !isManual) {
      if (e.excludeKeys.length > 0 && e.excludeKeys.some((k) => matchWorldInfoKey(haystack, k, e))) {
        continue;
      }
      if (e.selective && e.secondaryKeys.length > 0) {
        if (e.selectiveLogic === "NOT_ANY" && e.secondaryKeys.some((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
        if (e.selectiveLogic === "NOT_ALL" && e.secondaryKeys.every((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
      }
    }

    // `delay_until_recursion` (graphSecondHopOnly): only activates via graph hop, not direct key alone
    const graphOnlyBlocked = e.graphSecondHopOnly && !isManual && ppr < 0.08;
    if (graphOnlyBlocked && !isStickyActive) continue;

    const triggered =
      isStickyActive ||
      directHit ||
      e.staticPrebound ||
      ppr >= 0.12 ||
      (isManual && bm25 > 0.25) ||
      bm25 >= 2.2;

    if (!triggered) continue;

    if (!isStickyActive && !isManual && e.useProbability && e.probability < 100) {
      const roll = deterministicPercent(`${state.turn}:${e.id}`);
      if (roll >= e.probability) continue;
    }

    const totalScore =
      (isStickyActive ? 12 : 0) +
      (directHit ? 10 : 0) +
      (e.staticPrebound ? 4 : 0) +
      ppr * 6 +
      bm25 * 1.5;

    activated.push({ entry: e, score: totalScore, directTrigger: directHit });
  }

  // 5. Exclusive group resolution (`group` + `groupOverride` + `groupWeight`)
  const byGroup = new Map<string, Array<{ entry: CompiledLoreEntry; score: number; directTrigger: boolean }>>();
  const ungrouped: Array<{ entry: CompiledLoreEntry; score: number; directTrigger: boolean }> = [];

  for (const a of activated) {
    if (a.entry.group) {
      if (!byGroup.has(a.entry.group)) byGroup.set(a.entry.group, []);
      byGroup.get(a.entry.group)!.push(a);
    } else {
      ungrouped.push(a);
    }
  }

  const afterGroup = [...ungrouped];
  for (const [groupName, members] of byGroup.entries()) {
    if (members.length === 1) {
      afterGroup.push(members[0]!);
      continue;
    }
    const overrides = members.filter((m) => m.entry.groupOverride);
    if (overrides.length > 0) {
      overrides.sort((a, b) => b.entry.priority - a.entry.priority || b.score - a.score);
      afterGroup.push(overrides[0]!);
      continue;
    }
    if (members.some((m) => m.entry.useGroupScoring)) {
      members.sort((a, b) => b.score - a.score || b.entry.priority - a.entry.priority);
      afterGroup.push(members[0]!);
      continue;
    }
    const totalWeight = members.reduce((acc, m) => acc + Math.max(1, m.entry.groupWeight), 0);
    const pick = deterministicPercent(`${state.turn}:group:${groupName}`) % totalWeight;
    let cursor = 0;
    let chosen = members[0]!;
    for (const m of members) {
      cursor += Math.max(1, m.entry.groupWeight);
      if (pick < cursor) {
        chosen = m;
        break;
      }
    }
    afterGroup.push(chosen);
  }

  // 6. Hard Token budget trimming
  const budgeted = selectWithinTokenBudget(
    afterGroup.map((a) => ({
      item: a.entry,
      text: `[${a.entry.title}]\n${a.entry.content}`,
      score: a.score,
      priority: a.entry.priority,
      pinned: a.entry.pinned,
      lowBudgetPriority: a.entry.lowBudgetPriority,
    })),
    tokenBudget,
  );

  // Sort final Zone 3 lore by depthHint descending (depth=0 closest to generation), then priority
  const selected = [...budgeted.selected].sort(
    (a, b) => b.depthHint - a.depthHint || b.priority - a.priority || a.id.localeCompare(b.id),
  );

  // 7. Compute next sticky / cooldown / oneShot runtime maps (persisted at settled turn_end)
  const nextSticky: Record<string, number> = { ...state.loreSticky };
  const nextCooldown: Record<string, number> = { ...state.loreCooldown };
  const nextConsumed = new Set(state.loreConsumedOneShots);
  const activatedIds: string[] = [];

  if (!isManual) {
    for (const e of selected) {
      activatedIds.push(e.id);
      if (e.stickyPermanent) {
        nextSticky[e.id] = 999_999;
      } else if (e.stickyTurns > 0 && (nextSticky[e.id] ?? 0) === 0) {
        nextSticky[e.id] = e.stickyTurns;
      }
      if (e.oneShot) {
        nextConsumed.add(e.id);
      }
    }
  }

  return {
    selected,
    activatedIds,
    nextSticky,
    nextCooldown,
    nextConsumedOneShots: Array.from(nextConsumed),
    usedTokens: budgeted.usedTokens,
    droppedCount: budgeted.droppedCount,
  };
}

/**
 * Advance sticky & cooldown counters by 1 turn at `turn_end`.
 * Fixes the classic bug where `sticky === 0 && cooldown > 0` never entered cooldown!
 */
export function tickLoreRuntime(
  entries: CompiledLoreEntry[],
  sticky: Record<string, number>,
  cooldown: Record<string, number>,
  activatedIds: string[] = [],
): { sticky: Record<string, number>; cooldown: Record<string, number> } {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const nextSticky: Record<string, number> = {};
  const nextCooldown: Record<string, number> = {};

  for (const [id, rem] of Object.entries(cooldown)) {
    if (rem > 1) nextCooldown[id] = rem - 1;
  }

  for (const [id, rem] of Object.entries(sticky)) {
    if (rem >= 999_000) {
      nextSticky[id] = rem;
    } else if (rem > 1) {
      nextSticky[id] = rem - 1;
    } else {
      const cd = byId.get(id)?.cooldownTurns ?? 0;
      if (cd > 0) nextCooldown[id] = cd;
    }
  }

  // Non-sticky entries that activated this turn immediately enter cooldown if configured
  for (const id of activatedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (!entry.stickyPermanent && entry.stickyTurns <= 0 && entry.cooldownTurns > 0 && !nextSticky[id]) {
      nextCooldown[id] = entry.cooldownTurns;
    }
  }

  return { sticky: nextSticky, cooldown: nextCooldown };
}
