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
  CompiledLoreEntry,
  CompiledPreset,
  ContextXRaySnapshot,
  HudMode,
  MemoryBookEntry,
  NarrativePovMode,
  PacingMode,
  ResponseLengthMode,
  PersonaProfile,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  QuickReplyItem,
  RpTxEntry,
  SessionRpState,
  SettlementMode,
} from "../types.js";
import { unpackFile } from "../parser/unpack.js";
import { compileCharacterCard } from "../parser/card-compiler.js";
import { analyzeCardWithModel, applyAnalyzedProfileToCard, extractHeuristicVoiceAnchor } from "../parser/analyzer.js";
import { compileLoreBook } from "../parser/lore-compiler.js";
import { compileSillyTavernPreset } from "../parser/preset.js";
import { evaluateMacros } from "../parser/macros.js";
import { rollDiceCheck } from "../engine/dice.js";
import {
  buildContinuityDirective,
  computeCalendarAnchor,
  detectLifespanProfile,
  parseTimeSpan,
  type ContinuityMode,
} from "../engine/temporal.js";
import { computeMessageFingerprint } from "../engine/state-replay.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import {
  canCompleteWithRegistry,
  completeWithRegistry,
  extractJsonObject,
  listRegistryModels,
  resolveSidecarModel,
  stripThinkingBlocks,
} from "../engine/llm-helper.js";
import {
  deleteCompiledCard,
  deleteCompiledPreset,
  deletePersona,
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
  saveUpdatedCard,
} from "../storage/workspace-store.js";
import {
  DEFAULT_QUICK_REPLIES,
  loadQuickReplies,
  loadUiPrefs,
  normalizeUserFilePath,
  pickFilesToImport,
  saveQuickReplies,
  saveUiPrefs,
} from "./file-picker.js";
import { RP_SHORTCUT_LIST } from "./shortcuts.js";

export interface RpRuntimeHandle {
  pi: PiExtensionAPI;
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  getPreset(): CompiledPreset | null;
  getLastXRay(): ContextXRaySnapshot | null;
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

/** Normalize both regular `message` entries and Pi's native `custom_message` entries from `getBranch()`. */
function normalizeBranchMessage(e: {
  type: string;
  customType?: string;
  message?: PiMessage;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: number | string;
}): PiMessage | null {
  if (e.type === "message" && e.message) return e.message;
  if (e.type === "custom_message" && e.content !== undefined) {
    const ts = typeof e.timestamp === "number" ? e.timestamp : undefined;
    return {
      role: "custom",
      customType: e.customType,
      content: e.content as PiMessage["content"],
      display: Boolean(e.display),
      details: e.details,
      timestamp: ts,
    };
  }
  return null;
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

let activeWorkingCount = 0;

interface GuardedTaskHandle {
  signal: AbortSignal;
  guardedCtx: PiExtensionContext;
  isStillValid: () => boolean;
  cleanup: () => void;
}

/**
 * Shared guard for async LLM actions:
 * - Ref-counted `workingMessage` (clears only when last task finishes)
 * - 90s timeout chained with `ctx.signal`
 * - Session key, branch leaf & active card CAS check so late responses never pollute a switched session/branch
 */
function beginGuardedLlmTask(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  workingLabel?: string,
  timeoutMs = 90_000,
): GuardedTaskHandle {
  const startSessionKey =
    ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? "";
  const startLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
  const startCardSlug = rt.getState().cardSlug;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (ctx.signal) {
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  if (workingLabel) {
    activeWorkingCount += 1;
    ctx.ui.setWorkingMessage?.(workingLabel);
  }
  const guardedCtx: PiExtensionContext = { ...ctx, signal: controller.signal };
  let cleaned = false;
  return {
    signal: controller.signal,
    guardedCtx,
    isStillValid: () => {
      const curState = rt.getState();
      if (!curState.active || curState.cardSlug !== startCardSlug) return false;
      const curSessionKey =
        ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? "";
      if (curSessionKey !== startSessionKey) return false;
      const curLeaf = ctx.sessionManager?.getLeafId?.() ?? null;
      if (curLeaf !== startLeafId) return false;
      return true;
    },
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      if (ctx.signal) {
        ctx.signal.removeEventListener("abort", onParentAbort);
      }
      if (workingLabel) {
        activeWorkingCount = Math.max(0, activeWorkingCount - 1);
        if (activeWorkingCount === 0) {
          ctx.ui.setWorkingMessage?.(undefined);
        }
      }
    },
  };
}

async function pickGreeting(ctx: PiExtensionContext, card: CompiledCard, quickDefault = false): Promise<number | undefined> {
  const all = [card.greetings.firstMes, ...card.greetings.alternates].filter((g) => g.trim().length > 0);
  if (all.length <= 1 || quickDefault) return 0;

  const opts = all.map((g, i) => `${i === 0 ? "★ 主开场白" : `❖ 备选 #${i}`}  ${previewText(g, 58)}`);
  const pick = await ctx.ui.select(`🎭 选择「${card.identity.name}」的开场白（共 ${all.length} 条）`, opts);
  if (!pick) return undefined;
  const idx = opts.indexOf(pick);
  return idx >= 0 ? idx : undefined;
}

async function pickOrCreatePersona(ctx: PiExtensionContext, current: PersonaProfile): Promise<PersonaProfile | undefined> {
  const saved = loadPersonas(ctx.cwd);
  const prefs = loadUiPrefs();
  const preferred =
    saved.find((p) => p.id === prefs.lastPersonaId) ??
    (current.id !== "default" ? current : saved[0]) ??
    current;

  const others = saved.filter((p) => p.id !== preferred.id);
  const options = [
    `▶ 使用当前/默认人设：${preferred.name}${preferred.description ? ` (${previewText(preferred.description, 28)})` : ""}`,
    ...others.map((p) => `🧑 ${p.name}${p.description ? ` — ${previewText(p.description, 32)}` : ""}`),
    "+ 新建玩家人设（保存到全局库，跨卡通用）",
  ];

  const choice = await ctx.ui.select("🧑 选择本次会话的玩家马甲", options);
  if (!choice) {
    return undefined;
  }
  if (choice.startsWith("▶")) {
    return preferred;
  }
  if (choice.startsWith("+")) {
    const nameRaw = await ctx.ui.input("玩家角色名称", "旅人");
    if (nameRaw === undefined) return undefined;
    const name = nameRaw.trim();
    if (!name) return undefined;
    const descRaw = await ctx.ui.input("简短设定/外貌/身份（可留空）", "");
    if (descRaw === undefined) return undefined;
    const desc = descRaw.trim();
    const profile: PersonaProfile = {
      id: name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").slice(0, 32) || `p_${Date.now()}`,
      name,
      description: desc,
    };
    savePersona(ctx.cwd, profile, "library");
    saveUiPrefs({ lastPersonaId: profile.id });
    return profile;
  }

  const chosenIdx = options.indexOf(choice);
  const matched = chosenIdx >= 1 && chosenIdx <= others.length ? others[chosenIdx - 1] : undefined;
  if (matched) {
    saveUiPrefs({ lastPersonaId: matched.id });
    return matched;
  }
  return preferred;
}

/**
 * Deterministically hydrate ALL 7 narrative dimensions of a CompiledCard's WorldProfile
 * and multi-actor/category-routed `salvagedStateSchema` into the active session.
 * Runs in <2ms with 0 LLM cost whenever binding a card or applying `/rp analyze`.
 */
export function hydrateWorldProfileAndVariables(
  rt: RpRuntimeHandle,
  card: CompiledCard,
  reasonPrefix: "salvaged" | "llm_analyze" = "salvaged",
): void {
  const wp = card.worldProfile;

  // 1. WorldProfile core archetype, modules & spatio-temporal anchors
  if (wp) {
    const s0 = rt.getState();
    rt.commitTx({
      kind: "profile_apply",
      archetype: wp.archetype,
      modules: wp.modules,
      initialStage: wp.modules.stages ? wp.initialStage : undefined,
      initialTime: wp.initialTime,
    });
    const nextLoc = !s0.location && wp.initialLocation ? wp.initialLocation : s0.location;
    const nextNpcs = s0.presentNpcs.length === 0 && wp.initialPresentNpcs.length > 0 ? wp.initialPresentNpcs : s0.presentNpcs;
    if (nextLoc !== s0.location || nextNpcs.join("|") !== s0.presentNpcs.join("|")) {
      rt.commitTx({
        kind: "location_set",
        location: nextLoc,
        presentNpcs: nextNpcs,
      });
    }
    if (wp.initialObjective && !rt.getState().sceneObjective) {
      rt.commitTx({ kind: "scene_objective_set", objective: wp.initialObjective });
    }
    // 2. Multi-actor inventory (idempotent: never double-add an item already owned!)
    for (const inv of wp.initialInventory ?? []) {
      const targetActor = inv.actorId || "player";
      if (inv.item && inv.count > 0 && !rt.getState().inventory[targetActor]?.[inv.item]) {
        rt.commitTx({
          kind: "inventory_patch",
          actorId: targetActor,
          item: inv.item,
          delta: inv.count,
          note: `${reasonPrefix}:profile_init`,
        });
      }
    }
    // 3. Multi-actor CFSM axes (idempotent: never overwrite an already-defined axis)
    for (const ax of wp.suggestedCfsmAxes ?? []) {
      const targetActor = ax.actorId || card.identity.name;
      if (!rt.getState().cfsmDefs[targetActor]?.[ax.axis]) {
        rt.commitTx({
          kind: "cfsm_define",
          actorId: targetActor,
          def: ax,
        });
      }
    }
    // 4. Initial RoleMemo DualMem beliefs (idempotent by id)
    (wp.initialBeliefs ?? []).forEach((b, idx) => {
      const id = `belief_init_${idx}`;
      const stNow = rt.getState();
      if (!stNow.beliefs.some((existing) => existing.id === id)) {
        rt.commitTx({
          kind: "belief_update",
          id,
          actorId: b.actorId || card.identity.name,
          target: b.target || stNow.currentPersona.name,
          activatingEvent: b.activatingEvent || "初始设定",
          belief: b.belief,
          subjectiveInsight: b.subjectiveInsight,
          emotionalTone: b.emotionalTone,
          turn: stNow.turn,
        });
      }
    });
    // 5. Initial FANToM facts & hidden secrets (idempotent by id; never resurrect invalidated facts)
    (wp.initialFacts ?? []).forEach((f, idx) => {
      const id = `fact_init_${idx}`;
      const stNow = rt.getState();
      if (!stNow.facts.has(id)) {
        rt.commitTx({
          kind: "fact_add",
          fact: {
            id,
            statement: f.statement,
            entities: f.entities,
            validFromTurn: 0,
            validUntilTurn: null,
            ingestedAtTurn: stNow.turn,
            eventTimeLabel: wp.initialTime || undefined,
            witnessIds: f.witnessIds,
          },
        });
      }
    });
    // 6. Initial EverMemOS foresights (idempotent by id; never reset paid_off hooks)
    (wp.initialForesights ?? []).forEach((h, idx) => {
      const id = `hook_init_${idx}`;
      if (!rt.getState().foresights.has(id)) {
        rt.commitTx({
          kind: "foresight_upsert",
          hook: {
            id,
            summary: h.summary,
            triggerHint: h.triggerHint,
            entities: h.entities,
            plantedTurn: 0,
            status: "open",
          },
        });
      }
    });
    // 7. Initial condition-gated Storylets & clocks (idempotent by id; never reset completed storylets or double-tick clocks)
    (wp.initialStorylets ?? []).forEach((st, idx) => {
      const id = `st_init_${idx}`;
      if (!rt.getState().storylets.has(id)) {
        rt.commitTx({
          kind: "storylet_upsert",
          storylet: {
            id,
            title: st.title,
            triggerPrompt: st.triggerPrompt,
            gate: st.gate,
            postEffects: st.postEffects,
            oneTime: st.oneTime ?? true,
            status: "armed",
            createdTurn: 0,
          },
        });
      }
    });
    for (const ck of wp.initialClocks ?? []) {
      if (!rt.getState().clocks[ck.clockId]) {
        rt.commitTx({
          kind: "progress_clock",
          clockId: ck.clockId,
          label: ck.label,
          delta: ck.value,
          max: ck.max,
        });
      }
    }
  }

  // 7b. Voice & Backbone Anchors (L1 /rp analyze or zero-cost L0 heuristic fallback)
  const anchorsToHydrate = wp?.voiceAnchors && wp.voiceAnchors.length > 0
    ? wp.voiceAnchors
    : (() => {
        const h = extractHeuristicVoiceAnchor(card);
        return h ? [h] : [];
      })();
  for (const va of anchorsToHydrate) {
    if (!rt.getState().voiceAnchors[va.actorId]) {
      rt.commitTx({ kind: "voice_anchor_upsert", anchor: va });
    }
  }

  // 8. Route salvaged / LLM-analyzed variables cleanly by actorId & semantic category (idempotent!)
  const allVars = card.salvagedStateSchema.length > 0 ? card.salvagedStateSchema : wp?.initialStats ?? [];
  for (const v of allVars) {
    const stNow = rt.getState();
    const actor = v.actorId || card.identity.name;
    const cat = v.category ?? "stat";
    if (cat === "inventory") {
      const targetActor = actor === "world" ? "player" : actor;
      if (!stNow.inventory[targetActor]?.[v.key]) {
        const count = typeof v.initialValue === "number" && v.initialValue > 0 ? Math.trunc(v.initialValue) : 1;
        rt.commitTx({
          kind: "inventory_patch",
          actorId: targetActor,
          item: v.key,
          delta: count,
          note: `${reasonPrefix}:${v.source}`,
        });
      }
    } else if (cat === "flag") {
      const flagKey = actor !== card.identity.name && actor !== "world" ? `${actor}.${v.key}` : v.key;
      if (!Object.prototype.hasOwnProperty.call(stNow.flags, flagKey)) {
        rt.commitTx({
          kind: "flag_set",
          flag: flagKey,
          value: Boolean(v.initialValue),
        });
      }
    } else if (cat === "clock") {
      const clockId = v.key.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").slice(0, 24) || `clk_${v.key}`;
      if (!stNow.clocks[clockId]) {
        const cur = typeof v.initialValue === "number" ? Math.max(0, Math.trunc(v.initialValue)) : 0;
        const max = typeof v.max === "number" && v.max > 0 ? Math.trunc(v.max) : Math.max(4, cur);
        rt.commitTx({ kind: "progress_clock", clockId, label: v.key, delta: cur, max });
      }
    } else if (cat === "anchor") {
      const valStr = String(v.initialValue).trim();
      const kLower = v.key.toLowerCase();
      if (valStr && /(?:地点|位置|场景|location|place)/i.test(kLower) && !stNow.location) {
        rt.commitTx({ kind: "location_set", location: valStr, presentNpcs: stNow.presentNpcs });
      } else if (valStr && /(?:时间|日期|时刻|天气|time|date|clock)/i.test(kLower) && !stNow.worldTimeLabel) {
        rt.commitTx({ kind: "clock_tick", beatDelta: 0, worldTimeLabel: valStr });
      } else if (stNow.stats[actor]?.[v.key] === undefined) {
        rt.commitTx({
          kind: "stat_patch",
          actorId: actor,
          key: v.key,
          op: "set",
          value: v.initialValue,
          min: v.min,
          max: v.max,
          reason: `${reasonPrefix}:${v.source}`,
        });
      }
    } else if (stNow.stats[actor]?.[v.key] === undefined) {
      rt.commitTx({
        kind: "stat_patch",
        actorId: actor,
        key: v.key,
        op: "set",
        value: v.initialValue,
        min: v.min,
        max: v.max,
        reason: `${reasonPrefix}:${v.source}`,
      });
    }
  }
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

  // Hydrate full 7-dimension WorldProfile + multi-actor/category-routed variables in <2ms!
  hydrateWorldProfileAndVariables(rt, card, "salvaged");

  rt.reloadRuntime(ctx);
  rt.activateRpTools();
  rt.refreshHud(ctx);
  rt.pi.setSessionName?.(`🎭 ${card.identity.name}`);
  ctx.ui.setTitle?.(`◆ ${card.identity.name} · Pi RP`);

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
    `已在本会话开启角色扮演：${card.identity.name}（仅当前会话生效，可随时从菜单退出）`,
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
    `已导入酒馆预设「${preset.name}」：静态设定 ${preset.zone1Prompts.length} 段 / 动态提示 ${preset.zone3Prompts.length} 段`,
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
  const canAiAnalyze = card.worldProfile?.source !== "llm-analyzed" && canCompleteWithRegistry(ctx);
  const nextOpts = [
    ...(canAiAnalyze ? ["✨ AI 深度建档后开玩（推荐纯文字卡）"] : []),
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

  const runAnalyzeFirst = nextPick.startsWith("✨");
  const greetingIndex = await pickGreeting(ctx, card);
  if (greetingIndex === undefined) return;
  const persona = await pickOrCreatePersona(ctx, rt.getState().currentPersona);
  if (!persona) return;
  await bindCardToCurrentSession(rt, ctx, {
    card,
    source,
    baseDir,
    greetingIndex,
    persona,
    rawPassthrough: rawMode,
  });
  if (runAnalyzeFirst) {
    await actionAnalyzeCard(rt, ctx);
  }
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
  if (greetingIndex === undefined) return;
  const persona = await pickOrCreatePersona(ctx, rt.getState().currentPersona);
  if (!persona) return;
  let presetId: string | undefined;
  if (presets.length > 0) {
    const pPick = await ctx.ui.select("🎛 是否加载酒馆预设（可选）", ["不使用预设（推荐）", ...presets]);
    if (!pPick) return;
    if (!pPick.startsWith("不使用")) presetId = pPick;
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
  const busy = ctx.isIdle?.() === false;
  rt.pi.sendMessage(
    { customType: "rp:event", content: nudge, display: false, details: { kind: "continue" } },
    busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
  );
}

export async function actionIdeas(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  // Zero-pollution interactive Bottom Sheet picker (generates directly-sendable replies via isolated call!)
  if (canCompleteWithRegistry(ctx)) {
    const recent = collectRecentDialogueLines(ctx, state, 6);
    const systemPrompt =
      `Generate 3 distinct, concrete, directly-sendable first-person player replies for an interactive roleplay. ` +
      `Player persona: "${state.currentPersona.name}". Match the story's language and tone strictly. ` +
      `Return ONLY strict JSON array: [{"tag":"主动/破局","text":"..."},{"tag":"观察/试探","text":"..."},{"tag":"对话/情绪","text":"..."}]. Each text should be 1-3 natural sentences ready to send as-is.`;
    const userPrompt =
      `Scene: ${[state.era, state.worldTimeLabel, state.location].filter(Boolean).join(" · ") || "unset"}\n` +
      (state.sceneObjective ? `Objective: ${state.sceneObjective}\n` : "") +
      (recent.length ? `Recent dialogue:\n${recent.join("\n")}\n` : "") +
      `Output JSON array now:`;

    const task = beginGuardedLlmTask(rt, ctx, "正在构思 3 个行动建议…");
    try {
      const raw = await completeWithRegistry(ctx, ctx.model, {
        systemPrompt,
        userPrompt,
        maxTokens: 480,
        signal: task.signal,
      });
      const m = /\[[\s\S]*\]/.exec(raw);
      if (m) {
        const parsed = JSON.parse(m[0]!) as Array<{ tag?: string; text?: string }>;
        const choices = parsed
          .filter((x) => x && typeof x.text === "string" && x.text.trim().length > 0)
          .slice(0, 4);
        if (!task.isStillValid()) {
          ctx.ui.notify("会话或分支已变更，已放弃本次行动建议。", "warning");
          return;
        }
        if (choices.length > 0) {
          task.cleanup();
          const opts = choices.map((c, i) => `${i + 1}. [${c.tag || "选项"}] ${previewText(c.text!, 58)}`);
          const pick = await ctx.ui.select("💡 选择行动建议（点选填入输入框）", [...opts, "✕ 取消"]);
          if (!pick || pick.startsWith("✕")) return;
          if (!task.isStillValid()) {
            ctx.ui.notify("会话或分支已变更，已取消填入行动建议。", "warning");
            return;
          }
          const idx = opts.indexOf(pick);
          const chosen = choices[idx];
          if (chosen?.text) {
            ctx.ui.setEditorText(chosen.text.trim());
            ctx.ui.notify("✍️ 已填入输入框，可直接微调后发送。", "info");
          }
          return;
        }
      }
      ctx.ui.notify("未能解析行动建议，请稍后重试。", "warning");
      return;
    } catch (err) {
      ctx.ui.notify(`构思行动建议失败：${(err as Error).message}`, "error");
      return;
    } finally {
      task.cleanup();
    }
  }

  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成回复，请等待本轮结束后再请求行动建议。", "warning");
    return;
  }
  rt.markNextTurnOoc();
  rt.pi.sendMessage(
    {
      customType: "rp:ooc",
      content:
        "[OOC Request] Please suggest 3 distinct, in-character action or dialogue choices the player could take right now (1 proactive, 1 observant/tactical, 1 conversational). Keep each concise (1-2 sentences) and do NOT advance the scene.",
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
  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成剧情回复，请等本轮结束后再发送场外讨论。", "warning");
    return;
  }
  let text = argsText.trim();
  if (!text) {
    const entered = await ctx.ui.input("💬 输入场外讨论内容（不推进剧情与时钟）", "请问角色现在对玩家是什么看法？");
    if (!entered?.trim()) return;
    text = entered.trim();
  }
  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成剧情回复，请等本轮结束后再发送场外讨论。", "warning");
    return;
  }
  rt.markNextTurnOoc();
  rt.pi.sendMessage(
    {
      customType: "rp:ooc",
      content: `[OOC - Meta/Director Discussion; do NOT advance story prose. Answer accurately using full context/tools; ONLY call rp_state_patch/rp_fact_commit if the user explicitly asks to fix or update state/memory.]\n${text}`,
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
    "去 AI 味：禁止排比句、总结式升华与“空气仿佛凝固/眼底闪过一丝”等陈词滥调，用克制白描和具体动作推动场景",
    "严禁越权：绝不替玩家说话、动作或揣测玩家内心决定，把选择权完整留给玩家",
    "保持人物棱角：角色遵循自身立场、利害与防备心，不无端讨好或瞬间软化，对白留有潜台词",
    "群像自然运转：在场配角各自有短期意图与小动作，不全部围着主角转，允许打断与信息差",
    "细节镜头：放慢当前一拍，通过声音、气味、光线与微表情展现情绪，避免直接点破心理",
    "打破平淡：引入一个合乎逻辑的外部变数、意外访客或隐蔽线索，在结尾留出明确行动钩子",
    "紧凑提速：正文控制在 250–400 字内，对白干脆利落，加快交互节奏",
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
    const entered = await ctx.ui.input("输入导演指令", "");
    if (!entered?.trim()) return;
    noteText = entered.trim();
  }

  const ttlPick = await ctx.ui.select("设置指令持续时间", [
    "1 轮（仅下一回合生效）",
    "3 轮（短期场景引导）",
    "常驻（直到手动清除）",
  ]);
  if (!ttlPick) return;
  const remainingTurns = ttlPick.startsWith("1") ? 1 : ttlPick.startsWith("3") ? 3 : null;
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
  if (!next) return;
  rt.commitTx({ kind: "persona_set", persona: next });
  rt.refreshHud(ctx);
  ctx.ui.notify(`已切换玩家马甲：${next.name}`, "info");
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
  if (idx === undefined) return;
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
  const suggested = [state.era, state.worldTimeLabel, state.location, `T${state.turn}`].filter(Boolean).join(" · ");
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
    ctx.ui.notify("当前会话还没有保存任何剧情书签，请先创建一个书签。", "info");
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
    "⏪ 原地回溯到该书签（自动还原状态）",
    ...(typeof ctx.fork === "function" ? ["🌿 从该书签分叉新剧情线（保留原分支）"] : []),
    "✕ 取消",
  ]);
  if (!modePick || modePick.startsWith("✕")) return;

  if (modePick.startsWith("🌿") && typeof ctx.fork === "function") {
    try {
      const forkFn = ctx.fork as (
        targetId: string,
        opts?: { position?: "before" | "at"; withSession?: (newCtx: PiExtensionContext) => Promise<void> | void },
      ) => Promise<{ cancelled?: boolean } | void>;
      await forkFn(target.targetId, {
        position: "at",
        withSession: (newCtx) => {
          newCtx.ui?.notify?.(`已从书签「${target.label}」创建新剧情分支。`, "info");
        },
      });
    } catch (err) {
      ctx.ui.notify(`创建分支失败：${err instanceof Error ? err.message : String(err)}`, "warning");
    }
    return;
  }

  if (typeof ctx.navigateTree === "function") {
    try {
      const res = await ctx.navigateTree(target.targetId);
      if (!res?.cancelled) {
        rt.reloadRuntime(ctx);
        rt.refreshHud(ctx);
        ctx.ui.notify(`已回溯至书签「${target.label}」，所有数值与事实账本已同步还原。`, "info");
      }
    } catch (err) {
      ctx.ui.notify(`无法回溯至书签：${err instanceof Error ? err.message : String(err)}`, "warning");
    }
  } else {
    ctx.ui.setEditorText?.(`/rp goto ${target.label}`);
    ctx.ui.notify(`已将跳转命令填入输入框，按回车即可回溯/分叉至「${target.label}」（或用 /tree 切换）。`, "info");
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
  const msgEntries = branch
    .map((e) => ({ entry: e, msg: normalizeBranchMessage(e) }))
    .filter(
      (x): x is { entry: (typeof branch)[number]; msg: PiMessage } =>
        Boolean(
          x.msg &&
            (x.msg.role === "user" ||
              x.msg.role === "assistant" ||
              x.msg.customType === "rp:rewrite" ||
              x.msg.customType === "rp:greeting"),
        ),
    );

  if (msgEntries.length === 0) {
    ctx.ui.notify("当前分支暂无可隐藏的对话楼层。", "info");
    return;
  }

  const isEntryHidden = (x: (typeof msgEntries)[number]): boolean => {
    const fp = computeMessageFingerprint(x.msg);
    return state.hiddenEntryIds.has(x.entry.id) || state.hiddenFingerprints.has(fp);
  };

  const hasHidden = state.hiddenEntryIds.size > 0 || state.hiddenFingerprints.size > 0;
  const pool = hide ? msgEntries : msgEntries.filter(isEntryHidden);

  const arg = argsText.trim();
  if (arg) {
    if (!hide && pool.length === 0) {
      ctx.ui.notify("当前没有已隐藏的对话楼层。", "info");
      return;
    }
    const count = Math.max(1, Number(arg) || 1);
    const targets = pool.slice(-count);
    const ids = targets.map((x) => x.entry.id);
    const fps = targets.map((x) => computeMessageFingerprint(x.msg));
    rt.commitTx({ kind: "hide_toggle", entryIds: ids, fingerprints: fps, hidden: hide });
    rt.refreshHud(ctx);
    ctx.ui.notify(`已${hide ? "隐藏" : "恢复"}最近 ${ids.length} 条对话楼层（非破坏性，不删日志）。`, "info");
    return;
  }

  if (!hide && pool.length === 0 && !hasHidden) {
    ctx.ui.notify("当前没有已隐藏的对话楼层。", "info");
    return;
  }

  // Interactive floor picker showing last 16 messages (or only hidden floors in unhide mode)
  const recent = pool.slice(-16).reverse();
  const opts = recent.map((x, idx) => {
    const fp = computeMessageFingerprint(x.msg);
    const isHidden = state.hiddenEntryIds.has(x.entry.id) || state.hiddenFingerprints.has(fp);
    const roleTag = x.msg.role === "user" ? "玩家" : x.msg.customType === "rp:rewrite" ? "改写" : "叙事";
    const badge = isHidden ? "🙈已隐藏" : "👁可见";
    return `${idx + 1}. [${badge}] [${roleTag}] ${previewText(extractMsgPlain(x.msg), 50)}`;
  });

  const pick = await ctx.ui.select(
    hide ? "🙈 隐藏或恢复对话楼层（点击切换可见/隐藏）" : "👁 选择要恢复显示的已隐藏楼层",
    [...opts, ...(hasHidden ? ["✨ 一键恢复全部已隐藏楼层"] : []), "✕ 返回"],
  );
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("✨")) {
    rt.commitTx({
      kind: "hide_toggle",
      entryIds: Array.from(state.hiddenEntryIds),
      fingerprints: Array.from(state.hiddenFingerprints),
      hidden: false,
    });
    rt.refreshHud(ctx);
    ctx.ui.notify("已恢复全部隐藏楼层。", "info");
    return;
  }

  const idx = opts.indexOf(pick);
  const chosen = recent[idx];
  if (!chosen) return;
  const fp = computeMessageFingerprint(chosen.msg);
  const currentlyHidden = state.hiddenEntryIds.has(chosen.entry.id) || state.hiddenFingerprints.has(fp);
  const nextHidden = !currentlyHidden;
  rt.commitTx({ kind: "hide_toggle", entryIds: [chosen.entry.id], fingerprints: [fp], hidden: nextHidden });
  rt.refreshHud(ctx);
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
    if (!dcPick) return;
    if (dcPick.startsWith("DC ")) {
      dc = Number(dcPick.split(" ")[1]);
    } else if (dcPick.startsWith("✏️")) {
      const dcRaw = await ctx.ui.input("输入目标 DC", "12");
      if (dcRaw === undefined) return;
      const d = Number(dcRaw.trim());
      if (Number.isFinite(d) && d > 0) dc = d;
    }

    const reasonRaw = await ctx.ui.input("检定事由（可留空）", "");
    if (reasonRaw === undefined) return;
    reason = reasonRaw.trim();
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
    const curState = rt.getState();
    if (curState.active) {
      rt.commitTx({
        kind: "roll_record",
        roll: {
          turn: curState.turn,
          actor: curState.currentPersona.name,
          expression: res.expression,
          rolls: res.rolls,
          keptRolls: res.keptRolls,
          modifier: res.modifier,
          total: res.total,
          dc,
          success: res.success,
          critical: res.critical ?? null,
          reason: reason || undefined,
          source: "manual",
        },
      });
      rt.refreshHud(ctx);
    }

    let sendToAi = false;
    if (curState.active && !trimmed) {
      const follow = await ctx.ui.select(
        `🎲 ${res.expression} → ${res.total}${outcomeText ? ` · ${outcomeText}` : ""}`,
        [
          "🚀 将本次检定结果发给 AI 续写剧情（推荐）",
          "👀 仅记录点数，不触发 AI 回复",
        ],
      );
      sendToAi = Boolean(follow && follow.startsWith("🚀"));
    }

    if (sendToAi) {
      const busy = ctx.isIdle?.() === false;
      const rollPrompt = `[玩家掷骰检定] 公式：${res.expression}${reason ? `（事由：${reason}）` : ""}，结果：${res.total}${dc !== undefined ? ` / DC ${dc}` : ""}${outcomeText ? ` → ${outcomeText}` : ""}。请严格依据此判定结果继续演绎剧情。`;
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
      rt.pi.sendUserMessage?.(rollPrompt, busy ? { deliverAs: "followUp" } : undefined);
    } else {
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
    }
  } catch (err) {
    ctx.ui.notify(`无效掷骰公式：${(err as Error).message}`, "error");
  }
}

export async function actionSkipMontage(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  let spanKind: "hours" | "days" | "long" | "scene_only" = "days";
  let desc = argsText.trim();
  let playerPlan = "";

  if (!desc) {
    const pick = await ctx.ui.select("⏳ 时间推进与幕间世界推演 (Downtime)", [
      "🌅 下一时段（几小时后 / 今晚 / 次日清晨）",
      "⏳ 跨日休整（数日后 · 推演幕后势力与时钟进展）",
      "🗓 长线跃迁（半月 / 换季 / 进入新阶段 · 全量幕间推演）",
      "📍 纯切地点（不推进时间，只换当前场景）",
      "✏️ 自定义时间与去向",
      "✕ 取消",
    ]);
    if (!pick || pick.startsWith("✕")) return;

    if (pick.startsWith("📍")) {
      spanKind = "scene_only";
      const loc = (await ctx.ui.input("输入要切往的新地点", state.location || ""))?.trim();
      if (!loc) return;
      const npcsInput = await ctx.ui.input("新地点在场人物（逗号分隔，可留空）", "");
      if (npcsInput === undefined) return;
      const npcsRaw = npcsInput;
      const npcs = npcsRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      rt.commitTx({ kind: "location_set", location: loc, presentNpcs: npcs });
      rt.refreshHud(ctx);
      rt.pi.sendMessage(
        {
          customType: "rp:era",
          content: `[场景切换：${loc}] 自然切入新地点的当下氛围与在场人物动态，将行动权交给玩家。`,
          display: true,
          details: { fromEra: state.era, toEra: state.era, kind: "scene_shift" },
        },
        { triggerTurn: true },
      );
      return;
    }

    if (pick.startsWith("🌅")) {
      spanKind = "hours";
      const sub = await ctx.ui.select("选择目标时段", ["次日清晨", "数小时后", "夜幕降临", "✏️ 自定义"]);
      if (!sub) return;
      desc = sub.startsWith("✏️") ? ((await ctx.ui.input("输入目标时段", "次日清晨"))?.trim() || "") : sub;
    } else if (pick.startsWith("⏳")) {
      spanKind = "days";
      const sub = await ctx.ui.select("选择跨日跨度", ["3天后", "7天后", "半月后", "✏️ 自定义"]);
      if (!sub) return;
      desc = sub.startsWith("✏️") ? ((await ctx.ui.input("输入时间跨度", "3天后"))?.trim() || "") : sub;
    } else if (pick.startsWith("🗓")) {
      spanKind = "long";
      desc = (await ctx.ui.input("输入长线时间或新阶段名称（如：入冬大雪、半年后、进入第二幕）", "一月后"))?.trim() || "";
    } else {
      desc = (await ctx.ui.input("输入时间推进或场景描述", "次日清晨"))?.trim() || "";
    }
    if (!desc) return;

    if (spanKind === "days" || spanKind === "long") {
      const planInput = await ctx.ui.input("这段时间主角主要做什么？（可留空自动推演）", "");
      if (planInput === undefined) return;
      playerPlan = planInput.trim();
    }
  }

  const parsedSpan = parseTimeSpan(desc);
  const dayDelta = parsedSpan.dayDelta;
  const isStageChange = /(?:第[一二三四五六七八九十0-9]+[幕章篇卷]|纪元|Act\s+[IVX0-9]+|Chapter)/i.test(desc);
  const nextEra = isStageChange ? desc : state.era;

  const worldSignalText = [
    card.identity.name,
    card.frozen.description,
    card.frozen.scenario,
    state.archetype,
  ].join("\n");
  const lifespanProfile = detectLifespanProfile(worldSignalText);
  const calendarAnchor = computeCalendarAnchor(state.worldTimeLabel, parsedSpan.years, dayDelta);

  let continuityMode: ContinuityMode =
    lifespanProfile === "long_lived"
      ? "immortal_span"
      : lifespanProfile === "scifi_stasis" && parsedSpan.years >= 30
        ? "stasis_or_portal"
        : "natural_aging";

  if (parsedSpan.years >= 30) {
    const yearNote = calendarAnchor?.targetEraLabel ? ` → 推算年份：${calendarAnchor.targetEraLabel}` : "";
    const mortalWarning =
      lifespanProfile === "mortal" && parsedSpan.years >= 60
        ? `⚠️ 跨度 ${parsedSpan.years} 年已超出凡人自然寿命${yearNote}，请选择延续方式：`
        : `⏳ 长跨度时间跃迁（${parsedSpan.years} 年${yearNote}），请选择世界延续方式：`;

    const modeOptions =
      lifespanProfile === "mortal" && parsedSpan.years >= 60
        ? [
            "🧬 世代更替（旧角色老去/作古，改以遗产、后人或新主角承接）",
            "❄️ 休眠 / 封印 / 穿越（主角肉身停滞，醒来故人多已不在）",
            "🕰️ 强行按长生/奇幻处理（主角存活，凡人世界沧海桑田）",
            "✏️ 取消并返回缩短时间跨度",
          ]
        : [
            "🕰️ 自然衰老 / 正常度过（按当前世界观寿命自然演进）",
            "🧬 世代更替（切换至下一代/继承者视角）",
            "❄️ 休眠 / 封印 / 穿越（主角停滞，外界沧海桑田）",
            "✏️ 取消并返回修改跨度",
          ];

    const pickedMode = await ctx.ui.select(mortalWarning, modeOptions);
    if (!pickedMode || pickedMode.startsWith("✏️")) {
      ctx.ui.notify("已取消本次超长跨度推进。", "info");
      return;
    }
    if (pickedMode.startsWith("🧬")) continuityMode = "generational_legacy";
    else if (pickedMode.startsWith("❄️")) continuityMode = "stasis_or_portal";
    else if (pickedMode.startsWith("🕰️")) {
      continuityMode = lifespanProfile === "long_lived" || parsedSpan.years >= 60 ? "immortal_span" : "natural_aging";
    }
  }

  interface DowntimeSimResult {
    worldTimeLabel?: string;
    location?: string;
    presentNpcs?: string[];
    clockDeltas?: Array<{ clockId: string; delta: number; reason?: string }>;
    offscreenEvents?: Array<{ statement: string; public?: boolean; entities?: string[] }>;
    openingBeat?: string;
  }

  let sim: DowntimeSimResult | null = null;
  let simTask: GuardedTaskHandle | null = null;
  if (canCompleteWithRegistry(ctx)) {
    const activeClocks = Object.values(state.clocks)
      .filter((c) => !c.completed)
      .map((c) => `${c.clockId} (${c.label}: ${c.value}/${c.max})`);
    const openHooks = Array.from(state.foresights.values())
      .filter((h) => h.status === "open")
      .slice(0, 4)
      .map((h) => h.summary);
    const activeAgendas = Object.values(state.npcAgendas)
      .slice(0, 4)
      .map((ag) => `${ag.actorId}: ${ag.goal}${ag.currentActivity ? ` (${ag.currentActivity})` : ""}`);
    const recentFacts = getActiveFacts(state)
      .slice(-6)
      .map((f) => f.statement);

    const continuityDirective = buildContinuityDirective(continuityMode, parsedSpan.years, lifespanProfile);

    const simPrompt =
      `You are an off-screen world simulator for "${card.identity.name}". ` +
      `Given a time jump ("${desc}") and the player's downtime intent, simulate what realistically happens off-screen across factions, clocks, NPC agendas, and open threads. ` +
      `${continuityDirective} ` +
      (calendarAnchor ? `${calendarAnchor.exactHint} ` : "") +
      `Return ONLY strict JSON:\n` +
      `{"worldTimeLabel":"new in-world time string","location":"new or same location","presentNpcs":["names"],"clockDeltas":[{"clockId":"existing_id","delta":1,"reason":"why"}],"offscreenEvents":[{"statement":"concise event","public":true,"entities":["name"]}],"openingBeat":"1-2 sentence concrete opening sensory hook for the new scene"}\n` +
      `Rules: Keep clockDeltas grounded to existing clockIds (0-2 entries, delta 1-2). OffscreenEvents: 1-2 realistic developments (mark secret faction moves public:false). Match the story's language.`;

    const simInput =
      `Current time: ${state.worldTimeLabel || "unset"} | Location: ${state.location || "unset"} | Present: ${state.presentNpcs.join(", ") || "none"}\n` +
      `World lifespan profile: ${lifespanProfile} | Time jump: ${desc} (≈${dayDelta} days / ${parsedSpan.years} years)\n` +
      (calendarAnchor ? `Authoritative target year: ${calendarAnchor.targetEraLabel ?? calendarAnchor.targetYear}\n` : "") +
      (playerPlan ? `Player downtime activity: ${playerPlan}\n` : "") +
      (activeClocks.length ? `Active clocks: ${activeClocks.join("; ")}\n` : "") +
      (activeAgendas.length ? `Active NPC agendas: ${activeAgendas.join("; ")}\n` : "") +
      (openHooks.length ? `Open foresights: ${openHooks.join("; ")}\n` : "") +
      (recentFacts.length ? `Recent facts: ${recentFacts.join(" | ")}\n` : "");

    const task = beginGuardedLlmTask(rt, ctx, `正在推演「${desc}」期间的世界变化…`);
    simTask = task;
    let simFailed = false;
    try {
      const targetModel = resolveSidecarModel(ctx, state.sidecarModel) ?? ctx.model;
      const raw = await completeWithRegistry(ctx, targetModel, {
        systemPrompt: simPrompt,
        userPrompt: simInput,
        maxTokens: 600,
        signal: task.signal,
      });
      sim = extractJsonObject<DowntimeSimResult>(raw);
    } catch (err) {
      sim = null;
      simFailed = true;
      ctx.ui.notify(`幕间推演模型调用失败：${(err as Error).message}`, "warning");
    } finally {
      task.cleanup();
    }
    if (!task.isStillValid()) {
      ctx.ui.notify("会话或分支已变更，已放弃本次幕间推演结果。", "warning");
      return;
    }
    if (simFailed) {
      const proceedPlain = await ctx.ui.confirm("推演失败，是否仅推进时间并继续？", `目标跨度：${desc}`);
      if (!proceedPlain) return;
    }
  }

  if (sim) {
    const previewLines = [
      `🕒 新时间：${sim.worldTimeLabel || desc}`,
      sim.location ? `📍 新地点：${sim.location}${sim.presentNpcs?.length ? `（在场：${sim.presentNpcs.join("、")}）` : ""}` : null,
      sim.clockDeltas?.length
        ? `⏳ 时钟推进：${sim.clockDeltas.map((c) => `${c.clockId} +${c.delta}${c.reason ? `（${c.reason}）` : ""}`).join("；")}`
        : null,
      ...(sim.offscreenEvents ?? []).map((e) => `${e.public === false ? "🔒 幕后暗流" : "📰 世界变动"}：${e.statement}`),
      sim.openingBeat ? `🎬 切入镜头：${sim.openingBeat}` : null,
    ].filter(Boolean);

    const ok = await ctx.ui.confirm("确认应用幕间世界推演结果？", previewLines.join("\n"));
    if (!ok) {
      ctx.ui.notify("已取消本次时间推进。", "info");
      return;
    }
    if (simTask && !simTask.isStillValid()) {
      ctx.ui.notify("会话或分支已变更，已放弃应用幕间推演结果。", "warning");
      return;
    }
  }

  if (isStageChange && nextEra !== state.era) {
    rt.commitTx({
      kind: "era_advance",
      fromEra: state.era,
      toEra: nextEra,
      milestoneUnlocked: [],
      montageSummary: desc,
      turn: state.turn,
    });
  }

  const nextTimeLabel =
    sim?.worldTimeLabel?.trim() ||
    calendarAnchor?.targetEraLabel ||
    (dayDelta > 0 && !/第\s*\d+\s*天/.test(desc) ? `第 ${state.day + dayDelta} 天 · ${desc}` : desc);
  rt.commitTx({
    kind: "clock_tick",
    beatDelta: 0,
    dayDelta,
    worldTimeLabel: nextTimeLabel,
  });

  if (sim?.location && sim.location.trim()) {
    rt.commitTx({
      kind: "location_set",
      location: sim.location.trim(),
      presentNpcs: Array.isArray(sim.presentNpcs) ? sim.presentNpcs.filter(Boolean) : state.presentNpcs,
    });
  }

  if (sim?.clockDeltas) {
    for (const cd of sim.clockDeltas) {
      const existing = state.clocks[cd.clockId];
      if (!existing || !Number.isFinite(cd.delta) || cd.delta === 0) continue;
      rt.commitTx({
        kind: "progress_clock",
        clockId: existing.clockId,
        label: existing.label,
        delta: Math.max(-2, Math.min(3, Math.round(cd.delta))),
        max: existing.max,
      });
    }
  }

  if (sim?.offscreenEvents) {
    for (const ev of sim.offscreenEvents.slice(0, 3)) {
      if (!ev?.statement?.trim()) continue;
      rt.commitTx({
        kind: "fact_add",
        fact: {
          id: `downtime_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
          statement: ev.statement.trim(),
          entities: Array.isArray(ev.entities) ? ev.entities.filter(Boolean) : [],
          validFromTurn: state.turn,
          validUntilTurn: null,
          witnessIds: ev.public === false ? ["narrator"] : "public",
        },
      });
    }
  }

  rt.refreshHud(ctx);

  const publicNotes = (sim?.offscreenEvents ?? [])
    .filter((e) => e.public !== false && e.statement)
    .map((e) => `- ${e.statement}`)
    .join("\n");
  const transitionContent = [
    `[时间推进：${nextTimeLabel}${sim?.location ? ` · ${sim.location}` : ""}]`,
    playerPlan ? `期间主角去向：${playerPlan}` : null,
    publicNotes ? `期间外界已知变化：\n${publicNotes}` : null,
    sim?.openingBeat ? `开场切入点：${sim.openingBeat}` : null,
    `请用克制具体的细节自然切入新时间点后的第一场戏（不要泄露标记为盲区的幕后暗流），将主动权交给玩家。`,
  ]
    .filter(Boolean)
    .join("\n");

  rt.pi.sendMessage(
    {
      customType: "rp:era",
      content: transitionContent,
      display: true,
      details: { fromEra: state.era, toEra: nextEra, kind: "downtime" },
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
    const pick = await ctx.ui.select(`⚙ 引擎运行模式（当前：${state.settlementMode === "tool-assisted" ? "全能模式" : state.settlementMode === "sidecar-light" ? "纯文学后台" : "纯聊天"}）`, [
      "tool-assisted — 全能模式（默认 · 最强，单模型实时掷骰/控账/联动）",
      "sidecar-light — 纯文学后台（独立小模型静默记账，仍保留掷骰）",
      "off — 纯聊天（关闭自动工具与记账）",
    ]);
    if (!pick) return;
    next = pick.split(" ")[0] as SettlementMode;
  }
  rt.commitTx({ kind: "config_patch", settlementMode: next });
  rt.activateRpTools();
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
    if (currentCard.worldProfile?.source === "llm-analyzed") {
      applyAnalyzedProfileToCard(recompiled, currentCard.worldProfile, true);
    }
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
    `⌨️ RP 核心快捷键（共 ${RP_SHORTCUT_LIST.length} 项）`,
    [...RP_SHORTCUT_LIST.map((s) => `${s.key.padEnd(8)}  ${s.label} — ${s.description}`), "✕ 关闭"],
  );
}

/** L1 One-Click AI 7-Dimension Deep Card Analyzer (`/rp analyze`): extracts full structured narrative world and caches it permanently to card.compiled.json. */
export async function actionAnalyzeCard(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("请先加载一张角色卡再执行 /rp analyze 智能建档。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法执行智能建档。", "warning");
    return;
  }

  const task = beginGuardedLlmTask(rt, ctx, `正在对「${card.identity.name}」执行 7 维深度建档…`);
  let res;
  try {
    res = await analyzeCardWithModel(task.guardedCtx, card, state.sidecarModel);
  } catch (err) {
    ctx.ui.notify(`智能建档失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或角色卡已切换，已放弃过期建档结果。", "warning");
    return;
  }
  if (!res) {
    ctx.ui.notify("未能解析模型返回的结构化画像，请稍后重试。", "warning");
    return;
  }

  const { profile, initialStats } = res;
  const enabledMods = Object.entries(profile.modules)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(", ") || "仅基础叙事";
  const secretCount = (profile.initialFacts ?? []).filter((f) => f.witnessIds !== "public").length;
  const preview = [
    `1. 卡型与时空：${profile.archetype}（模块：${enabledMods}） · ${[profile.initialStage, profile.initialTime, profile.initialLocation].filter(Boolean).join(" · ") || "无显式初态"}`,
    profile.initialObjective ? `   开局目标：${profile.initialObjective}` : null,
    profile.initialPresentNpcs.length ? `   在场人物：${profile.initialPresentNpcs.join("、")}` : null,
    initialStats.length ? `2. 数值变量 (${initialStats.length})：${initialStats.slice(0, 6).map((s) => `${s.actorId ?? card.identity.name}.${s.key}=${s.initialValue}`).join("、")}` : null,
    profile.initialInventory.length ? `   初始物品 (${profile.initialInventory.length})：${profile.initialInventory.map((i) => `${i.actorId ?? "player"}:${i.item}×${i.count}`).join("、")}` : null,
    profile.suggestedCfsmAxes.length ? `3. 角色心态轴 (${profile.suggestedCfsmAxes.length})：${profile.suggestedCfsmAxes.map((a) => `${a.actorId ?? card.identity.name}.${a.axis}(${a.states.join("→")})`).join("；")}` : null,
    profile.initialBeliefs?.length ? `4. 初始人物信念：${profile.initialBeliefs.length} 条人物潜台词` : null,
    profile.initialFacts?.length ? `5. 初始事实与秘密：${profile.initialFacts.length} 条（含 ${secretCount} 条隐藏秘密/盲区）` : null,
    profile.initialForesights?.length ? `6. 初始伏笔与悬念：${profile.initialForesights.length} 条` : null,
    profile.initialStorylets?.length || profile.initialClocks?.length
      ? `7. 动态剧情卡与时钟：Storylets ${profile.initialStorylets?.length ?? 0} 张 · 时钟 ${profile.initialClocks?.length ?? 0} 个`
      : null,
    Object.keys(profile.entityAliases).length || profile.suggestedLoreGates.length
      ? `   实体别名 ${Object.keys(profile.entityAliases).length} 组 · 防剧透门禁 ${profile.suggestedLoreGates.length} 条`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const ok = await ctx.ui.confirm("应用并永久缓存 7 维深度建档结果？", preview);
  if (!ok) {
    ctx.ui.notify("已取消应用建档结果。", "info");
    return;
  }

  if (!task.isStillValid()) {
    ctx.ui.notify("会话或角色卡已切换，已取消写入建档结果。", "warning");
    return;
  }
  applyAnalyzedProfileToCard(card, profile, true, initialStats);
  if (state.worldDir) {
    try {
      saveUpdatedCard(state.worldDir, card);
    } catch (err) {
      ctx.ui.notify(`建档结果写入磁盘失败：${(err as Error).message}`, "error");
    }
  }

  hydrateWorldProfileAndVariables(rt, card, "llm_analyze");
  rt.reloadRuntime(ctx);
  rt.refreshHud(ctx);
  ctx.ui.notify(`✅ 已完成「${card.identity.name}」7 维深度建档并永久缓存，后续开局 <2ms 复用！`, "info");
}


/** True SillyTavern-style Swipe / Guided Reroll (`/rp reroll` & `Alt+W`):
 *  - Guards against mid-stream calls (`ctx.isIdle() === false`)
 *  - Detects BOTH user turns AND custom continue/montage/reroll triggers so rerolling after `/rp continue`
 *    never rewinds across multiple turns!
 *  - Includes 1-click Guided Reroll presets. */
export async function actionReroll(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成回复，请等待本轮输出结束后再重摇。", "warning");
    return;
  }

  const startLeafId = ctx.sessionManager.getLeafId();
  const branch = ctx.sessionManager.getBranch();
  let lastAssistantIdx = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    const normMsg = normalizeBranchMessage(e);
    if (!normMsg) continue;
    const isStoryReply =
      (e.type === "message" && normMsg.role === "assistant") ||
      normMsg.customType === "rp:rewrite";
    if (!isStoryReply) continue;
    const fp = computeMessageFingerprint(normMsg);
    if (state.hiddenEntryIds.has(e.id) || state.hiddenFingerprints.has(fp)) continue;
    lastAssistantIdx = i;
    break;
  }
  if (lastAssistantIdx < 0) {
    ctx.ui.notify("当前分支还没有可重摇的回复。", "info");
    return;
  }

  // Locate the exact trigger message right before the last assistant reply (user OR custom continue/montage/reroll)
  let triggerIdx = -1;
  let triggerKind: "user" | "custom" = "user";
  for (let i = lastAssistantIdx - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "message" && e.message?.role === "user") {
      triggerIdx = i;
      triggerKind = "user";
      break;
    }
    if (
      (e.type === "custom_message" || e.type === "message") &&
      (e.customType === "rp:event" || e.customType === "rp:era" || e.message?.customType === "rp:event" || e.message?.customType === "rp:era")
    ) {
      const details = ((e.message?.details ?? (e as { details?: unknown }).details ?? e.data) ?? {}) as { kind?: string };
      if (
        details.kind === "continue" ||
        details.kind === "montage" ||
        details.kind === "downtime" ||
        details.kind === "scene_shift" ||
        details.kind === "reroll"
      ) {
        triggerIdx = i;
        triggerKind = "custom";
        break;
      }
    }
  }

  let steerHint = argsText.trim();
  if (!steerHint) {
    const pick = await ctx.ui.select("🎲 重摇上一条回复 (Guided Swipe / Reroll)", [
      "🎲 直接重摇（换一种演绎，原分支保留在 /tree 中）",
      "🌙 定向重摇：更细腻的感官细节、微表情与潜台词",
      "⚡ 定向重摇：更紧凑的节奏与更高的戏剧张力",
      "🎭 定向重摇：更贴合原卡性格口吻，减少套话",
      "✂️ 定向重摇：篇幅更精炼（200-350 字）并留出互动钩子",
      "✏️ 输入自定义微调方向（仅生效 1 轮）",
      "✕ 取消",
    ]);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("🌙")) steerHint = "放慢镜头，强化环境感官细节、微表情与人物内心潜台词。";
    else if (pick.startsWith("⚡")) steerHint = "收紧节奏，提高戏剧张力并让潜在冲突或悬念显露出来。";
    else if (pick.startsWith("🎭")) steerHint = "严格贴合角色原始性格、说话习惯与当下给定情境，去除通用套话。";
    else if (pick.startsWith("✂️")) steerHint = "保持精炼紧凑（约 200-350 字），结尾自然抛出留给玩家的互动钩子。";
    else if (pick.startsWith("✏️")) {
      const entered = (await ctx.ui.input("输入本次重摇的微调提示（仅生效 1 轮）", "语气更克制，增加环境细节"))?.trim();
      if (!entered) return;
      steerHint = entered;
    }
  }

  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成回复，已取消本次重摇。", "warning");
    return;
  }
  const latestLeafId = ctx.sessionManager.getLeafId();
  if (startLeafId && latestLeafId && latestLeafId !== startLeafId) {
    ctx.ui.notify("分支状态已变化，请重新执行重摇。", "warning");
    return;
  }

  const assistantEntry = branch[lastAssistantIdx]!;
  const triggerEntry = triggerIdx >= 0 ? branch[triggerIdx]! : undefined;
  const normalizedTrigger = triggerEntry ? normalizeBranchMessage(triggerEntry) : null;
  const triggerText = normalizedTrigger ? extractMsgPlain(normalizedTrigger) : "";
  const triggerCustomType = normalizedTrigger?.customType === "rp:era" ? "rp:era" : "rp:event";
  const rewindParentId = triggerEntry?.parentId ?? (triggerIdx > 0 ? branch[triggerIdx - 1]?.id : undefined);

  // Preferred path: true tree-branching Swipe via navigateTree so old swipe stays intact in Pi /tree!
  if (typeof ctx.navigateTree === "function" && triggerEntry && rewindParentId) {
    let nav: { cancelled?: boolean } | void;
    try {
      nav = await ctx.navigateTree(rewindParentId);
    } catch (err) {
      ctx.ui.notify(`重摇回溯失败：${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }
    if (nav?.cancelled) return;
    rt.reloadRuntime(ctx);
    if (steerHint) {
      rt.commitTx({
        kind: "note_set",
        note: { id: `reroll_${Date.now().toString(36)}`, text: `[重摇微调] ${steerHint}`, remainingTurns: 1 },
      });
    }
    rt.refreshHud(ctx);
    if (triggerKind === "user" && triggerText && typeof rt.pi.sendUserMessage === "function") {
      rt.pi.sendUserMessage(triggerText);
    } else {
      rt.pi.sendMessage(
        {
          customType: triggerCustomType,
          content:
            triggerText ||
            "[Continue and regenerate the response with a fresh narrative angle while staying faithful to the current scene.]",
          display: triggerCustomType === "rp:era",
          details: { kind: triggerCustomType === "rp:era" ? "montage" : "reroll" },
        },
        { triggerTurn: true },
      );
    }
    ctx.ui.notify("🎲 已分叉重摇上一条回复（旧版本仍可在 /tree 中随时切回）。", "info");
    return;
  }

  // Fallback path: non-destructively hide the rejected story floor & trigger a fresh generation
  const normalizedAssistant = normalizeBranchMessage(assistantEntry);
  if (!normalizedAssistant) return;
  const fp = computeMessageFingerprint(normalizedAssistant);
  rt.commitTx({ kind: "hide_toggle", entryIds: [assistantEntry.id], fingerprints: [fp], hidden: true });
  if (steerHint) {
    rt.commitTx({
      kind: "note_set",
      note: { id: `reroll_${Date.now().toString(36)}`, text: `[重摇微调] ${steerHint}`, remainingTurns: 1 },
    });
  }
  rt.refreshHud(ctx);
  rt.pi.sendMessage(
    {
      customType: "rp:event",
      content:
        "[Regenerate the previous assistant response with a fresh, distinct narrative angle while staying faithful to the current scene and established facts.]",
      display: false,
      details: { kind: "reroll" },
    },
    { triggerTurn: true },
  );
  ctx.ui.notify("🎲 已隐藏旧回复并重新生成（非破坏性，随时可在 /rp unhide 恢复）。", "info");
}

/** 1-keypress pacing cycle (`Alt+P`): relaxed → balanced → dramatic. */
export async function actionCyclePacing(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const order: PacingMode[] = ["relaxed", "balanced", "dramatic"];
  const next = order[(order.indexOf(state.pacingMode) + 1) % order.length]!;
  const zh: Record<PacingMode, string> = {
    relaxed: "舒缓细腻（侧重氛围与日常互动）",
    balanced: "均衡自然（默认）",
    dramatic: "紧张强冲突（积极推进时钟与悬念）",
  };
  rt.commitTx({ kind: "config_patch", pacingMode: next });
  rt.refreshHud(ctx);
  ctx.ui.notify(`🎚 叙事节奏已切换：${zh[next]}`, "info");
}

/** 0-Token Instant Story Recap (`/rp recap`): synthesizes current state, facts, beliefs, clocks & foresights into an editorial card. */
export async function actionRecap(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const lines: string[] = [];
  const header = [card.identity.name, state.era, state.worldTimeLabel, `第 ${state.turn} 轮`].filter(Boolean).join(" · ");
  lines.push(`当前进度：${header}`);
  if (state.location || state.presentNpcs.length > 0) {
    lines.push(
      `当前场景：${state.location || "(未设定)"}${state.presentNpcs.length ? `  │  在场：${state.presentNpcs.join("、")}` : ""}`,
    );
  }

  const cfsmPairs: string[] = [];
  for (const [actor, axes] of Object.entries(state.cfsmStates)) {
    for (const [axis, rec] of Object.entries(axes)) {
      cfsmPairs.push(`${actor}.${axis}=${rec.state}`);
    }
  }
  if (cfsmPairs.length > 0) {
    lines.push(`角色心态：${cfsmPairs.slice(0, 4).join(" · ")}`);
  }

  const activeClocks = Object.values(state.clocks).filter((c) => !c.completed);
  if (activeClocks.length > 0) {
    lines.push(`进行时钟：${activeClocks.map((c) => `${c.label} (${c.value}/${c.max})`).join(" · ")}`);
  }

  const facts = getActiveFacts(state).slice(-5).reverse();
  if (facts.length > 0) {
    lines.push("", "【近期有效事实】");
    for (const f of facts) {
      lines.push(`· [T${f.validFromTurn}] ${f.statement}`);
    }
  }

  const latestBeliefs = state.beliefs.slice(-3).reverse();
  if (latestBeliefs.length > 0) {
    lines.push("", "【人物最新信念】");
    for (const b of latestBeliefs) {
      lines.push(`· ${b.actorId} → ${b.target}：${b.belief}（因：${b.activatingEvent}）`);
    }
  }

  const openHooks = Array.from(state.foresights.values()).filter((h) => h.status === "open").slice(0, 4);
  if (openHooks.length > 0) {
    lines.push("", "【未回收伏笔】");
    for (const h of openHooks) {
      lines.push(`· ${h.summary}${h.triggerHint ? `（线索：${h.triggerHint}）` : ""}`);
    }
  }

  rt.pi.sendMessage(
    {
      customType: "rp:event",
      content: lines.join("\n"),
      display: true,
      details: {
        kind: "recap",
        title: `${card.identity.name} · 前情提要`,
        subtitle: `T${state.turn} · 即时摘要`,
      },
    },
    { triggerTurn: false },
  );
}

/** Helper: extract recent visible dialogue transcript lines from the current branch. */
function collectRecentDialogueLines(ctx: PiExtensionContext, state: SessionRpState, limit = 8): string[] {
  const branch = ctx.sessionManager.getBranch();
  const out: string[] = [];
  for (const e of branch) {
    const m = normalizeBranchMessage(e);
    if (!m) continue;
    const isNarrative =
      m.role === "user" ||
      m.role === "assistant" ||
      m.customType === "rp:greeting" ||
      m.customType === "rp:rewrite";
    if (!isNarrative) continue;
    const fp = computeMessageFingerprint(m);
    if (state.hiddenEntryIds.has(e.id) || state.hiddenFingerprints.has(fp)) continue;
    const txt = extractMsgPlain(m).trim();
    if (!txt) continue;
    const speaker = m.role === "user" ? state.currentPersona.name : "叙事";
    out.push(`[${speaker}] ${txt.slice(0, 600)}`);
  }
  return out.slice(-limit);
}

/**
 * Guided Impersonate (`/rp imp` & `Alt+I`):
 * Drafts an in-character player reply from the user's persona perspective and prefills Pi's editor
 * via official `ctx.ui.setEditorText()` — zero chat pollution until the user edits and presses Enter!
 */
export async function actionImpersonate(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法代写主角回复。", "warning");
    return;
  }

  let hint = argsText.trim();
  if (!hint) {
    const entered = await ctx.ui.input(
      "✍️ 帮我代写主角回复（可输入简短意图，留空则按当前情境自然接话）",
      "",
    );
    if (entered === undefined) return;
    hint = entered.trim();
  }

  const recent = collectRecentDialogueLines(ctx, state, 6);
  const systemPrompt =
    `You are drafting the player's next in-character reply for an interactive roleplay. ` +
    `Write strictly from the perspective of player persona "${state.currentPersona.name}"` +
    `${state.currentPersona.description ? ` (${state.currentPersona.description.slice(0, 200)})` : ""}. ` +
    `Match the story's language and tone. Output ONLY the player's reply text (2-4 sentences, no meta commentary, no quotes wrapping the whole output).`;

  const userPrompt =
    `Character: ${card.identity.name}\n` +
    `Scene: ${[state.era, state.worldTimeLabel, state.location].filter(Boolean).join(" · ") || "(unset)"}\n` +
    (recent.length ? `Recent dialogue:\n${recent.join("\n")}\n\n` : "") +
    (hint ? `Player intent hint: ${hint}\n` : "") +
    `Draft the player's next reply now:`;

  const task = beginGuardedLlmTask(rt, ctx, "正在以你的视角起草回复…");
  let draft = "";
  try {
    draft = (await completeWithRegistry(ctx, ctx.model, { systemPrompt, userPrompt, maxTokens: 320, signal: task.signal })).trim();
  } catch (err) {
    ctx.ui.notify(`代写失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃填入代写草稿。", "warning");
    return;
  }

  if (!draft) {
    ctx.ui.notify("未生成有效草稿，请重试。", "warning");
    return;
  }

  ctx.ui.setEditorText(draft);
  ctx.ui.notify("✍️ 已将代写草稿填入输入框，可直接修改后按回车发送。", "info");
}

/**
 * Zero-Pollution Side Prompt (`/rp ask` & `Alt+Q`):
 * Asks the LLM an out-of-character question (character psychology, clue check, plot brainstorm)
 * using current world state & recent chat WITHOUT adding anything to conversation history or advancing turns.
 */
export async function actionSidePrompt(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法发起场外提问。", "warning");
    return;
  }

  let question = argsText.trim();
  if (!question) {
    const quick = await ctx.ui.select("💭 零污染场外提问（不进对话历史，不推进剧情）", [
      "✏️ 输入自定义问题",
      "🔍 透视角色此刻的真实心理与潜台词",
      "🧩 梳理目前已出现的线索与未解悬念",
      "💡 给接下来的剧情构思 3 个不同走向",
      "✕ 取消",
    ]);
    if (!quick || quick.startsWith("✕")) return;
    if (quick.startsWith("✏️")) {
      const entered = (await ctx.ui.input("输入你想问 AI 的场外问题", ""))?.trim();
      if (!entered) return;
      question = entered;
    } else {
      question = quick.replace(/^[^\s]+\s+/, "");
    }
  }

  const recent = collectRecentDialogueLines(ctx, state, 10);
  const activeFacts = getActiveFacts(state)
    .slice(-14)
    .map((f) => {
      const vis = f.witnessIds === "public" ? "公开" : `仅:${f.witnessIds.join(",")}`;
      return `- [T${f.validFromTurn}|${vis}] ${f.statement}`;
    });
  const activeFlags = Object.entries(state.flags).filter(([, v]) => Boolean(v)).map(([k]) => k);
  const cfsmList: string[] = [];
  for (const [actor, axes] of Object.entries(state.cfsmStates)) {
    for (const [axis, rec] of Object.entries(axes)) cfsmList.push(`${actor}.${axis}=${rec.state}`);
  }
  const statList: string[] = [];
  for (const [actor, rec] of Object.entries(state.stats)) {
    for (const [k, v] of Object.entries(rec)) statList.push(`${actor}.${k}=${String(v)}`);
  }
  const clockList = Object.values(state.clocks).map((c) => `${c.label}:${c.value}/${c.max}${c.completed ? "(完成)" : ""}`);
  const physList = Object.values(state.physicalState).map(
    (ps) => `- ${ps.actorId}: ${[ps.attire, ps.condition, ps.holding, ps.position].filter(Boolean).join(" | ")}`,
  );
  const beliefList = state.beliefs
    .slice(-8)
    .map((b) => `- [T${b.turn}] ${b.actorId}→${b.target}: ${b.belief}${b.subjectiveInsight ? ` (潜台词:${b.subjectiveInsight})` : ""}`);
  const hookList = Array.from(state.foresights.values())
    .filter((h) => h.status === "open")
    .slice(0, 8)
    .map((h) => `- ${h.summary}${h.triggerHint ? ` (线索:${h.triggerHint})` : ""}`);
  const memBookList = Array.from(state.memoryBooks.values())
    .filter((b) => b.enabled)
    .slice(-5)
    .map((b) => `- [${b.title} T${b.turnRange[0]}-${b.turnRange[1]}] ${b.summary.slice(0, 180)}`);
  const agendaList = Object.values(state.npcAgendas).map(
    (a) => `- ${a.actorId}${typeof a.etaTurns === "number" ? `(剩${a.etaTurns}轮)` : ""}: ${a.currentActivity} (目的:${a.goal})`,
  );
  const bondList = Object.values(state.pairBonds).map((b) => `- ${b.actorA}↔${b.actorB}: ${b.stance} (${b.tension}) ${b.note}`);

  const systemPrompt =
    `You are an omniscient out-of-character (OOC) story & engine copilot for the user playing "${card.identity.name}" inside tavern-next (Pi RP extension). ` +
    `You have the COMPLETE live world state, memory ledger, beliefs, foresights, agendas, and extension feature map below. ` +
    `Answer the user's question directly, accurately, and concisely in the user's language. Do NOT write roleplay prose. ` +
    `Extension UI map (if the user asks how to manage or edit anything): ` +
    `世界面板(/rp panel) has 5 sections: 1.本局动态(近期变更/一键撤销/标记/事实/信念/伏笔/物理与空间), 2.场景与世界(地点/时间/目标/标记/时钟/剧情卡/幕间推演/镜头聚焦/幕后插叙), ` +
    `3.人物与关系(按角色一站式档案:心态/数值/外貌伤势站位/口癖底线/看法/背包/日程 + 关系网/马甲/共演), ` +
    `4.记忆、伏笔与世界书(世界书/记忆书/秘密盲区/信念/事实/伏笔/前情提要/隐藏恢复楼层/导出小说至rp-exports), ` +
    `5.导演台与设置(节奏/篇幅视角/禁词表/局部改写/导演指令/内心独白/快捷回复/AI建档/高级设置含Sidecar与语义向量Embedding).`;

  const userPrompt = [
    `Character core: ${card.identity.name} — ${card.frozen.description.slice(0, 1000)}`,
    card.frozen.personality ? `Personality: ${card.frozen.personality.slice(0, 400)}` : null,
    `Live world state: ${[state.era, state.worldTimeLabel, state.location, `Turn ${state.turn}`].filter(Boolean).join(" · ")} | Present: ${state.presentNpcs.join(", ") || "none"} | Player: ${state.currentPersona.name}`,
    state.sceneObjective ? `Scene objective: ${state.sceneObjective}` : null,
    activeFlags.length ? `Active Flags: ${activeFlags.join(", ")}` : null,
    cfsmList.length ? `Character CFSM: ${cfsmList.join(" | ")}` : null,
    statList.length ? `Stats: ${statList.slice(0, 16).join(" | ")}` : null,
    clockList.length ? `Clocks: ${clockList.join(" | ")}` : null,
    physList.length ? `Physical state:\n${physList.join("\n")}${state.spatialNotes ? `\nSpace: ${state.spatialNotes}` : ""}` : null,
    memBookList.length ? `Archived Memory Books:\n${memBookList.join("\n")}` : null,
    activeFacts.length ? `Established Facts & Secrets:\n${activeFacts.join("\n")}` : null,
    beliefList.length ? `Character Beliefs:\n${beliefList.join("\n")}` : null,
    hookList.length ? `Open Foresights:\n${hookList.join("\n")}` : null,
    agendaList.length ? `Off-screen NPC Agendas:\n${agendaList.join("\n")}` : null,
    bondList.length ? `NPC Pair Bonds:\n${bondList.join("\n")}` : null,
    recent.length ? `Recent dialogue:\n${recent.join("\n")}` : null,
    `User's OOC question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const task = beginGuardedLlmTask(rt, ctx, "场外分析思考中（不写入历史）…");
  let answer = "";
  try {
    answer = (await completeWithRegistry(ctx, ctx.model, { systemPrompt, userPrompt, maxTokens: 700, signal: task.signal })).trim();
  } catch (err) {
    ctx.ui.notify(`场外提问失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃显示场外回答。", "warning");
    return;
  }

  if (!answer) {
    ctx.ui.notify("模型未返回内容。", "warning");
    return;
  }

  if (typeof ctx.ui.editor === "function") {
    await ctx.ui.editor(`💭 场外回答（关闭即清除，不占上下文）· ${question.slice(0, 28)}`, answer);
  } else {
    const lines = answer.split(/\r?\n/).filter((l) => l.trim()).slice(0, 24);
    await ctx.ui.select(`💭 场外回答：${question.slice(0, 32)}`, [...lines, "✕ 关闭"]);
  }
}

/**
 * Memory-Books Archive & Hide Old Floors (`/rp summarize`):
 * Summarizes the earliest visible N dialogue floors into a structured, keyword/entity-recalled
 * Memory Book chapter (`memory_book_upsert`) and hides them non-destructively!
 */
export async function actionSummarizeOldFloors(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法自动总结旧楼层。", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const visibleMsgs = branch.filter((e) => {
    if (e.type !== "message" || !e.message) return false;
    if (e.message.role !== "user" && e.message.role !== "assistant") return false;
    const fp = computeMessageFingerprint(e.message);
    return !state.hiddenEntryIds.has(e.id) && !state.hiddenFingerprints.has(fp);
  });

  if (visibleMsgs.length < 4) {
    ctx.ui.notify("当前可见对话楼层少于 4 条，暂不需要归档总结。", "info");
    return;
  }

  let count = Number(argsText.trim());
  if (!Number.isFinite(count) || count <= 0) {
    const opt10 = Math.min(10, visibleMsgs.length - 2);
    const opt20 = Math.min(20, visibleMsgs.length - 2);
    const optKeep6 = Math.max(0, visibleMsgs.length - 6);
    const choices: Array<{ label: string; count: number }> = [
      { label: `总结最早的 ${opt10} 条并归档为记忆书章节（推荐）`, count: opt10 },
    ];
    if (opt20 > opt10) {
      choices.push({ label: `总结最早的 ${opt20} 条并归档为记忆书章节`, count: opt20 });
    }
    if (optKeep6 > 0 && optKeep6 !== opt10 && optKeep6 !== opt20) {
      choices.push({ label: `仅保留最近 6 条原文，其余 ${optKeep6} 条全部归档隐藏`, count: optKeep6 });
    }
    const labels = [...choices.map((c) => c.label), "✕ 取消"];
    const pick = await ctx.ui.select(
      `📦 归档较早的对话楼层 → 记忆书章节（当前可见 ${visibleMsgs.length} 条）`,
      labels,
    );
    if (!pick || pick.startsWith("✕")) return;
    const chosenIdx = labels.indexOf(pick);
    count = chosenIdx >= 0 && choices[chosenIdx] ? choices[chosenIdx]!.count : 0;
  }

  count = Math.min(Math.max(0, Math.floor(count)), visibleMsgs.length - 2);
  if (count <= 0) {
    ctx.ui.notify("没有可归档的旧楼层。", "info");
    return;
  }

  const targets = visibleMsgs.slice(0, count);
  const transcript = targets
    .map((e) => {
      const role = e.message!.role === "user" ? state.currentPersona.name : card.identity.name;
      return `[${role}] ${extractMsgPlain(e.message).slice(0, 500)}`;
    })
    .join("\n");

  const model = resolveSidecarModel(ctx, state.sidecarModel);
  const task = beginGuardedLlmTask(rt, ctx, `正在将最早 ${count} 条对话凝练为记忆书章节…`);
  let raw = "";
  try {
    raw = await completeWithRegistry(ctx, model, {
      systemPrompt:
        'Summarize the roleplay excerpt into a structured Memory Book chapter. Return ONLY strict JSON: {"title": string, "summary": string, "keywords": string[], "entities": string[]}. Keep summary dense, factual, and under 220 Chinese chars or 110 English words, preserving promises, clues, relationship changes, and emotional turning points.',
      userPrompt: transcript,
      maxTokens: 480,
      signal: task.signal,
    });
  } catch (err) {
    ctx.ui.notify(`总结失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃归档旧楼层。", "warning");
    return;
  }

  const parsed = extractJsonObject<{
    title?: string;
    summary?: string;
    keywords?: string[];
    entities?: string[];
  }>(raw);

  const chapterNum = state.memoryBooks.size + 1;
  const title = parsed?.title?.trim() || `第 ${chapterNum} 章 · ${state.location || state.era || "往事归档"}`;
  const summary = (parsed?.summary ?? stripThinkingBlocks(raw)).trim();
  const entities = Array.isArray(parsed?.entities)
    ? parsed.entities.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : [card.identity.name, ...(state.location ? [state.location] : [])];
  const keywords = Array.isArray(parsed?.keywords)
    ? parsed.keywords.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : entities;

  if (!summary) {
    ctx.ui.notify("未能生成有效摘要。", "warning");
    return;
  }

  const ok = await ctx.ui.confirm(
    `写入记忆书「${title}」并隐藏这 ${count} 条旧楼层？`,
    `触发词：${keywords.join("、") || "自动实体"}\n\n${summary}\n\n（旧楼层仅对模型隐藏，随时可恢复）`,
  );
  if (!ok) return;
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃写入记忆书。", "warning");
    return;
  }

  const startTurn = Math.max(1, state.turn - Math.ceil(visibleMsgs.length / 2));
  const endTurn = Math.max(startTurn, startTurn + Math.max(1, Math.floor(count / 2)));
  const book: MemoryBookEntry = {
    id: `book_${Date.now().toString(36)}`,
    title,
    summary,
    entities: Array.from(new Set(entities)),
    keywords: Array.from(new Set(keywords)),
    turnRange: [startTurn, endTurn],
    enabled: true,
    pinned: false,
    createdTurn: state.turn,
  };

  rt.commitTx({ kind: "memory_book_upsert", entry: book });
  rt.commitTx({
    kind: "hide_toggle",
    entryIds: targets.map((e) => e.id),
    fingerprints: targets.map((e) => computeMessageFingerprint(e.message!)),
    hidden: true,
  });
  rt.refreshHud(ctx);
  ctx.ui.notify(`✅ 已归档为记忆书章节「${title}」并隐藏 ${count} 条旧楼层（将随关键词/实体自动召回）。`, "info");
}

/**
 * Dynamic World Info Entry Generator (`/rp loregen`):
 * Extracts a new structured Lorebook entry for an emergent NPC, location, or organization
 * from the recent dialogue and saves it cleanly via `saveUpdatedCard`.
 */
export async function actionGenerateLoreEntry(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法生成世界书条目。", "warning");
    return;
  }

  let subject = argsText.trim();
  if (!subject) {
    const entered = (await ctx.ui.input("📚 输入要收录进世界书的新人物 / 地点 / 组织名称", ""))?.trim();
    if (!entered) return;
    subject = entered;
  }

  const recent = collectRecentDialogueLines(ctx, state, 10);
  const model = resolveSidecarModel(ctx, state.sidecarModel);
  const task = beginGuardedLlmTask(rt, ctx, `正在为「${subject}」生成世界书条目…`);
  let raw = "";
  try {
    raw = await completeWithRegistry(ctx, model, {
      systemPrompt:
        'Extract a concise World Info (Lorebook) entry for the requested subject based on the recent roleplay dialogue. Return ONLY strict JSON: {"title": string, "keys": string[], "content": string}. Keep content factual and under 220 chars.',
      userPrompt: `Subject: ${subject}\nRecent dialogue:\n${recent.join("\n")}`,
      maxTokens: 420,
      signal: task.signal,
    });
  } catch (err) {
    ctx.ui.notify(`生成失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃收录世界书条目。", "warning");
    return;
  }

  const parsed = extractJsonObject<{ title?: string; keys?: string[]; content?: string }>(raw);
  if (!parsed) {
    ctx.ui.notify("未能解析生成的世界书 JSON，请重试。", "warning");
    return;
  }

  const title = (parsed.title || subject).trim();
  const keys = Array.isArray(parsed.keys)
    ? parsed.keys.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim())
    : [subject];
  if (!keys.includes(subject)) keys.unshift(subject);
  const content = (parsed.content || "").trim();
  if (!content) {
    ctx.ui.notify("生成的条目正文为空。", "warning");
    return;
  }

  const ok = await ctx.ui.confirm(
    `收录世界书条目「${title}」？`,
    `触发词：${keys.join("、")}\n\n${content}`,
  );
  if (!ok) return;
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃收录世界书条目。", "warning");
    return;
  }

  const compiledBook = compileLoreBook({
    entries: [
      {
        id: `lore_gen_${Date.now().toString(36)}`,
        comment: title,
        keys,
        content,
        enabled: true,
        constant: false,
        insertion_order: 100,
      },
    ],
  });
  const newEntry: CompiledLoreEntry | undefined = compiledBook.entries[0];
  if (!newEntry) return;

  card.loreBook.entries.push(newEntry);
  if (state.worldDir) {
    try {
      saveUpdatedCard(state.worldDir, card);
      rt.reloadRuntime(ctx);
    } catch (err) {
      ctx.ui.notify(`保存世界书失败（本次会话仍生效）：${(err as Error).message}`, "warning");
    }
  } else {
    ctx.ui.notify("当前角色卡缺少持久化目录，新条目仅在本次会话内存中生效。", "warning");
  }
  ctx.ui.notify(`✅ 已将「${title}」收录进当前角色卡世界书（触发词：${keys.join("、")}）。`, "info");
}

// ---------------------------------------------------------------------------
// v3 New Actions: Quick Replies, Context X-Ray, Reversible Undo, Sidecar Model Picker, Asset Library CRUD
// ---------------------------------------------------------------------------

/** 1-tap Quick Replies & Action Macros (`/rp qr` & `Alt+E`), persisted in global `ui-prefs.json`. */
export async function actionQuickReplies(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  let items = loadQuickReplies();
  const arg = argsText.trim();
  if (arg) {
    const byIdx = /^\d+$/.test(arg) ? items[Number(arg) - 1] : undefined;
    const matched = byIdx ?? items.find((i) => i.id === arg || i.label.includes(arg));
    if (matched) {
      executeQuickReply(rt, ctx, matched);
      return;
    }
  }

  while (true) {
    items = loadQuickReplies();
    const modeTag = (m: QuickReplyItem["mode"]) => (m === "send" ? "发送" : m === "editor" ? "预填" : "导演");
    const opts = [
      ...items.map((it, idx) => `${idx + 1}. [${modeTag(it.mode)}] ${it.label} — ${previewText(it.text, 34)}`),
      "+ 新建快捷回复 / 动作宏",
      "🗑 删除一条快捷回复",
      "↺ 恢复默认快捷回复",
      "✕ 关闭",
    ];
    const pick = await ctx.ui.select("⚡ 快捷回复与常用动作宏", opts);
    if (!pick || pick.startsWith("✕")) return;

    if (pick.startsWith("+")) {
      const label = (await ctx.ui.input("按钮名称（如：🔍 搜查房间）", ""))?.trim();
      if (!label) continue;
      const text = (await ctx.ui.input("触发内容文本", ""))?.trim();
      if (!text) continue;
      const mPick = await ctx.ui.select("触发方式", [
        "send — 立即作为玩家消息发送",
        "editor — 填入输入框等待修改后发送",
        "steer — 注入 1 轮临时导演指令",
      ]);
      if (!mPick) continue;
      const mode = mPick.split(" ")[0] as QuickReplyItem["mode"];
      items.push({ id: `qr_${Date.now().toString(36)}`, label, text, mode });
      saveQuickReplies(items);
      ctx.ui.notify(`已添加快捷回复：${label}`, "info");
      continue;
    }

    if (pick.startsWith("🗑")) {
      const delOpts = [...items.map((it, i) => `${i + 1}. ${it.label}`), "← 返回"];
      const delPick = await ctx.ui.select("选择要删除的快捷回复", delOpts);
      if (!delPick || delPick.startsWith("←")) continue;
      const delIdx = delOpts.indexOf(delPick);
      if (delIdx >= 0 && items[delIdx]) {
        const removed = items.splice(delIdx, 1)[0]!;
        saveQuickReplies(items);
        ctx.ui.notify(`已删除快捷回复：${removed.label}`, "info");
      }
      continue;
    }

    if (pick.startsWith("↺")) {
      saveQuickReplies(DEFAULT_QUICK_REPLIES.map((d) => ({ ...d })));
      ctx.ui.notify("已恢复默认快捷回复列表。", "info");
      continue;
    }

    const idx = opts.indexOf(pick);
    const chosen = items[idx];
    if (chosen) {
      executeQuickReply(rt, ctx, chosen);
      return;
    }
  }
}

function executeQuickReply(rt: RpRuntimeHandle, ctx: PiExtensionContext, item: QuickReplyItem): void {
  if (item.mode === "editor") {
    ctx.ui.setEditorText(item.text);
    ctx.ui.notify(`已预填至输入框：${item.label}`, "info");
    return;
  }
  if (item.mode === "steer") {
    rt.commitTx({
      kind: "note_set",
      note: { id: `qr_note_${Date.now().toString(36)}`, text: item.text, remainingTurns: 1 },
    });
    rt.refreshHud(ctx);
    ctx.ui.notify(`已注入 1 轮导演微调：${item.label}`, "info");
    return;
  }
  if (typeof rt.pi.sendUserMessage === "function") {
    const busy = ctx.isIdle?.() === false;
    rt.pi.sendUserMessage(item.text, busy ? { deliverAs: "followUp" } : undefined);
  } else {
    rt.pi.sendMessage(
      { customType: "rp:event", content: item.text, display: true, details: { kind: "quick_reply" } },
      { triggerTurn: true },
    );
  }
}

/** Live Context X-Ray Inspector (`/rp xray` & `Alt+X`): displays Zone 1/2/3 budget, KV-Cache hash, and exact lore/memory recall traces. */
export async function actionXRay(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const xray = rt.getLastXRay();
  if (!xray) {
    ctx.ui.notify("尚未捕获上下文快照，发送一轮对话后即可查看完整 X-Ray 透视。", "info");
    return;
  }

  const totalTokens = xray.zone1Tokens + xray.zone2Tokens + xray.zone3Tokens;
  const kvReasonMap: Record<string, string> = {
    prefix_hit: "✅ 前缀缓存命中",
    first_turn: "🆕 首轮建立缓存",
    tools_changed: "⚠ 工具列表变更导致刷新",
    zone1_changed: "⚠ 常驻设定变更导致刷新",
    history_mutated: "⚠ 对话历史变更（隐藏/压缩/回溯）",
  };
  const kvReason = kvReasonMap[xray.cacheInvalidationReason ?? ""] ?? "已监控";
  const repPct = Math.round((xray.repetitionScore ?? 0) * 100);
  const stagTurns = xray.stagnantTurns ?? 0;

  const lines: string[] = [
    `缓存状态: ${kvReason}  │  连续命中 ×${xray.cacheHitStreak}`,
    `Token 分布: 常驻设定 ~${xray.zone1Tokens}t · 对话历史 ~${xray.zone2Tokens}t · 动态上下文 ~${xray.zone3Tokens}t · 总计 ~${totalTokens}t`,
    `世界书预算: ${xray.loreTokens}/${xray.loreBudget}t  │  已隐藏楼层: ${xray.hiddenFloorCount} 楼`,
    `叙事健康度: 复读重叠率 ${repPct}%${repPct >= 42 ? " (⚠触发去重)" : " (正常)"}  │  距上次世界推进 ${stagTurns} 轮${stagTurns >= 4 ? " (⚠停滞)" : ""}`,
    `记忆与隔离: 有效事实 ${xray.activeFactCount} 条 · 认知盲区保护 ${xray.blindSpotCount} 处 · 激活剧情卡 ${xray.activeStoryletTitles.length} 张`,
  ];

  if (xray.activeStoryletTitles.length > 0) {
    lines.push(`触发 Storylets: ${xray.activeStoryletTitles.join("、")}`);
  }

  if (xray.recalled.length > 0) {
    lines.push("", `【本轮召回条目 (${xray.recalled.length})】`);
    for (const r of xray.recalled) {
      const src = r.source === "memory_book" ? "记忆书" : "世界书";
      const key = r.matchedKey ? ` 命中="${r.matchedKey}"` : "";
      lines.push(`· [${src}/${r.reason}] ${r.title}${key} (分:${r.score} · ~${r.tokens}t)`);
    }
  } else {
    lines.push("", "【本轮召回条目】无动态召回（仅常驻设定生效）");
  }

  if (xray.gatedOut.length > 0) {
    lines.push("", `【防剧透门禁拦截 (${xray.gatedOut.length})】${xray.gatedOut.slice(0, 6).map((g) => g.title).join("、")}`);
  }
  if (xray.budgetDropped.length > 0) {
    lines.push(
      "",
      `【超出预算裁切 (${xray.budgetDropped.length})】${xray.budgetDropped
        .slice(0, 5)
        .map((d) => `${d.title}(${d.tokens}t)`)
        .join("、")}`,
    );
  }

  rt.pi.sendMessage(
    {
      customType: "rp:event",
      content: lines.join("\n"),
      display: true,
      details: {
        kind: "xray",
        title: `${card.identity.name} · 上下文透视`,
        subtitle: `T${xray.turn} · ~${totalTokens}t`,
      },
    },
    { triggerTurn: false },
  );
}

/** Reversible State Audit Log & 1-Click Undo (`/rp undo`). */
export async function actionUndoTx(rt: RpRuntimeHandle, ctx: PiExtensionContext, autoLast = false): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const undoable = state.auditLog.filter((r) => Boolean(r.undoTx)).slice().reverse();
  if (undoable.length === 0) {
    ctx.ui.notify("暂无可撤销的状态变更记录。", "info");
    return;
  }

  if (autoLast) {
    const latest = undoable[0]!;
    const ok = await ctx.ui.confirm("撤销最近一次状态变更？", `[T${latest.turn}] ${latest.summary}`);
    if (!ok) return;
    rt.commitTx(latest.undoTx!);
    rt.refreshHud(ctx);
    ctx.ui.notify(`↩ 已撤销：${latest.summary}`, "info");
    return;
  }

  const opts = [
    ...undoable.slice(0, 14).map((r, i) => `${i + 1}. [T${r.turn}] ${r.summary}`),
    "✕ 取消",
  ];
  const pick = await ctx.ui.select(`↩ 状态变更审计日志（点击任一条目即可反向撤销 · 共 ${undoable.length} 条）`, opts);
  if (!pick || pick.startsWith("✕")) return;
  const idx = opts.indexOf(pick);
  const chosen = undoable[idx];
  if (!chosen?.undoTx) return;

  rt.commitTx(chosen.undoTx);
  rt.refreshHud(ctx);
  ctx.ui.notify(`↩ 已反向撤销：[T${chosen.turn}] ${chosen.summary}`, "info");
}

/** Pick a dedicated fast/cheap model from `ctx.modelRegistry` for Sidecar settlement, Compaction & Loregen (`/rp sidecar`). */
export async function actionSidecarModel(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const arg = argsText.trim();
  if (arg === "default" || arg === "auto" || arg === "off") {
    rt.commitTx({ kind: "config_patch", sidecarModel: null });
    rt.refreshHud(ctx);
    ctx.ui.notify("Sidecar 后台模型已恢复为：跟随当前主对话模型。", "info");
    return;
  }
  if (arg) {
    rt.commitTx({ kind: "config_patch", sidecarModel: arg });
    rt.refreshHud(ctx);
    ctx.ui.notify(`Sidecar 后台模型已设为：${arg}`, "info");
    return;
  }

  const models = listRegistryModels(ctx);
  const opts = [
    "🔄 跟随当前主对话模型（默认）",
    ...models.slice(0, 30).map((m) => `🤖 ${m.label}${m.isFastHint ? " ⚡推荐" : ""}`),
    "✏️ 手动输入 provider/model-id",
    "✕ 取消",
  ];
  const pick = await ctx.ui.select(
    `🤖 选择 Sidecar 后台专职模型（当前：${state.sidecarModel || "跟随主模型"} · 用于后台结算/摘要/世界书生成）`,
    opts,
  );
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("🔄")) {
    rt.commitTx({ kind: "config_patch", sidecarModel: null });
    rt.refreshHud(ctx);
    ctx.ui.notify("Sidecar 后台模型已恢复为跟随主对话模型。", "info");
    return;
  }
  if (pick.startsWith("✏️")) {
    const manual = (await ctx.ui.input("输入 provider/model-id（如 google/gemini-2.5-flash）", state.sidecarModel ?? ""))?.trim();
    if (!manual) return;
    rt.commitTx({ kind: "config_patch", sidecarModel: manual });
    rt.refreshHud(ctx);
    ctx.ui.notify(`Sidecar 后台模型已设为：${manual}`, "info");
    return;
  }

  const chosen = models[opts.indexOf(pick) - 1];
  if (chosen) {
    rt.commitTx({ kind: "config_patch", sidecarModel: chosen.key });
    rt.refreshHud(ctx);
    ctx.ui.notify(`Sidecar 后台模型已设为：${chosen.key}`, "info");
  }
}

/** Asset Library CRUD manager (`/rp library`): inspect & safely delete cards, presets, and personas. */
export async function actionManageLibrary(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const cards = listAllCardSummaries(ctx.cwd);
    const presets = listPresetIds(ctx.cwd);
    const personas = loadPersonas(ctx.cwd);
    const pick = await ctx.ui.select("🗂 RP 资产库管理（项目库 & 全局库）", [
      `🎭 管理已导入角色卡 (${cards.length} 张)`,
      `🎛 管理已导入酒馆预设 (${presets.length} 个)`,
      `🧑 管理已保存玩家马甲 (${personas.length} 个)`,
      "← 返回",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🎭")) {
      if (cards.length === 0) {
        ctx.ui.notify("角色库为空。", "info");
        continue;
      }
      const opts = [
        ...cards.map((c) => `🗑 ${c.name} (${c.slug}) [${c.source === "project" ? "项目" : "全局库"} · 世界书 ${c.loreCount} 条]`),
        "← 返回",
      ];
      const sub = await ctx.ui.select("选择要删除的角色卡（当前正在游玩的主卡受保护）", opts);
      if (!sub || sub.startsWith("←")) continue;
      const chosen = cards[opts.indexOf(sub)];
      if (!chosen) continue;
      if (rt.getState().active && rt.getState().cardSlug === chosen.slug) {
        ctx.ui.notify("无法删除当前会话正在游玩的主角色卡，请先 /rp exit 或切换角色。", "warning");
        continue;
      }
      const ok = await ctx.ui.confirm("确认删除角色卡？", `永久删除「${chosen.name}」(${chosen.slug}) 及其解包资源？`);
      if (ok) {
        deleteCompiledCard(chosen.baseDir, chosen.slug);
        ctx.ui.notify(`已删除角色卡：${chosen.name}`, "info");
      }
    } else if (pick.startsWith("🎛")) {
      if (presets.length === 0) {
        ctx.ui.notify("暂无已导入的酒馆预设。", "info");
        continue;
      }
      const sub = await ctx.ui.select("选择要删除的酒馆预设", [...presets.map((p) => `🗑 ${p}`), "← 返回"]);
      if (!sub || sub.startsWith("←")) continue;
      const id = sub.replace(/^🗑\s+/, "");
      const ok = await ctx.ui.confirm("确认删除预设？", `删除预设「${id}」？`);
      if (ok) {
        deleteCompiledPreset(ctx.cwd, id);
        if (rt.getState().presetId === id) {
          rt.commitTx({ kind: "preset_set", presetId: null });
          rt.reloadRuntime(ctx);
        }
        ctx.ui.notify(`已删除预设：${id}`, "info");
      }
    } else if (pick.startsWith("🧑")) {
      if (personas.length === 0) {
        ctx.ui.notify("暂无已保存的玩家马甲。", "info");
        continue;
      }
      const opts = [...personas.map((p) => `🗑 ${p.name} (${p.id})`), "← 返回"];
      const sub = await ctx.ui.select("选择要删除的玩家马甲", opts);
      if (!sub || sub.startsWith("←")) continue;
      const chosen = personas[opts.indexOf(sub)];
      if (!chosen) continue;
      const ok = await ctx.ui.confirm("确认删除玩家马甲？", `删除马甲「${chosen.name}」？`);
      if (ok) {
        deletePersona(ctx.cwd, chosen.id);
        ctx.ui.notify(`已删除玩家马甲：${chosen.name}`, "info");
      }
    }
  }
}



/**
 * 1. Targeted Partial Rewrite (`/rp rewrite`):
 * Rewrites ONLY the parts of the last assistant reply specified by the user via an isolated model call,
 * shows a preview, and non-destructively replaces the old floor (preserving original in `/rp unhide`).
 */
export async function actionRewriteLast(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (ctx.isIdle?.() === false) {
    ctx.ui.notify("当前正在生成回复，请等待结束后再改写。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法执行局部改写。", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  let lastTarget: { entry: (typeof branch)[number]; msg: PiMessage } | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    const m = normalizeBranchMessage(e);
    if (!m) continue;
    const isRewritable = m.role === "assistant" || m.customType === "rp:rewrite" || m.customType === "rp:greeting";
    if (!isRewritable) continue;
    const fp = computeMessageFingerprint(m);
    if (!state.hiddenEntryIds.has(e.id) && !state.hiddenFingerprints.has(fp)) {
      lastTarget = { entry: e, msg: m };
      break;
    }
  }
  if (!lastTarget) {
    ctx.ui.notify("当前分支没有可改写的回复。", "info");
    return;
  }

  const original = extractMsgPlain(lastTarget.msg).trim();
  if (!original) {
    ctx.ui.notify("上一条回复内容为空。", "info");
    return;
  }

  let instruction = argsText.trim();
  if (!instruction) {
    const pick = await ctx.ui.select("✂️ 局部定向改写上一条回复", [
      "✏️ 输入具体改写要求（如：保留前两段，只改结尾让她拒绝交易）",
      "🧹 去 AI 味润色（保留全部剧情，去掉翻译腔与陈词滥调）",
      "📉 精简压缩篇幅（保留关键动作与对白，压到 350 字以内）",
      "🔥 增强人物锋芒（让角色更克制、更有防备心与潜台词）",
      "✕ 取消",
    ]);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("✏️")) {
      const entered = (await ctx.ui.input("输入局部改写要求", ""))?.trim();
      if (!entered) return;
      instruction = entered;
    } else {
      instruction = pick.replace(/^[^\s]+\s+/, "");
    }
  }

  const task = beginGuardedLlmTask(rt, ctx, "正在按要求定向改写上一条回复…");
  let rewritten = "";
  try {
    rewritten = (
      await completeWithRegistry(ctx, ctx.model, {
        systemPrompt:
          `You are a skilled fiction editor actively revising a roleplay reply for "${card.identity.name}". ` +
          `You MUST make concrete, clearly noticeable textual revisions that fully satisfy the user's edit request — NEVER return an unchanged copy of the original text. ` +
          `Keep story continuity and the original language, and output ONLY the revised prose (no meta commentary, no markdown fences).`,
        userPrompt: `Original reply:\n${original}\n\nMandatory edit instruction (apply visibly and thoroughly):\n${instruction}\n\nOutput the revised reply now:`,
        maxTokens: 4096,
        signal: task.signal,
      })
    ).trim();
  } catch (err) {
    ctx.ui.notify(`改写失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃本次改写结果。", "warning");
    return;
  }

  if (!rewritten) {
    ctx.ui.notify("未生成有效改写结果。", "warning");
    return;
  }

  const norm = (t: string) => t.replace(/[\s\p{P}]+/gu, "");
  if (norm(rewritten) === norm(original)) {
    ctx.ui.notify("⚠️ 模型返回了与原文几乎一致的内容，未执行替换。请尝试输入更具体的改写要求。", "warning");
    return;
  }

  const ok = await ctx.ui.confirm(
    `确认替换为改写版本？（原 ${original.length} 字 → 改写后 ${rewritten.length} 字，原楼层对模型隐藏）`,
    rewritten.slice(0, 600) + (rewritten.length > 600 ? "\n…（已截断预览）" : ""),
  );
  if (!ok) return;
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃替换改写结果。", "warning");
    return;
  }

  const fp = computeMessageFingerprint(lastTarget.msg);
  rt.commitTx({ kind: "hide_toggle", entryIds: [lastTarget.entry.id], fingerprints: [fp], hidden: true });
  rt.pi.sendMessage(
    {
      customType: "rp:rewrite",
      content: rewritten,
      display: true,
      details: { kind: "rewrite", instruction },
    },
    { triggerTurn: false },
  );
  ctx.ui.notify("✅ 已非破坏性替换为改写版本（原楼层已隐藏，/rp unhide 可随时找回）。", "info");
}

/**
 * 2. Response Length & Narrative POV Control (`/rp style`):
 * 1-tap Bottom Sheet to configure response length & POV, injected cleanly via Zone 3.
 */
export async function actionStyleControl(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const lenZh: Record<ResponseLengthMode, string> = {
    concise: "精炼快节奏 (~200-350字)",
    standard: "标准均衡 (默认)",
    novel: "小说长篇 (~650-1000字)",
  };
  const povZh: Record<NarrativePovMode, string> = {
    auto: "跟随角色卡默认",
    second: "第二人称「你」",
    third: "第三人称叙事",
    first_char: "角色第一人称",
  };

  const arg = argsText.trim().toLowerCase();
  if (arg === "concise" || arg === "standard" || arg === "novel") {
    rt.commitTx({ kind: "config_patch", responseLength: arg });
    ctx.ui.notify(`篇幅档位已切换：${lenZh[arg]}`, "info");
    return;
  }
  if (arg === "auto" || arg === "second" || arg === "third" || arg === "first_char") {
    rt.commitTx({ kind: "config_patch", narrativePov: arg });
    ctx.ui.notify(`叙事视角已切换：${povZh[arg]}`, "info");
    return;
  }

  const pick = await ctx.ui.select(
    `✒️ 篇幅与视角控制（当前：${lenZh[state.responseLength]} · ${povZh[state.narrativePov]}）`,
    [
      "📏 切换回复篇幅（精炼 / 标准 / 小说长篇）",
      "👁 切换叙事视角（默认 / 第二人称 / 第三人称 / 角色第一人称）",
      "✕ 返回",
    ],
  );
  if (!pick || pick.startsWith("✕")) return;

  if (pick.startsWith("📏")) {
    const p = await ctx.ui.select("选择回复篇幅档位", [
      "concise — ⚡ 精炼快节奏（200-350字，适合高频对话）",
      "standard — 📖 标准均衡（默认，不额外限制）",
      "novel — 📚 小说长篇（650-1000字，细节与潜台词丰满）",
    ]);
    if (!p) return;
    const next = p.split(" ")[0] as ResponseLengthMode;
    rt.commitTx({ kind: "config_patch", responseLength: next });
    ctx.ui.notify(`篇幅档位已切换：${lenZh[next]}`, "info");
  } else {
    const p = await ctx.ui.select("选择叙事人称视角", [
      "auto — 跟随角色卡原设定（默认）",
      "second — 第二人称（以「你」沉浸代入）",
      "third — 第三人称（文学旁观/限知视角）",
      "first_char — 角色第一人称（角色自述）",
    ]);
    if (!p) return;
    const next = p.split(" ")[0] as NarrativePovMode;
    rt.commitTx({ kind: "config_patch", narrativePov: next });
    ctx.ui.notify(`叙事视角已切换：${povZh[next]}`, "info");
  }
}

/**
 * 3. Dynamic Anti-Slop Banlist Manager (`/rp ban`):
 * Lets players curate session-specific banned clichés (paired with automatic repetition detection in Zone 3).
 */
export async function actionBanPhrases(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const arg = argsText.trim();
  if (arg) {
    const additions = arg.split(/[,，/]/).map((x) => x.trim()).filter(Boolean);
    const next = Array.from(new Set([...state.bannedPhrases, ...additions]));
    rt.commitTx({ kind: "config_patch", bannedPhrases: next });
    ctx.ui.notify(`已加入本局禁词表：${additions.join("、")}`, "info");
    return;
  }

  const CN_SLOP_PACK = ["眼底闪过一丝", "空气仿佛凝固", "喉结滚动", "嘴角勾起一抹", "指节发白", "心头一震", "不禁", "仿佛"];
  while (true) {
    const cur = rt.getState().bannedPhrases;
    const pick = await ctx.ui.select(
      `🚫 反 AI 套话禁词表（当前 ${cur.length} 词 · 另含自动复读检测）`,
      [
        "+ 添加自定义禁词（逗号分隔）",
        "📦 一键导入中文常见 AI 套话包（8 词）",
        ...cur.map((w) => `🗑 移除：${w}`),
        ...(cur.length > 0 ? ["🧹 清空全部禁词"] : []),
        "← 返回",
      ],
    );
    if (!pick || pick.startsWith("←")) return;
    if (pick.startsWith("+")) {
      const entered = (await ctx.ui.input("输入要禁止的词或短语（逗号分隔）", ""))?.trim();
      if (!entered) continue;
      const adds = entered.split(/[,，/]/).map((x) => x.trim()).filter(Boolean);
      rt.commitTx({ kind: "config_patch", bannedPhrases: Array.from(new Set([...cur, ...adds])) });
    } else if (pick.startsWith("📦")) {
      rt.commitTx({ kind: "config_patch", bannedPhrases: Array.from(new Set([...cur, ...CN_SLOP_PACK])) });
      ctx.ui.notify("已导入中文常见 AI 套话包。", "info");
    } else if (pick.startsWith("🧹")) {
      rt.commitTx({ kind: "config_patch", bannedPhrases: [] });
      ctx.ui.notify("已清空自定义禁词表。", "info");
    } else if (pick.startsWith("🗑")) {
      const target = pick.replace(/^🗑 移除：/, "");
      rt.commitTx({ kind: "config_patch", bannedPhrases: cur.filter((x) => x !== target) });
    }
  }
}

/**
 * 4a. Group-Cast Spotlight (`/rp spotlight`):
 * Picks a specific NPC to take the narrative center stage on the next turn (1-turn director spotlight).
 */
export async function actionSpotlight(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  let target = argsText.trim();
  if (!target) {
    const candidates = Array.from(
      new Set([
        ...state.presentNpcs,
        ...rt.getExtraCastCards().map((c) => c.identity.nickname || c.identity.name),
      ]),
    ).filter(Boolean);
    const pick = await ctx.ui.select("🔦 群像镜头切换：指定下一轮主导角色 (Spotlight)", [
      ...candidates.map((n) => `🎭 镜头聚焦：${n}`),
      "✏️ 输入指定 NPC 名字",
      "✕ 取消",
    ]);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("✏️")) {
      target = (await ctx.ui.input("输入下一轮重点描写的角色名", ""))?.trim() || "";
    } else {
      target = pick.replace(/^🎭 镜头聚焦：/, "").trim();
    }
  }
  if (!target) return;

  rt.commitTx({
    kind: "note_set",
    note: {
      id: `spotlight_${Date.now().toString(36)}`,
      text: `[镜头聚焦] 下一回合请将叙事重心交给「${target}」，重点刻画其立场、神态、主动发言或暗中举动。`,
      remainingTurns: 1,
    },
  });
  rt.refreshHud(ctx);
  ctx.ui.notify(`🔦 已将下一轮镜头聚焦至「${target}」（生效 1 轮）。`, "info");
}

/**
 * 4b. Zero-Pollution Off-Screen Interlude / Side-Scene (`/rp interlude`):
 * Generates an isolated off-screen NPC/villain POV scene or fun parallel mini-theater WITHOUT polluting main chat!
 */
export async function actionInterlude(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  if (!canCompleteWithRegistry(ctx)) {
    ctx.ui.notify("当前环境不支持模型调用，无法生成插叙小剧场。", "warning");
    return;
  }

  let promptTopic = argsText.trim();
  if (!promptTopic) {
    const pick = await ctx.ui.select("🎞 零污染幕后插叙 / 小剧场（不改变主线状态与时间）", [
      "🕵️ 此时此刻·幕后视角（不在场人物/暗流势力正在做什么）",
      "💭 角色独白视角（刚才那场戏结束后，TA 独自一人时的真实想法）",
      "💬 江湖/论坛体吐槽（旁观者视角议论最近发生的事）",
      "✏️ 自定义插叙或番外主题",
      "✕ 取消",
    ]);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("✏️")) {
      promptTopic = (await ctx.ui.input("输入想看的插叙/番外主题", ""))?.trim() || "";
    } else {
      promptTopic = pick.replace(/^[^\s]+\s+/, "");
    }
  }
  if (!promptTopic) return;

  const recent = collectRecentDialogueLines(ctx, state, 8);
  const facts = getActiveFacts(state).slice(-6).map((f) => `- ${f.statement}`).join("\n");
  const task = beginGuardedLlmTask(rt, ctx, "正在生成幕后插叙…");
  let text = "";
  try {
    text = (
      await completeWithRegistry(ctx, ctx.model, {
        systemPrompt:
          `Write an engaging, self-contained off-screen interlude / side-scene for "${card.identity.name}". ` +
          `Stay faithful to established character voices and world tone. Match the story's language. Output ONLY the scene prose (~350-650 chars).`,
        userPrompt:
          `World state: ${[state.era, state.worldTimeLabel, state.location].filter(Boolean).join(" · ")}\n` +
          (facts ? `Facts:\n${facts}\n\n` : "") +
          (recent.length ? `Recent main scene:\n${recent.join("\n")}\n\n` : "") +
          `Interlude request: ${promptTopic}`,
        maxTokens: 1100,
        signal: task.signal,
      })
    ).trim();
  } catch (err) {
    ctx.ui.notify(`生成失败：${(err as Error).message}`, "error");
    return;
  } finally {
    task.cleanup();
  }
  if (!task.isStillValid()) {
    ctx.ui.notify("会话或分支已变更，已放弃显示幕后插叙。", "warning");
    return;
  }
  if (!text) return;

  if (typeof ctx.ui.editor === "function") {
    await ctx.ui.editor(`🎞 幕后插叙（关闭即清除，不污染主线）· ${promptTopic.slice(0, 22)}`, text);
  } else {
    await ctx.ui.select(`🎞 幕后插叙`, [...text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 28), "✕ 关闭"]);
  }
}

/**
 * 5. Export Clean Novel (`/rp export`):
 * Exports the active branch as a clean Markdown novel (excluding OOC, hidden floors, and system cards).
 */
export async function actionExportNovel(rt: RpRuntimeHandle, ctx: PiExtensionContext, argsText: string): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active || !card) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  const sections: string[] = [
    `# ${card.identity.name}`,
    `> 导出时间：${new Date().toISOString().slice(0, 16).replace("T", " ")} · 玩家：${state.currentPersona.name} · 共 ${state.turn} 轮`,
    "",
  ];

  let chapterIdx = 0;
  let msgCount = 0;
  for (const e of branch) {
    const m = normalizeBranchMessage(e);
    if (!m) continue;
    if (m.customType === "rp:ooc" || m.customType === "rp:event") continue;
    const fp = computeMessageFingerprint(m);
    if (state.hiddenEntryIds.has(e.id) || state.hiddenFingerprints.has(fp)) continue;
    const txt = extractMsgPlain(m).trim();
    if (!txt || txt.startsWith("[OOC")) continue;

    if (m.customType === "rp:era") {
      chapterIdx += 1;
      sections.push(`## 第 ${chapterIdx} 节`, "", `> ${txt.split("\n")[0]}`, "");
      continue;
    }
    if (m.role === "user") {
      sections.push(`**${state.currentPersona.name}**：${txt}`, "");
      msgCount += 1;
    } else if (m.role === "assistant" || m.customType === "rp:greeting" || m.customType === "rp:rewrite") {
      sections.push(txt, "");
      msgCount += 1;
    }
  }

  if (msgCount === 0) {
    ctx.ui.notify("当前分支还没有可导出的正文内容。", "info");
    return;
  }

  const exportDir = path.join(ctx.cwd || state.worldDir || getGlobalLibraryDir(), "rp-exports");
  const stamp = new Date().toISOString().slice(0, 10);
  const customName = argsText.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "_");
  const fileName = customName ? `${customName}.md` : `${card.slug}-${stamp}.md`;
  const outPath = path.join(exportDir, fileName);
  const fullText = sections.join("\n");
  try {
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(outPath, fullText, "utf-8");
  } catch (err) {
    ctx.ui.notify(`导出小说失败：${(err as Error).message}`, "error");
    return;
  }

  ctx.ui.notify(`📖 已导出纯净小说（${msgCount} 段，约 ${fullText.length} 字）：${outPath}`, "info");
}


// ---------------------------------------------------------------------------
// 6. Anti-Godmoding Guard & Portable World Save Snapshot (`.rp-save.json`)
// ---------------------------------------------------------------------------

interface PortableWorldSaveV1 {
  version: 1;
  exportedAt: string;
  cardSlug: string | null;
  cardName: string;
  turn: number;
  state: {
    stats: SessionRpState["stats"];
    statBounds: SessionRpState["statBounds"];
    inventory: SessionRpState["inventory"];
    flags: SessionRpState["flags"];
    clocks: SessionRpState["clocks"];
    cfsmDefs: SessionRpState["cfsmDefs"];
    cfsmStates: SessionRpState["cfsmStates"];
    facts: Array<SessionRpState["facts"] extends Map<string, infer V> ? V : never>;
    beliefs: SessionRpState["beliefs"];
    foresights: Array<SessionRpState["foresights"] extends Map<string, infer V> ? V : never>;
    memoryBooks: Array<SessionRpState["memoryBooks"] extends Map<string, infer V> ? V : never>;
    storylets: Array<SessionRpState["storylets"] extends Map<string, infer V> ? V : never>;
    physicalState: SessionRpState["physicalState"];
    spatialNotes: string;
    agendas: SessionRpState["npcAgendas"];
    pairBonds: SessionRpState["pairBonds"];
    voiceAnchors: SessionRpState["voiceAnchors"];
    era: string;
    day: number;
    worldTimeLabel: string;
    location: string;
    presentNpcs: string[];
    sceneObjective: string;
    pacingMode: PacingMode;
    antiGodmoding: boolean;
  };
}

/** Toggle strict anti-godmoding guard (`/rp godmode`): prevents characters from acting or speaking on behalf of the player. */
export async function actionToggleAntiGodmoding(rt: RpRuntimeHandle, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }
  const cur = Boolean((state as SessionRpState & { antiGodmoding?: boolean }).antiGodmoding);
  const next = !cur;
  rt.commitTx({ kind: "anti_godmoding_set", enabled: next } as unknown as RpTxEntry);
  rt.refreshHud(ctx);
  ctx.ui.notify(
    next ? "🛡 防抢戏守卫已开启（严禁角色代演玩家的动作与台词）。" : "🛡 防抢戏守卫已关闭。",
    "info",
  );
}

/** Export portable `.rp-save.json` world snapshot to `cwd/rp-saves/<slug>-<date>.rp-save.json`. */
export async function actionExportWorldSave(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const state = rt.getState();
  const card = rt.getCard();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。", "warning");
    return;
  }

  const slug = (card?.slug || state.cardSlug || "world").replace(/[^a-zA-Z0-9一-龥_-]+/g, "_");
  const stamp = new Date().toISOString().slice(0, 10);
  const customRaw = argsText.trim().replace(/[^a-zA-Z0-9一-龥_.-]+/g, "_");
  const fileName = customRaw
    ? customRaw.endsWith(".rp-save.json")
      ? customRaw
      : `${customRaw}.rp-save.json`
    : `${slug}-${stamp}.rp-save.json`;

  const saveDir = path.join(ctx.cwd || state.worldDir || getGlobalLibraryDir(), "rp-saves");
  const outPath = path.join(saveDir, fileName);

  const payload: PortableWorldSaveV1 = {
    version: 1,
    exportedAt: new Date().toISOString(),
    cardSlug: state.cardSlug,
    cardName: card?.identity.name ?? state.cardSlug ?? "RP",
    turn: state.turn,
    state: {
      stats: state.stats,
      statBounds: state.statBounds,
      inventory: state.inventory,
      flags: state.flags,
      clocks: state.clocks,
      cfsmDefs: state.cfsmDefs,
      cfsmStates: state.cfsmStates,
      facts: Array.from(state.facts.values()),
      beliefs: state.beliefs,
      foresights: Array.from(state.foresights.values()),
      memoryBooks: Array.from(state.memoryBooks.values()),
      storylets: Array.from(state.storylets.values()),
      physicalState: state.physicalState,
      spatialNotes: state.spatialNotes,
      agendas: state.npcAgendas,
      pairBonds: state.pairBonds,
      voiceAnchors: state.voiceAnchors,
      era: state.era,
      day: state.day,
      worldTimeLabel: state.worldTimeLabel,
      location: state.location,
      presentNpcs: state.presentNpcs,
      sceneObjective: state.sceneObjective,
      pacingMode: state.pacingMode,
      antiGodmoding: Boolean((state as SessionRpState & { antiGodmoding?: boolean }).antiGodmoding),
    },
  };

  try {
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err) {
    ctx.ui.notify(`导出世界存档失败：${(err as Error).message}`, "error");
    return;
  }

  ctx.ui.notify(
    `💾 已导出世界存档（事实 ${payload.state.facts.length} · 伏笔 ${payload.state.foresights.length} · 记忆书 ${payload.state.memoryBooks.length}）：${outPath}`,
    "info",
  );
}

/** Import portable `.rp-save.json` world snapshot into the current active RP session. */
export async function actionImportWorldSave(
  rt: RpRuntimeHandle,
  ctx: PiExtensionContext,
  argsText: string,
): Promise<void> {
  const curState = rt.getState();
  if (!curState.active) {
    ctx.ui.notify("请先加载一张角色卡再导入世界存档。", "warning");
    return;
  }

  const saveDir = path.join(ctx.cwd || curState.worldDir || getGlobalLibraryDir(), "rp-saves");
  let targetPath = "";

  const arg = argsText.trim();
  if (arg) {
    const direct = normalizeUserFilePath(arg, ctx.cwd);
    const inSaveDir = path.join(saveDir, arg.endsWith(".rp-save.json") ? arg : `${arg}.rp-save.json`);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
      targetPath = direct;
    } else if (fs.existsSync(inSaveDir) && fs.statSync(inSaveDir).isFile()) {
      targetPath = inSaveDir;
    } else {
      ctx.ui.notify(`找不到存档文件：${arg}`, "error");
      return;
    }
  } else {
    const candidates: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];
    if (fs.existsSync(saveDir)) {
      for (const entry of fs.readdirSync(saveDir)) {
        if (!entry.endsWith(".rp-save.json")) continue;
        const fullPath = path.join(saveDir, entry);
        try {
          const st = fs.statSync(fullPath);
          if (st.isFile()) candidates.push({ name: entry, fullPath, mtimeMs: st.mtimeMs });
        } catch {
          // ignore unreadable files
        }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const opts = [
      ...candidates.map((c) => `💾 ${c.name}`),
      "✏️ 手动输入存档文件路径",
      "✕ 取消",
    ];
    const pick = await ctx.ui.select(`📂 选择要导入的世界存档（${candidates.length} 个）`, opts);
    if (!pick || pick.startsWith("✕")) return;
    if (pick.startsWith("✏️")) {
      const entered = (await ctx.ui.input("输入 .rp-save.json 文件路径", ""))?.trim();
      if (!entered) return;
      targetPath = normalizeUserFilePath(entered, ctx.cwd);
    } else {
      const chosen = candidates[opts.indexOf(pick)];
      if (!chosen) return;
      targetPath = chosen.fullPath;
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    ctx.ui.notify(`存档文件不存在：${targetPath}`, "error");
    return;
  }

  let parsed: Partial<PortableWorldSaveV1>;
  try {
    parsed = JSON.parse(fs.readFileSync(targetPath, "utf-8")) as Partial<PortableWorldSaveV1>;
  } catch (err) {
    ctx.ui.notify(`解析存档 JSON 失败：${(err as Error).message}`, "error");
    return;
  }

  const snap = parsed.state;
  if (!snap || typeof snap !== "object") {
    ctx.ui.notify("存档格式无效：缺少 state 字段。", "error");
    return;
  }

  const factsArr = Array.isArray(snap.facts) ? snap.facts : [];
  const beliefsArr = Array.isArray(snap.beliefs) ? snap.beliefs : [];
  const foresightsArr = Array.isArray(snap.foresights) ? snap.foresights : [];
  const booksArr = Array.isArray(snap.memoryBooks) ? snap.memoryBooks : [];
  const storyletsArr = Array.isArray(snap.storylets) ? snap.storylets : [];

  const summary = [
    `来源角色：${parsed.cardName || parsed.cardSlug || "未知"}（第 ${parsed.turn ?? 0} 轮）`,
    `导出时间：${(parsed.exportedAt || "未知").slice(0, 16).replace("T", " ")}`,
    `包含数据：事实 ${factsArr.length} · 信念 ${beliefsArr.length} · 伏笔 ${foresightsArr.length} · 记忆书 ${booksArr.length} · 剧情卡 ${storyletsArr.length}`,
  ].join("\n");

  const ok = await ctx.ui.confirm("确认导入世界存档快照？", summary);
  if (!ok) return;

  // Apply spatio-temporal & pacing configuration
  if (typeof snap.era === "string" && snap.era !== curState.era) {
    rt.commitTx({
      kind: "era_advance",
      fromEra: curState.era,
      toEra: snap.era,
      milestoneUnlocked: [],
      montageSummary: "import_save",
      turn: curState.turn,
    });
  }
  const dayDelta = typeof snap.day === "number" && Number.isFinite(snap.day) ? snap.day - curState.day : 0;
  if (dayDelta !== 0 || (typeof snap.worldTimeLabel === "string" && snap.worldTimeLabel !== curState.worldTimeLabel)) {
    rt.commitTx({
      kind: "clock_tick",
      beatDelta: 0,
      dayDelta: dayDelta !== 0 ? dayDelta : undefined,
      worldTimeLabel: typeof snap.worldTimeLabel === "string" ? snap.worldTimeLabel : curState.worldTimeLabel,
    });
  }
  if (typeof snap.location === "string" || Array.isArray(snap.presentNpcs)) {
    rt.commitTx({
      kind: "location_set",
      location: typeof snap.location === "string" ? snap.location : curState.location,
      presentNpcs: Array.isArray(snap.presentNpcs) ? snap.presentNpcs.filter((x): x is string => typeof x === "string") : curState.presentNpcs,
    });
  }
  if (typeof snap.sceneObjective === "string") {
    rt.commitTx({ kind: "scene_objective_set", objective: snap.sceneObjective });
  }
  if (snap.pacingMode === "relaxed" || snap.pacingMode === "balanced" || snap.pacingMode === "dramatic") {
    rt.commitTx({ kind: "config_patch", pacingMode: snap.pacingMode });
  }
  if (typeof snap.antiGodmoding === "boolean") {
    rt.commitTx({ kind: "anti_godmoding_set", enabled: snap.antiGodmoding } as unknown as RpTxEntry);
  }

  // Flags
  if (snap.flags && typeof snap.flags === "object") {
    for (const [flag, value] of Object.entries(snap.flags)) {
      rt.commitTx({ kind: "flag_set", flag, value: Boolean(value) });
    }
  }

  // Stats & bounds
  const boundsMap = snap.statBounds && typeof snap.statBounds === "object" ? snap.statBounds : {};
  if (snap.stats && typeof snap.stats === "object") {
    for (const [actorId, actorStats] of Object.entries(snap.stats)) {
      if (!actorStats || typeof actorStats !== "object") continue;
      for (const [key, value] of Object.entries(actorStats)) {
        const b = boundsMap[actorId]?.[key];
        rt.commitTx({
          kind: "stat_patch",
          actorId,
          key,
          op: "set",
          value,
          min: b?.min,
          max: b?.max,
          reason: "import_save",
        });
      }
    }
  }

  // Inventory (exact target quantity via delta)
  if (snap.inventory && typeof snap.inventory === "object") {
    for (const [actorId, bag] of Object.entries(snap.inventory)) {
      if (!bag || typeof bag !== "object") continue;
      for (const [item, qty] of Object.entries(bag)) {
        if (typeof qty !== "number" || !Number.isFinite(qty)) continue;
        const curQty = rt.getState().inventory[actorId]?.[item] ?? 0;
        const delta = qty - curQty;
        if (delta !== 0) {
          rt.commitTx({ kind: "inventory_patch", actorId, item, delta, note: "import_save" });
        }
      }
    }
  }

  // Clocks
  if (snap.clocks && typeof snap.clocks === "object") {
    for (const clk of Object.values(snap.clocks)) {
      if (!clk || !clk.clockId) continue;
      const curVal = rt.getState().clocks[clk.clockId]?.value ?? 0;
      rt.commitTx({
        kind: "progress_clock",
        clockId: clk.clockId,
        label: clk.label || clk.clockId,
        delta: (clk.value ?? 0) - curVal,
        max: Math.max(1, clk.max ?? 4),
        completed: Boolean(clk.completed),
      });
    }
  }

  // CFSM definitions & states
  if (snap.cfsmDefs && typeof snap.cfsmDefs === "object") {
    for (const [actorId, axes] of Object.entries(snap.cfsmDefs)) {
      if (!axes || typeof axes !== "object") continue;
      for (const def of Object.values(axes)) {
        if (def?.axis && Array.isArray(def.states)) {
          rt.commitTx({ kind: "cfsm_define", actorId, def });
        }
      }
    }
  }
  if (snap.cfsmStates && typeof snap.cfsmStates === "object") {
    for (const [actorId, axes] of Object.entries(snap.cfsmStates)) {
      if (!axes || typeof axes !== "object") continue;
      for (const [axis, rec] of Object.entries(axes)) {
        if (!rec?.state) continue;
        const curAxisState = rt.getState().cfsmStates[actorId]?.[axis]?.state ?? "";
        if (curAxisState !== rec.state) {
          rt.commitTx({
            kind: "cfsm_transition",
            actorId,
            axis,
            from: curAxisState || rec.state,
            to: rec.state,
            reason: rec.reason || "import_save",
            turn: rec.updatedTurn ?? curState.turn,
          });
        }
      }
    }
  }

  // Facts
  for (const fact of factsArr) {
    if (!fact?.id || !fact.statement) continue;
    const exists = rt.getState().facts.has(fact.id);
    if (!exists) {
      rt.commitTx({ kind: "fact_add", fact });
    } else {
      rt.commitTx({
        kind: "fact_update",
        factId: fact.id,
        statement: fact.statement,
        witnessIds: fact.witnessIds,
        entities: fact.entities,
      });
    }
    if (fact.validUntilTurn !== null && fact.validUntilTurn !== undefined) {
      rt.commitTx({
        kind: "fact_invalidate",
        factId: fact.id,
        validUntilTurn: fact.validUntilTurn,
        supersededBy: fact.supersededBy,
        reason: "import_save",
      });
    }
  }

  // Beliefs
  for (const b of beliefsArr) {
    if (!b?.actorId || !b.belief) continue;
    const already = b.id && rt.getState().beliefs.some((x) => x.id === b.id);
    if (!already) {
      rt.commitTx({
        kind: "belief_update",
        id: b.id,
        actorId: b.actorId,
        target: b.target || curState.currentPersona.name,
        activatingEvent: b.activatingEvent || "存档导入",
        belief: b.belief,
        subjectiveInsight: b.subjectiveInsight,
        emotionalTone: b.emotionalTone,
        turn: b.turn ?? curState.turn,
      });
    }
  }

  // Foresights, Memory Books, Storylets
  for (const hook of foresightsArr) {
    if (hook?.id && hook.summary) rt.commitTx({ kind: "foresight_upsert", hook });
  }
  for (const entry of booksArr) {
    if (entry?.id && entry.title) rt.commitTx({ kind: "memory_book_upsert", entry });
  }
  for (const storylet of storyletsArr) {
    if (storylet?.id && storylet.title) rt.commitTx({ kind: "storylet_upsert", storylet });
  }

  // Physical state & spatial notes
  if (snap.physicalState && typeof snap.physicalState === "object") {
    for (const ps of Object.values(snap.physicalState)) {
      if (ps?.actorId) {
        rt.commitTx({ kind: "physical_patch", snapshot: ps, reason: "import_save" });
      }
    }
  }
  if (typeof snap.spatialNotes === "string" && snap.spatialNotes !== rt.getState().spatialNotes) {
    rt.commitTx({
      kind: "physical_patch",
      snapshot: { actorId: "", updatedTurn: curState.turn },
      spatialNotes: snap.spatialNotes,
      reason: "import_save",
    });
  }

  // Agendas, Pair Bonds, Voice Anchors
  if (snap.agendas && typeof snap.agendas === "object") {
    for (const agenda of Object.values(snap.agendas)) {
      if (agenda?.actorId && agenda.goal) rt.commitTx({ kind: "agenda_upsert", agenda });
    }
  }
  if (snap.pairBonds && typeof snap.pairBonds === "object") {
    for (const bond of Object.values(snap.pairBonds)) {
      if (bond?.id && bond.actorA && bond.actorB) rt.commitTx({ kind: "pair_bond_upsert", bond });
    }
  }
  if (snap.voiceAnchors && typeof snap.voiceAnchors === "object") {
    for (const anchor of Object.values(snap.voiceAnchors)) {
      if (anchor?.actorId && anchor.backbone) rt.commitTx({ kind: "voice_anchor_upsert", anchor });
    }
  }

  rt.refreshHud(ctx);
  ctx.ui.notify(`📂 已导入世界存档：${path.basename(targetPath)}`, "info");
}
