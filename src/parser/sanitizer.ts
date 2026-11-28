/**
 * Surgical whitelist-based FrontendSanitizer, Balanced HTML Container Stripper,
 * DuplicateRuleMerger & Official SillyTavern Display Regex Engine.
 *
 * Constitutional fidelity guarantees:
 *  1. NEVER truncate or summarize `mes_example`.
 *  2. NEVER censor or alter jailbreaks, writing-style guides, POV rules, or author constraints.
 *  3. ONLY strip SillyTavern 1.0 frontend shells (<script>, <style>, <iframe>, <svg>, balanced nested styled HTML
 *     status bars, <initvar>/<UpdateVariable> MVU blocks, _.set(...) JS patches, ST /setvar slash script blocks).
 *  4. ONLY deduplicate near-identical anti-godmoding boilerplate appearing >= 2 times across rule fields.
 */

import type { CompiledRegexRule } from "../types.js";
import { evaluateMacros, type MacroContext } from "./macros.js";

export interface StrippedRecord {
  field: string;
  kind: string;
  preview: string;
  charsRemoved: number;
}

export interface DeduplicatedRecord {
  field: string;
  preview: string;
}

const SIMPLE_FRONTEND_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "script_tag", regex: /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi },
  { kind: "style_tag", regex: /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi },
  { kind: "iframe_tag", regex: /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<iframe\b[^>]*\/?>/gi },
  { kind: "svg_tag", regex: /<svg\b[^>]*>[\s\S]*?<\/svg\s*>|<svg\b[^>]*\/>/gi },
  { kind: "mvu_initvar_block", regex: /<initvar\b[^>]*>[\s\S]*?<\/initvar\s*>/gi },
  { kind: "mvu_update_block", regex: /<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi },
  { kind: "mvu_status_block", regex: /<StatusPlaceHolderImpl\s*\/?>/gi },
  {
    kind: "mvu_js_patch",
    regex: /```(?:js|javascript|json)?\s*\n(?:[^\n]*?(?:_\.(?:set|assign|unset|add)\s*\(|TavernHelper|triggerSlash)[\s\S]*?)```/gi,
  },
  {
    kind: "st_slash_script",
    regex: /(?:^|\n)(?:\/(?:setvar|addvar|getvar|echo|trigger|flushvar|setglobalvar)\b[^\n]*(?:\n|$)){2,}/gi,
  },
];

// Narrow <details> matching so narrative collapsibles like `<details class="summary-card">` are preserved
// while styled status panels (`<details style="...">` or `<details class="status-panel">`) are still stripped.
const STYLED_CONTAINER_OPEN =
  /<(?:(div|section|table)\b[^>]*\b(?:style|class|onclick|onload)\s*=\s*["'][^"']*(?:display\s*:\s*(?:flex|grid)|grid-template|background|border|status|stat|hud|card|panel|st-|mvu|bar|box|progress|font-size|padding|margin|color\s*:)[^"']*["']|(details)\b[^>]*\b(?:(?:style|onclick|onload)\s*=\s*["'][^"']*(?:display\s*:\s*(?:flex|grid)|grid-template|background|border|font-size|padding|margin|color\s*:)[^"']*["']|class\s*=\s*["'][^"']*(?:status|hud|mvu|st-)[^"']*["']))[^>]*>/i;

function previewOf(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact;
}

/**
 * Balanced-depth HTML container stripper: accurately removes nested
 * `<div class="status-card"><div>HP</div><div>MP</div></div>` without stopping at the first inner `</div>`
 * and without leaving broken HTML fragments behind.
 */
export function stripBalancedStyledHtmlContainers(
  input: string,
  field: string,
  stripped: StrippedRecord[],
): string {
  let text = input;
  let guard = 0;

  while (guard++ < 64) {
    const m = STYLED_CONTAINER_OPEN.exec(text);
    if (!m || m.index === undefined) break;

    const tagName = (m[1] ?? m[2])!.toLowerCase();
    const startIdx = m.index;
    const afterOpen = startIdx + m[0].length;

    const tagRe = new RegExp(`<(\\/)?${tagName}\\b[^>]*>`, "gi");
    tagRe.lastIndex = afterOpen;

    let depth = 1;
    let endIdx = -1;
    let tm: RegExpExecArray | null;
    while ((tm = tagRe.exec(text)) !== null) {
      const fullTag = tm[0];
      const isClosing = Boolean(tm[1]);
      const isSelfClosing = fullTag.endsWith("/>");
      if (isSelfClosing) continue;
      if (isClosing) {
        depth -= 1;
        if (depth === 0) {
          endIdx = tm.index + fullTag.length;
          break;
        }
      } else {
        depth += 1;
      }
    }

    if (endIdx < 0) {
      // Unclosed stray opening tag — remove only the opening tag so narrative text isn't lost
      const removed = text.slice(startIdx, afterOpen);
      stripped.push({
        field,
        kind: "html_status_panel",
        preview: previewOf(removed),
        charsRemoved: removed.length,
      });
      text = text.slice(0, startIdx) + text.slice(afterOpen);
    } else {
      const removed = text.slice(startIdx, endIdx);
      stripped.push({
        field,
        kind: "html_status_panel",
        preview: previewOf(removed),
        charsRemoved: removed.length,
      });
      text = text.slice(0, startIdx) + text.slice(endIdx);
    }
  }

  return text;
}

/**
 * Surgically strip 1.0 frontend shells from a field while preserving all narrative text,
 * literary angle-bracket actions/thoughts, markdown formatting, and author/jailbreak rules.
 */
export function sanitizeFrontendShell(
  text: string,
  field: string,
  rawPassthrough = false,
): { cleaned: string; stripped: StrippedRecord[] } {
  if (!text || rawPassthrough) {
    return { cleaned: text, stripped: [] };
  }

  let current = text;
  const stripped: StrippedRecord[] = [];

  for (const { kind, regex } of SIMPLE_FRONTEND_PATTERNS) {
    regex.lastIndex = 0;
    current = current.replace(regex, (match) => {
      stripped.push({
        field,
        kind,
        preview: previewOf(match),
        charsRemoved: match.length,
      });
      return "";
    });
  }

  current = stripBalancedStyledHtmlContainers(current, field, stripped);

  if (stripped.length > 0) {
    current = current.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { cleaned: current, stripped };
}

/** Check if a SillyTavern regex_script is a frontend HTML/CSS/JS presentation script (to be stripped). */
export function isFrontendRegexScript(script: Record<string, unknown>): boolean {
  const replace = typeof script.replaceString === "string" ? script.replaceString : "";
  // Pure cleanup scripts (empty replacement) strip unwanted tags rather than injecting frontend HTML/CSS/JS
  if (replace.trim() === "") return false;
  const find = typeof script.findRegex === "string" ? script.findRegex : "";
  const combined = `${find}\n${replace}`;
  return /<(?:div|span|style|script|iframe|table|details|svg|button|input)\b|\bstyle\s*=|\bclass\s*=|display\s*:\s*(?:flex|grid)|TavernHelper|UpdateVariable/i.test(
    combined,
  );
}

/** Parse a SillyTavern `/pattern/flags` string into pattern + flags. */
export function parseStRegexString(raw: string): { pattern: string; flags: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(trimmed);
  if (m) {
    return { pattern: m[1]!, flags: m[2] || "g" };
  }
  return { pattern: trimmed, flags: "g" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply SillyTavern-compatible display regex rules (respecting placement=2 AI_OUTPUT,
 * substituteRegex 0/1/2, and trimStrings) to assistant markdown without altering stored JSONL.
 */
export function applyDisplayRegexRules(
  markdown: string,
  rules: CompiledRegexRule[],
  macroCtx?: MacroContext,
): string {
  if (!markdown || rules.length === 0) return markdown;
  let out = markdown;

  for (const rule of rules) {
    // Only apply rules that target AI_OUTPUT (placement 2) and are not promptOnly
    if (rule.promptOnly) continue;
    if (rule.placements.length > 0 && !rule.placements.includes(2)) continue;

    let pattern = rule.pattern;
    if (macroCtx && rule.substituteRegex !== 0) {
      if (rule.substituteRegex === 1) {
        pattern = evaluateMacros(pattern, macroCtx);
      } else if (rule.substituteRegex === 2) {
        pattern = evaluateMacros(pattern, {
          ...macroCtx,
          charName: escapeRegExp(macroCtx.charName),
          userName: escapeRegExp(macroCtx.userName),
        });
      }
    }

    try {
      const re = new RegExp(pattern, rule.flags);
      out = out.replace(re, (...args) => {
        const rawMatch = String(args[0] ?? "");
        // Detect trailing `groups` object passed by JS when the regex has named capture groups
        const hasGroups =
          args.length >= 4 &&
          typeof args[args.length - 1] === "object" &&
          args[args.length - 1] !== null &&
          typeof args[args.length - 2] === "string" &&
          typeof args[args.length - 3] === "number";
        const captures = args.slice(1, hasGroups ? -3 : -2);
        const groups = hasGroups ? (args[args.length - 1] as Record<string, string | undefined>) : undefined;

        let trimmedMatch = rawMatch;
        for (const rawTrim of rule.trimStrings) {
          if (!rawTrim) continue;
          const trim = macroCtx ? evaluateMacros(rawTrim, macroCtx) : rawTrim;
          if (trim) trimmedMatch = trimmedMatch.split(trim).join("");
        }

        const template = macroCtx ? evaluateMacros(rule.replacement, macroCtx) : rule.replacement;

        // Single-pass replacement for {{match}}, $&, $$, $<name>, and $1..$n so `$100` inside
        // matched text or capture groups is never corrupted by a second substitution pass.
        return template.replace(
          /\{\{match\}\}|\$\$|\$&|\$<([^>]+)>|\$(\d+)/gi,
          (token, namedGroup: string | undefined, numTok: string | undefined) => {
            if (token.toLowerCase() === "{{match}}" || token === "$&") return trimmedMatch;
            if (token === "$$") return "$";
            if (namedGroup !== undefined) {
              return groups && groups[namedGroup] !== undefined ? String(groups[namedGroup]) : "";
            }
            if (numTok !== undefined) {
              const idx = parseInt(numTok, 10) - 1;
              return idx >= 0 && idx < captures.length && captures[idx] !== undefined ? String(captures[idx]) : "";
            }
            return token;
          },
        );
      });
    } catch {
      // Skip invalid regex safely
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DuplicateRuleMerger: ONLY merges duplicate anti-godmoding boilerplate
// ---------------------------------------------------------------------------

const ANTI_GODMODE_SIGNATURE =
  /(?:不要|严禁|禁止|切勿|不得|never|do not|don't|must not|avoid).{0,24}(?:替|代|代表|控制|扮演|speak for|act for|control|impersonate|decide for|write for).{0,24}(?:\{\{user\}\}|<user>|用户|玩家|主角|user)/i;

function normalizeRuleSentence(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[\s\-*•·\d.()【】\[\]]+/, "")
    .replace(/(?:严禁|禁止|不要|切勿|不得|never|do not|don't|must not|avoid)/g, "禁止")
    .replace(/(?:\{\{user\}\}|<user>|用户|玩家|主角|user)/g, "U")
    .replace(/(?:代替|代表|替|代)/g, "替")
    .replace(/[，。！？、；："'`~,.!?;:()\[\]{}或和与]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function bigramDiceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) ?? 0;
    if (count > 0) {
      overlap++;
      bigramsA.set(bg, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/**
 * Deduplicate ONLY repeated anti-godmoding boilerplate lines across ordered fields.
 * First occurrence (highest priority field) is ALWAYS kept; subsequent near-identical
 * duplicates (Dice similarity >= 0.72) are removed and recorded in the audit log.
 * Non-duplicate rules (jailbreaks, POV, style, pacing) are NEVER touched.
 */
export function deduplicateBoilerplateAcrossFields(
  fields: Array<{ field: string; text: string }>,
  rawPassthrough = false,
): { fields: Array<{ field: string; text: string }>; deduplicated: DeduplicatedRecord[] } {
  if (rawPassthrough) {
    return { fields, deduplicated: [] };
  }

  const seenAntiGodmode: string[] = [];
  const deduplicated: DeduplicatedRecord[] = [];
  const outFields: Array<{ field: string; text: string }> = [];

  for (const item of fields) {
    if (!item.text) {
      outFields.push(item);
      continue;
    }
    const lines = item.text.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      if (ANTI_GODMODE_SIGNATURE.test(line)) {
        const norm = normalizeRuleSentence(line);
        const isDup = seenAntiGodmode.some((prev) => bigramDiceSimilarity(prev, norm) >= 0.72);
        if (isDup) {
          deduplicated.push({ field: item.field, preview: previewOf(line) });
          continue;
        }
        if (norm.length >= 6) {
          seenAntiGodmode.push(norm);
        }
      }
      kept.push(line);
    }
    outFields.push({ field: item.field, text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() });
  }

  return { fields: outFields, deduplicated };
}

/**
 * Display-layer sanitizer for `pi.registerMarkdownTransformer`:
 * strips stray leaked MVU/status HTML tags from rendered assistant output without altering history.
 */
export function stripDisplayResiduals(markdown: string): string {
  if (!markdown) return markdown;
  const dummy: StrippedRecord[] = [];
  let out = markdown
    .replace(/<initvar\b[^>]*>[\s\S]*?<\/initvar\s*>/gi, "")
    .replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi, "")
    .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>|<iframe\b[^>]*\/?>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>|<svg\b[^>]*\/>/gi, "");
  out = stripBalancedStyledHtmlContainers(out, "display", dummy);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
