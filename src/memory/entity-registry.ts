/**
 * Unified Entity Registry, Aho-Corasick Alias Automaton, Salience Coreference Stack,
 * and Context-Aware Homonym Disambiguation.
 *
 * Zero external dependencies; O(n) multi-pattern matching for mobile `pi-android` Pi SDK runtime.
 * Bridges: Card Identity + L1 entityAliases + Card Knowledge Entities + Lorebook Entities + Runtime NPCs/Factions.
 */

import type { CompiledCard, PiMessage, SessionRpState } from "../types.js";

export interface AcMatch {
  pattern: string;
  canonical: string;
  start: number;
  end: number;
}

interface AcNode {
  next: Map<string, number>;
  fail: number;
  outputs: Array<{ pattern: string; canonical: string }>;
}

export interface AhoCorasickAutomaton {
  nodes: AcNode[];
}

/** Build a case-insensitive Aho-Corasick automaton mapping every alias/name to its canonical entity. */
export function buildAhoCorasick(pairs: Array<{ pattern: string; canonical: string }>): AhoCorasickAutomaton {
  const nodes: AcNode[] = [{ next: new Map(), fail: 0, outputs: [] }];

  for (const { pattern, canonical } of pairs) {
    const clean = pattern.trim().toLowerCase();
    if (clean.length < 2) continue;
    let cur = 0;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i]!;
      let nxt = nodes[cur]!.next.get(ch);
      if (nxt === undefined) {
        nxt = nodes.length;
        nodes.push({ next: new Map(), fail: 0, outputs: [] });
        nodes[cur]!.next.set(ch, nxt);
      }
      cur = nxt;
    }
    const existing = nodes[cur]!.outputs;
    if (!existing.some((o) => o.pattern === clean && o.canonical === canonical)) {
      existing.push({ pattern: clean, canonical });
    }
  }

  // BFS to build failure links
  const queue: number[] = [];
  for (const child of nodes[0]!.next.values()) {
    nodes[child]!.fail = 0;
    queue.push(child);
  }

  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    for (const [ch, v] of nodes[u]!.next.entries()) {
      let f = nodes[u]!.fail;
      while (f !== 0 && !nodes[f]!.next.has(ch)) {
        f = nodes[f]!.fail;
      }
      const target = nodes[f]!.next.get(ch) ?? 0;
      nodes[v]!.fail = target;
      if (nodes[target]!.outputs.length > 0) {
        for (const out of nodes[target]!.outputs) {
          if (!nodes[v]!.outputs.some((o) => o.pattern === out.pattern && o.canonical === out.canonical)) {
            nodes[v]!.outputs.push(out);
          }
        }
      }
      queue.push(v);
    }
  }

  return { nodes };
}

/** O(n) scan returning all matched entity/alias spans in `text`. */
export function acScan(automaton: AhoCorasickAutomaton, text: string): AcMatch[] {
  if (!text || automaton.nodes.length <= 1) return [];
  const lower = text.toLowerCase();
  const matches: AcMatch[] = [];
  let state = 0;

  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i]!;
    while (state !== 0 && !automaton.nodes[state]!.next.has(ch)) {
      state = automaton.nodes[state]!.fail;
    }
    state = automaton.nodes[state]!.next.get(ch) ?? 0;
    const outs = automaton.nodes[state]!.outputs;
    if (outs.length > 0) {
      for (const out of outs) {
        const start = i - out.pattern.length + 1;
        // For pure ASCII Latin patterns, enforce word boundaries so "he" never matches "the"
        if (/^[a-z0-9_]+$/.test(out.pattern)) {
          const prev = start > 0 ? lower[start - 1]! : " ";
          const next = i + 1 < lower.length ? lower[i + 1]! : " ";
          if (/[a-z0-9_]/.test(prev) || /[a-z0-9_]/.test(next)) continue;
        }
        matches.push({
          pattern: out.pattern,
          canonical: out.canonical,
          start,
          end: i + 1,
        });
      }
    }
  }

  return matches;
}

const PRONOUN_CUE_RE = /(?:^|[\s，。！？、“”"‘’'：:；;（(])(他|她|那人|对方|此人|那位|其人|那家伙|he|him|his|she|her|hers|they|them|their)(?:$|[\s，。！？、“”"‘’'：:；;）)])/i;

function extractMsgPlain(m: PiMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export interface EntityRegistry {
  /** canonicalLower -> display canonical name */
  canonicalDisplay: Map<string, string>;
  /** aliasLower -> canonicalLower */
  aliasToCanonical: Map<string, string>;
  /** canonicalLower -> Set<aliasLower> (includes canonicalLower itself) */
  canonicalToAliases: Map<string, Set<string>>;
  /** Homonym groups: surfaceLower -> Set<disambiguatedCanonical> */
  homonyms: Map<string, Set<string>>;
  automaton: AhoCorasickAutomaton;

  resolveCanonical(name: string): string;
  getAliases(name: string): string[];
  sameEntity(a: string, b: string): boolean;
  scanEntities(text: string): string[];
  extractEntitiesFromText(text: string, fallbackNpcs?: string[], limit?: number): string[];
  expandQueryForRecall(
    queryText: string,
    options?: { messages?: PiMessage[]; presentNpcs?: string[] },
  ): {
    expandedText: string;
    matchedCanonicals: string[];
    matchedAliases: Array<{ alias: string; canonical: string }>;
    salienceResolved: string[];
  };
}

/**
 * Build a unified EntityRegistry from primary card, co-cast cards, knowledge index, lorebook, and live state.
 */
export function buildEntityRegistry(options: {
  card?: CompiledCard | null;
  extraCastCards?: CompiledCard[];
  state?: SessionRpState | null;
}): EntityRegistry {
  const { card, extraCastCards = [], state } = options;
  const canonicalDisplay = new Map<string, string>();
  const aliasToCanonical = new Map<string, string>();
  const canonicalToAliases = new Map<string, Set<string>>();
  const homonyms = new Map<string, Set<string>>();

  const registerEntity = (rawCanonical: string, aliases: string[] = []) => {
    const canon = rawCanonical.trim();
    if (canon.length < 2 || canon.length > 48) return;
    const canonLow = canon.toLowerCase();
    if (!canonicalDisplay.has(canonLow)) {
      canonicalDisplay.set(canonLow, canon);
    }
    if (!canonicalToAliases.has(canonLow)) {
      canonicalToAliases.set(canonLow, new Set([canonLow]));
    }
    if (!aliasToCanonical.has(canonLow)) {
      aliasToCanonical.set(canonLow, canonLow);
    }
    for (const rawAl of aliases) {
      const al = rawAl.trim();
      if (al.length < 2 || al.length > 48) continue;
      const alLow = al.toLowerCase();
      canonicalToAliases.get(canonLow)!.add(alLow);
      const existing = aliasToCanonical.get(alLow);
      if (existing && existing !== canonLow) {
        if (!homonyms.has(alLow)) homonyms.set(alLow, new Set([existing]));
        homonyms.get(alLow)!.add(canonLow);
      } else {
        aliasToCanonical.set(alLow, canonLow);
      }
    }
  };

  // 1. Primary & co-cast card identities
  for (const c of [card, ...extraCastCards]) {
    if (!c) continue;
    registerEntity(c.identity.name, [
      ...(c.identity.nickname ? [c.identity.nickname] : []),
      ...(c.identity.aliases ?? []),
    ]);

    // 2. L1 analyzed entityAliases
    if (c.worldProfile?.entityAliases) {
      for (const [canon, alList] of Object.entries(c.worldProfile.entityAliases)) {
        registerEntity(canon, alList);
      }
    }

    // 3. Card Knowledge Index entities & aliases
    if (c.knowledgeIndex?.entities) {
      for (const ent of c.knowledgeIndex.entities) {
        registerEntity(ent.canonical, ent.aliases);
      }
    }

    // 4. Lorebook entities
    for (const entry of c.loreBook.entries) {
      for (const ent of entry.entities) {
        registerEntity(ent, []);
      }
    }
  }

  // 5. Runtime state entities (presentNpcs, factions, persona, active facts)
  if (state) {
    if (state.currentPersona?.name) {
      registerEntity(state.currentPersona.name, ["player"]);
    }
    for (const npc of state.presentNpcs) registerEntity(npc, []);
    for (const fac of Object.keys(state.factions)) registerEntity(fac, []);
    for (const fact of state.facts.values()) {
      for (const ent of fact.entities) registerEntity(ent, []);
    }
  }

  const pairs: Array<{ pattern: string; canonical: string }> = [];
  for (const [canonLow, alSet] of canonicalToAliases.entries()) {
    const display = canonicalDisplay.get(canonLow) ?? canonLow;
    for (const al of alSet) {
      pairs.push({ pattern: al, canonical: display });
    }
  }
  const automaton = buildAhoCorasick(pairs);

  const resolveCanonical = (name: string): string => {
    const trimmed = name.trim();
    if (!trimmed) return "";
    const low = trimmed.toLowerCase();
    const mapped = aliasToCanonical.get(low);
    return mapped ? (canonicalDisplay.get(mapped) ?? trimmed) : trimmed;
  };

  const getAliases = (name: string): string[] => {
    const low = name.trim().toLowerCase();
    const mapped = aliasToCanonical.get(low) ?? low;
    const set = canonicalToAliases.get(mapped);
    if (!set) return name.trim() ? [name.trim()] : [];
    return Array.from(set).map((al) => canonicalDisplay.get(al) ?? al);
  };

  const sameEntity = (a: string, b: string): boolean => {
    const ca = resolveCanonical(a).toLowerCase();
    const cb = resolveCanonical(b).toLowerCase();
    return Boolean(ca && cb && ca === cb);
  };

  const scanEntities = (text: string): string[] => {
    const hits = acScan(automaton, text);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of hits) {
      const key = h.canonical.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(h.canonical);
      }
    }
    return out;
  };

  const extractEntitiesFromText = (text: string, fallbackNpcs: string[] = [], limit = 6): string[] => {
    const found = scanEntities(text);
    // Also extract quoted proper nouns 「...」 / 《...》 not yet in registry
    const quoteRe = /[「《【]([^」》】\n]{2,16})[」》】]/g;
    const seen = new Set(found.map((x) => x.toLowerCase()));
    let m: RegExpExecArray | null;
    while ((m = quoteRe.exec(text)) !== null) {
      const term = m[1]!.trim();
      if (term.length >= 2 && !seen.has(term.toLowerCase())) {
        seen.add(term.toLowerCase());
        found.push(term);
      }
    }
    if (found.length === 0 && fallbackNpcs.length > 0) {
      return fallbackNpcs.slice(0, limit);
    }
    return found.slice(0, limit);
  };

  const expandQueryForRecall = (
    queryText: string,
    opts?: { messages?: PiMessage[]; presentNpcs?: string[] },
  ) => {
    const hits = acScan(automaton, queryText);
    const matchedCanonicalsSet = new Set<string>();
    const matchedAliases: Array<{ alias: string; canonical: string }> = [];
    const expansionTerms = new Set<string>();

    for (const h of hits) {
      matchedCanonicalsSet.add(h.canonical);
      if (h.pattern !== h.canonical.toLowerCase()) {
        matchedAliases.push({ alias: h.pattern, canonical: h.canonical });
        expansionTerms.add(h.canonical);
      }
      // Also expand canonical -> aliases so lore entries keyed only by alias trigger too
      for (const al of getAliases(h.canonical)) {
        if (al.toLowerCase() !== h.pattern) {
          expansionTerms.add(al);
        }
      }
    }

    // Salience Coreference Stack: when query contains pronouns and few explicit entities,
    // pull salient entities from the last 2 in-world messages + presentNpcs
    const salienceResolved: string[] = [];
    if (PRONOUN_CUE_RE.test(queryText)) {
      const salient = new Set<string>();
      if (opts?.messages && opts.messages.length > 0) {
        const recentMsgs = opts.messages
          .filter((m) => m.customType !== "rp:ooc" && m.customType !== "rp:event" && m.role !== "toolResult")
          .slice(-4, -1);
        for (let i = recentMsgs.length - 1; i >= 0; i--) {
          const prevHits = scanEntities(extractMsgPlain(recentMsgs[i]!));
          for (const ent of prevHits) {
            if (!matchedCanonicalsSet.has(ent)) {
              salient.add(ent);
              if (salient.size >= 3) break;
            }
          }
          if (salient.size >= 3) break;
        }
      }
      if (salient.size === 0 && opts?.presentNpcs?.length) {
        for (const npc of opts.presentNpcs.slice(0, 2)) {
          const canon = resolveCanonical(npc);
          if (canon && !matchedCanonicalsSet.has(canon)) salient.add(canon);
        }
      }
      for (const s of salient) {
        salienceResolved.push(s);
        matchedCanonicalsSet.add(s);
        expansionTerms.add(s);
      }
    }

    const extra = Array.from(expansionTerms).filter((t) => !queryText.toLowerCase().includes(t.toLowerCase()));
    const expandedText = extra.length > 0 ? `${queryText}\n${extra.join(" ")}` : queryText;

    return {
      expandedText,
      matchedCanonicals: Array.from(matchedCanonicalsSet),
      matchedAliases,
      salienceResolved,
    };
  };

  return {
    canonicalDisplay,
    aliasToCanonical,
    canonicalToAliases,
    homonyms,
    automaton,
    resolveCanonical,
    getAliases,
    sameEntity,
    scanEntities,
    extractEntitiesFromText,
    expandQueryForRecall,
  };
}
