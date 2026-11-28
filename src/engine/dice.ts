/**
 * Deterministic / true-random dice & check engine using Node crypto.randomInt.
 * Supports:
 *  - Standard XdY(+/-mod) and shorthand d20 / d100
 *  - Advantage / Disadvantage / Keep-Highest / Keep-Lowest: 2d20kh1, 2d20kl1, 4d6kh3+2
 */

import * as crypto from "node:crypto";

export interface RollCheckResult {
  expression: string;
  rolls: number[];
  keptRolls: number[];
  modifier: number;
  total: number;
  dc?: number;
  success?: boolean;
  critical?: "nat_max" | "nat_min" | null;
}

export function rollDiceCheck(options: {
  expression: string;
  extraModifier?: number;
  dc?: number;
  deterministicRolls?: number[];
}): RollCheckResult {
  const m = /^\s*(\d*)\s*d\s*(\d+)\s*(?:(kh|kl)\s*(\d+))?\s*(?:([+-])\s*(\d+))?\s*$/i.exec(options.expression);
  if (!m) {
    throw new Error(
      `无效的骰子表达式 "${options.expression}"（支持如 1d20、d20+3、2d6、1d100、2d20kh1 优势、2d20kl1 劣势）`,
    );
  }
  const count = Math.min(Math.max(m[1] ? parseInt(m[1], 10) : 1, 1), 100);
  const rawSides = parseInt(m[2]!, 10);
  if (!Number.isFinite(rawSides) || rawSides < 1) {
    throw new Error(`无效的骰子面数 "${options.expression}"（面数必须 >= 1）`);
  }
  const sides = Math.min(rawSides, 10000);
  const keepMode = m[3]?.toLowerCase() as "kh" | "kl" | undefined;
  const keepCount = m[4] ? Math.min(Math.max(parseInt(m[4], 10), 1), count) : count;
  const sign = m[5] === "-" ? -1 : 1;
  const exprMod = m[6] ? parseInt(m[6], 10) * sign : 0;
  const modifier = exprMod + (options.extraModifier ?? 0);

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const predetermined = options.deterministicRolls?.[i];
    const r =
      predetermined !== undefined
        ? Math.min(Math.max(Math.floor(predetermined), 1), sides)
        : sides === 1
          ? 1
          : crypto.randomInt(1, sides + 1);
    rolls.push(r);
  }

  let keptRolls = rolls.slice();
  if (keepMode === "kh") {
    keptRolls = rolls.slice().sort((a, b) => b - a).slice(0, keepCount);
  } else if (keepMode === "kl") {
    keptRolls = rolls.slice().sort((a, b) => a - b).slice(0, keepCount);
  }

  const sum = keptRolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;
  const critical: RollCheckResult["critical"] =
    keptRolls.length === 1 && sides === 20
      ? keptRolls[0] === 20
        ? "nat_max"
        : keptRolls[0] === 1
          ? "nat_min"
          : null
      : null;

  const success =
    options.dc !== undefined
      ? critical === "nat_max"
        ? true
        : critical === "nat_min"
          ? false
          : total >= options.dc
      : undefined;

  const keepSuffix = keepMode ? `${keepMode}${keepCount}` : "";
  const modSuffix = modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : "";

  return {
    expression: `${count}d${sides}${keepSuffix}${modSuffix}`,
    rolls,
    keptRolls,
    modifier,
    total,
    dc: options.dc,
    success,
    critical,
  };
}
