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

/** Parse inline SillyTavern `/pattern/flags` key syntax. */
export function parseInlineRegexKey(key: string): { pattern: string; flags: string } | null {
  const m = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(key.trim());
  if (!m) return null;
  return { pattern: m[1]!, flags: m[2] ?? "" };
}

/**
 * Inspect a quantifier starting at `pos` in `pattern`.
 * Returns `{ length, repeats }` where `repeats === true` means it can repeat >= 2 times
 * (`*`, `+`, `{m,}`, `{m,n}` with `n >= 2`, or `{m}` with `m >= 2`).
 * Optional-only quantifiers (`?`, `{0,1}`, `{1}`, `{1,1}`) have `repeats: false`.
 */
function readQuantifier(pattern: string, pos: number): { length: number; repeats: boolean } | null {
  const ch = pattern[pos];
  if (ch === "*" || ch === "+") {
    const lazy = pattern[pos + 1] === "?" ? 1 : 0;
    return { length: 1 + lazy, repeats: true };
  }
  if (ch === "?") {
    const lazy = pattern[pos + 1] === "?" ? 1 : 0;
    return { length: 1 + lazy, repeats: false };
  }
  if (ch === "{") {
    const m = /^\{(\d+)(?:,(\d*))?\}(\?)?/.exec(pattern.slice(pos));
    if (m) {
      const min = parseInt(m[1]!, 10);
      const hasComma = m[0].includes(",");
      const maxStr = m[2];
      const repeats = hasComma ? (maxStr === "" || maxStr === undefined ? true : parseInt(maxStr, 10) >= 2) : min >= 2;
      return { length: m[0].length, repeats };
    }
  }
  return null;
}

/** Check whether two branches of a repeated alternation can match overlapping prefixes (e.g. `(a|a)+`, `(a|ab)+`, `(\w|a)+`). */
function hasOverlappingAlternation(branches: string[]): boolean {
  if (branches.length < 2) return false;
  const isBroadToken = (s: string): boolean => /^(?:\.|\\w|\\d|\\s|\\S|\\W|\\D|\[[^\]]+\])$/.test(s);

  for (let i = 0; i < branches.length; i++) {
    const a = branches[i]!;
    if (a === "") return true; // empty branch inside repeated alternation e.g. (a|)+
    for (let j = i + 1; j < branches.length; j++) {
      const b = branches[j]!;
      if (b === "") return true;
      if (a === b) return true;
      if (a.startsWith(b) || b.startsWith(a)) return true;
      if (isBroadToken(a) || isBroadToken(b)) return true;
    }
  }
  return false;
}

/**
 * Structural ReDoS detector:
 * - Rejects nested repeating quantifiers: `(a+)+`, `((a)+)+`, `(a+){2,50}`, `(a{1,10})+`, `([a-z]+)*`.
 * - Rejects overlapping repeated alternations: `(a|a)+`, `(a|aa)+`, `(a|ab)+`, `(\w|a)+`.
 * - Allows safe optional groups like `/(the\s+)?king/i` where the outer quantifier cannot repeat (>= 2).
 */
function hasRedosRisk(pattern: string): boolean {
  interface GroupFrame {
    hasInnerRepeat: boolean;
    branches: string[];
    currentBranch: string;
  }

  const stack: GroupFrame[] = [];
  let inCharClass = false;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      const token = pattern.slice(i, i + 2);
      if (!inCharClass && stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += token;
      }
      i += 2;
      continue;
    }

    if (inCharClass) {
      if (ch === "]") {
        inCharClass = false;
      }
      if (stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += ch;
      }
      i++;
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      if (stack.length > 0) {
        stack[stack.length - 1]!.currentBranch += ch;
      }
      i++;
      continue;
    }

    if (ch === "(") {
      // Skip group prefix such as (?:, (?=, (?!, (?<=, (?<!, (?<name>
      let nextIdx = i + 1;
      if (pattern[nextIdx] === "?") {
        if (pattern[nextIdx + 1] === ":" || pattern[nextIdx + 1] === "=" || pattern[nextIdx + 1] === "!") {
          nextIdx += 2;
        } else if (pattern[nextIdx + 1] === "<") {
          if (pattern[nextIdx + 2] === "=" || pattern[nextIdx + 2] === "!") {
            nextIdx += 3;
          } else {
            const closeName = pattern.indexOf(">", nextIdx + 2);
            if (closeName >= 0) nextIdx = closeName + 1;
          }
        }
      }
      stack.push({ hasInnerRepeat: false, branches: [], currentBranch: "" });
      i = nextIdx;
      continue;
    }

    if (ch === "|") {
      if (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        top.branches.push(top.currentBranch);
        top.currentBranch = "";
      }
      i++;
      continue;
    }

    if (ch === ")") {
      const frame = stack.pop();
      i++;
      const quant = readQuantifier(pattern, i);
      if (quant) {
        i += quant.length;
      }
      if (frame) {
        frame.branches.push(frame.currentBranch);
        const outerRepeats = Boolean(quant?.repeats);
        if (outerRepeats) {
          if (frame.hasInnerRepeat) return true;
          if (hasOverlappingAlternation(frame.branches)) return true;
        }
        if (stack.length > 0) {
          const parent = stack[stack.length - 1]!;
          if (frame.hasInnerRepeat || outerRepeats) {
            parent.hasInnerRepeat = true;
          }
          parent.currentBranch += `(${frame.branches.join("|")})`;
        }
      }
      continue;
    }

    const quant = readQuantifier(pattern, i);
    if (quant) {
      if (quant.repeats && stack.length > 0) {
        stack[stack.length - 1]!.hasInnerRepeat = true;
      }
      i += quant.length;
      continue;
    }

    if (stack.length > 0) {
      stack[stack.length - 1]!.currentBranch += ch;
    }
    i++;
  }

  return false;
}

export function isSafeRegexPattern(rawKey: string): boolean {
  const inline = parseInlineRegexKey(rawKey);
  const pattern = inline ? inline.pattern : rawKey;
  if (!pattern || pattern.length > MAX_REGEX_LENGTH) return false;
  if (hasRedosRisk(pattern)) return false;
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

function parseBoolDecoratorArg(arg: string): boolean {
  const v = arg.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no" && v !== "off";
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
 * Per CCV3 spec, decorator scanning stops at the first non-decorator body line so body lines
 * starting with `@@` are never silently deleted.
 * A `@@@` fallback decorator is ONLY applied if the immediately preceding `@@` decorator was unrecognized.
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
  let inHeader = true;

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
        result.useRegexOverride = parseBoolDecoratorArg(arg);
        return true;
      case "match_whole_words":
        result.matchWholeWordsOverride = parseBoolDecoratorArg(arg);
        return true;
      case "case_sensitive":
        result.caseSensitiveOverride = parseBoolDecoratorArg(arg);
        return true;
      default:
        return false;
    }
  };

  for (const line of lines) {
    if (!inHeader) {
      kept.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("@@")) {
      inHeader = false;
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
  const rawBudget = toNumber(rawBook.token_budget, 0);
  const tokenBudget = rawBudget > 0 ? rawBudget : 1800;
  const scanDepth = Math.max(1, Math.min(toNumber(rawBook.scan_depth, 4), 20));
  const compiled: CompiledLoreEntry[] = [];
  const seenIds = new Set<string>();

  for (let idx = 0; idx < rawList.length; idx++) {
    const raw = rawList[idx]!;
    const ext = (raw.extensions && typeof raw.extensions === "object"
      ? (raw.extensions as Record<string, unknown>)
      : {}) as Record<string, unknown>;

    const baseId = String(raw.id ?? raw.uid ?? `lore_${idx}`);
    let id = baseId;
    if (seenIds.has(id)) {
      let suffix = 1;
      while (seenIds.has(`${baseId}_${suffix}`)) suffix++;
      id = `${baseId}_${suffix}`;
    }
    seenIds.add(id);

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

    // Respect @@dont_activate even when raw.constant === true (unless @@activate is also present)
    const constant = dec.forceActivate ? true : dec.manualRecallOnly ? false : Boolean(raw.constant);
    const keys = [...toStringArray(raw.keys ?? raw.key), ...dec.additionalKeys];
    const secondaryKeys = toStringArray(raw.secondary_keys ?? raw.keysecondary);
    const excludeKeys = [...dec.excludeKeys];
    const selective = Boolean(raw.selective ?? secondaryKeys.length > 0);
    const selectiveLogic = mapSelectiveLogic(raw.selectiveLogic ?? ext.selectiveLogic);

    // Per-key ReDoS check: warn on risky regex keys while keeping `useRegex` enabled for safe keys
    // (`matchWorldInfoKey` enforces `isSafeRegexPattern(key)` per key and falls back to literal only for risky keys).
    const useRegex = dec.useRegexOverride ?? Boolean(raw.use_regex ?? ext.use_regex ?? false);
    if (useRegex) {
      for (const k of [...keys, ...secondaryKeys, ...excludeKeys]) {
        if (!isSafeRegexPattern(k)) {
          warnings.push(`世界书「${title}」含不安全或非法正则 "${k.slice(0, 40)}"，该键已自动降级为字面匹配`);
        }
      }
    }

    const caseSensitive =
      dec.caseSensitiveOverride ?? Boolean(raw.case_sensitive ?? raw.caseSensitive ?? ext.case_sensitive ?? false);
    const matchWholeWords =
      dec.matchWholeWordsOverride ?? Boolean(raw.match_whole_words ?? raw.matchWholeWords ?? ext.match_whole_words ?? false);
    const priority = toNumber(raw.insertion_order ?? raw.order ?? raw.priority, 100);
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
