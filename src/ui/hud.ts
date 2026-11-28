/**
 * Mobile-First Context-Adaptive Minimal & Full HUD renderer using Pi official `ctx.ui.setStatus` and `ctx.ui.setWidget`.
 *
 * v5 Mobile-First Enhancements:
 *  - Display-column aware clamping (`<= 44` cols) so 36–48 col mobile screens never clip or wrap awkwardly.
 *  - Zero internal implementation noise (no KV-Cache counters or command-spam footers).
 *  - Unobtrusive `⚠同步` indicator when background Sidecar sync fails.
 */

import type {
  CompiledCard,
  ContextXRaySnapshot,
  PacingMode,
  PiExtensionContext,
  SessionRpState,
} from "../types.js";
import { evaluateActiveStorylets } from "../context/zone-builder.js";
import {
  createLinesComponent,
  displayWidth,
  renderProgressBar,
  renderSmartStatBar,
  styleBold,
  styleDim,
  styleFg,
  truncateDisplayLine,
} from "./renderers.js";

const MOBILE_MAX_COLS = 44;

const PACING_LABEL: Record<PacingMode, string> = {
  relaxed: "舒缓",
  balanced: "均衡",
  dramatic: "紧张",
};

type StateWithSidecarStatus = SessionRpState & {
  lastSidecarStatus?: { ok: boolean; error?: string };
};

function getSidecarFailed(state: SessionRpState): boolean {
  const status = (state as StateWithSidecarStatus).lastSidecarStatus;
  return Boolean(status && !status.ok);
}

function clampSeg(text: string, maxCols: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return truncateDisplayLine(clean, maxCols);
}

export function formatRpStatusLine(
  state: SessionRpState,
  card: CompiledCard | null,
  _xray?: ContextXRaySnapshot | null,
): string {
  const charName = clampSeg(card ? card.identity.nickname || card.identity.name : state.cardSlug ?? "RP", 10);
  const sep = " · ";
  const sepW = displayWidth(sep);

  const head = `◆ ${charName}`;
  const turnSeg = `T${state.turn}`;
  const sidecarFailSeg = getSidecarFailed(state) ? "⚠同步" : null;

  // Priority-ordered optional segments (trimmed by display columns so total stays <= 44 cols)
  const optionalSegs: string[] = [];
  if (state.location) optionalSegs.push(clampSeg(state.location, 12));
  if (state.worldTimeLabel) optionalSegs.push(clampSeg(state.worldTimeLabel, 10));
  else if (state.era) optionalSegs.push(clampSeg(state.era, 10));

  const condCount = Object.keys(state.conditions).length;
  if (condCount > 0) optionalSegs.push(`⚡${condCount}`);

  const activeFlags = Object.values(state.flags).filter(Boolean).length;
  if (activeFlags > 0) optionalSegs.push(`🚩${activeFlags}`);

  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").length;
  if (openHooks > 0) optionalSegs.push(`伏笔:${openHooks}`);

  // Reserve width for mandatory head + turnSeg + optional sidecar failure badge
  const tailSegs = [turnSeg, ...(sidecarFailSeg ? [sidecarFailSeg] : [])];
  const tailWidth = tailSegs.reduce((acc, s) => acc + sepW + displayWidth(s), 0);
  let usedWidth = displayWidth(head) + tailWidth;

  const chosenMiddle: string[] = [];
  for (const seg of optionalSegs) {
    if (!seg) continue;
    const needed = sepW + displayWidth(seg);
    if (usedWidth + needed <= MOBILE_MAX_COLS) {
      chosenMiddle.push(seg);
      usedWidth += needed;
    }
  }

  const line = [head, ...chosenMiddle, ...tailSegs].join(sep);
  return displayWidth(line) <= MOBILE_MAX_COLS ? line : truncateDisplayLine(line, MOBILE_MAX_COLS);
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

  // Split header cleanly across short lines for narrow mobile widths
  const titleParts = [`╭─ ◆ ${charName}`, state.era, state.worldTimeLabel, `T${state.turn}`].filter(Boolean);
  lines.push(titleParts.join(" · "));

  const locPart = state.location ? `📍${state.location}` : null;
  const npcPart = state.presentNpcs.length > 0 ? `在场:${state.presentNpcs.join("、")}` : null;
  if (locPart && npcPart) {
    const combined = `│ ${locPart} · ${npcPart}`;
    if (displayWidth(combined) <= MOBILE_MAX_COLS) {
      lines.push(combined);
    } else {
      lines.push(`│ ${locPart}`);
      lines.push(`│ ${npcPart}`);
    }
  } else if (locPart) {
    lines.push(`│ ${locPart}`);
  } else if (npcPart) {
    lines.push(`│ ${npcPart}`);
  }

  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").length;
  const activeFlagNames = Object.entries(state.flags).filter(([, v]) => Boolean(v)).map(([k]) => k);
  const metaParts = [
    `扮演:${state.currentPersona.name}`,
    `节奏:${PACING_LABEL[state.pacingMode]}`,
    openHooks > 0 ? `伏笔:${openHooks}` : null,
    state.memoryBooks.size > 0 ? `记忆书:${state.memoryBooks.size}` : null,
    xray && xray.blindSpotCount > 0 ? `🔒盲区:${xray.blindSpotCount}` : null,
    state.activeCharacters.length > 1 ? `共演:${state.activeCharacters.length}卡` : null,
    state.innerMonologue ? "💭内心戏" : null,
    getSidecarFailed(state) ? "⚠同步" : null,
  ].filter(Boolean);
  lines.push(`│ ${metaParts.join(" · ")}`);

  if (activeFlagNames.length > 0) {
    lines.push(`│ 🚩 状态  ${activeFlagNames.slice(0, 5).join(" · ")}${activeFlagNames.length > 5 ? ` (+${activeFlagNames.length - 5})` : ""}`);
  }

  if (state.sceneObjective) {
    lines.push(`│ 🎯 目标  ${state.sceneObjective}`);
  }

  // Active timed/persistent Conditions (Buff/Debuff)
  const condList = Object.values(state.conditions);
  if (condList.length > 0) {
    const condText = condList
      .slice(0, 4)
      .map((c) => `${c.actorId}:${c.label}${c.remainingTurns !== null ? `(${c.remainingTurns}轮)` : ""}`)
      .join(" · ");
    lines.push(`│ ⚡ 状态  ${condText}${condList.length > 4 ? ` (+${condList.length - 4})` : ""}`);
  }

  // Recent dice roll result (shown for current/last turn)
  if (state.lastRoll && state.turn - state.lastRoll.turn <= 1) {
    const r = state.lastRoll;
    const badge =
      r.critical === "nat_max"
        ? "大成功★"
        : r.critical === "nat_min"
          ? "大失败✖"
          : r.success === true
            ? "成功✓"
            : r.success === false
              ? "失败✗"
              : "";
    lines.push(`│ 🎲 检定  ${r.expression} → ${r.total}${r.dc !== undefined ? `/DC${r.dc}` : ""}${badge ? ` · ${badge}` : ""}`);
  }

  // Triggered Storylets (smart adaptive: only shown when at least 1 storylet is live)
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

  // Inventory highlight
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

  // Narrative Health alert (only shown when genuine repetition or stagnation is detected)
  if (xray && ((xray.repetitionScore ?? 0) >= 0.42 || (xray.stagnantTurns ?? 0) >= 4)) {
    const alerts: string[] = [];
    if ((xray.repetitionScore ?? 0) >= 0.42) {
      alerts.push(`复读率 ${Math.round((xray.repetitionScore ?? 0) * 100)}%`);
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
        .map((n) => `${n.text.slice(0, 20)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : ""}`)
        .join(" / ")}`,
    );
  }

  lines.push("╰──────────────────────");
  return lines;
}

export function renderRpHud(
  ctx: PiExtensionContext,
  state: SessionRpState,
  card: CompiledCard | null,
  xray?: ContextXRaySnapshot | null,
): void {
  if (!ctx?.ui || ctx.hasUI === false) return;

  if (!state.active || state.hudMode === "off") {
    clearRpHud(ctx);
    return;
  }

  ctx.ui.setStatus("rp", formatRpStatusLine(state, card, xray));

  if (state.hudMode === "full") {
    const rawLines = buildHudRawLines(state, card, xray);

    // Official Pi SDK: component factory in TUI mode (dynamic terminal width + theme styling),
    // width-clamped string[] in RPC / mobile / test mode (JSON-RPC serializable, strictly <= 44 cols).
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
      const mobileClamped = rawLines.map((l) => truncateDisplayLine(l, MOBILE_MAX_COLS));
      ctx.ui.setWidget("rp-hud", mobileClamped, { placement: "aboveEditor" });
    }
  } else {
    ctx.ui.setWidget("rp-hud", undefined);
  }
}

export function clearRpHud(ctx: PiExtensionContext): void {
  if (!ctx?.ui || ctx.hasUI === false) return;
  try {
    ctx.ui.setStatus("rp", undefined);
    ctx.ui.setWidget("rp-hud", undefined);
  } catch {
    // Ignore in headless/test environments
  }
}
