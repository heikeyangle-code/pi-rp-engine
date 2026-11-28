/**
 * Post-turn deterministic settlement (`turn_end`, < 2ms, ONLY on final narrative assistant step)
 * & closed-loop zero-TTFT asynchronous sidecar extractor (`agent_settled` / `agent_end`):
 *
 * v3 Upgrades:
 *  - Uses thinking-safe `extractJsonObject` & `resolveSidecarModel` with `maxTokens: 1100`.
 *  - RoleMemo DualMem extraction: captures both objective world facts AND persona-conditioned
 *    `subjectiveInsight` + `emotionalTone` on character beliefs.
 *  - Auto-closes resolved foresights (`paidOffForesightIds`).
 *  - Fixes private-fact witness bug: includes player persona + present NPCs so player-witnessed
 *    secrets never lock out the player!
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
import { canCompleteWithRegistry, completeWithRegistry, extractJsonObject, resolveSidecarModel } from "./llm-helper.js";
import { computeCheckedStatValue, validateCfsmTransition, validateInventoryPatch } from "./cfsm.js";
import { selectFactsForConflictCheck } from "../memory/bitemporal.js";
import { tickLoreRuntime } from "../memory/graph-ppr.js";
import { evaluateActiveStorylets } from "../context/zone-builder.js";

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
  if (!lastAssistantText.trim()) return 0;

  const model = resolveSidecarModel(ctx, state.sidecarModel);
  if (!canCompleteWithRegistry(ctx, model)) return 0;

  // Snapshot branch leaf & turn BEFORE the async LLM call (ported from dsh-tavern Background Cycle CAS)
  // so late sidecar results NEVER contaminate a rewound/forked/exited branch!
  const startLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
  const startTurn = state.turn;
  const startCardSlug = state.cardSlug;

  const schemaFields: string[] = [
    `"location": string|null`,
    `"presentNpcs": string[]|null`,
    `"worldTimeLabel": string|null`,
    `"sceneObjective": string|null`,
    `"facts": [{"statement":"...","entities":["..."],"public":true}]`,
    `"invalidatedFactIds": [{"id":"...","reason":"..."}]`,
    `"beliefs": [{"actorId":"...","target":"...","activatingEvent":"...","belief":"...","subjectiveInsight":"how this character emotionally interprets it","emotionalTone":"..."}]`,
    `"foresights": [{"summary":"...","triggerHint":"...","entities":["..."]}]`,
    `"paidOffForesightIds": ["hook_id"]`,
    `"completedStoryletIds": ["storylet_id"]`,
    `"newStorylets": [{"title":"...","triggerPrompt":"...","requiredFlags":["..."],"minTurn":number|null}]`,
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
    `You are a silent RP world-state ledger extractor (PDVA + RoleMemo DualMem + QBN Storylets). Extract durable changes established by EITHER the player OR the narrative.\n` +
    `Output ONLY strict JSON with optional fields:\n{${schemaFields.join(", ")}}\n` +
    `- Only include fields that genuinely changed this turn; omit unchanged fields or leave arrays empty.\n` +
    `- If a new development contradicts or supersedes an active fact listed below, include its exact id in invalidatedFactIds.\n` +
    `- If an open foresight listed below was resolved/fulfilled this turn, include its id in paidOffForesightIds.\n` +
    `- If an active Storylet listed below was clearly played out / resolved this turn, include its exact id in completedStoryletIds.\n` +
    `- Only add newStorylets when the narrative plants a concrete deferred turning point or confrontation.\n` +
    `- For beliefs, capture BOTH the objective activatingEvent and the character's persona-conditioned subjectiveInsight.`;

  const conflictCandidates = selectFactsForConflictCheck(
    state,
    `${lastUserText}\n${lastAssistantText}`,
    10,
    15,
  );
  const activeFactsSummary = conflictCandidates
    .map((f) => `[${f.id} | T${f.validFromTurn}] ${f.statement}`)
    .join("\n");

  const openHooksSummary = Array.from(state.foresights.values())
    .filter((h) => h.status === "open")
    .slice(0, 8)
    .map((h) => `[${h.id}] ${h.summary}`)
    .join("\n");

  const activeStoryletsSummary = evaluateActiveStorylets(state)
    .slice(0, 6)
    .map((s) => `[${s.id}] ${s.title}: ${s.triggerPrompt}`)
    .join("\n");

  const contextHeader = [
    `Turn ${state.turn}`,
    state.era || null,
    state.worldTimeLabel || null,
    `Location: ${state.location || "(unset)"}`,
    state.sceneObjective ? `Objective: ${state.sceneObjective}` : null,
    `Present: ${state.presentNpcs.join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join(" | ");

  try {
    const userPrompt =
      `${contextHeader}\n` +
      (activeFactsSummary ? `Active Facts (Recent + Entity-Matched):\n${activeFactsSummary}\n\n` : "") +
      (openHooksSummary ? `Open Foresights:\n${openHooksSummary}\n\n` : "") +
      (activeStoryletsSummary ? `Active Storylets:\n${activeStoryletsSummary}\n\n` : "") +
      `Player (${state.currentPersona.name}): ${lastUserText.slice(0, 700)}\n` +
      `Narrative: ${lastAssistantText.slice(0, 1800)}`;

    const rawText = await completeWithRegistry(ctx, model, {
      systemPrompt,
      userPrompt,
      maxTokens: 1200,
      signal: ctx.signal,
    });
    if (!rawText) return 0;

    const parsed = extractJsonObject<{
      location?: string | null;
      presentNpcs?: string[] | null;
      worldTimeLabel?: string | null;
      sceneObjective?: string | null;
      facts?: Array<{ statement?: string; entities?: string[]; public?: boolean }>;
      invalidatedFactIds?: Array<{ id?: string; reason?: string }>;
      beliefs?: Array<{
        actorId?: string;
        target?: string;
        activatingEvent?: string;
        belief?: string;
        subjectiveInsight?: string;
        emotionalTone?: string;
      }>;
      foresights?: Array<{ summary?: string; triggerHint?: string; entities?: string[] }>;
      paidOffForesightIds?: string[];
      completedStoryletIds?: string[];
      newStorylets?: Array<{ title?: string; triggerPrompt?: string; requiredFlags?: string[]; minTurn?: number | null }>;
      cfsm?: Array<{ actorId?: string; axis?: string; to?: string; reason?: string }>;
      stats?: Array<{ actorId?: string; key?: string; op?: "set" | "add"; value?: number | string | boolean; reason?: string }>;
      inventory?: Array<{ actorId?: string; item?: string; delta?: number; note?: string }>;
      clocks?: Array<{ clockId?: string; label?: string; delta?: number; max?: number }>;
    }>(rawText);
    if (!parsed) return 0;

    // Stale-branch guard: if user exited RP, switched cards, rewound, or moved to another branch while sidecar ran, discard cleanly!
    if (!state.active || state.turn !== startTurn || state.cardSlug !== startCardSlug) {
      return 0;
    }
    if (startLeafId && typeof ctx.sessionManager?.getBranch === "function") {
      const currentBranch = ctx.sessionManager.getBranch();
      if (currentBranch.length > 0 && !currentBranch.some((e) => e.id === startLeafId)) {
        return 0;
      }
    }

    let committed = 0;
    const commit = (tx: RpTxEntry) => {
      pi.appendEntry(RP_ENTRY_TYPE, tx);
      applyRpTx(state, tx);
      committed++;
    };

    // 1. Spatio-temporal updates
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

    if (
      typeof parsed.sceneObjective === "string" &&
      parsed.sceneObjective.trim() &&
      parsed.sceneObjective.trim() !== state.sceneObjective
    ) {
      commit({ kind: "scene_objective_set", objective: parsed.sceneObjective.trim() });
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
        reason: typeof inv.reason === "string" && inv.reason.trim() ? `sidecar:${inv.reason.trim()}` : "sidecar:superseded",
      });
    }

    // 3. New bi-temporal facts (includes both validFromTurn and ingestedAtTurn + eventTimeLabel!)
    for (const f of parsed.facts ?? []) {
      if (!f.statement?.trim()) continue;
      const privateWitnesses = Array.from(new Set([state.currentPersona.name, ...state.presentNpcs].filter(Boolean)));
      const fact: BiTemporalFact = {
        id: `fact_t${state.turn}_${committed}`,
        statement: f.statement.trim(),
        entities: Array.isArray(f.entities) ? f.entities.map(String) : [],
        validFromTurn: state.turn,
        validUntilTurn: null,
        ingestedAtTurn: state.turn,
        eventTimeLabel: state.worldTimeLabel || undefined,
        witnessIds: f.public === false && privateWitnesses.length > 0 ? privateWitnesses : "public",
      };
      commit({ kind: "fact_add", fact });
    }

    // 4. RoleMemo DualMem beliefs & subjective insights
    for (const b of parsed.beliefs ?? []) {
      if (!b.actorId?.trim() || !b.belief?.trim()) continue;
      commit({
        kind: "belief_update",
        id: `belief_t${state.turn}_${committed}`,
        actorId: b.actorId.trim(),
        target: b.target?.trim() || state.currentPersona.name,
        activatingEvent: b.activatingEvent?.trim() || "recent scene",
        belief: b.belief.trim(),
        subjectiveInsight: typeof b.subjectiveInsight === "string" && b.subjectiveInsight.trim() ? b.subjectiveInsight.trim() : undefined,
        emotionalTone: typeof b.emotionalTone === "string" && b.emotionalTone.trim() ? b.emotionalTone.trim() : undefined,
        turn: state.turn,
      });
    }

    // 5. Foresights (plant new + auto-payoff resolved hooks)
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
    for (const hookId of parsed.paidOffForesightIds ?? []) {
      const existing = typeof hookId === "string" ? state.foresights.get(hookId.trim()) : undefined;
      if (existing && existing.status === "open") {
        commit({ kind: "foresight_upsert", hook: { ...existing, status: "paid_off" } });
      }
    }

    // 5b. Storylet completion (auto-applies postEffects!) & dynamic new storylets
    for (const sid of parsed.completedStoryletIds ?? []) {
      const existing = typeof sid === "string" ? state.storylets.get(sid.trim()) : undefined;
      if (existing && existing.status !== "completed") {
        commit({ kind: "storylet_upsert", storylet: { ...existing, status: "completed" } });
      }
    }
    for (const ns of parsed.newStorylets ?? []) {
      if (!ns.title?.trim() || !ns.triggerPrompt?.trim()) continue;
      const gate: Record<string, unknown> = {};
      if (Array.isArray(ns.requiredFlags) && ns.requiredFlags.length > 0) {
        gate.requiredFlags = ns.requiredFlags.map((x) => String(x).trim()).filter(Boolean);
      }
      if (typeof ns.minTurn === "number" && ns.minTurn > 0) {
        gate.minTurn = Math.trunc(ns.minTurn);
      }
      commit({
        kind: "storylet_upsert",
        storylet: {
          id: `st_t${state.turn}_${committed}`,
          title: ns.title.trim(),
          triggerPrompt: ns.triggerPrompt.trim(),
          gate: Object.keys(gate).length > 0 ? (gate as any) : undefined,
          oneTime: true,
          status: "armed",
          createdTurn: state.turn,
        },
      });
    }

    // 6. CFSM transitions (strictly validated against adjacent transitions)
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
        reason: c.reason?.trim() ? `sidecar:${c.reason.trim()}` : "sidecar",
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
        commit({ kind: "stat_patch", actorId, key, op, value: s.value, reason: s.reason?.trim() ? `sidecar:${s.reason.trim()}` : "sidecar" });
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
        commit({ kind: "inventory_patch", actorId, item, delta, note: inv.note?.trim() ? `sidecar:${inv.note.trim()}` : "sidecar" });
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
