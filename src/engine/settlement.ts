/**
 * Post-turn deterministic settlement (`turn_end`, < 2ms) & optional zero-TTFT
 * asynchronous sidecar extractor (`agent_settled` via `ctx.modelRegistry.complete`).
 */

import type {
  BiTemporalFact,
  CompiledCard,
  PiExtensionAPI,
  PiExtensionContext,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "./state-replay.js";
import { tickLoreRuntime } from "../memory/graph-ppr.js";

/** Synchronous deterministic turn_end settlement (< 2ms, zero LLM calls). */
export function runDeterministicTurnSettlement(options: {
  pi: PiExtensionAPI;
  card: CompiledCard;
  state: SessionRpState;
  isOocTurn: boolean;
  pendingLoreRuntime?: {
    sticky: Record<string, number>;
    cooldown: Record<string, number>;
    consumedOneShots: string[];
  } | null;
}): void {
  const { pi, card, state, isOocTurn, pendingLoreRuntime } = options;
  if (!state.active || isOocTurn) return;

  const tickTx: RpTxEntry = { kind: "clock_tick", beatDelta: 1 };
  pi.appendEntry(RP_ENTRY_TYPE, tickTx);
  applyRpTx(state, tickTx);

  const baseSticky = pendingLoreRuntime?.sticky ?? state.loreSticky;
  const baseCooldown = pendingLoreRuntime?.cooldown ?? state.loreCooldown;
  const baseConsumed = pendingLoreRuntime?.consumedOneShots ?? Array.from(state.loreConsumedOneShots);
  const ticked = tickLoreRuntime(card.loreBook.entries, baseSticky, baseCooldown);

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
 * Optional zero-TTFT background sidecar (`agent_settled`):
 * Uses `ctx.modelRegistry.complete()` with existing user credentials to extract
 * concise new facts or foresights from the finished turn. Fails silently on any error.
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
    `You are a silent RP ledger extractor. Output ONLY strict JSON: ` +
    `{"facts":[{"statement":"...","entities":["..."],"public":true}],"foresights":[{"summary":"...","triggerHint":"...","entities":["..."]}]}. ` +
    `If nothing permanent changed, return {"facts":[],"foresights":[]}.`;

  try {
    const resp = await ctx.modelRegistry.complete(model, {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: `Turn ${state.turn} (${state.era}, ${state.location || "unknown"}):\nPlayer: ${lastUserText.slice(0, 600)}\nNarrative: ${lastAssistantText.slice(0, 1400)}`,
        },
      ],
    });
    const rawText =
      resp?.text ??
      resp?.content
        ?.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("") ??
      "";

    const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
    if (!jsonMatch) return 0;
    const parsed = JSON.parse(jsonMatch[0]!) as {
      facts?: Array<{ statement?: string; entities?: string[]; public?: boolean }>;
      foresights?: Array<{ summary?: string; triggerHint?: string; entities?: string[] }>;
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
    return committed;
  } catch {
    return 0;
  }
}
