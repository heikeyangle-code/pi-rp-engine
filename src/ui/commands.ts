/**
 * Humanized `/rp` command palette, categorized quick launcher, and smart autocompletions.
 * Keeps every core capability 1-2 clicks away in both dormant and active RP sessions.
 */

import type { PiExtensionAPI, PiExtensionContext } from "../types.js";
import { listAllCardSummaries, listPresetIds } from "../storage/workspace-store.js";
import {
  type RpRuntimeHandle,
  actionAnalyzeCard,
  actionBookmarkGoto,
  actionBookmarkSave,
  actionContinue,
  actionDirectorNote,
  actionExitRp,
  actionGreeting,
  actionIdeas,
  actionImportFile,
  actionLoadCard,
  actionManageCast,
  actionManualRoll,
  actionOoc,
  actionPersona,
  actionPreset,
  actionRecap,
  actionReroll,
  actionSelectPacing,
  actionSetHud,
  actionSetSettlementMode,
  actionShowShortcuts,
  actionSkipMontage,
  actionToggleHide,
  actionToggleRawPassthrough,
} from "./actions.js";
import { openRpDashboard, type DashboardRuntime } from "./dashboard.js";

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "import", description: "打开文件浏览器导入角色卡 / 世界书 / 预设（支持批量）" },
  { value: "load", description: "从角色库加载角色卡（仅绑定当前会话）" },
  { value: "panel", description: "打开实时世界面板与状态/世界书编辑器 (Ctrl+Shift+R)" },
  { value: "analyze", description: "一键 AI 智能建档：识别卡型、初态、别名与防剧透门禁（永久缓存）" },
  { value: "reroll", description: "重摇上一条回复，旧分支保留在 /tree (Alt+W)" },
  { value: "continue", description: "让角色无缝续写剧情 (Alt+K)" },
  { value: "act", description: "生成 3 个符合当下情境的行动建议 (Alt+A)" },
  { value: "recap", description: "0 Token 瞬时合成前情提要与当前局势摘要" },
  { value: "roll", description: "打开快捷掷骰检定器，支持优势/劣势/DC (Alt+G)" },
  { value: "note", description: "管理导演指令 (Alt+N)" },
  { value: "ooc", description: "发起场外 OOC 讨论，不推进剧情 (Alt+O)" },
  { value: "pace", description: "切换叙事节奏 (relaxed / balanced / dramatic · Alt+P)" },
  { value: "save", description: "保存剧情书签 (Alt+B)" },
  { value: "goto", description: "跳转或分叉至已保存的剧情书签 (Alt+J)" },
  { value: "hide", description: "交互式隐藏对话楼层（不发给模型，不删记录）" },
  { value: "unhide", description: "恢复已隐藏的对话楼层" },
  { value: "persona", description: "切换或新建玩家人设（不破坏缓存）" },
  { value: "greet", description: "切换/重发角色开场白" },
  { value: "cast", description: "交互式管理多角色同场共演" },
  { value: "skip", description: "时间推进 / 幕间蒙太奇 (Alt+T)" },
  { value: "preset", description: "加载或关闭酒馆预设" },
  { value: "hud", description: "切换 HUD 显示模式 (minimal / full / off · Alt+H)" },
  { value: "mode", description: "切换后台结算模式 (tool-assisted / sidecar-light / off)" },
  { value: "raw", description: "切换原味直通模式（跳过酒馆前端壳剥离）" },
  { value: "keys", description: "查看全部 RP 快捷键速查表" },
  { value: "exit", description: "彻底退出当前会话 RP 模式，恢复编程助手 (Alt+Shift+X)" },
];

export function makeDashboardRuntime(rt: RpRuntimeHandle): DashboardRuntime {
  return {
    getState: () => rt.getState(),
    getCard: () => rt.getCard(),
    getExtraCastCards: () => rt.getExtraCastCards(),
    commitTx: (tx) => rt.commitTx(tx),
    refreshHud: (ctx) => rt.refreshHud(ctx),
    exitRp: (ctx, askConfirm) => actionExitRp(rt, ctx, askConfirm),
  };
}

/** Open the context-aware `/rp` main menu (Dormant Launcher vs Active RP Control Center). */
export async function openRpMenu(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();

  if (!state.active) {
    const cards = listAllCardSummaries(ctx.cwd);
    const pick = await ctx.ui.select("🎭 RP 引擎启动器（仅在当前会话生效，绝不影响其他会话）", [
      `🎭 加载已有角色卡（角色库共 ${cards.length} 张）`,
      "📥 浏览并导入角色卡 / 世界书 / 预设（自动识别 Downloads 与当前目录）",
      "⌨️ 查看快捷键速查表",
      "✕ 关闭",
    ]);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("🎭")) await actionLoadCard(rt, ctx, "");
    else if (pick.startsWith("📥")) await actionImportFile(rt, ctx, "");
    else if (pick.startsWith("⌨️")) await actionShowShortcuts(ctx);
    return;
  }

  const card = rt.getCard();
  const title = `🎭 ${[card?.identity.name ?? state.cardSlug ?? "RP", state.era, state.worldTimeLabel, `T${state.turn}`].filter(Boolean).join(" · ")}（Alt+R）`;
  const pick = await ctx.ui.select(title, [
    "📊 打开世界面板 & 实时状态/世界书编辑器 (Ctrl+Shift+R)",
    "🔄 重摇上一条回复 (Alt+W)  /  ▶ 续写 (Alt+K)  /  💡 行动建议 (Alt+A)",
    "📜 前情提要 · 0 Token 瞬时局势回顾 (/rp recap)",
    "🎲 快捷掷骰检定 (Alt+G)",
    "🎬 导演指令与叙事节奏 (Alt+N / Alt+P)",
    "💬 OOC 场外讨论 (Alt+O)",
    "🔖 剧情书签：保存 (Alt+B) / 跳转分叉 (Alt+J)",
    "⏳ 幕间蒙太奇 / 推进时间 (Alt+T)",
    "🙈 隐藏或恢复对话楼层 (/rp hide)",
    "🧑 切换玩家人设 / 👥 同场共演 / 🎭 切换角色或开场白",
    "🔍 一键 AI 智能建档（识别初态 / 物品 / 别名 / 防剧透门禁）",
    "📥 导入新的角色卡 / 世界书 / 预设",
    "⚙ 引擎设置（HUD / 预设 / 结算模式 / 原味直通 / 快捷键）",
    "🚪 彻底退出本会话 RP 模式 (Alt+Shift+X)",
    "✕ 关闭",
  ]);
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("📊")) {
    await openRpDashboard(makeDashboardRuntime(rt), ctx);
  } else if (pick.startsWith("🔄")) {
    const sub = await ctx.ui.select("剧情推进与重摇", [
      "🔄 重摇上一条回复 (Alt+W)",
      "▶ 无缝续写 (Alt+K)",
      "💡 生成 3 个行动建议 (Alt+A)",
      "← 返回",
    ]);
    if (sub?.startsWith("🔄")) await actionReroll(rt, ctx, "");
    else if (sub?.startsWith("▶")) await actionContinue(rt, ctx);
    else if (sub?.startsWith("💡")) await actionIdeas(rt, ctx);
  } else if (pick.startsWith("📜")) {
    await actionRecap(rt, ctx);
  } else if (pick.startsWith("🎲")) {
    await actionManualRoll(rt, ctx, "");
  } else if (pick.startsWith("🎬")) {
    const sub = await ctx.ui.select("导演台", [
      "📝 管理导演指令 (Alt+N)",
      "🎚 切换叙事节奏 (relaxed/balanced/dramatic · Alt+P)",
      "← 返回",
    ]);
    if (sub?.startsWith("📝")) await actionDirectorNote(rt, ctx, "");
    else if (sub?.startsWith("🎚")) await actionSelectPacing(rt, ctx, "");
  } else if (pick.startsWith("💬")) {
    await actionOoc(rt, ctx, "");
  } else if (pick.startsWith("🔖")) {
    const sub = await ctx.ui.select("剧情书签与时间线", [
      "🔖 保存当前节点为书签 (Alt+B)",
      "⏪ 跳转 / 分叉至已有书签 (Alt+J)",
      "← 返回",
    ]);
    if (sub?.startsWith("🔖")) await actionBookmarkSave(rt, ctx, "");
    else if (sub?.startsWith("⏪")) await actionBookmarkGoto(rt, ctx, "");
  } else if (pick.startsWith("⏳")) {
    await actionSkipMontage(rt, ctx, "");
  } else if (pick.startsWith("🙈")) {
    await actionToggleHide(rt, ctx, "", true);
  } else if (pick.startsWith("🧑")) {
    const sub = await ctx.ui.select("角色与人设", [
      "🧑 切换/新建玩家人设 (Persona)",
      "👥 管理同场共演角色卡 (Cast)",
      "💬 重发/切换开场白 (Greeting)",
      "🎭 切换其他主角色卡 (Load)",
      "← 返回",
    ]);
    if (sub?.startsWith("🧑")) await actionPersona(rt, ctx, "");
    else if (sub?.startsWith("👥")) await actionManageCast(rt, ctx, "");
    else if (sub?.startsWith("💬")) await actionGreeting(rt, ctx);
    else if (sub?.startsWith("🎭")) await actionLoadCard(rt, ctx, "");
  } else if (pick.startsWith("🔍")) {
    await actionAnalyzeCard(rt, ctx);
  } else if (pick.startsWith("📥")) {
    await actionImportFile(rt, ctx, "");
  } else if (pick.startsWith("⚙")) {
    const sub = await ctx.ui.select("引擎设置", [
      `🖥 切换 HUD 模式（当前：${state.hudMode} · Alt+H）`,
      `🎛 切换酒馆预设（当前：${state.presetId ?? "无"}）`,
      `⚙️ 切换结算模式（当前：${state.settlementMode}）`,
      `🛡 原味直通模式（当前：${state.rawPassthrough ? "开" : "关"}）`,
      "⌨️ 查看全部快捷键",
      "← 返回",
    ]);
    if (sub?.startsWith("🖥")) await actionSetHud(rt, ctx, "");
    else if (sub?.startsWith("🎛")) await actionPreset(rt, ctx, "");
    else if (sub?.startsWith("⚙️")) await actionSetSettlementMode(rt, ctx, "");
    else if (sub?.startsWith("🛡")) await actionToggleRawPassthrough(rt, ctx, "");
    else if (sub?.startsWith("⌨️")) await actionShowShortcuts(ctx);
  } else if (pick.startsWith("🚪")) {
    await actionExitRp(rt, ctx, true);
  }
}

export function registerRpCommands(pi: PiExtensionAPI, rt: RpRuntimeHandle): void {
  pi.registerCommand("rp", {
    description: "角色扮演引擎控制台（仅当前会话生效，输入 /rp 或按 Alt+R 打开菜单）",
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
      if (sub === "load") {
        const cards = listAllCardSummaries(process.cwd());
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
        case "report":
          await openRpDashboard(makeDashboardRuntime(rt), ctx);
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
          ctx.ui.notify(`未知子命令：${sub}。输入 /rp 或按 Alt+R 打开交互菜单。`, "warning");
      }
    },
  });
}
