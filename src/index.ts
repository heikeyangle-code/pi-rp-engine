/**
 * pi-rp-engine v2 — Official Pi Coding Agent (1.6.1+) Zero-Dependency Roleplay Extension.
 *
 * Strict Lifecycle & Architectural Guarantees:
 *  1. 100% Session-Only Binding: RP mode lives EXCLUSIVELY in a session that has explicitly
 *     executed `/rp load` or `/rp import -> 立即开启`. Importing or storing cards NEVER
 *     auto-activates RP mode in other sessions of the same project!
 *  2. Total Clean Exit: `/rp exit` / `/rp off` / `Alt+Shift+X` emits `unbind`, completely wipes
 *     every runtime variable (`activeCard`, `extraCastCards`, `activePreset`, `isOocTurn`,
 *     `pendingLoreRuntime`, etc.), restores original coding tools, and clears all RP HUD/widgets.
 *  3. KV-Cache Three-Zone Assembly:
 *     - Zone 1 (`before_agent_start`): byte-identical frozen prefix across turns.
 *     - Zone 2 (`messages`): strictly append-only history (non-destructive fingerprint hiding).
 *     - Zone 3 (`context`): transient tail frame attached only to outbound tail, never saved.
 *  4. Official Pi SDK 1.6.1+ Parity:
 *     - Hooks `session_start`, `session_tree`, `session_switch` for exact branch replay.
 *     - Skips intermediate tool-call assistant steps in `turn_end` so turns/TTLs never double-tick.
 *     - Returns compliant `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`.
 *     - Registers narrative `renderCall`/`renderResult`, `registerMessageRenderer`, display-only
 *       `registerMarkdownTransformer`, and 10 terminal-safe shortcuts.
 */

import type {
  CompiledCard,
  CompiledLoreEntry,
  CompiledPreset,
  PiCompactionPreparation,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  RpTxEntry,
  SessionRpState,
} from "./types.js";
import { RP_ENTRY_TYPE, applyRpTx, createInitialRpState, replayBranchState } from "./engine/state-replay.js";
import { loadCompiledCard, loadCompiledPreset, resolveCardBySlug } from "./storage/workspace-store.js";
import { recallLoreWithGraphPpr } from "./memory/graph-ppr.js";
import { buildMemSceneCompactionSummary } from "./memory/compaction.js";
import {
  attachZone3ToMessages,
  buildZone1FrozenPrefix,
  buildZone3TransientTail,
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
import { registerRpMessageRenderers } from "./ui/renderers.js";
import {
  type RpRuntimeHandle,
  actionBookmarkSave,
  actionContinue,
  actionDirectorNote,
  actionExitRp,
  actionIdeas,
  actionManualRoll,
  actionOoc,
  actionSetHud,
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
  let isOocTurn = false;
  let lastUserText = "";
  let lastAssistantText = "";
  let lastSidecarSettledTurn = -1;
  let pendingLoreRuntime: {
    activatedIds: string[];
    sticky: Record<string, number>;
    cooldown: Record<string, number>;
    consumedOneShots: string[];
  } | null = null;

  const rpToolSet = new Set<string>(RP_TOOL_NAMES);

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
    lastUserText = "";
    lastAssistantText = "";
    lastSidecarSettledTurn = -1;
    pendingLoreRuntime = null;
  }

  function commitTx(tx: RpTxEntry): void {
    pi.appendEntry(RP_ENTRY_TYPE, tx);
    applyRpTx(state, tx);
  }

  function activateRpTools(): void {
    const current = pi.getActiveTools();
    const isAlreadyPureRp =
      current.length === RP_TOOL_NAMES.length && current.every((t) => rpToolSet.has(t));
    if (!isAlreadyPureRp) {
      const nonRp = current.filter((t) => !rpToolSet.has(t));
      savedCodingTools = nonRp;
    }
    pi.setActiveTools([...RP_TOOL_NAMES]);
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
  }

  function refreshHud(ctx?: PiExtensionContext): void {
    if (!ctx) return;
    if (state.active) {
      renderRpHud(ctx, state, activeCard);
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
      // Card missing on disk — degrade cleanly instead of leaving broken RP tools active
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
    renderRpHud(ctx, state, activeCard);
  }

  const runtime: RpRuntimeHandle = {
    pi,
    getState: () => state,
    getCard: () => activeCard,
    getExtraCastCards: () => extraCastCards,
    getPreset: () => activePreset,
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

  // Register 10 ergonomic, terminal-safe shortcuts
  registerRpShortcuts(pi, {
    isActive: () => state.active,
    openMenu: (ctx) => openRpMenu(runtime, ctx),
    openDashboard: (ctx) => openRpDashboard(makeDashboardRuntime(runtime), ctx),
    continueStory: (ctx) => actionContinue(runtime, ctx),
    actionIdeas: (ctx) => actionIdeas(runtime, ctx),
    directorNote: (ctx) => actionDirectorNote(runtime, ctx, ""),
    oocChat: (ctx) => actionOoc(runtime, ctx, ""),
    quickRoll: (ctx) => actionManualRoll(runtime, ctx, ""),
    saveBookmark: (ctx) => actionBookmarkSave(runtime, ctx, ""),
    cycleHud: (ctx) => actionSetHud(runtime, ctx, ""),
    exitRp: (ctx) => actionExitRp(runtime, ctx, true),
  });

  // Display-only Markdown cleanup + SillyTavern AI_OUTPUT regex rules (never mutates JSONL or LLM context)
  if (typeof pi.registerMarkdownTransformer === "function") {
    pi.registerMarkdownTransformer(
      (markdown: string) => {
        if (!state.active || !activeCard) return markdown;
        let out = markdown;
        if (!state.rawPassthrough) {
          out = stripDisplayResiduals(out);
        }
        if (activeCard.displayRegexRules.length > 0) {
          out = applyDisplayRegexRules(out, activeCard.displayRegexRules, {
            charName: activeCard.identity.nickname || activeCard.identity.name,
            userName: state.currentPersona.name,
          });
        }
        return out;
      },
      { messageTypes: ["assistant", "rp:greeting"] },
    );
  }

  // -------------------------------------------------------------------------
  // Official Pi SDK Lifecycle Event Hooks
  // -------------------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  // Zone 1 Frozen Prefix (KV-Cache 100% byte-identical across turns)
  pi.on("before_agent_start", (event) => {
    if (!state.active || !activeCard) return;

    if (typeof event?.prompt === "string") {
      lastUserText = event.prompt;
    }

    const initialPersona = state.initialPersona ?? state.currentPersona;
    const zone1 = buildZone1FrozenPrefix({
      card: activeCard,
      extraCastCards,
      preset: activePreset,
      initialPersona,
    });

    return { systemPrompt: zone1 };
  });

  // Zone 3 Transient Tail Injection + Non-destructive floor hiding (Zero mutation to Zone 2)
  pi.on("context", (event) => {
    if (!state.active || !activeCard) return;
    const messages: PiMessage[] = Array.isArray(event?.messages) ? event.messages : [];
    if (messages.length === 0) return;

    const scanDepth = activeCard.loreBook.scanDepth || 4;
    const recentText = extractRecentMessagesText(messages, scanDepth);
    const allLoreEntries = getAllActiveLoreEntries();

    const recall = recallLoreWithGraphPpr({
      entries: allLoreEntries,
      state,
      recentText,
      messages,
      defaultScanDepth: scanDepth,
      tokenBudget: Math.min(state.loreTokenBudget, activeCard.loreBook.tokenBudget || state.loreTokenBudget),
    });

    pendingLoreRuntime = {
      activatedIds: recall.activatedIds,
      sticky: recall.nextSticky,
      cooldown: recall.nextCooldown,
      consumedOneShots: recall.nextConsumedOneShots,
    };

    // Extract last user & char messages for SillyTavern {{lastUserMessage}} / {{lastCharMessage}}
    let lastUserMsg = "";
    let lastCharMsg = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (!lastUserMsg && m.role === "user") lastUserMsg = extractMessageText(m);
      if (!lastCharMsg && m.role === "assistant") lastCharMsg = extractMessageText(m);
      if (lastUserMsg && lastCharMsg) break;
    }

    const zone3 = buildZone3TransientTail({
      card: activeCard,
      extraCastCards,
      state,
      preset: activePreset,
      recalledLore: recall.selected,
      recentText,
      lastUserMessage: lastUserMsg,
      lastCharMessage: lastCharMsg,
    });

    const outMessages = attachZone3ToMessages(
      messages,
      zone3,
      state.hiddenEntryIds,
      state.hiddenFingerprints,
    );
    return { messages: outMessages };
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

    runDeterministicTurnSettlement({
      pi,
      allLoreEntries: getAllActiveLoreEntries(),
      state,
      isOocTurn,
      pendingLoreRuntime,
    });

    isOocTurn = false;
    pendingLoreRuntime = null;
    renderRpHud(ctx, state, activeCard);
  });

  // Optional zero-TTFT sidecar extractor (per-turn idempotency guard across agent_settled & agent_end)
  const triggerSidecarOnce = async (ctx: PiExtensionContext) => {
    if (!state.active || state.settlementMode !== "sidecar-light") return;
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
      renderRpHud(ctx, state, activeCard);
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    await triggerSidecarOnce(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    await triggerSidecarOnce(ctx);
  });

  // EverMemOS MemScene Compaction — 100% Official Pi SDK CompactionResult contract!
  pi.on("session_before_compact", (event) => {
    if (!state.active) return;
    const prep = (event?.preparation ?? {}) as Partial<PiCompactionPreparation>;
    const summary = buildMemSceneCompactionSummary(state, {
      messagesToSummarize: prep.messagesToSummarize,
      previousSummary: prep.previousSummary,
    });

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
          activeFacts: state.facts.size,
          openForesights: Array.from(state.foresights.values()).filter((h) => h.status === "open").length,
        },
      },
    };
  });
}
