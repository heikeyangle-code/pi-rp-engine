/**
 * Zero-dependency local HippoRAG 2 (Passage + Entity Hybrid 2-hop Personalized PageRank)
 * + Unified Denoised CJK/EN BM25 + Aho-Corasick Alias & Salience Coreference
 * + Reciprocal Rank Fusion (RRF, k=60) + Official SillyTavern World Info + Memory Books recall engine.
 */

import * as crypto from "node:crypto";
import type {
  CompiledLoreEntry,
  DreamBelief,
  EmbeddingConfig,
  LoreRecallTraceItem,
  MemoryBookEntry,
  PiMessage,
  SessionRpState,
} from "../types.js";
import { evaluateGate } from "../engine/gates.js";
import { parseInlineRegexKey, isSafeRegexPattern } from "../parser/lore-compiler.js";
import { estimateTokens, selectWithinTokenBudget } from "../context/token-budget.js";
import { getActiveFacts } from "./bitemporal.js";
import { type Bm25Index, bm25Scores, buildBm25Index, tokenizeBigram } from "./bm25.js";
import { getCachedSemanticRanking, reciprocalRankFusion } from "./embedding.js";
import type { EntityRegistry } from "./entity-registry.js";

/** Tokenize mixed Chinese/English text using the unified stopword-filtered CJK/EN tokenizer. */
export function tokenizeHybrid(text: string): string[] {
  return tokenizeBigram(text);
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

  if (
    entry.matchWholeWords &&
    /^[\p{L}\p{N}_\-'\s]+$/u.test(key) &&
    !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(key)
  ) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(key)}(?![\\p{L}\\p{N}_])`,
      entry.caseSensitive ? "u" : "iu",
    );
    return re.test(haystack);
  }
  if (entry.caseSensitive) {
    return haystack.includes(key);
  }
  return haystack.toLowerCase().includes(key.toLowerCase());
}

/** Find the first matching primary key if World Info entry matches haystack (also enforces selectiveLogic & excludeKeys). */
export function findMatchedWorldInfoKey(haystack: string, entry: CompiledLoreEntry): string | null {
  if (entry.keys.length === 0) return null;

  if (entry.excludeKeys.length > 0 && entry.excludeKeys.some((k) => matchWorldInfoKey(haystack, k, entry))) {
    return null;
  }

  const primaryKey = entry.keys.find((k) => matchWorldInfoKey(haystack, k, entry));
  if (!primaryKey) return null;

  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return primaryKey;
  }

  const secHits = entry.secondaryKeys.map((k) => matchWorldInfoKey(haystack, k, entry));
  switch (entry.selectiveLogic) {
    case "AND_ANY":
      return secHits.some(Boolean) ? primaryKey : null;
    case "AND_ALL":
      return secHits.every(Boolean) ? primaryKey : null;
    case "NOT_ANY":
      return !secHits.some(Boolean) ? primaryKey : null;
    case "NOT_ALL":
      return !secHits.every(Boolean) ? primaryKey : null;
  }
}

export function matchesWorldInfoKeys(haystack: string, entry: CompiledLoreEntry): boolean {
  return findMatchedWorldInfoKey(haystack, entry) !== null;
}

function deterministicUint32(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function deterministicPercent(seed: string): number {
  return deterministicUint32(seed) % 100;
}

/** Recall enabled Memory Book chapters by pinned flag, keyword/entity overlap, or BM25 similarity. */
export function recallMemoryBooks(
  state: SessionRpState,
  queryText: string,
  maxChapters = 6,
  memoryBookBudget?: number,
  registry?: EntityRegistry,
): { chapters: MemoryBookEntry[]; traces: LoreRecallTraceItem[] } {
  const all = Array.from(state.memoryBooks.values()).filter((m) => m.enabled && m.summary.trim());
  if (all.length === 0) return { chapters: [], traces: [] };

  const expanded = registry ? registry.expandQueryForRecall(queryText).expandedText : queryText;
  const hay = `${expanded}\n${state.location}\n${state.presentNpcs.join(" ")}`.toLowerCase();
  const qTokens = new Set(tokenizeHybrid(hay));

  const scored: Array<{ entry: MemoryBookEntry; score: number; reason: LoreRecallTraceItem["reason"]; matchedKey?: string }> = [];
  for (const ch of all) {
    if (ch.pinned) {
      scored.push({ entry: ch, score: 100 + ch.createdTurn * 0.01, reason: "pinned" });
      continue;
    }
    const matchedKey = [...ch.keywords, ...ch.entities].find((k) => k.trim() && hay.includes(k.trim().toLowerCase()));
    const docTokens = tokenizeHybrid(`${ch.title} ${ch.summary}`);
    let overlap = 0;
    for (const t of docTokens) {
      if (qTokens.has(t)) overlap++;
    }
    const bmScore = docTokens.length > 0 ? (overlap / Math.sqrt(docTokens.length)) * 2 : 0;
    if (matchedKey) {
      scored.push({ entry: ch, score: 10 + bmScore, reason: "direct_key", matchedKey });
    } else if (bmScore >= 0.9) {
      scored.push({ entry: ch, score: bmScore, reason: "bm25" });
    }
  }

  if (scored.length === 0) {
    const latest = all.sort((a, b) => b.createdTurn - a.createdTurn)[0];
    if (latest) {
      scored.push({ entry: latest, score: 1, reason: "static" });
    }
  }

  scored.sort((a, b) => b.score - a.score || b.entry.createdTurn - a.entry.createdTurn);
  const candidates = scored.slice(0, maxChapters);

  let picked = candidates;
  if (typeof memoryBookBudget === "number" && memoryBookBudget > 0) {
    picked = [];
    let usedTokens = 0;
    for (const item of candidates) {
      const cost = estimateTokens(`[${item.entry.title}] ${item.entry.summary}`);
      if (item.entry.pinned || usedTokens + cost <= memoryBookBudget || picked.length === 0) {
        picked.push(item);
        usedTokens += cost;
      }
    }
  }

  return {
    chapters: picked.map((p) => p.entry),
    traces: picked.map((p) => ({
      id: p.entry.id,
      title: p.entry.title,
      source: "memory_book",
      reason: p.reason,
      matchedKey: p.matchedKey,
      score: Number(p.score.toFixed(2)),
      tokens: estimateTokens(`[${p.entry.title}] ${p.entry.summary}`),
    })),
  };
}

/** RoleMemo DualMem query-relevant belief selection (alias-aware). */
export function selectRelevantBeliefs(
  state: SessionRpState,
  queryText: string,
  limit = 8,
  registry?: EntityRegistry,
): DreamBelief[] {
  if (state.beliefs.length === 0) return [];
  const norm = (n: string) => (registry ? registry.resolveCanonical(n).toLowerCase() : n.toLowerCase());
  const presentSet = new Set(state.presentNpcs.map(norm));
  const personaLower = norm(state.currentPersona.name);
  const expanded = registry ? registry.expandQueryForRecall(queryText).expandedText : queryText;
  const queryLower = expanded.toLowerCase();
  const queryTokens = new Set(tokenizeHybrid(queryLower));

  const scored = state.beliefs.map((b, idx) => {
    let score = 0;
    const actorLower = norm(b.actorId);
    const targetLower = norm(b.target);
    if (presentSet.has(actorLower)) score += 5;
    if (presentSet.has(targetLower) || targetLower === personaLower || targetLower === "player") score += 1.5;
    if (actorLower.length >= 2 && queryLower.includes(actorLower)) score += 3.5;
    if (targetLower.length >= 2 && targetLower !== "player" && queryLower.includes(targetLower)) score += 2.5;

    const beliefTokens = tokenizeHybrid(
      `${b.activatingEvent} ${b.belief} ${b.subjectiveInsight ?? ""} ${b.emotionalTone ?? ""}`,
    );
    let overlap = 0;
    for (const t of beliefTokens) {
      if (queryTokens.has(t)) overlap++;
    }
    if (overlap > 0) {
      score += Math.min(4.5, overlap * 0.85);
    }
    score += b.turn * 0.04 + idx * 0.001;
    return { belief: b, score };
  });

  scored.sort((a, b) => b.score - a.score || b.belief.turn - a.belief.turn);
  return scored.slice(0, limit).map((s) => s.belief);
}

interface CachedLoreEntryMeta {
  docIdx: number;
  baseEntities: string[];
  lowerContent: string;
  matchedCorpusEntities: string[];
}

interface CachedLoreCorpus {
  fingerprint: string;
  bm25: Bm25Index;
  byId: Map<string, CachedLoreEntryMeta>;
}

const loreCorpusCache = new WeakMap<CompiledLoreEntry[], CachedLoreCorpus>();

/** Full-corpus SHA-1 fingerprint covering EVERY entry's id, title, keys, entities, revision & content (never stale!). */
function computeEntriesFingerprint(entries: CompiledLoreEntry[]): string {
  const h = crypto.createHash("sha1");
  for (const e of entries) {
    h.update(
      `${e.id}|${e.revision ?? 1}|${e.title}|${e.keys.join(",")}|${e.entities.join(",")}|${e.content.length}|${e.content.slice(0, 48)}|${e.content.slice(-32)}\n`,
    );
  }
  return h.digest("hex");
}

function getOrBuildLoreCorpus(entries: CompiledLoreEntry[]): CachedLoreCorpus {
  const fp = computeEntriesFingerprint(entries);
  const existing = loreCorpusCache.get(entries);
  if (existing && existing.fingerprint === fp) {
    return existing;
  }

  // Field-weighted documents: title + keys weighted 2x over content for sharper precision
  const docs: string[] = [];
  const byId = new Map<string, CachedLoreEntryMeta>();
  const allCorpusEntities = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const header = `${e.title} ${e.keys.join(" ")}`;
    docs.push(`${header} ${header}\n${e.content}`);
    const baseEntities = Array.from(new Set(e.entities.map((ent) => ent.toLowerCase()).filter((x) => x.length >= 2)));
    for (const ent of baseEntities) {
      allCorpusEntities.add(ent);
    }
    byId.set(e.id, {
      docIdx: i,
      baseEntities,
      lowerContent: e.content.toLowerCase(),
      matchedCorpusEntities: [],
    });
  }

  const entityList = Array.from(allCorpusEntities);
  for (const e of entries) {
    const preventOut = e.preventRecursion ?? e.noGraphSpread;
    if (preventOut) continue;
    const item = byId.get(e.id)!;
    const matched: string[] = [];
    for (const ent of entityList) {
      if (item.lowerContent.includes(ent)) {
        matched.push(ent);
      }
    }
    item.matchedCorpusEntities = matched;
  }

  const bm25 = buildBm25Index(docs);
  const built: CachedLoreCorpus = { fingerprint: fp, bm25, byId };
  loreCorpusCache.set(entries, built);
  return built;
}

export interface RecallResult {
  selected: CompiledLoreEntry[];
  activatedIds: string[];
  nextSticky: Record<string, number>;
  nextCooldown: Record<string, number>;
  nextConsumedOneShots: string[];
  usedTokens: number;
  droppedCount: number;
  traces: LoreRecallTraceItem[];
  gatedOut: Array<{ id: string; title: string }>;
  budgetDropped: Array<{ id: string; title: string; tokens: number }>;
  aliasExpansions?: string[];
}

/**
 * Local Unified Denoised BM25 + HippoRAG 2 (Passage + Entity Bipartite PPR) + AC Alias/Salience
 * + RRF + Official SillyTavern World Info recall engine.
 */
export function recallLoreWithGraphPpr(options: {
  entries: CompiledLoreEntry[];
  state: SessionRpState;
  recentText: string;
  messages?: PiMessage[];
  defaultScanDepth?: number;
  tokenBudget: number;
  manualQuery?: string;
  registry?: EntityRegistry;
  embeddingConfig?: EmbeddingConfig;
  minActivations?: number;
}): RecallResult {
  const {
    entries,
    state,
    recentText,
    messages,
    defaultScanDepth = 4,
    tokenBudget,
    manualQuery,
    registry,
    embeddingConfig,
    minActivations = 0,
  } = options;
  const isManual = Boolean(manualQuery);
  const rawQueryText = isManual ? manualQuery! : recentText;

  // AC Alias & Salience Coreference query expansion
  const expansion = registry
    ? registry.expandQueryForRecall(rawQueryText, { messages, presentNpcs: state.presentNpcs })
    : null;
  const queryText = expansion?.expandedText ?? rawQueryText;
  const aliasExpansions = [
    ...(expansion?.matchedAliases.map((m) => `${m.alias}→${m.canonical}`) ?? []),
    ...(expansion?.salienceResolved.map((s) => `指代→${s}`) ?? []),
  ];

  const cleanMessages = messages?.filter(
    (m) => m.customType !== "rp:ooc" && m.customType !== "rp:event",
  );

  const depthTextCache = new Map<number, string>();
  const getHaystackForEntry = (entry: CompiledLoreEntry, extraDepthBoost = 0): string => {
    if (isManual || !cleanMessages || cleanMessages.length === 0 || (!entry.scanDepthOverride && extraDepthBoost === 0)) {
      return queryText;
    }
    const d = Math.max(1, (entry.scanDepthOverride ?? defaultScanDepth) + extraDepthBoost);
    let cached = depthTextCache.get(d);
    if (cached === undefined) {
      const rawSlice = cleanMessages.slice(-d).map(extractMsgText).join("\n");
      cached = registry ? registry.expandQueryForRecall(rawSlice, { presentNpcs: state.presentNpcs }).expandedText : rawSlice;
      depthTextCache.set(d, cached);
    }
    return cached;
  };

  const gatedOut: Array<{ id: string; title: string }> = [];

  // 1. Filter eligible dynamic entries
  const eligible = entries.filter((e) => {
    const effectiveEnabled = state.loreOverrides[e.id] ?? e.enabled;
    if (!effectiveEnabled || !e.content) return false;
    if (e.constant && !isManual) return false;
    if (e.manualRecallOnly && !isManual) return false;
    if (!evaluateGate(e.gate, state, registry)) {
      gatedOut.push({ id: e.id, title: e.title });
      return false;
    }
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
      traces: [],
      gatedOut,
      budgetDropped: [],
      aliasExpansions,
    };
  }

  // 2. Unified denoised BM25 scoring via bm25.ts (deduplicated queryTokens + CJK/EN stopwords!)
  const corpus = getOrBuildLoreCorpus(entries);
  const eligibleDocSet = new Set<number>();
  for (const e of eligible) {
    const meta = corpus.byId.get(e.id);
    if (meta) eligibleDocSet.add(meta.docIdx);
  }
  const queryTokens = Array.from(new Set(tokenizeBigram(queryText)));
  const rawBm25Array = bm25Scores(queryTokens, corpus.bm25, eligibleDocSet);

  const bm25ScoreMap = new Map<string, number>();
  for (const e of eligible) {
    const meta = corpus.byId.get(e.id);
    bm25ScoreMap.set(e.id, meta ? (rawBm25Array[meta.docIdx] ?? 0) : 0);
  }

  // Adaptive BM25 threshold: scales cleanly with query vocabulary size so long 4-turn chats don't flood noise!
  const adaptiveBm25Threshold = isManual
    ? 0.45
    : Math.max(4.8, 2.8 + Math.log2(Math.max(4, queryTokens.length)) * 1.35);

  // 3. HippoRAG 2 Bipartite Graph: Passage Nodes + Entity Nodes -> 2-hop PPR
  const entityToEntries = new Map<string, Set<string>>();
  const entryToEntities = new Map<string, Set<string>>();
  const eligibleById = new Map(eligible.map((e) => [e.id, e]));

  for (const e of eligible) {
    const meta = corpus.byId.get(e.id)!;
    const ents = new Set<string>();
    for (const norm of meta.baseEntities) {
      const canon = registry ? registry.resolveCanonical(norm).toLowerCase() : norm;
      ents.add(canon);
      if (!entityToEntries.has(canon)) entityToEntries.set(canon, new Set());
      entityToEntries.get(canon)!.add(e.id);
      if (canon !== norm) {
        ents.add(norm);
        if (!entityToEntries.has(norm)) entityToEntries.set(norm, new Set());
        entityToEntries.get(norm)!.add(e.id);
      }
    }
    entryToEntities.set(e.id, ents);
  }

  const allEntityNames = Array.from(entityToEntries.keys());
  for (const e of eligible) {
    const preventOut = e.preventRecursion ?? e.noGraphSpread;
    if (preventOut) continue;
    const meta = corpus.byId.get(e.id)!;
    const ents = entryToEntities.get(e.id)!;
    for (const ent of meta.matchedCorpusEntities) {
      const canon = registry ? registry.resolveCanonical(ent).toLowerCase() : ent;
      if (entityToEntries.has(canon)) {
        ents.add(canon);
        // Only link back into entityToEntries if the target entry allows being recursively reached
        if (!(e.excludeRecursion ?? false)) {
          entityToEntries.get(canon)!.add(e.id);
        }
      }
    }
  }

  // Cross-entity co-occurrence bridges from active Bi-Temporal Facts & Memory Books
  const entityCooccur = new Map<string, Set<string>>();
  const linkEntities = (rawList: string[]) => {
    const norms = Array.from(
      new Set(
        rawList
          .map((x) => (registry ? registry.resolveCanonical(x) : x).trim().toLowerCase())
          .filter((x) => x.length >= 2),
      ),
    );
    if (norms.length < 2) return;
    for (let i = 0; i < norms.length; i++) {
      for (let j = i + 1; j < norms.length; j++) {
        const a = norms[i]!;
        const b = norms[j]!;
        if (!entityCooccur.has(a)) entityCooccur.set(a, new Set());
        if (!entityCooccur.has(b)) entityCooccur.set(b, new Set());
        entityCooccur.get(a)!.add(b);
        entityCooccur.get(b)!.add(a);
      }
    }
  };
  const activeFacts = getActiveFacts(state, registry);
  for (const fact of activeFacts) linkEntities(fact.entities);
  for (const ch of state.memoryBooks.values()) {
    if (!ch.enabled) continue;
    linkEntities([...ch.entities, ...ch.keywords]);
  }

  // Seed entity scores from expanded query + AC matched canonicals + location + presentNpcs
  const seedContext = `${queryText}\n${state.location}\n${state.presentNpcs.join(" ")}`.toLowerCase();
  const seedEntities = new Map<string, number>();
  const allKnownEntities = new Set<string>([...allEntityNames, ...entityCooccur.keys()]);
  for (const ent of allKnownEntities) {
    if (ent.length >= 2 && seedContext.includes(ent)) {
      seedEntities.set(ent, 1.0);
    }
  }
  if (expansion) {
    for (const c of expansion.matchedCanonicals) {
      const cl = c.toLowerCase();
      if (entityToEntries.has(cl) || entityCooccur.has(cl)) {
        seedEntities.set(cl, Math.max(seedEntities.get(cl) ?? 0, 1.15));
      }
    }
  }

  // 1-hop entity-to-entity bridges from active Facts & Memory Books
  const bridgedSeeds = new Map<string, number>();
  for (const [ent, weight] of seedEntities.entries()) {
    const coList = entityCooccur.get(ent);
    if (!coList || coList.size === 0) continue;
    const share = (weight * 0.65) / coList.size;
    for (const linkedEnt of coList) {
      if (!seedEntities.has(linkedEnt) && entityToEntries.has(linkedEnt)) {
        bridgedSeeds.set(linkedEnt, (bridgedSeeds.get(linkedEnt) ?? 0) + share);
      }
    }
  }
  for (const [ent, w] of bridgedSeeds.entries()) {
    seedEntities.set(ent, (seedEntities.get(ent) ?? 0) + w);
  }

  // Pre-evaluate direct key hits & sticky status (with optional minActivations progressive scanDepth)
  const directKeyMap = new Map<string, string | null>();
  const stickyActiveMap = new Map<string, boolean>();
  for (const e of eligible) {
    const haystack = getHaystackForEntry(e);
    directKeyMap.set(e.id, findMatchedWorldInfoKey(haystack, e));
    stickyActiveMap.set(e.id, !isManual && (state.loreSticky[e.id] ?? 0) > 0);
  }

  // Progressive scanDepth expansion if minActivations > 0 and too few direct hits
  if (!isManual && minActivations > 0 && cleanMessages && cleanMessages.length > defaultScanDepth) {
    let directCount = 0;
    for (const v of directKeyMap.values()) if (v) directCount++;
    if (directCount < minActivations) {
      for (const boost of [4, 8, 16]) {
        for (const e of eligible) {
          if (directKeyMap.get(e.id)) continue;
          const widerHay = getHaystackForEntry(e, boost);
          const hit = findMatchedWorldInfoKey(widerHay, e);
          if (hit) {
            directKeyMap.set(e.id, hit);
            directCount++;
          }
        }
        if (directCount >= minActivations) break;
      }
    }
  }

  // HippoRAG 2: 2-hop PPR with Passage Nodes (0.05 reset weight for top BM25 passages) + Entity Nodes
  const pprEntryScores = new Map<string, number>();
  const damping = 0.85;
  const hop1Entry = new Map<string, number>();

  for (const [ent, weight] of seedEntities.entries()) {
    const neighbors = entityToEntries.get(ent);
    if (!neighbors || neighbors.size === 0) continue;
    const share = weight / neighbors.size;
    for (const entryId of neighbors) {
      const target = eligibleById.get(entryId);
      // Respect strict matchWholeWords on hop-1 entity seeding too
      if (target?.matchWholeWords && !directKeyMap.get(entryId)) continue;
      hop1Entry.set(entryId, (hop1Entry.get(entryId) ?? 0) + share);
    }
  }

  // Passage-level seed reset (HippoRAG 2: 0.05 weight on high-BM25 passages)
  const topBm25ForPpr = eligible
    .map((e) => ({ id: e.id, score: bm25ScoreMap.get(e.id) ?? 0, entry: e }))
    .filter((x) => x.score >= adaptiveBm25Threshold && !(x.entry.matchWholeWords && !directKeyMap.get(x.id)))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  for (const p of topBm25ForPpr) {
    hop1Entry.set(p.id, (hop1Entry.get(p.id) ?? 0) + Math.min(0.6, p.score * 0.05));
  }

  for (const e of eligible) {
    if (directKeyMap.get(e.id) || stickyActiveMap.get(e.id)) {
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
      // preventRecursion blocks OUTGOING spread from this entry's content
      const preventOut = entry ? (entry.preventRecursion ?? entry.noGraphSpread) : true;
      if (!entry || preventOut) continue;
      const ents = entryToEntities.get(entryId);
      if (!ents || ents.size === 0) continue;
      const share = (weight * damping) / ents.size;
      for (const ent of ents) {
        hop2Entity.set(ent, (hop2Entity.get(ent) ?? 0) + share);
        const coList = entityCooccur.get(ent);
        if (coList && coList.size > 0) {
          const coShare = (share * 0.5) / coList.size;
          for (const linked of coList) {
            hop2Entity.set(linked, (hop2Entity.get(linked) ?? 0) + coShare);
          }
        }
      }
    }
    for (const [ent, weight] of hop2Entity.entries()) {
      const neighbors = entityToEntries.get(ent);
      if (!neighbors || neighbors.size === 0) continue;
      const share = weight / neighbors.size;
      for (const entryId of neighbors) {
        const target = eligibleById.get(entryId);
        // excludeRecursion strictly blocks INCOMING hop-2 recursion activation!
        if (!target || target.excludeRecursion) continue;
        if (target.matchWholeWords && !directKeyMap.get(entryId)) continue;
        pprEntryScores.set(entryId, (pprEntryScores.get(entryId) ?? 0) + share * 0.65);
      }
    }
  }

  // Optional non-blocking cached semantic ranking (when user enabled embeddings & cache is warm)
  const semanticScoreMap = new Map<string, number>();
  if (embeddingConfig?.enabled) {
    const docs = eligible.map((e) => `${e.title}: ${e.content.slice(0, 1200)}`);
    const cachedSem = getCachedSemanticRanking(embeddingConfig, rawQueryText, docs, 0.32);
    if (cachedSem && cachedSem.length > 0) {
      for (const hit of cachedSem.slice(0, 12)) {
        const entry = eligible[hit.index];
        if (entry) semanticScoreMap.set(entry.id, hit.similarity);
      }
    }
  }

  // RRF fusion bonus across BM25 + PPR + Semantic channels
  const bm25RankedIds = eligible
    .filter((e) => (bm25ScoreMap.get(e.id) ?? 0) >= adaptiveBm25Threshold)
    .sort((a, b) => (bm25ScoreMap.get(b.id) ?? 0) - (bm25ScoreMap.get(a.id) ?? 0))
    .map((e) => e.id);
  const pprRankedIds = eligible
    .filter((e) => (pprEntryScores.get(e.id) ?? 0) >= 0.12)
    .sort((a, b) => (pprEntryScores.get(b.id) ?? 0) - (pprEntryScores.get(a.id) ?? 0))
    .map((e) => e.id);
  const semRankedIds = Array.from(semanticScoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  const rrfFused = reciprocalRankFusion(bm25RankedIds, pprRankedIds, 60);
  const rrfWithSem = semRankedIds.length > 0
    ? reciprocalRankFusion(rrfFused.map((x) => x.id), semRankedIds, 60)
    : rrfFused;
  const rrfMap = new Map(rrfWithSem.map((x) => [x.id, x.score]));

  // 4. Combine direct key match, sticky, staticPrebound, denoised BM25, 2-hop PPR, and cached Semantic RRF
  const activated: Array<{
    entry: CompiledLoreEntry;
    score: number;
    reason: LoreRecallTraceItem["reason"];
    matchedKey?: string;
  }> = [];

  for (const e of eligible) {
    const haystack = getHaystackForEntry(e);
    const isStickyActive = stickyActiveMap.get(e.id) ?? false;
    const matchedKey = directKeyMap.get(e.id) ?? undefined;
    const directHit = Boolean(matchedKey);
    const ppr = pprEntryScores.get(e.id) ?? 0;
    const bm25 = bm25ScoreMap.get(e.id) ?? 0;
    const semSim = semanticScoreMap.get(e.id) ?? 0;

    if (!isStickyActive && !isManual) {
      if (e.excludeKeys.length > 0 && e.excludeKeys.some((k) => matchWorldInfoKey(haystack, k, e))) {
        continue;
      }
      if (e.selective && e.secondaryKeys.length > 0) {
        if (e.selectiveLogic === "AND_ANY" && !e.secondaryKeys.some((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
        if (e.selectiveLogic === "AND_ALL" && !e.secondaryKeys.every((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
        if (e.selectiveLogic === "NOT_ANY" && e.secondaryKeys.some((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
        if (e.selectiveLogic === "NOT_ALL" && e.secondaryKeys.every((k) => matchWorldInfoKey(haystack, k, e))) {
          continue;
        }
      }
      // Strict matchWholeWords guard: never let fuzzy BM25 bypass an explicit whole-word entry!
      if (e.matchWholeWords && !directHit && semSim < 0.45) {
        continue;
      }
    }

    const graphOnlyBlocked = e.graphSecondHopOnly && !isManual && ppr < 0.08;
    if (graphOnlyBlocked && !isStickyActive) continue;

    const staticTrigger = e.staticPrebound && (state.turn <= 1 || bm25 >= adaptiveBm25Threshold * 0.5 || ppr >= 0.08);
    const bm25Triggered = bm25 >= adaptiveBm25Threshold;
    const pprTriggered = ppr >= 0.12;
    const semTriggered = semSim >= 0.36;

    const triggered =
      isStickyActive ||
      directHit ||
      staticTrigger ||
      pprTriggered ||
      bm25Triggered ||
      semTriggered;

    if (!triggered) continue;

    if (!isStickyActive && !isManual && e.useProbability && e.probability < 100) {
      const roll = deterministicPercent(`${state.turn}:${e.id}`);
      if (roll >= e.probability) continue;
    }

    const reason: LoreRecallTraceItem["reason"] = isStickyActive
      ? "sticky"
      : directHit
        ? "direct_key"
        : pprTriggered
          ? "ppr_2hop"
          : semTriggered && !bm25Triggered
            ? "semantic_rrf"
            : staticTrigger
              ? "static"
              : "bm25";

    const rrfBoost = (rrfMap.get(e.id) ?? 0) * 180;
    const totalScore =
      (isStickyActive ? 14 : 0) +
      (directHit ? 12 : 0) +
      (e.staticPrebound ? 2 : 0) +
      ppr * 6 +
      bm25 * 1.2 +
      semSim * 10 +
      rrfBoost;

    activated.push({ entry: e, score: totalScore, reason, matchedKey });
  }

  // 5. Exclusive group resolution (`group` + `groupOverride` + `groupWeight`)
  const byGroup = new Map<string, typeof activated>();
  const ungrouped: typeof activated = [];

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
    const pick = deterministicUint32(`${state.turn}:group:${groupName}`) % totalWeight;
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

  const metaById = new Map(afterGroup.map((a) => [a.entry.id, a]));

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

  const selectedIds = new Set(budgeted.selected.map((e) => e.id));
  const budgetDropped = afterGroup
    .filter((a) => !selectedIds.has(a.entry.id))
    .map((a) => ({
      id: a.entry.id,
      title: a.entry.title,
      tokens: estimateTokens(`[${a.entry.title}]\n${a.entry.content}`),
    }));

  const selected = [...budgeted.selected].sort(
    (a, b) => b.depthHint - a.depthHint || b.priority - a.priority || a.id.localeCompare(b.id),
  );

  const traces: LoreRecallTraceItem[] = selected.map((e) => {
    const meta = metaById.get(e.id);
    return {
      id: e.id,
      title: e.title,
      source: "lore",
      reason: meta?.reason ?? "bm25",
      matchedKey: meta?.matchedKey,
      score: Number((meta?.score ?? 0).toFixed(2)),
      tokens: estimateTokens(`[${e.title}]\n${e.content}`),
    };
  });

  // 7. Compute next sticky / cooldown / oneShot runtime maps
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
    traces,
    gatedOut,
    budgetDropped,
    aliasExpansions,
  };
}

/** Advance sticky & cooldown counters by 1 turn at `turn_end`. */
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
      const entry = byId.get(id);
      if (entry && entry.cooldownTurns > 0) {
        nextCooldown[id] = entry.cooldownTurns;
      }
    }
  }

  for (const id of activatedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    if (entry.cooldownTurns > 0 && !nextSticky[id] && entry.stickyTurns === 0 && !entry.stickyPermanent) {
      nextCooldown[id] = entry.cooldownTurns;
    }
  }

  return { sticky: nextSticky, cooldown: nextCooldown };
}
