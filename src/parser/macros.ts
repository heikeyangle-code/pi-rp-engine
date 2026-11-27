/**
 * Safe SillyTavern / CCV3 Macro evaluator & variable extractor.
 * Never leaks raw {{getvar::x}} / {{// comment}} syntax to the LLM.
 */

import * as crypto from "node:crypto";

export interface MacroContext {
  charName: string;
  userName: string;
  vars?: Record<string, number | string | boolean>;
  worldTime?: string;
  worldDate?: string;
  idleDuration?: string;
  deterministicSeed?: number;
}

function seededIndex(seed: number, len: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const frac = x - Math.floor(x);
  return Math.floor(frac * len);
}

/** Roll XdY(+/-Z) using crypto.randomInt (or deterministic seed for tests). */
export function evalRollMacro(expr: string, seed?: number): number {
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(expr);
  if (!m) return 0;
  const count = Math.min(Math.max(parseInt(m[1]!, 10), 1), 100);
  const sides = Math.min(Math.max(parseInt(m[2]!, 10), 2), 10000);
  const sign = m[3] === "-" ? -1 : 1;
  const mod = m[4] ? parseInt(m[4], 10) * sign : 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += seed !== undefined ? seededIndex(seed + i, sides) + 1 : crypto.randomInt(1, sides + 1);
  }
  return total + mod;
}

/** Extract {{setvar::k::v}} / {{getvar::k}} / {{addvar::k::n}} variable references. */
export function extractMacroVariables(text: string): Array<{ key: string; initialValue: number | string | boolean }> {
  const map = new Map<string, number | string | boolean>();
  const setRe = /\{\{(?:setvar|setglobalvar)::([^:}]+)::([^}]*)\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = setRe.exec(text)) !== null) {
    const key = m[1]!.trim();
    const rawVal = m[2]!.trim();
    if (!key) continue;
    map.set(key, parseScalar(rawVal));
  }
  const addRe = /\{\{(?:addvar|incvar)::([^:}]+)(?:::([^}]*))?\}\}/gi;
  while ((m = addRe.exec(text)) !== null) {
    const key = m[1]!.trim();
    if (key && !map.has(key)) map.set(key, 0);
  }
  const getRe = /\{\{(?:getvar|getglobalvar)::([^}]+)\}\}/gi;
  while ((m = getRe.exec(text)) !== null) {
    const key = m[1]!.trim();
    if (key && !map.has(key)) map.set(key, "");
  }
  return Array.from(map.entries()).map(([key, initialValue]) => ({ key, initialValue }));
}

function parseScalar(raw: string): number | string | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Evaluate macros cleanly:
 *  - {{char}} / <BOT> -> charName
 *  - {{user}} / <USER> -> userName
 *  - {{// ...}} -> stripped
 *  - {{random::a::b}} / {{pick::a::b}} -> random choice
 *  - {{roll:XdY}} -> rolled integer
 *  - {{getvar::k}} -> value from L1 state vars
 *  - {{setvar::...}} / {{addvar::...}} -> stripped (state owned by L1)
 *  - {{time}} / {{date}} / {{idle_duration}} -> L1 world clock
 */
export function evaluateMacros(text: string, ctx: MacroContext): string {
  if (!text) return text;
  let out = text;

  // Strip macro comments {{// ...}}
  out = out.replace(/\{\{\/\/[\s\S]*?\}\}/g, "");

  // Canonical character & user substitutions
  out = out.replace(/\{\{char\}\}|<BOT>/gi, ctx.charName);
  out = out.replace(/\{\{user\}\}|<USER>/gi, ctx.userName);

  // World clock macros
  if (ctx.worldTime !== undefined) {
    out = out.replace(/\{\{time\}\}/gi, ctx.worldTime);
  }
  if (ctx.worldDate !== undefined) {
    out = out.replace(/\{\{date\}\}/gi, ctx.worldDate);
  }
  if (ctx.idleDuration !== undefined) {
    out = out.replace(/\{\{idle_duration\}\}/gi, ctx.idleDuration);
  }

  // {{random::a::b::c}} and {{pick::a::b::c}}
  let choiceCounter = 0;
  out = out.replace(/\{\{(?:random|pick)::([^}]+)\}\}/gi, (_match, body: string) => {
    const options = body.split("::").map((s) => s.trim()).filter(Boolean);
    if (options.length === 0) return "";
    const idx =
      ctx.deterministicSeed !== undefined
        ? seededIndex(ctx.deterministicSeed + choiceCounter++, options.length)
        : crypto.randomInt(0, options.length);
    return options[idx] ?? options[0]!;
  });

  // {{roll:1d20+3}} or {{roll::1d20}}
  let rollCounter = 0;
  out = out.replace(/\{\{roll::?([^}]+)\}\}/gi, (_match, expr: string) => {
    const seed = ctx.deterministicSeed !== undefined ? ctx.deterministicSeed + 100 + rollCounter++ : undefined;
    return String(evalRollMacro(expr, seed));
  });

  // {{getvar::key}}
  out = out.replace(/\{\{(?:getvar|getglobalvar)::([^}]+)\}\}/gi, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const val = ctx.vars?.[key];
    return val !== undefined ? String(val) : "";
  });

  // Strip mutating macros so raw template syntax never leaks to LLM
  out = out.replace(/\{\{(?:setvar|setglobalvar|addvar|incvar|decvar)::[^}]*\}\}/gi, "");

  return out;
}
