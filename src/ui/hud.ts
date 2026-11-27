/**
 * 100% Official Pi ExtensionUIContext HUD renderer (`setStatus` + `setWidget`).
 * Renders identically on desktop Pi TUI and mobile `pi-android` with zero custom app hooks.
 */

import type { CompiledCard, PiExtensionContext, SessionRpState } from "../types.js";
import { getActiveFacts } from "../memory/bitemporal.js";

export const RP_STATUS_KEY = "rp";
export const RP_WIDGET_KEY = "rp-hud";

export function clearRpHud(ctx?: PiExtensionContext): void {
  if (!ctx?.ui) return;
  ctx.ui.setStatus(RP_STATUS_KEY, undefined);
  ctx.ui.setWidget(RP_WIDGET_KEY, undefined);
}

export function renderRpHud(
  ctx: PiExtensionContext | undefined,
  state: SessionRpState,
  card: CompiledCard | null,
): void {
  if (!ctx?.ui) return;
  if (!state.active || !card || state.hudMode === "off") {
    clearRpHud(ctx);
    return;
  }

  const charName = card.identity.nickname || card.identity.name;
  const statusParts = [
    `🎭 ${charName}`,
    state.era,
    state.worldTimeLabel,
    state.location || null,
    `T${state.turn}`,
  ].filter(Boolean);

  ctx.ui.setStatus(RP_STATUS_KEY, statusParts.join(" · "));

  if (state.hudMode === "minimal") {
    const lines: string[] = [];
    const clocks = Object.values(state.clocks).filter((c) => !c.completed);
    if (clocks.length > 0) {
      lines.push(`⏱ ${clocks.map((c) => `${c.label} ${c.value}/${c.max}`).join(" | ")}`);
    }
    const playerStats = state.stats.player ?? state.stats[charName];
    if (playerStats && Object.keys(playerStats).length > 0) {
      const pairs = Object.entries(playerStats)
        .slice(0, 5)
        .map(([k, v]) => `${k}:${v}`);
      lines.push(`📊 ${pairs.join(" · ")}`);
    }
    if (state.notes.length > 0) {
      lines.push(`📌 导演便签: ${state.notes.map((n) => n.text).join(" / ").slice(0, 60)}`);
    }
    ctx.ui.setWidget(RP_WIDGET_KEY, lines.length > 0 ? lines : undefined);
    return;
  }

  // Full HUD mode
  const lines: string[] = [
    `🎭 ${charName} · 玩家: ${state.currentPersona.name} · 时代: ${state.era} (${state.worldTimeLabel}, T${state.turn})`,
  ];
  if (state.location) {
    lines.push(`📍 ${state.location}${state.presentNpcs.length ? ` · 在场: ${state.presentNpcs.join(", ")}` : ""}`);
  }
  for (const [actor, stats] of Object.entries(state.stats)) {
    const entries = Object.entries(stats);
    if (entries.length > 0) {
      lines.push(`📊 ${actor}: ${entries.map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    }
  }
  for (const [actor, inv] of Object.entries(state.inventory)) {
    const items = Object.entries(inv);
    if (items.length > 0) {
      lines.push(`🎒 ${actor}: ${items.map(([k, v]) => `${k}×${v}`).join(", ")}`);
    }
  }
  const clocks = Object.values(state.clocks);
  if (clocks.length > 0) {
    lines.push(`⏱ 时钟: ${clocks.map((c) => `${c.label} ${c.value}/${c.max}`).join(" | ")}`);
  }
  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open");
  lines.push(`🧠 有效事实 ${getActiveFacts(state).length} · 未收伏笔 ${openHooks.length} · 结算: ${state.settlementMode}`);
  if (state.notes.length > 0) {
    lines.push(`📌 便签: ${state.notes.map((n) => n.text).join(" / ")}`);
  }
  ctx.ui.setWidget(RP_WIDGET_KEY, lines);
}
