/**
 * Humanized, interactive action handlers for `/rp` commands and shortcuts.
 *
 * Key guarantees:
 *  - Strictly session-only binding (NEVER writes project-wide auto-activation files!)
 *  - Complete, clean exit (`actionExitRp`) wiping all runtime state, restoring coding tools & clearing HUD
 *  - Effortless file import via interactive file browser + auto-sniffer + batch import + post-import quick-start
 *  - Official Pi SDK compliance for bookmarks (`sessionManager.getLabel(id)` + `type === "label"`),
 *    floor hiding (both `entryId` & deterministic message fingerprint), and rich narrative messages.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CompiledCard,
  CompiledPreset,
  HudMode,
  PacingMode,
  PersonaProfile,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  RpTxEntry,
  SessionRpState,
  SettlementMode,
} from "../types.js";
import { unpackFile } from "../parser/unpack.js";
import { compileCharacterCard } from "../parser/card-compiler.js";
import { compileLoreBook } from "../parser/lore-compiler.js";
import { compileSillyTavernPreset } from "../parser/preset.js";
import { evaluateMacros } from "../parser/macros.js";
import { rollDiceCheck } from "../engine/dice.js";
import { computeMessageFingerprint } from "../engine/state-replay.js";
import {
  getGlobalLibraryDir,
  getProjectRpDir,
  listAllCardSummaries,
  listPresetIds,
  loadCompiledPreset,
  loadPersonas,
  loadRawCardJson,
  mergeExternalLoreBook,
  resolveCardBySlug,
  saveCompiledCard,
  saveCompiledPreset,
  savePersona,
} from "../storage/workspace-store.js";
import { loadUiPrefs, normalizeUserFilePath, pickFilesToImport, saveUiPrefs } from "./file-picker.js";
import { RP_SHORTCUT_LIST } from "./shortcuts.js";

export interface RpRuntimeHandle {
  pi: PiExtensionAPI;
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  getPreset(): CompiledPreset | null;
  commitTx(tx: RpTxEntry): void;
  reloadRuntime(ctx: PiExtensionContext): void;
  refreshHud(ctx: PiExtensionContext): void;
  activateRpTools(): void;
  restoreCodingTools(): void;
  markNextTurnOoc(): void;
  teardownSessionRuntime(ctx: PiExtensionContext): void;
}

function previewText(text: string, maxLen = 68): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

function extractMsgPlain(msg: PiMessage | undefined): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function getTargetStorageDir(cwd: string, scope: "project" | "library"): string {
  return scope === "library" ? getGlobalLibraryDir() : getProjectRpDir(cwd);
}

async function pickGreeting(ctx: PiExtensionContext, card: CompiledCard, quickDefault = false): Promise<number> {
  const all = [card.greetings.firstMes, ...card.greetings.alternates].filter((g) => g.trim().length > 0);
  if (all.length <= 1 || quickDefault) return 0;

  const opts = all.map((g, i) => `${i === 0 ? "★ 主开场白" : `❖ 备选 #${i}`}  ${previewText(g, 58)}`);
  const pick = await ctx.ui.select(`🎭 选择「${card.identity.name}」的开场白（共 ${all.length} 条）`, opts);
  if (!pick) return 0;
  const idx = opts.indexOf(pick);
  return idx >= 0 ? idx : 0;
}

async function pickOrCreatePersona(ctx: PiExtensionContext, current: PersonaProfile): Promise<PersonaProfile> {
  const saved = loadPersonas(ctx.cwd);
  const prefs = loadUiPrefs();
  const preferred =
    saved.find((p) => p.id === prefs.lastPersonaId) ??
    (current.id !== "default" ? current : saved[0]) ??
    current;

  const options = [
    `▶ 使用当前/默认人设：${preferred.name}${preferred.description ? ` (${previewText(preferred.description, 28)})` : ""}`,
    ...saved
      .filter((p) => p.id !== preferred.id)
      .map((p) => `🧑 ${p.name}${p.description ? ` — ${previewText(p.description, 32)}` : ""}`),
    "+ 新建玩家人设（保存到全局库，跨卡通用）",
  ];

  const choice = await ctx.ui.select("🧑 选择本次会话的玩家人设 (Persona)", options);
  if (!choice || choice.startsWith("▶")) {
    return preferred;
  }
  if (choice.startsWith("+")) {
    const name = (await ctx.ui.input("玩家角色名称", "旅人"))?.trim();
    if (!name) return preferred;
    const desc = (await ctx.ui.input("简短设定/外貌/身份（可留空）", ""))?.trim() ?? "";
    const profile: PersonaProfile = {
      id: name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").slice(0, 32) || `p_${Date.now()}`,
      name,
      description: desc,
    };
    savePersona(ctx.cwd, profile, "library");
    saveUiPrefs({ lastPersonaId: profile.id });
    return profile;
  }

  const matched = saved.find((p) => choice.startsWith(`🧑 ${p.name}`));
  if (matched) {
    saveUiPrefs({ lastPersonaId: matched.id });
    return matched;
  }
  return preferred;
}

/** Bind a compiled card strictly to THIS session (never touches any project auto-bind config!). */
export async function bindCardToCurrentSession(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  options: {
    card: CompiledCard;
    source: "project" | "library";
    baseDir: string;
    greetingIndex?: number;
    persona?: PersonaProfile;
    presetId?: string;
    rawPassthrough?: boolean;
  },
): Promise<void> {
  const { card, source, baseDir, greetingIndex = 0, persona, presetId, rawPassthrough = false } = options;

  rt.commitTx({
    kind: "bind",
    cardId: card.id,
    cardSlug: card.slug,
    cardSource: source,
    worldDir: baseDir,
    greetingIndex,
    activeCharacters: [card.slug],
    presetId,
    rawPassthrough,
    persona,
  });

  // Seed salvaged MVU/YAML/macro variables into deterministic L1 stats
  for (const v of card.salvagedStateSchema) {
    rt.commitTx({
      kind: "stat_patch",
      actorId: card.identity.name,
      key: v.key,
      op: "set",
      value: v.initialValue,
      min: v.min,
      max: v.max,
      reason: `salvaged:${v.source}`,
    });
  }

  rt.reloadRuntime(ctx);
  rt.activateRpTools();
  rt.refreshHud(ctx);

  const state = rt.getState();
  const allGreetings = [card.greetings.firstMes, ...card.greetings.alternates];
  const chosenGreeting = allGreetings[greetingIndex] ?? card.greetings.firstMes;
  if (chosenGreeting.trim()) {
    const rendered = evaluateMacros(chosenGreeting, {
      charName: card.identity.nickname || card.identity.name,
      userName: state.currentPersona.name,
      personaDescription: state.currentPersona.description,
    });
    rt.pi.sendMessage(
      {
        customType: "rp:greeting",
        content: rendered,
        display: true,
        details: { cardName: card.identity.name, greetingIndex, era: state.era },
      },
      { triggerTurn: false },
    );
  }

  ctx.ui.notify(
    `已在本会话开启角色扮演：${card.identity.name}（仅当前会话生效，按 Alt+Shift+X 或 /rp exit 可随时彻底退出）`,
    "info",
  );
}

/** Import one file into library/project and return summary metadata. */
async function importSingleFile(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  resolvedPath: string,
  storageScope: "project" | "library",
  rawMode: boolean,
  silent = false,
): Promise<{ kind: "card"; card: CompiledCard; source: "project" | "library"; baseDir: string } | { kind: "lorebook" | "preset"; name: string } | null> {
  let unpacked;
  try {
    unpacked = unpackFile(resolvedPath);
  } catch (err) {
    ctx.ui.notify(`解包失败 (${path.basename(resolvedPath)}): ${(err as Error).message}`, "error");
    return null;
  }

  const targetDir = getTargetStorageDir(ctx.cwd, storageScope);

  if (unpacked.kind === "card") {
    const card = compileCharacterCard(unpacked.rawJson, unpacked.specOrigin, {
      rawPassthrough: rawMode,
    });
    saveCompiledCard({
      baseDir: targetDir,
      card,
      rawJson: unpacked.rawJson,
      avatarPng: unpacked.avatarPng,
      assets: unpacked.assets,
    });

    if (!silent) {
      const r = card.importReport;
      const summaryLines = [
        `角色：${card.identity.name} (${card.specOrigin.toUpperCase()}) · 存入${storageScope === "library" ? "全局角色库" : "项目角色库"}`,
        `对话示例保留：${r.mesExampleCharsAfter}/${r.mesExampleCharsBefore} 字符 (100% 无损) · 世界书 ${r.loreCount} 条`,
        `前端壳剥离：${r.strippedItems.length} 项 · 打捞数值变量：${r.salvagedVariables.length} 项`,
      ];
      ctx.ui.notify(summaryLines.join(" | "), "info");
    }
    return { kind: "card", card, source: storageScope, baseDir: targetDir };
  }

  if (unpacked.kind === "lorebook") {
    const book = compileLoreBook(unpacked.rawJson, { rawPassthrough: rawMode });
    const state = rt.getState();
    let targetSlug = state.cardSlug ?? "";
    let targetBase = state.worldDir ?? targetDir;

    if (!targetSlug) {
      const cards = listAllCardSummaries(ctx.cwd);
      if (cards.length === 0) {
        ctx.ui.notify("请先导入至少一张角色卡，再将独立世界书挂载到角色卡。", "warning");
        return null;
      }
      const opts = cards.map((c) => `${c.name} (${c.slug}) [${c.source === "project" ? "项目" : "全局库"}]`);
      const pick = await ctx.ui.select(`选择要挂载世界书（${book.entries.length} 条）的目标角色卡`, opts);
      if (!pick) return null;
      const chosen = cards[opts.indexOf(pick)];
      if (!chosen) return null;
      targetSlug = chosen.slug;
      targetBase = chosen.baseDir;
    }

    const updated = mergeExternalLoreBook(targetBase, targetSlug, book);
    if (!updated) {
      ctx.ui.notify(`未找到目标角色卡：${targetSlug}`, "error");
      return null;
    }
    rt.reloadRuntime(ctx);
    ctx.ui.notify(`已将 ${book.entries.length} 条世界书条目合并至「${updated.identity.name}」`, "info");
    return { kind: "lorebook", name: book.name || path.basename(resolvedPath) };
  }

  // Preset
  const preset = compileSillyTavernPreset(unpacked.rawJson, {
    name: path.basename(resolvedPath, path.extname(resolvedPath)),
    rawPassthrough: rawMode,
  });
  saveCompiledPreset(targetDir, preset);
  ctx.ui.notify(
    `已导入酒馆预设「${preset.name}」：Zone1 ${preset.zone1Prompts.length} 段 / Zone3 ${preset.zone3Prompts.length} 段`,
    "info",
  );
  if (rt.getState().active) {
    const applyNow = await ctx.ui.confirm("立即启用预设", `是否立即在当前 RP 会话中启用预设「${preset.name}」？`);
    if (applyNow) {
      rt.commitTx({ kind: "preset_set", presetId: preset.id });
      rt.reloadRuntime(ctx);
      ctx.ui.notify(`已切换至预设：${preset.name}`, "info");
    }
  }
  return { kind: "preset", name: preset.name };
}

/** Humanized `/rp import`: supports direct path args OR full interactive file browser + batch import! */
export async function actionImportFile(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const tokens = argsText.trim().split(/\s+/).filter(Boolean);
  let storageScope: "project" | "library" | null = null;
  let rawMode = false;
  const pathParts: string[] = [];

  for (const t of tokens) {
    if (t === "--global" || t === "--library" || t === "-g") storageScope = "library";
    else if (t === "--project" || t === "-p") storageScope = "project";
    else if (t === "--raw") rawMode = true;
    else pathParts.push(t);
  }

  let filePaths: string[] = [];
  if (pathParts.length > 0) {
    const resolved = normalizeUserFilePath(pathParts.join(" "), ctx.cwd);
    if (!fs.existsSync(resolved)) {
      ctx.ui.notify(`找不到文件：${resolved}`, "error");
      return;
    }
    if (fs.statSync(resolved).isDirectory()) {
      ctx.ui.notify("已检测到目录，正在打开交互式文件浏览器…", "info");
      const picked = await pickFilesToImport(ctx);
      if (!picked || picked.length === 0) return;
      filePaths = picked;
    } else {
      filePaths = [resolved];
      saveUiPrefs({ lastImportDir: path.dirname(resolved) });
    }
  } else {
    const picked = await pickFilesToImport(ctx);
    if (!picked || picked.length === 0) return;
    filePaths = picked;
  }

  // Ask storage scope once (defaulting cleanly to Global Library so cards are reusable anywhere!)
  if (!storageScope) {
    const scopePick = await ctx.ui.select("🗂 选择存放位置", [
      "🌐 全局角色库 (~/.pi/agent/rp-library) — 推荐，任何目录都能直接加载",
      "📁 当前项目库 (.pi/rp) — 仅存放在本目录，绝不自动激活其他会话",
    ]);
    if (!scopePick) return;
    storageScope = scopePick.startsWith("📁") ? "project" : "library";
  }

  // Batch import
  if (filePaths.length > 1) {
    const importedCards: Array<{ card: CompiledCard; source: "project" | "library"; baseDir: string }> = [];
    for (const fp of filePaths) {
      const res = await importSingleFile(rt, ctx, fp, storageScope, rawMode, true);
      if (res && res.kind === "card") importedCards.push(res);
    }
    ctx.ui.notify(`批量导入完成：成功导入 ${importedCards.length}/${filePaths.length} 张角色卡`, "info");
    if (importedCards.length > 0) {
      const start = await ctx.ui.confirm("立即开玩？", "是否从刚导入的角色卡中选择一张立即开启本会话 RP？");
      if (start) await actionLoadCard(rt, ctx, "");
    }
    return;
  }

  // Single file import
  const singleRes = await importSingleFile(rt, ctx, filePaths[0]!, storageScope, rawMode, false);
  if (!singleRes || singleRes.kind !== "card") return;

  const { card, source, baseDir } = singleRes;
  const alreadyActive = rt.getState().active;
  const nextOpts = [
    "▶ 立即在本会话开启角色扮演（进入此角色）",
    ...(alreadyActive ? ["👥 加入当前同场共演阵容（保留当前主卡）"] : []),
    "📚 仅存入角色库，稍后再玩",
  ];
  const nextPick = await ctx.ui.select(`✨ 「${card.identity.name}」已就绪，下一步？`, nextOpts);
  if (!nextPick || nextPick.startsWith("📚")) return;

  if (nextPick.startsWith("👥")) {
    const nextCast = Array.from(new Set([...rt.getState().activeCharacters, card.slug]));
    rt.commitTx({ kind: "cast_set", slugs: nextCast });
    rt.reloadRuntime(ctx);
    rt.refreshHud(ctx);
    ctx.ui.notify(`已将「${card.identity.name}」加入当前同场共演阵容。`, "info");
    return;
  }

  const greetingIndex = await pickGreeting(ctx, card);
  const persona = await pickOrCreatePersona(ctx, rt.getState().currentPersona);
  await bindCardToCurrentSession(rt, ctx, {
    card,
    source,
    baseDir,
    greetingIndex,
    persona,
    rawPassthrough: rawMode,
  });
}

/** Humanized `/rp load`: rich card picker, seamless fallback to import when library is empty, quick-start option. */
export async function actionLoadCard(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const summaries = listAllCardSummaries(ctx.cwd);

  if (summaries.length === 0) {
    const goImport = await ctx.ui.confirm(
      "角色库为空",
      "当前项目与全局库还没有导入任何角色卡。是否立即打开文件浏览器导入？",
    );
    if (goImport) {
      await actionImportFile(rt, ctx, "");
    }
    return;
  }

  let chosenSlug = argsText.trim();
  let preferredSource: "project" | "library" | undefined;

  if (!chosenSlug) {
    const opts = [
      ...summaries.map((c) => {
        const srcTag = c.source === "project" ? "项目" : "全局库";
        const tags = c.tags.length > 0 ? ` · ${c.tags.join("/")}` : "";
        return `🎭 ${c.name}  [${srcTag} · ${c.specOrigin.toUpperCase()} · 世界书 ${c.loreCount} 条${tags}]`;
      }),
      "📥 导入新的角色卡…",
    ];
    const pick = await ctx.ui.select(`🎭 选择角色卡（仅绑定当前会话 · 共 ${summaries.length} 张）`, opts);
    if (!pick) return;
    if (pick.startsWith("📥")) {
      await actionImportFile(rt, ctx, "");
      return;
    }
    const idx = opts.indexOf(pick);
    const chosen = summaries[idx];
    if (!chosen) return;
    chosenSlug = chosen.slug;
    preferredSource = chosen.source;
  }

  const resolved = resolveCardBySlug(ctx.cwd, chosenSlug, preferredSource);
  if (!resolved) {
    ctx.ui.notify(`未找到角色卡：${chosenSlug}`, "error");
    return;
  }

  const { card, source, baseDir } = resolved;
  const presets = listPresetIds(ctx.cwd);
  const prefs = loadUiPrefs();
  const savedPersonas = loadPersonas(ctx.cwd);
  const defaultPersona =
    savedPersonas.find((p) => p.id === prefs.lastPersonaId) ??
    (rt.getState().currentPersona.id !== "default" ? rt.getState().currentPersona : savedPersonas[0]) ??
    rt.getState().currentPersona;

  const startStyle = await ctx.ui.select(`🎭 准备进入「${card.identity.name}」`, [
    `⚡ 立即开局（人设：${defaultPersona.name} · 首条开场白）`,
    "⚙️ 自定义开局（挑选开场白 / 玩家人设 / 酒馆预设）",
    "← 取消",
  ]);
  if (!startStyle || startStyle.startsWith("←")) return;

  if (startStyle.startsWith("⚡")) {
    await bindCardToCurrentSession(rt, ctx, {
      card,
      source,
      baseDir,
      greetingIndex: 0,
      persona: defaultPersona,
    });
    return;
  }

  const greetingIndex = await pickGreeting(ctx, card);
  const persona = await pickOrCreatePersona(ctx, rt.getState().currentPersona);
  let presetId: string | undefined;
  if (presets.length > 0) {
    const pPick = await ctx.ui.select("🎛 是否加载酒馆预设（可选）", ["不使用预设（推荐）", ...presets]);
    if (pPick && !pPick.startsWith("不使用")) presetId = pPick;
  }

  await bindCardToCurrentSession(rt, ctx, {
    card,
    source,
    baseDir,
    greetingIndex,
    persona,
    presetId,
  });
}

/** Complete, thorough exit from RP mode in THIS session. Restores coding tools & wipes runtime cleanly. */
export async function actionExitRp(rt: RpRuntimeHandle, ctx: PiExtensionContext, askConfirm = false): Promise<void> {
  if (!rt.getState().active) {
    ctx.ui.notify("当前会话本来就处于普通编程模式（未开启 RP）。", "info");
    return;
  }

  if (askConfirm) {
    const ok = await ctx.ui.confirm(
      "彻底退出角色扮演模式",
      "退出后将恢复原有编程工具、清空 RP 状态与界面组件，且不会影响角色库中的文件。确定退出？",
    );
    if (!ok) return;
  }

  rt.commitTx({ kind: "unbind" });
  rt.teardownSessionRuntime(ctx);
  ctx.ui.notify("已彻底退出本会话 RP 模式，已恢复为纯净编程助手。", "info");
}

export async function actionContinue(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  if (!rt.getState().active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const nudge =
    rt.getPreset()?.utilityPrompts.continueNudge ||
    "[Continue the scene seamlessly from the exact point where the narrative left off, maintaining voice, atmosphere, and momentum without repeating prior paragraphs.]";
  rt.pi.sendMessage(
    { customType: "rp:event", content: nudge, display: false, details: { kind: "continue" } },
    { triggerTurn: true },
  );
}

export async function actionIdeas(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  if (!rt.getState().active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  rt.markNextTurnOoc();
  rt.pi.sendMessage(
    {
      customType: "rp:ooc",
      content:
        "[OOC Request] Please suggest 3 distinct, in-character action or dialogue choices the player could take right now (e.g., 1 bold/proactive, 1 observant/tactical, 1 emotional/conversational). Keep each concise (1-2 sentences) and do NOT advance the scene.",
      display: true,
      details: { kind: "ideas" },
    },
    { triggerTurn: true },
  );
}

export async function actionOoc(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  if (!rt.getState().active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  let text = argsText.trim();
  if (!text) {
    const entered = await ctx.ui.input("💬 输入 OOC 场外讨论内容（不推进剧情与时钟）", "请问角色现在对玩家是什么看法？");
    if (!entered?.trim()) return;
    text = entered.trim();
  }
  rt.markNextTurnOoc();
  rt.pi.sendMessage(
    {
      customType: "rp:ooc",
      content: `[OOC - Out of Character Discussion; do NOT advance the story or modify world state]\n${text}`,
      display: true,
      details: { kind: "ooc" },
    },
    { triggerTurn: true },
  );
}

export async function actionDirectorNote(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const trimmed = argsText.trim();
  if (trimmed === "clear") {
    rt.commitTx({ kind: "note_clear" });
    rt.refreshHud(ctx);
    ctx.ui.notify("已清空全部导演指令。", "info");
    return;
  }

  if (trimmed) {
    const ttlMatch = /^--ttl\s+(\d+)\s+(.+)$/i.exec(trimmed);
    const remainingTurns = ttlMatch ? Math.max(1, Number(ttlMatch[1])) : null;
    const text = ttlMatch ? ttlMatch[2]!.trim() : trimmed;
    rt.commitTx({
      kind: "note_set",
      note: { id: `note_${Date.now().toString(36)}`, text, remainingTurns },
    });
    rt.refreshHud(ctx);
    ctx.ui.notify(`导演指令已生效${remainingTurns ? `（持续 ${remainingTurns} 轮）` : "（常驻）"}`, "info");
    return;
  }

  // Interactive humanized manager
  const quickTemplates = [
    "放慢节奏，侧重环境氛围、微表情与内心潜台词描写",
    "提高戏剧张力，引入一个合理的意外线索或冲突转折",
    "让角色更主动地推动对话并向玩家抛出一两个具体问题",
    "回复篇幅保持精炼紧凑（约 250-400 字），加快互动节奏",
  ];

  const opts = [
    "✏️ 输入自定义导演指令",
    "✨ 选择常用导演预设模板",
    ...state.notes.map(
      (n, i) => `🗑 移除 #${i + 1}: ${previewText(n.text, 44)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
    ),
    ...(state.notes.length > 0 ? ["🧹 清空全部导演指令"] : []),
    "✕ 返回",
  ];

  const pick = await ctx.ui.select(`🎬 导演指令管理（当前 ${state.notes.length} 条）`, opts);
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("🧹")) {
    rt.commitTx({ kind: "note_clear" });
    rt.refreshHud(ctx);
    ctx.ui.notify("已清空全部导演指令。", "info");
    return;
  }
  if (pick.startsWith("🗑")) {
    const idx = Number(/^🗑 移除 #(\d+)/.exec(pick)?.[1]) - 1;
    const target = state.notes[idx];
    if (target) {
      rt.commitTx({ kind: "note_clear", noteId: target.id });
      rt.refreshHud(ctx);
      ctx.ui.notify("已移除该导演指令。", "info");
    }
    return;
  }

  let noteText = "";
  if (pick.startsWith("✨")) {
    const tpl = await ctx.ui.select("选择导演模板", [...quickTemplates, "← 返回"]);
    if (!tpl || tpl.startsWith("←")) return;
    noteText = tpl;
  } else {
    const entered = await ctx.ui.input("输入导演指令（注入 Zone 3，不影响缓存命中）", "");
    if (!entered?.trim()) return;
    noteText = entered.trim();
  }

  const ttlPick = await ctx.ui.select("设置指令持续时间", [
    "1 轮（仅下一回合生效）",
    "3 轮（短期场景引导）",
    "常驻（直到手动清除）",
  ]);
  const remainingTurns = ttlPick?.startsWith("1") ? 1 : ttlPick?.startsWith("3") ? 3 : null;
  rt.commitTx({
    kind: "note_set",
    note: { id: `note_${Date.now().toString(36)}`, text: noteText, remainingTurns },
  });
  rt.refreshHud(ctx);
  ctx.ui.notify(`导演指令已添加${remainingTurns ? `（${remainingTurns}轮）` : "（常驻）"}`, "info");
}

export async function actionPersona(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim();
  const saved = loadPersonas(ctx.cwd);
  if (arg) {
    const found = saved.find((p) => p.name === arg || p.id === arg);
    const next: PersonaProfile = found ?? {
      id: arg.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_"),
      name: arg,
      description: "",
    };
    savePersona(ctx.cwd, next, "library");
    saveUiPrefs({ lastPersonaId: next.id });
    rt.commitTx({ kind: "persona_set", persona: next });
    rt.refreshHud(ctx);
    ctx.ui.notify(`已切换玩家人设：${next.name}`, "info");
    return;
  }

  const next = await pickOrCreatePersona(ctx, state.currentPersona);
  rt.commitTx({ kind: "persona_set", persona: next });
  rt.refreshHud(ctx);
  ctx.ui.notify(`已切换玩家人设：${next.name}（Zone 1 保持冻结，不破坏 KV 缓存）`, "info");
}

export async function actionGreeting(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const card = rt.getCard();
  const state = rt.getState();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const all = [card.greetings.firstMes, ...card.greetings.alternates].filter((g) => g.trim().length > 0);
  if (all.length === 0) {
    ctx.ui.notify("当前角色卡没有配置开场白。", "warning");
    return;
  }
  const idx = await pickGreeting(ctx, card, false);
  const rendered = evaluateMacros(all[idx]!, {
    charName: card.identity.nickname || card.identity.name,
    userName: state.currentPersona.name,
    personaDescription: state.currentPersona.description,
  });
  rt.pi.sendMessage(
    {
      customType: "rp:greeting",
      content: rendered,
      display: true,
      details: { cardName: card.identity.name, greetingIndex: idx, era: state.era },
    },
    { triggerTurn: false },
  );
  ctx.ui.notify(`已发送开场白 #${idx + 1}`, "info");
}

export async function actionPreset(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim();
  if (arg === "off" || arg === "none") {
    rt.commitTx({ kind: "preset_set", presetId: null });
    rt.reloadRuntime(ctx);
    ctx.ui.notify("已关闭当前酒馆预设。", "info");
    return;
  }

  const presets = listPresetIds(ctx.cwd);
  let chosen = arg;
  if (!chosen) {
    if (presets.length === 0) {
      ctx.ui.notify("尚未导入任何酒馆预设。请使用 /rp import 导入 .json 预设。", "info");
      return;
    }
    const pick = await ctx.ui.select(
      `🎛 选择酒馆预设（当前：${state.presetId ?? "无"}）`,
      ["关闭预设", ...presets],
    );
    if (!pick) return;
    if (pick === "关闭预设") {
      rt.commitTx({ kind: "preset_set", presetId: null });
      rt.reloadRuntime(ctx);
      ctx.ui.notify("已关闭酒馆预设。", "info");
      return;
    }
    chosen = pick;
  }

  const loaded = loadCompiledPreset(ctx.cwd, chosen);
  if (!loaded) {
    ctx.ui.notify(`未找到预设：${chosen}`, "error");
    return;
  }
  rt.commitTx({ kind: "preset_set", presetId: loaded.id });
  rt.reloadRuntime(ctx);
  ctx.ui.notify(`已切换酒馆预设：${loaded.name}`, "info");
}

/** Collect all labeled entries using official Pi SDK `sessionManager.getLabel(id)` + `type === "label"` fallback. */
export function collectLabeledBookmarks(ctx: PiExtensionContext): Array<{ targetId: string; label: string }> {
  const entries = ctx.sessionManager.getEntries();
  const byTarget = new Map<string, string>();

  // 1. Official Pi SDK method: `sessionManager.getLabel(entry.id)`
  if (typeof ctx.sessionManager.getLabel === "function") {
    for (const e of entries) {
      const lbl = ctx.sessionManager.getLabel(e.id);
      if (lbl && lbl.trim()) {
        byTarget.set(e.id, lbl.trim());
      }
    }
  }

  // 2. Fallback: scan `type === "label"` entries (Pi JSONL persistence format) and direct `e.label`
  for (const e of entries) {
    if (e.type === "label" && typeof e.targetId === "string") {
      if (typeof e.label === "string" && e.label.trim()) {
        byTarget.set(e.targetId, e.label.trim());
      } else {
        byTarget.delete(e.targetId);
      }
    } else if (typeof e.label === "string" && e.label.trim() && !byTarget.has(e.id)) {
      byTarget.set(e.id, e.label.trim());
    }
  }

  return Array.from(byTarget.entries()).map(([targetId, label]) => ({ targetId, label }));
}

export async function actionBookmarkSave(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    ctx.ui.notify("当前会话尚无可标记的历史节点。", "warning");
    return;
  }
  const suggested = `${state.era}${state.location ? ` · ${state.location}` : ""} · T${state.turn}`;
  let label = argsText.trim();
  if (!label) {
    const entered = await ctx.ui.input("🔖 输入剧情书签名称（回车使用默认）", suggested);
    if (entered === undefined) return;
    label = entered.trim() || suggested;
  }
  if (typeof rt.pi.setLabel === "function") {
    rt.pi.setLabel(leafId, label);
    ctx.ui.notify(`已保存剧情书签：「${label}」`, "info");
  } else {
    ctx.ui.notify("当前 Pi 运行环境不支持 setLabel API。", "warning");
  }
}

export async function actionBookmarkGoto(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const bookmarks = collectLabeledBookmarks(ctx);
  if (bookmarks.length === 0) {
    ctx.ui.notify("当前会话还没有保存任何剧情书签。使用 Alt+B 或 /rp save 创建一个吧！", "info");
    return;
  }

  let target = argsText.trim()
    ? bookmarks.find((b) => b.label === argsText.trim() || b.label.includes(argsText.trim()))
    : undefined;

  if (!target) {
    const opts = bookmarks.map((b, i) => `🔖 #${i + 1}  ${b.label}  (${b.targetId.slice(0, 8)})`);
    const pick = await ctx.ui.select(`🔖 跳转到剧情书签（共 ${bookmarks.length} 个）`, opts);
    if (!pick) return;
    target = bookmarks[opts.indexOf(pick)];
  }
  if (!target) {
    ctx.ui.notify(`未找到书签：${argsText}`, "error");
    return;
  }

  const modePick = await ctx.ui.select(`跳转到「${target.label}」的方式`, [
    "⏪ 原地回溯到该书签（navigateTree，世界状态自动精确还原）",
    ...(typeof ctx.fork === "function" ? ["🌿 从该书签分叉出新剧情线（fork，保留当前分支）"] : []),
    "✕ 取消",
  ]);
  if (!modePick || modePick.startsWith("✕")) return;

  if (modePick.startsWith("🌿") && typeof ctx.fork === "function") {
    const res = await ctx.fork(target.targetId);
    if (!res?.cancelled) {
      rt.reloadRuntime(ctx);
      rt.refreshHud(ctx);
      ctx.ui.notify(`已从书签「${target.label}」创建新剧情分支。`, "info");
    }
    return;
  }

  if (typeof ctx.navigateTree === "function") {
    const res = await ctx.navigateTree(target.targetId);
    if (!res?.cancelled) {
      rt.reloadRuntime(ctx);
      rt.refreshHud(ctx);
      ctx.ui.notify(`已回溯至书签「${target.label}」，所有数值与事实账本已同步还原。`, "info");
    }
  } else {
    ctx.ui.notify("当前环境不支持 navigateTree，请使用 Pi 原生 /tree 选择节点。", "info");
  }
}

/** Humanized floor hiding with readable snippet previews and dual (entryId + fingerprint) matching. */
export async function actionToggleHide(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
  hide: boolean,
): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const msgEntries = branch.filter(
    (e) => e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant"),
  );

  if (msgEntries.length === 0) {
    ctx.ui.notify("当前分支暂无可隐藏的对话楼层。", "info");
    return;
  }

  const arg = argsText.trim();
  if (arg) {
    const count = Math.max(1, Number(arg) || 1);
    const targets = msgEntries.slice(-count);
    const ids = targets.map((e) => e.id);
    const fps = targets.map((e) => computeMessageFingerprint(e.message!));
    rt.commitTx({ kind: "hide_toggle", entryIds: ids, fingerprints: fps, hidden: hide });
    ctx.ui.notify(`已${hide ? "隐藏" : "恢复"}最近 ${ids.length} 条对话楼层（非破坏性，不删日志）。`, "info");
    return;
  }

  // Interactive floor picker showing last 16 messages with status badges
  const recent = msgEntries.slice(-16).reverse();
  const opts = recent.map((e, idx) => {
    const fp = computeMessageFingerprint(e.message!);
    const isHidden = state.hiddenEntryIds.has(e.id) || state.hiddenFingerprints.has(fp);
    const roleTag = e.message!.role === "user" ? "玩家" : "叙事";
    const badge = isHidden ? "🙈已隐藏" : "👁可见";
    return `${idx + 1}. [${badge}] [${roleTag}] ${previewText(extractMsgPlain(e.message), 50)}`;
  });

  const pick = await ctx.ui.select(
    hide ? "🙈 选择要隐藏（不发给模型）的对话楼层" : "👁 选择要恢复显示的对话楼层",
    [...opts, ...(hide ? [] : ["✨ 一键恢复全部已隐藏楼层"]), "✕ 返回"],
  );
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("✨")) {
    rt.commitTx({
      kind: "hide_toggle",
      entryIds: Array.from(state.hiddenEntryIds),
      fingerprints: Array.from(state.hiddenFingerprints),
      hidden: false,
    });
    ctx.ui.notify("已恢复全部隐藏楼层。", "info");
    return;
  }

  const idx = opts.indexOf(pick);
  const chosen = recent[idx];
  if (!chosen) return;
  const fp = computeMessageFingerprint(chosen.message!);
  const currentlyHidden = state.hiddenEntryIds.has(chosen.id) || state.hiddenFingerprints.has(fp);
  const nextHidden = !currentlyHidden;
  rt.commitTx({ kind: "hide_toggle", entryIds: [chosen.id], fingerprints: [fp], hidden: nextHidden });
  ctx.ui.notify(`该楼层已设为：${nextHidden ? "隐藏（模型不可见）" : "恢复可见"}`, "info");
}

/** Humanized `/rp roll` & `Alt+G`: supports direct syntax OR 1-click dice presets + optional DC. */
export async function actionManualRoll(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const trimmed = argsText.trim();
  let expr = "";
  let dc: number | undefined;
  let reason = "";

  if (trimmed) {
    const dcMatch = /\bdc\s*(\d+)/i.exec(trimmed);
    dc = dcMatch ? Number(dcMatch[1]) : undefined;
    expr = trimmed.replace(/\bdc\s*\d+/i, "").trim() || "1d20";
  } else {
    const presetPick = await ctx.ui.select("🎲 快捷掷骰检定器", [
      "1d20 — 标准二十面骰 (D&D / 通用)",
      "2d20kh1 — 优势检定（掷 2 颗取高）",
      "2d20kl1 — 劣势检定（掷 2 颗取低）",
      "1d100 — 百分骰 (COC / 技能检定)",
      "2d6 — 双六面骰 (PbtA / 经典叙事)",
      "✏️ 输入自定义公式（如 4d6kh3+2）",
    ]);
    if (!presetPick) return;
    if (presetPick.startsWith("✏️")) {
      const custom = (await ctx.ui.input("输入掷骰公式（支持 kh/kl 与 +/- 修正）", "1d20+3"))?.trim();
      if (!custom) return;
      expr = custom;
    } else {
      expr = presetPick.split(" ")[0]!;
    }

    const dcPick = await ctx.ui.select("设置检定难度 (DC，可选)", [
      "不设难度（仅输出点数）",
      "DC 10（简单）",
      "DC 15（中等）",
      "DC 20（困难）",
      "✏️ 自定义 DC",
    ]);
    if (dcPick?.startsWith("DC ")) {
      dc = Number(dcPick.split(" ")[1]);
    } else if (dcPick?.startsWith("✏️")) {
      const d = Number((await ctx.ui.input("输入目标 DC", "12"))?.trim());
      if (Number.isFinite(d) && d > 0) dc = d;
    }

    reason = (await ctx.ui.input("检定事由（可留空）", ""))?.trim() ?? "";
  }

  try {
    const res = rollDiceCheck({ expression: expr, dc });
    const outcomeText =
      res.critical === "nat_max"
        ? "大成功 ★"
        : res.critical === "nat_min"
          ? "大失败 ✖"
          : res.success === true
            ? "检定成功 ✓"
            : res.success === false
              ? "检定失败 ✗"
              : null;
    const keptText =
      res.keptRolls.length !== res.rolls.length ? `  保留 [${res.keptRolls.join(", ")}]` : "";
    const lines = [
      `公式：${res.expression}${reason ? `  ·  事由：${reason}` : ""}`,
      `骰面：[${res.rolls.join(", ")}]${keptText}${res.modifier ? `  修正 ${res.modifier >= 0 ? "+" : ""}${res.modifier}` : ""}`,
      `总计：${res.total}${dc !== undefined ? `  /  DC ${dc}` : ""}${outcomeText ? `  →  ${outcomeText}` : ""}`,
    ];
    rt.pi.sendMessage(
      {
        customType: "rp:event",
        content: lines.join("\n"),
        display: true,
        details: {
          kind: "roll",
          title: `掷骰 ${res.expression}`,
          subtitle: outcomeText ?? `结果 ${res.total}`,
          ...res,
        },
      },
      { triggerTurn: false },
    );
  } catch (err) {
    ctx.ui.notify(`无效掷骰公式：${(err as Error).message}`, "error");
  }
}

export async function actionSkipMontage(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  let desc = argsText.trim();
  if (!desc) {
    const entered = await ctx.ui.input("⏳ 跳过时间 / 幕间蒙太奇（如：3天后、次日清晨、进入第二幕）", "次日清晨");
    if (!entered?.trim()) return;
    desc = entered.trim();
  }
  const dayMatch = /(\d+)\s*(天|日|days?)/i.exec(desc);
  const dayDelta = dayMatch ? Number(dayMatch[1]) : 1;
  const nextEra = /幕|章|Act/i.test(desc) ? desc : state.era;

  rt.commitTx({
    kind: "era_advance",
    fromEra: state.era,
    toEra: nextEra,
    milestoneUnlocked: [],
    montageSummary: desc,
    turn: state.turn,
  });
  rt.commitTx({
    kind: "clock_tick",
    beatDelta: 0,
    dayDelta,
    worldTimeLabel: `Day ${state.day + dayDelta} (${desc})`,
  });
  rt.refreshHud(ctx);
  rt.pi.sendMessage(
    {
      customType: "rp:era",
      content: `时光流转：${desc}\n请写一段简短、富有画面感的过渡蒙太奇，并自然切入新时间点后的下一场戏。`,
      display: true,
      details: { fromEra: state.era, toEra: nextEra, kind: "montage" },
    },
    { triggerTurn: true },
  );
}

/** Humanized multi-character co-cast manager (interactive checklist + CLI subcommands). */
export async function actionManageCast(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const [sub, slug] = argsText.trim().split(/\s+/);
  if (sub === "add" && slug) {
    const resolved = resolveCardBySlug(ctx.cwd, slug);
    if (!resolved) {
      ctx.ui.notify(`未找到角色卡：${slug}`, "error");
      return;
    }
    const next = Array.from(new Set([...state.activeCharacters, slug]));
    rt.commitTx({ kind: "cast_set", slugs: next });
    rt.reloadRuntime(ctx);
    rt.refreshHud(ctx);
    ctx.ui.notify(`已将「${resolved.card.identity.name}」加入同场共演。`, "info");
    return;
  }
  if (sub === "remove" && slug) {
    if (slug === state.cardSlug) {
      ctx.ui.notify("无法移除主角色卡，请使用 /rp load 切换主角色。", "warning");
      return;
    }
    const next = state.activeCharacters.filter((s) => s !== slug);
    rt.commitTx({ kind: "cast_set", slugs: next });
    rt.reloadRuntime(ctx);
    rt.refreshHud(ctx);
    ctx.ui.notify(`已将 ${slug} 移出同场共演。`, "info");
    return;
  }

  // Interactive checklist of all cards in library
  const allCards = listAllCardSummaries(ctx.cwd);
  while (true) {
    const curr = new Set(rt.getState().activeCharacters);
    const opts = allCards.map((c) => {
      const isPrimary = c.slug === rt.getState().cardSlug;
      const inCast = curr.has(c.slug);
      const badge = isPrimary ? "★主卡" : inCast ? "✅共演中" : "⬜未上场";
      return `${badge}  ${c.name} (${c.slug})`;
    });
    const pick = await ctx.ui.select(
      `👥 同场共演管理（当前 ${rt.getState().activeCharacters.length} 张卡，点击切换上场/退场）`,
      [...opts, "✕ 完成"],
    );
    if (!pick || pick.startsWith("✕")) return;
    const idx = opts.indexOf(pick);
    const chosen = allCards[idx];
    if (!chosen) continue;
    if (chosen.slug === rt.getState().cardSlug) {
      ctx.ui.notify("主角色卡始终在场；如需更换主角色请使用 /rp load。", "info");
      continue;
    }
    const next = curr.has(chosen.slug)
      ? rt.getState().activeCharacters.filter((s) => s !== chosen.slug)
      : [...rt.getState().activeCharacters, chosen.slug];
    rt.commitTx({ kind: "cast_set", slugs: next });
    rt.reloadRuntime(ctx);
    rt.refreshHud(ctx);
    ctx.ui.notify(
      curr.has(chosen.slug) ? `「${chosen.name}」已退场` : `「${chosen.name}」已加入同场共演（含世界书联动）`,
      "info",
    );
  }
}

export async function actionSelectPacing(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim().toLowerCase();
  let mode: PacingMode | undefined;
  if (arg === "relaxed" || arg === "balanced" || arg === "dramatic") {
    mode = arg;
  } else {
    const pick = await ctx.ui.select(`🎚 选择叙事节奏（当前：${state.pacingMode}）`, [
      "relaxed — 舒缓细腻，注重环境氛围与心理互动",
      "balanced — 均衡自然（默认）",
      "dramatic — 紧张强冲突，积极推进时钟与悬念",
    ]);
    if (!pick) return;
    mode = pick.split(" ")[0] as PacingMode;
  }
  rt.commitTx({ kind: "config_patch", pacingMode: mode });
  rt.refreshHud(ctx);
  ctx.ui.notify(`叙事节奏已切换为：${mode}`, "info");
}

export async function actionSetHud(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim() as HudMode;
  let next: HudMode;
  if (arg === "minimal" || arg === "full" || arg === "off") {
    next = arg;
  } else {
    next = state.hudMode === "minimal" ? "full" : state.hudMode === "full" ? "off" : "minimal";
  }
  rt.commitTx({ kind: "config_patch", hudMode: next });
  rt.refreshHud(ctx);
  const zh: Record<HudMode, string> = { minimal: "极简状态栏", full: "完整世界面板条", off: "隐藏" };
  ctx.ui.notify(`HUD 模式：${zh[next]}`, "info");
}

export async function actionSetSettlementMode(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim() as SettlementMode;
  let next: SettlementMode | undefined;
  if (arg === "off" || arg === "tool-assisted" || arg === "sidecar-light") {
    next = arg;
  } else {
    const pick = await ctx.ui.select(`⚙ 选择结算模式（当前：${state.settlementMode}）`, [
      "tool-assisted — 零额外调用，按需工具更新状态（默认推荐）",
      "sidecar-light — 回合结束后后台异步提炼事实、信念与伏笔（零首字延迟）",
      "off — 仅基础时间推进，完全关闭自动结算",
    ]);
    if (!pick) return;
    next = pick.split(" ")[0] as SettlementMode;
  }
  rt.commitTx({ kind: "config_patch", settlementMode: next });
  rt.refreshHud(ctx);
  ctx.ui.notify(`结算模式已切换为：${next}`, "info");
}

export async function actionToggleRawPassthrough(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const state = rt.getState();
  if (!state.active || !state.cardSlug || !state.worldDir) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const arg = argsText.trim().toLowerCase();
  const next = arg === "on" ? true : arg === "off" ? false : !state.rawPassthrough;
  const rawJson = loadRawCardJson(state.worldDir, state.cardSlug);
  const currentCard = rt.getCard();
  if (rawJson && currentCard) {
    const recompiled = compileCharacterCard(rawJson, currentCard.specOrigin, {
      rawPassthrough: next,
    });
    saveCompiledCard({ baseDir: state.worldDir, card: recompiled, rawJson });
  }
  rt.commitTx({ kind: "config_patch", rawPassthrough: next });
  rt.reloadRuntime(ctx);
  rt.refreshHud(ctx);
  ctx.ui.notify(
    `原味直通模式：${next ? "已开启（完全跳过前端壳剥离）" : "已关闭（智能剥离酒馆前端壳，保留 100% 灵魂设定）"}`,
    "info",
  );
}

export async function actionShowShortcuts(ctx: PiExtensionContext): Promise<void> {
  await ctx.ui.select(
    "⌨️ RP 快捷键速查（Pi 原生 /hotkeys 也可查看全部绑定）",
    [...RP_SHORTCUT_LIST.map((s) => `${s.key.padEnd(14)}  ${s.label} — ${s.description}`), "✕ 关闭"],
  );
}
