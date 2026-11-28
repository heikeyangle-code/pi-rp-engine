/**
 * End-to-end V1 / V2 / V3 / .charx Character Card Compiler.
 *
 * Guarantees:
 *  - 100% verbatim preservation of `mes_example`, `system_prompt`, `post_history_instructions`, `depth_prompt`
 *    (except surgical removal of 1.0 HTML/JS/MVU frontend shells unless `rawPassthrough: true`).
 *  - Pre-sanitization MVU variable schema salvage (scans RAW card & RAW constant lore BEFORE stripping!).
 *  - Official SillyTavern `regex_scripts` placement / markdownOnly / promptOnly / trimStrings / substituteRegex parsing.
 *  - Full transparent `ImportAuditReport`.
 */

import * as crypto from "node:crypto";
import type { CardSpecOrigin, CompiledCard, CompiledRegexRule, ImportAuditReport } from "../types.js";
import { compileLoreBook, extractRawLoreEntries, isSafeRegexPattern } from "./lore-compiler.js";
import { salvageMvuVariables } from "./mvu-salvage.js";
import { extractPlainTextStats, inferHeuristicWorldProfile } from "./world-profile.js";
import {
  deduplicateBoilerplateAcrossFields,
  isFrontendRegexScript,
  parseStRegexString,
  sanitizeFrontendShell,
  type StrippedRecord,
} from "./sanitizer.js";
import { rewriteEmbeddedAssetUri } from "./unpack.js";
import { compileCardKnowledgeIndex } from "./card-knowledge.js";

const WEB_ONLY_ASSET_TYPES = new Set(["live2d", "vrm", "x-risu-asset", "x-risu-bg", "video"]);

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || `card-${crypto.randomBytes(3).toString("hex")}`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

export function compileCharacterCard(
  rawJson: Record<string, unknown>,
  specOrigin: CardSpecOrigin,
  options: { rawPassthrough?: boolean; avatarPath?: string } = {},
): CompiledCard {
  const rawPassthrough = Boolean(options.rawPassthrough);
  const data = (
    rawJson.data && typeof rawJson.data === "object" && !Array.isArray(rawJson.data)
      ? rawJson.data
      : rawJson
  ) as Record<string, unknown>;

  const extensions = (
    data.extensions && typeof data.extensions === "object" && !Array.isArray(data.extensions)
      ? data.extensions
      : {}
  ) as Record<string, unknown>;

  const name = asString(data.name).trim() || "Unnamed Character";
  const nickname = asString(data.nickname).trim() || undefined;
  const slug = slugify(name);
  const id = `${slug}-${crypto.createHash("sha1").update(name + "\0" + asString(data.description)).digest("hex").slice(0, 8)}`;

  const strippedAll: StrippedRecord[] = [];
  const warnings: string[] = [];

  const sanitizeField = (field: string, value: string): string => {
    const res = sanitizeFrontendShell(value, field, rawPassthrough);
    strippedAll.push(...res.stripped);
    return res.cleaned;
  };

  const rawSystemPrompt = asString(data.system_prompt);
  const rawDescription = asString(data.description);
  const rawPersonality = asString(data.personality);
  const rawScenario = asString(data.scenario);
  const rawMesExample = asString(data.mes_example);
  const rawPostHistory = asString(data.post_history_instructions);
  const rawFirstMes = asString(data.first_mes);

  const rawDepthPromptObj =
    extensions.depth_prompt && typeof extensions.depth_prompt === "object"
      ? (extensions.depth_prompt as Record<string, unknown>)
      : null;
  const rawDepthContent = rawDepthPromptObj ? asString(rawDepthPromptObj.prompt) : "";
  const depthPromptDepth = rawDepthPromptObj && typeof rawDepthPromptObj.depth === "number" ? rawDepthPromptObj.depth : 4;
  const rawDepthRole = rawDepthPromptObj ? asString(rawDepthPromptObj.role) : "system";
  const depthPromptRole: "system" | "user" | "assistant" =
    rawDepthRole === "user" || rawDepthRole === "assistant" ? rawDepthRole : "system";

  // 0. Salvage MVU / InitVar / nested YAML / JSONPatch / HTML-table / macro variables from ALL RAW pre-sanitization content
  //    (CRITICAL: includes disabled & non-constant `[InitVar]` lorebook entries!)
  const rawBook =
    data.character_book && typeof data.character_book === "object"
      ? (data.character_book as Record<string, unknown>)
      : null;
  const rawAllLoreEntries = extractRawLoreEntries(rawBook)
    .map((entry) => ({
      name: asString(entry.name),
      comment: asString(entry.comment),
      keys: asStringArray(entry.keys ?? entry.key),
      content: asString(entry.content),
      constant: Boolean(entry.constant),
      enabled: entry.enabled !== false && entry.disable !== true,
    }))
    .filter((e) => e.content.length > 0);

  const rawAlternateGreetings = asStringArray(data.alternate_greetings);

  const mvuSalvaged = salvageMvuVariables({
    firstMes: rawFirstMes,
    alternateGreetings: rawAlternateGreetings,
    description: rawDescription,
    systemPrompt: rawSystemPrompt,
    postHistory: rawPostHistory,
    extensions,
    rawAllLoreEntries,
  });
  const plainStats = extractPlainTextStats(`${rawScenario}\n${rawFirstMes}`);
  const salvagedByKey = new Map(
    mvuSalvaged.map((v) => [`${(v.actorId ?? "").toLowerCase()}::${v.key.toLowerCase()}`, v]),
  );
  const plainKeysExisting = new Set(mvuSalvaged.map((v) => v.key.toLowerCase()));
  for (const ps of plainStats) {
    if (!plainKeysExisting.has(ps.key.toLowerCase())) {
      salvagedByKey.set(`::${ps.key.toLowerCase()}`, ps);
    }
  }
  const salvagedStateSchema = Array.from(salvagedByKey.values());

  // 1. Surgically strip frontend HTML/JS shells while keeping 100% of narrative, mes_example, and jailbreaks
  const cleanedSystemPrompt = sanitizeField("system_prompt", rawSystemPrompt);
  const cleanedDescription = sanitizeField("description", rawDescription);
  const cleanedPersonalityRaw = sanitizeField("personality", rawPersonality);
  const cleanedPersonality =
    !rawPassthrough && cleanedPersonalityRaw && cleanedPersonalityRaw === cleanedDescription
      ? ""
      : cleanedPersonalityRaw;
  const cleanedScenario = sanitizeField("scenario", rawScenario);
  const cleanedMesExample = sanitizeField("mes_example", rawMesExample);
  const cleanedPostHistory = sanitizeField("post_history_instructions", rawPostHistory);
  const cleanedDepthContent = sanitizeField("depth_prompt", rawDepthContent);
  const cleanedFirstMes = sanitizeField("first_mes", rawFirstMes);

  // 2. Deduplicate ONLY repeated anti-godmoding boilerplate across rule fields (never touches mes_example!)
  const dedup = deduplicateBoilerplateAcrossFields(
    [
      { field: "system_prompt", text: cleanedSystemPrompt },
      { field: "depth_prompt", text: cleanedDepthContent },
      { field: "post_history_instructions", text: cleanedPostHistory },
    ],
    rawPassthrough,
  );
  const finalSystemPrompt = dedup.fields[0]!.text;
  const finalDepthContent = dedup.fields[1]!.text;
  const finalPostHistory = dedup.fields[2]!.text;

  // 3. Compile embedded character_book (30+ fields + full V3 @@ decorators)
  const loreBook = compileLoreBook(rawBook, {
    rawPassthrough,
    staticScan: {
      description: cleanedDescription,
      personality: cleanedPersonality,
      scenario: cleanedScenario,
      depthPrompt: finalDepthContent,
      creatorNotes: asString(data.creator_notes),
    },
  });
  warnings.push(...loreBook.warnings);

  const constantLoreIds = loreBook.entries
    .filter((e) => e.enabled && e.constant && e.content.length > 0 && [0, 1, 5, 6].includes(e.position))
    .sort((a, b) => a.position - b.position || b.priority - a.priority || a.id.localeCompare(b.id))
    .map((e) => e.id);

  // 4. Filter extensions.regex_scripts: respect official ST placement, promptOnly, markdownOnly, trimStrings, substituteRegex
  const displayRegexRules: CompiledRegexRule[] = [];
  const promptRegexRules: CompiledRegexRule[] = [];
  if (Array.isArray(extensions.regex_scripts)) {
    for (const item of extensions.regex_scripts) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      if (rec.disabled === true) continue;

      if (isFrontendRegexScript(rec)) {
        strippedAll.push({
          field: "extensions.regex_scripts",
          kind: "frontend_regex_script",
          preview: asString(rec.scriptName) || asString(rec.findRegex).slice(0, 60),
          charsRemoved: asString(rec.replaceString).length,
        });
        continue;
      }

      const placements = Array.isArray(rec.placement)
        ? rec.placement.filter((p): p is number => typeof p === "number")
        : [2];
      const promptOnly = Boolean(rec.promptOnly);
      const markdownOnly = Boolean(rec.markdownOnly);

      const rawFind = asString(rec.findRegex);
      const replaceString = asString(rec.replaceString);
      const parsedRe = parseStRegexString(rawFind);
      if (parsedRe && isSafeRegexPattern(parsedRe.pattern)) {
        const subRaw = typeof rec.substituteRegex === "number" ? rec.substituteRegex : 0;
        const substituteRegex: 0 | 1 | 2 = subRaw === 1 ? 1 : subRaw === 2 ? 2 : 0;
        const compiledRule: CompiledRegexRule = {
          name: asString(rec.scriptName) || "regex",
          pattern: parsedRe.pattern,
          flags: parsedRe.flags,
          replacement: replaceString,
          placements,
          trimStrings: asStringArray(rec.trimStrings),
          substituteRegex,
          markdownOnly,
          promptOnly,
          minDepth: typeof rec.minDepth === "number" ? rec.minDepth : undefined,
          maxDepth: typeof rec.maxDepth === "number" ? rec.maxDepth : undefined,
        };
        if (promptOnly || placements.includes(1) || placements.includes(5)) {
          promptRegexRules.push(compiledRule);
        }
        if (!promptOnly && (placements.length === 0 || placements.includes(2))) {
          displayRegexRules.push(compiledRule);
        }
      } else if (rawFind) {
        warnings.push(`跳过非法或不安全的展示正则脚本「${asString(rec.scriptName) || rawFind.slice(0, 24)}」`);
      }
    }
  }

  // 5. V3 assets: keep static images, skip Web-only Live2D/VRM/Risu binaries
  const assets: CompiledCard["assets"] = [];
  const skippedAssets: ImportAuditReport["skippedAssets"] = [];
  if (Array.isArray(data.assets)) {
    for (const a of data.assets) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const type = asString(rec.type).toLowerCase() || "icon";
      const assetName = asString(rec.name) || "asset";
      const ext = asString(rec.ext).toLowerCase() || "png";
      const uri = asString(rec.uri);
      if (WEB_ONLY_ASSET_TYPES.has(type) || type.startsWith("x-risu-")) {
        skippedAssets.push({ type, name: assetName, reason: "Web 专有资产格式，标准 Pi 扩展跳过" });
        continue;
      }
      if (uri) {
        try {
          assets.push({
            type,
            name: assetName,
            localPath: rewriteEmbeddedAssetUri(uri),
            ext,
          });
        } catch (err) {
          const msg = (err as Error).message;
          skippedAssets.push({ type, name: assetName, reason: `非法资产路径: ${msg}` });
          warnings.push(`跳过非法资产路径「${assetName}」: ${msg}`);
        }
      }
    }
  }

  const aliases = Array.from(new Set([name, ...(nickname ? [nickname] : [])]));
  const talkativeness =
    typeof extensions.talkativeness === "number"
      ? extensions.talkativeness
      : typeof extensions.talkativeness === "string" && !Number.isNaN(Number(extensions.talkativeness))
        ? Number(extensions.talkativeness)
        : undefined;

  const preservedFields: string[] = [];
  if (finalSystemPrompt) preservedFields.push("system_prompt");
  if (cleanedDescription) preservedFields.push("description");
  if (cleanedPersonality) preservedFields.push("personality");
  if (cleanedScenario) preservedFields.push("scenario");
  if (cleanedMesExample) preservedFields.push("mes_example");
  if (finalDepthContent) preservedFields.push("depth_prompt");
  if (finalPostHistory) preservedFields.push("post_history_instructions");

  const importReport: ImportAuditReport = {
    specOrigin,
    rawPassthrough,
    preservedFields,
    mesExampleCharsBefore: rawMesExample.length,
    mesExampleCharsAfter: cleanedMesExample.length,
    strippedItems: strippedAll,
    deduplicatedRules: dedup.deduplicated,
    salvagedVariables: salvagedStateSchema,
    loreCount: loreBook.entries.length,
    constantLoreCount: constantLoreIds.length,
    dynamicLoreCount: loreBook.entries.filter((e) => e.enabled && !e.constant).length,
    skippedAssets,
    warnings,
  };

  return {
    id,
    slug,
    specOrigin,
    rawPassthrough,
    identity: {
      name,
      nickname,
      aliases,
      avatarPath: options.avatarPath,
      talkativeness,
    },
    frozen: {
      systemPrompt: finalSystemPrompt,
      description: cleanedDescription,
      personality: cleanedPersonality,
      scenario: cleanedScenario,
      mesExample: cleanedMesExample,
      constantLoreIds,
    },
    tailInstructions: {
      depthPrompt: finalDepthContent
        ? { content: finalDepthContent, depth: depthPromptDepth, role: depthPromptRole }
        : undefined,
      postHistoryInstructions: finalPostHistory,
    },
    greetings: {
      firstMes: cleanedFirstMes,
      alternates: asStringArray(data.alternate_greetings).map((g, i) => sanitizeField(`alternate_greetings[${i}]`, g)),
      groupOnly: asStringArray(data.group_only_greetings).map((g, i) => sanitizeField(`group_only_greetings[${i}]`, g)),
    },
    assets,
    meta: {
      creator: asString(data.creator) || undefined,
      version: asString(data.character_version) || undefined,
      tags: asStringArray(data.tags),
      creatorNotes: asString(data.creator_notes) || undefined,
      creatorNotesMultilingual:
        data.creator_notes_multilingual && typeof data.creator_notes_multilingual === "object"
          ? (data.creator_notes_multilingual as Record<string, string>)
          : undefined,
      source: asStringArray(data.source),
    },
    displayRegexRules,
    promptRegexRules,
    knowledgeIndex: compileCardKnowledgeIndex({
      id,
      identity: { name, nickname, aliases, avatarPath: options.avatarPath, talkativeness },
      frozen: {
        systemPrompt: finalSystemPrompt,
        description: cleanedDescription,
        personality: cleanedPersonality,
        scenario: cleanedScenario,
        mesExample: cleanedMesExample,
        constantLoreIds,
      },
    }),
    salvagedStateSchema,
    worldProfile: inferHeuristicWorldProfile({
      description: cleanedDescription,
      personality: cleanedPersonality,
      scenario: cleanedScenario,
      firstMes: cleanedFirstMes,
      loreEntries: loreBook.entries,
      salvagedVariables: salvagedStateSchema,
      hasGroupGreetings: asStringArray(data.group_only_greetings).length > 0,
    }),
    loreBook,
    importReport,
  };
}

/** Losslessly merge edited CompiledCard fields & loreBook back onto original rawJson as CCV3 JSON. */
export function exportCardToCcv3Json(
  rawJson: Record<string, unknown> | null,
  card: CompiledCard,
): Record<string, unknown> {
  const baseRaw = rawJson && typeof rawJson === "object" ? JSON.parse(JSON.stringify(rawJson)) : {};
  const baseData = (baseRaw.data && typeof baseRaw.data === "object" ? baseRaw.data : baseRaw) as Record<string, unknown>;
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      ...baseData,
      name: card.identity.name,
      nickname: card.identity.nickname ?? baseData.nickname ?? "",
      description: card.frozen.description,
      personality: card.frozen.personality,
      scenario: card.frozen.scenario,
      mes_example: card.frozen.mesExample,
      system_prompt: card.frozen.systemPrompt,
      post_history_instructions: card.tailInstructions.postHistoryInstructions,
      first_mes: card.greetings.firstMes,
      alternate_greetings: card.greetings.alternates,
      group_only_greetings: card.greetings.groupOnly,
      tags: card.meta.tags,
      creator: card.meta.creator ?? baseData.creator ?? "",
      character_version: card.meta.version ?? baseData.character_version ?? "",
      creator_notes: card.meta.creatorNotes ?? baseData.creator_notes ?? "",
      modification_date: Math.floor(Date.now() / 1000),
      character_book: {
        name: card.loreBook.name ?? card.identity.name,
        description: card.loreBook.description ?? "",
        token_budget: card.loreBook.tokenBudget,
        scan_depth: card.loreBook.scanDepth,
        entries: card.loreBook.entries.map((e, idx) => ({
          id: e.id,
          comment: e.title,
          name: e.title,
          keys: e.keys,
          secondary_keys: e.secondaryKeys,
          content: e.content,
          enabled: e.enabled,
          constant: e.constant,
          selective: e.selective,
          use_regex: e.useRegex,
          case_sensitive: e.caseSensitive,
          insertion_order: e.priority,
          priority: e.priority,
          position: e.position,
          extensions: {
            selectiveLogic: e.selectiveLogic,
            match_whole_words: e.matchWholeWords,
            prevent_recursion: e.preventRecursion ?? false,
            exclude_recursion: e.excludeRecursion ?? false,
            delay_until_recursion: e.graphSecondHopOnly,
            depth: e.depthHint,
            role: e.role,
            sticky: e.stickyTurns,
            cooldown: e.cooldownTurns,
            probability: e.probability,
            useProbability: e.useProbability,
            group: e.group,
            group_override: e.groupOverride,
            group_weight: e.groupWeight,
            use_group_scoring: e.useGroupScoring,
            ignore_budget: e.pinned,
            outlet_name: e.outletName,
            ...(e.gate ? { gate: e.gate } : {}),
          },
          _order: idx,
        })),
      },
    },
  };
}
