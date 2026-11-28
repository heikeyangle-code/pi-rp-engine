/**
 * On-Demand History Recall Engine (`rp_history_recall`).
 * Ported faithfully from dsh-tavern's `history-recall.js` and adapted to Pi's native
 * session branch (`message` + `custom_message` entries).
 *
 * Features:
 *  - CJK Bigram-BM25 search with +1000 exact-phrase bonus.
 *  - Rarest-IDF anchor selection + merged grep-style excerpt windows.
 *  - `termTurns` verbatim occurrence map across all committed story rounds.
 *  - Exact round reading (`turn` + `radius` 0..3) even after old floors are compacted/hidden.
 *  - Per-turn call budget (max 6), duplicate search dedup, and 10-turn full-read cooldown.
 */

import { createHash } from "node:crypto";
import type { PiContentBlock, PiMessage, PiSessionEntry } from "../types.js";
import { type Bm25Index, bm25Scores, buildBm25Index, hasPosting, tokenizeBigram } from "./bm25.js";

export interface CommittedRoundMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CommittedRound {
  turn: number;
  messages: CommittedRoundMessage[];
}

export interface HistoryRecallCooldown {
  turn: number;
  hash: string;
  at: number;
}

export interface HistoryRecallTurnScope {
  calls: number;
  rounds: Set<string>;
  searches: Set<string>;
}

export interface HistoryRecallResult {
  notice: string;
  found: boolean;
  mode: "search" | "read";
  query: string;
  requestedTurn: number;
  terms: Array<{ term: string; turns: number[] }>;
  matches: Array<{ turn: number; excerpt: string }>;
  rounds: CommittedRound[];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function searchable(value: string): string {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function termsOf(query: string): string[] {
  return Array.from(new Set(String(query ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));
}

function extractPlainContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as PiContentBlock[])
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function isToolCallAssistantMessage(m: PiMessage): boolean {
  if (m.role !== "assistant") return false;
  if (m.stopReason === "toolUse" || m.stopReason === "tool_calls") return true;
  if (Array.isArray(m.content)) {
    return m.content.some((b) => b && typeof b === "object" && (b.type === "toolCall" || b.type === "tool_use"));
  }
  return false;
}

/** Extract committed story rounds from Pi's session branch (keeping rp:greeting as Turn 0 so turns align with state.turn). */
export function extractCommittedRounds(branch: PiSessionEntry[]): CommittedRound[] {
  const rounds: CommittedRound[] = [];
  let pendingUsers: CommittedRoundMessage[] = [];
  let turnCounter = 0;

  for (const e of branch) {
    if (e.type === "message" && e.message) {
      const m = e.message;
      if (
        m.customType === "rp:ooc" ||
        m.customType === "rp:event" ||
        m.customType === "rp:error" ||
        m.customType === "rp:recovery"
      ) {
        continue;
      }
      if (m.display === false && m.customType !== "rp:greeting") continue;
      if (m.stopReason === "error" || m.stopReason === "aborted") continue;
      if (isToolCallAssistantMessage(m)) continue;

      const text = extractPlainContent(m.content).trim();
      if (!text || text.startsWith("[OOC")) continue;

      if (m.customType === "rp:greeting") {
        rounds.push({
          turn: 0,
          messages: [{ role: "assistant", text }],
        });
        continue;
      }

      if (m.role === "user") {
        pendingUsers.push({ role: "user", text });
      } else if (m.role === "assistant" || m.customType === "rp:rewrite") {
        turnCounter += 1;
        rounds.push({
          turn: turnCounter,
          messages: [...pendingUsers, { role: "assistant", text }],
        });
        pendingUsers = [];
      }
      continue;
    }

    if (e.type === "custom_message") {
      if (e.customType !== "rp:greeting" && e.customType !== "rp:rewrite") continue;
      if ((e as { display?: boolean }).display === false && e.customType !== "rp:greeting") continue;
      const text = extractPlainContent((e as { content?: unknown }).content).trim();
      if (!text || text.startsWith("[OOC")) continue;
      if (e.customType === "rp:greeting") {
        rounds.push({
          turn: 0,
          messages: [{ role: "assistant", text }],
        });
        continue;
      }
      turnCounter += 1;
      rounds.push({
        turn: turnCounter,
        messages: [...pendingUsers, { role: "assistant", text }],
      });
      pendingUsers = [];
    }
  }

  return rounds;
}

function excerpt(text: string, terms: string[], maximum = 240): string {
  const source = text.replace(/\s+/g, " ").trim();
  if (source.length <= maximum) return source;
  const lower = source.toLocaleLowerCase();
  let found = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (found < 0 || idx < found)) found = idx;
  }
  const start = Math.max(0, (found < 0 ? 0 : found) - Math.floor(maximum / 3));
  const end = Math.min(source.length, start + maximum);
  return (start > 0 ? "…" : "") + source.slice(start, end) + (end < source.length ? "…" : "");
}

/** Merge nearby grep-style windows around every anchor hit (at most `count` windows). */
function hitExcerpts(text: string, terms: string[], radius = 60, count = 3): string {
  const source = text.replace(/\s+/g, " ").trim();
  const lower = source.toLocaleLowerCase();
  const windows: Array<[number, number]> = [];
  for (const term of terms) {
    if (!term) continue;
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      windows.push([Math.max(0, at - radius), Math.min(source.length, at + term.length + radius)]);
    }
  }
  if (windows.length === 0) return excerpt(text, terms);
  windows.sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const win of windows) {
    const last = merged[merged.length - 1];
    if (last && win[0] <= last[1]) {
      if (win[1] - last[0] <= radius * 4) {
        last[1] = Math.max(last[1], win[1]);
      } else if (win[1] > last[1]) {
        merged.push([last[1], win[1]]);
      }
    } else {
      merged.push([win[0], win[1]]);
    }
  }

  const head = merged
    .slice(0, count)
    .map(([start, end]) => (start > 0 ? "…" : "") + source.slice(start, end) + (end < source.length ? "…" : ""))
    .join(" ");
  return head + (merged.length > count ? `（本轮另有 ${merged.length - count} 处命中）` : "");
}

function termTurns(rounds: CommittedRound[], terms: string[]): Array<{ term: string; turns: number[] }> {
  const texts = rounds.map((r) => ({
    turn: r.turn,
    text: searchable(r.messages.map((m) => m.text).join("\n")),
  }));
  return terms.map((term) => {
    const needle = searchable(term);
    return {
      term,
      turns: needle ? texts.filter((item) => item.text.includes(needle)).map((item) => item.turn) : [],
    };
  });
}

function roundSignature(round: CommittedRound): string {
  return createHash("sha256").update(JSON.stringify(round.messages)).digest("hex").slice(0, 16);
}

interface CachedCorpus extends Bm25Index {
  texts: string[];
}

const corpusCache = new Map<string, CachedCorpus>();

function getOrBuildCorpus(rounds: CommittedRound[], cacheKey: string): CachedCorpus {
  const hit = corpusCache.get(cacheKey);
  if (hit) return hit;
  const texts = rounds.map((r) => r.messages.map((m) => m.text).join("\n"));
  const corpus: CachedCorpus = { ...buildBm25Index(texts), texts };
  corpusCache.set(cacheKey, corpus);
  if (corpusCache.size > 4) {
    const oldestKey = corpusCache.keys().next().value;
    if (oldestKey) corpusCache.delete(oldestKey);
  }
  return corpus;
}

/** Pick rarest (lowest DF) 2+ char matched tokens as excerpt anchors so common function words don't dominate. */
function excerptAnchors(queryTokens: string[], corpus: CachedCorpus, docIdx: number): string[] {
  const present = queryTokens.filter((token) => hasPosting(corpus.index.get(token), docIdx));
  present.sort((a, b) => (corpus.index.get(a)?.length ?? 0) - (corpus.index.get(b)?.length ?? 0));
  const strong = present.filter((t) => t.length >= 2).slice(0, 5);
  return strong.length > 0 ? strong : present.slice(0, 2);
}

export function createTurnRecallScope(): HistoryRecallTurnScope {
  return { calls: 0, rounds: new Set(), searches: new Set() };
}

export function recallHistory(options: {
  branch: PiSessionEntry[];
  query?: string;
  turn?: number;
  radius?: number;
  limit?: number;
  scope?: HistoryRecallTurnScope;
  cooldowns?: HistoryRecallCooldown[];
  cacheScopeId?: string;
}): { result: HistoryRecallResult; nextCooldowns: HistoryRecallCooldown[] } {
  const query = typeof options.query === "string" ? options.query.trim() : "";
  const hasQuery = query.length > 0;
  const hasTurn = options.turn !== undefined && options.turn !== null;
  if (Number(hasQuery) + Number(hasTurn) !== 1) {
    throw new Error("历史正文检索必须且只能提供 query 或 turn 之一。");
  }

  const rounds = extractCommittedRounds(options.branch);
  const currentTurn = rounds.reduce((max, r) => Math.max(max, r.turn), 0);
  const activeCooldowns = (options.cooldowns ?? []).filter(
    (c) => currentTurn >= c.at && currentTurn - c.at <= 10,
  );
  const isCooling = (r: CommittedRound): boolean =>
    activeCooldowns.some((c) => c.turn === r.turn && c.hash === roundSignature(r));

  const base: HistoryRecallResult = {
    notice: "",
    found: false,
    mode: hasQuery ? "search" : "read",
    query: hasQuery ? query : "",
    requestedTurn: hasTurn ? Number(options.turn) : 0,
    terms: [],
    matches: [],
    rounds: [],
  };

  if (options.scope && options.scope.calls++ >= 6) {
    return {
      result: {
        ...base,
        notice: "本回合的历史召回预算已用尽（上限 6 次）。请使用已返回的资料继续当前正文。",
      },
      nextCooldowns: activeCooldowns,
    };
  }

  if (hasQuery) {
    const terms = termsOf(query);
    if (terms.length === 0) {
      throw new Error("历史正文检索关键词不能为空。");
    }
    const limit = clampInteger(options.limit, 5, 1, 8);
    const searchKey = JSON.stringify([[...terms].sort(), limit]);
    if (options.scope?.searches.has(searchKey)) {
      return {
        result: {
          ...base,
          notice: "相同关键词本回合已检索，请直接使用此前结果；如需原文请按 turn 读取对应轮次。",
        },
        nextCooldowns: activeCooldowns,
      };
    }
    options.scope?.searches.add(searchKey);

    const lastRound = rounds[rounds.length - 1];
    const cacheKey = `${options.cacheScopeId ?? "default"}:${rounds.length}:${lastRound ? roundSignature(lastRound) : "0"}`;
    const corpus = getOrBuildCorpus(rounds, cacheKey);
    const queryTokens = Array.from(new Set(tokenizeBigram(query)));
    const scores = bm25Scores(queryTokens, corpus);
    const full = searchable(query);

    const ranked: Array<{ docIdx: number; turn: number; score: number }> = [];
    for (let docIdx = 0; docIdx < corpus.count; docIdx++) {
      const s = scores[docIdx] ?? 0;
      if (!(s > 0)) continue;
      const bonus = full && searchable(corpus.texts[docIdx] ?? "").includes(full) ? 1000 : 0;
      ranked.push({ docIdx, turn: rounds[docIdx]!.turn, score: s + bonus });
    }
    ranked.sort((a, b) => b.score - a.score || b.turn - a.turn);

    let anyMatchedCooling = false;
    const top = ranked.slice(0, limit).map((m) => {
      const anchors = excerptAnchors(queryTokens, corpus, m.docIdx);
      const cooling = isCooling(rounds[m.docIdx]!);
      if (cooling) anyMatchedCooling = true;
      const cooledMark = cooling ? "〔全文已读过·摘要复查〕" : "";
      return {
        turn: m.turn,
        excerpt: cooledMark + hitExcerpts(corpus.texts[m.docIdx] ?? "", anchors.length ? anchors : terms),
      };
    });

    return {
      result: {
        ...base,
        found: ranked.length > 0,
        matches: top,
        terms: termTurns(rounds, terms),
        notice: anyMatchedCooling ? "已召回全文的轮次处于 10 轮冷却期，本次命中只显示摘要复查。" : "",
      },
      nextCooldowns: activeCooldowns,
    };
  }

  // Read mode: by round turn +/- radius
  const requested = Number(options.turn);
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error("历史正文轮次必须是大于 0 的整数。");
  }
  const radius = clampInteger(options.radius, 1, 0, 3);
  const selected = rounds.filter((r) => Math.abs(r.turn - requested) <= radius);
  const cooled = selected.filter(isCooling);
  const fresh = selected.filter((r) => {
    if (isCooling(r)) return false;
    const key = `${r.turn}:${roundSignature(r)}`;
    if (options.scope?.rounds.has(key)) return false;
    options.scope?.rounds.add(key);
    return true;
  });

  const nextCooldowns = fresh.length
    ? activeCooldowns
        .filter((c) => !fresh.some((r) => r.turn === c.turn))
        .concat(fresh.map((r) => ({ turn: r.turn, hash: roundSignature(r), at: currentTurn })))
    : activeCooldowns;

  const notice = cooled.length
    ? `第 ${cooled.map((r) => r.turn).join("、")} 轮处于 10 轮冷却期，请使用已有资料继续。`
    : fresh.length < selected.length
      ? "重叠轮次本回合已读取，本次仅补充未返回的正文。"
      : "";

  return {
    result: {
      ...base,
      found: selected.some((r) => r.turn === requested),
      rounds: fresh,
      notice,
    },
    nextCooldowns,
  };
}

export function renderHistoryRecall(value: HistoryRecallResult): string {
  let warning = "以下是已经发生的历史，用来确认和回忆细节；正文从当前场景接着写，不重演这一段。";
  if (value.notice) warning += `\n\n${value.notice}`;
  if (value.notice && value.rounds.length === 0 && value.matches.length === 0) {
    return `<history_recall>\n${warning}\n</history_recall>`;
  }
  if (!value.found) {
    return `<history_recall>\n${warning}\n\n没有找到相关历史正文。\n</history_recall>`;
  }

  if (value.mode === "search") {
    const spread = value.terms
      .map((item) => {
        const turns =
          item.turns.length > 40
            ? `${item.turns.slice(0, 20).join("、")}……${item.turns.slice(-20).join("、")}`
            : item.turns.join("、");
        return `「${item.term}」${item.turns.length ? `逐字出现于第 ${turns} 轮` : "无逐字出现（下方为部分匹配结果）"}`;
      })
      .join("\n");
    const body = value.matches.map((m) => `<round turn="${m.turn}">\n${m.excerpt}\n</round>`).join("\n\n");
    return [
      "<history_recall>",
      warning,
      spread ? `逐字出现位置：\n${spread}` : null,
      `按相关度命中的轮次：\n\n${body}`,
      "信息足够请直接继续当前正文；如需确认某轮完整原话可传 turn 读取。",
      "</history_recall>",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const body = value.rounds
    .map((r) => {
      const text = r.messages.map((m) => `${m.role === "user" ? "[玩家]" : "[正文]"}\n${m.text}`).join("\n\n");
      return `<round turn="${r.turn}">\n${text}\n</round>`;
    })
    .join("\n\n");

  return `<history_recall>\n${warning}\n\n${body}\n</history_recall>`;
}
