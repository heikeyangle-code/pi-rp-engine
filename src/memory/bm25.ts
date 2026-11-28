/**
 * Zero-dependency CJK/Kana/Hangul Bigram + Unicode Latin BM25 retrieval engine.
 * Ported faithfully from dsh-tavern's `bm25.js` (k1=1.5, b=0.75, Int32Array packed postings).
 *
 * Chinese/Japanese/Korean segments emit both unigrams (filtering common CJK stopwords) and
 * 2-char sliding bigrams so partial/fuzzy queries match reliably without any external tokenizer.
 */

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const BM25_TF_SCALE = 4096;

const CJK_STOPWORDS = new Set(["的", "了", "是", "在", "我", "你", "他", "她", "它", "和", "与", "这", "那"]);
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
    if (CJK_STOPWORDS.has(a) && CJK_STOPWORDS.has(b)) continue;
    tokens.push(a + b);
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
    for (let i = 0; i < postings.length; i++) {
      const packed = postings[i]!;
      const docIdx = Math.floor(packed / BM25_TF_SCALE);
      if (candidates && !candidates.has(docIdx)) continue;
      const tf = packed % BM25_TF_SCALE;
      const norm = 1 - BM25_B + BM25_B * ((corpus.docLengths[docIdx] ?? 0) / Math.max(1, corpus.avgdl));
      scores[docIdx] = (scores[docIdx] ?? 0) + idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
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
