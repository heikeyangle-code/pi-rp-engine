/**
 * Zero-dependency CJK/Kana/Hangul Bigram + Unicode Latin BM25 retrieval engine.
 * Upgraded with CJK + English stopword filtering, deduplicated query scoring,
 * and field-weighted corpus building (k1=1.5, b=0.75, Int32Array packed postings).
 */

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_TF_SCALE = 4096;

const CJK_STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "和", "与", "这", "那",
  "一", "个", "不", "有", "也", "就", "都", "而", "及", "着", "把", "被", "让",
  "从", "向", "对", "为", "于", "将", "还", "又", "再", "很", "更", "最", "没",
  "之", "吗", "呢", "吧", "啊", "呀", "哦", "嗯", "么", "所", "以", "但", "却",
]);

const CJK_BIGRAM_STOPWORDS = new Set([
  "没有", "一个", "什么", "怎么", "我们", "你们", "他们", "她们", "自己",
  "这里", "那里", "时候", "因为", "所以", "如果", "但是", "虽然", "或者",
  "可以", "已经", "正在", "人们", "这样", "那样", "不是", "就是", "还是",
  "只是", "可是", "而且", "于是", "然后", "不过", "有些", "有时", "通常",
  "一般", "非常", "十分", "特别", "注意", "发生", "地方", "日常",
]);

const EN_STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "has", "had",
  "was", "were", "are", "is", "be", "been", "being", "not", "but", "you",
  "your", "his", "her", "its", "our", "their", "they", "them", "she", "him",
  "who", "what", "when", "where", "why", "how", "all", "any", "can", "will",
  "just", "into", "out", "about", "there", "here", "then", "than", "too",
  "very", "some", "more", "most", "also", "only", "over", "such", "does",
  "did", "done", "would", "could", "should", "may", "might", "must",
]);

const CJK_SEGMENT_RE = /^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u;

function pushCjkTokens(tokens: string[], segment: string): void {
  const chars = Array.from(segment);
  for (const ch of chars) {
    if (!CJK_STOPWORDS.has(ch)) {
      tokens.push(ch);
    }
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i]!;
    const b = chars[i + 1]!;
    if (CJK_STOPWORDS.has(a) || CJK_STOPWORDS.has(b)) continue;
    const bg = a + b;
    if (CJK_BIGRAM_STOPWORDS.has(bg)) continue;
    tokens.push(bg);
  }
}

export function tokenizeBigram(text: string): string[] {
  const normalized = String(text ?? "").toLocaleLowerCase();
  const tokens: string[] = [];
  const pattern = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+|(?:(?![\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af])[\p{L}\p{N}_])+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    const part = match[0];
    if (!part) continue;
    if (CJK_SEGMENT_RE.test(part)) {
      pushCjkTokens(tokens, part);
    } else {
      if (part.length < 2 || EN_STOPWORDS.has(part)) continue;
      tokens.push(part);
    }
  }
  return tokens;
}

export interface Bm25Index {
  count: number;
  avgdl: number;
  index: Map<string, Int32Array>;
  docLengths: Int32Array;
}

export function buildBm25Index(documents: string[]): Bm25Index {
  const rawIndex = new Map<string, number[]>();
  const docLengths = new Int32Array(documents.length);
  let totalTokens = 0;

  for (let docIdx = 0; docIdx < documents.length; docIdx++) {
    const tokens = tokenizeBigram(documents[docIdx] ?? "");
    docLengths[docIdx] = tokens.length;
    totalTokens += tokens.length;

    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    for (const [token, count] of tf) {
      let postings = rawIndex.get(token);
      if (!postings) {
        postings = [];
        rawIndex.set(token, postings);
      }
      postings.push(docIdx * BM25_TF_SCALE + Math.min(count, BM25_TF_SCALE - 1));
    }
  }

  const index = new Map<string, Int32Array>();
  for (const [token, postings] of rawIndex) {
    index.set(token, Int32Array.from(postings));
  }

  return {
    count: documents.length,
    avgdl: documents.length ? totalTokens / documents.length : 0,
    index,
    docLengths,
  };
}

export function bm25Scores(
  queryTokens: string[],
  corpus: Bm25Index,
  candidates?: Set<number>,
): Float64Array {
  const scores = new Float64Array(corpus.count);
  const uniqueTokens = Array.from(new Set(queryTokens));
  for (const token of uniqueTokens) {
    const postings = corpus.index.get(token);
    if (!postings) continue;
    const df = postings.length;
    const idf = Math.log(1 + (corpus.count - df + 0.5) / (df + 0.5));
    // Give 2+ char bigrams/words slightly higher weight than single CJK unigrams
    const lenWeight = token.length >= 2 ? 1.0 : 0.35;
    for (let i = 0; i < postings.length; i++) {
      const packed = postings[i]!;
      const docIdx = Math.floor(packed / BM25_TF_SCALE);
      if (candidates && !candidates.has(docIdx)) continue;
      const tf = packed % BM25_TF_SCALE;
      const norm = 1 - BM25_B + BM25_B * ((corpus.docLengths[docIdx] ?? 0) / Math.max(1, corpus.avgdl));
      scores[docIdx] = (scores[docIdx] ?? 0) + lenWeight * idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
  }
  return scores;
}

export function hasPosting(postings: Int32Array | undefined, docIdx: number): boolean {
  if (!postings || postings.length === 0) return false;
  let lo = 0;
  let hi = postings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = Math.floor(postings[mid]! / BM25_TF_SCALE);
    if (at === docIdx) return true;
    if (at < docIdx) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}
