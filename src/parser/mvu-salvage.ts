/**
 * MvuSchemaSalvager: extracts initial RPG/SLG variable schemas (HP, affection, money,
 * location, clothing, schedule, etc.) from MVU / tavern_helper / <UpdateVariable> /
 * {{setvar}} blocks so they can be promoted cleanly into the L1 deterministic FSM.
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
      out.push({ key: fullKey, value: v });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      flattenObject(v as Record<string, unknown>, fullKey, out, depth + 1);
    }
  }
  return out;
}

function parseLooseScalar(raw: string): number | string | boolean {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Salvage variables from raw card fields, extensions, and constant lore entries. */
export function salvageMvuVariables(sources: {
  firstMes?: string;
  description?: string;
  systemPrompt?: string;
  postHistory?: string;
  extensions?: Record<string, unknown>;
  constantLoreContents?: string[];
}): SalvagedVariable[] {
  const byKey = new Map<string, SalvagedVariable>();

  const register = (v: SalvagedVariable) => {
    if (!v.key || v.key.length > 80) return;
    if (!byKey.has(v.key)) {
      byKey.set(v.key, v);
    }
  };

  // 1. Scan _.set('path', value) calls across text blobs
  const scanText = (text: string | undefined, source: SalvagedVariable["source"]) => {
    if (!text) return;
    const lodashSetRe = /_\.set\(\s*[^,]+,\s*["']([^"']+)["']\s*,\s*([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = lodashSetRe.exec(text)) !== null) {
      const key = m[1]!.trim();
      const val = parseLooseScalar(m[2]!);
      register({ key, initialValue: val, source });
    }

    // 2. Scan JSON blocks inside <UpdateVariable> or fenced ```json
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

    // 3. Scan {{setvar::k::v}} macros
    for (const mv of extractMacroVariables(text)) {
      register({ key: mv.key, initialValue: mv.initialValue, source: "macro" });
    }
  };

  scanText(sources.firstMes, "first_mes");
  scanText(sources.description, "mvu");
  scanText(sources.systemPrompt, "mvu");
  scanText(sources.postHistory, "mvu");
  for (const lore of sources.constantLoreContents ?? []) {
    scanText(lore, "constant_lore");
  }

  // 4. Scan known MVU / tavern_helper extension payloads
  const ext = sources.extensions;
  if (ext && typeof ext === "object") {
    for (const extKey of ["mvu", "MVU", "tavern_helper", "TavernHelper_scripts", "era"]) {
      const val = ext[extKey];
      if (typeof val === "string") {
        scanText(val, "mvu");
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        for (const item of flattenObject(val as Record<string, unknown>)) {
          if (typeof item.value === "string" && item.value.length > 160) continue;
          register({ key: item.key, initialValue: item.value, source: "mvu" });
        }
      }
    }
  }

  return Array.from(byKey.values());
}
