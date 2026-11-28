/**
 * True Tabbed Interactive TUI Overlay Dashboard (v4) using Official Pi SDK `ctx.ui.custom(..., { overlay: true })`.
 *
 * Smart Context-Adaptive Design:
 *  - Shows what actually matters for THIS card on the right tab:
 *    - Tab 1 (场景): location, time, objective, live Storylets, clocks (only when active/enabled), narrative health
 *    - Tab 2 (人物): persona, co-cast, CFSM, actor-grouped bipolar-aware stats, inventory (promoted here when active!), DualMem beliefs
 *    - Tab 3 (记忆): Memory Books, Recap, Summarize-to-Book, Bi-Temporal Facts, 🔒 Epistemic Blind Spots/Secrets, Foresights
 *    - Tab 4 (世界书): full Lorebook manager + AI loregen + live entry badges
 *    - Tab 5 (导演): pacing, Author's Note, Inner Monologue, Quick Replies, ✨ One-Click AI Deep Analysis status
 *    - Tab 6 (X-Ray): True 3-Layer KV-Cache (Tools + Zone1 + Zone2 prefix), token distribution, recall traces, narrative health, Audit & Undo
 *    - Tab 7 (设置): RPG/Modules, Sidecar model, lore budget, preset sampling, asset library, overview, exit
 */

import type {
  CompiledCard,
  CompiledLoreEntry,
  ContextXRaySnapshot,
  PiExtensionContext,
  PiKeybindingsLike,
  PiTuiLike,
  SessionRpState,
} from "../types.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import { evaluateGate, partitionEpistemicFacts } from "../engine/gates.js";
import { evaluateActiveStorylets } from "../context/zone-builder.js";
import {
  displayWidth,
  renderProgressBar,
  renderSmartStatBar,
  styleBold,
  styleDim,
  styleFg,
  truncateDisplayLine,
} from "./renderers.js";

export type OverlayTabIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type OverlayAction =
  | { kind: "close"; tab: OverlayTabIndex }
  | { kind: "undo_last"; tab: OverlayTabIndex }
  | { kind: "open_section"; tab: OverlayTabIndex; actionKey: string };

export interface OverlayRow {
  label: string;
  actionKey: string;
  detail?: string;
}

export interface OverlayController {
  getTab(): OverlayTabIndex;
  getSelectedIndex(): number;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

const TAB_TITLES: ReadonlyArray<string> = [
  "1场景",
  "2人物",
  "3记忆",
  "4世界书",
  "5导演",
  "6X-Ray",
  "7设置",
];

function formatCacheReason(reason?: ContextXRaySnapshot["cacheInvalidationReason"]): string {
  switch (reason) {
    case "prefix_hit":
      return "三层全命中";
    case "first_turn":
      return "首轮建立";
    case "tools_changed":
      return "⚠工具表变更";
    case "zone1_changed":
      return "⚠Zone1变更";
    case "history_mutated":
      return "⚠历史前缀变更";
    default:
      return "已监控";
  }
}

function buildRowsForTab(
  tab: OverlayTabIndex,
  state: SessionRpState,
  card: CompiledCard | null,
  allLore: CompiledLoreEntry[],
  xray: ContextXRaySnapshot | null,
): OverlayRow[] {
  switch (tab) {
    case 0: {
      const activeStorylets = evaluateActiveStorylets(state);
      const clocks = Object.values(state.clocks);
      const rows: OverlayRow[] = [
        {
          label: `📍 地点与在场：${state.location || "(未设定)"}${state.presentNpcs.length ? ` · ${state.presentNpcs.join("、")}` : ""}`,
          actionKey: "scene:location",
        },
        {
          label: `🕒 世界时间：${state.worldTimeLabel || "(未设定)"} · 第 ${state.turn} 轮${state.era ? ` · ${state.era}` : ""}`,
          actionKey: "scene:time",
        },
        {
          label: `🎯 场景目标：${state.sceneObjective || "(未设定 — 按 Enter 设定)"}`,
          actionKey: "scene:objective",
        },
        {
          label: `🃏 动态剧情卡 Storylets：${state.storylets.size} 张（当前触发 ${activeStorylets.length} 张${
            activeStorylets.length > 0 ? `：${activeStorylets.slice(0, 2).map((s) => s.title).join(" / ")}` : ""
          }）`,
          actionKey: "scene:storylets",
        },
        {
          label: `⏳ 切场景 / 跳时间蒙太奇 (Alt+T)`,
          actionKey: "scene:skip",
        },
      ];
      // Smart adaptive: only display clocks on Tab 1 when clocks module is on or clocks exist
      if (state.modules.clocks || clocks.length > 0) {
        if (clocks.length === 0) {
          rows.push({ label: `⏱ 进度时钟：暂无（Enter 新建倒计时/紧张度时钟）`, actionKey: "rpg:clocks" });
        } else {
          for (const c of clocks.slice(0, 4)) {
            rows.push({
              label: `⏱ 时钟 ${c.label}  ${renderProgressBar(c.value, c.max, 6)}  ${c.value}/${c.max}${c.completed ? " ✓" : ""}`,
              actionKey: "rpg:clocks",
            });
          }
        }
      }
      // Narrative health summary row
      if (xray) {
        const repPct = Math.round((xray.repetitionScore ?? 0) * 100);
        const stag = xray.stagnantTurns ?? 0;
        const healthText =
          repPct >= 42
            ? `⚠ 检测到复读倾向 (${repPct}%) · 已自动注入去重引导`
            : stag >= 4
              ? `⚠ 剧情已停滞 ${stag} 轮 · 可调节奏或触发剧情卡`
              : `🟢 叙事健康（复读率 ${repPct}% · 距上次世界推进 ${stag} 轮）`;
        rows.push({ label: healthText, actionKey: "xray:full" });
      }
      return rows;
    }
    case 1: {
      const cfsmRows: OverlayRow[] = [];
      for (const [actor, axes] of Object.entries(state.cfsmStates)) {
        for (const [axis, rec] of Object.entries(axes)) {
          cfsmRows.push({
            label: `  💭 ${actor} · ${axis} = ${rec.state}`,
            actionKey: "char:cfsm",
          });
        }
      }
      const statRows: OverlayRow[] = [];
      for (const [actor, rec] of Object.entries(state.stats)) {
        for (const [k, v] of Object.entries(rec)) {
          const b = state.statBounds[actor]?.[k];
          const smartBar = typeof v === "number" && b ? renderSmartStatBar(v, b.min, b.max, 5) : null;
          const displayVal = smartBar ? ` ${smartBar}` : ` = ${String(v)}`;
          statRows.push({ label: `  📊 ${actor} · ${k}${displayVal}`, actionKey: "char:stats" });
        }
      }
      const invEntries: string[] = [];
      for (const [actor, bag] of Object.entries(state.inventory)) {
        for (const [item, qty] of Object.entries(bag)) {
          invEntries.push(actor === "player" ? `${item}×${qty}` : `${actor}:${item}×${qty}`);
        }
      }
      const rows: OverlayRow[] = [
        { label: `🧑 玩家马甲：${state.currentPersona.name}（Enter 切换）`, actionKey: "char:persona" },
        { label: `👥 同场共演：${state.activeCharacters.length} 张角色卡`, actionKey: "char:cast" },
        { label: `💭 角色态度/情绪阶段 CFSM（${cfsmRows.length} 项 — 进入管理）`, actionKey: "char:cfsm" },
        ...cfsmRows.slice(0, 3),
        { label: `📊 角色数值与变量（${statRows.length} 项 — 支持负值与分角色编辑）`, actionKey: "char:stats" },
        ...statRows.slice(0, 4),
      ];
      // Smart promotion: show inventory directly on Characters tab whenever active or non-empty!
      if (state.modules.inventory || invEntries.length > 0) {
        const preview = invEntries.length > 0 ? invEntries.slice(0, 3).join(" · ") : "空";
        rows.push({
          label: `🎒 随身物品与装备（${invEntries.length} 项：${preview}）`,
          actionKey: "char:inventory",
        });
      }
      rows.push({
        label: `◇ DualMem 人物信念与潜台词（${state.beliefs.length} 条）`,
        actionKey: "char:beliefs",
      });
      return rows;
    }
    case 2: {
      const activeFacts = getActiveFacts(state);
      const secretFacts = activeFacts.filter((f) => f.witnessIds !== "public");
      const { blindSpots } = partitionEpistemicFacts(activeFacts, state.presentNpcs);
      const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open");
      const books = Array.from(state.memoryBooks.values());
      return [
        { label: `📚 记忆书章节 Memory Books（${books.length} 章 — 查看/编辑/置顶）`, actionKey: "mem:books" },
        { label: `📜 0-Token 前情提要 Recap`, actionKey: "mem:recap" },
        { label: `📦 总结并隐藏旧对话楼层 → 写入记忆书`, actionKey: "mem:summarize" },
        { label: `🧠 长期双时态事实（${activeFacts.length} 条 — 编辑/知情隔离/失效）`, actionKey: "mem:facts" },
        {
          label: `🔒 秘密与认知盲区 FANToM（秘密 ${secretFacts.length} 条 · 当前生效盲区 ${blindSpots.length} 处）`,
          actionKey: "mem:secrets",
        },
        { label: `◇ 未完约定与伏笔（${openHooks.length} 条）`, actionKey: "mem:hooks" },
        ...books.slice(-3).reverse().map((b) => ({
          label: `  📖 [${b.pinned ? "📌" : b.enabled ? "●" : "○"}] ${b.title} (T${b.turnRange[0]}-T${b.turnRange[1]})`,
          actionKey: "mem:books",
        })),
      ];
    }
    case 3: {
      const enabledCount = allLore.filter((e) => state.loreOverrides[e.id] ?? e.enabled).length;
      const rows: OverlayRow[] = [
        { label: `📚 进入世界书完整管理器（启用 ${enabledCount}/${allLore.length} · 搜索/编辑/新增/删除）`, actionKey: "lore:manage" },
        { label: `✨ 从最近剧情 AI 生成新世界书条目 (/rp loregen)`, actionKey: "lore:gen" },
      ];
      for (const e of allLore.slice(0, 9)) {
        const on = state.loreOverrides[e.id] ?? e.enabled;
        const gated = !evaluateGate(e.gate, state) ? " [门禁]" : "";
        const sticky = state.loreSticky[e.id] ? ` [粘滞:${state.loreSticky[e.id]}]` : "";
        rows.push({
          label: `  ${on ? "●" : "○"} [${e.constant ? "常驻" : "动态"}] ${e.title}${sticky}${gated}`,
          actionKey: "lore:manage",
        });
      }
      return rows;
    }
    case 4: {
      const profileSrc = card?.worldProfile?.source === "llm-analyzed"
        ? "已深度建档（7维永久缓存，可重跑）"
        : "启发式初态（推荐纯文字卡运行一次 7 维提取）";
      return [
        { label: `🎚 叙事节奏：${state.pacingMode}（Enter 切换）`, actionKey: "dir:pacing" },
        { label: `📝 导演指令 Author's Note（当前 ${state.notes.length} 条）`, actionKey: "dir:notes" },
        { label: `💭 角色内心独白 (<thought>)：${state.innerMonologue ? "● 已开启" : "○ 已关闭"}`, actionKey: "dir:monologue" },
        { label: `⚡ 快捷回复 / 常用动作宏 (Alt+E)`, actionKey: "dir:qr" },
        { label: `✨ 一键 AI 深度建档 (/rp analyze)：${profileSrc}`, actionKey: "dir:analyze" },
        ...state.notes.slice(0, 4).map((n, i) => ({
          label: `  ▪ #${i + 1} ${n.text.slice(0, 48)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
          actionKey: "dir:notes",
        })),
      ];
    }
    case 5: {
      const rows: OverlayRow[] = [];
      if (xray) {
        const kvStatus = formatCacheReason(xray.cacheInvalidationReason);
        const z2Flag = xray.zone2PrefixMatch === false ? "✗前缀断开" : "✓连续";
        rows.push({
          label: `⚡ 三层 KV-Cache：${kvStatus} · 连击 ×${xray.cacheHitStreak} · Z2:${z2Flag}`,
          actionKey: "xray:full",
        });
        rows.push({
          label: `🔑 Hash  Tools:${xray.toolsHash ?? "—"} · Zone1:${xray.zone1Hash}`,
          actionKey: "xray:full",
        });
        rows.push({
          label: `📊 预算  Z1=${xray.zone1Tokens}t · Z2=${xray.zone2Tokens}t · Z3=${xray.zone3Tokens}t · 书=${xray.loreTokens}/${xray.loreBudget}t`,
          actionKey: "xray:full",
        });
        rows.push({
          label: `🔎 命中 ${xray.recalled.length} · 门禁 ${xray.gatedOut.length} · 裁切 ${xray.budgetDropped.length} · 盲区 ${xray.blindSpotCount} · 复读 ${Math.round((xray.repetitionScore ?? 0) * 100)}%`,
          actionKey: "xray:full",
        });
        for (const item of xray.recalled.slice(0, 3)) {
          rows.push({
            label: `  ✦ [${item.reason}] ${item.title}${item.matchedKey ? ` (${item.matchedKey})` : ""} · ${item.tokens}t`,
            actionKey: "xray:full",
          });
        }
      } else {
        rows.push({
          label: "🔎 尚无本回合上下文快照（发送一轮对话后即可透视三层 KV-Cache 与召回原因）",
          actionKey: "xray:full",
        });
      }
      const undoable = state.auditLog.filter((r) => Boolean(r.undoTx)).length;
      rows.push({
        label: `↩ 状态变更审计与一键撤销（共 ${state.auditLog.length} 条，可撤销 ${undoable} 条 · 按 u 撤销最近一条）`,
        actionKey: "xray:undo",
      });
      return rows;
    }
    case 6: {
      const invCount = Object.values(state.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
      return [
        { label: `🎒 背包 (${invCount}) · 时钟 (${Object.keys(state.clocks).length}) · Flags · 掷骰 · 模块开关`, actionKey: "set:rpg" },
        { label: `🤖 Sidecar 后台专职模型：${state.sidecarModel || "跟随主对话模型"}`, actionKey: "set:sidecar" },
        { label: `📏 动态世界书 Token 预算：${state.loreTokenBudget} tokens`, actionKey: "set:budget" },
        { label: `🎛 应用预设采样参数 (before_provider_request)：${state.applyPresetSampling ? "● 开启" : "○ 关闭"}`, actionKey: "set:sampling" },
        { label: `🗂 资产库管理（删除角色卡 / 预设 / 玩家马甲）`, actionKey: "set:library" },
        { label: `🌍 会话总览、导入审计与快捷键速查（${card?.identity.name ?? state.cardSlug ?? "RP"}）`, actionKey: "set:overview" },
        { label: `🚪 彻底退出本会话 RP 模式 (Alt+Shift+X)`, actionKey: "set:exit" },
      ];
    }
  }
}

export function createRpOverlayController(options: {
  state: SessionRpState;
  card: CompiledCard | null;
  allLore: CompiledLoreEntry[];
  xray: ContextXRaySnapshot | null;
  initialTab?: OverlayTabIndex;
  tui?: PiTuiLike;
  theme?: unknown;
  keybindings?: PiKeybindingsLike;
  done: (result?: OverlayAction) => void;
}): OverlayController {
  let tab: OverlayTabIndex = options.initialTab ?? 0;
  let selectedIdx = 0;

  const getRows = () => buildRowsForTab(tab, options.state, options.card, options.allLore, options.xray);

  const clampSelection = (rows: OverlayRow[]) => {
    if (rows.length === 0) selectedIdx = 0;
    else if (selectedIdx >= rows.length) selectedIdx = rows.length - 1;
    else if (selectedIdx < 0) selectedIdx = 0;
  };

  return {
    getTab: () => tab,
    getSelectedIndex: () => selectedIdx,
    invalidate(): void {
      // Pure render from latest state snapshot
    },
    render(width: number): string[] {
      const boxW = Math.max(42, Math.min(Number.isFinite(width) && width > 10 ? Math.floor(width) : 80, 96));
      const innerW = boxW - 4;
      const rows = getRows();
      clampSelection(rows);

      const charName = options.card
        ? options.card.identity.nickname || options.card.identity.name
        : options.state.cardSlug ?? "RP";
      const headerMeta = [charName, options.state.era, options.state.worldTimeLabel, `T${options.state.turn}`]
        .filter(Boolean)
        .join(" · ");

      const padLine = (plainText: string, styledText?: string): string => {
        const clampedPlain = truncateDisplayLine(plainText, innerW);
        const pad = Math.max(0, innerW - displayWidth(clampedPlain));
        const content = styledText ?? clampedPlain;
        return `${styleFg(options.theme, "accent", "│")} ${content}${" ".repeat(pad)} ${styleFg(options.theme, "accent", "│")}`;
      };

      const topRule = styleFg(options.theme, "accent", `╭${"─".repeat(boxW - 2)}╮`);
      const midRule = styleFg(options.theme, "accent", `├${"─".repeat(boxW - 2)}┤`);
      const botRule = styleFg(options.theme, "accent", `╰${"─".repeat(boxW - 2)}╯`);

      // Tab bar
      const tabPlainParts = TAB_TITLES.map((t, i) => (i === tab ? `[${t}]` : ` ${t} `));
      const tabBarPlain = tabPlainParts.join(" ");
      const tabBarStyled = TAB_TITLES.map((t, i) =>
        i === tab ? styleBold(options.theme, styleFg(options.theme, "accent", `[${t}]`)) : styleDim(options.theme, ` ${t} `),
      ).join(" ");

      const lines: string[] = [
        topRule,
        padLine(`◆ RP 世界控制台 · ${headerMeta}`, styleBold(options.theme, truncateDisplayLine(`◆ RP 世界控制台 · ${headerMeta}`, innerW))),
        padLine(tabBarPlain, displayWidth(tabBarPlain) <= innerW ? tabBarStyled : truncateDisplayLine(tabBarPlain, innerW)),
        midRule,
      ];

      const maxVisible = 11;
      const start = Math.max(0, Math.min(selectedIdx - Math.floor(maxVisible / 2), Math.max(0, rows.length - maxVisible)));
      const slice = rows.slice(start, start + maxVisible);

      for (let i = 0; i < slice.length; i++) {
        const realIdx = start + i;
        const row = slice[i]!;
        const isSel = realIdx === selectedIdx;
        const prefix = isSel ? "▸ " : "  ";
        const plain = `${prefix}${row.label}`;
        const clamped = truncateDisplayLine(plain, innerW);
        const styled = isSel ? styleBold(options.theme, styleFg(options.theme, "accent", clamped)) : clamped;
        lines.push(padLine(clamped, styled));
      }

      if (rows.length > maxVisible) {
        const scrollHint = `  (${selectedIdx + 1}/${rows.length} · ↑↓ 滚动)`;
        lines.push(padLine(scrollHint, styleDim(options.theme, scrollHint)));
      }

      lines.push(midRule);
      const footer = "1-7/Tab 切页 · ↑↓/jk 移动 · Enter 打开 · u 撤销变更 · Esc/q 关闭";
      lines.push(padLine(footer, styleDim(options.theme, truncateDisplayLine(footer, innerW))));
      lines.push(botRule);

      return lines;
    },
    handleInput(data: string): void {
      if (!data) return;
      const rows = getRows();
      clampSelection(rows);

      if (
        data === "\x1b" ||
        data === "q" ||
        data === "Q" ||
        data === "\x03" ||
        options.keybindings?.matches?.(data, "tui.select.cancel") ||
        options.keybindings?.matches?.(data, "cancel")
      ) {
        options.done({ kind: "close", tab });
        return;
      }

      if (data >= "1" && data <= "7") {
        tab = (Number(data) - 1) as OverlayTabIndex;
        selectedIdx = 0;
        options.tui?.requestRender?.();
        return;
      }

      if (data === "\t" || data === "\x1b[C" || data === "l") {
        tab = ((tab + 1) % TAB_TITLES.length) as OverlayTabIndex;
        selectedIdx = 0;
        options.tui?.requestRender?.();
        return;
      }

      if (data === "\x1b[Z" || data === "\x1b[D" || data === "h") {
        tab = ((tab + TAB_TITLES.length - 1) % TAB_TITLES.length) as OverlayTabIndex;
        selectedIdx = 0;
        options.tui?.requestRender?.();
        return;
      }

      if (data === "\x1b[B" || data === "j") {
        if (rows.length > 0) selectedIdx = (selectedIdx + 1) % rows.length;
        options.tui?.requestRender?.();
        return;
      }

      if (data === "\x1b[A" || data === "k") {
        if (rows.length > 0) selectedIdx = (selectedIdx + rows.length - 1) % rows.length;
        options.tui?.requestRender?.();
        return;
      }

      if (data === "u" || data === "U") {
        options.done({ kind: "undo_last", tab });
        return;
      }

      if (
        data === "\r" ||
        data === "\n" ||
        options.keybindings?.matches?.(data, "tui.select.confirm") ||
        options.keybindings?.matches?.(data, "submit")
      ) {
        const chosen = rows[selectedIdx];
        if (chosen) {
          options.done({ kind: "open_section", tab, actionKey: chosen.actionKey });
        }
      }
    },
  };
}

/**
 * Open the interactive 7-tab TUI Overlay via official `ctx.ui.custom(..., { overlay: true })`.
 * Returns `undefined` when not in TUI mode (e.g. RPC/pi-android) so caller falls back cleanly.
 */
export async function openTuiOverlayDashboard(
  ctx: PiExtensionContext,
  options: {
    state: SessionRpState;
    card: CompiledCard | null;
    allLore: CompiledLoreEntry[];
    xray: ContextXRaySnapshot | null;
    initialTab?: OverlayTabIndex;
  },
): Promise<OverlayAction | undefined> {
  if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function") {
    return undefined;
  }
  return ctx.ui.custom<OverlayAction>(
    (tui, theme, keybindings, done) =>
      createRpOverlayController({
        state: options.state,
        card: options.card,
        allLore: options.allLore,
        xray: options.xray,
        initialTab: options.initialTab,
        tui,
        theme,
        keybindings,
        done,
      }),
    { overlay: true },
  );
}
