/**
 * Mobile-First `/rp` command palette, streamlined quick launcher, and smart autocompletions (v5).
 * Keeps every core capability 1–2 taps away without duplicating `/rp panel` controls.
 */

import type { PiExtensionAPI, PiExtensionContext } from "../types.js";
import { listAllCardSummaries, listPresetIds } from "../storage/workspace-store.js";
import {
  type RpRuntimeHandle,
  actionAnalyzeCard,
  actionBanPhrases,
  actionExportNovel,
  actionExportWorldSave,
  actionImportWorldSave,
  actionInterlude,
  actionRewriteLast,
  actionSpotlight,
  actionStyleControl,
  actionToggleAntiGodmoding,
  actionBookmarkGoto,
  actionBookmarkSave,
  actionContinue,
  actionDirectorNote,
  actionExitRp,
  actionGenerateLoreEntry,
  actionGreeting,
  actionIdeas,
  actionImpersonate,
  actionImportFile,
  actionLoadCard,
  actionManageCast,
  actionManageLibrary,
  actionManualRoll,
  actionOoc,
  actionPersona,
  actionPreset,
  actionQuickReplies,
  actionRecap,
  actionReroll,
  actionSelectPacing,
  actionSetHud,
  actionSetSettlementMode,
  actionShowShortcuts,
  actionSidePrompt,
  actionSidecarModel,
  actionSkipMontage,
  actionSummarizeOldFloors,
  actionToggleHide,
  actionToggleRawPassthrough,
  actionUndoTx,
  actionXRay,
} from "./actions.js";
import { openRpDashboard, type DashboardRuntime } from "./dashboard.js";

const CARD_SUMMARY_CACHE_TTL_MS = 5000;
let cardSummaryCache: { cwd: string; ts: number; data: ReturnType<typeof listAllCardSummaries> } | null = null;

function getCachedCardSummaries(cwd: string): ReturnType<typeof listAllCardSummaries> {
  const now = Date.now();
  if (cardSummaryCache && cardSummaryCache.cwd === cwd && now - cardSummaryCache.ts < CARD_SUMMARY_CACHE_TTL_MS) {
    return cardSummaryCache.data;
  }
  const data = listAllCardSummaries(cwd);
  cardSummaryCache = { cwd, ts: now, data };
  return data;
}

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "import", description: "导入角色卡 / 世界书 / 预设（支持批量）" },
  { value: "load", description: "从角色库加载角色卡（仅绑定当前会话）" },
  { value: "panel", description: "打开世界面板（加 tui 启用桌面终端浮窗）" },
  { value: "qr", description: "快捷回复与常用动作宏" },
  { value: "xray", description: "上下文透视：占用统计、缓存命中与世界书召回" },
  { value: "undo", description: "查看状态变更记录并一键撤销误改" },
  { value: "books", description: "打开记忆书与世界书管理" },
  { value: "storylets", description: "管理条件触发动态剧情卡与场景目标" },
  { value: "scene", description: "打开场景与世界管理" },
  { value: "sidecar", description: "配置后台专职模型（结算/归档/建档）" },
  { value: "monologue", description: "开关角色内心独白 (<thought>) 引文块" },
  { value: "godmode", description: "开关防抢戏守卫（严禁角色代演玩家）" },
  { value: "export-save", description: "导出当前世界状态快照 (.rp-save.json)" },
  { value: "import-save", description: "导入世界状态快照 (.rp-save.json)" },
  { value: "library", description: "管理并清理已导入的角色卡、预设与马甲" },
  { value: "imp", description: "以玩家视角帮我代写一段回复并填入输入框" },
  { value: "ask", description: "零污染场外提问，不写入对话历史" },
  { value: "rewrite", description: "局部定向改写上一条回复（非破坏性替换）" },
  { value: "style", description: "切换回复篇幅（精炼/标准/长篇）与叙事视角" },
  { value: "ban", description: "管理本局反 AI 套话禁词表" },
  { value: "spotlight", description: "群像镜头切换：指定下一轮主导 NPC" },
  { value: "interlude", description: "零污染幕后插叙 / 番外小剧场" },
  { value: "export", description: "导出当前分支为纯净 Markdown 小说" },
  { value: "reroll", description: "重摇上一条回复（支持定向微调预设）" },
  { value: "continue", description: "让角色无缝续写剧情" },
  { value: "act", description: "生成 3 个符合当下情境的行动建议" },
  { value: "recap", description: "即时生成前情提要与当前局势摘要" },
  { value: "summarize", description: "将较早楼层归档为记忆书章节并隐藏" },
  { value: "loregen", description: "从最近对话一键生成世界书条目" },
  { value: "analyze", description: "一键 AI 深度建档（提取初态与防剧透门禁）" },
  { value: "note", description: "管理导演指令" },
  { value: "pace", description: "切换叙事节奏 (relaxed / balanced / dramatic)" },
  { value: "skip", description: "切场景 / 跳时间" },
  { value: "ooc", description: "发起场外 OOC 讨论（也可直接输入 ((内容))）" },
  { value: "roll", description: "快捷掷骰检定器，支持优势/劣势/DC" },
  { value: "save", description: "保存剧情书签" },
  { value: "goto", description: "跳转或分叉至已保存的剧情书签" },
  { value: "hide", description: "隐藏对话楼层（不发给模型，不删记录）" },
  { value: "unhide", description: "恢复已隐藏的对话楼层" },
  { value: "persona", description: "切换或新建玩家马甲" },
  { value: "greet", description: "切换或重发角色开场白" },
  { value: "cast", description: "管理多角色同场共演" },
  { value: "preset", description: "加载或关闭酒馆预设" },
  { value: "hud", description: "切换 HUD 显示模式 (minimal / full / off)" },
  { value: "mode", description: "切换后台结算模式 (tool-assisted / sidecar-light / off)" },
  { value: "raw", description: "切换原味直通模式（跳过酒馆前端壳剥离）" },
  { value: "keys", description: "查看 9 项核心 RP 快捷键速查表" },
  { value: "exit", description: "彻底退出当前会话 RP 模式" },
];

export function makeDashboardRuntime(rt: RpRuntimeHandle): DashboardRuntime {
  return {
    getState: () => rt.getState(),
    getCard: () => rt.getCard(),
    getExtraCastCards: () => rt.getExtraCastCards(),
    getLastXRay: () => rt.getLastXRay(),
    commitTx: (tx) => rt.commitTx(tx),
    reloadRuntime: (ctx) => rt.reloadRuntime(ctx),
    refreshHud: (ctx) => rt.refreshHud(ctx),
    exitRp: (ctx, askConfirm) => actionExitRp(rt, ctx, askConfirm),
    skipScene: (ctx) => actionSkipMontage(rt, ctx, ""),
    recapStory: (ctx) => actionRecap(rt, ctx),
    summarizeOldFloors: (ctx) => actionSummarizeOldFloors(rt, ctx, ""),
    generateLoreEntry: (ctx) => actionGenerateLoreEntry(rt, ctx, ""),
    analyzeCard: (ctx) => actionAnalyzeCard(rt, ctx),
    switchPersona: (ctx) => actionPersona(rt, ctx, ""),
    manageCast: (ctx) => actionManageCast(rt, ctx, ""),
    quickRoll: (ctx) => actionManualRoll(rt, ctx, ""),
    openXRay: (ctx) => actionXRay(rt, ctx),
    undoLast: (ctx, autoLast) => actionUndoTx(rt, ctx, autoLast),
    openQuickReplies: (ctx) => actionQuickReplies(rt, ctx, ""),
    pickSidecarModel: (ctx) => actionSidecarModel(rt, ctx, ""),
    manageLibrary: (ctx) => actionManageLibrary(rt, ctx),
    rewriteLast: (ctx) => actionRewriteLast(rt, ctx, ""),
    styleControl: (ctx) => actionStyleControl(rt, ctx, ""),
    banPhrases: (ctx) => actionBanPhrases(rt, ctx, ""),
    spotlightNpc: (ctx) => actionSpotlight(rt, ctx, ""),
    interludeScene: (ctx) => actionInterlude(rt, ctx, ""),
    exportNovel: (ctx) => actionExportNovel(rt, ctx, ""),
    toggleHide: (ctx) => actionToggleHide(rt, ctx, "", true),
    toggleAntiGodmoding: (ctx) => actionToggleAntiGodmoding(rt, ctx),
      setSettlementMode: (c) => actionSetSettlementMode(rt, c, ""),
    exportWorldSave: (ctx) => actionExportWorldSave(rt, ctx, ""),
    importWorldSave: (ctx) => actionImportWorldSave(rt, ctx, ""),
  };
}

/** Open the context-aware `/rp` main menu (Dormant Launcher vs Active RP Control Center). */
export async function openRpMenu(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const state = rt.getState();

    if (!state.active) {
      const cards = listAllCardSummaries(ctx.cwd);
      const pick = await ctx.ui.select("🎭 RP 引擎启动器（仅当前会话）", [
        `🎭 加载已有角色卡（共 ${cards.length} 张）`,
        "📥 导入角色卡 / 世界书 / 预设",
        "🗂 资产库管理（卡 / 预设 / 马甲）",
        "✕ 关闭",
      ]);
      if (!pick || pick.startsWith("✕")) return;
      if (pick.startsWith("🎭")) await actionLoadCard(rt, ctx, "");
      else if (pick.startsWith("📥")) await actionImportFile(rt, ctx, "");
      else if (pick.startsWith("🗂")) await actionManageLibrary(rt, ctx);
      return;
    }

    const card = rt.getCard();
    const title = `🎭 ${[card?.identity.name ?? state.cardSlug ?? "RP", state.location || state.era, `T${state.turn}`].filter(Boolean).join(" · ")}`;
    const pick = await ctx.ui.select(title, [
      "📊 打开世界面板（全功能总控）",
      "⚡ 快捷回复 · 代写 · 行动建议",
      "🔄 重摇 · 局部改写 · 无缝续写",
      "💭 场外提问 · 对话内 OOC",
      "⏳ 推演切场 · 镜头 · 插叙 · 书签",
      "🎭 换卡 · 开场白 · 导入 · 建档",
      "⚙ 快捷开关（HUD / 预设 / 结算）",
      "✕ 关闭",
    ]);
    if (!pick || pick.startsWith("✕")) return;

    if (pick.startsWith("📊")) {
      await openRpDashboard(makeDashboardRuntime(rt), ctx);
      return;
    }
    if (pick.startsWith("⚡")) {
      const sub = await ctx.ui.select("快捷回复与行动辅助", [
        "⚡ 快捷回复与动作宏",
        "✍️ 帮我代写主角回复",
        "💡 生成 3 个行动建议",
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("⚡")) await actionQuickReplies(rt, ctx, "");
      else if (sub.startsWith("✍️")) await actionImpersonate(rt, ctx, "");
      else if (sub.startsWith("💡")) await actionIdeas(rt, ctx);
      return;
    }
    if (pick.startsWith("🔄")) {
      const sub = await ctx.ui.select("重摇、改写与续写", [
        "🔄 重摇上一条回复",
        "✂️ 局部定向改写",
        "▶ 让角色无缝续写",
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("🔄")) await actionReroll(rt, ctx, "");
      else if (sub.startsWith("✂️")) await actionRewriteLast(rt, ctx, "");
      else if (sub.startsWith("▶")) await actionContinue(rt, ctx);
      return;
    }
    if (pick.startsWith("💭")) {
      const sub = await ctx.ui.select("场外提问与 OOC", [
        "💭 零污染场外提问（不进历史）",
        "💬 对话内 OOC（用完自动隐身）",
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("💭")) await actionSidePrompt(rt, ctx, "");
      else if (sub.startsWith("💬")) await actionOoc(rt, ctx, "");
      return;
    }
    if (pick.startsWith("⏳")) {
      const sub = await ctx.ui.select("场景推演、镜头与书签", [
        "⏳ 幕间推演 / 切场景",
        "🔦 镜头聚焦主导 NPC",
        "🎞 幕后插叙 / 小剧场",
        "🔖 保存当前节点书签",
        "⏪ 跳转或分叉至书签",
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("⏳")) await actionSkipMontage(rt, ctx, "");
      else if (sub.startsWith("🔦")) await actionSpotlight(rt, ctx, "");
      else if (sub.startsWith("🎞")) await actionInterlude(rt, ctx, "");
      else if (sub.startsWith("🔖")) await actionBookmarkSave(rt, ctx, "");
      else if (sub.startsWith("⏪")) await actionBookmarkGoto(rt, ctx, "");
      return;
    }
    if (pick.startsWith("🎭")) {
      const sub = await ctx.ui.select("角色卡、开场白与导入", [
        "✨ 一键 AI 深度建档",
        "💬 重发 / 切换开场白",
        "🎭 切换其他主角色卡",
        "📥 导入新卡 / 世界书 / 预设",
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("✨")) await actionAnalyzeCard(rt, ctx);
      else if (sub.startsWith("💬")) await actionGreeting(rt, ctx);
      else if (sub.startsWith("🎭")) await actionLoadCard(rt, ctx, "");
      else if (sub.startsWith("📥")) await actionImportFile(rt, ctx, "");
      return;
    }
    if (pick.startsWith("⚙")) {
      const hudZh = state.hudMode === "off" ? "关" : state.hudMode === "full" ? "完整" : "精简";
      const settleZh = state.settlementMode === "sidecar-light" ? "后台小模型" : state.settlementMode === "off" ? "纯文学关闭" : "主模型随行";
      const sub = await ctx.ui.select("快捷开关", [
        `🖥 切换状态显示（${hudZh}）`,
        `🎛 切换预设（${state.presetId ?? "无"}）`,
        `⚙️ 记账模式（${settleZh}）`,
        `🛡 原味直通（${state.rawPassthrough ? "开" : "关"}）`,
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("🖥")) await actionSetHud(rt, ctx, "");
      else if (sub.startsWith("🎛")) await actionPreset(rt, ctx, "");
      else if (sub.startsWith("⚙️")) await actionSetSettlementMode(rt, ctx, "");
      else if (sub.startsWith("🛡")) await actionToggleRawPassthrough(rt, ctx, "");
      return;
    }
    return;
  }
}

export function registerRpCommands(pi: PiExtensionAPI, rt: RpRuntimeHandle): void {
  pi.registerCommand("rp", {
    description: "角色扮演引擎控制台（仅当前会话生效，输入 /rp 打开菜单）",
    getArgumentCompletions(prefix: string) {
      const lower = prefix.trimStart().toLowerCase();
      if (!lower.includes(" ")) {
        return SUBCOMMANDS.filter((c) => c.value.startsWith(lower)).map((c) => ({
          value: c.value,
          label: c.value,
          description: c.description,
        }));
      }
      const [sub, ...restParts] = lower.split(/\s+/);
      const rest = restParts.join(" ");
      if (sub === "panel") {
        return ["tui"]
          .filter((m) => m.startsWith(rest))
          .map((m) => ({ value: `panel ${m}`, label: m, description: "打开桌面终端浮窗面板" }));
      }
      if (sub === "load") {
        const cards = getCachedCardSummaries(process.cwd());
        return cards
          .filter((c) => c.slug.toLowerCase().includes(rest) || c.name.toLowerCase().includes(rest))
          .map((c) => ({ value: `load ${c.slug}`, label: c.name, description: `${c.source} · ${c.specOrigin}` }));
      }
      if (sub === "preset") {
        const ids = ["off", ...listPresetIds(process.cwd())];
        return ids.filter((id) => id.toLowerCase().includes(rest)).map((id) => ({ value: `preset ${id}`, label: id }));
      }
      if (sub === "hud") {
        return ["minimal", "full", "off"]
          .filter((m) => m.startsWith(rest))
          .map((m) => ({ value: `hud ${m}`, label: m }));
      }
      if (sub === "pace") {
        return ["relaxed", "balanced", "dramatic"]
          .filter((m) => m.startsWith(rest))
          .map((m) => ({ value: `pace ${m}`, label: m }));
      }
      if (sub === "mode") {
        return ["tool-assisted", "sidecar-light", "off"]
          .filter((m) => m.startsWith(rest))
          .map((m) => ({ value: `mode ${m}`, label: m }));
      }
      if (sub === "monologue") {
        return ["on", "off"]
          .filter((m) => m.startsWith(rest))
          .map((m) => ({ value: `monologue ${m}`, label: m }));
      }
      return null;
    },
    async handler(args: string, ctx: PiExtensionContext) {
      const trimmed = args.trim();
      if (!trimmed) {
        await openRpMenu(rt, ctx);
        return;
      }

      const spIdx = trimmed.indexOf(" ");
      const sub = (spIdx === -1 ? trimmed : trimmed.slice(0, spIdx)).toLowerCase();
      const rest = spIdx === -1 ? "" : trimmed.slice(spIdx + 1).trim();

      switch (sub) {
        case "import":
          await actionImportFile(rt, ctx, rest);
          return;
        case "load":
          await actionLoadCard(rt, ctx, rest);
          return;
        case "analyze":
          await actionAnalyzeCard(rt, ctx);
          return;
        case "panel":
        case "info":
        case "stats":
        case "report": {
          const preferTui = rest.trim().toLowerCase() === "tui";
          await openRpDashboard(makeDashboardRuntime(rt), ctx, 0, preferTui);
          return;
        }
        case "books":
        case "memory": {
          const preferTui = rest.trim().toLowerCase() === "tui";
          await openRpDashboard(makeDashboardRuntime(rt), ctx, preferTui ? 2 : 3, preferTui);
          return;
        }
        case "storylets":
        case "scene": {
          const preferTui = rest.trim().toLowerCase() === "tui";
          await openRpDashboard(makeDashboardRuntime(rt), ctx, preferTui ? 0 : 1, preferTui);
          return;
        }
        case "export-save":
          await actionExportWorldSave(rt, ctx, rest);
          return;
        case "import-save":
          await actionImportWorldSave(rt, ctx, rest);
          return;
        case "godmode":
          await actionToggleAntiGodmoding(rt, ctx);
          return;
        case "qr":
        case "quick":
          await actionQuickReplies(rt, ctx, rest);
          return;
        case "xray":
        case "inspect":
          await actionXRay(rt, ctx);
          return;
        case "undo":
          await actionUndoTx(rt, ctx, rest === "last" || rest === "1");
          return;
        case "sidecar":
          await actionSidecarModel(rt, ctx, rest);
          return;
        case "library":
        case "lib":
          await actionManageLibrary(rt, ctx);
          return;
        case "monologue": {
          const st = rt.getState();
          if (!st.active) {
            ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
            return;
          }
          const next = rest === "on" ? true : rest === "off" ? false : !st.innerMonologue;
          rt.commitTx({ kind: "config_patch", innerMonologue: next });
          rt.refreshHud(ctx);
          ctx.ui.notify(`角色内心独白 (<thought>) 已${next ? "开启" : "关闭"}`, "info");
          return;
        }
        case "imp":
        case "impersonate":
          await actionImpersonate(rt, ctx, rest);
          return;
        case "ask":
        case "side":
          await actionSidePrompt(rt, ctx, rest);
          return;
        case "summarize":
        case "archive":
          await actionSummarizeOldFloors(rt, ctx, rest);
          return;
        case "loregen":
        case "lore-add":
          await actionGenerateLoreEntry(rt, ctx, rest);
          return;
        case "rewrite":
          await actionRewriteLast(rt, ctx, rest);
          return;
        case "style":
        case "pov":
        case "len":
          await actionStyleControl(rt, ctx, rest);
          return;
        case "ban":
        case "slop":
          await actionBanPhrases(rt, ctx, rest);
          return;
        case "spotlight":
        case "focus":
          await actionSpotlight(rt, ctx, rest);
          return;
        case "interlude":
        case "theater":
          await actionInterlude(rt, ctx, rest);
          return;
        case "export":
        case "novel":
          await actionExportNovel(rt, ctx, rest);
          return;
        case "reroll":
        case "swipe":
        case "retry":
          await actionReroll(rt, ctx, rest);
          return;
        case "recap":
        case "summary":
          await actionRecap(rt, ctx);
          return;
        case "c":
        case "continue":
          await actionContinue(rt, ctx);
          return;
        case "act":
        case "ideas":
          await actionIdeas(rt, ctx);
          return;
        case "note":
          await actionDirectorNote(rt, ctx, rest);
          return;
        case "ooc":
          await actionOoc(rt, ctx, rest);
          return;
        case "persona":
          await actionPersona(rt, ctx, rest);
          return;
        case "greet":
          await actionGreeting(rt, ctx);
          return;
        case "preset":
          await actionPreset(rt, ctx, rest);
          return;
        case "save":
          await actionBookmarkSave(rt, ctx, rest);
          return;
        case "goto":
          await actionBookmarkGoto(rt, ctx, rest);
          return;
        case "hide":
          await actionToggleHide(rt, ctx, rest, true);
          return;
        case "unhide":
          await actionToggleHide(rt, ctx, rest, false);
          return;
        case "roll":
          await actionManualRoll(rt, ctx, rest);
          return;
        case "skip":
        case "montage":
          await actionSkipMontage(rt, ctx, rest);
          return;
        case "cast":
          await actionManageCast(rt, ctx, rest);
          return;
        case "pace":
        case "pacing":
          await actionSelectPacing(rt, ctx, rest);
          return;
        case "hud":
          await actionSetHud(rt, ctx, rest);
          return;
        case "mode":
          await actionSetSettlementMode(rt, ctx, rest);
          return;
        case "raw":
          await actionToggleRawPassthrough(rt, ctx, rest);
          return;
        case "keys":
        case "hotkeys":
        case "shortcuts":
          await actionShowShortcuts(ctx);
          return;
        case "exit":
        case "off":
        case "quit":
        case "leave":
          await actionExitRp(rt, ctx, false);
          return;
        default:
          ctx.ui.notify(`未知子命令：${sub}。输入 /rp 打开交互菜单。`, "warning");
      }
    },
  });
}
