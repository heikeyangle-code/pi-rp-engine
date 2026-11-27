/**
 * All 11 high-frequency RP player workflows implemented 100% via Official Pi 1.6.1 Extension APIs:
 *  1. Greeting switcher (`alternate_greetings`)
 *  2. Persona manager (`/rp persona`)
 *  3. Director note / temporary injection (`/rp note`)
 *  4. Seamless continue (`/rp c`)
 *  5. Action inspiration / impersonate -> `ctx.ui.setEditorText` (`/rp act`)
 *  6. OOC channel (`/rp ooc` & `((...))`)
 *  7. Non-destructive floor hide/unhide (`/rp hide`, `/rp unhide`)
 *  8. Bookmark / quick rewind (`/rp save`, `/rp goto`)
 *  9. Manual roll + timeskip (`/rp roll`, `/rp skip`)
 * 10. Multi-character cast (`/rp cast`)
 * 11. Raw passthrough + Preset manager + Import audit report (`/rp raw`, `/rp preset`, `/rp import`, `/rp info`)
 */

import * as path from "node:path";
import type {
  CompiledCard,
  CompiledPreset,
  PersonaProfile,
  PiExtensionAPI,
  PiExtensionContext,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "../engine/state-replay.js";
import { rollDiceCheck } from "../engine/dice.js";
import { unpackFile } from "../parser/unpack.js";
import { compileCharacterCard } from "../parser/card-compiler.js";
import { compileLoreBook } from "../parser/lore-compiler.js";
import { compileSillyTavernPreset } from "../parser/preset.js";
import { evaluateMacros } from "../parser/macros.js";
import {
  getGlobalLibraryDir,
  getProjectRpDir,
  listCardSlugs,
  listPresetIds,
  loadCompiledPreset,
  loadPersonas,
  mergeExternalLoreBook,
  resolveCardBySlug,
  saveCompiledCard,
  saveCompiledPreset,
  savePersona,
  saveProjectWorldConfig,
} from "../storage/workspace-store.js";
import { buildMemSceneCompactionSummary } from "../memory/compaction.js";
import { getActiveFacts } from "../memory/bitemporal.js";

export interface RpActionRuntime {
  pi: PiExtensionAPI;
  getState: () => SessionRpState;
  getCard: () => CompiledCard | null;
  getPreset: () => CompiledPreset | null;
  reloadRuntime: (ctx: PiExtensionContext) => void;
  activateRpTools: () => void;
  restoreOriginalTools: () => void;
  refreshHud: (ctx: PiExtensionContext) => void;
  markNextTurnOoc: () => void;
}

export function formatImportAuditSummary(card: CompiledCard): string {
  const r = card.importReport;
  const lines = [
    `✅ 已导入角色卡：${card.identity.name}（${card.slug} · ${r.specOrigin.toUpperCase()}）`,
    `- 灵魂保留：${r.preservedFields.join(", ") || "基础字段"}（mes_example ${r.mesExampleCharsAfter}/${r.mesExampleCharsBefore} 字符）`,
    `- 世界书：共 ${r.loreCount} 条（常驻蓝灯 ${r.constantLoreCount} · 动态 ${r.dynamicLoreCount}）`,
    `- 剥离 1.0 前端壳：${r.strippedItems.length} 处 · 合并重复防越权：${r.deduplicatedRules.length} 处`,
    `- 抢救状态变量：${r.salvagedVariables.length} 项${r.salvagedVariables.length ? `（${r.salvagedVariables.slice(0, 6).map((v) => v.key).join(", ")}）` : ""}`,
  ];
  if (r.skippedAssets.length > 0) {
    lines.push(`- 跳过 Web 专有资产：${r.skippedAssets.map((a) => `${a.name}(${a.type})`).join(", ")}`);
  }
  if (r.warnings.length > 0) {
    lines.push(`- 提醒：${r.warnings.slice(0, 3).join("；")}`);
  }
  return lines.join("\n");
}

function appendAndApply(rt: RpActionRuntime, ctx: PiExtensionContext, tx: RpTxEntry): void {
  rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
  applyRpTx(rt.getState(), tx);
  rt.refreshHud(ctx);
}

export async function actionImportFile(rt: RpActionRuntime, ctx: PiExtensionContext, rawPath: string): Promise<void> {
  const inputPath = rawPath.trim() || (await ctx.ui.input("导入角色卡 / 世界书 / 预设", "输入 .png / .charx / .json 文件路径"));
  if (!inputPath) return;

  const resolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(ctx.cwd, inputPath);
  let unpacked;
  try {
    unpacked = unpackFile(resolved);
  } catch (err) {
    ctx.ui.notify(`导入失败：${(err as Error).message}`, "error");
    return;
  }

  const targetChoice = await ctx.ui.select("保存到哪里？", [
    "当前项目世界 (.pi/rp/) — 推荐长篇大卡",
    "全局角色库 (~/.pi/agent/rp-library/) — 适合轻卡复用",
  ]);
  if (!targetChoice) return;
  const scope: "project" | "library" = targetChoice.startsWith("当前项目") ? "project" : "library";
  const baseDir = scope === "project" ? getProjectRpDir(ctx.cwd) : getGlobalLibraryDir();

  if (unpacked.kind === "preset") {
    const preset = compileSillyTavernPreset(unpacked.rawJson, {
      name: path.basename(resolved, path.extname(resolved)),
    });
    saveCompiledPreset(baseDir, preset);
    if (rt.getState().active) {
      appendAndApply(rt, ctx, { kind: "preset_set", presetId: preset.id });
    }
    ctx.ui.notify(
      `✅ 已导入预设「${preset.name}」(${preset.id})：Zone 1 前缀 ${preset.zone1Prompts.length} 条，Zone 3 尾部 ${preset.zone3Prompts.length} 条`,
      "info",
    );
    return;
  }

  if (unpacked.kind === "lorebook") {
    const state = rt.getState();
    const targetSlug = state.cardSlug;
    if (!targetSlug) {
      ctx.ui.notify("请先加载或导入一张角色卡，再挂载独立世界书。", "warning");
      return;
    }
    const extraBook = compileLoreBook(unpacked.rawJson);
    const merged = mergeExternalLoreBook(state.worldDir || baseDir, targetSlug, extraBook);
    if (!merged) {
      ctx.ui.notify("未找到当前绑定的角色卡文件，合并世界书失败。", "error");
      return;
    }
    rt.reloadRuntime(ctx);
    ctx.ui.notify(`✅ 已为「${merged.identity.name}」合并 ${extraBook.entries.length} 条世界书`, "info");
    return;
  }

  // Character card
  const compiled = compileCharacterCard(unpacked.rawJson, unpacked.specOrigin);
  saveCompiledCard({
    baseDir,
    card: compiled,
    rawJson: unpacked.rawJson,
    avatarPng: unpacked.avatarPng,
    assets: unpacked.assets,
  });

  if (scope === "project") {
    saveProjectWorldConfig(ctx.cwd, {
      defaultCardSlug: compiled.slug,
      activeCharacters: [compiled.slug],
    });
  }

  ctx.ui.notify(formatImportAuditSummary(compiled), "info");

  const bindNow = await ctx.ui.confirm("立即开局？", `将当前对话绑定到「${compiled.identity.name}」并加载开场白？`);
  if (bindNow) {
    await actionBindCard(rt, ctx, compiled, baseDir, scope);
  }
}

export async function actionBindCard(
  rt: RpActionRuntime,
  ctx: PiExtensionContext,
  card: CompiledCard,
  baseDir: string,
  source: "project" | "library",
): Promise<void> {
  const greetings = [card.greetings.firstMes, ...card.greetings.alternates].filter((g) => g.trim().length > 0);
  let chosenIdx = 0;
  if (greetings.length > 1) {
    const options = greetings.map((g, i) => `${i === 0 ? "默认开场" : `备选开场 #${i}`}：${g.replace(/\s+/g, " ").slice(0, 48)}…`);
    const picked = await ctx.ui.select(`选择「${card.identity.name}」开场白`, options);
    if (picked) {
      const idx = options.indexOf(picked);
      if (idx >= 0) chosenIdx = idx;
    }
  }

  appendAndApply(rt, ctx, {
    kind: "bind",
    cardId: card.id,
    cardSlug: card.slug,
    cardSource: source,
    worldDir: baseDir,
    greetingIndex: chosenIdx,
    activeCharacters: [card.slug],
    rawPassthrough: card.rawPassthrough,
  });

  // Seed salvaged MVU/macro variables into L1 state automatically
  for (const v of card.salvagedStateSchema) {
    appendAndApply(rt, ctx, {
      kind: "stat_patch",
      actorId: "player",
      key: v.key,
      op: "set",
      value: v.initialValue,
      min: v.min,
      max: v.max,
      reason: `salvaged:${v.source}`,
    });
  }

  rt.activateRpTools();
  rt.reloadRuntime(ctx);

  const greetingText = greetings[chosenIdx];
  if (greetingText) {
    const state = rt.getState();
    const rendered = evaluateMacros(greetingText, {
      charName: card.identity.nickname || card.identity.name,
      userName: state.currentPersona.name,
      worldTime: state.worldTimeLabel,
      worldDate: `Day ${state.day}`,
    });
    rt.pi.sendMessage(
      { customType: "rp:greeting", content: rendered, display: true, details: { cardSlug: card.slug, greetingIndex: chosenIdx } },
      { triggerTurn: false },
    );
  }
}

export async function actionLoadCard(rt: RpActionRuntime, ctx: PiExtensionContext, slugArg?: string): Promise<void> {
  let slug = slugArg?.trim();
  if (!slug) {
    const projSlugs = listCardSlugs(getProjectRpDir(ctx.cwd)).map((s) => `project:${s}`);
    const libSlugs = listCardSlugs(getGlobalLibraryDir()).map((s) => `library:${s}`);
    const all = [...projSlugs, ...libSlugs];
    if (all.length === 0) {
      ctx.ui.notify("暂无已导入的角色卡，请先运行 /rp import <路径> 导入。", "warning");
      return;
    }
    const picked = await ctx.ui.select("选择要加载的角色卡", all);
    if (!picked) return;
    slug = picked.replace(/^(?:project|library):/, "");
  }

  const resolved = resolveCardBySlug(ctx.cwd, slug);
  if (!resolved) {
    ctx.ui.notify(`未找到角色卡 "${slug}"`, "error");
    return;
  }
  await actionBindCard(rt, ctx, resolved.card, resolved.baseDir, resolved.source);
}

export async function actionSwitchGreeting(rt: RpActionRuntime, ctx: PiExtensionContext): Promise<void> {
  const card = rt.getCard();
  if (!card) {
    ctx.ui.notify("当前未激活角色卡。", "warning");
    return;
  }
  const greetings = [card.greetings.firstMes, ...card.greetings.alternates].filter((g) => g.trim().length > 0);
  if (greetings.length === 0) {
    ctx.ui.notify("该角色卡没有可用开场白。", "info");
    return;
  }
  const options = greetings.map((g, i) => `${i === 0 ? "默认开场" : `备选 #${i}`}：${g.replace(/\s+/g, " ").slice(0, 50)}…`);
  const picked = await ctx.ui.select("切换开场白", options);
  if (!picked) return;
  const idx = options.indexOf(picked);
  if (idx < 0) return;
  const state = rt.getState();
  const rendered = evaluateMacros(greetings[idx]!, {
    charName: card.identity.nickname || card.identity.name,
    userName: state.currentPersona.name,
    worldTime: state.worldTimeLabel,
    worldDate: `Day ${state.day}`,
  });
  rt.pi.sendMessage(
    { customType: "rp:greeting", content: rendered, display: true, details: { cardSlug: card.slug, greetingIndex: idx } },
    { triggerTurn: false },
  );
}

export async function actionManagePersona(rt: RpActionRuntime, ctx: PiExtensionContext): Promise<void> {
  const personas = loadPersonas(ctx.cwd);
  const options = [
    ...personas.map((p) => `${p.name}${p.description ? ` — ${p.description.slice(0, 32)}` : ""}`),
    "+ 新建/编辑玩家马甲",
  ];
  const picked = await ctx.ui.select(`当前马甲：${rt.getState().currentPersona.name}`, options);
  if (!picked) return;

  if (picked.startsWith("+")) {
    const name = await ctx.ui.input("马甲名称", rt.getState().currentPersona.name);
    if (!name?.trim()) return;
    const desc = (await ctx.ui.editor("马甲简介（外貌/身份/背景）", rt.getState().currentPersona.description)) ?? "";
    const profile: PersonaProfile = {
      id: name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-") || "persona",
      name: name.trim(),
      description: desc.trim(),
    };
    savePersona(ctx.cwd, profile, "project");
    appendAndApply(rt, ctx, { kind: "persona_set", persona: profile });
    ctx.ui.notify(`✅ 已切换玩家马甲为「${profile.name}」`, "info");
    return;
  }

  const idx = options.indexOf(picked);
  const chosen = personas[idx];
  if (chosen) {
    appendAndApply(rt, ctx, { kind: "persona_set", persona: chosen });
    ctx.ui.notify(`✅ 已切换玩家马甲为「${chosen.name}」`, "info");
  }
}

export async function actionDirectorNote(rt: RpActionRuntime, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const trimmed = argsText.trim();
  if (trimmed === "clear") {
    appendAndApply(rt, ctx, { kind: "note_clear" });
    ctx.ui.notify("已清空全部导演便签。", "info");
    return;
  }
  let text = trimmed;
  let ttl: number | null = null;
  const ttlMatch = /--ttl\s+(\d+)/i.exec(text);
  if (ttlMatch) {
    ttl = Math.max(1, parseInt(ttlMatch[1]!, 10));
    text = text.replace(ttlMatch[0], "").trim();
  }
  if (!text) {
    const edited = await ctx.ui.editor("输入导演便签 / 临时剧情引导（留空取消）", rt.getState().notes.map((n) => n.text).join("\n"));
    if (!edited?.trim()) return;
    text = edited.trim();
  }
  appendAndApply(rt, ctx, {
    kind: "note_set",
    note: { id: `note_${Date.now()}`, text, remainingTurns: ttl },
  });
  ctx.ui.notify(`📌 已挂载导演便签${ttl ? `（有效期 ${ttl} 轮）` : "（常驻直至清除）"}`, "info");
}

export function actionContinue(rt: RpActionRuntime, ctx: PiExtensionContext): void {
  if (!rt.getState().active) {
    ctx.ui.notify("当前未处于 RP 模式。", "warning");
    return;
  }
  const nudge =
    rt.getPreset()?.utilityPrompts.continueNudge?.trim() ||
    "请紧接上文自然续写下一段剧情与人物反应，不要重复前文已写过的内容。";
  rt.pi.sendMessage({ customType: "rp:continue", content: nudge, display: false }, { triggerTurn: true });
}

export async function actionSuggestPlayerMoves(rt: RpActionRuntime, ctx: PiExtensionContext, hint: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前未处于 RP 模式。", "warning");
    return;
  }
  if (!ctx.modelRegistry?.complete || !ctx.model) {
    ctx.ui.notify("当前环境不支持模型补全，无法生成行动灵感。", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const recent = branch
    .filter((e) => e.type === "message" && e.message)
    .slice(-4)
    .map((e) => `${e.message!.role}: ${typeof e.message!.content === "string" ? e.message!.content : ""}`)
    .join("\n")
    .slice(-1800);

  const sysPrompt =
    rt.getPreset()?.utilityPrompts.impersonation?.trim() ||
    `你正在帮玩家「${state.currentPersona.name}」构思下一步角色扮演行动。请严格输出 3 行不同风格的行动建议，每行以「1. 」「2. 」「3. 」开头，直接用玩家视角可发送的文字写出。`;

  try {
    const resp = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt: sysPrompt,
      messages: [
        {
          role: "user",
          content: `当前场景：${state.location || "未定"} (${state.era}, ${state.worldTimeLabel})\n近期对话：\n${recent}\n${hint ? `玩家偏好提示：${hint}` : ""}`,
        },
      ],
    });
    const raw =
      resp?.text ??
      resp?.content
        ?.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("") ??
      "";
    const lines = raw
      .split("\n")
      .map((l) => l.replace(/^\s*[\d]+[.)、]\s*/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, 3);
    if (lines.length === 0) {
      ctx.ui.notify("未能生成行动建议，请重试。", "warning");
      return;
    }
    const picked = await ctx.ui.select("选择一个行动灵感（将回填到输入框）", lines);
    if (picked) {
      ctx.ui.setEditorText(picked);
      ctx.ui.notify("已填入输入框，可微调后发送。", "info");
    }
  } catch (err) {
    ctx.ui.notify(`生成行动灵感失败：${(err as Error).message}`, "error");
  }
}

export async function actionOoc(rt: RpActionRuntime, ctx: PiExtensionContext, text: string): Promise<void> {
  const msg = text.trim() || (await ctx.ui.input("场外 OOC 沟通（不入角色记忆与状态账本）", "输入给导演/AI 的场外说明"));
  if (!msg?.trim()) return;
  rt.markNextTurnOoc();
  rt.pi.sendMessage({ customType: "rp:ooc", content: `((OOC: ${msg.trim()}))`, display: true }, { triggerTurn: true });
}

export async function actionToggleHide(rt: RpActionRuntime, ctx: PiExtensionContext, hide: boolean): Promise<void> {
  const state = rt.getState();
  const branch = ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message);
  if (branch.length === 0) {
    ctx.ui.notify("当前分支暂无可操作的对话楼层。", "info");
    return;
  }
  const candidates = hide
    ? branch.filter((e) => !state.hiddenEntryIds.has(e.id)).slice(-15)
    : branch.filter((e) => state.hiddenEntryIds.has(e.id));

  if (candidates.length === 0) {
    ctx.ui.notify(hide ? "没有可屏蔽的楼层。" : "当前没有已屏蔽的楼层。", "info");
    return;
  }
  const options = candidates.map((e) => {
    const raw = typeof e.message!.content === "string" ? e.message!.content : "[富内容]";
    return `[${e.id.slice(0, 6)}] ${e.message!.role}: ${raw.replace(/\s+/g, " ").slice(0, 44)}`;
  });
  const picked = await ctx.ui.select(hide ? "选择要屏蔽的楼层（仅发往模型时跳过）" : "选择要恢复的楼层", options);
  if (!picked) return;
  const idx = options.indexOf(picked);
  const target = candidates[idx];
  if (target) {
    appendAndApply(rt, ctx, { kind: "hide_toggle", entryIds: [target.id], hidden: hide });
    ctx.ui.notify(hide ? "已屏蔽该楼层（不删记录，可随时 /rp unhide 恢复）。" : "已恢复该楼层。", "info");
  }
}

export async function actionBookmarkSave(rt: RpActionRuntime, ctx: PiExtensionContext, nameArg: string): Promise<void> {
  const name = nameArg.trim() || (await ctx.ui.input("保存剧情书签", "例如：初入老金沟"));
  if (!name?.trim()) return;
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId || !rt.pi.setLabel) {
    ctx.ui.notify("当前会话节点不支持打书签。", "warning");
    return;
  }
  rt.pi.setLabel(leafId, `🔖 ${name.trim()}`);
  ctx.ui.notify(`🔖 已在当前节点保存书签「${name.trim()}」`, "info");
}

export async function actionBookmarkGoto(rt: RpActionRuntime, ctx: PiExtensionContext): Promise<void> {
  const entries = ctx.sessionManager.getEntries().filter((e) => typeof e.label === "string" && (e.label as string).startsWith("🔖"));
  if (entries.length === 0) {
    ctx.ui.notify("当前会话还没有保存过 🔖 书签（用 /rp save <名称> 保存）。", "info");
    return;
  }
  const options = entries.map((e) => `${e.label as string} (${e.id.slice(0, 6)})`);
  const picked = await ctx.ui.select("选择要回档的书签（状态将自动随分支回滚）", options);
  if (!picked) return;
  const idx = options.indexOf(picked);
  const target = entries[idx];
  if (target && ctx.navigateTree) {
    await ctx.navigateTree(target.id);
    rt.reloadRuntime(ctx);
    ctx.ui.notify(`✅ 已回档至 ${target.label as string}`, "info");
  }
}

export function actionManualRoll(rt: RpActionRuntime, ctx: PiExtensionContext, exprArg: string): void {
  const expr = exprArg.trim() || "1d20";
  try {
    const res = rollDiceCheck({ expression: expr });
    const msg = `🎲 手动掷骰 ${res.expression} = [${res.rolls.join(", ")}]${res.modifier ? (res.modifier > 0 ? `+${res.modifier}` : `${res.modifier}`) : ""} → **${res.total}**`;
    rt.pi.sendMessage({ customType: "rp:event", content: msg, display: true, details: res }, { triggerTurn: false });
  } catch (err) {
    ctx.ui.notify((err as Error).message, "error");
  }
}

export async function actionTimeSkip(rt: RpActionRuntime, ctx: PiExtensionContext, labelArg: string): Promise<void> {
  const label = labelArg.trim() || (await ctx.ui.input("时间推进 / 幕间蒙太奇", "例如：三日后 · 霜降"));
  if (!label?.trim()) return;
  appendAndApply(rt, ctx, { kind: "clock_tick", beatDelta: 1, dayDelta: 1, worldTimeLabel: label.trim() });
  const summary = buildMemSceneCompactionSummary(rt.getState());
  rt.pi.sendMessage(
    { customType: "rp:event", content: `⏳ 时间推进至 **${label.trim()}**\n\n${summary}`, display: true },
    { triggerTurn: false },
  );
}

export async function actionManageCast(rt: RpActionRuntime, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const [sub, targetSlug] = argsText.trim().split(/\s+/);
  if (sub === "add" && targetSlug) {
    if (!resolveCardBySlug(ctx.cwd, targetSlug)) {
      ctx.ui.notify(`未找到角色卡 "${targetSlug}"`, "error");
      return;
    }
    const next = Array.from(new Set([...state.activeCharacters, targetSlug]));
    appendAndApply(rt, ctx, { kind: "cast_set", slugs: next });
    ctx.ui.notify(`🎭 已将「${targetSlug}」加入同场卡组`, "info");
    return;
  }
  if (sub === "remove" && targetSlug) {
    const next = state.activeCharacters.filter((s) => s !== targetSlug);
    appendAndApply(rt, ctx, { kind: "cast_set", slugs: next });
    ctx.ui.notify(`🎭 已将「${targetSlug}」移出同场卡组`, "info");
    return;
  }
  ctx.ui.notify(`当前同场卡组：${state.activeCharacters.join(", ") || "（空）"}`, "info");
}

export async function actionSelectPreset(rt: RpActionRuntime, ctx: PiExtensionContext, presetArg?: string): Promise<void> {
  const ids = listPresetIds(ctx.cwd);
  if (presetArg === "off") {
    appendAndApply(rt, ctx, { kind: "preset_set", presetId: null });
    ctx.ui.notify("已关闭外部预设。", "info");
    return;
  }
  let chosen = presetArg?.trim();
  if (!chosen) {
    const options = [...ids, "关闭预设 (off)"];
    const picked = await ctx.ui.select(`当前预设：${rt.getState().presetId ?? "无"}`, options);
    if (!picked) return;
    if (picked.startsWith("关闭预设")) {
      appendAndApply(rt, ctx, { kind: "preset_set", presetId: null });
      ctx.ui.notify("已关闭外部预设。", "info");
      return;
    }
    chosen = picked;
  }
  const preset = loadCompiledPreset(ctx.cwd, chosen);
  if (!preset) {
    ctx.ui.notify(`未找到预设 "${chosen}"（可先用 /rp import 导入 SillyTavern 预设 JSON）`, "error");
    return;
  }
  appendAndApply(rt, ctx, { kind: "preset_set", presetId: preset.id });
  rt.reloadRuntime(ctx);
  ctx.ui.notify(`✅ 已启用预设「${preset.name}」（Zone 1: ${preset.zone1Prompts.length} · Zone 3: ${preset.zone3Prompts.length}）`, "info");
}

export function actionShowInfo(rt: RpActionRuntime, ctx: PiExtensionContext): void {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前未处于 RP 模式（静默休眠中，0 Token 占用）。输入 /rp 打开菜单。", "info");
    return;
  }
  const preset = rt.getPreset();
  const lines = [
    `🎭 角色卡：${card.identity.name} (${card.slug} · ${card.specOrigin})`,
    `👤 马甲：${state.currentPersona.name} · 时代：${state.era} · 回合：T${state.turn} (${state.worldTimeLabel})`,
    `🎛 预设：${preset ? preset.name : "无"} · 结算：${state.settlementMode} · 无损直通：${state.rawPassthrough ? "开" : "关"}`,
    `📚 世界书：${card.loreBook.entries.length} 条 · 有效事实：${getActiveFacts(state).length} · 未收伏笔：${Array.from(state.foresights.values()).filter((h) => h.status === "open").length}`,
  ];
  if (card.meta.creatorNotes) {
    lines.push(`📝 作者说明：${card.meta.creatorNotes.slice(0, 160)}`);
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
