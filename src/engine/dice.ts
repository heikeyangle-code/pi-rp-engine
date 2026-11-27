/**
 * Deterministic / true-random XdY(+/-mod) dice & check engine using Node crypto.randomInt.
 */

import * as crypto from "node:crypto";

export interface RollCheckResult {
  expression: string;
  rolls: number[];
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
  const m = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i.exec(options.expression);
  if (!m) {
    throw new Error(`Invalid dice expression "${options.expression}" (expected e.g. 1d20+3, 2d6, 1d100)`);
  }
  const count = Math.min(Math.max(parseInt(m[1]!, 10), 1), 100);
  const sides = Math.min(Math.max(parseInt(m[2]!, 10), 2), 10000);
  const sign = m[3] === "-" ? -1 : 1;
  const exprMod = m[4] ? parseInt(m[4], 10) * sign : 0;
  const modifier = exprMod + (options.extraModifier ?? 0);

  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const predetermined = options.deterministicRolls?.[i];
    const r =
      predetermined !== undefined
        ? Math.min(Math.max(predetermined, 1), sides)
        : crypto.randomInt(1, sides + 1);
    rolls.push(r);
  }

  const sum = rolls.reduce((a, b) => a + b, 0);
  const total = sum + modifier;
  const critical: RollCheckResult["critical"] =
    count === 1 && sides === 20
      ? rolls[0] === 20
        ? "nat_max"
        : rolls[0] === 1
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

  return {
    expression: `${count}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? `${modifier}` : ""}`,
    rolls,
    modifier,
    total,
    dc: options.dc,
    success,
    critical,
  };
}
