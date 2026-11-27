/**
 * Surgical whitelist-based FrontendSanitizer & DuplicateRuleMerger.
 *
 * Constitutional fidelity guarantees:
 *  1. NEVER truncate or summarize `mes_example`.
 *  2. NEVER censor or alter jailbreaks, writing-style guides, POV rules, or author constraints.
 *  3. ONLY strip SillyTavern 1.0 frontend shells (<script>, <style>, <iframe>, styled HTML status bars,
 *     <UpdateVariable> MVU blocks, _.set(...) patches, ST /setvar slash blocks).
 *  4. ONLY deduplicate near-identical anti-godmoding boilerplate appearing >= 2 times across fields.
 */

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

const FRONTEND_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "script_tag", regex: /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi },
  { kind: "style_tag", regex: /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi },
  { kind: "iframe_tag", regex: /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi },
  { kind: "mvu_update_block", regex: /<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi },
  { kind: "mvu_status_block", regex: /<StatusPlaceHolderImpl\s*\/?>/gi },
  // Styled HTML status-bar containers (must contain explicit CSS/JS attributes like style=/class=/onclick=)
  {
    kind: "html_status_panel",
    regex: /<(?:div|section|table|details)\b[^>]*\b(?:style|class|onclick|onload)\s*=\s*["'][^"']*(?:display\s*:\s*(?:flex|grid)|grid-template|background|border|status|hud|card|panel)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|table|details)\s*>/gi,
  },
  // MVU JS helper code blocks (_.set / _.assign / TavernHelper)
  {
    kind: "mvu_js_patch",
    regex: /```(?:js|javascript|json)?\s*\n(?:[^\n]*?(?:_\.(?:set|assign|unset|add)\s*\(|TavernHelper|triggerSlash)[\s\S]*?)```/gi,
  },
  // SillyTavern frontend slash-command script blocks (/setvar, /echo, /trigger)
  {
    kind: "st_slash_script",
    regex: /(?:^|\n)(?:\/(?:setvar|addvar|getvar|echo|trigger|flushvar|setglobalvar)\b[^\n]*(?:\n|$)){2,}/gi,
  },
];

function previewOf(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 72)}…` : compact;
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

  for (const { kind, regex } of FRONTEND_PATTERNS) {
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

  // Clean up excessive blank lines left by removed HTML/JS blocks without touching indentation
  if (stripped.length > 0) {
    current = current.replace(/\n{3,}/g, "\n\n").trim();
  }

  return { cleaned: current, stripped };
}

/** Check if a SillyTavern regex_script is a frontend HTML/CSS/JS presentation script (to be stripped). */
export function isFrontendRegexScript(script: Record<string, unknown>): boolean {
  const replace = typeof script.replaceString === "string" ? script.replaceString : "";
  const find = typeof script.findRegex === "string" ? script.findRegex : "";
  const combined = `${find}\n${replace}`;
  return /<(?:div|span|style|script|iframe|table|details|svg|button|input)\b|\bstyle\s*=|\bclass\s*=|display\s*:\s*(?:flex|grid)|TavernHelper|UpdateVariable/i.test(
    combined,
  );
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
  return markdown
    .replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi, "")
    .replace(/<StatusPlaceHolderImpl\s*\/?>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
