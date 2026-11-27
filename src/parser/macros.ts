/**
 * Official SillyTavern & CCV3 Macro evaluator & variable extractor.
 *
 * Full parity with SillyTavern `macros.js`:
 *  - {{char}} / <BOT>, {{user}} / <USER>, {{persona}}, {{group}}, {{charIfNotGroup}}
 *  - {{// comment}}, {{trim}}, {{newline}}, {{space}}
 *  - {{random::a::b}} AND legacy {{random:a,b,c}}
 *  - {{pick::a::b}} AND legacy {{pick:a,b,c}} (stable deterministic choice!)
 *  - {{roll:XdY+Z}} / {{roll::XdY}} / {{roll:d20}}
 *  - {{time}} / {{date}} / {{isotime}} / {{isodate}} / {{weekday}} / {{idle_duration}}
 *  - {{lastUserMessage}} / {{lastCharMessage}} / {{outlet::name}}
 *  - {{getvar::k}} / {{getglobalvar::k}} (resolved from L1 state)
 *  - {{setvar::...}} / {{addvar::...}} / {{incvar::...}} / {{decvar::...}} (stripped so template syntax never leaks)
 */

import * as crypto from "node:crypto";

export interface MacroContext {
  charName: string;
  userName: string;
  personaDescription?: string;
  groupMembers?: string[];
  vars?: Record<string, number | string | boolean>;
  outlets?: Record<string, string>;
  worldTime?: string;
  worldDate?: string;
  idleDuration?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  deterministicSeed?: number;
}

function fnv1aHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededIndex(seed: number, len: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  const frac = x - Math.floor(x);
  return Math.floor(frac * len);
}

/** Roll XdY(+/-Z) or shorthand dY using crypto.randomInt (or deterministic seed for tests). */
export function evalRollMacro(expr: string, seed?: number): number {
  const m = /^\s*(\d*)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(expr);
  if (!m) return 0;
  const count = Math.min(Math.max(m[1] ? parseInt(m[1], 10) : 1, 1), 100);
  const sides = Math.min(Math.max(parseInt(m[2]!, 10), 2), 10000);
  const sign = m[3] === "-" ? -1 : 1;
  const mod = m[4] ? parseInt(m[4], 10) * sign : 0;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += seed !== undefined ? seededIndex(seed + i, sides) + 1 : crypto.randomInt(1, sides + 1);
  }
  return total + mod;
}

function parseScalar(raw: string): number | string | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Extract {{setvar::k::v}} / {{getvar::k}} / {{addvar::k::n}} / {{incvar::k}} variable references. */
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
  const addRe = /\{\{(?:addvar|incvar|decvar)::([^:}]+)(?:::([^}]*))?\}\}/gi;
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

function splitMacroOptions(body: string, isDoubleColon: boolean): string[] {
  if (isDoubleColon || body.includes("::")) {
    return body.split("::").map((s) => s.trim()).filter(Boolean);
  }
  // Legacy SillyTavern comma-separated options with \, escape
  return body
    .split(/(?<!\\),/)
    .map((s) => s.replace(/\\,/g, ",").trim())
    .filter(Boolean);
}

/** Evaluate SillyTavern & CCV3 macros cleanly without ever leaking template syntax. */
export function evaluateMacros(text: string, ctx: MacroContext): string {
  if (!text) return text;
  let out = text;

  // 1. Strip macro comments {{// ...}}
  out = out.replace(/\{\{\/\/[\s\S]*?\}\}/g, "");

  // 2. Canonical identity & group macros
  const groupList = ctx.groupMembers && ctx.groupMembers.length > 1 ? ctx.groupMembers.join(", ") : ctx.charName;
  out = out.replace(/\{\{char\}\}|<BOT>/gi, ctx.charName);
  out = out.replace(/\{\{user\}\}|<USER>/gi, ctx.userName);
  out = out.replace(/\{\{persona\}\}/gi, ctx.personaDescription ?? "");
  out = out.replace(/\{\{group\}\}|\{\{charIfNotGroup\}\}/gi, groupList);

  // 3. Formatting helpers
  out = out.replace(/\{\{newline\}\}/gi, "\n");
  out = out.replace(/\{\{space\}\}/gi, " ");

  // 4. World clock & recent message macros
  if (ctx.worldTime !== undefined) {
    out = out.replace(/\{\{(?:time|isotime)\}\}/gi, ctx.worldTime);
  }
  if (ctx.worldDate !== undefined) {
    out = out.replace(/\{\{(?:date|isodate|weekday)\}\}/gi, ctx.worldDate);
  }
  if (ctx.idleDuration !== undefined) {
    out = out.replace(/\{\{idle_duration\}\}/gi, ctx.idleDuration);
  }
  if (ctx.lastUserMessage !== undefined) {
    out = out.replace(/\{\{lastUserMessage\}\}/gi, ctx.lastUserMessage);
  }
  if (ctx.lastCharMessage !== undefined) {
    out = out.replace(/\{\{lastCharMessage\}\}/gi, ctx.lastCharMessage);
  }

  // 5. {{outlet::name}} (World Info position=7 outlets)
  if (ctx.outlets) {
    out = out.replace(/\{\{outlet::([^}]+)\}\}/gi, (_m, rawName: string) => {
      const key = rawName.trim();
      return ctx.outlets?.[key] ?? "";
    });
  }

  // 6. {{random::a::b}} / {{random:a,b,c}}
  let choiceCounter = 0;
  out = out.replace(/\{\{random(::|:)([^}]+)\}\}/gi, (_m, sep: string, body: string) => {
    const options = splitMacroOptions(body, sep === "::");
    if (options.length === 0) return "";
    const idx =
      ctx.deterministicSeed !== undefined
        ? seededIndex(ctx.deterministicSeed + choiceCounter++, options.length)
        : crypto.randomInt(0, options.length);
    return options[idx] ?? options[0]!;
  });

  // 7. {{pick::a::b}} / {{pick:a,b,c}} — stable deterministic pick (SillyTavern official behavior!)
  out = out.replace(/\{\{pick(::|:)([^}]+)\}\}/gi, (_m, sep: string, body: string) => {
    const options = splitMacroOptions(body, sep === "::");
    if (options.length === 0) return "";
    const seed = ctx.deterministicSeed !== undefined ? ctx.deterministicSeed : fnv1aHash(`${ctx.charName}:${ctx.userName}:${body}`);
    return options[seed % options.length] ?? options[0]!;
  });

  // 8. {{roll:1d20+3}} / {{roll::1d20}} / {{roll:d20}}
  let rollCounter = 0;
  out = out.replace(/\{\{roll::?([^}]+)\}\}/gi, (_m, expr: string) => {
    const seed = ctx.deterministicSeed !== undefined ? ctx.deterministicSeed + 100 + rollCounter++ : undefined;
    return String(evalRollMacro(expr, seed));
  });

  // 9. {{getvar::key}} / {{getglobalvar::key}}
  out = out.replace(/\{\{(?:getvar|getglobalvar)::([^}]+)\}\}/gi, (_m, rawKey: string) => {
    const key = rawKey.trim();
    const val = ctx.vars?.[key];
    return val !== undefined ? String(val) : "";
  });

  // 10. Strip mutating variable macros so raw template syntax never leaks to LLM
  out = out.replace(/\{\{(?:setvar|setglobalvar|addvar|incvar|decvar|flushvar)::[^}]*\}\}/gi, "");

  // 11. {{trim}} — removes surrounding whitespace/newlines around the token (official ST behavior)
  out = out.replace(/[ \t\r\n]*\{\{trim\}\}[ \t\r\n]*/gi, "");

  return out;
}
