/**
 * Post-turn deterministic settlement (`turn_end`, < 2ms, ONLY on final narrative assistant step)
 * & closed-loop zero-TTFT asynchronous sidecar extractor (`agent_settled` / `agent_end`):
 *  - Passes active fact IDs so contradicted facts are cleanly invalidated (`invalidatedFactIds`,
 *    addressing NCP-Bench 2026's 40–68% fact-conflict failure mode).
 *  - Tracks universal spatio-temporal anchors (`location`, `presentNpcs`, `worldTimeLabel`).
 *  - Dynamically prunes the JSON schema based on `state.modules` (`stats`, `inventory`, `clocks`)
 *    so slice-of-life/companion cards never hallucinate RPG inventories.
 *  - Validates every extracted mutation against deterministic bounds/CFSM rules before committing.
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
import { canCompleteWithRegistry, completeWithRegistry } from "./llm-helper.js";
import { computeCheckedStatValue, validateCfsmTransition, validateInventoryPatch } from "./cfsm.js";
import { getActiveFacts } from "../memory/bitemporal.js";
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
 * Closed-loop zero-TTFT background sidecar (`agent_settled` / `agent_end`):
 * Single-pass extraction over BOTH player actions and assistant-established world details.
 * Fails silently on any error so narrative UX is never interrupted.
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
  if (!canCompleteWithRegistry(ctx)) return 0;
  if (!lastAssistantText.trim()) return 0;

  let model = ctx.model;
  if (state.sidecarModel && ctx.modelRegistry?.find) {
    const [provider, id] = state.sidecarModel.split("/");
    if (provider && id) {
      model = ctx.modelRegistry?.find?.(provider, id) ?? model;
    }
  }
  if (!model) return 0;

  const schemaFields: string[] = [
    `"location": string|null`,
    `"presentNpcs": string[]|null`,
    `"worldTimeLabel": string|null`,
    `"facts": [{"statement":"...","entities":["..."],"public":true}]`,
    `"invalidatedFactIds": [{"id":"...","reason":"..."}]`,
    `"beliefs": [{"actorId":"...","target":"...","activatingEvent":"...","belief":"..."}]`,
    `"foresights": [{"summary":"...","triggerHint":"...","entities":["..."]}]`,
    `"cfsm": [{"actorId":"...","axis":"...","to":"...","reason":"..."}]`,
  ];
  if (state.modules.stats) {
    schemaFields.push(`"stats": [{"actorId":"...","key":"...","op":"set"|"add","value":number|string|boolean,"reason":"..."}]`);
  }
  if (state.modules.inventory) {
    schemaFields.push(`"inventory": [{"actorId":"...","item":"...","delta":integer,"note":"..."}]`);
  }
  if (state.modules.clocks) {
    schemaFields.push(`"clocks": [{"clockId":"...","label":"...","delta":integer,"max":integer}]`);
  }

  const systemPrompt =
    `You are a silent RP world-state ledger extractor. Extract durable changes established by EITHER the player OR the narrative.\n` +
    `Output ONLY strict JSON with optional fields:\n{${schemaFields.join(", ")}}\n` +
    `- Only include fields that genuinely changed this turn; omit unchanged fields or leave arrays empty.\n` +
    `- If a new development contradicts or supersedes an existing active fact listed below, include its exact id in invalidatedFactIds.`;

  const activeFactsSummary = getActiveFacts(state)
    .slice(0, 15)
    .map((f) => `[${f.id}] ${f.statement}`)
    .join("\n");

  const contextHeader = [
    `Turn ${state.turn}`,
    state.era || null,
    state.worldTimeLabel || null,
    `Location: ${state.location || "(unset)"}`,
    `Present: ${state.presentNpcs.join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join(" | ");

  try {
    const userPrompt =
      `${contextHeader}\n` +
      (activeFactsSummary ? `Active Facts:\n${activeFactsSummary}\n\n` : "\n") +
      `Player: ${lastUserText.slice(0, 600)}\n` +
      `Narrative: ${lastAssistantText.slice(0, 1500)}`;
    const rawText = await completeWithRegistry(ctx, model, {
      systemPrompt,
      userPrompt,
      maxTokens: 700,
      signal: ctx.signal,
    });
    if (!rawText) return 0;

    const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
    if (!jsonMatch) return 0;
    const parsed = JSON.parse(jsonMatch[0]!) as {
      location?: string | null;
      presentNpcs?: string[] | null;
      worldTimeLabel?: string | null;
      facts?: Array<{ statement?: string; entities?: string[]; public?: boolean }>;
      invalidatedFactIds?: Array<{ id?: string; reason?: string }>;
      beliefs?: Array<{ actorId?: string; target?: string; activatingEvent?: string; belief?: string }>;
      foresights?: Array<{ summary?: string; triggerHint?: string; entities?: string[] }>;
      cfsm?: Array<{ actorId?: string; axis?: string; to?: string; reason?: string }>;
      stats?: Array<{ actorId?: string; key?: string; op?: "set" | "add"; value?: number | string | boolean; reason?: string }>;
      inventory?: Array<{ actorId?: string; item?: string; delta?: number; note?: string }>;
      clocks?: Array<{ clockId?: string; label?: string; delta?: number; max?: number }>;
    };

    let committed = 0;
    const commit = (tx: RpTxEntry) => {
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    };

    // 1. Spatio-temporal updates (location / presentNpcs / worldTimeLabel)
    const nextLocation = typeof parsed.location === "string" && parsed.location.trim() ? parsed.location.trim() : null;
    const nextPresent = Array.isArray(parsed.presentNpcs)
      ? parsed.presentNpcs.map((x) => String(x).trim()).filter(Boolean)
      : null;
    if (
      (nextLocation && nextLocation !== state.location) ||
      (nextPresent && nextPresent.join("|") !== state.presentNpcs.join("|"))
    ) {
      commit({
        kind: "location_set",
        location: nextLocation ?? state.location,
        presentNpcs: nextPresent ?? state.presentNpcs,
      });
    }

    if (
      typeof parsed.worldTimeLabel === "string" &&
      parsed.worldTimeLabel.trim() &&
      parsed.worldTimeLabel.trim() !== state.worldTimeLabel
    ) {
      commit({ kind: "clock_tick", beatDelta: 0, worldTimeLabel: parsed.worldTimeLabel.trim() });
    }

    // 2. Non-destructive invalidation of superseded facts
    for (const inv of parsed.invalidatedFactIds ?? []) {
      const factId = typeof inv.id === "string" ? inv.id.trim() : "";
      if (!factId) continue;
      const existing = state.facts.get(factId);
      if (!existing || existing.validUntilTurn !== null) continue;
      commit({
        kind: "fact_invalidate",
        factId,
        validUntilTurn: state.turn,
        reason: typeof inv.reason === "string" && inv.reason.trim() ? inv.reason.trim() : "superseded",
      });
    }

    // 3. New bi-temporal facts
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
      commit({ kind: "fact_add", fact });
    }

    // 4. DREAM belief shifts
    for (const b of parsed.beliefs ?? []) {
      if (!b.actorId?.trim() || !b.belief?.trim()) continue;
      commit({
        kind: "belief_update",
        actorId: b.actorId.trim(),
        target: b.target?.trim() || "player",
        activatingEvent: b.activatingEvent?.trim() || "recent scene",
        belief: b.belief.trim(),
        turn: state.turn,
      });
    }

    // 5. Foresights
    for (const h of parsed.foresights ?? []) {
      if (!h.summary?.trim()) continue;
      commit({
        kind: "foresight_upsert",
        hook: {
          id: `hook_t${state.turn}_${committed}`,
          summary: h.summary.trim(),
          triggerHint: h.triggerHint?.trim() || "",
          entities: Array.isArray(h.entities) ? h.entities.map(String) : [],
          plantedTurn: state.turn,
          status: "open",
        },
      });
    }

    // 6. CFSM transitions (strictly validated)
    for (const c of parsed.cfsm ?? []) {
      if (!c.actorId?.trim() || !c.axis?.trim() || !c.to?.trim()) continue;
      const check = validateCfsmTransition(state, c.actorId.trim(), c.axis.trim(), c.to.trim());
      if (!check.ok) continue;
      const from = state.cfsmStates[c.actorId.trim()]?.[c.axis.trim()]?.state ?? "initial";
      commit({
        kind: "cfsm_transition",
        actorId: c.actorId.trim(),
        axis: c.axis.trim(),
        from,
        to: c.to.trim(),
        reason: c.reason?.trim() || "sidecar",
        turn: state.turn,
      });
    }

    // 7. Module-gated & bounds-checked stats / inventory / clocks
    if (state.modules.stats) {
      for (const s of parsed.stats ?? []) {
        const actorId = s.actorId?.trim() || "player";
        const key = s.key?.trim();
        if (!key || s.value === undefined) continue;
        const op = s.op === "add" ? "add" : "set";
        const check = computeCheckedStatValue(state, actorId, key, op, s.value);
        if (!check.ok) continue;
        commit({ kind: "stat_patch", actorId, key, op, value: s.value, reason: s.reason?.trim() || "sidecar" });
      }
    }

    if (state.modules.inventory) {
      for (const inv of parsed.inventory ?? []) {
        const actorId = inv.actorId?.trim() || "player";
        const item = inv.item?.trim();
        const delta = typeof inv.delta === "number" ? Math.trunc(inv.delta) : 0;
        if (!item || delta === 0) continue;
        const check = validateInventoryPatch(state, actorId, item, delta);
        if (!check.ok) continue;
        commit({ kind: "inventory_patch", actorId, item, delta, note: inv.note?.trim() || "sidecar" });
      }
    }

    if (state.modules.clocks) {
      for (const ck of parsed.clocks ?? []) {
        const clockId = ck.clockId?.trim();
        const delta = typeof ck.delta === "number" ? Math.trunc(ck.delta) : 0;
        if (!clockId || delta === 0) continue;
        const max = typeof ck.max === "number" && ck.max > 0 ? Math.trunc(ck.max) : state.clocks[clockId]?.max ?? 4;
        commit({ kind: "progress_clock", clockId, label: ck.label?.trim() || clockId, delta, max });
      }
    }

    return committed;
  } catch {
    return 0;
  }
}
