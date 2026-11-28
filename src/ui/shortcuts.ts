/**
 * Ergonomic, terminal-safe RP shortcuts registered via Pi's official `pi.registerShortcut`.
 *
 * Terminal safety guarantees:
 *  - Avoids raw terminal-reserved collisions (`ctrl+i`=Tab, `ctrl+m`=Enter, `ctrl+j`=LF,
 *    `ctrl+h`=Backspace, `ctrl+c`/`ctrl+z`/`ctrl+d`/`ctrl+l`/`ctrl+r`/`ctrl+o`).
 *  - In dormant (non-RP) sessions, ONLY `alt+r` opens the RP Launcher; all other RP shortcuts
 *    quietly notify without modifying any coding session state or tools.
 */

import type { PiExtensionAPI, PiExtensionContext } from "../types.js";

export interface RpShortcutSpec {
  key: string;
  label: string;
  description: string;
}

export const RP_SHORTCUT_LIST: RpShortcutSpec[] = [
  { key: "alt+r", label: "主菜单 / 启动器", description: "打开 RP 主菜单（未开启时打开启动器）" },
  { key: "ctrl+shift+r", label: "世界面板", description: "打开实时世界面板 / 状态与世界书编辑器 (/rp panel)" },
  { key: "alt+w", label: "重摇回复", description: "分叉重摇上一条回复，旧版本保留在 /tree (/rp reroll)" },
  { key: "alt+k", label: "继续续写", description: "让角色无缝续写剧情 (/rp continue)" },
  { key: "alt+a", label: "行动建议", description: "生成 3 个当前情境下的行动选项 (/rp act)" },
  { key: "alt+n", label: "导演指令", description: "管理导演指令与常用模板 (/rp note)" },
  { key: "alt+p", label: "切换节奏", description: "一键循环切换节奏：舒缓 → 均衡 → 紧张 (/rp pace)" },
  { key: "alt+o", label: "OOC 讨论", description: "发起场外 OOC 讨论，不推进剧情 (/rp ooc)" },
  { key: "alt+g", label: "快捷掷骰", description: "打开快捷掷骰检定器 (/rp roll)" },
  { key: "alt+t", label: "时间快进", description: "跳过时间 / 触发幕间蒙太奇 (/rp skip)" },
  { key: "alt+b", label: "保存书签", description: "为当前剧情节点打书签 (/rp save)" },
  { key: "alt+j", label: "跳转书签", description: "回溯或分叉至已保存的剧情书签 (/rp goto)" },
  { key: "alt+h", label: "切换 HUD", description: "循环切换 HUD：极简 → 完整 → 隐藏 (/rp hud)" },
  { key: "alt+shift+x", label: "彻底退出", description: "确认后彻底退出当前会话的 RP 模式 (/rp exit)" },
];

export interface RpShortcutHandlers {
  isActive(): boolean;
  openMenu(ctx: PiExtensionContext): Promise<void>;
  openDashboard(ctx: PiExtensionContext): Promise<void>;
  rerollLast(ctx: PiExtensionContext): Promise<void>;
  continueStory(ctx: PiExtensionContext): Promise<void>;
  actionIdeas(ctx: PiExtensionContext): Promise<void>;
  directorNote(ctx: PiExtensionContext): Promise<void>;
  cyclePacing(ctx: PiExtensionContext): Promise<void>;
  oocChat(ctx: PiExtensionContext): Promise<void>;
  quickRoll(ctx: PiExtensionContext): Promise<void>;
  skipTime(ctx: PiExtensionContext): Promise<void>;
  saveBookmark(ctx: PiExtensionContext): Promise<void>;
  gotoBookmark(ctx: PiExtensionContext): Promise<void>;
  cycleHud(ctx: PiExtensionContext): Promise<void>;
  exitRp(ctx: PiExtensionContext): Promise<void>;
}

export function registerRpShortcuts(pi: PiExtensionAPI, handlers: RpShortcutHandlers): void {
  if (typeof pi.registerShortcut !== "function") return;

  const requireActive = (fn: (ctx: PiExtensionContext) => Promise<void>) => async (ctx: PiExtensionContext) => {
    if (!handlers.isActive()) {
      ctx.ui.notify("当前会话未开启 RP 模式。按 Alt+R 或输入 /rp 打开启动器。", "info");
      return;
    }
    await fn(ctx);
  };

  pi.registerShortcut("alt+r", {
    description: "RP 主菜单 / 启动器",
    handler: async (ctx) => handlers.openMenu(ctx),
  });

  pi.registerShortcut("ctrl+shift+r", {
    description: "RP 世界面板与实时状态编辑器",
    handler: requireActive((ctx) => handlers.openDashboard(ctx)),
  });

  pi.registerShortcut("alt+w", {
    description: "RP 重摇上一条回复 (/rp reroll)",
    handler: requireActive((ctx) => handlers.rerollLast(ctx)),
  });

  pi.registerShortcut("alt+k", {
    description: "RP 续写剧情 (/rp continue)",
    handler: requireActive((ctx) => handlers.continueStory(ctx)),
  });

  pi.registerShortcut("alt+a", {
    description: "RP 生成行动建议 (/rp act)",
    handler: requireActive((ctx) => handlers.actionIdeas(ctx)),
  });

  pi.registerShortcut("alt+n", {
    description: "RP 导演指令管理 (/rp note)",
    handler: requireActive((ctx) => handlers.directorNote(ctx)),
  });

  pi.registerShortcut("alt+p", {
    description: "RP 一键循环切换叙事节奏 (/rp pace)",
    handler: requireActive((ctx) => handlers.cyclePacing(ctx)),
  });

  pi.registerShortcut("alt+o", {
    description: "RP 发起 OOC 场外讨论 (/rp ooc)",
    handler: requireActive((ctx) => handlers.oocChat(ctx)),
  });

  pi.registerShortcut("alt+g", {
    description: "RP 快捷掷骰检定 (/rp roll)",
    handler: requireActive((ctx) => handlers.quickRoll(ctx)),
  });

  pi.registerShortcut("alt+t", {
    description: "RP 推进时间 / 幕间蒙太奇 (/rp skip)",
    handler: requireActive((ctx) => handlers.skipTime(ctx)),
  });

  pi.registerShortcut("alt+b", {
    description: "RP 保存剧情书签 (/rp save)",
    handler: requireActive((ctx) => handlers.saveBookmark(ctx)),
  });

  pi.registerShortcut("alt+j", {
    description: "RP 跳转或分叉至剧情书签 (/rp goto)",
    handler: requireActive((ctx) => handlers.gotoBookmark(ctx)),
  });

  pi.registerShortcut("alt+h", {
    description: "RP 循环切换 HUD 显示模式",
    handler: requireActive((ctx) => handlers.cycleHud(ctx)),
  });

  pi.registerShortcut("alt+shift+x", {
    description: "RP 彻底退出本会话角色扮演模式",
    handler: requireActive((ctx) => handlers.exitRp(ctx)),
  });
}
