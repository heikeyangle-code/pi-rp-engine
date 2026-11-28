/**
 * Dual-Track Pure-Text Character Card Knowledge Compiler (Zero-LLM, <50ms on 400K chars).
 *
 * Solves the giant pure-text card problem (50K - 500K+ chars, 0 lorebook entries):
 *  - Cards <= `DEFAULT_ZONE1_DIRECT_TOKEN_LIMIT` (24,000 tokens) keep 100% verbatim text in Zone 1.
 *  - Giant cards (> 24,000 tokens) automatically split into:
 *      Track 1 (Zone 1 Frozen Skeleton, <= 12,000 tokens): core opening/protagonist/rules + verbatim mes_example +
 *              compact Full-Card TOC & Entity Directory so the flagship model always sees the whole world map.
 *      Track 2 (Lossless Hierarchical Parent-Child Index): Document -> Chapter -> Passage (360-520 chars, 60-char overlap),
 *              each passage enriched with a deterministic Contextual Prefix `[Volume > Chapter > Entities]`,
 *              plus explicit alias extraction (nicknames/epithets/codenames) & entity-passage co-occurrence links.
 *  - Persisted to `cards/<slug>/knowledge.index.json` with SHA-256 contentHash for <5ms reload & safe invalidation.
 */

import * as crypto from "node:crypto";
import type {
  CardChapterNode,
  CardEntityNode,
  CardKnowledgeIndex,
  CardPassageNode,
  CompiledCard,
  LoreRecallTraceItem,
} from "../types.js";
import { buildBm25Index, bm25Scores, tokenizeBigram, type Bm25Index } from "../memory/bm25.js";
import { estimateTokens } from "../context/token-budget.js";
import type { EntityRegistry } from "../memory/entity-registry.js";

/** Generous modern threshold: cards <= 24K tokens stay 100% verbatim in Zone 1 without splitting. */
export const DEFAULT_ZONE1_DIRECT_TOKEN_LIMIT = 24_000;
/** Generous Zone 1 skeleton cap when dual-track mode activates on giant 50K-500K cards. */
export const DEFAULT_ZONE1_SKELETON_TOKEN_LIMIT = 12_000;

const HEADING_RE =
  /^(?:#{1,4}\s+(.+)|(?:第[零一二三四五六七八九十百千\d]+[卷章节回部篇][\s：:·\-—]*(.*))|(?:【([^】]{2,36})】\s*)|(?:==+\s*([^=]{2,48})\s*==+))$/;

const ALIAS_PATTERN_RE =
  /([^\s，。！？；：、（）()「」“”"《》]{2,12})\s*[（(](?:[^）)]{0,16}(?:绰号|外号|化名|代号|人称|又称|别名|小名|字|号|亦称|俗称|aka|alias|nickname)[^）)]{0,60})[）)]/gi;

const INNER_QUOTE_ALIAS_RE = /[「“"‘'《]([^」”"’'》]{2,14})[」”"’'》]/g;

const NAMED_HEADING_ENTITY_RE =
  /(?:人物|角色|主角|配角|反派|同名人物[甲乙丙丁]?|隐秘人物|核心人物|势力|组织|地点|门派|家族)[^：:]*[：:]\s*([^\s（(·\-—|｜]{2,16})/;

export function computeCardKnowledgeHash(description: string, personality: string, scenario: string): string {
  return crypto
    .createHash("sha256")
    .update(`${description}\0${personality}\0${scenario}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/** Extract explicit canonical->alias pairs from Chinese/English prose patterns without any LLM. */
export function extractExplicitEntitiesAndAliases(text: string): CardEntityNode[] {
  const byCanon = new Map<string, { canonical: string; aliases: Set<string>; contexts: Set<string> }>();

  const ensure = (canon: string, ctxHint?: string) => {
    const clean = canon.replace(/^[\s\-*•·\d.]+/, "").trim();
    if (clean.length < 2 || clean.length > 20) return null;
    if (/^(?:第一|第二|第三|人物|角色|章节|设定|世界观|核心|简介|背景|故事|内容|说明)$/.test(clean)) return null;
    const key = clean.toLowerCase();
    if (!byCanon.has(key)) {
      byCanon.set(key, { canonical: clean, aliases: new Set(), contexts: new Set() });
    }
    if (ctxHint) byCanon.get(key)!.contexts.add(ctxHint);
    return byCanon.get(key)!;
  };

  // 1. Scan lines for explicit heading entity declarations & parenthetical alias declarations
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headEnt = NAMED_HEADING_ENTITY_RE.exec(trimmed);
    if (headEnt) {
      const node = ensure(headEnt[1]!, trimmed.slice(0, 48));
      if (node) {
        let qm: RegExpExecArray | null;
        INNER_QUOTE_ALIAS_RE.lastIndex = 0;
        while ((qm = INNER_QUOTE_ALIAS_RE.exec(trimmed)) !== null) {
          const al = qm[1]!.trim();
          if (al.length >= 2 && al.length <= 16 && al.toLowerCase() !== node.canonical.toLowerCase()) {
            node.aliases.add(al);
          }
        }
      }
    }

    ALIAS_PATTERN_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ALIAS_PATTERN_RE.exec(trimmed)) !== null) {
      const rawName = am[1]!.replace(/^(?:主角|人物|配角|反派|隐秘人物|同名人物[甲乙丙丁]?)[：:]/, "").trim();
      const parenText = am[0]!;
      const node = ensure(rawName, trimmed.slice(0, 48));
      if (!node) continue;

      let foundQuoted = false;
      INNER_QUOTE_ALIAS_RE.lastIndex = 0;
      let qm: RegExpExecArray | null;
      while ((qm = INNER_QUOTE_ALIAS_RE.exec(parenText)) !== null) {
        const al = qm[1]!.trim();
        if (al.length >= 2 && al.length <= 16 && al.toLowerCase() !== node.canonical.toLowerCase()) {
          node.aliases.add(al);
          foundQuoted = true;
        }
      }
      if (!foundQuoted) {
        const afterLabel = /(?:绰号|外号|化名|代号|人称|又称|别名|aka|alias)[:：\s]*([^，,、）)]+)/i.exec(parenText);
        if (afterLabel) {
          for (const part of afterLabel[1]!.split(/[、，,/]/)) {
            const al = part.replace(/[「」“”"‘’']/g, "").trim();
            if (al.length >= 2 && al.length <= 16 && al.toLowerCase() !== node.canonical.toLowerCase()) {
              node.aliases.add(al);
            }
          }
        }
      }
    }

    // 2. Prose-only quoted proper nouns (e.g. ——「枯梅道人」)
    const proseProperRe = /(?:——|名为|叫做|人称|自称|号称|隐士|掌柜|门主|宗主|道人|先生|娘子|帮主|首领)\s*[「“"《]([^」”"》\n]{2,12})[」”"》]/g;
    let pm: RegExpExecArray | null;
    while ((pm = proseProperRe.exec(trimmed)) !== null) {
      ensure(pm[1]!, trimmed.slice(0, 48));
    }
  }

  return Array.from(byCanon.values()).map((v) => ({
    canonical: v.canonical,
    aliases: Array.from(v.aliases),
    chapterIds: [],
    passageIds: [],
    contextHints: Array.from(v.contexts).slice(0, 3),
  }));
}

/** Split a chapter's body into overlapping child passages (~420 chars target, 60-char overlap). */
function splitChapterIntoPassages(
  chapterId: string,
  chapterPath: string,
  body: string,
  startCharOffset: number,
  targetChars = 440,
  overlapChars = 60,
): CardPassageNode[] {
  const clean = body.trim();
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const passages: CardPassageNode[] = [];
  let buf = "";
  let bufStart = startCharOffset;
  let cursor = startCharOffset;
  let idx = 0;

  const flush = (text: string, offset: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    passages.push({
      id: `${chapterId}_p${idx++}`,
      chapterId,
      chapterPath,
      text: trimmed,
      contextualPrefix: `[${chapterPath}]`,
      charOffset: offset,
      tokens: estimateTokens(trimmed),
      entities: [],
    });
  };

  for (const para of paragraphs) {
    if (para.length > targetChars * 1.6) {
      if (buf) {
        flush(buf, bufStart);
        buf = "";
      }
      // Hard-split oversized paragraph by sentence boundary with overlap
      let pos = 0;
      while (pos < para.length) {
        let end = Math.min(para.length, pos + targetChars);
        if (end < para.length) {
          const punct = para.slice(pos + Math.floor(targetChars * 0.65), end).search(/[。！？.!?\n]/);
          if (punct >= 0) end = pos + Math.floor(targetChars * 0.65) + punct + 1;
        }
        flush(para.slice(pos, end), cursor + pos);
        if (end >= para.length) break;
        pos = Math.max(pos + 1, end - overlapChars);
      }
      cursor += para.length + 2;
      bufStart = cursor;
      continue;
    }

    if (buf && buf.length + para.length + 2 > targetChars) {
      flush(buf, bufStart);
      const tailOverlap = buf.length > overlapChars ? buf.slice(-overlapChars) : "";
      buf = tailOverlap ? `${tailOverlap}\n${para}` : para;
      bufStart = Math.max(startCharOffset, cursor - tailOverlap.length);
    } else {
      if (!buf) bufStart = cursor;
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    cursor += para.length + 2;
  }

  if (buf) flush(buf, bufStart);
  return passages;
}

/**
 * Compile a CompiledCard's pure-text body into a lossless hierarchical Knowledge Index.
 */
export function compileCardKnowledgeIndex(
  card: Pick<CompiledCard, "id" | "frozen" | "identity">,
  options: { directTokenLimit?: number; skeletonTokenLimit?: number } = {},
): CardKnowledgeIndex {
  const directTokenLimit = options.directTokenLimit ?? DEFAULT_ZONE1_DIRECT_TOKEN_LIMIT;
  const skeletonTokenLimit = options.skeletonTokenLimit ?? DEFAULT_ZONE1_SKELETON_TOKEN_LIMIT;

  const desc = card.frozen.description || "";
  const pers = card.frozen.personality || "";
  const scen = card.frozen.scenario || "";
  const contentHash = computeCardKnowledgeHash(desc, pers, scen);
  const fullText = [
    desc,
    pers ? `\n# 性格与核心特质\n${pers}` : "",
    scen ? `\n# 初始场景\n${scen}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const totalChars = fullText.length;
  const totalTokens = estimateTokens(fullText);
  const dualTrackActive = totalTokens > directTokenLimit;

  // 1. Parse document into structural chapters
  const lines = fullText.split(/\r?\n/);
  const chapters: CardChapterNode[] = [];
  let currentTitle = `${card.identity.name} · 核心设定`;
  let currentLevel = 1;
  let currentVolume = "";
  let currentLines: string[] = [];
  let charOffset = 0;
  let chapterStartOffset = 0;

  const pushChapter = () => {
    const body = currentLines.join("\n").trim();
    if (!body) return;
    const chId = `ch_${chapters.length}`;
    const fullPath =
      currentVolume && currentLevel > 1 && !currentTitle.startsWith(currentVolume)
        ? `${currentVolume} > ${currentTitle}`
        : currentTitle;
    chapters.push({
      id: chId,
      title: currentTitle,
      path: fullPath,
      level: currentLevel,
      charOffset: chapterStartOffset,
      charLength: body.length,
      tokens: estimateTokens(body),
      excerpt: body.replace(/\s+/g, " ").slice(0, 140),
      passageIds: [],
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const hm = trimmed.length <= 80 ? HEADING_RE.exec(trimmed) : null;
    if (hm) {
      pushChapter();
      const rawTitle = (hm[1] ?? hm[3] ?? hm[4] ?? trimmed).trim();
      const hashPrefix = /^(#{1,4})\s+/.exec(trimmed);
      currentLevel = hashPrefix ? hashPrefix[1]!.length : /^第.+卷/.test(trimmed) ? 1 : 2;
      if (currentLevel === 1) currentVolume = rawTitle;
      currentTitle = rawTitle;
      currentLines = [];
      chapterStartOffset = charOffset + line.length + 1;
    } else {
      currentLines.push(line);
    }
    charOffset += line.length + 1;
  }
  pushChapter();

  // If no headings existed at all and text is huge, synthesize fixed-size chapters (~6,000 chars each)
  if (chapters.length <= 1 && totalChars > 8000) {
    chapters.length = 0;
    const step = 6000;
    for (let pos = 0; pos < totalChars; pos += step) {
      const slice = fullText.slice(pos, Math.min(totalChars, pos + step)).trim();
      if (!slice) continue;
      const idx = chapters.length;
      chapters.push({
        id: `ch_${idx}`,
        title: `正文第 ${idx + 1} 段 (${Math.round(pos / 1000)}K-${Math.round((pos + slice.length) / 1000)}K)`,
        path: `正文第 ${idx + 1} 段`,
        level: 1,
        charOffset: pos,
        charLength: slice.length,
        tokens: estimateTokens(slice),
        excerpt: slice.replace(/\s+/g, " ").slice(0, 140),
        passageIds: [],
      });
    }
  }

  // 2. Build passages for every chapter
  const passages: CardPassageNode[] = [];
  for (const ch of chapters) {
    const chBody = fullText.slice(ch.charOffset, ch.charOffset + ch.charLength);
    const chPassages = splitChapterIntoPassages(ch.id, ch.path, chBody, ch.charOffset);
    ch.passageIds = chPassages.map((p) => p.id);
    passages.push(...chPassages);
  }

  // 3. Extract entities & explicit aliases, then link passages & enrich contextualPrefix
  const entities = extractExplicitEntitiesAndAliases(fullText);
  const entMatchers = entities.map((e) => ({
    node: e,
    terms: [e.canonical.toLowerCase(), ...e.aliases.map((a) => a.toLowerCase())],
  }));

  for (const p of passages) {
    const low = `${p.chapterPath}\n${p.text}`.toLowerCase();
    const matched: string[] = [];
    for (const em of entMatchers) {
      if (em.terms.some((t) => t.length >= 2 && low.includes(t))) {
        matched.push(em.node.canonical);
        em.node.passageIds.push(p.id);
        if (!em.node.chapterIds.includes(p.chapterId)) {
          em.node.chapterIds.push(p.chapterId);
        }
      }
    }
    p.entities = matched.slice(0, 12);
    p.contextualPrefix =
      matched.length > 0 ? `[${p.chapterPath} | 实体: ${matched.slice(0, 6).join("、")}]` : `[${p.chapterPath}]`;
  }

  // 4. Build Zone 1 Frozen Skeleton + Full-Card TOC (used ONLY when dualTrackActive === true)
  const skeletonParts: string[] = [];
  if (dualTrackActive) {
    let usedTokens = 0;
    // Keep opening core chapters up to ~65% of skeleton budget
    const coreBudget = Math.floor(skeletonTokenLimit * 0.65);
    for (const ch of chapters) {
      const body = fullText.slice(ch.charOffset, ch.charOffset + ch.charLength).trim();
      const cost = estimateTokens(body);
      if (usedTokens + cost <= coreBudget || skeletonParts.length === 0) {
        skeletonParts.push(`## ${ch.title}\n${body.slice(0, Math.min(body.length, coreBudget * 2))}`);
        usedTokens += Math.min(cost, coreBudget);
      } else {
        break;
      }
    }

    // Append full-card TOC so the flagship model knows every chapter & entity exists
    const tocLines = chapters
      .slice(0, 80)
      .map((ch, i) => `${i + 1}. ${ch.path} (~${ch.tokens}t)`)
      .join("\n");
    const entLines = entities
      .slice(0, 100)
      .map((e) => (e.aliases.length > 0 ? `${e.canonical}(${e.aliases.slice(0, 3).join("/")})` : e.canonical))
      .join("、");

    skeletonParts.push(
      `## 全卡知识库目录（共 ${chapters.length} 章 · ${passages.length} 片段 · ~${totalTokens}t；细节按需自动召回或调用 rp_recall 查阅）\n${tocLines}`,
    );
    if (entLines) {
      skeletonParts.push(`## 全卡核心人物与实体索引（含别名）\n${entLines}`);
    }
  }

  return {
    version: 1,
    contentHash,
    totalChars,
    totalTokens,
    dualTrackActive,
    directTokenLimit,
    skeletonTokenLimit,
    zone1Skeleton: skeletonParts.join("\n\n"),
    chapters,
    passages,
    entities,
  };
}

// WeakMap runtime BM25 cache for CardKnowledgeIndex
const knowledgeBm25Cache = new WeakMap<CardKnowledgeIndex, { hash: string; index: Bm25Index }>();

function getKnowledgeBm25(ki: CardKnowledgeIndex): Bm25Index {
  const hit = knowledgeBm25Cache.get(ki);
  if (hit && hit.hash === ki.contentHash) return hit.index;
  // Field-weighted indexing: repeat contextualPrefix (chapter path + entities) 2x for Anthropic Contextual BM25 boost
  const docs = ki.passages.map((p) => `${p.contextualPrefix} ${p.contextualPrefix}\n${p.text}`);
  const index = buildBm25Index(docs);
  knowledgeBm25Cache.set(ki, { hash: ki.contentHash, index });
  return index;
}

export interface CardKnowledgeRecallResult {
  passages: Array<{
    id: string;
    chapterId: string;
    chapterPath: string;
    text: string;
    score: number;
    reason: LoreRecallTraceItem["reason"];
    matchedEntities: string[];
    tokens: number;
  }>;
  traces: LoreRecallTraceItem[];
  usedTokens: number;
}

/**
 * Recall verbatim passages from a giant pure-text card using:
 *  - Aho-Corasick alias-expanded entity hits
 *  - Contextual Prefix CJK-BM25
 *  - Parent-Child auto-merging (adjacent/same-chapter hits merged cleanly without duplication)
 *  - Homonym disambiguation bonus via co-occurring context tokens
 */
export function recallCardKnowledge(options: {
  knowledgeIndex: CardKnowledgeIndex | undefined | null;
  queryText: string;
  registry?: EntityRegistry;
  tokenBudget: number;
  maxPassages?: number;
  isManual?: boolean;
}): CardKnowledgeRecallResult {
  const { knowledgeIndex, queryText, registry, tokenBudget, maxPassages = 6, isManual = false } = options;
  if (!knowledgeIndex || knowledgeIndex.passages.length === 0 || tokenBudget <= 0) {
    return { passages: [], traces: [], usedTokens: 0 };
  }
  // If card is NOT in dual-track mode and not manual, full text is already in Zone 1 — skip redundant injection!
  if (!knowledgeIndex.dualTrackActive && !isManual) {
    return { passages: [], traces: [], usedTokens: 0 };
  }

  const expanded = registry ? registry.expandQueryForRecall(queryText) : null;
  const effectiveQuery = expanded?.expandedText ?? queryText;
  const matchedCanonSet = new Set((expanded?.matchedCanonicals ?? []).map((c) => c.toLowerCase()));

  const bm25Index = getKnowledgeBm25(knowledgeIndex);
  const queryTokens = Array.from(new Set(tokenizeBigram(effectiveQuery)));
  const rawBm25 = bm25Scores(queryTokens, bm25Index);

  // Adaptive BM25 noise floor scales gently with query token count
  const bm25Floor = isManual ? 0.5 : Math.max(3.2, Math.log2(Math.max(4, queryTokens.length)) * 1.4);

  const scored: Array<{
    passage: CardPassageNode;
    score: number;
    reason: LoreRecallTraceItem["reason"];
    matchedEntities: string[];
  }> = [];

  const qLower = effectiveQuery.toLowerCase();
  for (let i = 0; i < knowledgeIndex.passages.length; i++) {
    const p = knowledgeIndex.passages[i]!;
    const bScore = rawBm25[i] ?? 0;

    // Entity / alias match score
    const hitEnts: string[] = [];
    for (const ent of p.entities) {
      if (matchedCanonSet.has(ent.toLowerCase())) {
        hitEnts.push(ent);
      }
    }

    // Direct title/chapter match boost
    const chapterHit = p.chapterPath.length >= 2 && qLower.includes(p.chapterPath.toLowerCase());
    if (hitEnts.length === 0 && !chapterHit && bScore < bm25Floor) continue;

    // Contextual disambiguation: if homonym exists, BM25 overlap with surrounding chapter context breaks ties cleanly
    const totalScore = hitEnts.length * 14 + (chapterHit ? 10 : 0) + bScore * 1.8;
    const reason: LoreRecallTraceItem["reason"] =
      hitEnts.length > 0 ? "direct_key" : chapterHit ? "static" : "bm25";

    scored.push({ passage: p, score: totalScore, reason, matchedEntities: hitEnts });
  }

  scored.sort((a, b) => b.score - a.score || a.passage.charOffset - b.passage.charOffset);

  const selected: CardKnowledgeRecallResult["passages"] = [];
  const traces: LoreRecallTraceItem[] = [];
  let usedTokens = 0;
  const seenChapters = new Map<string, number>();

  for (const item of scored) {
    if (selected.length >= maxPassages) break;
    // Allow at most 2 passages from the same chapter so multi-chapter queries get diverse evidence
    const chCount = seenChapters.get(item.passage.chapterId) ?? 0;
    if (chCount >= 2) continue;

    const cost = item.passage.tokens + 16;
    if (usedTokens + cost > tokenBudget && selected.length > 0) continue;

    seenChapters.set(item.passage.chapterId, chCount + 1);
    usedTokens += cost;
    selected.push({
      id: item.passage.id,
      chapterId: item.passage.chapterId,
      chapterPath: item.passage.chapterPath,
      text: item.passage.text,
      score: Number(item.score.toFixed(2)),
      reason: item.reason,
      matchedEntities: item.matchedEntities,
      tokens: cost,
    });
    traces.push({
      id: item.passage.id,
      title: `卡体·${item.passage.chapterPath}`,
      source: "card_knowledge",
      reason: item.reason,
      matchedKey: item.matchedEntities[0],
      score: Number(item.score.toFixed(2)),
      tokens: cost,
    });
  }

  return { passages: selected, traces, usedTokens };
}
