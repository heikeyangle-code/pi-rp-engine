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

import type { PiExtensionAPI, PiMessage } from "../types.js";

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

/** Render a centered bipolar bar like `░▓▓│░░░` or `░░░│▓▓░` for negative-to-positive stats (e.g. -100..+100). */
export function renderBipolarBar(value: number, min: number, max: number, halfSlots = 3): string {
  const slots = Math.max(2, Math.min(5, halfSlots));
  const negSpan = Math.max(1, Math.abs(Math.min(0, min)));
  const posSpan = Math.max(1, Math.max(0, max));
  if (value < 0) {
    const filled = Math.min(slots, Math.max(1, Math.round((Math.abs(value) / negSpan) * slots)));
    return `${"░".repeat(slots - filled)}${"▓".repeat(filled)}│${"░".repeat(slots)}`;
  }
  if (value > 0) {
    const filled = Math.min(slots, Math.max(1, Math.round((value / posSpan) * slots)));
    return `${"░".repeat(slots)}│${"▓".repeat(filled)}${"░".repeat(slots - filled)}`;
  }
  return `${"░".repeat(slots)}│${"░".repeat(slots)}`;
}

/** Automatically choose bipolar bar (when min < 0 < max) or standard progress bar (when bounded). */
export function renderSmartStatBar(
  value: number,
  min?: number,
  max?: number,
  slots = 5,
): string | null {
  if (typeof max !== "number") return null;
  const lo = typeof min === "number" ? min : 0;
  if (max <= lo) return null;
  if (lo < 0 && max > 0) {
    const sign = value > 0 ? `+${value}` : String(value);
    return `${renderBipolarBar(value, lo, max, Math.max(2, Math.floor(slots / 2) + 1))} ${sign}`;
  }
  return `${renderProgressBar(value - lo, max - lo, slots)} ${value}/${max}`;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0xfe0f || code === 0x200d) return 0;
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
  const stripped = text.replace(ANSI_ESCAPE_RE, "");
  let w = 0;
  for (const ch of stripped) w += charDisplayWidth(ch);
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

/** Truncate a single plain-text line to fit within `maxWidth` columns (CJK double-width aware). */
export function truncateDisplayLine(line: string, maxWidth: number): string {
  const limit = Math.max(8, Math.floor(maxWidth));
  if (displayWidth(line) <= limit) return line;
  const target = Math.max(4, limit - 1);
  let out = "";
  let w = 0;
  for (const ch of line) {
    const cw = charDisplayWidth(ch);
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** Style optional `<thought>...</thought>` inner monologue blocks into crisp Markdown asides (skipping fenced code blocks). */
export function formatThoughtBlocks(markdown: string): string {
  if (!/<thought\b/i.test(markdown)) return markdown;
  return markdown.replace(
    /(?:^|\r?\n)(?:```|~~~)[^\n]*\r?\n[\s\S]*?(?:\r?\n(?:```|~~~)[ \t]*(?=\r?\n|$)|$)|<thought\b[^>]*>([\s\S]*?)<\/thought>/gi,
    (full, inner: string | undefined) => {
      if (inner === undefined) return full;
      const cleaned = inner
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, idx) => (idx === 0 ? `> 💭 *${line}*` : `> *${line}*`))
        .join("\n");
      return cleaned ? `${cleaned}\n` : "";
    },
  );
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

  const prefixPlain = `╭─ [${tag}] `;
  const availHeader = Math.max(8, width - displayWidth(prefixPlain));
  const rawMeta = subtitle ? `${title} · ${subtitle}` : title;
  const headerLine =
    displayWidth(rawMeta) <= availHeader
      ? `${headerRule} ${styleFg(theme, accentColor, `[${tag}]`)} ${styleBold(theme, title)}` +
        (subtitle ? ` ${styleDim(theme, `· ${subtitle}`)}` : "")
      : `${headerRule} ${styleFg(theme, accentColor, `[${tag}]`)} ${styleBold(theme, truncateDisplayLine(rawMeta, availHeader))}`;

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

/** Register custom Pi message renderers for auxiliary RP cards (`rp:event`, `rp:ooc`, `rp:era`).
 *  Note: `rp:greeting` intentionally uses Pi's native Markdown renderer without an ASCII frame for clean reading. */
export function registerRpMessageRenderers(pi: PiExtensionAPI): void {
  if (typeof pi.registerMessageRenderer !== "function") return;

  pi.registerMessageRenderer("rp:event", (message, options, theme) => {
    const details = (message.details ?? {}) as { kind?: string; title?: string; subtitle?: string };
    const tag =
      details.kind === "roll"
        ? "CHECK"
        : details.kind === "recap"
          ? "RECAP"
          : details.kind === "xray"
            ? "X-RAY"
            : "EVENT";
    const title =
      details.title ||
      (details.kind === "roll"
        ? "掷骰判定"
        : details.kind === "recap"
          ? "前情提要"
          : details.kind === "xray"
            ? "上下文 X-Ray 透视"
            : "世界事件");
    const text = extractMessageText(message);
    return createLinesComponent((width) =>
      renderEditorialCard({
        tag,
        title,
        subtitle: details.subtitle,
        body: text,
        accentColor:
          details.kind === "roll" || details.kind === "recap" || details.kind === "xray" ? "accent" : "muted",
        theme,
        width,
        maxLines: options?.expanded
          ? undefined
          : details.kind === "xray"
            ? 36
            : details.kind === "recap"
              ? 20
              : 10,
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

