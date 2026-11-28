/**
 * Refined Editorial TUI Renderers for official Pi SDK (`registerMessageRenderer`,
 * `renderCall`, `renderResult`).
 *
 * Design language:
 *  - Hairline box drawing (`╭─`, `│`, `╰─`) with clean typographic section tags
 *  - Visual progress bars (`▓▓▓▓░░`) & semantic color tokens (with graceful fallback)
 *  - CJK double-width aware line wrapping so Chinese/English prose never overflows
 *  - Zero third-party dependencies, 100% safe on desktop TUI and mobile Pi
 */

import type { PiExtensionAPI, PiMessage, RpTxEntry } from "../types.js";

export interface PiThemeLike {
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
  dim?: (text: string) => string;
  italic?: (text: string) => string;
}

export interface TuiComponent {
  render(width: number): string[];
  invalidate(): void;
}

export function styleFg(theme: unknown, color: string, text: string): string {
  const t = theme as PiThemeLike | undefined;
  if (t && typeof t.fg === "function") {
    try {
      return t.fg(color, text);
    } catch {
      return text;
    }
  }
  return text;
}

export function styleBold(theme: unknown, text: string): string {
  const t = theme as PiThemeLike | undefined;
  if (t && typeof t.bold === "function") {
    try {
      return t.bold(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function styleDim(theme: unknown, text: string): string {
  const t = theme as PiThemeLike | undefined;
  if (t && typeof t.dim === "function") {
    try {
      return t.dim(text);
    } catch {
      return text;
    }
  }
  return text;
}

/** Render a crisp tactile progress bar like `▓▓▓▓░░` for clocks and bounded gauges. */
export function renderProgressBar(value: number, max: number, slots = 6): string {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, Math.min(1, value / safeMax));
  const width = Math.max(2, Math.min(slots, safeMax <= 8 ? safeMax : slots));
  const filled = Math.round(ratio * width);
  return `${"▓".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x1f300 && code <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charDisplayWidth(ch);
  return w;
}

/** Wrap a plain text line cleanly to fit within `maxWidth` columns (CJK-aware). */
export function wrapDisplayLine(line: string, maxWidth: number): string[] {
  const limit = Math.max(16, maxWidth);
  if (!line) return [""];
  const out: string[] = [];
  let current = "";
  let w = 0;

  for (const ch of line) {
    const cw = charDisplayWidth(ch);
    if (w + cw > limit && current.length > 0) {
      out.push(current);
      current = ch;
      w = cw;
    } else {
      current += ch;
      w += cw;
    }
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

/** Create a zero-dependency Pi TUI Component from a width-aware line renderer. */
export function createLinesComponent(getLines: (width: number) => string[]): TuiComponent {
  return {
    render(width: number): string[] {
      const safeWidth = Number.isFinite(width) && width > 10 ? Math.floor(width) : 80;
      return getLines(safeWidth);
    },
    invalidate(): void {
      // Stateless pure renderer
    },
  };
}

function extractMessageText(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function renderEditorialCard(options: {
  tag: string;
  title: string;
  subtitle?: string;
  body: string;
  accentColor: string;
  theme: unknown;
  width: number;
  maxLines?: number;
}): string[] {
  const { tag, title, subtitle, body, accentColor, theme, width, maxLines } = options;
  const innerWidth = Math.max(24, Math.min(width - 4, 96));
  const border = styleFg(theme, accentColor, "│");
  const headerRule = styleFg(theme, accentColor, "╭─");
  const footerRule = styleFg(theme, accentColor, `╰${"─".repeat(Math.min(innerWidth + 1, 44))}`);

  const headerLine =
    `${headerRule} ${styleFg(theme, accentColor, `[${tag}]`)} ${styleBold(theme, title)}` +
    (subtitle ? ` ${styleDim(theme, `· ${subtitle}`)}` : "");

  const lines: string[] = [headerLine];
  const rawLines = body.replace(/\r\n?/g, "\n").split("\n");
  const wrapped: string[] = [];
  for (const raw of rawLines) {
    wrapped.push(...wrapDisplayLine(raw, innerWidth));
  }

  const limit = maxLines && wrapped.length > maxLines ? maxLines : wrapped.length;
  for (let i = 0; i < limit; i++) {
    lines.push(`${border} ${wrapped[i]!}`);
  }
  if (maxLines && wrapped.length > maxLines) {
    lines.push(`${border} ${styleDim(theme, `… 其余 ${wrapped.length - maxLines} 行已折叠，展开查看全文`)}`);
  }

  lines.push(footerRule);
  return lines;
}

/** Register custom Pi message renderers for RP narrative cards (`rp:greeting`, `rp:event`, `rp:ooc`, `rp:era`). */
export function registerRpMessageRenderers(pi: PiExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  pi.registerMessageRenderer("rp:greeting", (message, options, theme) => {
    const details = (message.details ?? {}) as { cardName?: string; greetingIndex?: number; era?: string };
    const title = details.cardName || "角色开场白";
    const subtitle = `开场 #${(details.greetingIndex ?? 0) + 1}${details.era ? ` · ${details.era}` : ""}`;
    const text = extractMessageText(message);
    return createLinesComponent((width) =>
      renderEditorialCard({
        tag: "OPENING",
        title,
        subtitle,
        body: text,
        accentColor: "accent",
        theme,
        width,
        maxLines: options?.expanded ? undefined : 22,
      }),
    );
  });

  pi.registerMessageRenderer("rp:event", (message, options, theme) => {
    const details = (message.details ?? {}) as { kind?: string; title?: string; subtitle?: string };
    const tag = details.kind === "roll" ? "CHECK" : details.kind === "recap" ? "RECAP" : "EVENT";
    const title =
      details.title ||
      (details.kind === "roll" ? "掷骰判定" : details.kind === "recap" ? "前情提要" : "世界事件");
    const text = extractMessageText(message);
    return createLinesComponent((width) =>
      renderEditorialCard({
        tag,
        title,
        subtitle: details.subtitle,
        body: text,
        accentColor: details.kind === "roll" || details.kind === "recap" ? "accent" : "muted",
        theme,
        width,
        maxLines: options?.expanded ? undefined : details.kind === "recap" ? 20 : 10,
      }),
    );
  });

  pi.registerMessageRenderer("rp:ooc", (message, options, theme) => {
    const text = extractMessageText(message);
    return createLinesComponent((width) =>
      renderEditorialCard({
        tag: "OOC",
        title: "场外讨论",
        subtitle: "不推进剧情与世界时钟",
        body: text,
        accentColor: "dim",
        theme,
        width,
        maxLines: options?.expanded ? undefined : 14,
      }),
    );
  });

  pi.registerMessageRenderer("rp:era", (message, options, theme) => {
    const details = (message.details ?? {}) as { fromEra?: string; toEra?: string; milestones?: string[] };
    const title =
      details.fromEra && details.toEra ? `${details.fromEra}  ━━▶  ${details.toEra}` : "幕次跃迁 · 蒙太奇";
    const subtitle = details.milestones?.length ? `解锁：${details.milestones.join("、")}` : undefined;
    const text = extractMessageText(message);
    return createLinesComponent((width) =>
      renderEditorialCard({
        tag: "ERA",
        title,
        subtitle,
        body: text,
        accentColor: "warning",
        theme,
        width,
        maxLines: options?.expanded ? undefined : 16,
      }),
    );
  });
}


/** Register human-readable `/tree` entry renderer for `rp:tx` session-tree transactions. */
export function registerRpEntryRenderer(pi: PiExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function") return;

  pi.registerEntryRenderer("rp:tx", (entry, _options, theme) => {
    const tx = entry.data as RpTxEntry | undefined;
    if (!tx || typeof tx !== "object") return undefined;

    let label = `RP 事件: ${tx.kind}`;
    switch (tx.kind) {
      case "bind":
        label = `🎭 开启扮演 · ${tx.cardSlug}`;
        break;
      case "unbind":
        label = "🚪 退出 RP 模式";
        break;
      case "location_set":
        label = `📍 场景变更 · ${tx.location || "(空)"}${tx.presentNpcs.length ? ` (${tx.presentNpcs.join("、")})` : ""}`;
        break;
      case "stat_patch":
        label = `📊 数值 · ${tx.actorId}.${tx.key} ${tx.op === "add" ? (Number(tx.value) >= 0 ? `+${tx.value}` : tx.value) : `= ${String(tx.value)}`}`;
        break;
      case "inventory_patch":
        label = `🎒 物品 · ${tx.actorId} ${tx.item} (${tx.delta > 0 ? `+${tx.delta}` : tx.delta})`;
        break;
      case "progress_clock":
        label = `⏳ 时钟 · ${tx.label} (${tx.delta >= 0 ? `+${tx.delta}` : tx.delta}/${tx.max})`;
        break;
      case "cfsm_transition":
        label = `💭 心态 · ${tx.actorId}.${tx.axis}: ${tx.from} → ${tx.to}`;
        break;
      case "fact_add":
        label = `🧠 事实 · ${tx.fact.statement.slice(0, 42)}`;
        break;
      case "fact_invalidate":
        label = `✖ 事实失效 · ${tx.factId}`;
        break;
      case "belief_update":
        label = `◇ 信念 · ${tx.actorId} → ${tx.target}: ${tx.belief.slice(0, 36)}`;
        break;
      case "foresight_upsert":
        label = `✨ 伏笔 · ${tx.hook.summary.slice(0, 42)} [${tx.hook.status}]`;
        break;
      case "era_advance":
        label = `🎬 阶段跃迁 · ${tx.fromEra || "起"} → ${tx.toEra || "无"}`;
        break;
      case "clock_tick":
        label = tx.worldTimeLabel ? `🕒 时间 · ${tx.worldTimeLabel}` : `🕒 回合推进 (+${tx.beatDelta})`;
        break;
      case "note_set":
        label = `🎬 导演指令 · ${tx.note.text.slice(0, 38)}`;
        break;
      case "profile_apply":
        label = `🔍 画像应用 · ${tx.archetype}`;
        break;
      default:
        return undefined;
    }

    return createLinesComponent(() => [styleDim(theme, label)]);
  });
}
