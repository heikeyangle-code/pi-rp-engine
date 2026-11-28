/**
 * Refined Adaptive Minimal & Full HUD renderer using Pi official `ctx.ui.setStatus` and `ctx.ui.setWidget`.
 *
 * Design principles:
 *  - Universal semantics: never displays hardcoded "Act I" or "Day 1" — only shows stage/time when present.
 *  - Minimal mode: calm single-line status (`◆ 角色 · [阶段] · [时间] · [地点] · T12 · [伏笔:2]`).
 *  - Full mode: crisp framed telemetry strip above the editor with archetype badge, CFSM states,
 *    tactile progress bars (`▓▓░░`), bounded stats, inventory preview, active clocks, director notes,
 *    and a mobile-friendly compact keybinding footer.
 *  - Dormant / Exit: 100% clean teardown (`clearRpHud`) leaving zero UI artifacts.
 */

import type { CardArchetype, CompiledCard, PacingMode, PiExtensionContext, SessionRpState } from "../types.js";
import { renderProgressBar } from "./renderers.js";

const PACING_LABEL: Record<PacingMode, string> = {
  relaxed: "舒缓",
  balanced: "均衡",
  dramatic: "紧张",
};

const ARCHETYPE_LABEL: Record<CardArchetype, string> = {
  companion: "陪伴",
  "slice-of-life": "日常",
  "rpg-sandbox": "沙盒",
  mystery: "悬疑",
  "epic-saga": "史诗",
  ensemble: "群像",
};

export function formatRpStatusLine(state: SessionRpState, card: CompiledCard | null): string {
  const charName = card ? card.identity.nickname || card.identity.name : state.cardSlug ?? "RP";
  const parts = [`◆ ${charName}`, state.era, state.worldTimeLabel].filter(Boolean);
  if (state.location) parts.push(state.location);
  parts.push(`T${state.turn}`);
  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").length;
  if (openHooks > 0) {
    parts.push(`伏笔:${openHooks}`);
  }
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
      [state.era, state.worldTimeLabel, `T${state.turn}`].filter(Boolean).join(" · "),
      state.location ? `📍${state.location}` : null,
      state.presentNpcs.length > 0 ? `在场:${state.presentNpcs.join("、")}` : null,
    ].filter(Boolean);
    lines.push(headerParts.join("  │  "));

    const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").length;
    const metaParts = [
      `扮演:${state.currentPersona.name}`,
      `类型:${ARCHETYPE_LABEL[state.archetype] ?? state.archetype}`,
      `节奏:${PACING_LABEL[state.pacingMode]}`,
      `结算:${state.settlementMode}`,
      openHooks > 0 ? `伏笔:${openHooks}` : null,
      state.activeCharacters.length > 1 ? `共演:${state.activeCharacters.length}卡` : null,
      state.rawPassthrough ? "原味直通" : null,
    ].filter(Boolean);
    lines.push(`│ ${metaParts.join(" · ")}`);

    // CFSM states (compact actor attitude/stage badges)
    const cfsmSnippets: string[] = [];
    for (const [actor, axes] of Object.entries(state.cfsmStates)) {
      const pairs = Object.entries(axes)
        .slice(0, 3)
        .map(([axis, rec]) => `${axis}:${rec.state}`);
      if (pairs.length > 0) {
        cfsmSnippets.push(`${actor}〔${pairs.join(" · ")}〕`);
      }
    }
    if (cfsmSnippets.length > 0) {
      lines.push(`│ 心态  ${cfsmSnippets.slice(0, 2).join("  ")}`);
    }

    // Stats (bounded gauges)
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
      lines.push(`│ 数值  ${statSnippets.slice(0, 2).join("  ")}`);
    }

    // Inventory highlight (only when inventory module is active and non-empty)
    if (state.modules.inventory) {
      const invPairs: string[] = [];
      for (const [actor, bag] of Object.entries(state.inventory)) {
        for (const [item, qty] of Object.entries(bag)) {
          invPairs.push(actor === "player" ? `${item}×${qty}` : `${actor}:${item}×${qty}`);
        }
      }
      if (invPairs.length > 0) {
        const shown = invPairs.slice(0, 4).join(" · ");
        const extra = invPairs.length > 4 ? ` (+${invPairs.length - 4})` : "";
        lines.push(`│ 物品  ${shown}${extra}`);
      }
    }

    const activeClocks = Object.values(state.clocks).filter((c) => !c.completed);
    if (activeClocks.length > 0) {
      lines.push(
        `│ 时钟  ${activeClocks
          .slice(0, 3)
          .map((c) => `${c.label} ${renderProgressBar(c.value, c.max, 6)} ${c.value}/${c.max}`)
          .join("  ")}`,
      );
    }

    if (state.notes.length > 0) {
      lines.push(
        `│ 导演  ${state.notes
          .slice(0, 2)
          .map((n) => `${n.text.slice(0, 28)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : ""}`)
          .join(" / ")}`,
      );
    }

    // Mobile-safe concise footer (fits cleanly on narrow pi-android screens)
    lines.push("╰─ Alt+R 菜单 · Ctrl+Shift+R 面板 · Alt+W 重摇 · Alt+K 续写 · Alt+H 切HUD");

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
