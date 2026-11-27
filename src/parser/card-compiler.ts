/**
 * End-to-end V1 / V2 / V3 / .charx Character Card Compiler.
 *
 * Guarantees:
 *  - 100% verbatim preservation of `mes_example`, `system_prompt`, `post_history_instructions`, `depth_prompt`
 *    (except surgical removal of 1.0 HTML/JS/MVU frontend shells unless `rawPassthrough: true`).
 *  - Automatic MVU variable schema salvage for L1 FSM onboarding.
 *  - Full transparent `ImportAuditReport`.
 */

import * as crypto from "node:crypto";
import type { CardSpecOrigin, CompiledCard, ImportAuditReport } from "../types.js";
import { compileLoreBook } from "./lore-compiler.js";
import { salvageMvuVariables } from "./mvu-salvage.js";
import {
  deduplicateBoilerplateAcrossFields,
  isFrontendRegexScript,
  sanitizeFrontendShell,
  type StrippedRecord,
} from "./sanitizer.js";
import { rewriteEmbeddedAssetUri } from "./unpack.js";

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
  const id = `${slug}-${crypto.createHash("sha1").update(name + asString(data.description).slice(0, 128)).digest("hex").slice(0, 6)}`;

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

  // Depth prompt from extensions.depth_prompt
  const rawDepthPromptObj =
    extensions.depth_prompt && typeof extensions.depth_prompt === "object"
      ? (extensions.depth_prompt as Record<string, unknown>)
      : null;
  const rawDepthContent = rawDepthPromptObj ? asString(rawDepthPromptObj.prompt) : "";
  const depthPromptDepth = rawDepthPromptObj && typeof rawDepthPromptObj.depth === "number" ? rawDepthPromptObj.depth : 4;
  const rawDepthRole = rawDepthPromptObj ? asString(rawDepthPromptObj.role) : "system";
  const depthPromptRole: "system" | "user" | "assistant" =
    rawDepthRole === "user" || rawDepthRole === "assistant" ? rawDepthRole : "system";

  // 1. Surgically strip frontend HTML/JS shells while keeping 100% of narrative, mes_example, and jailbreaks
  const cleanedSystemPrompt = sanitizeField("system_prompt", rawSystemPrompt);
  const cleanedDescription = sanitizeField("description", rawDescription);
  const cleanedPersonalityRaw = sanitizeField("personality", rawPersonality);
  // Only drop personality if literally identical to description
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

  // 3. Compile embedded character_book (30+ fields + V3 @@ decorators)
  const rawBook =
    data.character_book && typeof data.character_book === "object"
      ? (data.character_book as Record<string, unknown>)
      : null;
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
    .sort((a, b) => a.position - b.position || b.priority - a.priority)
    .map((e) => e.id);

  // 4. Salvage MVU / macro variables for L1 FSM
  const rawConstantLoreTexts = loreBook.entries.filter((e) => e.constant).map((e) => e.content);
  const salvagedStateSchema = salvageMvuVariables({
    firstMes: rawFirstMes,
    description: rawDescription,
    systemPrompt: rawSystemPrompt,
    postHistory: rawPostHistory,
    extensions,
    constantLoreContents: rawConstantLoreTexts,
  });

  // 5. Filter extensions.regex_scripts: strip frontend HTML/JS scripts, retain safe text-only display rules
  const displayRegexRules: CompiledCard["displayRegexRules"] = [];
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
      const rawFind = asString(rec.findRegex);
      const replaceString = asString(rec.replaceString);
      if (rawFind && rawFind.length <= 200) {
        const m = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(rawFind);
        const pattern = m ? m[1]! : rawFind;
        const flags = m ? m[2]! : "g";
        try {
          new RegExp(pattern, flags);
          displayRegexRules.push({
            name: asString(rec.scriptName) || "regex",
            pattern,
            flags,
            replacement: replaceString,
          });
        } catch {
          warnings.push(`Skipped invalid display regex script "${asString(rec.scriptName)}"`);
        }
      }
    }
  }

  // 6. V3 assets: keep static images, skip Web-only Live2D/VRM/Risu binaries
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
        skippedAssets.push({ type, name: assetName, reason: "Web-only asset type not supported in standard Pi extension" });
        continue;
      }
      if (uri) {
        assets.push({
          type,
          name: assetName,
          localPath: rewriteEmbeddedAssetUri(uri),
          ext,
        });
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
    salvagedStateSchema,
    loreBook,
    importReport,
  };
}
