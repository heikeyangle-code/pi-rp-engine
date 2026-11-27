/**
 * 6 static RP tools (registered with `defaultActive: false`, activated once when RP mode starts
 * and NEVER mutated mid-session to preserve KV Cache):
 *  1. rp_recall          - Deep gated BM25 + PPR + historical fact archive query
 *  2. rp_roll_check      - True-random crypto.randomInt XdY+mod check against DC
 *  3. rp_state_patch     - Deterministic bounds-checked stat / inventory / location / clock / CFSM patch
 *  4. rp_fact_commit     - Bi-temporal fact add/invalidate, DREAM belief update, Foresight upsert
 *  5. rp_era_advance     - EraGate milestone check & inter-act montage transition
 *  6. rp_npc_deliberate  - On-demand epistemically isolated single-NPC thinking via ctx.modelRegistry.complete
 */

import type {
  BiTemporalFact,
  CompiledCard,
  PiExtensionAPI,
  PiExtensionContext,
  PiToolDefinition,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "../engine/state-replay.js";
import { computeCheckedStatValue, validateCfsmTransition, validateInventoryPatch } from "../engine/cfsm.js";
import { rollDiceCheck } from "../engine/dice.js";
import { evaluateGate, isFactVisibleToActor } from "../engine/gates.js";
import { getActiveFacts, getHistoricalFacts } from "../memory/bitemporal.js";
import { recallLoreWithGraphPpr } from "../memory/graph-ppr.js";

export const RP_TOOL_NAMES = [
  "rp_recall",
  "rp_roll_check",
  "rp_state_patch",
  "rp_fact_commit",
  "rp_era_advance",
  "rp_npc_deliberate",
] as const;

export interface RpToolRuntime {
  pi: PiExtensionAPI;
  getState: () => SessionRpState;
  getCard: () => CompiledCard | null;
  refreshHud: (ctx?: PiExtensionContext) => void;
}

function textResult(text: string, details?: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, isError };
}

export function createRpTools(rt: RpToolRuntime): PiToolDefinition[] {
  const commitTx = (tx: RpTxEntry, ctx?: PiExtensionContext) => {
    const state = rt.getState();
    rt.pi.appendEntry(RP_ENTRY_TYPE, tx);
    applyRpTx(state, tx);
    rt.refreshHud(ctx);
  };

  // 1. rp_recall
  const rpRecall: PiToolDefinition = {
    name: "rp_recall",
    label: "RP Recall",
    description:
      "Deeply search gated worldbook entries (including @@dont_activate entries) and bi-temporal facts (active or historical).",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, character name, item, or event to recall" },
        includeHistoricalFacts: { type: "boolean", description: "Whether to include superseded/invalidated past facts" },
      },
      required: ["query"],
    },
    async execute(_id, params) {
      const state = rt.getState();
      const card = rt.getCard();
      if (!state.active || !card) return textResult("RP mode is not active.", undefined, true);
      const query = String(params.query ?? "").trim();
      if (!query) return textResult("Missing query.", undefined, true);

      const recalled = recallLoreWithGraphPpr({
        entries: card.loreBook.entries,
        state,
        recentText: query,
        tokenBudget: Math.min(state.loreTokenBudget, 1500),
        manualQuery: query,
      });

      const qLower = query.toLowerCase();
      const activeFacts = getActiveFacts(state).filter(
        (f) => f.statement.toLowerCase().includes(qLower) || f.entities.some((e) => e.toLowerCase().includes(qLower)),
      );
      const histFacts = params.includeHistoricalFacts
        ? getHistoricalFacts(state).filter(
            (f) => f.statement.toLowerCase().includes(qLower) || f.entities.some((e) => e.toLowerCase().includes(qLower)),
          )
        : [];

      const lines: string[] = [];
      if (recalled.selected.length > 0) {
        lines.push("## Recalled Lore");
        for (const e of recalled.selected) lines.push(`- [${e.title}] ${e.content}`);
      }
      if (activeFacts.length > 0) {
        lines.push("## Active Facts");
        for (const f of activeFacts) lines.push(`- [T${f.validFromTurn}] ${f.statement}`);
      }
      if (histFacts.length > 0) {
        lines.push("## Historical (Superseded) Facts");
        for (const f of histFacts) lines.push(`- [T${f.validFromTurn}..T${f.validUntilTurn}] ${f.statement}`);
      }

      return textResult(lines.length > 0 ? lines.join("\n") : `No accessible records matched "${query}".`, {
        loreCount: recalled.selected.length,
        factCount: activeFacts.length + histFacts.length,
      });
    },
  };

  // 2. rp_roll_check
  const rpRollCheck: PiToolDefinition = {
    name: "rp_roll_check",
    label: "Dice Check",
    description: "Roll true-random dice (e.g. 1d20+3, 2d6, 1d100) with optional stat modifier and DC.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Dice expression such as 1d20, 1d20+3, 2d6, 1d100" },
        reason: { type: "string", description: "What action is being checked" },
        actorId: { type: "string", description: "Optional actor whose numeric stat adds as modifier" },
        statKey: { type: "string", description: "Optional numeric stat key to add to roll" },
        dc: { type: "number", description: "Optional Difficulty Class threshold" },
      },
      required: ["expression"],
    },
    async execute(_id, params) {
      const state = rt.getState();
      const expr = String(params.expression ?? "1d20");
      const actorId = typeof params.actorId === "string" ? params.actorId : undefined;
      const statKey = typeof params.statKey === "string" ? params.statKey : undefined;
      const dc = typeof params.dc === "number" ? params.dc : undefined;
      const reason = typeof params.reason === "string" ? params.reason : "";

      let statBonus = 0;
      if (actorId && statKey) {
        const raw = state.stats[actorId]?.[statKey];
        if (typeof raw === "number") statBonus = raw;
      }

      try {
        const res = rollDiceCheck({ expression: expr, extraModifier: statBonus, dc });
        const verdict =
          res.success === undefined
            ? ""
            : res.critical === "nat_max"
              ? " → CRITICAL SUCCESS"
              : res.critical === "nat_min"
                ? " → CRITICAL FAILURE"
                : res.success
                  ? ` → SUCCESS (vs DC ${dc})`
                  : ` → FAILURE (vs DC ${dc})`;
        const summary = `🎲 ${reason ? `${reason}: ` : ""}${res.expression} = [${res.rolls.join(", ")}]${res.modifier ? (res.modifier > 0 ? `+${res.modifier}` : `${res.modifier}`) : ""} = ${res.total}${verdict}`;
        return textResult(summary, res);
      } catch (err) {
        return textResult((err as Error).message, undefined, true);
      }
    },
  };

  // 3. rp_state_patch
  const rpStatePatch: PiToolDefinition = {
    name: "rp_state_patch",
    label: "State Patch",
    description:
      "Deterministically update L1 world state: stats (with min/max clamp), inventory (non-negative), location/presentNpcs, progress clocks, flags, or CFSM state.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["stat", "inventory", "location", "clock", "flag", "cfsm"],
        },
        actorId: { type: "string" },
        key: { type: "string" },
        op: { type: "string", enum: ["set", "add"] },
        value: {},
        min: { type: "number" },
        max: { type: "number" },
        item: { type: "string" },
        delta: { type: "number" },
        location: { type: "string" },
        presentNpcs: { type: "array", items: { type: "string" } },
        clockId: { type: "string" },
        label: { type: "string" },
        axis: { type: "string" },
        to: { type: "string" },
        reason: { type: "string" },
      },
      required: ["kind"],
    },
    async execute(_id, params, _sig, _upd, ctx) {
      const state = rt.getState();
      if (!state.active) return textResult("RP mode is not active.", undefined, true);
      const kind = String(params.kind);
      const actorId = String(params.actorId ?? "player");
      const reason = typeof params.reason === "string" ? params.reason : "";

      if (kind === "stat") {
        const key = String(params.key ?? "").trim();
        if (!key) return textResult("stat patch requires key", undefined, true);
        const op = params.op === "add" ? "add" : "set";
        const val = params.value as number | string | boolean;
        const min = typeof params.min === "number" ? params.min : undefined;
        const max = typeof params.max === "number" ? params.max : undefined;
        const check = computeCheckedStatValue(state, actorId, key, op, val, min, max);
        if (!check.ok) return textResult(check.error!, undefined, true);
        commitTx({ kind: "stat_patch", actorId, key, op, value: val, min, max, reason }, ctx);
        return textResult(`Updated ${actorId}.${key} = ${check.clampedValue}`, { actorId, key, value: check.clampedValue });
      }

      if (kind === "inventory") {
        const item = String(params.item ?? "").trim();
        const delta = Number(params.delta ?? 0);
        const check = validateInventoryPatch(state, actorId, item, delta);
        if (!check.ok) return textResult(check.error!, undefined, true);
        commitTx({ kind: "inventory_patch", actorId, item, delta, note: reason }, ctx);
        return textResult(`Inventory ${actorId}: ${item} ${delta > 0 ? `+${delta}` : delta} (now ${check.clampedValue})`, {
          actorId,
          item,
          count: check.clampedValue,
        });
      }

      if (kind === "location") {
        const location = String(params.location ?? "").trim();
        const presentNpcs = Array.isArray(params.presentNpcs) ? params.presentNpcs.map(String) : state.presentNpcs;
        commitTx({ kind: "location_set", location, presentNpcs }, ctx);
        return textResult(`Location → ${location} (present: ${presentNpcs.join(", ") || "none"})`);
      }

      if (kind === "clock") {
        const clockId = String(params.clockId ?? "").trim();
        if (!clockId) return textResult("clock patch requires clockId", undefined, true);
        const label = String(params.label ?? clockId);
        const delta = Number(params.delta ?? 1);
        const max = Number(params.max ?? state.clocks[clockId]?.max ?? 4);
        commitTx({ kind: "progress_clock", clockId, label, delta, max }, ctx);
        const updated = state.clocks[clockId]!;
        return textResult(`Clock "${updated.label}": ${updated.value}/${updated.max}${updated.completed ? " [COMPLETED]" : ""}`);
      }

      if (kind === "flag") {
        const flag = String(params.key ?? "").trim();
        if (!flag) return textResult("flag patch requires key", undefined, true);
        commitTx({ kind: "flag_set", flag, value: Boolean(params.value) }, ctx);
        return textResult(`Flag ${flag} = ${Boolean(params.value)}`);
      }

      if (kind === "cfsm") {
        const axis = String(params.axis ?? "").trim();
        const to = String(params.to ?? "").trim();
        if (!axis || !to) return textResult("cfsm patch requires axis and to", undefined, true);
        const check = validateCfsmTransition(state, actorId, axis, to);
        if (!check.ok) return textResult(check.error!, undefined, true);
        const from = state.cfsmStates[actorId]?.[axis]?.state ?? "initial";
        commitTx({ kind: "cfsm_transition", actorId, axis, from, to, reason, turn: state.turn }, ctx);
        return textResult(`CFSM ${actorId}.${axis}: ${from} → ${to}`);
      }

      return textResult(`Unknown state patch kind "${kind}"`, undefined, true);
    },
  };

  // 4. rp_fact_commit
  const rpFactCommit: PiToolDefinition = {
    name: "rp_fact_commit",
    label: "Commit Fact / Foresight",
    description: "Add/invalidate a bi-temporal fact, record a DREAM character belief shift, or upsert a foresight hook.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_fact", "invalidate_fact", "belief", "foresight"] },
        id: { type: "string" },
        statement: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        witnessIds: {},
        supersededBy: { type: "string" },
        reason: { type: "string" },
        actorId: { type: "string" },
        target: { type: "string" },
        activatingEvent: { type: "string" },
        belief: { type: "string" },
        triggerHint: { type: "string" },
        status: { type: "string", enum: ["open", "paid_off", "expired"] },
      },
      required: ["action"],
    },
    async execute(_id, params, _sig, _upd, ctx) {
      const state = rt.getState();
      if (!state.active) return textResult("RP mode is not active.", undefined, true);
      const action = String(params.action);

      if (action === "add_fact") {
        const statement = String(params.statement ?? "").trim();
        if (!statement) return textResult("add_fact requires statement", undefined, true);
        const id = String(params.id ?? `fact_t${state.turn}_${state.facts.size + 1}`);
        const entities = Array.isArray(params.entities) ? params.entities.map(String) : [];
        const witnessIds: string[] | "public" =
          params.witnessIds === "public" || params.witnessIds === undefined
            ? "public"
            : Array.isArray(params.witnessIds)
              ? params.witnessIds.map(String)
              : "public";
        const fact: BiTemporalFact = {
          id,
          statement,
          entities,
          validFromTurn: state.turn,
          validUntilTurn: null,
          witnessIds,
        };
        commitTx({ kind: "fact_add", fact }, ctx);
        return textResult(`Committed fact [${id}]: ${statement}`);
      }

      if (action === "invalidate_fact") {
        const factId = String(params.id ?? "").trim();
        if (!factId || !state.facts.has(factId)) return textResult(`Fact "${factId}" not found`, undefined, true);
        commitTx(
          {
            kind: "fact_invalidate",
            factId,
            validUntilTurn: state.turn,
            supersededBy: typeof params.supersededBy === "string" ? params.supersededBy : undefined,
            reason: String(params.reason ?? "superseded"),
          },
          ctx,
        );
        return textResult(`Invalidated fact [${factId}] at turn ${state.turn}`);
      }

      if (action === "belief") {
        const actorId = String(params.actorId ?? "").trim();
        const target = String(params.target ?? "player").trim();
        const activatingEvent = String(params.activatingEvent ?? "").trim();
        const belief = String(params.belief ?? "").trim();
        if (!actorId || !belief) return textResult("belief requires actorId and belief", undefined, true);
        commitTx({ kind: "belief_update", actorId, target, activatingEvent, belief, turn: state.turn }, ctx);
        return textResult(`Recorded belief update: ${actorId} → ${target}: ${belief}`);
      }

      if (action === "foresight") {
        const summary = String(params.statement ?? "").trim();
        if (!summary) return textResult("foresight requires statement", undefined, true);
        const id = String(params.id ?? `hook_t${state.turn}_${state.foresights.size + 1}`);
        const status =
          params.status === "paid_off" || params.status === "expired" ? params.status : "open";
        commitTx(
          {
            kind: "foresight_upsert",
            hook: {
              id,
              summary,
              entities: Array.isArray(params.entities) ? params.entities.map(String) : [],
              plantedTurn: state.foresights.get(id)?.plantedTurn ?? state.turn,
              triggerHint: String(params.triggerHint ?? ""),
              status,
            },
          },
          ctx,
        );
        return textResult(`Foresight [${id}] (${status}): ${summary}`);
      }

      return textResult(`Unknown action "${action}"`, undefined, true);
    },
  };

  // 5. rp_era_advance
  const rpEraAdvance: PiToolDefinition = {
    name: "rp_era_advance",
    label: "Advance Era",
    description: "Advance the world to a new Era/Act, unlocking milestone-gated lore and recording a montage summary.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        toEra: { type: "string", description: "Target era/act name" },
        milestoneUnlocked: { type: "array", items: { type: "string" } },
        montageSummary: { type: "string" },
        requiredFlags: { type: "array", items: { type: "string" } },
      },
      required: ["toEra"],
    },
    async execute(_id, params, _sig, _upd, ctx) {
      const state = rt.getState();
      if (!state.active) return textResult("RP mode is not active.", undefined, true);
      const toEra = String(params.toEra ?? "").trim();
      if (!toEra) return textResult("toEra is required", undefined, true);

      const reqFlags = Array.isArray(params.requiredFlags) ? params.requiredFlags.map(String) : undefined;
      if (reqFlags && !evaluateGate({ requiredFlags: reqFlags }, state)) {
        return textResult(`Era gate blocked: required flags [${reqFlags.join(", ")}] not satisfied`, undefined, true);
      }

      const milestones = Array.isArray(params.milestoneUnlocked) ? params.milestoneUnlocked.map(String) : [];
      const montageSummary = String(params.montageSummary ?? "");
      const fromEra = state.era;
      commitTx({ kind: "era_advance", fromEra, toEra, milestoneUnlocked: milestones, montageSummary, turn: state.turn }, ctx);
      return textResult(`Era advanced: ${fromEra} → ${toEra}${milestones.length ? ` (unlocked: ${milestones.join(", ")})` : ""}`);
    },
  };

  // 6. rp_npc_deliberate (on-demand epistemically isolated single-NPC thinking)
  const rpNpcDeliberate: PiToolDefinition = {
    name: "rp_npc_deliberate",
    label: "NPC Deliberate (Isolated)",
    description:
      "ONLY for strict hidden-information / mystery / scheming moments: runs a short isolated thought for one NPC using ONLY facts visible to that NPC.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        npcName: { type: "string", description: "The NPC who is privately deliberating" },
        situation: { type: "string", description: "What the NPC currently observes (NO player secrets!)" },
      },
      required: ["npcName", "situation"],
    },
    async execute(_id, params, _sig, _upd, ctx) {
      const state = rt.getState();
      if (!state.active) return textResult("RP mode is not active.", undefined, true);
      const npcName = String(params.npcName ?? "").trim();
      const situation = String(params.situation ?? "").trim();
      if (!npcName || !situation) return textResult("npcName and situation are required", undefined, true);

      const visibleFacts = getActiveFacts(state)
        .filter((f) => isFactVisibleToActor(f, npcName))
        .slice(0, 12)
        .map((f) => `- ${f.statement}`);
      const npcBeliefs = state.beliefs
        .filter((b) => b.actorId.toLowerCase() === npcName.toLowerCase())
        .slice(-5)
        .map((b) => `- About ${b.target}: ${b.belief} (because: ${b.activatingEvent})`);

      if (!ctx?.modelRegistry?.complete || !ctx.model) {
        return textResult(
          `[Isolated Epistemic Slice for ${npcName}]\nKnown facts (${visibleFacts.length}):\n${visibleFacts.join("\n") || "(none)"}\nBeliefs:\n${npcBeliefs.join("\n") || "(none)"}`,
        );
      }

      try {
        const resp = await ctx.modelRegistry.complete(ctx.model, {
          systemPrompt: `You are ${npcName} thinking privately. You ONLY know the facts listed below and have ZERO knowledge of anything the player did out of your sight. Respond in 2-4 concise sentences with your private assessment and immediate intention.`,
          messages: [
            {
              role: "user",
              content: `Known facts:\n${visibleFacts.join("\n") || "(none)"}\n\nYour beliefs:\n${npcBeliefs.join("\n") || "(none)"}\n\nWhat you see right now:\n${situation}`,
            },
          ],
        });
        const thought =
          resp?.text ??
          resp?.content
            ?.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("") ??
          "(no private deliberation returned)";
        return textResult(`[${npcName} Private Intent]\n${thought.trim()}`);
      } catch (err) {
        return textResult(`Deliberation fallback for ${npcName}: ${(err as Error).message}`);
      }
    },
  };

  return [rpRecall, rpRollCheck, rpStatePatch, rpFactCommit, rpEraAdvance, rpNpcDeliberate];
}
