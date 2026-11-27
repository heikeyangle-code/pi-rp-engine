/**
 * Full SillyTavern / CCV3 Lorebook (World Info) compiler:
 *  - Supports all 30+ World Info fields (both array `entries` and keyed object `{ "0": ... }`).
 *  - Parses & strips V3 `@@` / `@@@` decorators from content.
 *  - Maps `delay` / `@@activate_only_after` -> `gate.minTurn`, `@@activate_only_every` -> `gate.everyNTurns`.
 *  - Enforces ReDoS-safe regex compilation with automatic literal fallback.
 *  - Performs one-time static scan for `match_character_*` flags.
 *  - Extracts entity index terms for local HippoRAG 2 PPR graph recall.
 */

import type { CompiledLoreBook, CompiledLoreEntry, GateCondition, SelectiveLogic } from "../types.js";
import { sanitizeFrontendShell } from "./sanitizer.js";

const MAX_REGEX_LENGTH = 200;
// Reject obvious catastrophic backtracking shapes like (a+)+, (.*)+, (.+)*
const REDOS_RISK_PATTERN = /\([^)]*[+*][^)]*\)[+*?]|\(\?:[^)]*[+*][^)]*\)[+*?]/;

export function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_REGEX_LENGTH) return false;
  if (REDOS_RISK_PATTERN.test(pattern)) return false;
  try {
    new RegExp(pattern);
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

export interface ParsedDecorators {
  cleanedContent: string;
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
}

/** Parse CCV3 `@@` / `@@@` leading decorators and strip all decorator lines from content. */
export function parseV3Decorators(content: string): ParsedDecorators {
  const lines = content.split("\n");
  const kept: string[] = [];
  let manualRecallOnly = false;
  let minTurn: number | undefined;
  let everyNTurns: number | undefined;
  let stickyPermanent = false;
  let oneShot = false;
  const additionalKeys: string[] = [];
  const excludeKeys: string[] = [];
  let lowBudgetPriority = false;
  let positionOverride: number | undefined;
  let depthOverride: number | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@@")) {
      kept.push(line);
      continue;
    }
    // Strip leading @@ or @@@
    const body = trimmed.replace(/^@{2,3}/, "").trim();
    const spaceIdx = body.search(/\s+/);
    const name = (spaceIdx >= 0 ? body.slice(0, spaceIdx) : body).toLowerCase();
    const arg = spaceIdx >= 0 ? body.slice(spaceIdx).trim() : "";

    switch (name) {
      case "dont_activate":
        manualRecallOnly = true;
        break;
      case "activate_only_after": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n >= 0) minTurn = n;
        break;
      }
      case "activate_only_every": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n > 0) everyNTurns = n;
        break;
      }
      case "keep_activate_after_match":
        stickyPermanent = true;
        break;
      case "dont_activate_after_match":
        oneShot = true;
        break;
      case "additional_keys":
        additionalKeys.push(...toStringArray(arg));
        break;
      case "exclude_keys":
        excludeKeys.push(...toStringArray(arg));
        break;
      case "ignore_on_max_context":
        lowBudgetPriority = true;
        break;
      case "depth": {
        const n = parseInt(arg, 10);
        if (Number.isFinite(n) && n >= 0) depthOverride = n;
        break;
      }
      case "position":
        if (arg === "before_desc" || arg === "0") positionOverride = 0;
        else if (arg === "after_desc" || arg === "1") positionOverride = 1;
        else if (arg === "in_chat" || arg === "4") positionOverride = 4;
        break;
      default:
        // Unknown decorator line is still stripped so raw @@ syntax never leaks to LLM
        break;
    }
  }

  return {
    cleanedContent: kept.join("\n").trim(),
    manualRecallOnly,
    minTurn,
    everyNTurns,
    stickyPermanent,
    oneShot,
    additionalKeys,
    excludeKeys,
    lowBudgetPriority,
    positionOverride,
    depthOverride,
  };
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

/** Compile a SillyTavern / CCV3 character_book or standalone Lorebook JSON object. */
export function compileLoreBook(
  rawBook: Record<string, unknown> | undefined | null,
  options: { rawPassthrough?: boolean; staticScan?: StaticScanContext } = {},
): CompiledLoreBook {
  const warnings: string[] = [];
  if (!rawBook || typeof rawBook !== "object") {
    return { tokenBudget: 1800, scanDepth: 4, entries: [], warnings };
  }

  const rawEntriesField = rawBook.entries;
  let rawList: Record<string, unknown>[] = [];
  if (Array.isArray(rawEntriesField)) {
    rawList = rawEntriesField.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
  } else if (rawEntriesField && typeof rawEntriesField === "object") {
    rawList = Object.values(rawEntriesField as Record<string, unknown>).filter(
      (x): x is Record<string, unknown> => Boolean(x && typeof x === "object"),
    );
  }

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

    // Enabled normalization: standalone books use `disable: true`, card books use `enabled: boolean`
    const enabled =
      typeof raw.enabled === "boolean"
        ? raw.enabled
        : typeof raw.disable === "boolean"
          ? !raw.disable
          : true;

    const constant = Boolean(raw.constant);
    const keys = [...toStringArray(raw.keys ?? raw.key), ...dec.additionalKeys];
    let secondaryKeys = toStringArray(raw.secondary_keys ?? raw.keysecondary);
    let selective = Boolean(raw.selective ?? secondaryKeys.length > 0);
    let selectiveLogic = mapSelectiveLogic(raw.selectiveLogic ?? ext.selectiveLogic);

    if (dec.excludeKeys.length > 0) {
      secondaryKeys = [...secondaryKeys, ...dec.excludeKeys];
      selective = true;
      selectiveLogic = "NOT_ANY";
    }

    let useRegex = Boolean(raw.use_regex ?? ext.use_regex ?? false);
    if (useRegex) {
      const badKey = [...keys, ...secondaryKeys].find((k) => !isSafeRegexPattern(k));
      if (badKey !== undefined) {
        warnings.push(`Lore "${title}": unsafe or invalid regex "${badKey.slice(0, 40)}", downgraded to literal matching`);
        useRegex = false;
      }
    }

    const caseSensitive = Boolean(raw.case_sensitive ?? raw.caseSensitive ?? ext.case_sensitive ?? false);
    const matchWholeWords = Boolean(raw.match_whole_words ?? raw.matchWholeWords ?? ext.match_whole_words ?? false);
    const priority = toNumber(raw.priority ?? raw.order ?? raw.insertion_order, 100);
    const rawPos = dec.positionOverride ?? raw.position ?? ext.position;
    const position = typeof rawPos === "string" ? (rawPos === "before_char" ? 0 : rawPos === "after_char" ? 1 : 4) : toNumber(rawPos, 4);
    const depthHint = dec.depthOverride ?? toNumber(raw.depth ?? ext.depth, 4);
    const pinned = Boolean(raw.ignore_budget ?? raw.ignoreBudget ?? ext.ignore_budget ?? false);

    const delay = toNumber(raw.delay ?? ext.delay, 0);
    const stickyTurns = toNumber(raw.sticky ?? ext.sticky, 0);
    const cooldownTurns = toNumber(raw.cooldown ?? ext.cooldown, 0);
    const probability = toNumber(raw.probability ?? ext.probability, 100);
    const useProbability = Boolean(raw.useProbability ?? ext.useProbability ?? probability < 100);
    const group = typeof (raw.group ?? ext.group) === "string" && String(raw.group ?? ext.group).trim()
      ? String(raw.group ?? ext.group).trim()
      : undefined;
    const groupOverride = Boolean(raw.group_override ?? raw.groupOverride ?? ext.group_override ?? false);
    const groupWeight = toNumber(raw.group_weight ?? raw.groupWeight ?? ext.group_weight, 100);
    const useGroupScoring = Boolean(raw.use_group_scoring ?? raw.useGroupScoring ?? ext.use_group_scoring ?? false);

    const noGraphSpread = Boolean(
      raw.prevent_recursion ?? raw.preventRecursion ?? ext.prevent_recursion ??
      raw.exclude_recursion ?? raw.excludeRecursion ?? ext.exclude_recursion ?? false,
    );
    const graphSecondHopOnly = Boolean(
      raw.delay_until_recursion ?? raw.delayUntilRecursion ?? ext.delay_until_recursion ?? false,
    );

    const outletName =
      typeof (raw.outletName ?? ext.outlet_name) === "string" && String(raw.outletName ?? ext.outlet_name).trim()
        ? String(raw.outletName ?? ext.outlet_name).trim()
        : undefined;

    // Build physical GateCondition from delay / decorators / explicit gate extension
    const gate: GateCondition = {};
    const effectiveMinTurn = Math.max(delay, dec.minTurn ?? 0);
    if (effectiveMinTurn > 0) gate.minTurn = effectiveMinTurn;
    if (dec.everyNTurns !== undefined) gate.everyNTurns = dec.everyNTurns;
    if (ext.gate && typeof ext.gate === "object") {
      Object.assign(gate, ext.gate as GateCondition);
    }
    const hasGate = Object.keys(gate).length > 0;

    // One-time static evaluation of match_character_* flags
    let staticPrebound = false;
    if (options.staticScan && !constant && keys.length > 0) {
      const scanPool: string[] = [];
      if (raw.matchCharacterDescription ?? ext.match_character_description) scanPool.push(options.staticScan.description ?? "");
      if (raw.matchCharacterPersonality ?? ext.match_character_personality) scanPool.push(options.staticScan.personality ?? "");
      if (raw.matchScenario ?? ext.match_scenario) scanPool.push(options.staticScan.scenario ?? "");
      if (raw.matchCharacterDepthPrompt ?? ext.match_character_depth_prompt) scanPool.push(options.staticScan.depthPrompt ?? "");
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
      selective,
      selectiveLogic,
      useRegex,
      caseSensitive,
      matchWholeWords,
      priority,
      position,
      depthHint,
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
