/**
 * pi-rp-engine — Universal Agentic Role-Playing & World Simulator Extension
 * for Official Pi SDK (@earendil-works/pi-coding-agent 1.6.1+).
 *
 * 100% standard Pi Extension APIs, zero third-party runtime dependencies,
 * zero app-specific hacks (works identically on desktop Pi CLI/TUI and pi-android).
 */

import type {
  CompiledCard,
  CompiledPreset,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  SessionRpState,
} from "./types.js";
import { createInitialRpState, replayBranchState } from "./engine/state-replay.js";
import {
  attachZone3ToMessages,
  buildZone1FrozenPrefix,
  buildZone3TransientTail,
  extractRecentMessagesText,
} from "./context/zone-builder.js";
import { recallLoreWithGraphPpr } from "./memory/graph-ppr.js";
import { buildMemSceneCompactionSummary } from "./memory/compaction.js";
import { runDeterministicTurnSettlement, runSidecarLightSettlement } from "./engine/settlement.js";
import {
  loadCompiledCard,
  loadCompiledPreset,
  loadProjectWorldConfig,
  resolveCardBySlug,
} from "./storage/workspace-store.js";
import { stripDisplayResiduals } from "./parser/sanitizer.js";
import { RP_TOOL_NAMES, createRpTools } from "./tools/rp-tools.js";
import { clearRpHud, renderRpHud } from "./ui/hud.js";
import { createRpCommand } from "./ui/commands.js";
import { actionShowInfo } from "./ui/actions.js";

const OOC_INPUT_REGEX = /^\s*(?:\(\([\s\S]*\)\)|（（[\s\S]*））)\s*$/;

export default function piRpEngine(pi: PiExtensionAPI): void {
  let state: SessionRpState = createInitialRpState();
  let activeCard: CompiledCard | null = null;
  let extraCastCards: CompiledCard[] = [];
  let activePreset: CompiledPreset | null = null;
  let savedCodingTools: string[] | null = null;
  let rpToolsActive = false;
  let isOocTurn = false;
  let lastUserText = "";
  let lastAssistantText = "";
  let pendingLoreRuntime: {
    sticky: Record<string, number>;
    cooldown: Record<string, number>;
    consumedOneShots: string[];
  } | null = null;

  const activateRpTools = () => {
    if (rpToolsActive) return;
    try {
      const current = pi.getActiveTools();
      savedCodingTools = current.filter((n) => !(RP_TOOL_NAMES as readonly string[]).includes(n));
      pi.setActiveTools([...RP_TOOL_NAMES]);
      rpToolsActive = true;
    } catch {
      // Ignore if host hasn't bound tool registry yet
    }
  };

  const restoreOriginalTools = () => {
    if (!rpToolsActive) return;
    try {
      if (savedCodingTools) {
        pi.setActiveTools(savedCodingTools);
      }
      rpToolsActive = false;
    } catch {
      // Ignore
    }
  };

  const refreshHud = (ctx?: PiExtensionContext) => {
    renderRpHud(ctx, state, activeCard);
  };

  const reloadRuntime = (ctx: PiExtensionContext) => {
    const projectCfg = loadProjectWorldConfig(ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    state = replayBranchState(branch, projectCfg);

    if (!state.active || !state.cardSlug) {
      activeCard = null;
      extraCastCards = [];
      activePreset = null;
      restoreOriginalTools();
      clearRpHud(ctx);
      return;
    }

    // Load primary card
    if (state.worldDir) {
      activeCard = loadCompiledCard(state.worldDir, state.cardSlug);
    }
    if (!activeCard) {
      activeCard = resolveCardBySlug(ctx.cwd, state.cardSlug)?.card ?? null;
    }

    // Load extra multi-character cast cards
    extraCastCards = [];
    for (const slug of state.activeCharacters) {
      if (slug === state.cardSlug) continue;
      const found = resolveCardBySlug(ctx.cwd, slug);
      if (found) extraCastCards.push(found.card);
    }

    // Load optional SillyTavern preset
    activePreset = state.presetId ? loadCompiledPreset(ctx.cwd, state.presetId) : null;

    if (activeCard) {
      activateRpTools();
      refreshHud(ctx);
    } else {
      restoreOriginalTools();
      clearRpHud(ctx);
    }
  };

  // 1. Register 6 static RP tools (defaultActive: false -> 0 token pollution when dormant)
  const tools = createRpTools({
    pi,
    getState: () => state,
    getCard: () => activeCard,
    refreshHud,
  });
  for (const tool of tools) {
    pi.registerTool(tool);
  }

  // 2. Register /rp dual-track command & ctrl+shift+r shortcut
  const actionRuntime = {
    pi,
    getState: () => state,
    getCard: () => activeCard,
    getPreset: () => activePreset,
    reloadRuntime,
    activateRpTools,
    restoreOriginalTools,
    refreshHud,
    markNextTurnOoc: () => {
      isOocTurn = true;
    },
  };
  pi.registerCommand("rp", createRpCommand(actionRuntime));
  pi.registerShortcut?.("ctrl+shift+r", {
    description: "打开 RP 世界状态面板",
    handler: (ctx) => actionShowInfo(actionRuntime, ctx),
  });

  // 3. Display-layer markdown purification (non-destructive; never modifies persisted JSONL)
  pi.registerMarkdownTransformer?.(
    (markdown) => {
      if (!state.active || !activeCard || state.rawPassthrough) return markdown;
      let out = stripDisplayResiduals(markdown);
      for (const rule of activeCard.displayRegexRules) {
        try {
          out = out.replace(new RegExp(rule.pattern, rule.flags), rule.replacement);
        } catch {
          // Skip invalid rule
        }
      }
      return out;
    },
    { messageTypes: ["assistant"] },
  );

  // 4. Lifecycle hooks: session_start & session_tree (deterministic Event Sourcing replay)
  pi.on("session_start", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reloadRuntime(ctx);
  });

  // 5. Input hook: OOC detection `((...))` / `（（...））`
  pi.on("input", (event) => {
    if (!state.active) return { action: "continue" };
    const text = typeof event?.text === "string" ? event.text : "";
    lastUserText = text;
    if (OOC_INPUT_REGEX.test(text)) {
      isOocTurn = true;
      return {
        action: "transform",
        text: `[OOC Director Channel — Do NOT advance in-world time, stats, or character memories]\n${text}`,
      };
    }
    isOocTurn = false;
    return { action: "continue" };
  });

  // 6. before_agent_start: Zone 1 Frozen Prefix (100% KV-Cache friendly & isolates coding prompt)
  pi.on("before_agent_start", () => {
    if (!state.active || !activeCard) return;
    const initialPersona = state.initialPersona ?? state.currentPersona;
    const zone1 = buildZone1FrozenPrefix({
      card: activeCard,
      extraCastCards,
      preset: activePreset,
      initialPersona,
    });
    return { systemPrompt: zone1 };
  });

  // 7. context: Non-destructive floor hiding + local BM25/PPR recall + Zone 3 Transient Tail
  pi.on("context", (event) => {
    if (!state.active || !activeCard) return;
    const messages = Array.isArray(event?.messages) ? (event.messages as PiMessage[]) : [];
    if (messages.length === 0) return;

    const recentText = extractRecentMessagesText(messages, activeCard.loreBook.scanDepth);
    const recalled = recallLoreWithGraphPpr({
      entries: activeCard.loreBook.entries,
      state,
      recentText,
      tokenBudget: state.loreTokenBudget,
    });

    pendingLoreRuntime = {
      sticky: recalled.nextSticky,
      cooldown: recalled.nextCooldown,
      consumedOneShots: recalled.nextConsumedOneShots,
    };

    const zone3 = buildZone3TransientTail({
      card: activeCard,
      state,
      preset: activePreset,
      recalledLore: recalled.selected,
      recentText,
    });

    const transformed = attachZone3ToMessages(messages, zone3, state.hiddenEntryIds);
    return { messages: transformed };
  });

  // 8. turn_end: Synchronous deterministic settlement (< 2ms)
  pi.on("turn_end", (event, ctx) => {
    if (!state.active || !activeCard) return;
    const msg = event?.message as PiMessage | undefined;
    if (msg && msg.role === "assistant") {
      if (typeof msg.content === "string") {
        lastAssistantText = msg.content;
      } else if (Array.isArray(msg.content)) {
        lastAssistantText = msg.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("");
      }
    }

    runDeterministicTurnSettlement({
      pi,
      card: activeCard,
      state,
      isOocTurn,
      pendingLoreRuntime,
    });
    pendingLoreRuntime = null;
    refreshHud(ctx);
  });

  // 9. agent_settled: Optional zero-TTFT asynchronous sidecar extraction
  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.active || isOocTurn) {
      isOocTurn = false;
      return;
    }
    const committed = await runSidecarLightSettlement({
      pi,
      ctx,
      state,
      lastUserText,
      lastAssistantText,
    });
    if (committed > 0) {
      refreshHud(ctx);
    }
  });

  // 10. session_before_compact: EverMemOS MemScene compaction
  pi.on("session_before_compact", () => {
    if (!state.active) return;
    return {
      compaction: {
        summary: buildMemSceneCompactionSummary(state),
      },
    };
  });
}
