/**
 * Smart Context-Adaptive Minimal & Full HUD renderer using Pi official `ctx.ui.setStatus` and `ctx.ui.setWidget`.
 *
 * v4 Enhancements:
 *  - Smart visibility: only renders rows relevant to the current card & live world state
 *    (objective, triggered storylets, epistemic blind spots, CFSM, bipolar-aware stats,
 *    inventory when active/non-empty, clocks when active, narrative health warnings).
 *  - Honest 3-layer KV-Cache status badge (`⚡KV×N` vs `⚠KV刷新`).
 *  - TUI mode uses width-aware component factory; RPC/mobile mode uses width-clamped `string[]`.
 */

import type {
  CardArchetype,
  CompiledCard,
  ContextXRaySnapshot,
  PacingMode,
  PiExtensionContext,
  SessionRpState,
} from "../types.js";
import { evaluateActiveStorylets } from "../context/zone-builder.js";
import {
  createLinesComponent,
  renderProgressBar,
  renderSmartStatBar,
  styleBold,
  styleDim,
  styleFg,
  truncateDisplayLine,
} from "./renderers.js";

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

function formatKvBadge(xray?: ContextXRaySnapshot | null): string | null {
  if (!xray) return null;
  if (
    xray.cacheInvalidationReason === "tools_changed" ||
    xray.cacheInvalidationReason === "zone1_changed" ||
    xray.cacheInvalidationReason === "history_mutated"
  ) {
    return "⚠KV刷新";
  }
  if (xray.cacheHitStreak >= 2) return `⚡KV×${xray.cacheHitStreak}`;
  if (xray.cacheHitStreak === 1) return "⚡KV×1";
  return null;
}

export function formatRpStatusLine(
  state: SessionRpState,
  card: CompiledCard | null,
  xray?: ContextXRaySnapshot | null,
): string {
  const charName = card ? card.identity.nickname || card.identity.name : state.cardSlug ?? "RP";
  const parts = [`◆ ${charName}`, state.era, state.worldTimeLabel].filter(Boolean);
  if (state.location) parts.push(state.location);
  parts.push(`T${state.turn}`);
  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").length;
  if (openHooks > 0) parts.push(`伏笔:${openHooks}`);
  if (state.memoryBooks.size > 0) parts.push(`书:${state.memoryBooks.size}`);
  if (xray && xray.blindSpotCount > 0) parts.push(`🔒盲区:${xray.blindSpotCount}`);
  if (state.pacingMode !== "balanced") parts.push(`节奏:${PACING_LABEL[state.pacingMode]}`);
  if (state.innerMonologue) parts.push("💭");
  if (state.notes.length > 0) parts.push(`指令:${state.notes.length}`);
  const kv = formatKvBadge(xray);
  if (kv && (kv.startsWith("⚠") || (xray && xray.cacheHitStreak >= 2))) parts.push(kv);
  return parts.join(" · ");
}

function formatBoundedStat(
  state: SessionRpState,
  actor: string,
  key: string,
  value: number | string | boolean,
): string {
  const bounds = state.statBounds[actor]?.[key];
  if (typeof value === "number" && bounds) {
    const bar = renderSmartStatBar(value, bounds.min, bounds.max, 5);
    if (bar) return `${key} ${bar}`;
  }
  return `${key}:${String(value)}`;
}

function buildHudRawLines(
  state: SessionRpState,
  card: CompiledCard | null,
  xray?: ContextXRaySnapshot | null,
): string[] {
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
  const kvBadge = formatKvBadge(xray);
  const metaParts = [
    `扮演:${state.currentPersona.name}`,
    `类型:${ARCHETYPE_LABEL[state.archetype] ?? state.archetype}`,
    `节奏:${PACING_LABEL[state.pacingMode]}`,
    `结算:${state.settlementMode}`,
    openHooks > 0 ? `伏笔:${openHooks}` : null,
    state.memoryBooks.size > 0 ? `记忆书:${state.memoryBooks.size}` : null,
    xray && xray.blindSpotCount > 0 ? `🔒盲区:${xray.blindSpotCount}` : null,
    state.activeCharacters.length > 1 ? `共演:${state.activeCharacters.length}卡` : null,
    state.innerMonologue ? "💭内心戏" : null,
    state.rawPassthrough ? "原味直通" : null,
    kvBadge,
  ].filter(Boolean);
  lines.push(`│ ${metaParts.join(" · ")}`);

  if (state.sceneObjective) {
    lines.push(`│ 🎯 目标  ${state.sceneObjective}`);
  }

  // Triggered Storylets (smart adaptive: only shown when at least 1 storylet is live!)
  const liveStorylets = evaluateActiveStorylets(state);
  if (liveStorylets.length > 0) {
    lines.push(`│ 🃏 剧情  ${liveStorylets.slice(0, 2).map((s) => s.title).join(" · ")}`);
  }

  // CFSM states
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

  // Stats (bipolar-aware & actor-grouped)
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

  // Inventory highlight (smart: shown when inventory module is on OR any items exist)
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

  const activeClocks = Object.values(state.clocks).filter((c) => !c.completed);
  if (activeClocks.length > 0) {
    lines.push(
      `│ 时钟  ${activeClocks
        .slice(0, 3)
        .map((c) => `${c.label} ${renderProgressBar(c.value, c.max, 6)} ${c.value}/${c.max}`)
        .join("  ")}`,
    );
  }

  // Narrative Health alert (only shown when genuine repetition or stagnation is detected!)
  if (xray && ((xray.repetitionScore ?? 0) >= 0.42 || (xray.stagnantTurns ?? 0) >= 4)) {
    const alerts: string[] = [];
    if ((xray.repetitionScore ?? 0) >= 0.42) {
      alerts.push(`复读率 ${Math.round((xray.repetitionScore ?? 0) * 100)}%（已自动注入去重引导）`);
    }
    if ((xray.stagnantTurns ?? 0) >= 4) {
      alerts.push(`连续 ${xray.stagnantTurns} 轮无进展`);
    }
    lines.push(`│ ⚠ 叙事  ${alerts.join(" · ")}`);
  }

  if (state.notes.length > 0) {
    lines.push(
      `│ 导演  ${state.notes
        .slice(0, 2)
        .map((n) => `${n.text.slice(0, 28)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : ""}`)
        .join(" / ")}`,
    );
  }

  lines.push("╰─ Alt+R 菜单 · Ctrl+Shift+R 面板 · Alt+E 快捷回复 · Alt+X X-Ray · Alt+W 重摇 · Alt+H HUD");
  return lines;
}

export function renderRpHud(
  ctx: PiExtensionContext,
  state: SessionRpState,
  card: CompiledCard | null,
  xray?: ContextXRaySnapshot | null,
): void {
  if (!ctx?.ui) return;

  if (!state.active || state.hudMode === "off") {
    clearRpHud(ctx);
    return;
  }

  ctx.ui.setStatus("rp", formatRpStatusLine(state, card, xray));

  if (state.hudMode === "full") {
    const rawLines = buildHudRawLines(state, card, xray);

    // Official Pi SDK: component factory in TUI mode (dynamic terminal width + theme styling),
    // width-clamped string[] in RPC / mobile / test mode (JSON-RPC serializable).
    if (ctx.mode === "tui") {
      ctx.ui.setWidget(
        "rp-hud",
        (_tui, theme) =>
          createLinesComponent((width) =>
            rawLines.map((line, idx) => {
              const clamped = truncateDisplayLine(line, Math.max(24, width - 1));
              if (idx === 0) return styleBold(theme, styleFg(theme, "accent", clamped));
              if (idx === rawLines.length - 1) return styleDim(theme, clamped);
              return clamped;
            }),
          ),
        { placement: "aboveEditor" },
      );
    } else {
      const mobileClamped = rawLines.map((l) => truncateDisplayLine(l, 72));
      ctx.ui.setWidget("rp-hud", mobileClamped, { placement: "aboveEditor" });
    }
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
