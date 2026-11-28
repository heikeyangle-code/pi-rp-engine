/**
 * pi-rp-engine v3 — Official Pi Coding Agent (1.6.1+) Zero-Dependency Roleplay Extension.
 *
 * Strict Lifecycle & Architectural Guarantees:
 *  1. 100% Session-Only Binding: RP mode lives EXCLUSIVELY in a session that has explicitly
 *     executed `/rp load` or `/rp import -> 立即开启`. Never auto-activates other sessions.
 *  2. Total Clean Exit: `/rp exit` / `/rp off` / `Alt+Shift+X` emits `unbind`, wipes every
 *     runtime buffer, restores original coding tools, clears HUD/widgets, and only resets
 *     terminal title if RP actually set it.
 *  3. KV-Cache Three-Zone Assembly + Live Context X-Ray:
 *     - Zone 1 (`before_agent_start`): byte-identical frozen prefix tracked via SHA-256 hash & streak.
 *     - Zone 2 (`messages`): strictly append-only history (non-destructive fingerprint hiding).
 *     - Zone 3 (`context`): transient tail frame with Graph-PPR Lore + Memory Books + DualMem
 *       Beliefs + FANToM Epistemic Boundaries + Condition-Gated Storylets + Inner Monologue cue.
 *  4. Official Pi SDK 1.6.1+ Full Parity:
 *     - Hooks `session_start`, `session_switch`, `session_tree` idempotently for exact branch replay.
 *     - Hooks `before_provider_request` for optional SillyTavern preset sampling parameters.
 *     - Async `session_before_compact` with real LLM Semantic MemScene compaction & deterministic fallback.
 *     - Streaming-safe `registerMarkdownTransformer` (skips `isStreaming` & `assistant-thinking`, styles `<thought>`).
 *     - Native 7-tab TUI Overlay (`ctx.ui.custom(..., { overlay: true })`) + mobile RPC fallback.
 */

import type {
  CompiledCard,
  CompiledLoreEntry,
  CompiledPreset,
  ContextXRaySnapshot,
  MemoryBookEntry,
  PiCompactionPreparation,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  RpTxEntry,
  SessionRpState,
} from "./types.js";
import { createHash } from "node:crypto";
import { RP_ENTRY_TYPE, applyRpTx, computeMessageFingerprint, createInitialRpState, replayBranchState } from "./engine/state-replay.js";
import { loadCompiledCard, loadCompiledPreset, resolveCardBySlug } from "./storage/workspace-store.js";
import { recallLoreWithGraphPpr, recallMemoryBooks } from "./memory/graph-ppr.js";
import { buildEntityRegistry } from "./memory/entity-registry.js";
import { recallCardKnowledge } from "./parser/card-knowledge.js";
import { loadUiPrefs } from "./ui/file-picker.js";
import { type HistoryRecallCooldown, createTurnRecallScope } from "./memory/history-recall.js";
import { buildSemanticMemSceneCompaction, maybeBuildAutoSceneChapter } from "./memory/compaction.js";
import { extractInlineDelta, parseAndValidateInlineDelta, stripInlineDelta, stripInlineDeltaStreaming } from "./engine/inline-delta.js";
import { propagateSecretsOnScene } from "./engine/world-sim.js";
import { getActiveFacts } from "./memory/bitemporal.js";
import { evaluateNarrativeHealth } from "./engine/stagnation.js";
import { estimateTokens } from "./context/token-budget.js";
import {
  attachZone3ToMessages,
  buildZone1FrozenPrefix,
  buildZone3TransientTail,
  buildZone3TransientTailWithStats,
  computeMessagesTokens,
  computeZone1Hash,
  extractRecentMessagesText,
} from "./context/zone-builder.js";
import {
  isIntermediateToolCallMessage,
  runDeterministicTurnSettlement,
  runSidecarLightSettlement,
} from "./engine/settlement.js";
import { applyDisplayRegexRules, applyPromptRegexRules, stripDisplayResiduals } from "./parser/sanitizer.js";
import { prewarmEmbeddingCache } from "./memory/embedding.js";
import { RP_TOOL_NAMES, registerRpTools } from "./tools/rp-tools.js";
import { clearRpHud, renderRpHud } from "./ui/hud.js";
import { formatThoughtBlocks, registerRpMessageRenderers } from "./ui/renderers.js";
import {
  type RpRuntimeHandle,
  actionBookmarkGoto,
  actionBookmarkSave,
  actionContinue,
  actionCyclePacing,
  actionDirectorNote,
  actionExitRp,
  actionIdeas,
  actionImpersonate,
  actionQuickReplies,
  actionReroll,
  actionRewriteLast,
  actionStyleControl,
  actionSetHud,
  actionSidePrompt,
  actionSkipMontage,
  actionXRay,
  bindCardToCurrentSession,
} from "./ui/actions.js";
import { makeDashboardRuntime, openRpMenu, registerRpCommands } from "./ui/commands.js";
import { openRpDashboard } from "./ui/dashboard.js";
import { registerRpShortcuts } from "./ui/shortcuts.js";

function extractMessageText(msg: PiMessage | undefined): string {
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


/** Detect DeepSeek V4 DSML / malformed XML tool-call leak that ends with stopReason="stop" and no real story prose. */
export function isMalformedToolLeakText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 1500) return false;
  // Strip any leaked DSML / XML tool tags & quotes; if nothing meaningful remains, it's a pure leak!
  const stripped = trimmed
    .replace(/<[|｜]?\s*DSML\s*[|｜]?[^>]*>?/gi, "")
    .replace(/<\/?(?:function_calls|invoke|parameter|tool_call|rp_[a-z_]+)\b[^>]*>?/gi, "")
    .replace(/["'`\s<>|｜\/]+/g, "")
    .trim();
  return stripped.length === 0;
}

/** Detect reasoning-only or completely empty assistant stops (ported from dsh-tavern body-generation-failure.js). */
export function isReasoningOnlyOrEmptyStop(msg: PiMessage | undefined): boolean {
  if (!msg || msg.role !== "assistant") return false;
  if (
    msg.stopReason === "toolUse" ||
    msg.stopReason === "tool_calls" ||
    msg.stopReason === "aborted" ||
    msg.stopReason === "error"
  ) {
    return false;
  }
  if (Array.isArray(msg.content)) {
    const hasToolCall = msg.content.some((b) => b && typeof b === "object" && (b.type === "toolCall" || b.type === "tool_use"));
    if (hasToolCall) return false;
  }
  return extractMessageText(msg).trim().length === 0;
}

export const SIDECAR_READ_TOOLS = ["rp_roll_check", "rp_recall", "rp_history_recall"] as const;
export const TOOL_ASSISTED_CORE_TOOLS = [
  "rp_roll_check",
  "rp_recall",
  "rp_history_recall",
] as const;

/**
 * Unified Strongest-Default Tool Exposure (Zero Ghost Tools):
 * - "off": 0 tools (pure chat)
 * - "sidecar-light": always keeps lean read + dice tools (rp_roll_check, rp_recall, rp_history_recall)
 *   so dice checks NEVER silently disappear on any card!
 * - "tool-assisted" (DEFAULT — strongest all-in-one mode): 5 core tools + contextual
 *   `rp_era_advance` (when stages/era active) & `rp_npc_deliberate` (when multi-NPC/living-world active).
 */
export function getDesiredRpTools(state: SessionRpState, card: CompiledCard | null): string[] {
  if (state.settlementMode === "off") {
    return [];
  }
  if (state.settlementMode === "sidecar-light") {
    return [...SIDECAR_READ_TOOLS];
  }
  const tools: string[] = [...TOOL_ASSISTED_CORE_TOOLS];
  const modules = state.modules ?? card?.worldProfile?.modules;
  const archetype = state.archetype || card?.worldProfile?.archetype || "companion";
  if (modules?.stages || Boolean(state.era?.trim())) {
    tools.push("rp_era_advance");
  }
  if (
    state.presentNpcs.length >= 2 ||
    Object.keys(state.npcAgendas).length > 0 ||
    archetype === "ensemble" ||
    archetype === "mystery" ||
    archetype === "epic-saga"
  ) {
    tools.push("rp_npc_deliberate");
  }
  return tools;
}

export default function rpEngineExtension(pi: PiExtensionAPI): void {
  let state: SessionRpState = createInitialRpState();
  let activeCard: CompiledCard | null = null;
  let extraCastCards: CompiledCard[] = [];
  let activePreset: CompiledPreset | null = null;
  let savedCodingTools: string[] | null = null;
  let rpTitleSet = false;
  let isOocTurn = false;
  let lastTurnWasOoc = false;
  let lastUserText = "";
  let lastAssistantText = "";
  let lastSidecarSettledTurn = -1;
  let consecutiveLeakRecoveries = 0;
  let runtimeEpoch = 0;
  const sessionUnlockedTools = new Set<string>();
  let turnHistoryRecallScope = createTurnRecallScope();
  let historyRecallCooldowns: HistoryRecallCooldown[] = [];
  let lastToolsHash = "";
  let lastZone1Hash = "";
  let lastZone1Tokens = 0;
  let lastZone2PrefixHashes: string[] = [];
  let pendingCacheInvalidation: ContextXRaySnapshot["cacheInvalidationReason"] = "first_turn";
  let cacheHitStreak = 0;
  let lastXRay: ContextXRaySnapshot | null = null;
  let pendingLoreRuntime: {
    activatedIds: string[];
    sticky: Record<string, number>;
    cooldown: Record<string, number>;
    consumedOneShots: string[];
  } | null = null;
  let pendingCompactionBookEntry: MemoryBookEntry | null = null;
  let pendingInlineDeltaBlock: string | null = null;

  const rpToolSet = new Set<string>(RP_TOOL_NAMES);

  function computeFullMessageHash(m: PiMessage): string {
    const contentStr = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return createHash("sha256").update(`${m.role}|${contentStr}`, "utf8").digest("hex").slice(0, 16);
  }

  function getAllActiveLoreEntries(): CompiledLoreEntry[] {
    if (!activeCard) return [];
    const list: CompiledLoreEntry[] = [...activeCard.loreBook.entries];
    for (const extra of extraCastCards) {
      list.push(...extra.loreBook.entries);
    }
    return list;
  }

  function resetTransientTurnBuffers(): void {
    isOocTurn = false;
    pendingInlineDeltaBlock = null;
    lastTurnWasOoc = false;
    lastUserText = "";
    lastAssistantText = "";
    lastSidecarSettledTurn = -1;
    consecutiveLeakRecoveries = 0;
    turnHistoryRecallScope = createTurnRecallScope();
    historyRecallCooldowns = [];
    lastToolsHash = "";
    lastZone1Hash = "";
    lastZone1Tokens = 0;
    lastZone2PrefixHashes = [];
    pendingCacheInvalidation = "first_turn";
    cacheHitStreak = 0;
    lastXRay = null;
    pendingLoreRuntime = null;
    pendingCompactionBookEntry = null;
  }

  function commitTx(tx: RpTxEntry): void {
    pi.appendEntry(RP_ENTRY_TYPE, tx);
    applyRpTx(state, tx);
  }

  function activateRpTools(): void {
    const current = pi.getActiveTools();
    const desired = getDesiredRpTools(state, activeCard);
    if (state.settlementMode === "tool-assisted") {
      for (const t of desired) {
        if (t === "rp_era_advance" || t === "rp_npc_deliberate") {
          sessionUnlockedTools.add(t);
        }
      }
      for (const t of sessionUnlockedTools) {
        if (!desired.includes(t)) desired.push(t);
      }
    } else {
      sessionUnlockedTools.clear();
    }
    const hasNonRpTools = current.some((t) => !rpToolSet.has(t));
    if (savedCodingTools === null && hasNonRpTools) {
      savedCodingTools = current.filter((t) => !rpToolSet.has(t));
    }
    const currentSorted = [...current].sort().join(",");
    const desiredSorted = [...desired].sort().join(",");
    if (currentSorted !== desiredSorted) {
      pi.setActiveTools(desired);
    }
  }

  function restoreCodingTools(): void {
    if (savedCodingTools !== null) {
      pi.setActiveTools([...savedCodingTools]);
      savedCodingTools = null;
    } else {
      const current = pi.getActiveTools();
      const filtered = current.filter((t) => !rpToolSet.has(t));
      if (filtered.length > 0) {
        if (filtered.length !== current.length) {
          pi.setActiveTools(filtered);
        }
      } else if (current.length > 0) {
        const fallback = pi.getAllTools?.().map((t) => t.name).filter((n) => !rpToolSet.has(n));
        if (fallback && fallback.length > 0) {
          pi.setActiveTools(fallback);
        } else if (filtered.length !== current.length) {
          pi.setActiveTools(filtered);
        }
      }
    }
  }

  function teardownSessionRuntime(ctx: PiExtensionContext): void {
    runtimeEpoch += 1;
    sessionUnlockedTools.clear();
    state = createInitialRpState();
    activeCard = null;
    extraCastCards = [];
    activePreset = null;
    resetTransientTurnBuffers();
    restoreCodingTools();
    clearRpHud(ctx);
    ctx.ui.setWorkingMessage?.(undefined);
    if (rpTitleSet) {
      ctx.ui.setTitle?.("Pi");
      rpTitleSet = false;
    }
  }

  function refreshHud(ctx?: PiExtensionContext): void {
    if (!ctx) return;
    if (state.active) {
      renderRpHud(ctx, state, activeCard, lastXRay);
    } else {
      clearRpHud(ctx);
    }
  }

  /**
   * Reconstruct RP state strictly from THIS session's branch (`ctx.sessionManager.getBranch()`).
   * NEVER reads project-level auto-bind config: dormant sessions remain 100% pure coding sessions.
   */
  function reloadRuntime(ctx: PiExtensionContext): void {
    runtimeEpoch += 1;
    sessionUnlockedTools.clear();
    const branch = ctx.sessionManager.getBranch();
    state = replayBranchState(branch);
    resetTransientTurnBuffers();

    if (!state.active || !state.cardSlug) {
      activeCard = null;
      extraCastCards = [];
      activePreset = null;
      restoreCodingTools();
      clearRpHud(ctx);
      if (rpTitleSet) {
        ctx.ui.setTitle?.("Pi");
        rpTitleSet = false;
      }
      return;
    }

    // Load primary card from recorded worldDir or fallback lookup
    let card: CompiledCard | null = null;
    if (state.worldDir) {
      card = loadCompiledCard(state.worldDir, state.cardSlug);
    }
    if (!card) {
      const resolved = resolveCardBySlug(ctx.cwd, state.cardSlug, state.cardSource ?? undefined);
      if (resolved) {
        card = resolved.card;
        state.worldDir = resolved.baseDir;
        state.cardSource = resolved.source;
      }
    }
    activeCard = card;

    if (!activeCard) {
      const missingSlug = state.cardSlug;
      activeCard = null;
      extraCastCards = [];
      activePreset = null;
      state.active = false;
      restoreCodingTools();
      clearRpHud(ctx);
      ctx?.ui?.notify?.(`无法加载角色卡「${missingSlug}」，已自动退回普通编程会话。`, "warning");
      return;
    }

    // Load extra co-cast cards
    extraCastCards = [];
    for (const slug of state.activeCharacters) {
      if (slug === state.cardSlug) continue;
      const co = resolveCardBySlug(ctx.cwd, slug);
      if (co) extraCastCards.push(co.card);
    }

    // Load preset if bound
    activePreset = state.presetId ? loadCompiledPreset(ctx.cwd, state.presetId) : null;

    activateRpTools();
    const prewarmCfg = loadUiPrefs().embeddingConfig;
    if (prewarmCfg?.enabled && activeCard.loreBook.entries.length > 0) {
      prewarmEmbeddingCache(prewarmCfg, activeCard.loreBook.entries.slice(0, 128).map((e) => `${e.title}: ${e.content.slice(0, 1200)}`));
    }
    ctx.ui.setTitle?.(`◆ ${activeCard.identity.name} · Pi RP`);
    rpTitleSet = true;
    renderRpHud(ctx, state, activeCard, lastXRay);
  }

  async function retrySidecarSettlement(ctx: PiExtensionContext): Promise<number> {
    if (!state.active || !activeCard || state.settlementMode !== "sidecar-light") return 0;
    let userText = lastUserText;
    let assistantText = lastAssistantText;
    if (!assistantText.trim()) {
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i]!;
        if (e.type === "message" && e.message) {
          if (!assistantText && e.message.role === "assistant") {
            assistantText = extractMessageText(e.message);
          } else if (assistantText && !userText && e.message.role === "user") {
            userText = extractMessageText(e.message);
            break;
          }
        }
      }
    }
    if (!assistantText.trim()) return 0;
    try {
      const committed = await runSidecarLightSettlement({
        pi,
        ctx,
        state,
        lastUserText: userText,
        lastAssistantText: assistantText,
      });
      lastSidecarSettledTurn = state.turn;
      const sidecarStatus = (state as SessionRpState & { lastSidecarStatus?: unknown }).lastSidecarStatus;
      if (lastXRay && sidecarStatus !== undefined) {
        (lastXRay as ContextXRaySnapshot & { lastSidecarStatus?: unknown }).lastSidecarStatus = sidecarStatus;
      }
      renderRpHud(ctx, state, activeCard, lastXRay);
      return committed;
    } catch {
      return 0;
    }
  }

  const runtime: RpRuntimeHandle & { retrySidecarSettlement?: (ctx: PiExtensionContext) => Promise<number> } = {
    pi,
    getState: () => state,
    getCard: () => activeCard,
    getExtraCastCards: () => extraCastCards,
    getPreset: () => activePreset,
    getLastXRay: () => lastXRay,
    commitTx,
    reloadRuntime,
    refreshHud,
    activateRpTools,
    restoreCodingTools,
    markNextTurnOoc: () => {
      isOocTurn = true;
    },
    teardownSessionRuntime,
    retrySidecarSettlement,
  };

  // Register tools (defaultActive: false -> 0 tokens in coding sessions)
  registerRpTools(pi, {
    getState: () => state,
    getCard: () => activeCard,
    getExtraCastCards: () => extraCastCards,
    commitTx,
    refreshHud,
    getHistoryRecallScope: () => turnHistoryRecallScope,
    getHistoryRecallCooldowns: () => historyRecallCooldowns,
    setHistoryRecallCooldowns: (next) => {
      historyRecallCooldowns = next;
    },
  });

  // Register custom editorial TUI message renderers
  registerRpMessageRenderers(pi);

  // Register `/rp` command palette & subcommands
  registerRpCommands(pi, runtime);

  // Register optional CLI flag `pi --rp-card <slug>` for direct single-session launch
  pi.registerFlag?.("rp-card", {
    type: "string",
    description: "Bind a compiled character card slug immediately in this session",
  });

  // Register 18 ergonomic, terminal-safe shortcuts
  registerRpShortcuts(pi, {
    isActive: () => state.active,
    openMenu: (ctx) => openRpMenu(runtime, ctx),
    openDashboard: (ctx) => openRpDashboard(makeDashboardRuntime(runtime), ctx),
    quickReplies: (ctx) => actionQuickReplies(runtime, ctx, ""),
    openXRay: (ctx) => actionXRay(runtime, ctx),
    impersonate: (ctx) => actionImpersonate(runtime, ctx, ""),
    sidePrompt: (ctx) => actionSidePrompt(runtime, ctx, ""),
    rerollLast: (ctx) => actionReroll(runtime, ctx, ""),
    rewriteLast: (ctx) => actionRewriteLast(runtime, ctx, ""),
    continueStory: (ctx) => actionContinue(runtime, ctx),
    actionIdeas: (ctx) => actionIdeas(runtime, ctx),
    directorNote: (ctx) => actionDirectorNote(runtime, ctx, ""),
    cyclePacing: (ctx) => actionCyclePacing(runtime, ctx),
    styleControl: (ctx) => actionStyleControl(runtime, ctx, ""),
    skipTime: (ctx) => actionSkipMontage(runtime, ctx, ""),
    saveBookmark: (ctx) => actionBookmarkSave(runtime, ctx, ""),
    gotoBookmark: (ctx) => actionBookmarkGoto(runtime, ctx, ""),
    cycleHud: (ctx) => actionSetHud(runtime, ctx, ""),
    exitRp: (ctx) => actionExitRp(runtime, ctx, true),
  });

  // Display-only Markdown cleanup + <thought> inner monologue styling + SillyTavern AI_OUTPUT regex rules
  // Strictly skips streaming chunks & assistant-thinking blocks to avoid flicker or partial-tag corruption!
  if (typeof pi.registerMarkdownTransformer === "function") {
    pi.registerMarkdownTransformer(
      (markdown: string, mdCtx?: { messageType?: string; isStreaming?: boolean }) => {
        if (!state.active || !activeCard) return markdown;
        if (mdCtx?.messageType === "assistant-thinking") return markdown;
        const deltaHidden = stripInlineDeltaStreaming(markdown);
        if (mdCtx?.isStreaming) return deltaHidden;
        let out = deltaHidden;
        if (!state.rawPassthrough) {
          out = stripDisplayResiduals(out);
        }
        out = formatThoughtBlocks(out);
        if (activeCard.displayRegexRules.length > 0) {
          out = applyDisplayRegexRules(out, activeCard.displayRegexRules, {
            charName: activeCard.identity.nickname || activeCard.identity.name,
            userName: state.currentPersona.name,
          });
        }
        return out;
      },
      { messageTypes: ["assistant", "custom"] },
    );
  }

  // -------------------------------------------------------------------------
  // Official Pi SDK Lifecycle Event Hooks
  // -------------------------------------------------------------------------

  pi.on("session_start", async (event, ctx) => {
    reloadRuntime(ctx);
    // Optional explicit CLI flag `--rp-card <slug>` on fresh startup only (never auto-binds otherwise)
    if (!state.active && event?.reason === "startup" && typeof pi.getFlag === "function") {
      const flagSlug = pi.getFlag("rp-card");
      if (typeof flagSlug === "string" && flagSlug.trim()) {
        const resolved = resolveCardBySlug(ctx.cwd, flagSlug.trim());
        if (resolved) {
          await bindCardToCurrentSession(runtime, ctx, {
            card: resolved.card,
            source: resolved.source,
            baseDir: resolved.baseDir,
          });
          rpTitleSet = true;
        }
      }
    }
  });

  // Compatibility hook for Pi builds that emit `session_switch` separately from `session_start`
  pi.on("session_switch", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx?.ui?.setWorkingMessage?.(undefined);
    if (rpTitleSet) {
      ctx?.ui?.setTitle?.("Pi");
      rpTitleSet = false;
    }
  });

  // Zero-friction inline OOC shorthand: `((...))` or `（（...））` automatically marks OOC turn without advancing story/clock
  pi.on("input", (event) => {
    if (!state.active || !activeCard) return { action: "continue" };
    const raw = typeof event?.text === "string" ? event.text.trim() : "";
    const oocMatch = /^(?:\(\(([\s\S]+?)\)\)|（（([\s\S]+?)））)$/.exec(raw);
    if (oocMatch) {
      const inner = (oocMatch[1] ?? oocMatch[2] ?? "").trim();
      if (inner) {
        const sb = (event as { streamingBehavior?: string } | undefined)?.streamingBehavior;
        if (sb !== "followUp" && sb !== "steer") {
          isOocTurn = true;
        }
        return {
          action: "transform",
          text: `[OOC - Meta/Director Discussion; do NOT advance story prose. Answer accurately using full context/tools; ONLY call rp_state_patch/rp_fact_commit if the user explicitly asks to fix or update state/memory.]\n${inner}`,
        };
      }
    }
    return { action: "continue" };
  });

  // Zone 1 Frozen Prefix (KV-Cache 100% byte-identical across turns, fingerprinted via SHA-256)
  pi.on("before_agent_start", (event) => {
    if (!state.active || !activeCard) return;
    turnHistoryRecallScope = createTurnRecallScope();

    if (typeof event?.prompt === "string") {
      lastUserText = event.prompt;
      const trimmedPrompt = event.prompt.trim();
      if (/^(?:\(\([\s\S]+?\)\)|（（[\s\S]+?））|\[OOC\b)/i.test(trimmedPrompt)) {
        isOocTurn = true;
      }
    }

    activateRpTools();
    const initialPersona = state.initialPersona ?? state.currentPersona;
    const activeToolNames = pi.getActiveTools();
    const zone1Options = {
      card: activeCard,
      extraCastCards,
      preset: activePreset,
      initialPersona,
      activeToolNames,
      loreOverrides: state.loreOverrides,
      inlineDeltaEnabled: state.settlementMode === "tool-assisted",
      archetype: state.archetype || activeCard.worldProfile?.archetype || "companion",
    };
    const zone1 = buildZone1FrozenPrefix(zone1Options);

    const hash = computeZone1Hash(zone1);
    const activeToolsSorted = [...pi.getActiveTools()].sort().join(",");
    const toolsHash = createHash("sha256").update(activeToolsSorted, "utf8").digest("hex").slice(0, 12);
    lastZone1Tokens = estimateTokens(zone1);

    if (!lastZone1Hash) {
      pendingCacheInvalidation = "first_turn";
    } else if (toolsHash !== lastToolsHash) {
      pendingCacheInvalidation = "tools_changed";
    } else if (hash !== lastZone1Hash) {
      pendingCacheInvalidation = "zone1_changed";
    } else {
      pendingCacheInvalidation = "prefix_hit";
    }
    lastToolsHash = toolsHash;
    lastZone1Hash = hash;

    return { systemPrompt: zone1 };
  });

  // Zone 3 Transient Tail Injection + Non-destructive floor hiding + True 3-Layer KV-Cache X-Ray
  pi.on("context", (event) => {
    if (!state.active || !activeCard) return;
    const messages: PiMessage[] = Array.isArray(event?.messages) ? event.messages : [];
    if (messages.length === 0) return;

    const scanDepth = activeCard.loreBook.scanDepth || 4;
    const recentText = extractRecentMessagesText(messages, scanDepth);
    const allLoreEntries = getAllActiveLoreEntries();
    const registry = buildEntityRegistry({ card: activeCard, extraCastCards, state });
    const embeddingConfig = loadUiPrefs().embeddingConfig;
    const cardDefaultBudget = activeCard.loreBook.tokenBudget || 4000;
    const totalLoreBudget = state.loreBudgetUserSet
      ? state.loreTokenBudget
      : Math.max(state.loreTokenBudget, cardDefaultBudget);
    const hasMemoryBooks = state.memoryBooks.size > 0;
    const memoryBookBudget = hasMemoryBooks ? Math.min(1200, Math.floor(totalLoreBudget * 0.25)) : 0;
    const isDualTrackCard = Boolean(activeCard.knowledgeIndex?.dualTrackActive && !activeCard.forceFullZone1);
    const cardKbBudget = isDualTrackCard ? Math.min(2800, Math.floor(totalLoreBudget * 0.45)) : 0;
    const loreBudget = Math.max(400, totalLoreBudget - memoryBookBudget);

    const recall = recallLoreWithGraphPpr({
      entries: allLoreEntries,
      state,
      recentText,
      messages,
      defaultScanDepth: scanDepth,
      tokenBudget: loreBudget,
      registry,
      embeddingConfig,
    });

    const cardKbRecall = isDualTrackCard
      ? recallCardKnowledge({
          knowledgeIndex: activeCard.knowledgeIndex,
          queryText: recentText,
          registry,
          tokenBudget: cardKbBudget,
          maxPassages: 6,
        })
      : { passages: [], traces: [], usedTokens: 0 };

    const memBookRecall = hasMemoryBooks
      ? recallMemoryBooks(state, recentText, 6, memoryBookBudget, registry)
      : { chapters: [], traces: [] };
    const memBookTokens = memBookRecall.traces.reduce((acc, t) => acc + t.tokens, 0);

    pendingLoreRuntime = {
      activatedIds: recall.activatedIds,
      sticky: recall.nextSticky,
      cooldown: recall.nextCooldown,
      consumedOneShots: recall.nextConsumedOneShots,
    };

    // Extract last user & char messages for SillyTavern {{lastUserMessage}} / {{lastCharMessage}}
    // Recognizes both assistant replies AND `rp:greeting` custom opening messages!
    let lastUserMsg = "";
    let lastCharMsg = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (!lastUserMsg && m.role === "user") lastUserMsg = extractMessageText(m);
      if (!lastCharMsg && (m.role === "assistant" || m.customType === "rp:greeting")) {
        lastCharMsg = extractMessageText(m);
      }
      if (lastUserMsg && lastCharMsg) break;
    }

    // Genuine lexical repetition & world-state stagnation analysis (zero extra LLM cost!)
    const visibleMessagesForHealth = messages.filter((m) => {
      const id = typeof m.id === "string" ? m.id : "";
      if (id && state.hiddenEntryIds.has(id)) return false;
      const fp = computeMessageFingerprint(m);
      if (state.hiddenFingerprints.has(fp)) return false;
      return true;
    });
    const properNouns = [
      activeCard.identity.name,
      ...(activeCard.identity.aliases ?? []),
      ...extraCastCards.map((c) => c.identity.name),
    ];
    const narrativeHealth = evaluateNarrativeHealth(state, visibleMessagesForHealth, properNouns);

    const { text: zone3, stats: zone3Stats } = buildZone3TransientTailWithStats({
      card: activeCard,
      extraCastCards,
      state,
      preset: activePreset,
      recalledLore: recall.selected,
      recalledCardPassages: cardKbRecall.passages,
      recalledMemoryBooks: memBookRecall.chapters,
      budgetDroppedLore: recall.budgetDropped,
      recentText,
      lastUserMessage: lastUserMsg,
      lastCharMessage: lastCharMsg,
      narrativeHealth,
      registry,
    });

    const userPromptRules = activeCard.promptRegexRules ?? [];
    const promptMacroCtx = {
      charName: activeCard.identity.nickname || activeCard.identity.name,
      userName: state.currentPersona.name,
    };
    const cleanedMessages: PiMessage[] = messages.map((m) => {
      if (m.role === "user" && userPromptRules.length > 0) {
        if (typeof m.content === "string") {
          const transformed = applyPromptRegexRules(m.content, userPromptRules, 1, promptMacroCtx);
          return transformed === m.content ? m : { ...m, content: transformed };
        }
        return m;
      }
      if (m.role !== "assistant") return m;
      if (typeof m.content === "string") {
        const stripped = stripInlineDelta(m.content);
        return stripped === m.content ? m : { ...m, content: stripped };
      }
      if (Array.isArray(m.content)) {
        let changed = false;
        const blocks = m.content.map((b) => {
          if (b && b.type === "text" && typeof b.text === "string") {
            const s = stripInlineDelta(b.text);
            if (s !== b.text) {
              changed = true;
              return { ...b, text: s };
            }
          }
          return b;
        });
        return changed ? { ...m, content: blocks } : m;
      }
      return m;
    });
    const outMessages = attachZone3ToMessages(
      cleanedMessages,
      zone3,
      state.hiddenEntryIds,
      state.hiddenFingerprints,
    );

    // True 3-Layer KV-Cache Prefix Continuity Check (Tools + Zone 1 + Zone 2 prefix messages[0..n-2])
    const currentToolsHash = createHash("sha256")
      .update([...pi.getActiveTools()].sort().join(","), "utf8")
      .digest("hex")
      .slice(0, 12);
    const currentPrefixHashes = outMessages.slice(0, Math.max(0, outMessages.length - 1)).map(computeFullMessageHash);
    let zone2PrefixMatch = true;
    if (lastZone2PrefixHashes.length > 0) {
      if (currentPrefixHashes.length < lastZone2PrefixHashes.length) {
        zone2PrefixMatch = false;
      } else {
        for (let i = 0; i < lastZone2PrefixHashes.length; i++) {
          if (currentPrefixHashes[i] !== lastZone2PrefixHashes[i]) {
            zone2PrefixMatch = false;
            break;
          }
        }
      }
    }

    let invalidationReason: ContextXRaySnapshot["cacheInvalidationReason"] = pendingCacheInvalidation;
    if (invalidationReason === "prefix_hit" && lastToolsHash && currentToolsHash !== lastToolsHash) {
      invalidationReason = "tools_changed";
    } else if (invalidationReason === "prefix_hit" && !zone2PrefixMatch) {
      invalidationReason = "history_mutated";
    }
    if (invalidationReason === "prefix_hit") {
      cacheHitStreak += 1;
    } else {
      cacheHitStreak = 1;
    }
    lastToolsHash = currentToolsHash;
    lastZone2PrefixHashes = currentPrefixHashes;
    // If multiple context calls fire inside the same turn (tool-call loop), next step inherits prefix_hit unless mutated!
    pendingCacheInvalidation = "prefix_hit";

    // Record live Context X-Ray snapshot from exact structured Zone 3 stats (zero fragile regex parsing!)
    const knownFactCount = zone3Stats.knownFactCount;
    const blindSpotCount = zone3Stats.blindSpotCount;
    const activeFactCount = knownFactCount + blindSpotCount;
    const activeStoryletTitles = zone3Stats.activeStoryletTitles;

    const zone3Tokens = estimateTokens(zone3);
    const zone2Tokens = Math.max(0, computeMessagesTokens(outMessages) - zone3Tokens);

    const sidecarStatus = (state as SessionRpState & { lastSidecarStatus?: unknown }).lastSidecarStatus;
    const nextXRay: ContextXRaySnapshot & { lastSidecarStatus?: unknown } = {
      turn: state.turn,
      timestamp: Date.now(),
      toolsHash: currentToolsHash,
      zone1Hash: lastZone1Hash || "pending",
      zone2PrefixMatch,
      cacheInvalidationReason: invalidationReason,
      cacheHitStreak,
      zone1Tokens: lastZone1Tokens,
      zone2Tokens,
      zone3Tokens,
      loreTokens: recall.usedTokens + cardKbRecall.usedTokens + memBookTokens + zone3Stats.zone3ConstLoreTokens,
      loreBudget: totalLoreBudget,
      recalled: [...recall.traces, ...cardKbRecall.traces, ...memBookRecall.traces],
      aliasExpansions: recall.aliasExpansions,
      zone3ConstLoreTokens: zone3Stats.zone3ConstLoreTokens,
      gatedOut: recall.gatedOut,
      budgetDropped: recall.budgetDropped,
      activeFactCount,
      blindSpotCount,
      activeStoryletTitles,
      hiddenFloorCount: state.hiddenEntryIds.size,
      repetitionScore: narrativeHealth.repetitionScore,
      stagnantTurns: narrativeHealth.stagnantTurns,
      ...(sidecarStatus !== undefined ? { lastSidecarStatus: sidecarStatus } : {}),
    };
    lastXRay = nextXRay;

    return { messages: outMessages };
  });

  // Official Pi SDK `before_provider_request`: optionally apply SillyTavern preset sampling parameters (provider-aware)
  pi.on("before_provider_request", (event, ctx) => {
    if (!state.active || !state.applyPresetSampling || !activePreset) return;
    const payload = event?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    const s = activePreset.sampling;
    const next = { ...(payload as Record<string, unknown>) };
    const modelObj = (ctx?.model && typeof ctx.model === "object" ? ctx.model : undefined) as
      | { api?: string; provider?: string }
      | undefined;
    const api = typeof modelObj?.api === "string" ? modelObj.api.toLowerCase() : "";
    const provider = typeof modelObj?.provider === "string" ? modelObj.provider.toLowerCase() : "";

    let mutated = false;

    if (api.includes("google") || provider === "google" || provider.startsWith("google-")) {
      const existingCfg =
        next.generationConfig && typeof next.generationConfig === "object" && !Array.isArray(next.generationConfig)
          ? { ...(next.generationConfig as Record<string, unknown>) }
          : {};
      let cfgMutated = false;
      if (typeof s.temperature === "number" && Number.isFinite(s.temperature)) {
        existingCfg.temperature = s.temperature;
        cfgMutated = true;
      }
      if (typeof s.topP === "number" && Number.isFinite(s.topP)) {
        existingCfg.topP = s.topP;
        cfgMutated = true;
      }
      if (typeof s.maxTokens === "number" && Number.isFinite(s.maxTokens) && s.maxTokens > 0) {
        existingCfg.maxOutputTokens = s.maxTokens;
        cfgMutated = true;
      }
      if (cfgMutated) {
        next.generationConfig = existingCfg;
        mutated = true;
      }
      return mutated ? next : undefined;
    }

    if (api === "anthropic-messages" || api.includes("anthropic") || provider === "anthropic") {
      if (typeof s.temperature === "number" && Number.isFinite(s.temperature)) {
        next.temperature = s.temperature;
        mutated = true;
      }
      if (typeof s.topP === "number" && Number.isFinite(s.topP)) {
        next.top_p = s.topP;
        mutated = true;
      }
      if (typeof s.maxTokens === "number" && Number.isFinite(s.maxTokens) && s.maxTokens > 0) {
        next.max_tokens = s.maxTokens;
        mutated = true;
      }
      return mutated ? next : undefined;
    }

    if (api === "openai-responses") {
      if (typeof s.temperature === "number" && Number.isFinite(s.temperature)) {
        next.temperature = s.temperature;
        mutated = true;
      }
      if (typeof s.topP === "number" && Number.isFinite(s.topP)) {
        next.top_p = s.topP;
        mutated = true;
      }
      if (typeof s.maxTokens === "number" && Number.isFinite(s.maxTokens) && s.maxTokens > 0) {
        next.max_output_tokens = s.maxTokens;
        mutated = true;
      }
      return mutated ? next : undefined;
    }

    if (typeof s.temperature === "number" && Number.isFinite(s.temperature)) {
      next.temperature = s.temperature;
      mutated = true;
    }
    if (typeof s.topP === "number" && Number.isFinite(s.topP)) {
      next.top_p = s.topP;
      mutated = true;
    }
    if (typeof s.maxTokens === "number" && Number.isFinite(s.maxTokens) && s.maxTokens > 0) {
      next.max_tokens = s.maxTokens;
      mutated = true;
    }
    if (typeof s.frequencyPenalty === "number" && Number.isFinite(s.frequencyPenalty)) {
      next.frequency_penalty = s.frequencyPenalty;
      mutated = true;
    }
    if (typeof s.presencePenalty === "number" && Number.isFinite(s.presencePenalty)) {
      next.presence_penalty = s.presencePenalty;
      mutated = true;
    }
    return mutated ? next : undefined;
  });

  // Universal SDK/RPC/TUI stripping of trailing [[RP_DELTA]]...[[/RP_DELTA]] before message persistence & UI display
  pi.on("message_end", (event) => {
    if (!state.active || isOocTurn) return;
    const msg = event?.message as PiMessage | undefined;
    if (!msg || msg.role !== "assistant") return;
    const fullText = extractMessageText(msg);
    if (!fullText || !fullText.includes("[[RP_DELTA]]")) return;
    const { cleanProse, rawBlock } = extractInlineDelta(fullText);
    if (!rawBlock) return;
    pendingInlineDeltaBlock = rawBlock;
    if (typeof msg.content === "string") {
      return { message: { ...msg, content: cleanProse } };
    }
    if (Array.isArray(msg.content)) {
      let changed = false;
      const nextBlocks = msg.content.map((b) => {
        if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
          const stripped = stripInlineDelta(b.text);
          if (stripped !== b.text) {
            changed = true;
            return { ...b, text: stripped };
          }
        }
        return b;
      });
      if (changed) {
        return { message: { ...msg, content: nextBlocks } };
      }
    }
    return undefined;
  });

  // Deterministic turn_end settlement (< 2ms, skips intermediate tool-call assistant steps!)
  pi.on("turn_end", (event, ctx) => {
    if (!state.active || !activeCard) return;

    const msg = event?.message as PiMessage | undefined;
    if (isIntermediateToolCallMessage(msg)) {
      // Tool-call loop intermediate turn — do NOT increment turn counter or burn TTLs!
      return;
    }

    const resolvedEntryId =
      typeof event?.messageEntryId === "string" && event.messageEntryId
        ? event.messageEntryId
        : typeof msg?.entryId === "string" && msg.entryId
          ? msg.entryId
          : typeof msg?.id === "string" && msg.id
            ? msg.id
            : null;
    const isErrorOrAborted =
      event?.outcome === "error" ||
      event?.outcome === "aborted" ||
      msg?.stopReason === "error" ||
      msg?.stopReason === "aborted";

    if (msg) {
      lastAssistantText = extractMessageText(msg);
      // Auto-recover from DeepSeek V4 DSML / malformed `<rp_state_patch">` OR reasoning-only/empty stop without burning a turn!
      // Never trigger recovery retries on API errors or aborted turns.
      const isMalformed = !isErrorOrAborted && isMalformedToolLeakText(lastAssistantText);
      const isEmptyStop = !isErrorOrAborted && !isMalformed && isReasoningOnlyOrEmptyStop(msg);
      if (isMalformed || isEmptyStop) {
        const fp = computeMessageFingerprint(msg);
        commitTx({
          kind: "hide_toggle",
          entryIds: resolvedEntryId ? [resolvedEntryId] : [],
          fingerprints: [fp],
          hidden: true,
        });
        if (consecutiveLeakRecoveries < 1) {
          consecutiveLeakRecoveries += 1;
          ctx?.ui?.notify?.(
            isEmptyStop
              ? "检测到模型仅输出思考/空响应，已自动静默恢复生成正文…"
              : "检测到模型输出残缺工具标签，已自动静默恢复生成正文…",
            "info",
          );
          pi.sendMessage(
            {
              customType: "rp:event",
              content: isEmptyStop
                ? "[Auto-recovery: the previous response produced no visible story prose (reasoning-only/empty stop). Output the narrative prose directly now.]"
                : "[Auto-recovery: the previous output contained only malformed tool markup. Output the narrative prose directly now.]",
              display: false,
              details: { kind: "leak_recovery" },
            },
            { triggerTurn: true },
          );
          return;
        }
        pendingLoreRuntime = null;
        isOocTurn = false;
        renderRpHud(ctx, state, activeCard, lastXRay);
        return;
      } else if (lastAssistantText.trim().length > 0) {
        consecutiveLeakRecoveries = 0;
      }
    }

    const thisTurnOoc = isOocTurn;
    lastTurnWasOoc = thisTurnOoc;

    // Auto-hide OOC Q&A pair from subsequent story LLM context (zero OOC context pollution!)
    // Messages stay visible in the user's chat UI, but future story turns never see OOC chatter.
    if (thisTurnOoc && msg) {
      const hideIds: string[] = [];
      const hideFps: string[] = [computeMessageFingerprint(msg)];
      const assistantId = resolvedEntryId;
      if (assistantId) hideIds.push(assistantId);
      let hidFallbackAssistant = Boolean(assistantId);
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i]!;
        if (e.type === "message" && e.message) {
          const t = extractMessageText(e.message).trim();
          if (e.message.role === "user" && (/^\[OOC\b/i.test(t) || /^(?:\(\(|（（)/.test(t))) {
            hideIds.push(e.id);
            hideFps.push(computeMessageFingerprint(e.message));
            break;
          }
          if (e.message.role === "assistant" && !hidFallbackAssistant) {
            hideIds.push(e.id);
            hideFps.push(computeMessageFingerprint(e.message));
            hidFallbackAssistant = true;
          }
        } else if (e.type === "custom_message" && e.customType === "rp:ooc") {
          hideIds.push(e.id);
          const content = (e as { content?: PiMessage["content"] }).content;
          if (content !== undefined) {
            hideFps.push(computeMessageFingerprint({ role: "custom", content }));
          }
          break;
        }
      }
      commitTx({ kind: "hide_toggle", entryIds: Array.from(new Set(hideIds)), fingerprints: Array.from(new Set(hideFps)), hidden: true });
    }

    const prevLocBeforeDelta = state.location;
    const prevEraBeforeDelta = state.era;

    // Single-model zero-RTT inline delta sync (`[[RP_DELTA]]...[[/RP_DELTA]]`)
    const capturedDeltaBlock = pendingInlineDeltaBlock;
    pendingInlineDeltaBlock = null;
    if (!thisTurnOoc && (capturedDeltaBlock || lastAssistantText)) {
      let rawBlock = capturedDeltaBlock;
      if (!rawBlock && lastAssistantText) {
        const extracted = extractInlineDelta(lastAssistantText);
        if (extracted.rawBlock) {
          lastAssistantText = extracted.cleanProse;
          rawBlock = extracted.rawBlock;
        }
      }
      if (rawBlock) {
        const turnRegistry = buildEntityRegistry({ card: activeCard, extraCastCards, state });
        const parsedDelta = parseAndValidateInlineDelta(rawBlock, state, turnRegistry);
        for (const dtx of parsedDelta.txs) {
          commitTx(dtx);
        }
      }
    }

    runDeterministicTurnSettlement({
      pi,
      allLoreEntries: getAllActiveLoreEntries(),
      state,
      isOocTurn: thisTurnOoc,
      pendingLoreRuntime,
    });

    // Dynamic Rumor / Epistemic Propagation among bonded present NPCs (zero LLM cost)
    if (!thisTurnOoc) {
      propagateSecretsOnScene(state, commitTx);
    }

    // Automatic Episodic -> Semantic Scene Consolidation (zero LLM cost)
    if (!thisTurnOoc) {
      const autoChapter = maybeBuildAutoSceneChapter(state, prevLocBeforeDelta, prevEraBeforeDelta, lastAssistantText);
      if (autoChapter) {
        commitTx({ kind: "memory_book_upsert", entry: autoChapter });
      }
    }

    isOocTurn = false;
    pendingLoreRuntime = null;
    renderRpHud(ctx, state, activeCard, lastXRay);
  });

  // Optional zero-TTFT sidecar extractor (per-turn idempotency + strict OOC/turn-0 isolation!)
  const triggerSidecarOnce = async (ctx: PiExtensionContext) => {
    if (!state.active || state.settlementMode !== "sidecar-light") return;
    if (lastTurnWasOoc || state.turn <= 0) return;
    if (lastSidecarSettledTurn === state.turn) return;
    lastSidecarSettledTurn = state.turn;
    const startEpoch = runtimeEpoch;
    try {
      const committed = await runSidecarLightSettlement({
        pi,
        ctx,
        state,
        getState: () => state,
        isStale: () => runtimeEpoch !== startEpoch,
        lastUserText,
        lastAssistantText,
      });
      if (runtimeEpoch !== startEpoch) return;
      const sidecarStatus = (state as SessionRpState & { lastSidecarStatus?: unknown }).lastSidecarStatus;
      if (lastXRay && sidecarStatus !== undefined) {
        (lastXRay as ContextXRaySnapshot & { lastSidecarStatus?: unknown }).lastSidecarStatus = sidecarStatus;
      }
      if (committed > 0 || sidecarStatus !== undefined) {
        renderRpHud(ctx, state, activeCard, lastXRay);
      }
    } catch {
      // Sidecar settlement is best-effort and must never break the main RP turn
    }
  };

  pi.on("agent_settled", async (event, ctx) => {
    if (event?.aborted) return;
    await triggerSidecarOnce(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ctx?.ui?.setWorkingMessage?.(undefined);
    isOocTurn = false; // Safe recovery if turn was aborted before turn_end
  });

  // EverMemOS Semantic MemScene Compaction — 100% Official Pi SDK async CompactionResult contract
  // Stashes the consolidated MemScene draft here and commits it in `session_compact` once compaction succeeds!
  pi.on("session_before_compact", async (event, ctx) => {
    if (!state.active) return;
    const prep = (event?.preparation ?? {}) as Partial<PiCompactionPreparation>;
    const summary = await buildSemanticMemSceneCompaction(ctx, state, {
      messagesToSummarize: prep.messagesToSummarize,
      previousSummary: prep.previousSummary,
      signal: event?.signal,
    });

    // Prepare EverMemOS MemScene draft to commit on `session_compact` with a non-colliding ID
    pendingCompactionBookEntry = null;
    if (summary.trim()) {
      const prevMaxTurn = Array.from(state.memoryBooks.values()).reduce(
        (acc, b) => Math.max(acc, b.turnRange[1]),
        0,
      );
      const startTurn = Math.max(1, prevMaxTurn + 1);
      const endTurn = Math.max(startTurn, state.turn);
      const entities = Array.from(
        new Set(
          [
            state.location,
            ...state.presentNpcs,
            ...getActiveFacts(state)
              .slice(0, 8)
              .flatMap((f) => f.entities),
          ].filter(Boolean),
        ),
      ).slice(0, 12);
      pendingCompactionBookEntry = {
        id: `mb_compact_t${endTurn}_${Date.now().toString(36).slice(-4)}`,
        title: `压缩记忆章 (T${startTurn}-T${endTurn}${state.location ? ` · ${state.location}` : ""})`,
        summary: summary.trim().slice(0, 4000),
        entities,
        keywords: entities.slice(0, 8),
        turnRange: [startTurn, endTurn],
        enabled: true,
        pinned: false,
        createdTurn: state.turn,
      };
    }

    const firstKeptEntryId =
      typeof prep.firstKeptEntryId === "string" && prep.firstKeptEntryId
        ? prep.firstKeptEntryId
        : "";
    const tokensBefore = typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0;

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: {
          era: state.era,
          turn: state.turn,
          memoryBooks: state.memoryBooks.size,
          activeFacts: state.facts.size,
          openForesights: Array.from(state.foresights.values()).filter((h) => h.status === "open").length,
        },
      },
    };
  });

  // Commit the stashed MemScene Memory Book chapter only after compaction actually succeeds
  pi.on("session_compact", (_event, ctx) => {
    if (!state.active || !pendingCompactionBookEntry) return;
    const entry = pendingCompactionBookEntry;
    pendingCompactionBookEntry = null;
    commitTx({ kind: "memory_book_upsert", entry });
    renderRpHud(ctx, state, activeCard, lastXRay);
  });

  pi.on("session_compact_failed", () => {
    pendingCompactionBookEntry = null;
  });
}
