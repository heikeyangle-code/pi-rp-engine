/**
 * Full SillyTavern / CCV3 Lorebook (World Info) compiler:
 *  - Supports all 30+ World Info fields (both array `entries` and keyed object `{ "0": ... }`).
 *  - Parses & strips full CCV3 `@@` decorators with genuine `@@@` fallback semantics:
 *      @@activate, @@dont_activate, @@activate_only_after, @@activate_only_every,
 *      @@keep_activate_after_match, @@dont_activate_after_match, @@additional_keys,
 *      @@exclude_keys (independent field — NEVER clobbers selectiveLogic!),
 *      @@ignore_on_max_context, @@depth, @@reverse_depth, @@position, @@role,
 *      @@scan_depth, @@use_regex, @@match_whole_words, @@case_sensitive.
 *  - Enforces ReDoS-safe regex compilation (including inline `/pattern/flags` keys).
 *  - Performs one-time static scan for `match_character_*` flags.
 *  - Extracts entity index terms for local HippoRAG 2 PPR graph recall.
 */

import type { CompiledLoreBook, CompiledLoreEntry, GateCondition, SelectiveLogic } from "../types.js";
import { sanitizeFrontendShell } from "./sanitizer.js";

const MAX_REGEX_LENGTH = 200;
const REDOS_RISK_PATTERN = /\([^)]*[+*][^)]*\)[+*?]|\(\?:[^)]*[+*][^)]*\)[+*?]/;

/** Parse inline SillyTavern `/pattern/flags` key syntax. */
export function parseInlineRegexKey(key: string): { pattern: string; flags: string } | null {
  const m = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(key.trim());
  if (!m) return null;
  return { pattern: m[1]!, flags: m[2] ?? "" };
}

export function isSafeRegexPattern(rawKey: string): boolean {
  const inline = parseInlineRegexKey(rawKey);
  const pattern = inline ? inline.pattern : rawKey;
  if (!pattern || pattern.length > MAX_REGEX_LENGTH) return false;
  if (REDOS_RISK_PATTERN.test(pattern)) return false;
  try {
    new RegExp(pattern, inline?.flags);
    return true;
  } catch {
    return false;
  }
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.map((x) => String(x).trim()).filter(Boolean);
  }
  if (typeof val === "string") {
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function toNumber(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() !== "") {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function mapSelectiveLogic(raw: unknown): SelectiveLogic {
  switch (raw) {
    case 1:
    case "NOT_ALL":
      return "NOT_ALL";
    case 2:
    case "NOT_ANY":
      return "NOT_ANY";
    case 3:
    case "AND_ALL":
      return "AND_ALL";
    default:
      return "AND_ANY";
  }
}

function mapPositionValue(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  switch (s) {
    case "before_char":
    case "before_desc":
      return 0;
    case "after_char":
    case "after_desc":
    case "personality":
    case "scenario":
      return 1;
    case "an_top":
    case "before_an":
      return 2;
    case "an_bottom":
    case "after_an":
      return 3;
    case "in_chat":
    case "at_depth":
      return 4;
    case "before_example":
    case "before_em":
      return 5;
    case "after_example":
    case "after_em":
      return 6;
    case "outlet":
      return 7;
    default:
      return undefined;
  }
}

export interface ParsedDecorators {
  cleanedContent: string;
  forceActivate: boolean;
  manualRecallOnly: boolean;
  minTurn?: number;
  everyNTurns?: number;
  stickyPermanent: boolean;
  oneShot: boolean;
  additionalKeys: string[];
  excludeKeys: string[];
  lowBudgetPriority: boolean;
  positionOverride?: number;
  depthOverride?: number;
  reverseDepth?: number;
  roleOverride?: "system" | "user" | "assistant";
  scanDepthOverride?: number;
  useRegexOverride?: boolean;
  matchWholeWordsOverride?: boolean;
  caseSensitiveOverride?: boolean;
}

/**
 * Parse CCV3 `@@` primary decorators and `@@@` fallback decorators.
 * A `@@@` fallback decorator is ONLY applied if the immediately preceding `@@` decorator was unrecognized.
 * All `@@` and `@@@` lines are stripped from content so raw decorator syntax never leaks to the LLM.
 */
export function parseV3Decorators(content: string): ParsedDecorators {
  const lines = content.split("\n");
  const kept: string[] = [];

  const result: ParsedDecorators = {
    cleanedContent: "",
    forceActivate: false,
    manualRecallOnly: false,
    stickyPermanent: false,
    oneShot: false,
    additionalKeys: [],
    excludeKeys: [],
    lowBudgetPriority: false,
  };

  let lastPrimaryWasUnknown = false;

  const applyDecorator = (name: string, arg: string): boolean => {
    switch (name) {
      case "activate":
        result.forceActivate = true;
        return true;
      case "dont_activate":
        result.manualRecallOnly = true;
        return true;
      case "activate_only_after": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n >= 0) result.minTurn = n;
        return true;
      }
      case "activate_only_every": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n > 0) result.everyNTurns = n;
        return true;
      }
      case "keep_activate_after_match":
        result.stickyPermanent = true;
        return true;
      case "dont_activate_after_match":
        result.oneShot = true;
        return true;
      case "additional_keys":
        result.additionalKeys.push(...toStringArray(arg));
        return true;
      case "exclude_keys":
        result.excludeKeys.push(...toStringArray(arg));
        return true;
      case "ignore_on_max_context":
        result.lowBudgetPriority = true;
        return true;
      case "depth": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n >= 0) result.depthOverride = n;
        return true;
      }
      case "reverse_depth": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n >= 0) result.reverseDepth = n;
        return true;
      }
      case "scan_depth": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n > 0) result.scanDepthOverride = Math.min(n, 50);
        return true;
      }
      case "position": {
        const pos = mapPositionValue(arg);
        if (pos !== undefined) result.positionOverride = pos;
        return true;
      }
      case "role": {
        const r = arg.trim().toLowerCase();
        if (r === "system" || r === "user" || r === "assistant") {
          result.roleOverride = r;
        }
        return true;
      }
      case "use_regex":
        result.useRegexOverride = arg.toLowerCase() !== "false";
        return true;
      case "match_whole_words":
        result.matchWholeWordsOverride = arg.toLowerCase() !== "false";
        return true;
      case "case_sensitive":
        result.caseSensitiveOverride = arg.toLowerCase() !== "false";
        return true;
      default:
        return false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@@")) {
      lastPrimaryWasUnknown = false;
      kept.push(line);
      continue;
    }

    const isFallback = trimmed.startsWith("@@@");
    const body = trimmed.replace(/^@{2,3}/, "").trim();
    const spaceIdx = body.search(/\s+/);
    const name = (spaceIdx >= 0 ? body.slice(0, spaceIdx) : body).toLowerCase();
    const arg = spaceIdx >= 0 ? body.slice(spaceIdx).trim() : "";

    if (isFallback) {
      if (lastPrimaryWasUnknown) {
        const recognized = applyDecorator(name, arg);
        if (recognized) lastPrimaryWasUnknown = false;
      }
    } else {
      const recognized = applyDecorator(name, arg);
      lastPrimaryWasUnknown = !recognized;
    }
  }

  result.cleanedContent = kept.join("\n").trim();
  return result;
}

/** Extract clean entity labels from title + keys for local PPR graph indexing. */
export function extractEntryEntities(title: string, keys: string[]): string[] {
  const set = new Set<string>();
  const add = (raw: string) => {
    const clean = raw.replace(/^\/|\/[gimsuy]*$/g, "").trim();
    if (clean.length >= 2 && clean.length <= 48 && !/[.*+?^${}()|[\]\\]/.test(clean)) {
      set.add(clean);
    }
  };
  if (title) {
    for (const part of title.split(/[·\-–—|｜/：:()（）【】\[\]]+/)) {
      add(part);
    }
  }
  for (const k of keys) {
    add(k);
  }
  return Array.from(set);
}

export interface StaticScanContext {
  description?: string;
  personality?: string;
  scenario?: string;
  depthPrompt?: string;
  creatorNotes?: string;
}

/** Extract raw entries list from array or keyed object dictionary. */
export function extractRawLoreEntries(rawBook: Record<string, unknown> | undefined | null): Record<string, unknown>[] {
  if (!rawBook || typeof rawBook !== "object") return [];
  const rawEntriesField = rawBook.entries;
  if (Array.isArray(rawEntriesField)) {
    return rawEntriesField.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
  }
  if (rawEntriesField && typeof rawEntriesField === "object") {
    return Object.values(rawEntriesField as Record<string, unknown>).filter(
      (x): x is Record<string, unknown> => Boolean(x && typeof x === "object"),
    );
  }
  return [];
}

/** Compile a SillyTavern / CCV3 character_book or standalone Lorebook JSON object. */
export function compileLoreBook(
  rawBook: Record<string, unknown> | undefined | null,
  options: { rawPassthrough?: boolean; staticScan?: StaticScanContext } = {},
): CompiledLoreBook {
  const warnings: string[] = [];
  if (!rawBook || typeof rawBook !== "object") {
    return { tokenBudget: 1800, scanDepth: 4, entries: [], warnings };
  }

  const rawList = extractRawLoreEntries(rawBook);
  const tokenBudget = toNumber(rawBook.token_budget, 1800);
  const scanDepth = Math.max(1, Math.min(toNumber(rawBook.scan_depth, 4), 20));
  const compiled: CompiledLoreEntry[] = [];

  for (let idx = 0; idx < rawList.length; idx++) {
    const raw = rawList[idx]!;
    const ext = (raw.extensions && typeof raw.extensions === "object"
      ? (raw.extensions as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const id = String(raw.id ?? raw.uid ?? `lore_${idx}`);
    const title = String(raw.comment ?? raw.name ?? "").trim() || `Entry #${idx + 1}`;
    const rawContent = typeof raw.content === "string" ? raw.content : "";

    // 1. Parse & strip V3 @@ / @@@ decorators first
    const dec = parseV3Decorators(rawContent);

    // 2. Surgically strip 1.0 frontend HTML/JS shells (unless rawPassthrough)
    const { cleaned } = sanitizeFrontendShell(dec.cleanedContent, `lore:${title}`, options.rawPassthrough);
    const finalContent = cleaned.trim();

    const enabled =
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : typeof raw.disable === "boolean"
          ? !raw.disable
          : true;

    const constant = Boolean(raw.constant) || dec.forceActivate;
    const keys = [...toStringArray(raw.keys ?? raw.key), ...dec.additionalKeys];
    const secondaryKeys = toStringArray(raw.secondary_keys ?? raw.keysecondary);
    const excludeKeys = [...dec.excludeKeys];
    const selective = Boolean(raw.selective ?? secondaryKeys.length > 0);
    const selectiveLogic = mapSelectiveLogic(raw.selectiveLogic ?? ext.selectiveLogic);

    let useRegex = dec.useRegexOverride ?? Boolean(raw.use_regex ?? ext.use_regex ?? false);
    if (useRegex) {
      const badKey = [...keys, ...secondaryKeys, ...excludeKeys].find((k) => !isSafeRegexPattern(k));
      if (badKey !== undefined) {
        warnings.push(`世界书「${title}」含不安全或非法正则 "${badKey.slice(0, 40)}"，已自动降级为字面匹配`);
        useRegex = false;
      }
    }

    const caseSensitive =
      dec.caseSensitiveOverride ?? Boolean(raw.case_sensitive ?? raw.caseSensitive ?? ext.case_sensitive ?? false);
    const matchWholeWords =
      dec.matchWholeWordsOverride ?? Boolean(raw.match_whole_words ?? raw.matchWholeWords ?? ext.match_whole_words ?? false);
    const priority = toNumber(raw.priority ?? raw.order ?? raw.insertion_order, 100);
    const position =
      dec.positionOverride ??
      mapPositionValue(raw.position ?? ext.position) ??
      4;
    const depthHint = dec.depthOverride ?? toNumber(raw.depth ?? ext.depth, 4);
    const roleRaw = dec.roleOverride ?? raw.role ?? ext.role;
    const role: "system" | "user" | "assistant" | undefined =
      roleRaw === "user" || roleRaw === 1
        ? "user"
        : roleRaw === "assistant" || roleRaw === 2
          ? "assistant"
          : roleRaw === "system" || roleRaw === 0
            ? "system"
            : undefined;
    const pinned = Boolean(raw.ignore_budget ?? raw.ignoreBudget ?? ext.ignore_budget ?? false);

    const delay = toNumber(raw.delay ?? ext.delay, 0);
    const stickyTurns = toNumber(raw.sticky ?? ext.sticky, 0);
    const cooldownTurns = toNumber(raw.cooldown ?? ext.cooldown, 0);
    const probability = toNumber(raw.probability ?? ext.probability, 100);
    const useProbability = Boolean(raw.useProbability ?? ext.useProbability ?? probability < 100);
    const group =
      typeof (raw.group ?? ext.group) === "string" && String(raw.group ?? ext.group).trim()
        ? String(raw.group ?? ext.group).trim()
        : undefined;
    const groupOverride = Boolean(raw.group_override ?? raw.groupOverride ?? ext.group_override ?? false);
    const groupWeight = toNumber(raw.group_weight ?? raw.groupWeight ?? ext.group_weight, 100);
    const useGroupScoring = Boolean(raw.use_group_scoring ?? raw.useGroupScoring ?? ext.use_group_scoring ?? false);

    const noGraphSpread = Boolean(
      raw.prevent_recursion ??
        raw.preventRecursion ??
        ext.prevent_recursion ??
        raw.exclude_recursion ??
        raw.excludeRecursion ??
        ext.exclude_recursion ??
        false,
    );
    const graphSecondHopOnly = Boolean(
      raw.delay_until_recursion ?? raw.delayUntilRecursion ?? ext.delay_until_recursion ?? false,
    );

    const outletName =
      typeof (raw.outletName ?? ext.outlet_name) === "string" && String(raw.outletName ?? ext.outlet_name).trim()
        ? String(raw.outletName ?? ext.outlet_name).trim()
        : undefined;

    const scanDepthOverride =
      dec.scanDepthOverride ??
      (raw.scanDepth !== undefined || ext.scan_depth !== undefined
        ? toNumber(raw.scanDepth ?? ext.scan_depth, 0) || undefined
        : undefined);

    const gate: GateCondition = {};
    const effectiveMinTurn = Math.max(delay, dec.minTurn ?? 0);
    if (effectiveMinTurn > 0) gate.minTurn = effectiveMinTurn;
    if (dec.everyNTurns !== undefined) gate.everyNTurns = dec.everyNTurns;
    if (ext.gate && typeof ext.gate === "object") {
      Object.assign(gate, ext.gate as GateCondition);
    }
    const hasGate = Object.keys(gate).length > 0;

    let staticPrebound = false;
    if (options.staticScan && !constant && keys.length > 0) {
      const scanPool: string[] = [];
      if (raw.matchCharacterDescription ?? ext.match_character_description)
        scanPool.push(options.staticScan.description ?? "");
      if (raw.matchCharacterPersonality ?? ext.match_character_personality)
        scanPool.push(options.staticScan.personality ?? "");
      if (raw.matchScenario ?? ext.match_scenario) scanPool.push(options.staticScan.scenario ?? "");
      if (raw.matchCharacterDepthPrompt ?? ext.match_character_depth_prompt)
        scanPool.push(options.staticScan.depthPrompt ?? "");
      if (raw.matchCreatorNotes ?? ext.match_creator_notes) scanPool.push(options.staticScan.creatorNotes ?? "");
      const joined = scanPool.join("\n").toLowerCase();
      if (joined && keys.some((k) => joined.includes(k.toLowerCase()))) {
        staticPrebound = true;
      }
    }

    compiled.push({
      id,
      title,
      content: finalContent,
      enabled,
      constant,
      manualRecallOnly: dec.manualRecallOnly,
      keys,
      secondaryKeys,
      excludeKeys,
      selective,
      selectiveLogic,
      useRegex,
      caseSensitive,
      matchWholeWords,
      priority,
      position,
      depthHint,
      reverseDepth: dec.reverseDepth,
      role,
      scanDepthOverride,
      pinned,
      lowBudgetPriority: dec.lowBudgetPriority,
      stickyTurns,
      stickyPermanent: dec.stickyPermanent,
      cooldownTurns,
      oneShot: dec.oneShot,
      probability,
      useProbability,
      group,
      groupOverride,
      groupWeight,
      useGroupScoring,
      noGraphSpread,
      graphSecondHopOnly,
      outletName,
      staticPrebound,
      gate: hasGate ? gate : undefined,
      entities: extractEntryEntities(title, keys),
    });
  }

  return {
    name: typeof rawBook.name === "string" ? rawBook.name : undefined,
    description: typeof rawBook.description === "string" ? rawBook.description : undefined,
    tokenBudget,
    scanDepth,
    entries: compiled,
    warnings,
  };
}
