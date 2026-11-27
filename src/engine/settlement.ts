/**
 * Post-turn deterministic settlement (`turn_end`, < 2ms, ONLY on final narrative assistant step)
 * & optional zero-TTFT asynchronous sidecar extractor (`agent_settled` / `agent_end` via `ctx.modelRegistry.complete`).
 */

import type {
  BiTemporalFact,
  CompiledLoreEntry,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "./state-replay.js";
import { validateCfsmTransition } from "./cfsm.js";
import { tickLoreRuntime } from "../memory/graph-ppr.js";

/** Detect whether an assistant message is an intermediate tool-call step rather than a completed narrative turn. */
export function isIntermediateToolCallMessage(msg: PiMessage | undefined): boolean {
  if (!msg || msg.role !== "assistant") return false;
  if (msg.stopReason === "toolUse" || msg.stopReason === "tool_calls") return true;
  if (Array.isArray(msg.content)) {
    const hasToolCall = msg.content.some(
      (b) => b && typeof b === "object" && (b.type === "toolCall" || b.type === "tool_use"),
    );
    if (hasToolCall) return true;
  }
  return false;
}

/** Synchronous deterministic turn_end settlement (< 2ms, zero LLM calls). */
export function runDeterministicTurnSettlement(options: {
  pi: PiExtensionAPI;
  allLoreEntries: CompiledLoreEntry[];
  state: SessionRpState;
  isOocTurn: boolean;
  pendingLoreRuntime?: {
    activatedIds: string[];
    sticky: Record<string, number>;
    cooldown: Record<string, number>;
    consumedOneShots: string[];
  } | null;
}): void {
  const { pi, allLoreEntries, state, isOocTurn, pendingLoreRuntime } = options;
  if (!state.active || isOocTurn) return;

  const tickTx: RpTxEntry = { kind: "clock_tick", beatDelta: 1 };
  pi.appendEntry(RP_ENTRY_TYPE, tickTx);
  applyRpTx(state, tickTx);

  const baseSticky = pendingLoreRuntime?.sticky ?? state.loreSticky;
  const baseCooldown = pendingLoreRuntime?.cooldown ?? state.loreCooldown;
  const baseConsumed = pendingLoreRuntime?.consumedOneShots ?? Array.from(state.loreConsumedOneShots);
  const activatedIds = pendingLoreRuntime?.activatedIds ?? [];
  const ticked = tickLoreRuntime(allLoreEntries, baseSticky, baseCooldown, activatedIds);

  const loreTx: RpTxEntry = {
    kind: "lore_runtime",
    sticky: ticked.sticky,
    cooldown: ticked.cooldown,
    consumedOneShots: baseConsumed,
  };
  pi.appendEntry(RP_ENTRY_TYPE, loreTx);
  applyRpTx(state, loreTx);
}

/**
 * Optional zero-TTFT background sidecar (`agent_settled` / `agent_end`):
 * Extracts concise new facts, invalidated facts, DREAM belief updates, CFSM transitions,
 * and foresights using `ctx.modelRegistry.complete()`. Fails silently on any error.
 */
export async function runSidecarLightSettlement(options: {
  pi: PiExtensionAPI;
  ctx: PiExtensionContext;
  state: SessionRpState;
  lastUserText: string;
  lastAssistantText: string;
}): Promise<number> {
  const { pi, ctx, state, lastUserText, lastAssistantText } = options;
  if (!state.active || state.settlementMode !== "sidecar-light") return 0;
  if (!ctx.modelRegistry?.complete) return 0;
  if (!lastAssistantText.trim()) return 0;

  let model = ctx.model;
  if (state.sidecarModel && ctx.modelRegistry.find) {
    const [provider, id] = state.sidecarModel.split("/");
    if (provider && id) {
      model = ctx.modelRegistry.find(provider, id) ?? model;
    }
  }
  if (!model) return 0;

  const systemPrompt =
    `You are a silent RP world-state ledger extractor. Output ONLY strict JSON with optional arrays:\n` +
    `{"facts":[{"statement":"...","entities":["..."],"public":true}],` +
    `"beliefs":[{"actorId":"...","target":"...","activatingEvent":"...","belief":"..."}],` +
    `"foresights":[{"summary":"...","triggerHint":"...","entities":["..."]}],` +
    `"cfsm":[{"actorId":"...","axis":"...","to":"...","reason":"..."}]}.\n` +
    `Only extract durable changes; if nothing permanent changed, return {"facts":[],"beliefs":[],"foresights":[],"cfsm":[]}.`;

  try {
    const resp = await ctx.modelRegistry.complete(model, {
      systemPrompt,
      messages: [
        {
          role: "user",
          content:
            `Turn ${state.turn} (${state.era}, ${state.location || "unknown"}, present: ${state.presentNpcs.join(", ") || "none"}):\n` +
            `Player: ${lastUserText.slice(0, 600)}\n` +
            `Narrative: ${lastAssistantText.slice(0, 1500)}`,
        },
      ],
    });
    const rawText =
      resp?.text ??
      resp?.content
        ?.filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
        .map((b) => b.text)
        .join("") ??
      "";

    const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
    if (!jsonMatch) return 0;
    const parsed = JSON.parse(jsonMatch[0]!) as {
      facts?: Array<{ statement?: string; entities?: string[]; public?: boolean }>;
      beliefs?: Array<{ actorId?: string; target?: string; activatingEvent?: string; belief?: string }>;
      foresights?: Array<{ summary?: string; triggerHint?: string; entities?: string[] }>;
      cfsm?: Array<{ actorId?: string; axis?: string; to?: string; reason?: string }>;
    };

    let committed = 0;
    for (const f of parsed.facts ?? []) {
      if (!f.statement?.trim()) continue;
      const fact: BiTemporalFact = {
        id: `fact_t${state.turn}_${committed}`,
        statement: f.statement.trim(),
        entities: Array.isArray(f.entities) ? f.entities.map(String) : [],
        validFromTurn: state.turn,
        validUntilTurn: null,
        witnessIds: f.public === false && state.presentNpcs.length > 0 ? [...state.presentNpcs] : "public",
      };
      const tx: RpTxEntry = { kind: "fact_add", fact };
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    }

    for (const b of parsed.beliefs ?? []) {
      if (!b.actorId?.trim() || !b.belief?.trim()) continue;
      const tx: RpTxEntry = {
        kind: "belief_update",
        actorId: b.actorId.trim(),
        target: b.target?.trim() || "player",
        activatingEvent: b.activatingEvent?.trim() || "recent scene",
        belief: b.belief.trim(),
        turn: state.turn,
      };
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    }

    for (const h of parsed.foresights ?? []) {
      if (!h.summary?.trim()) continue;
      const tx: RpTxEntry = {
        kind: "foresight_upsert",
        hook: {
          id: `hook_t${state.turn}_${committed}`,
          summary: h.summary.trim(),
          triggerHint: h.triggerHint?.trim() || "",
          entities: Array.isArray(h.entities) ? h.entities.map(String) : [],
          plantedTurn: state.turn,
          status: "open",
        },
      };
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    }

    for (const c of parsed.cfsm ?? []) {
      if (!c.actorId?.trim() || !c.axis?.trim() || !c.to?.trim()) continue;
      const check = validateCfsmTransition(state, c.actorId.trim(), c.axis.trim(), c.to.trim());
      if (!check.ok) continue;
      const from = state.cfsmStates[c.actorId.trim()]?.[c.axis.trim()]?.state ?? "initial";
      const tx: RpTxEntry = {
        kind: "cfsm_transition",
        actorId: c.actorId.trim(),
        axis: c.axis.trim(),
        from,
        to: c.to.trim(),
        reason: c.reason?.trim() || "sidecar",
        turn: state.turn,
      };
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    }

    return committed;
  } catch {
    return 0;
  }
}
