/**
 * Refined Minimal & Full HUD renderer using Pi official `ctx.ui.setStatus` and `ctx.ui.setWidget`.
 *
 * Design principles:
 *  - Minimal mode: clean, calm single-line status (`◆ 角色 · 幕次 · 时间 · 地点 · T12`)
 *  - Full mode: crisp framed telemetry strip above the editor with visual clock bars (`▓▓░░`),
 *    bounded stats, active director notes, and subtle keybinding cues.
 *  - Dormant / Exit: 100% clean teardown (`clearRpHud`) leaving zero UI artifacts.
 */

import type { CompiledCard, PacingMode, PiExtensionContext, SessionRpState } from "../types.js";
import { renderProgressBar } from "./renderers.js";

const PACING_LABEL: Record<PacingMode, string> = {
  relaxed: "舒缓",
  balanced: "均衡",
  dramatic: "紧张",
};

export function formatRpStatusLine(state: SessionRpState, card: CompiledCard | null): string {
  const charName = card ? card.identity.nickname || card.identity.name : state.cardSlug ?? "RP";
  const parts = [`◆ ${charName}`, state.era, state.worldTimeLabel];
  if (state.location) parts.push(state.location);
  parts.push(`T${state.turn}`);
  if (state.pacingMode !== "balanced") {
    parts.push(`节奏:${PACING_LABEL[state.pacingMode]}`);
  }
  if (state.notes.length > 0) {
    parts.push(`指令:${state.notes.length}`);
  }
  return parts.join(" · ");
}

function formatBoundedStat(
  state: SessionRpState,
  actor: string,
  key: string,
  value: number | string | boolean,
): string {
  const bounds = state.statBounds[actor]?.[key];
  if (typeof value === "number" && bounds && typeof bounds.max === "number" && bounds.max > 0) {
    return `${key} ${renderProgressBar(value - (bounds.min ?? 0), bounds.max - (bounds.min ?? 0), 5)} ${value}/${bounds.max}`;
  }
  return `${key}:${String(value)}`;
}

export function renderRpHud(ctx: PiExtensionContext, state: SessionRpState, card: CompiledCard | null): void {
  if (!ctx?.ui) return;

  if (!state.active || state.hudMode === "off") {
    clearRpHud(ctx);
    return;
  }

  ctx.ui.setStatus("rp", formatRpStatusLine(state, card));

  if (state.hudMode === "full") {
    const charName = card ? card.identity.nickname || card.identity.name : state.cardSlug ?? "RP";
    const lines: string[] = [];

    const headerParts = [
      `╭─ ◆ ${charName}`,
      `${state.era} · ${state.worldTimeLabel} · T${state.turn}`,
      state.location ? `地点:${state.location}` : null,
      state.presentNpcs.length > 0 ? `在场:${state.presentNpcs.join("、")}` : null,
    ].filter(Boolean);
    lines.push(headerParts.join("  │  "));

    const metaParts = [
      `扮演:${state.currentPersona.name}`,
      `节奏:${PACING_LABEL[state.pacingMode]}`,
      `结算:${state.settlementMode}`,
      state.activeCharacters.length > 1 ? `共演:${state.activeCharacters.length}卡` : null,
      state.rawPassthrough ? "原味直通" : null,
    ].filter(Boolean);
    lines.push(`│ ${metaParts.join("  ·  ")}`);

    const statSnippets: string[] = [];
    for (const [actor, stats] of Object.entries(state.stats)) {
      const pairs = Object.entries(stats)
        .slice(0, 4)
        .map(([k, v]) => formatBoundedStat(state, actor, k, v));
      if (pairs.length > 0) {
        statSnippets.push(`${actor}〔${pairs.join(" · ")}〕`);
      }
    }
    if (statSnippets.length > 0) {
      lines.push(`│ 数值  ${statSnippets.slice(0, 2).join("   ")}`);
    }

    const activeClocks = Object.values(state.clocks).filter((c) => !c.completed);
    if (activeClocks.length > 0) {
      lines.push(
        `│ 时钟  ${activeClocks
          .slice(0, 3)
          .map((c) => `${c.label} ${renderProgressBar(c.value, c.max, 6)} ${c.value}/${c.max}`)
          .join("   ")}`,
      );
    }

    if (state.notes.length > 0) {
      lines.push(
        `│ 导演  ${state.notes
          .slice(0, 2)
          .map((n) => `${n.text.slice(0, 30)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : ""}`)
          .join("  /  ")}`,
      );
    }

    lines.push("╰─ Alt+R 菜单 · Ctrl+Shift+R 面板 · Alt+K 续写 · Alt+G 掷骰 · Alt+N 导演 · Alt+Shift+X 退出");

    ctx.ui.setWidget("rp-hud", lines, { placement: "aboveEditor" });
  } else {
    ctx.ui.setWidget("rp-hud", undefined);
  }
}

export function clearRpHud(ctx: PiExtensionContext): void {
  if (!ctx?.ui) return;
  try {
    ctx.ui.setStatus("rp", undefined);
    ctx.ui.setWidget("rp-hud", undefined);
  } catch {
    // Ignore in headless/test environments
  }
}
