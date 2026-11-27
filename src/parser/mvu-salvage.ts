/**
 * MvuSchemaSalvager: extracts initial RPG/SLG variable schemas (HP, affection, money,
 * location, clothing, schedule, etc.) from RAW MVU / tavern_helper / <UpdateVariable> /
 * _.set(...) / YAML InitVar / {{setvar}} blocks BEFORE frontend stripping.
 */

import type { SalvagedVariable } from "../types.js";
import { extractMacroVariables } from "./macros.js";

function flattenObject(
  obj: Record<string, unknown>,
  prefix = "",
  out: Array<{ key: string; value: number | string | boolean }> = [],
  depth = 0,
): Array<{ key: string; value: number | string | boolean }> {
  if (depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$") || k.startsWith("_")) continue;
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      if (typeof v === "string" && v.length > 160) continue;
      out.push({ key: fullKey, value: v });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenObject(v as Record<string, unknown>, fullKey, out, depth + 1);
    }
  }
  return out;
}

function parseLooseScalar(raw: string): number | string | boolean {
  const trimmed = raw.trim().replace(/,$/, "").replace(/^["']|["']$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Salvage variables from RAW card fields, extensions, and RAW constant lore entries. */
export function salvageMvuVariables(sources: {
  firstMes?: string;
  description?: string;
  systemPrompt?: string;
  postHistory?: string;
  extensions?: Record<string, unknown>;
  rawConstantLoreContents?: string[];
}): SalvagedVariable[] {
  const byKey = new Map<string, SalvagedVariable>();

  const register = (v: SalvagedVariable) => {
    const cleanKey = v.key.trim();
    if (!cleanKey || cleanKey.length > 80) return;
    if (!byKey.has(cleanKey)) {
      byKey.set(cleanKey, { ...v, key: cleanKey });
    }
  };

  const scanText = (text: string | undefined, source: SalvagedVariable["source"]) => {
    if (!text) return;

    // 1. _.set(stat_data, 'path', value) or _.set('path', value[, min, max])
    const lodash3Re = /_\.set\(\s*[^,"']+\s*,\s*["']([^"']+)["']\s*,\s*([^,)]+)/g;
    let m: RegExpExecArray | null;
    while ((m = lodash3Re.exec(text)) !== null) {
      const key = m[1]!.trim();
      const val = parseLooseScalar(m[2]!);
      register({ key, initialValue: val, source });
    }
    const lodash2Re = /_\.set\(\s*["']([^"']+)["']\s*,\s*([^,)]+)(?:\s*,\s*([^,)]+))?(?:\s*,\s*([^,)]+))?\s*\)/g;
    while ((m = lodash2Re.exec(text)) !== null) {
      const key = m[1]!.trim();
      const val = parseLooseScalar(m[2]!);
      const minRaw = m[3] ? parseLooseScalar(m[3]) : undefined;
      const maxRaw = m[4] ? parseLooseScalar(m[4]) : undefined;
      register({
        key,
        initialValue: val,
        min: typeof minRaw === "number" ? minRaw : undefined,
        max: typeof maxRaw === "number" ? maxRaw : undefined,
        source,
      });
    }

    // 2. JSON blocks inside <UpdateVariable> or fenced ```json
    const jsonBlockRe = /(?:<UpdateVariable[^>]*>|```json)\s*([\s\S]*?)(?:<\/UpdateVariable>|```)/gi;
    while ((m = jsonBlockRe.exec(text)) !== null) {
      const candidate = m[1]!.trim();
      if (!candidate.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        for (const item of flattenObject(parsed)) {
          register({ key: item.key, initialValue: item.value, source });
        }
      } catch {
        // Ignore non-JSON script blocks
      }
    }

    // 3. YAML-like InitVar blocks inside ```yaml / [InitVar] constant lore entries
    const yamlBlockRe = /```(?:ya?ml)\s*\n([\s\S]*?)```/gi;
    while ((m = yamlBlockRe.exec(text)) !== null) {
      const body = m[1]!;
      for (const line of body.split("\n")) {
        const kv = /^\s*([a-zA-Z0-9_\u4e00-\u9fa5.-]{1,40})\s*:\s*([^\n#]+)$/.exec(line);
        if (!kv) continue;
        const val = parseLooseScalar(kv[2]!);
        if (typeof val === "number" || typeof val === "boolean" || (typeof val === "string" && val.length <= 48)) {
          register({ key: kv[1]!, initialValue: val, source });
        }
      }
    }

    // 4. {{setvar::k::v}} / {{getvar::k}} / {{addvar::k::n}} macros
    for (const mv of extractMacroVariables(text)) {
      register({ key: mv.key, initialValue: mv.initialValue, source: "macro" });
    }
  };

  scanText(sources.firstMes, "first_mes");
  scanText(sources.description, "mvu");
  scanText(sources.systemPrompt, "mvu");
  scanText(sources.postHistory, "mvu");
  for (const lore of sources.rawConstantLoreContents ?? []) {
    scanText(lore, "constant_lore");
  }

  // 5. Known MVU / tavern_helper extension payloads
  const ext = sources.extensions;
  if (ext && typeof ext === "object") {
    for (const extKey of ["mvu", "MVU", "tavern_helper", "TavernHelper_scripts", "era"]) {
      const val = ext[extKey];
      if (typeof val === "string") {
        scanText(val, "mvu");
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const item of flattenObject(val as Record<string, unknown>)) {
          register({ key: item.key, initialValue: item.value, source: "mvu" });
        }
      }
    }
  }

  return Array.from(byKey.values());
}
