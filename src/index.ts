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
  PiCompactionPreparation,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  RpTxEntry,
  SessionRpState,
} from "./types.js";
import { createHash } from "node:crypto";
import { RP_ENTRY_TYPE, applyRpTx, createInitialRpState, replayBranchState } from "./engine/state-replay.js";
import { loadCompiledCard, loadCompiledPreset, resolveCardBySlug } from "./storage/workspace-store.js";
import { recallLoreWithGraphPpr, recallMemoryBooks } from "./memory/graph-ppr.js";
import { buildSemanticMemSceneCompaction } from "./memory/compaction.js";
import { getActiveFacts, selectFactsForZone3 } from "./memory/bitemporal.js";
import { partitionEpistemicFacts } from "./engine/gates.js";
import { evaluateNarrativeHealth } from "./engine/stagnation.js";
import { estimateTokens } from "./context/token-budget.js";
import {
  attachZone3ToMessages,
  buildZone1FrozenPrefix,
  buildZone3TransientTail,
  computeMessagesTokens,
  computeZone1Hash,
  evaluateActiveStorylets,
  extractRecentMessagesText,
} from "./context/zone-builder.js";
import {
  isIntermediateToolCallMessage,
  runDeterministicTurnSettlement,
  runSidecarLightSettlement,
} from "./engine/settlement.js";
import { applyDisplayRegexRules, stripDisplayResiduals } from "./parser/sanitizer.js";
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
    lastTurnWasOoc = false;
    lastUserText = "";
    lastAssistantText = "";
    lastSidecarSettledTurn = -1;
    lastToolsHash = "";
    lastZone1Hash = "";
    lastZone1Tokens = 0;
    lastZone2PrefixHashes = [];
    pendingCacheInvalidation = "first_turn";
    cacheHitStreak = 0;
    lastXRay = null;
    pendingLoreRuntime = null;
  }

  function commitTx(tx: RpTxEntry): void {
    pi.appendEntry(RP_ENTRY_TYPE, tx);
    applyRpTx(state, tx);
  }

  function getDesiredRpTools(): string[] {
    // In sidecar-light or off mode, the main narrative model does not need state/fact write tools;
    // omitting them saves tool-schema tokens and prevents XML-style `<rp_state_patch">` leaks.
    if (state.settlementMode === "sidecar-light" || state.settlementMode === "off") {
      return RP_TOOL_NAMES.filter((t) => t !== "rp_state_patch" && t !== "rp_fact_commit");
    }
    return [...RP_TOOL_NAMES];
  }

  function activateRpTools(): void {
    const current = pi.getActiveTools();
    const desired = getDesiredRpTools();
    const isAlreadyPureRp = current.length > 0 && current.every((t) => rpToolSet.has(t));
    if (!isAlreadyPureRp) {
      const nonRp = current.filter((t) => !rpToolSet.has(t));
      savedCodingTools = nonRp;
    }
    pi.setActiveTools(desired);
  }

  function restoreCodingTools(): void {
    if (savedCodingTools !== null) {
      pi.setActiveTools([...savedCodingTools]);
      savedCodingTools = null;
    } else {
      const filtered = pi.getActiveTools().filter((t) => !rpToolSet.has(t));
      if (filtered.length !== pi.getActiveTools().length) {
        pi.setActiveTools(filtered);
      }
    }
  }

  function teardownSessionRuntime(ctx: PiExtensionContext): void {
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
      activeCard = null;
      extraCastCards = [];
      activePreset = null;
      state.active = false;
      restoreCodingTools();
      clearRpHud(ctx);
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
    ctx.ui.setTitle?.(`◆ ${activeCard.identity.name} · Pi RP`);
    rpTitleSet = true;
    renderRpHud(ctx, state, activeCard, lastXRay);
  }

  const runtime: RpRuntimeHandle = {
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
  };

  // Register tools (defaultActive: false -> 0 tokens in coding sessions)
  registerRpTools(pi, {
    getState: () => state,
    getCard: () => activeCard,
    getExtraCastCards: () => extraCastCards,
    commitTx,
    refreshHud,
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

  // Register 16 ergonomic, terminal-safe shortcuts
  registerRpShortcuts(pi, {
    isActive: () => state.active,
    openMenu: (ctx) => openRpMenu(runtime, ctx),
    openDashboard: (ctx) => openRpDashboard(makeDashboardRuntime(runtime), ctx),
    quickReplies: (ctx) => actionQuickReplies(runtime, ctx, ""),
    openXRay: (ctx) => actionXRay(runtime, ctx),
    impersonate: (ctx) => actionImpersonate(runtime, ctx, ""),
    sidePrompt: (ctx) => actionSidePrompt(runtime, ctx, ""),
    rerollLast: (ctx) => actionReroll(runtime, ctx, ""),
    continueStory: (ctx) => actionContinue(runtime, ctx),
    actionIdeas: (ctx) => actionIdeas(runtime, ctx),
    directorNote: (ctx) => actionDirectorNote(runtime, ctx, ""),
    cyclePacing: (ctx) => actionCyclePacing(runtime, ctx),
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
        if (mdCtx?.isStreaming || mdCtx?.messageType === "assistant-thinking") return markdown;
        let out = markdown;
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

  // Zero-friction inline OOC shorthand: `((...))` or `（（...））` automatically marks OOC turn without advancing story/clock
  pi.on("input", (event) => {
    if (!state.active || !activeCard) return { action: "continue" };
    const raw = typeof event?.text === "string" ? event.text.trim() : "";
    const oocMatch = /^(?:\(\(([\s\S]+?)\)\)|（（([\s\S]+?)））)$/.exec(raw);
    if (oocMatch) {
      const inner = (oocMatch[1] ?? oocMatch[2] ?? "").trim();
      if (inner) {
        isOocTurn = true;
        return {
          action: "transform",
          text: `[OOC - Out of Character Discussion; do NOT advance the story or modify world state]\n${inner}`,
        };
      }
    }
    return { action: "continue" };
  });

  // Zone 1 Frozen Prefix (KV-Cache 100% byte-identical across turns, fingerprinted via SHA-256)
  pi.on("before_agent_start", (event) => {
    if (!state.active || !activeCard) return;

    if (typeof event?.prompt === "string") {
      lastUserText = event.prompt;
      const trimmedPrompt = event.prompt.trim();
      if (/^(?:\(\([\s\S]+?\)\)|（（[\s\S]+?））|\[OOC\b)/i.test(trimmedPrompt)) {
        isOocTurn = true;
      }
    }

    const initialPersona = state.initialPersona ?? state.currentPersona;
    const zone1 = buildZone1FrozenPrefix({
      card: activeCard,
      extraCastCards,
      preset: activePreset,
      initialPersona,
    });

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
    const totalLoreBudget = Math.min(state.loreTokenBudget, activeCard.loreBook.tokenBudget || state.loreTokenBudget);
    const hasMemoryBooks = state.memoryBooks.size > 0;
    const memoryBookBudget = hasMemoryBooks ? Math.min(450, Math.floor(totalLoreBudget * 0.25)) : 0;
    const loreBudget = Math.max(200, totalLoreBudget - memoryBookBudget);

    const recall = recallLoreWithGraphPpr({
      entries: allLoreEntries,
      state,
      recentText,
      messages,
      defaultScanDepth: scanDepth,
      tokenBudget: loreBudget,
    });

    const memBookRecall = hasMemoryBooks
      ? recallMemoryBooks(state, recentText, 4)
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
    const narrativeHealth = evaluateNarrativeHealth(state, messages);

    const zone3 = buildZone3TransientTail({
      card: activeCard,
      extraCastCards,
      state,
      preset: activePreset,
      recalledLore: recall.selected,
      recalledMemoryBooks: memBookRecall.chapters,
      recentText,
      lastUserMessage: lastUserMsg,
      lastCharMessage: lastCharMsg,
      narrativeHealth,
    });

    const outMessages = attachZone3ToMessages(
      messages,
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

    // Record live Context X-Ray snapshot (0 extra LLM calls!)
    const activeFacts = selectFactsForZone3(state, recentText, 8, 6);
    const { blindSpots } = partitionEpistemicFacts(activeFacts, state.presentNpcs);
    const activeStorylets = evaluateActiveStorylets(state);
    const zone3Tokens = estimateTokens(zone3);
    const zone2Tokens = Math.max(0, computeMessagesTokens(outMessages) - zone3Tokens);

    lastXRay = {
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
      loreTokens: recall.usedTokens + memBookTokens,
      loreBudget: totalLoreBudget,
      recalled: [...recall.traces, ...memBookRecall.traces],
      gatedOut: recall.gatedOut,
      budgetDropped: recall.budgetDropped,
      activeFactCount: activeFacts.length,
      blindSpotCount: blindSpots.length,
      activeStoryletTitles: activeStorylets.map((s) => s.title),
      hiddenFloorCount: state.hiddenEntryIds.size,
      repetitionScore: narrativeHealth.repetitionScore,
      stagnantTurns: narrativeHealth.stagnantTurns,
    };

    return { messages: outMessages };
  });

  // Official Pi SDK `before_provider_request`: optionally apply SillyTavern preset sampling parameters
  pi.on("before_provider_request", (event) => {
    if (!state.active || !state.applyPresetSampling || !activePreset) return;
    const payload = event?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

    const s = activePreset.sampling;
    const next = { ...(payload as Record<string, unknown>) };
    let mutated = false;
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

  // Deterministic turn_end settlement (< 2ms, skips intermediate tool-call assistant steps!)
  pi.on("turn_end", (event, ctx) => {
    if (!state.active || !activeCard) return;

    const msg = event?.message as PiMessage | undefined;
    if (isIntermediateToolCallMessage(msg)) {
      // Tool-call loop intermediate turn — do NOT increment turn counter or burn TTLs!
      return;
    }

    if (msg) {
      lastAssistantText = extractMessageText(msg);
    }

    const thisTurnOoc = isOocTurn;
    lastTurnWasOoc = thisTurnOoc;

    runDeterministicTurnSettlement({
      pi,
      allLoreEntries: getAllActiveLoreEntries(),
      state,
      isOocTurn: thisTurnOoc,
      pendingLoreRuntime,
    });

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
    const committed = await runSidecarLightSettlement({
      pi,
      ctx,
      state,
      lastUserText,
      lastAssistantText,
    });
    if (committed > 0) {
      renderRpHud(ctx, state, activeCard, lastXRay);
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    await triggerSidecarOnce(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    ctx?.ui?.setWorkingMessage?.(undefined);
    isOocTurn = false; // Safe recovery if turn was aborted before turn_end
    await triggerSidecarOnce(ctx);
  });

  // EverMemOS Semantic MemScene Compaction — 100% Official Pi SDK async CompactionResult contract
  // AND automatically persists the consolidated MemScene into a searchable Memory Book chapter!
  pi.on("session_before_compact", async (event, ctx) => {
    if (!state.active) return;
    const prep = (event?.preparation ?? {}) as Partial<PiCompactionPreparation>;
    const summary = await buildSemanticMemSceneCompaction(ctx, state, {
      messagesToSummarize: prep.messagesToSummarize,
      previousSummary: prep.previousSummary,
    });

    // Persist EverMemOS MemScene consolidation into Memory Books so future turns can Graph-PPR recall it!
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
      commitTx({
        kind: "memory_book_upsert",
        entry: {
          id: `mb_compact_t${endTurn}`,
          title: `压缩记忆章 (T${startTurn}-T${endTurn}${state.location ? ` · ${state.location}` : ""})`,
          summary: summary.trim().slice(0, 1600),
          entities,
          keywords: entities.slice(0, 8),
          turnRange: [startTurn, endTurn],
          enabled: true,
          pinned: false,
          createdTurn: state.turn,
        },
      });
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
}
