/**
 * Conflict-free, mobile-first RP shortcuts registered via Pi's official `pi.registerShortcut` (9 core bindings).
 *
 * Renders as 3 clean rows of 3 tappable pills in `pi-android` 扩展中心 while avoiding Readline,
 * Termux, and browser conflicts (e.g. `ctrl+shift+r`, `alt+b/t/u/v/p/n/a/j/h/x`).
 * All remaining RP actions are 1–2 taps away inside `/rp` or 世界面板 (`alt+m`).
 */

import type { PiExtensionAPI, PiExtensionContext } from "../types.js";

export interface RpShortcutSpec {
  key: string;
  label: string;
  description: string;
}

export const RP_SHORTCUT_LIST: RpShortcutSpec[] = [
  { key: "alt+r", label: "主菜单", description: "打开 RP 主菜单" },
  { key: "alt+m", label: "世界面板", description: "打开世界面板" },
  { key: "alt+e", label: "快捷回复", description: "快捷回复与动作宏" },
  { key: "alt+w", label: "重摇回复", description: "重摇上一条回复" },
  { key: "alt+g", label: "局部改写", description: "定向改写上一条回复" },
  { key: "alt+k", label: "续写剧情", description: "继续续写剧情" },
  { key: "alt+i", label: "代写回复", description: "帮我代写回复" },
  { key: "alt+q", label: "场外提问", description: "零污染场外提问" },
  { key: "alt+o", label: "导演指令", description: "管理导演指令" },
  { key: "alt+x", label: "检索透视", description: "查看上下文与召回透视 (X-Ray)" },
  { key: "alt+y", label: "知识图谱", description: "打开卡体知识库与实体图谱" },
];

export interface RpShortcutHandlers {
  isActive(): boolean;
  openMenu(ctx: PiExtensionContext): Promise<void>;
  openDashboard(ctx: PiExtensionContext): Promise<void>;
  quickReplies(ctx: PiExtensionContext): Promise<void>;
  rerollLast(ctx: PiExtensionContext): Promise<void>;
  rewriteLast(ctx: PiExtensionContext): Promise<void>;
  continueStory(ctx: PiExtensionContext): Promise<void>;
  impersonate(ctx: PiExtensionContext): Promise<void>;
  sidePrompt(ctx: PiExtensionContext): Promise<void>;
  directorNote(ctx: PiExtensionContext): Promise<void>;
  // Optional legacy handler slots kept for backward compatibility with callers
  openXRay?(ctx: PiExtensionContext): Promise<void>;
  openKnowledge?(ctx: PiExtensionContext): Promise<void>;
  actionIdeas?(ctx: PiExtensionContext): Promise<void>;
  cyclePacing?(ctx: PiExtensionContext): Promise<void>;
  styleControl?(ctx: PiExtensionContext): Promise<void>;
  skipTime?(ctx: PiExtensionContext): Promise<void>;
  saveBookmark?(ctx: PiExtensionContext): Promise<void>;
  gotoBookmark?(ctx: PiExtensionContext): Promise<void>;
  cycleHud?(ctx: PiExtensionContext): Promise<void>;
  exitRp?(ctx: PiExtensionContext): Promise<void>;
}

export function registerRpShortcuts(pi: PiExtensionAPI, handlers: RpShortcutHandlers): void {
  if (typeof pi.registerShortcut !== "function") return;

  // Always launch interactive shortcut UI non-blocking so mobile hosts (pi-android)
  // never hit the 30s `catalog.triggerShortcut` RPC timeout even when ctx.mode === "tui".
  const SHORTCUT_BUSY_WATCHDOG_MS = 60_000;
  let shortcutBusySince = 0;
  const runShortcut = (fn: (ctx: PiExtensionContext) => Promise<void>, ctx: PiExtensionContext): void => {
    const now = Date.now();
    if (shortcutBusySince > 0 && now - shortcutBusySince < SHORTCUT_BUSY_WATCHDOG_MS) return;
    shortcutBusySince = now;
    const token = now;
    void Promise.resolve(fn(ctx))
      .catch((err) => {
        ctx.ui?.notify?.(`操作执行失败：${(err as Error).message}`, "error");
      })
      .finally(() => {
        if (shortcutBusySince === token) shortcutBusySince = 0;
      });
  };

  const requireActive = (fn: (ctx: PiExtensionContext) => Promise<void>) => (ctx: PiExtensionContext) => {
    if (!handlers.isActive()) {
      ctx.ui.notify("当前会话未开启角色扮演模式，请先点「主菜单」加载角色卡。", "info");
      return;
    }
    return runShortcut(fn, ctx);
  };

  pi.registerShortcut("alt+r", {
    description: "🎭 主菜单",
    handler: (ctx) => runShortcut((c) => handlers.openMenu(c), ctx),
  });

  pi.registerShortcut("alt+m", {
    description: "📊 世界面板",
    handler: requireActive((ctx) => handlers.openDashboard(ctx)),
  });

  pi.registerShortcut("alt+e", {
    description: "⚡ 快捷回复",
    handler: requireActive((ctx) => handlers.quickReplies(ctx)),
  });

  pi.registerShortcut("alt+w", {
    description: "🔄 重摇回复",
    handler: requireActive(async (ctx) => {
      if (typeof ctx.navigateTree !== "function" && typeof ctx.fork !== "function") {
        ctx.ui.setEditorText?.("/rp reroll");
        ctx.ui.notify("已将 /rp reroll 填入输入框，按回车即可重摇上一条回复。", "info");
        return;
      }
      await handlers.rerollLast(ctx);
    }),
  });

  pi.registerShortcut("alt+g", {
    description: "✂️ 局部改写",
    handler: requireActive((ctx) => handlers.rewriteLast(ctx)),
  });

  pi.registerShortcut("alt+k", {
    description: "▶ 续写剧情",
    handler: requireActive((ctx) => handlers.continueStory(ctx)),
  });

  pi.registerShortcut("alt+i", {
    description: "✍️ 代写回复",
    handler: requireActive((ctx) => handlers.impersonate(ctx)),
  });

  pi.registerShortcut("alt+q", {
    description: "💭 场外提问",
    handler: requireActive((ctx) => handlers.sidePrompt(ctx)),
  });

  pi.registerShortcut("alt+o", {
    description: "🎬 导演指令",
    handler: requireActive((ctx) => handlers.directorNote(ctx)),
  });

  pi.registerShortcut("alt+x", {
    description: "🔍 检索透视",
    handler: requireActive((ctx) =>
      handlers.openXRay ? handlers.openXRay(ctx) : handlers.openDashboard(ctx),
    ),
  });

  pi.registerShortcut("alt+y", {
    description: "🧠 知识图谱",
    handler: requireActive((ctx) =>
      handlers.openKnowledge ? handlers.openKnowledge(ctx) : handlers.openDashboard(ctx),
    ),
  });
}
