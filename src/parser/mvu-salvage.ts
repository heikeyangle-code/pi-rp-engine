/**
 * Universal MVU / Era / InitVar / YAML / JSON5 / JSONPatch / HTML-Status-Bar / EJS / Macro Variable Extractor (v4).
 *
 * Fixes EVERY major variable extraction gap audited against real SillyTavern variable cards:
 *  1. Scans ALL lorebook entries (INCLUDING `enabled: false` / `constant: false` `[InitVar]` entries!).
 *  2. True indentation-aware nested YAML parser (handles multi-level trees like `悠纪.服装.上衣`,
 *     inline `# 0-100` bounds & semantic comments, `$meta` skipping, and YAML inventory lists `- 柴刀`).
 *  3. Correct MVU syntax: `_.set('path', oldVal, newVal)` takes `newVal` (3rd arg), plus `_.set(stat_data, 'path', val)`,
 *     `_.add`, `_.assign`, `<initvar>`, `<UpdateVariable>`, and RFC 6902 JSONPatch!
 *  4. Pre-sanitization HTML status-bar table/div text salvage (extracts `HP: 80/100`, `好感度：35` BEFORE HTML stripping!).
 *  5. EJS template variable references (`<%= getvar('...') %>`, `stat_data.xxx`).
 *  6. Actor-aware & category-aware routing (`actorId`: "player" | "world" | NPC name; `category`: stat | inventory | anchor | flag | clock).
 */

import type { SalvagedVariable } from "../types.js";
import { extractMacroVariables } from "./macros.js";

export interface RawLoreVariableSource {
  name?: string;
  comment?: string;
  keys?: string[];
  content: string;
  constant?: boolean;
  enabled?: boolean;
}

const INVENTORY_SECTION_RE = /(?:背包|物品栏?|道具栏?|持有物|装备栏?|行囊|包裹|inventory|backpack|items?|bag|equipment)/i;
const PLAYER_NAMESPACE_RE = /^(?:player|user|主角|玩家|我|自身|个人|hero|protagonist|mc)$/i;
const WORLD_NAMESPACE_RE = /^(?:world|global|env|environment|scene|system|世界|全局|环境|场景|当前|系统|天气|时空)$/i;
const ANCHOR_KEY_RE = /^(?:地点|位置|当前地点|当前位置|场景|location|place|时间|当前时间|日期|时刻|time|date|阶段|纪元|章节|stage|era|chapter)$/i;
const CLOCK_KEY_RE = /(?:倒计时|进度条|警戒度?|警觉度?|时钟|期限|countdown|clock|alert|tension)/i;
const BIPOLAR_KEY_RE = /(?:好感|关系|声望|信任|阵营|善恶|倾向|态度|亲密|情绪|affection|trust|reputation|karma|alignment|affinity)/i;

function parseLooseScalar(raw: string): number | string | boolean {
  const trimmed = raw
    .trim()
    .replace(/,$/, "")
    .replace(/;$/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Parse bounds hints like `# 0-100`, `# -100~100`, `范围：0到100`, `(0/100)` from comments or notes. */
function parseBoundsHint(note: string | undefined): { min?: number; max?: number } {
  if (!note) return {};
  const rangeMatch = /(-?\d+(?:\.\d+)?)\s*(?:~|～|到|to|—|–|-)\s*(-?\d+(?:\.\d+)?)/i.exec(note);
  if (rangeMatch) {
    const a = Number(rangeMatch[1]);
    const b = Number(rangeMatch[2]);
    if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
      return { min: a, max: b };
    }
  }
  return {};
}

/** Infer actorId and clean key + semantic category from a dotted variable path like `悠纪.好感度` or `玩家.背包.柴刀`. */
function classifyPath(
  rawPath: string,
  val: number | string | boolean,
  defaultActor?: string,
): { actorId?: string; key: string; category: SalvagedVariable["category"] } {
  const clean = rawPath
    .replace(/^stat_data\./i, "")
    .replace(/^vars?\./i, "")
    .replace(/^data\./i, "")
    .trim();
  const segments = clean.split(".").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) {
    return { actorId: defaultActor, key: clean, category: "stat" };
  }

  // Detect inventory paths like `玩家.背包.柴刀` or `inventory.sword`
  const invIdx = segments.findIndex((s) => INVENTORY_SECTION_RE.test(s));
  if (invIdx >= 0 && invIdx < segments.length - 1) {
    const ownerSeg = invIdx > 0 ? segments[0]! : "player";
    const actorId = PLAYER_NAMESPACE_RE.test(ownerSeg) ? "player" : ownerSeg;
    const itemName = segments.slice(invIdx + 1).join(".");
    return { actorId, key: itemName, category: "inventory" };
  }

  let actorId: string | undefined = defaultActor;
  let key = clean;

  if (segments.length >= 2) {
    const head = segments[0]!;
    const tail = segments.slice(1).join(".");
    if (PLAYER_NAMESPACE_RE.test(head)) {
      actorId = "player";
      key = tail;
    } else if (WORLD_NAMESPACE_RE.test(head)) {
      actorId = "world";
      key = tail;
    } else {
      actorId = head;
      key = tail;
    }
  } else if (ANCHOR_KEY_RE.test(segments[0]!)) {
    actorId = "world";
    key = segments[0]!;
  }

  // Classify category
  if (ANCHOR_KEY_RE.test(key) && typeof val === "string") {
    return { actorId: "world", key, category: "anchor" };
  }
  if (typeof val === "boolean") {
    return { actorId: actorId ?? "world", key, category: "flag" };
  }
  if (CLOCK_KEY_RE.test(key) && typeof val === "number") {
    return { actorId: actorId ?? "world", key, category: "clock" };
  }
  return { actorId, key, category: "stat" };
}

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
  out: Array<{ path: string; value: number | string | boolean; note?: string; min?: number; max?: number; isInventoryList?: boolean }> = [],
  depth = 0,
): Array<{ path: string; value: number | string | boolean; note?: string; min?: number; max?: number; isInventoryList?: boolean }> {
  if (depth > 4) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$") || k.startsWith("_")) continue;
    const fullPath = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      if (typeof v === "string" && v.length > 160) continue;
      // Handle bounded ratio strings like "80/100"
      if (typeof v === "string") {
        const ratio = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(v.trim());
        if (ratio) {
          const num = Number(ratio[1]);
          const max = Number(ratio[2]);
          const min = num < 0 || BIPOLAR_KEY_RE.test(k) ? Math.min(-max, num) : 0;
          out.push({ path: fullPath, value: num, min, max });
          continue;
        }
      }
      out.push({ path: fullPath, value: v });
    } else if (Array.isArray(v)) {
      // MVU tuple `[value, "description"]` convention (very common in Chinese MVU cards!)
      if (
        v.length === 2 &&
        (typeof v[0] === "number" || typeof v[0] === "string" || typeof v[0] === "boolean") &&
        typeof v[1] === "string"
      ) {
        const bounds = parseBoundsHint(v[1]);
        out.push({ path: fullPath, value: v[0], note: v[1].slice(0, 120), ...bounds });
        continue;
      }
      // Inventory / item array: `["柴刀", "干粮"]` or `[{ item: "柴刀", count: 1 }]`
      if (INVENTORY_SECTION_RE.test(k)) {
        for (const elem of v) {
          if (typeof elem === "string" && elem.trim() && elem.length <= 48) {
            out.push({ path: `${fullPath}.${elem.trim()}`, value: 1, isInventoryList: true });
          } else if (elem && typeof elem === "object" && !Array.isArray(elem)) {
            const rec = elem as Record<string, unknown>;
            const name = String(rec.name ?? rec.item ?? rec.id ?? "").trim();
            const count = typeof rec.count === "number" ? rec.count : typeof rec.qty === "number" ? rec.qty : 1;
            if (name) out.push({ path: `${fullPath}.${name}`, value: Math.max(1, Math.trunc(count)), isInventoryList: true });
          }
        }
      }
    } else if (v && typeof v === "object") {
      // Check MVU `{ value: 30, min: 0, max: 100, description: "..." }` leaf descriptor
      const rec = v as Record<string, unknown>;
      if (
        ("value" in rec || "val" in rec || "current" in rec) &&
        Object.keys(rec).every((rk) => /^(?:value|val|current|min|max|note|description|desc|\$meta)$/i.test(rk))
      ) {
        const leafVal = rec.value ?? rec.val ?? rec.current;
        if (typeof leafVal === "number" || typeof leafVal === "string" || typeof leafVal === "boolean") {
          out.push({
            path: fullPath,
            value: leafVal,
            min: typeof rec.min === "number" ? rec.min : undefined,
            max: typeof rec.max === "number" ? rec.max : undefined,
            note: typeof rec.description === "string" ? rec.description : typeof rec.note === "string" ? rec.note : undefined,
          });
          continue;
        }
      }
      flattenObject(rec, fullPath, out, depth + 1);
    }
  }
  return out;
}

/**
 * Zero-dependency indentation-aware nested YAML variable extractor.
 * Properly preserves parent paths (`悠纪.好感度`, `悠纪.服装.上衣`), strips `$meta` subtrees,
 * extracts `# 0-100` range comments, and parses `- 柴刀` inventory lists!
 */
export function parseNestedYamlVariables(
  yamlText: string,
): Array<{ path: string; value: number | string | boolean; min?: number; max?: number; note?: string }> {
  const results: Array<{ path: string; value: number | string | boolean; min?: number; max?: number; note?: string }> = [];
  const stack: Array<{ indent: number; key: string; skip: boolean }> = [];

  for (const rawLine of yamlText.replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine) || /^\s*---/.test(rawLine)) continue;
    const indentMatch = /^(\s*)/.exec(rawLine);
    const indent = indentMatch ? indentMatch[1]!.replace(/\t/g, "  ").length : 0;
    const trimmed = rawLine.trim();

    // Pop stack items at >= current indent
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }

    // If any ancestor is skipped (e.g. `$meta`), ignore entire subtree
    if (stack.some((s) => s.skip)) continue;

    // List item `- 柴刀` or `- 干粮 x3` under an inventory/items section
    const listMatch = /^-\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      const parentPath = stack.map((s) => s.key).join(".");
      if (parentPath && INVENTORY_SECTION_RE.test(parentPath)) {
        const rawItem = listMatch[1]!.split(/\s+#/)[0]!.trim().replace(/^["']|["']$/g, "");
        if (!rawItem || rawItem.length > 48) continue;
        const qtyMatch = /^(.+?)\s*[×xX*]\s*(\d+)$/.exec(rawItem);
        if (qtyMatch) {
          results.push({ path: `${parentPath}.${qtyMatch[1]!.trim()}`, value: Number(qtyMatch[2]) });
        } else if (!rawItem.includes(":")) {
          results.push({ path: `${parentPath}.${rawItem}`, value: 1 });
        }
      }
      continue;
    }

    // Key-value or parent section: `key: value # comment` or `key:`
    const kvMatch = /^["']?([^"':#\n]{1,48})["']?\s*[:：]\s*(.*)$/.exec(trimmed);
    if (!kvMatch) continue;
    const rawKey = kvMatch[1]!.trim();
    const rest = kvMatch[2]!.trim();

    if (rawKey.startsWith("$") || rawKey.startsWith("_")) {
      stack.push({ indent, key: rawKey, skip: true });
      continue;
    }

    // Separate inline comment (respecting quotes)
    let valPart = rest;
    let commentPart: string | undefined;
    if (rest) {
      const hashIdx = rest.search(/\s+#\s*/);
      if (hashIdx >= 0 && !/^["'][^"']*#/.test(rest)) {
        valPart = rest.slice(0, hashIdx).trim();
        commentPart = rest.slice(hashIdx).replace(/^\s*#\s*/, "").trim();
      }
    }

    const fullPath = stack.length > 0 ? `${stack.map((s) => s.key).join(".")}.${rawKey}` : rawKey;

    if (valPart === "|" || valPart === ">" || valPart === "|-" || valPart === ">-") {
      // Skip multiline YAML prose block scalars so colons inside prose are never misread as variables
      stack.push({ indent, key: rawKey, skip: true });
      continue;
    }
    if (!valPart) {
      // Nested parent node
      stack.push({ indent, key: rawKey, skip: false });
      continue;
    }
    if (/^(?:null|~|undefined)$/i.test(valPart)) {
      continue;
    }

    // Inline JSON/YAML array `[30, "0-100 好感度"]`, `[50, "Hero's trust"]`, or `['柴刀', '火折子']`
    if (valPart.startsWith("[") && valPart.endsWith("]")) {
      const parsedArr = tryParseJsonLoose(valPart);
      if (Array.isArray(parsedArr)) {
        if (
          parsedArr.length === 2 &&
          (typeof parsedArr[0] === "number" || typeof parsedArr[0] === "string" || typeof parsedArr[0] === "boolean") &&
          typeof parsedArr[1] === "string"
        ) {
          const bounds = parseBoundsHint(parsedArr[1]);
          results.push({ path: fullPath, value: parsedArr[0], note: parsedArr[1].slice(0, 120), ...bounds });
          continue;
        }
        if (INVENTORY_SECTION_RE.test(fullPath)) {
          for (const elem of parsedArr) {
            if (typeof elem === "string" && elem.trim()) {
              results.push({ path: `${fullPath}.${elem.trim()}`, value: 1 });
            }
          }
          continue;
        }
      }
    }

    // Inline ratio `80/100`
    const ratio = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(valPart);
    if (ratio) {
      const num = Number(ratio[1]);
      const max = Number(ratio[2]);
      const min = num < 0 || BIPOLAR_KEY_RE.test(rawKey) ? Math.min(-max, num) : 0;
      results.push({ path: fullPath, value: num, min, max, note: commentPart });
      continue;
    }

    const scalar = parseLooseScalar(valPart);
    if (typeof scalar === "number" || typeof scalar === "boolean" || (typeof scalar === "string" && scalar.length <= 80)) {
      const bounds = parseBoundsHint(commentPart);
      if (typeof scalar === "number" && bounds.min === undefined && (scalar < 0 || BIPOLAR_KEY_RE.test(rawKey))) {
        bounds.min = Math.min(-100, scalar);
      }
      results.push({ path: fullPath, value: scalar, note: commentPart, ...bounds });
    }
  }

  return results;
}

/** Extract JS-style arguments safely (respecting quoted strings with commas). */
function splitJsArgs(argStr: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let escape = false;
  let depth = 0;

  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i]!;
    if (quote) {
      cur += ch;
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** Balanced-paren scanner for `_.set(...)`, `_.add(...)`, and `_.assign(...)` calls. */
function extractMvuCalls(text: string): Array<{ fn: string; rawArgs: string; comment?: string }> {
  const calls: Array<{ fn: string; rawArgs: string; comment?: string }> = [];
  const startRe = /_\.(set|add|assign)\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = startRe.exec(text)) !== null) {
    const fn = m[1]!.toLowerCase();
    const argsStart = startRe.lastIndex;
    let depth = 1;
    let quote: string | null = null;
    let escape = false;
    let i = argsStart;

    while (i < text.length && depth > 0) {
      const ch = text[i]!;
      if (quote) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === quote) quote = null;
      } else {
        if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
        } else if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      i++;
    }

    if (depth !== 0) continue;
    const rawArgs = text.slice(argsStart, i);
    const tail = text.slice(i + 1);
    const commentMatch = /^[ \t]*;?[ \t]*\/\/([^\n]*)/.exec(tail);
    const comment = commentMatch?.[1]?.trim() || undefined;
    calls.push({ fn, rawArgs, comment });
    startRe.lastIndex = i + 1 + (commentMatch ? commentMatch[0].length : 0);
  }

  return calls;
}

/** Loose JSON5-like parser supporting `//` & `/* ... *\/` comments, single-quoted strings, unquoted keys, and trailing commas. */
function tryParseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to string-aware JSON5 normalizer
  }

  // Pass 1: strip // and /* */ comments outside strings, and convert single-quoted strings to double-quoted
  let out = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;
    if (ch === '"') {
      out += ch;
      i++;
      while (i < trimmed.length) {
        const c = trimmed[i]!;
        out += c;
        i++;
        if (c === "\\" && i < trimmed.length) {
          out += trimmed[i]!;
          i++;
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === "'") {
      out += '"';
      i++;
      while (i < trimmed.length) {
        const c = trimmed[i]!;
        if (c === "\\" && i + 1 < trimmed.length) {
          const next = trimmed[i + 1]!;
          if (next === "'") {
            out += "'";
          } else if (next === '"') {
            out += '\\"';
          } else {
            out += "\\" + next;
          }
          i += 2;
        } else if (c === '"') {
          out += '\\"';
          i++;
        } else if (c === "'") {
          out += '"';
          i++;
          break;
        } else {
          out += c;
          i++;
        }
      }
      continue;
    }
    if (ch === "/" && trimmed[i + 1] === "/") {
      i += 2;
      while (i < trimmed.length && trimmed[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && trimmed[i + 1] === "*") {
      i += 2;
      while (i < trimmed.length && !(trimmed[i] === "*" && trimmed[i + 1] === "/")) i++;
      if (i < trimmed.length) i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  // Pass 2: quote unquoted object keys & strip trailing commas (string-aware)
  let final = "";
  i = 0;
  let expectKey = false;
  const containerStack: string[] = [];
  while (i < out.length) {
    const ch = out[i]!;
    if (ch === '"') {
      final += ch;
      i++;
      while (i < out.length) {
        const c = out[i]!;
        final += c;
        i++;
        if (c === "\\" && i < out.length) {
          final += out[i]!;
          i++;
        } else if (c === '"') {
          break;
        }
      }
      expectKey = false;
      continue;
    }
    if (ch === "{") {
      containerStack.push("{");
      expectKey = true;
      final += ch;
      i++;
      continue;
    }
    if (ch === "[") {
      containerStack.push("[");
      expectKey = false;
      final += ch;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      containerStack.pop();
      expectKey = false;
      final += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j]!)) j++;
      if (out[j] === "}" || out[j] === "]") {
        i++;
        continue;
      }
      final += ch;
      expectKey = containerStack[containerStack.length - 1] === "{";
      i++;
      continue;
    }
    if (expectKey && !/\s/.test(ch)) {
      const keyMatch = /^([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff-]*)(\s*:)/.exec(out.slice(i));
      if (keyMatch) {
        final += `"${keyMatch[1]!}"${keyMatch[2]!}`;
        i += keyMatch[0].length;
        expectKey = false;
        continue;
      }
      expectKey = false;
    }
    final += ch;
    i++;
  }

  try {
    return JSON.parse(final);
  } catch {
    return null;
  }
}

/** Pre-sanitization salvage from HTML status panels/tables (`<div>HP: 80/100</div>`, `<td><b>好感度</b></td><td><span>35</span></td>`). */
function salvageHtmlStatusTableVars(text: string): Array<{ path: string; value: number | string | boolean; min?: number; max?: number }> {
  if (!/<(?:div|table|section|span|td|tr)\b/i.test(text)) return [];
  const results: Array<{ path: string; value: number | string | boolean; min?: number; max?: number }> = [];

  // 1. Table row pairs (allowing nested HTML tags inside <td>/<th> cells)
  const tdPairRe =
    /<t[dh]\b[^>]*>((?:(?!<\/t[dh]\b)[\s\S]){1,200})<\/t[dh]>\s*<t[dh]\b[^>]*>((?:(?!<\/t[dh]\b)[\s\S]){1,200})<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = tdPairRe.exec(text)) !== null) {
    const key = m[1]!.replace(/<[^>]*>/g, "").replace(/[:：\s]+$/g, "").trim();
    const rawVal = m[2]!.replace(/<[^>]*>/g, "").trim();
    if (!key || key.length > 24 || !rawVal || rawVal.length > 48) continue;
    if (/^(?:项目|属性|名称|数值|状态|item|stat|name|value)$/i.test(key)) continue;
    const ratio = /^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(rawVal);
    if (ratio) {
      const num = Number(ratio[1]);
      const max = Number(ratio[2]);
      results.push({ path: key, value: num, min: num < 0 || BIPOLAR_KEY_RE.test(key) ? Math.min(-max, num) : 0, max });
    } else if (/^-?\d+(?:\.\d+)?$/.test(rawVal)) {
      const num = Number(rawVal);
      results.push({ path: key, value: num, min: num < 0 || BIPOLAR_KEY_RE.test(key) ? Math.min(-100, num) : 0 });
    }
  }

  // 2. Inline label:value inside stripped HTML tags
  const plainFromHtml = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(?:div|p|tr|li|br|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const boundedRe = /(?:^|[\n|｜·•\s【\[])([\u4e00-\u9fffA-Za-z_]{1,16})\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g;
  while ((m = boundedRe.exec(plainFromHtml)) !== null) {
    const key = m[1]!.trim();
    const num = Number(m[2]);
    const max = Number(m[3]);
    if (!key || !Number.isFinite(num) || !Number.isFinite(max) || max <= 0) continue;
    if (/^(?:http|https|date|time|年|月|日|px|em|rem|rgb|rgba|font|width|height)$/i.test(key)) continue;
    results.push({ path: key, value: num, min: num < 0 || BIPOLAR_KEY_RE.test(key) ? Math.min(-max, num) : 0, max });
  }

  return results;
}

function isInitVarLoreEntry(entry: RawLoreVariableSource): boolean {
  const header = `${entry.name ?? ""} ${entry.comment ?? ""} ${(entry.keys ?? []).join(" ")}`;
  if (/\[?\s*init\s*var\s*\]?|变量初始|初始变量|状态初始化|stat_data|mvu/i.test(header)) return true;
  if (/<initvar\b|<UpdateVariable\b|_\.(?:set|add|assign|insert)\s*\(|stat_data\s*[:=]/i.test(entry.content)) return true;
  return false;
}

/** Salvage variables from ALL raw card fields, extensions, HTML panels, and ALL raw lorebook entries (including disabled `[InitVar]`). */
export function salvageMvuVariables(sources: {
  firstMes?: string;
  alternateGreetings?: string[];
  description?: string;
  systemPrompt?: string;
  postHistory?: string;
  extensions?: Record<string, unknown>;
  /** Legacy compatibility: raw constant lore texts */
  rawConstantLoreContents?: string[];
  /** v4: ALL raw lore entries (including disabled/non-constant `[InitVar]` entries!) */
  rawAllLoreEntries?: RawLoreVariableSource[];
}): SalvagedVariable[] {
  const byCompositeKey = new Map<string, SalvagedVariable>();

  const registerRaw = (
    rawPath: string,
    initialValue: number | string | boolean,
    source: SalvagedVariable["source"],
    opts?: { min?: number; max?: number; note?: string; actorId?: string; category?: SalvagedVariable["category"] },
  ) => {
    const cleanRaw = rawPath.trim();
    if (!cleanRaw || cleanRaw.length > 96) return;
    const classified = classifyPath(cleanRaw, initialValue, opts?.actorId);
    const finalActor = opts?.actorId ?? classified.actorId;
    const finalCategory = opts?.category ?? classified.category;
    const finalKey = classified.key;
    if (!finalKey) return;

    // Use actor::key so two different characters can BOTH have `好感度` without overwriting each other!
    const composite = `${(finalActor ?? "").toLowerCase()}::${finalKey.toLowerCase()}`;
    if (!byCompositeKey.has(composite)) {
      byCompositeKey.set(composite, {
        key: finalKey,
        actorId: finalActor,
        category: finalCategory,
        initialValue,
        min: opts?.min,
        max: opts?.max,
        note: opts?.note,
        source,
      });
    }
  };

  const scanText = (text: string | undefined, source: SalvagedVariable["source"], isDedicatedInitVar = false) => {
    if (!text) return;

    // 1. Official MVU `_.set(...)` & `_.add(...)` & `_.assign(...)` via balanced-paren scanner
    for (const call of extractMvuCalls(text)) {
      const fn = call.fn;
      const args = splitJsArgs(call.rawArgs);
      const comment = call.comment;
      const bounds = parseBoundsHint(comment);

      if (fn === "set") {
        // Form A: _.set(stat_data, 'path', value)
        if (args.length >= 3 && !/^["'`]/.test(args[0]!)) {
          const pathStr = String(parseLooseScalar(args[1]!));
          const val = parseLooseScalar(args[2]!);
          registerRaw(pathStr, val, source, { note: comment, ...bounds });
        } else if (args.length === 3 && /^["'`]/.test(args[0]!)) {
          // Official MVU Form B: _.set('悠纪.好感度', oldVal, newVal);//reason -> 3rd arg is NEW value!
          const pathStr = String(parseLooseScalar(args[0]!));
          const newVal = parseLooseScalar(args[2]!);
          registerRaw(pathStr, newVal, source, { note: comment, ...bounds });
        } else if (args.length === 2 && /^["'`]/.test(args[0]!)) {
          // Form C: _.set('path', value)
          const pathStr = String(parseLooseScalar(args[0]!));
          const val = parseLooseScalar(args[1]!);
          registerRaw(pathStr, val, source, { note: comment, ...bounds });
        } else if (args.length === 4 && /^["'`]/.test(args[0]!)) {
          // Legacy 4-arg form: _.set('path', value, min, max)
          const pathStr = String(parseLooseScalar(args[0]!));
          const val = parseLooseScalar(args[1]!);
          const minRaw = parseLooseScalar(args[2]!);
          const maxRaw = parseLooseScalar(args[3]!);
          registerRaw(pathStr, val, source, {
            min: typeof minRaw === "number" ? minRaw : bounds.min,
            max: typeof maxRaw === "number" ? maxRaw : bounds.max,
            note: comment,
          });
        }
      } else if (fn === "add" && args.length >= 2) {
        const pathIdx = /^["'`]/.test(args[0]!) ? 0 : 1;
        const pathStr = String(parseLooseScalar(args[pathIdx]!));
        const val = parseLooseScalar(args[pathIdx + 1] ?? "0");
        registerRaw(pathStr, typeof val === "number" ? val : 0, source, { note: comment, ...bounds });
      } else if (fn === "assign" && args.length >= 2) {
        const pathIdx = /^["'`]/.test(args[0]!) ? 0 : 1;
        const prefix = String(parseLooseScalar(args[pathIdx]!));
        const obj = tryParseJsonLoose(args[pathIdx + 1] ?? "");
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          for (const item of flattenObject(obj as Record<string, unknown>, prefix)) {
            registerRaw(item.path, item.value, source, { min: item.min, max: item.max, note: item.note ?? comment });
          }
        }
      }
    }

    // 2. `<initvar>...</initvar>`, `<UpdateVariable>...</UpdateVariable>`, fenced ```json / ```json5 / ```yaml
    const taggedBlockRe = /<(initvar|UpdateVariable)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let m: RegExpExecArray | null;
    while ((m = taggedBlockRe.exec(text)) !== null) {
      const body = m[2]!.trim();
      const jsonObj = tryParseJsonLoose(body);
      if (Array.isArray(jsonObj)) {
        // RFC 6902 JSONPatch array: [{ op: "replace"|"add", path: "/悠纪/好感度", value: 40 }]
        for (const patch of jsonObj) {
          if (!patch || typeof patch !== "object") continue;
          const p = patch as Record<string, unknown>;
          if ((p.op === "add" || p.op === "replace") && typeof p.path === "string" && p.value !== undefined) {
            const dotPath = p.path.replace(/^\/+/, "").replace(/\//g, ".");
            if (typeof p.value === "number" || typeof p.value === "string" || typeof p.value === "boolean") {
              registerRaw(dotPath, p.value, source);
            } else if (p.value && typeof p.value === "object" && !Array.isArray(p.value)) {
              for (const item of flattenObject(p.value as Record<string, unknown>, dotPath)) {
                registerRaw(item.path, item.value, source, { min: item.min, max: item.max, note: item.note });
              }
            }
          }
        }
      } else if (jsonObj && typeof jsonObj === "object") {
        for (const item of flattenObject(jsonObj as Record<string, unknown>)) {
          registerRaw(item.path, item.value, source, { min: item.min, max: item.max, note: item.note });
        }
      } else {
        // Treat tagged body as nested YAML if not JSON
        for (const yv of parseNestedYamlVariables(body)) {
          registerRaw(yv.path, yv.value, source, { min: yv.min, max: yv.max, note: yv.note });
        }
      }
    }

    // Fenced JSON / JSON5 blocks
    const jsonFenceRe = /```json5?\s*\n([\s\S]*?)```/gi;
    while ((m = jsonFenceRe.exec(text)) !== null) {
      const parsed = tryParseJsonLoose(m[1]!);
      if (Array.isArray(parsed)) {
        for (const patch of parsed) {
          if (!patch || typeof patch !== "object") continue;
          const p = patch as Record<string, unknown>;
          if ((p.op === "add" || p.op === "replace") && typeof p.path === "string") {
            const dotPath = p.path.replace(/^\/+/, "").replace(/\//g, ".");
            if (typeof p.value === "number" || typeof p.value === "string" || typeof p.value === "boolean") {
              registerRaw(dotPath, p.value, source);
            }
          }
        }
      } else if (parsed && typeof parsed === "object") {
        for (const item of flattenObject(parsed as Record<string, unknown>)) {
          registerRaw(item.path, item.value, source, { min: item.min, max: item.max, note: item.note });
        }
      }
    }

    // Fenced YAML blocks (using TRUE indentation-aware nested parser!)
    const yamlFenceRe = /```(?:ya?ml)\s*\n([\s\S]*?)```/gi;
    while ((m = yamlFenceRe.exec(text)) !== null) {
      for (const yv of parseNestedYamlVariables(m[1]!)) {
        registerRaw(yv.path, yv.value, source, { min: yv.min, max: yv.max, note: yv.note });
      }
    }

    // Dedicated `[InitVar]` lorebook entry with BARE (unfenced) JSON or YAML!
    // Skip bare YAML fallback when the entry already uses structured blocks (`_.set`, `<initvar>`, ``` fences)
    // so surrounding natural-language instructions with colons are never misparsed as variables.
    if (isDedicatedInitVar) {
      const trimmed = text.trim();
      const hasStructuredBlocks =
        /<(?:initvar|UpdateVariable)\b/i.test(trimmed) ||
        /```/.test(trimmed) ||
        /_\.(?:set|add|assign)\s*\(/i.test(trimmed);
      if (!hasStructuredBlocks) {
        const bareJson = trimmed.startsWith("{") ? tryParseJsonLoose(trimmed) : null;
        if (bareJson && typeof bareJson === "object" && !Array.isArray(bareJson)) {
          for (const item of flattenObject(bareJson as Record<string, unknown>)) {
            registerRaw(item.path, item.value, "init_var", { min: item.min, max: item.max, note: item.note });
          }
        } else {
          for (const yv of parseNestedYamlVariables(trimmed)) {
            registerRaw(yv.path, yv.value, "init_var", { min: yv.min, max: yv.max, note: yv.note });
          }
        }
      }
    }

    // 3. Pre-sanitization HTML status bar tables/divs
    for (const hv of salvageHtmlStatusTableVars(text)) {
      registerRaw(hv.path, hv.value, "html_table", { min: hv.min, max: hv.max });
    }

    // 4. EJS variable references `<%= getvar('path') %>` or `stat_data.foo.bar`
    const ejsGetVarRe = /getvar\(\s*["']([^"']+)["']\s*\)/gi;
    while ((m = ejsGetVarRe.exec(text)) !== null) {
      registerRaw(m[1]!, 0, source);
    }

    // 5. SillyTavern `{{setvar::k::v}}` / `{{getvar::k}}` / `{{addvar::k::n}}` macros
    for (const mv of extractMacroVariables(text)) {
      registerRaw(mv.key, mv.initialValue, "macro");
    }
  };

  // Priority order: dedicated `[InitVar]` entries first (most authoritative!), then first_mes, core fields, constant lore, extensions
  for (const entry of sources.rawAllLoreEntries ?? []) {
    if (isInitVarLoreEntry(entry)) {
      scanText(entry.content, "init_var", true);
    }
  }

  scanText(sources.firstMes, "first_mes");
  for (const alt of (sources.alternateGreetings ?? []).slice(0, 1)) {
    scanText(alt, "first_mes");
  }
  scanText(sources.description, "mvu");
  scanText(sources.systemPrompt, "mvu");
  scanText(sources.postHistory, "mvu");

  for (const entry of sources.rawAllLoreEntries ?? []) {
    if (!isInitVarLoreEntry(entry) && entry.constant) {
      scanText(entry.content, "constant_lore");
    }
  }
  for (const lore of sources.rawConstantLoreContents ?? []) {
    scanText(lore, "constant_lore");
  }

  // Known MVU / tavern_helper / Era extension payloads
  const ext = sources.extensions;
  if (ext && typeof ext === "object") {
    for (const extKey of ["mvu", "MVU", "tavern_helper", "TavernHelper_scripts", "era", "stat_data"]) {
      const val = ext[extKey];
      if (typeof val === "string") {
        scanText(val, "mvu");
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const item of flattenObject(val as Record<string, unknown>)) {
          registerRaw(item.path, item.value, "mvu", { min: item.min, max: item.max, note: item.note });
        }
      }
    }
  }

  return Array.from(byCompositeKey.values());
}
