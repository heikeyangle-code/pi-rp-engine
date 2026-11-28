/**
 * Ergonomic, terminal-safe RP shortcuts registered via Pi's official `pi.registerShortcut` (16 total).
 *
 * Prioritizes daily high-frequency RP workflows (Impersonate, Zero-Pollution Side Prompt,
 * Quick Replies, Context X-Ray, Reroll/Swipe, Continue, Director Note, Scene/Time Jump, Bookmarks).
 */

import type { PiExtensionAPI, PiExtensionContext } from "../types.js";

export interface RpShortcutSpec {
  key: string;
  label: string;
  description: string;
}

export const RP_SHORTCUT_LIST: RpShortcutSpec[] = [
  { key: "alt+r", label: "主菜单 / 启动器", description: "打开 RP 主菜单（未开启时打开启动器）" },
  { key: "ctrl+shift+r", label: "世界面板", description: "打开 7 标签页世界控制台（TUI 浮窗 / 移动端全功能面板 · /rp panel）" },
  { key: "alt+e", label: "快捷回复宏", description: "一键发送常用动作、预填模板或导演微调 (/rp qr)" },
  { key: "alt+x", label: "X-Ray 透视", description: "查看 Zone 1/2/3 Token、KV-Cache 连击与世界书命中原因 (/rp xray)" },
  { key: "alt+i", label: "帮我代写", description: "以玩家视角起草回复并填入输入框 (/rp imp)" },
  { key: "alt+q", label: "场外提问", description: "零污染 Side Prompt，不写入历史与时钟 (/rp ask)" },
  { key: "alt+w", label: "重摇回复", description: "重摇上一条回复（支持定向微调预设，旧分支保留在 /tree · /rp reroll）" },
  { key: "alt+k", label: "继续续写", description: "让角色无缝续写剧情 (/rp continue)" },
  { key: "alt+a", label: "行动建议", description: "生成 3 个当前情境下的行动选项 (/rp act)" },
  { key: "alt+n", label: "导演指令", description: "管理导演指令与文风/篇幅模板 (/rp note)" },
  { key: "alt+p", label: "切换节奏", description: "循环切换节奏：舒缓 → 均衡 → 紧张 (/rp pace)" },
  { key: "alt+t", label: "切场景/跳时间", description: "跳过时间或切换至下一场景 (/rp skip)" },
  { key: "alt+b", label: "保存书签", description: "为当前剧情节点打书签 (/rp save)" },
  { key: "alt+j", label: "跳转书签", description: "回溯或分叉至已保存的剧情书签 (/rp goto)" },
  { key: "alt+h", label: "切换 HUD", description: "循环切换 HUD：极简 → 完整 → 隐藏 (/rp hud)" },
  { key: "alt+shift+x", label: "彻底退出", description: "确认后彻底退出当前会话的 RP 模式 (/rp exit)" },
];

export interface RpShortcutHandlers {
  isActive(): boolean;
  openMenu(ctx: PiExtensionContext): Promise<void>;
  openDashboard(ctx: PiExtensionContext): Promise<void>;
  quickReplies(ctx: PiExtensionContext): Promise<void>;
  openXRay(ctx: PiExtensionContext): Promise<void>;
  impersonate(ctx: PiExtensionContext): Promise<void>;
  sidePrompt(ctx: PiExtensionContext): Promise<void>;
  rerollLast(ctx: PiExtensionContext): Promise<void>;
  continueStory(ctx: PiExtensionContext): Promise<void>;
  actionIdeas(ctx: PiExtensionContext): Promise<void>;
  directorNote(ctx: PiExtensionContext): Promise<void>;
  cyclePacing(ctx: PiExtensionContext): Promise<void>;
  skipTime(ctx: PiExtensionContext): Promise<void>;
  saveBookmark(ctx: PiExtensionContext): Promise<void>;
  gotoBookmark(ctx: PiExtensionContext): Promise<void>;
  cycleHud(ctx: PiExtensionContext): Promise<void>;
  exitRp(ctx: PiExtensionContext): Promise<void>;
}

export function registerRpShortcuts(pi: PiExtensionAPI, handlers: RpShortcutHandlers): void {
  if (typeof pi.registerShortcut !== "function") return;

  // In RPC / mobile hosts (e.g. pi-android), `catalog.triggerShortcut` awaits the shortcut handler
  // with a 30s RPC timeout. Launching interactive UI flows non-blocking in non-TUI mode prevents
  // false timeout errors while the user reads or browses a native bottom sheet!
  const runShortcut = (fn: (ctx: PiExtensionContext) => Promise<void>, ctx: PiExtensionContext): Promise<void> | void => {
    if (ctx.mode !== "tui") {
      void Promise.resolve(fn(ctx)).catch((err) => {
        ctx.ui?.notify?.(`操作执行失败：${(err as Error).message}`, "error");
      });
      return;
    }
    return fn(ctx);
  };

  const requireActive = (fn: (ctx: PiExtensionContext) => Promise<void>) => (ctx: PiExtensionContext) => {
    if (!handlers.isActive()) {
      ctx.ui.notify("当前会话未开启 RP 模式。按 Alt+R 或输入 /rp 打开启动器。", "info");
      return;
    }
    return runShortcut(fn, ctx);
  };

  pi.registerShortcut("alt+r", {
    description: "RP 主菜单 / 启动器",
    handler: (ctx) => runShortcut((c) => handlers.openMenu(c), ctx),
  });

  pi.registerShortcut("ctrl+shift+r", {
    description: "RP 世界控制台（TUI 7标签浮窗 / 全功能面板）",
    handler: requireActive((ctx) => handlers.openDashboard(ctx)),
  });

  pi.registerShortcut("alt+e", {
    description: "RP 快捷回复与常用动作宏 (/rp qr)",
    handler: requireActive((ctx) => handlers.quickReplies(ctx)),
  });

  pi.registerShortcut("alt+x", {
    description: "RP 上下文 X-Ray 透视 (/rp xray)",
    handler: requireActive((ctx) => handlers.openXRay(ctx)),
  });

  pi.registerShortcut("alt+i", {
    description: "RP 帮我代写主角回复 (/rp imp)",
    handler: requireActive((ctx) => handlers.impersonate(ctx)),
  });

  pi.registerShortcut("alt+q", {
    description: "RP 零污染场外提问 (/rp ask)",
    handler: requireActive((ctx) => handlers.sidePrompt(ctx)),
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

  pi.registerShortcut("alt+t", {
    description: "RP 切场景 / 跳时间 (/rp skip)",
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
