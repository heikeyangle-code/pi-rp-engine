/**
 * Dual-track `/rp` command:
 *  - Mobile-first: `/rp` (no args) opens a clean `ctx.ui.select()` menu covering all high-frequency workflows.
 *  - Power-user: `/rp <subcommand> [args]` with `getArgumentCompletions`.
 */

import type { HudMode, PiCommandDefinition, PiExtensionContext, SettlementMode } from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "../engine/state-replay.js";
import {
  type RpActionRuntime,
  actionBookmarkGoto,
  actionBookmarkSave,
  actionContinue,
  actionDirectorNote,
  actionImportFile,
  actionLoadCard,
  actionManageCast,
  actionManagePersona,
  actionManualRoll,
  actionOoc,
  actionSelectPreset,
  actionShowInfo,
  actionSuggestPlayerMoves,
  actionSwitchGreeting,
  actionTimeSkip,
  actionToggleHide,
} from "./actions.js";

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
  { value: "import", description: "导入角色卡(.png/.charx/.json)、世界书或 ST 预设" },
  { value: "load", description: "加载已导入的角色卡" },
  { value: "c", description: "无缝续写下一段剧情" },
  { value: "act", description: "生成 3 个玩家行动灵感并回填输入框" },
  { value: "note", description: "添加/清空导演便签 (--ttl N)" },
  { value: "ooc", description: "发送场外沟通（不污染记忆与账本）" },
  { value: "persona", description: "切换或编辑玩家马甲" },
  { value: "greet", description: "切换开场白 (alternate_greetings)" },
  { value: "preset", description: "切换或关闭 SillyTavern 预设" },
  { value: "save", description: "在当前节点保存剧情书签" },
  { value: "goto", description: "回档至已保存的剧情书签" },
  { value: "hide", description: "非破坏性屏蔽旧楼层" },
  { value: "unhide", description: "恢复已屏蔽楼层" },
  { value: "roll", description: "手动掷骰 (如 1d20+3)" },
  { value: "skip", description: "时间推进 / 幕间蒙太奇" },
  { value: "cast", description: "管理多角色同场卡组 (add/remove/list)" },
  { value: "hud", description: "切换 HUD 密度 (minimal|full|off)" },
  { value: "mode", description: "切换结算档位 (off|tool-assisted|sidecar-light)" },
  { value: "raw", description: "无损直通开关 (on|off)" },
  { value: "info", description: "查看当前世界与导入审计信息" },
  { value: "off", description: "退出 RP 模式并恢复原编程工具集" },
];

export function createRpCommand(rt: RpActionRuntime): PiCommandDefinition {
  return {
    description: "RP 角色扮演与世界引擎总入口（无参数弹快捷菜单）",
    getArgumentCompletions(prefix: string) {
      const p = prefix.trim().toLowerCase();
      if (p.includes(" ")) return null;
      return SUBCOMMANDS.filter((s) => s.value.startsWith(p)).map((s) => ({
        value: s.value,
        label: s.value,
        description: s.description,
      }));
    },
    async handler(rawArgs: string, ctx: PiExtensionContext) {
      const trimmed = rawArgs.trim();
      if (!trimmed) {
        await openQuickMenu(rt, ctx);
        return;
      }

      const spaceIdx = trimmed.search(/\s+/);
      const sub = (spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
      const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx).trim() : "";

      switch (sub) {
        case "import":
          await actionImportFile(rt, ctx, rest);
          break;
        case "load":
          await actionLoadCard(rt, ctx, rest);
          break;
        case "c":
        case "continue":
          actionContinue(rt, ctx);
          break;
        case "act":
          await actionSuggestPlayerMoves(rt, ctx, rest);
          break;
        case "note":
          await actionDirectorNote(rt, ctx, rest);
          break;
        case "ooc":
          await actionOoc(rt, ctx, rest);
          break;
        case "persona":
          await actionManagePersona(rt, ctx);
          break;
        case "greet":
          await actionSwitchGreeting(rt, ctx);
          break;
        case "preset":
          await actionSelectPreset(rt, ctx, rest || undefined);
          break;
        case "save":
          await actionBookmarkSave(rt, ctx, rest);
          break;
        case "goto":
          await actionBookmarkGoto(rt, ctx);
          break;
        case "hide":
          await actionToggleHide(rt, ctx, true);
          break;
        case "unhide":
          await actionToggleHide(rt, ctx, false);
          break;
        case "roll":
          actionManualRoll(rt, ctx, rest);
          break;
        case "skip":
        case "montage":
          await actionTimeSkip(rt, ctx, rest);
          break;
        case "cast":
          await actionManageCast(rt, ctx, rest);
          break;
        case "hud": {
          const mode = (rest || (await ctx.ui.select("HUD 显示模式", ["minimal", "full", "off"]))) as HudMode | undefined;
          if (mode === "minimal" || mode === "full" || mode === "off") {
            const tx = { kind: "config_patch" as const, hudMode: mode };
            rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
            applyRpTx(rt.getState(), tx);
            rt.refreshHud(ctx);
            ctx.ui.notify(`HUD 模式已切换为 ${mode}`, "info");
          }
          break;
        }
        case "mode": {
          const mode = (rest ||
            (await ctx.ui.select("回合结算模式", ["tool-assisted", "off", "sidecar-light"]))) as
            | SettlementMode
            | undefined;
          if (mode === "off" || mode === "tool-assisted" || mode === "sidecar-light") {
            const tx = { kind: "config_patch" as const, settlementMode: mode };
            rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
            applyRpTx(rt.getState(), tx);
            rt.refreshHud(ctx);
            ctx.ui.notify(`结算模式已切换为 ${mode}`, "info");
          }
          break;
        }
        case "raw": {
          const next = rest === "on" ? true : rest === "off" ? false : !rt.getState().rawPassthrough;
          const tx = { kind: "config_patch" as const, rawPassthrough: next };
          rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
          applyRpTx(rt.getState(), tx);
          ctx.ui.notify(`无损直通模式已${next ? "开启" : "关闭"}`, "info");
          break;
        }
        case "info":
        case "panel":
          actionShowInfo(rt, ctx);
          break;
        case "off": {
          const tx = { kind: "unbind" as const };
          rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
          applyRpTx(rt.getState(), tx);
          rt.restoreOriginalTools();
          rt.refreshHud(ctx);
          ctx.ui.notify("已退出 RP 模式，原编程工具集已恢复。", "info");
          break;
        }
        default:
          ctx.ui.notify(`未知子命令 "/rp ${sub}"，输入 /rp 打开交互菜单。`, "warning");
      }
    },
  };
}

async function openQuickMenu(rt: RpActionRuntime, ctx: PiExtensionContext): Promise<void> {
  const active = rt.getState().active;
  const menu = active
    ? [
        "▶ 无缝续写 (/rp c)",
        "💡 帮我想 3 个行动灵感 (/rp act)",
        "📌 导演便签 / 临时引导 (/rp note)",
        "💬 场外 OOC 沟通 (/rp ooc)",
        "👤 切换玩家马甲 (/rp persona)",
        "🎛 切换 SillyTavern 预设 (/rp preset)",
        "📖 切换开场白 (/rp greet)",
        "🔖 保存书签 (/rp save)",
        "⏪ 书签回档 (/rp goto)",
        "🎲 手动掷骰 (/rp roll)",
        "⏳ 时间推进 / 幕间蒙太奇 (/rp skip)",
        "🙈 屏蔽旧楼层 (/rp hide)",
        "📥 导入角色卡 / 世界书 / 预设 (/rp import)",
        "🔄 更换角色卡 (/rp load)",
        "📊 查看世界状态总览 (/rp info)",
        "🛑 退出 RP 模式 (/rp off)",
      ]
    : [
        "📥 导入角色卡 / 世界书 / 预设 (/rp import)",
        "📂 加载已有角色卡 (/rp load)",
        "📊 查看状态 (/rp info)",
      ];

  const choice = await ctx.ui.select(active ? "🎭 RP 引擎快捷菜单" : "🎭 RP 引擎（当前静默休眠）", menu);
  if (!choice) return;

  if (choice.includes("/rp c")) actionContinue(rt, ctx);
  else if (choice.includes("/rp act")) await actionSuggestPlayerMoves(rt, ctx, "");
  else if (choice.includes("/rp note")) await actionDirectorNote(rt, ctx, "");
  else if (choice.includes("/rp ooc")) await actionOoc(rt, ctx, "");
  else if (choice.includes("/rp persona")) await actionManagePersona(rt, ctx);
  else if (choice.includes("/rp preset")) await actionSelectPreset(rt, ctx);
  else if (choice.includes("/rp greet")) await actionSwitchGreeting(rt, ctx);
  else if (choice.includes("/rp save")) await actionBookmarkSave(rt, ctx, "");
  else if (choice.includes("/rp goto")) await actionBookmarkGoto(rt, ctx);
  else if (choice.includes("/rp roll")) actionManualRoll(rt, ctx, "1d20");
  else if (choice.includes("/rp skip")) await actionTimeSkip(rt, ctx, "");
  else if (choice.includes("/rp hide")) await actionToggleHide(rt, ctx, true);
  else if (choice.includes("/rp import")) await actionImportFile(rt, ctx, "");
  else if (choice.includes("/rp load")) await actionLoadCard(rt, ctx);
  else if (choice.includes("/rp info")) actionShowInfo(rt, ctx);
  else if (choice.includes("/rp off")) {
    const tx = { kind: "unbind" as const };
    rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
    applyRpTx(rt.getState(), tx);
    rt.restoreOriginalTools();
    rt.refreshHud(ctx);
    ctx.ui.notify("已退出 RP 模式，原编程工具集已恢复。", "info");
  }
}
