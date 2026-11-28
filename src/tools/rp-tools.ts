/**
 * Seven RP-exclusive tools registered with `defaultActive: false` (0 tokens in dormant coding sessions).
 * All tools include narrative `renderCall` / `renderResult` TUI micro-cards and operate strictly
 * through deterministic L1 event sourcing (`rp:tx`).
 */

import type {
  BiTemporalFact,
  CompiledCard,
  CompiledLoreEntry,
  PhysicalSnapshot,
  PiExtensionAPI,
  PiToolDefinition,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "../engine/state-replay.js";
import { rollDiceCheck } from "../engine/dice.js";
import { computeCalendarAnchor, detectLifespanProfile } from "../engine/temporal.js";
import { computeCheckedStatValue, resolveCanonicalStatKey, validateCfsmTransition, validateInventoryPatch } from "../engine/cfsm.js";
import { recallLoreWithGraphPpr, tokenizeHybrid } from "../memory/graph-ppr.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import {
  type HistoryRecallCooldown,
  type HistoryRecallTurnScope,
  createTurnRecallScope,
  extractCommittedRounds,
  recallHistory,
  renderHistoryRecall,
} from "../memory/history-recall.js";
import { rankBySemanticSimilarity, reciprocalRankFusion } from "../memory/embedding.js";
import { loadUiPrefs } from "../ui/file-picker.js";
import { evaluateGate, isFactVisibleToActor } from "../engine/gates.js";
import { createLinesComponent, styleBold, styleDim, styleFg, wrapDisplayLine } from "../ui/renderers.js";

export const RP_TOOL_NAMES = [
  "rp_roll_check",
  "rp_state_patch",
  "rp_fact_commit",
  "rp_recall",
  "rp_history_recall",
  "rp_era_advance",
  "rp_npc_deliberate",
] as const;

export interface RpToolRuntime {
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  commitTx(tx: RpTxEntry): void;
  refreshHud(ctx?: any): void;
  getHistoryRecallScope?(): HistoryRecallTurnScope;
  getHistoryRecallCooldowns?(): HistoryRecallCooldown[];
  setHistoryRecallCooldowns?(next: HistoryRecallCooldown[]): void;
}

type ExtendedPiToolDefinition = PiToolDefinition & {
  executionMode?: "sequential" | "parallel";
  annotations?: { readOnlyHint?: boolean };
};

function registerExtendedTool(pi: PiExtensionAPI, tool: ExtendedPiToolDefinition): void {
  pi.registerTool({
    prepareArguments: (args) => unwrapNestedArgs(args),
    ...tool,
  });
}

/**
 * Unwrap DeepSeek / OpenAI-compatible vLLM proxy quirk where tool arguments arrive
 * nested as `{ arguments: "{\"action\":\"read\"...}" }` or `{ arguments: { ... } }`.
 */
export function unwrapNestedArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  let current = raw as Record<string, unknown>;
  for (let depth = 0; depth < 2; depth++) {
    const keys = Object.keys(current);
    if (keys.length !== 1 || keys[0] !== "arguments") break;
    const inner = current.arguments;
    if (typeof inner === "string") {
      const trimmed = inner.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            current = parsed as Record<string, unknown>;
            continue;
          }
        } catch {
          break;
        }
      }
      break;
    }
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      current = inner as Record<string, unknown>;
      continue;
    }
    break;
  }
  return current;
}

/** Monotonic module-level sequence counter so multiple `rp_fact_commit` calls in the same turn never collide. */
let nextCommitSeq = 0;

function allocateUniqueId(prefix: string, turn: number, existing: Map<string, unknown>): string {
  let candidate = `${prefix}_t${turn}_${nextCommitSeq++}`;
  while (existing.has(candidate)) {
    candidate = `${prefix}_t${turn}_${nextCommitSeq++}`;
  }
  return candidate;
}

/** Create a lightweight staging clone of the mutable state slices touched by `rp_state_patch` for two-phase validation. */
function cloneStagingState(state: SessionRpState): SessionRpState {
  const stats: SessionRpState["stats"] = {};
  for (const [actor, rec] of Object.entries(state.stats)) {
    stats[actor] = { ...rec };
  }
  const statBounds: SessionRpState["statBounds"] = {};
  for (const [actor, rec] of Object.entries(state.statBounds)) {
    statBounds[actor] = {};
    for (const [k, b] of Object.entries(rec)) {
      statBounds[actor]![k] = { ...b };
    }
  }
  const inventory: SessionRpState["inventory"] = {};
  for (const [actor, rec] of Object.entries(state.inventory)) {
    inventory[actor] = { ...rec };
  }
  const cfsmDefs: SessionRpState["cfsmDefs"] = {};
  for (const [actor, rec] of Object.entries(state.cfsmDefs)) {
    cfsmDefs[actor] = { ...rec };
  }
  const cfsmStates: SessionRpState["cfsmStates"] = {};
  for (const [actor, rec] of Object.entries(state.cfsmStates)) {
    cfsmStates[actor] = {};
    for (const [axis, s] of Object.entries(rec)) {
      cfsmStates[actor]![axis] = { ...s };
    }
  }
  const clocks: SessionRpState["clocks"] = {};
  for (const [cid, c] of Object.entries(state.clocks)) {
    clocks[cid] = { ...c };
  }
  const physicalState: SessionRpState["physicalState"] = {};
  for (const [actor, snap] of Object.entries(state.physicalState)) {
    physicalState[actor] = { ...snap };
  }

  return {
    ...state,
    presentNpcs: [...state.presentNpcs],
    flags: { ...state.flags },
    conditions: { ...state.conditions },
    storylets: new Map(state.storylets),
    milestones: new Set(state.milestones),
    foresights: new Map(state.foresights),
    npcAgendas: { ...state.npcAgendas },
    pairBonds: { ...state.pairBonds },
    beliefs: [...state.beliefs],
    stats,
    statBounds,
    inventory,
    cfsmDefs,
    cfsmStates,
    clocks,
    physicalState,
    auditLog: [...state.auditLog],
  };
}

function getAllLoreEntries(rt: RpToolRuntime): CompiledLoreEntry[] {
  const primary = rt.getCard();
  if (!primary) return [];
  const list: CompiledLoreEntry[] = [...primary.loreBook.entries];
  for (const extra of rt.getExtraCastCards()) {
    list.push(...extra.loreBook.entries);
  }
  return list;
}

export function registerRpTools(pi: PiExtensionAPI, rt: RpToolRuntime): void {
  // 1. rp_roll_check
  registerExtendedTool(pi, {
    name: "rp_roll_check",
    label: "RP 掷骰检定",
    description:
      "Deterministic dice/skill check ('1d20', '1d20+3', '2d20kh1', '2d6', '1d100'). Call BEFORE narrating risky/uncertain/contested actions; optionally pass stat_key to auto-add character stat bonus.",
    promptSnippet: "Roll dice for risky/uncertain skill, stealth, persuasion, or combat checks.",
    defaultActive: false,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Dice formula, e.g. '1d20', '1d20+3', '2d20kh1', '1d100'" },
        dc: { type: "number", description: "Optional target DC" },
        reason: { type: "string", description: "Action attempted" },
        actor: { type: "string", description: "Actor name" },
        stat_key: { type: "string", description: "Optional stat name to auto-lookup bonus from ledger (e.g. '敏捷', '魅力')" },
      },
      required: ["expression"],
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      const expr = String(args.expression ?? "1d20");
      const dc = typeof args.dc === "number" ? ` vs DC ${args.dc}` : "";
      const reason = args.reason ? ` · ${String(args.reason)}` : "";
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "🎲 检定")} ${styleBold(theme, expr)}${dc}${styleDim(theme, reason)}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as {
        expression?: string;
        total?: number;
        dc?: number;
        success?: boolean;
        critical?: "nat_max" | "nat_min" | null;
        rolls?: number[];
        keptRolls?: number[];
        reason?: string;
      };
      if (result.isError || typeof d.total !== "number") {
        const msg = result.content?.[0] && "text" in result.content[0] ? String(result.content[0].text) : "检定失败";
        return createLinesComponent(() => [styleFg(theme, "error", `🎲 ${msg}`)]);
      }
      const badge =
        d.critical === "nat_max"
          ? { label: "大成功 ★", color: "success" }
          : d.critical === "nat_min"
            ? { label: "大失败 ✖", color: "error" }
            : d.success === true
              ? { label: "成功 ✓", color: "success" }
              : d.success === false
                ? { label: "失败 ✗", color: "warning" }
                : null;
      const rollsStr = d.rolls ? `[${d.rolls.join(",")}]` : "";
      const summary =
        `${styleFg(theme, "accent", "🎲")} ${d.expression ?? ""} → ${styleBold(theme, String(d.total))} ${styleDim(theme, rollsStr)}` +
        (d.dc !== undefined ? ` / DC ${d.dc}` : "") +
        (badge ? ` · ${styleFg(theme, badge.color, badge.label)}` : "");
      return createLinesComponent(() => [summary]);
    },
    async execute(_id, rawParams, _sig, _onUpdate, ctx) {
      const params = unwrapNestedArgs(rawParams);
      let expr = String(params.expression ?? "1d20").trim();
      const dc = typeof params.dc === "number" ? params.dc : undefined;
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      const actor = typeof params.actor === "string" ? params.actor : undefined;
      const statKey = typeof params.stat_key === "string" && params.stat_key.trim() ? params.stat_key.trim() : undefined;
      let statBonus: number | undefined;

      const curState = rt.getState();
      if (statKey && curState.active) {
        const targetKey = statKey.toLowerCase();
        const actorPools = actor
          ? Object.entries(curState.stats).filter(([a]) => a.toLowerCase() === actor.toLowerCase())
          : Object.entries(curState.stats);
        for (const [, statsMap] of actorPools.length > 0 ? actorPools : Object.entries(curState.stats)) {
          for (const [k, v] of Object.entries(statsMap)) {
            if (k.toLowerCase() === targetKey && typeof v === "number" && Number.isFinite(v)) {
              statBonus = Math.trunc(v);
              break;
            }
          }
          if (statBonus !== undefined) break;
        }
        // Append stat bonus automatically when formula does not already carry an explicit +/- modifier
        if (statBonus !== undefined && statBonus !== 0 && !/[+-]\s*\d+\s*$/.test(expr)) {
          expr = `${expr}${statBonus > 0 ? "+" : ""}${statBonus}`;
        }
      }

      try {
        const res = rollDiceCheck({ expression: expr, dc });
        const outcomeLabel =
          res.critical === "nat_max"
            ? "CRITICAL_SUCCESS"
            : res.critical === "nat_min"
              ? "CRITICAL_FAILURE"
              : res.success === true
                ? "SUCCESS"
                : res.success === false
                  ? "FAILURE"
                  : null;
        if (curState.active) {
          rt.commitTx({
            kind: "roll_record",
            roll: {
              turn: curState.turn,
              actor,
              expression: res.expression,
              statKey,
              statBonus,
              rolls: res.rolls,
              keptRolls: res.keptRolls,
              modifier: res.modifier,
              total: res.total,
              dc,
              success: res.success,
              critical: res.critical ?? null,
              reason,
              source: "tool",
            },
          });
          rt.refreshHud(ctx);
        }
        const outcomeText = outcomeLabel ? ` -> ${outcomeLabel}${dc !== undefined ? ` (DC ${dc})` : ""}` : "";
        const keptInfo =
          res.keptRolls.length !== res.rolls.length ? ` kept [${res.keptRolls.join(", ")}]` : "";
        const statInfo = statKey && statBonus !== undefined ? ` [stat ${statKey} ${statBonus >= 0 ? "+" : ""}${statBonus}]` : "";
        const summary = `Roll ${res.expression}${statInfo}${actor ? ` [${actor}]` : ""}${reason ? ` (${reason})` : ""}: rolls [${res.rolls.join(", ")}]${keptInfo}${res.modifier ? ` ${res.modifier >= 0 ? "+" : ""}${res.modifier}` : ""} = ${res.total}${outcomeText}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { ...res, actor, reason, statKey, statBonus },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid dice expression: ${(err as Error).message}` }],
        };
      }
    },
  });

  // 2. rp_state_patch
  registerExtendedTool(pi, {
    name: "rp_state_patch",
    label: "RP 状态账本更新",
    description:
      "Atomically update world state (location, NPCs, scene objective, time label, stats, inventory, flags, clocks, CFSM, physical/spatial notes).",
    promptSnippet: "Patch world stats, inventory, location, objective, time, flags, clocks, CFSM.",
    defaultActive: false,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Scene location" },
        present_npcs: { type: "array", items: { type: "string" }, description: "Present NPC names" },
        scene_objective: { type: "string", description: "Current scene objective (empty string to clear)" },
        world_time_label: { type: "string", description: "Updated in-world time label (e.g. '次日清晨', '夜半')" },
        day_delta: { type: "integer", description: "Optional non-negative day increment when advancing calendar days" },
        delete_clocks: { type: "array", items: { type: "string" }, description: "Clock IDs to remove after resolution" },
        stats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              key: { type: "string" },
              op: { type: "string", enum: ["set", "add"] },
              value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }], description: "Number, string, or boolean" },
              min: { type: "number" },
              max: { type: "number" },
              reason: { type: "string" },
            },
            required: ["actor", "key", "op", "value"],
          },
        },
        inventory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              item: { type: "string" },
              delta: { type: "number" },
              note: { type: "string" },
            },
            required: ["actor", "item", "delta"],
          },
        },
        flags: {
          type: "object",
          additionalProperties: { type: "boolean" },
          description: "Boolean flags map",
        },
        clocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              clockId: { type: "string" },
              label: { type: "string" },
              delta: { type: "number" },
              max: { type: "number" },
              on_complete_flags: {
                type: "object",
                additionalProperties: { type: "boolean" },
                description: "Optional flags auto-set when this clock fills",
              },
              on_complete_storylet: {
                type: "string",
                description: "Optional storylet ID auto-triggered when this clock fills",
              },
            },
            required: ["clockId", "delta"],
          },
        },
        conditions: {
          type: "array",
          description: "Add or remove timed/persistent Buff/Debuff conditions (e.g. poisoned, bleeding, disguised)",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              label: { type: "string" },
              action: { type: "string", enum: ["add", "remove"] },
              effect: { type: "string" },
              duration_turns: { type: "number", description: "Omit or null for persistent until cured" },
            },
            required: ["actor", "label"],
          },
        },
        storylets: {
          type: "array",
          description: "Create or update condition-gated Storylets (deferred plot beats / quests / confrontations)",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              trigger_prompt: { type: "string", description: "What happens when this Storylet triggers" },
              required_flags: { type: "array", items: { type: "string" } },
              min_turn: { type: "number" },
              post_flags: { type: "object", additionalProperties: { type: "boolean" } },
              next_objective: { type: "string" },
            },
            required: ["title", "trigger_prompt"],
          },
        },
        completed_storylets: {
          type: "array",
          items: { type: "string" },
          description: "IDs of active Storylets that were resolved/completed this turn (auto-applies postEffects)",
        },
        define_cfsm: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              axis: { type: "string" },
              states: { type: "array", items: { type: "string" } },
              initial: { type: "string" },
              transitions: {
                type: "object",
                additionalProperties: { type: "array", items: { type: "string" } },
                description: "Allowed transitions map",
              },
            },
            required: ["actor", "axis", "states", "initial"],
          },
        },
        cfsm: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              axis: { type: "string" },
              to: { type: "string" },
              reason: { type: "string" },
            },
            required: ["actor", "axis", "to"],
          },
        },
        physical: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              attire: { type: "string" },
              condition: { type: "string" },
              holding: { type: "string" },
              position: { type: "string" },
            },
            required: ["actor"],
          },
        },
        spatial_notes: { type: "string", description: "Layout/visibility/occlusion notes" },
      },
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      const tags: string[] = [];
      if (typeof args.location === "string") tags.push(`地点→${args.location}`);
      if (Array.isArray(args.stats) && args.stats.length > 0) tags.push(`数值×${args.stats.length}`);
      if (Array.isArray(args.inventory) && args.inventory.length > 0) tags.push(`物品×${args.inventory.length}`);
      if (Array.isArray(args.clocks) && args.clocks.length > 0) tags.push(`时钟×${args.clocks.length}`);
      if (Array.isArray(args.cfsm) && args.cfsm.length > 0) tags.push(`心态×${args.cfsm.length}`);
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "✦ 状态账本")} ${styleDim(theme, tags.join(" · ") || "更新状态")}`,
      ]);
    },
    renderResult(result, options, theme) {
      const d = (result.details ?? {}) as { applied?: string[]; rejected?: string[] };
      const applied = d.applied ?? [];
      const rejected = d.rejected ?? [];
      return createLinesComponent((width) => {
        const summary = applied.length > 0 ? applied.join(" | ") : "无状态变更";
        const lines = wrapDisplayLine(`✦ 状态已更新: ${summary}`, Math.max(24, width - 2)).map((l, idx) =>
          idx === 0 ? styleFg(theme, "success", l) : styleDim(theme, `  ${l}`),
        );
        if (rejected.length > 0 && options?.expanded) {
          lines.push(styleFg(theme, "warning", `  ⚠ 拒绝: ${rejected.join("; ")}`));
        }
        return lines;
      });
    },
    async execute(_id, rawParams, _sig, _onUpdate, ctx) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }

      // Phase 1: Validate all operations against a staging copy before committing any `rp:tx`
      const staging = cloneStagingState(state);
      const pendingTxs: RpTxEntry[] = [];
      const applied: string[] = [];
      const rejected: string[] = [];

      const stageTx = (tx: RpTxEntry, summary: string) => {
        applyRpTx(staging, tx);
        pendingTxs.push(tx);
        applied.push(summary);
      };

      if (typeof params.location === "string" || Array.isArray(params.present_npcs)) {
        const loc = typeof params.location === "string" ? params.location : staging.location;
        const npcs = Array.isArray(params.present_npcs) ? params.present_npcs.map(String) : staging.presentNpcs;
        stageTx(
          { kind: "location_set", location: loc, presentNpcs: npcs },
          `location=${loc}${npcs.length ? ` [${npcs.join(", ")}]` : ""}`,
        );
      }

      if (typeof params.scene_objective === "string") {
        stageTx({ kind: "scene_objective_set", objective: params.scene_objective.trim() }, `objective=${params.scene_objective.trim() || "(cleared)"}`);
      }

      if (typeof params.world_time_label === "string" || (typeof params.day_delta === "number" && params.day_delta > 0)) {
        const dayDelta = typeof params.day_delta === "number" && Number.isFinite(params.day_delta) ? Math.max(0, Math.round(params.day_delta)) : 0;
        stageTx(
          {
            kind: "clock_tick",
            beatDelta: 0,
            dayDelta,
            worldTimeLabel: typeof params.world_time_label === "string" && params.world_time_label.trim() ? params.world_time_label.trim() : undefined,
          },
          `time=${typeof params.world_time_label === "string" ? params.world_time_label.trim() : `+${dayDelta}d`}`,
        );
      }

      if (Array.isArray(params.delete_clocks)) {
        for (const cid of params.delete_clocks) {
          const cleanId = String(cid ?? "").trim();
          if (cleanId) {
            stageTx({ kind: "clock_delete", clockId: cleanId }, `clock.del(${cleanId})`);
          }
        }
      }

      if (Array.isArray(params.stats)) {
        for (const s of params.stats as Array<Record<string, unknown>>) {
          const actorId = String(s.actor ?? "player");
          const rawKey = String(s.key ?? "");
          const key = resolveCanonicalStatKey(staging, actorId, rawKey);
          const op = s.op === "add" ? "add" : "set";
          const val = s.value as number | string | boolean;
          const min = typeof s.min === "number" ? s.min : undefined;
          const max = typeof s.max === "number" ? s.max : undefined;
          if (!key) continue;
          const checked = computeCheckedStatValue(staging, actorId, key, op, val, min, max);
          if (!checked.ok) {
            rejected.push(`${actorId}.${key}: ${checked.error ?? "invalid"}`);
            continue;
          }
          stageTx(
            {
              kind: "stat_patch",
              actorId,
              key,
              op,
              value: val,
              min,
              max,
              reason: typeof s.reason === "string" ? s.reason : undefined,
            },
            `${actorId}.${key}=${String(checked.clampedValue)}`,
          );
        }
      }

      if (Array.isArray(params.inventory)) {
        for (const item of params.inventory as Array<Record<string, unknown>>) {
          const actorId = String(item.actor ?? item.actorId ?? "player");
          const name = String(item.item ?? "");
          const delta = Number(item.delta ?? 0);
          if (!name || !Number.isFinite(delta) || delta === 0) continue;
          const invCheck = validateInventoryPatch(staging, actorId, name, delta);
          if (!invCheck.ok) {
            rejected.push(`${actorId}.inv[${name}]: ${invCheck.error ?? "insufficient"}`);
            continue;
          }
          stageTx(
            {
              kind: "inventory_patch",
              actorId,
              item: name,
              delta,
              note: typeof item.note === "string" ? item.note : undefined,
            },
            `${actorId}.inv[${name}] ${delta > 0 ? `+${delta}` : delta}`,
          );
        }
      }

      if (params.flags && typeof params.flags === "object" && !Array.isArray(params.flags)) {
        for (const [k, v] of Object.entries(params.flags as Record<string, unknown>)) {
          stageTx({ kind: "flag_set", flag: k, value: Boolean(v) }, `flag.${k}=${Boolean(v)}`);
        }
      }

      if (Array.isArray(params.clocks)) {
        for (const c of params.clocks as Array<Record<string, unknown>>) {
          const clockId = String(c.clockId ?? "");
          const delta = Number(c.delta ?? 0);
          const max = typeof c.max === "number" ? c.max : staging.clocks[clockId]?.max ?? 4;
          const label = typeof c.label === "string" ? c.label : staging.clocks[clockId]?.label ?? clockId;
          if (!clockId || !Number.isFinite(delta)) continue;
          const setFlags =
            c.on_complete_flags && typeof c.on_complete_flags === "object" && !Array.isArray(c.on_complete_flags)
              ? Object.fromEntries(
                  Object.entries(c.on_complete_flags as Record<string, unknown>).map(([k, v]) => [k, Boolean(v)]),
                )
              : undefined;
          const triggerStoryletId =
            typeof c.on_complete_storylet === "string" && c.on_complete_storylet.trim()
              ? c.on_complete_storylet.trim()
              : undefined;
          const onComplete = setFlags || triggerStoryletId ? { setFlags, triggerStoryletId } : undefined;
          const tx: RpTxEntry = { kind: "progress_clock", clockId, label, delta, max, ...(onComplete ? { onComplete } : {}) };
          applyRpTx(staging, tx);
          pendingTxs.push(tx);
          const now = staging.clocks[clockId];
          applied.push(`clock[${label}]=${now?.value ?? 0}/${now?.max ?? max}`);
        }
      }

      if (Array.isArray(params.conditions)) {
        for (const cond of params.conditions as Array<Record<string, unknown>>) {
          const actorId = String(cond.actor ?? "").trim();
          const label = String(cond.label ?? "").trim();
          if (!actorId || !label) continue;
          const condId = `${actorId.toLowerCase()}::${label.toLowerCase()}`;
          if (cond.action === "remove") {
            if (staging.conditions[condId]) {
              stageTx({ kind: "condition_remove", id: condId, reason: "tool" }, `condition-${actorId}.${label}`);
            }
          } else {
            const rem =
              typeof cond.duration_turns === "number" && Number.isFinite(cond.duration_turns) && cond.duration_turns > 0
                ? Math.trunc(cond.duration_turns)
                : null;
            stageTx(
              {
                kind: "condition_upsert",
                condition: {
                  id: condId,
                  actorId,
                  label,
                  effect: typeof cond.effect === "string" && cond.effect.trim() ? cond.effect.trim() : undefined,
                  remainingTurns: rem,
                  appliedTurn: staging.turn,
                },
              },
              `condition+${actorId}.${label}${rem !== null ? `(${rem}t)` : ""}`,
            );
          }
        }
      }

      if (Array.isArray(params.storylets)) {
        for (const ns of params.storylets as Array<Record<string, unknown>>) {
          const title = String(ns.title ?? "").trim();
          const triggerPrompt = String(ns.trigger_prompt ?? "").trim();
          if (!title || !triggerPrompt) continue;
          const sid =
            typeof ns.id === "string" && ns.id.trim()
              ? ns.id.trim()
              : allocateUniqueId("st", staging.turn, staging.storylets);
          const gate: Record<string, unknown> = {};
          if (Array.isArray(ns.required_flags)) {
            const rf = ns.required_flags.map((x) => String(x).trim()).filter(Boolean);
            if (rf.length > 0) gate.requiredFlags = rf;
          }
          if (typeof ns.min_turn === "number" && Number.isFinite(ns.min_turn) && ns.min_turn > 0) {
            gate.minTurn = Math.trunc(ns.min_turn);
          }
          const postFlags =
            ns.post_flags && typeof ns.post_flags === "object" && !Array.isArray(ns.post_flags)
              ? Object.fromEntries(
                  Object.entries(ns.post_flags as Record<string, unknown>).map(([k, v]) => [k, Boolean(v)]),
                )
              : undefined;
          const nextObjective =
            typeof ns.next_objective === "string" && ns.next_objective.trim() ? ns.next_objective.trim() : undefined;
          stageTx(
            {
              kind: "storylet_upsert",
              storylet: {
                id: sid,
                title,
                triggerPrompt,
                gate: Object.keys(gate).length > 0 ? (gate as any) : undefined,
                postEffects: postFlags || nextObjective ? { setFlags: postFlags, nextObjective } : undefined,
                oneTime: true,
                status: Object.keys(gate).length > 0 ? "armed" : "triggered",
                createdTurn: staging.turn,
              },
            },
            `storylet+${title}`,
          );
        }
      }

      if (Array.isArray(params.completed_storylets)) {
        for (const rawId of params.completed_storylets) {
          const sid = String(rawId ?? "").trim();
          if (!sid) continue;
          const existing = staging.storylets.get(sid);
          if (existing && existing.status !== "completed") {
            stageTx(
              { kind: "storylet_upsert", storylet: { ...existing, status: "completed" } },
              `storylet.done(${existing.title})`,
            );
          }
        }
      }

      if (Array.isArray(params.define_cfsm)) {
        for (const d of params.define_cfsm as Array<Record<string, unknown>>) {
          const actorId = String(d.actor ?? "");
          const axis = String(d.axis ?? "");
          const states = Array.isArray(d.states) ? d.states.map(String) : [];
          const initial = String(d.initial ?? states[0] ?? "");
          if (!actorId || !axis || states.length === 0 || !initial) continue;
          stageTx(
            {
              kind: "cfsm_define",
              actorId,
              def: {
                axis,
                states,
                initial,
                transitions:
                  d.transitions && typeof d.transitions === "object"
                    ? (d.transitions as Record<string, string[]>)
                    : undefined,
              },
            },
            `cfsm.define(${actorId}.${axis}=${initial})`,
          );
        }
      }

      if (Array.isArray(params.cfsm)) {
        for (const t of params.cfsm as Array<Record<string, unknown>>) {
          const actorId = String(t.actor ?? "");
          const axis = String(t.axis ?? "");
          const to = String(t.to ?? "");
          const reason = String(t.reason ?? "");
          const check = validateCfsmTransition(staging, actorId, axis, to);
          if (!check.ok) {
            rejected.push(`cfsm ${actorId}.${axis}->${to}: ${check.error ?? "invalid"}`);
            continue;
          }
          const from = staging.cfsmStates[actorId]?.[axis]?.state ?? "initial";
          stageTx(
            { kind: "cfsm_transition", actorId, axis, from, to, reason, turn: staging.turn },
            `cfsm ${actorId}.${axis}: ${from}->${to}`,
          );
        }
      }

      const spatialNote = typeof params.spatial_notes === "string" ? params.spatial_notes.trim() : undefined;
      let appliedPhysicalCount = 0;
      if (Array.isArray(params.physical)) {
        for (const ph of params.physical as Array<Record<string, unknown>>) {
          const actorId = String(ph.actor ?? "").trim();
          if (!actorId) continue;
          const snapshot: PhysicalSnapshot = { actorId, updatedTurn: staging.turn };
          if (typeof ph.attire === "string" && ph.attire.trim()) snapshot.attire = ph.attire.trim();
          if (typeof ph.condition === "string" && ph.condition.trim()) snapshot.condition = ph.condition.trim();
          if (typeof ph.holding === "string" && ph.holding.trim()) snapshot.holding = ph.holding.trim();
          if (typeof ph.position === "string" && ph.position.trim()) snapshot.position = ph.position.trim();
          stageTx(
            {
              kind: "physical_patch",
              snapshot,
              spatialNotes: spatialNote,
              reason: "tool",
            },
            `physical[${actorId}]`,
          );
          appliedPhysicalCount++;
        }
      }
      if (appliedPhysicalCount === 0 && spatialNote !== undefined) {
        stageTx(
          {
            kind: "physical_patch",
            snapshot: { actorId: "", updatedTurn: staging.turn },
            spatialNotes: spatialNote,
            reason: "tool",
          },
          "spatial_notes",
        );
      }

      // Phase 2: Atomic commit — abort all transactions if any validation failed
      if (rejected.length > 0) {
        return {
          isError: true,
          content: [{ type: "text", text: `Rejected (no changes committed): ${rejected.join("; ")}` }],
          details: { applied: [], rejected },
        };
      }

      for (const tx of pendingTxs) {
        rt.commitTx(tx);
      }

      rt.refreshHud(ctx);
      return {
        content: [{ type: "text", text: applied.length ? `Applied: ${applied.join("; ")}` : "No state changes applied." }],
        details: { applied, rejected: [] },
      };
    },
  });

  // 3. rp_fact_commit
  registerExtendedTool(pi, {
    name: "rp_fact_commit",
    label: "RP 事实与伏笔归档",
    description:
      "Commit/invalidate bi-temporal facts (with witnesses), DREAM beliefs, foresights, agendas, or pair bonds.",
    promptSnippet: "Commit/invalidate facts, beliefs, foresights, or agendas.",
    defaultActive: false,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    parameters: {
      type: "object",
      properties: {
        add_facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              statement: { type: "string" },
              entities: { type: "array", items: { type: "string" } },
              witnesses: {
                type: "array",
                items: { type: "string" },
                description: "Witness names or [\"public\"]",
              },
              causeEvent: { type: "string" },
            },
            required: ["statement"],
          },
        },
        invalidate_facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              factId: { type: "string" },
              supersededBy: { type: "string" },
              reason: { type: "string" },
            },
            required: ["factId"],
          },
        },
        beliefs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              target: { type: "string" },
              activatingEvent: { type: "string" },
              belief: { type: "string" },
              subjectiveInsight: { type: "string", description: "Character inner subtext" },
              emotionalTone: { type: "string", description: "Emotional tone" },
            },
            required: ["actor", "target", "activatingEvent", "belief"],
          },
        },
        foresights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              summary: { type: "string" },
              entities: { type: "array", items: { type: "string" } },
              triggerHint: { type: "string" },
              dueClockId: { type: "string" },
              status: { type: "string", enum: ["open", "paid_off", "expired"] },
            },
            required: ["summary"],
          },
        },
        agendas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              goal: { type: "string" },
              currentActivity: { type: "string" },
              etaTurns: { type: "number" },
            },
            required: ["actor", "currentActivity"],
          },
        },
        pair_bonds: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actorA: { type: "string" },
              actorB: { type: "string" },
              stance: { type: "string" },
              tension: { type: "number" },
              note: { type: "string" },
            },
            required: ["actorA", "actorB", "stance"],
          },
        },
      },
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      const counts: string[] = [];
      if (Array.isArray(args.add_facts) && args.add_facts.length) counts.push(`+事实×${args.add_facts.length}`);
      if (Array.isArray(args.invalidate_facts) && args.invalidate_facts.length) counts.push(`失效×${args.invalidate_facts.length}`);
      if (Array.isArray(args.beliefs) && args.beliefs.length) counts.push(`信念×${args.beliefs.length}`);
      if (Array.isArray(args.foresights) && args.foresights.length) counts.push(`伏笔×${args.foresights.length}`);
      if (Array.isArray(args.agendas) && args.agendas.length) counts.push(`日程×${args.agendas.length}`);
      if (Array.isArray(args.pair_bonds) && args.pair_bonds.length) counts.push(`关系×${args.pair_bonds.length}`);
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "🧠 记忆归档")} ${styleDim(theme, counts.join(" · ") || "记录事件")}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { log?: string[]; previews?: string[] };
      const previews = d.previews ?? [];
      if (previews.length === 0) {
        return createLinesComponent(() => [styleFg(theme, "muted", `🧠 已写入 ${d.log?.length ?? 0} 条记忆记录`)]);
      }
      return createLinesComponent((width) =>
        previews.slice(0, 4).flatMap((line, i) =>
          wrapDisplayLine(i === 0 ? `🧠 ${line}` : `  · ${line}`, Math.max(24, width - 2)).map((l) =>
            styleFg(theme, "muted", l),
          ),
        ),
      );
    },
    async execute(_id, rawParams) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }

      const log: string[] = [];
      const previews: string[] = [];

      if (Array.isArray(params.add_facts)) {
        for (const f of params.add_facts as Array<Record<string, unknown>>) {
          const statement = String(f.statement ?? "").trim();
          if (!statement) continue;

          let witnessIds: string[] | "public" = "public";
          if (f.witnesses === "public") {
            witnessIds = "public";
          } else if (typeof f.witnesses === "string") {
            const w = f.witnesses.trim();
            witnessIds = !w || w.toLowerCase() === "public" ? "public" : [w];
          } else if (Array.isArray(f.witnesses)) {
            const cleaned = f.witnesses.map((x) => String(x).trim()).filter(Boolean);
            witnessIds = cleaned.length === 1 && cleaned[0]!.toLowerCase() === "public" ? "public" : cleaned;
          }

          const fact: BiTemporalFact = {
            id:
              typeof f.id === "string" && f.id.trim()
                ? f.id.trim()
                : allocateUniqueId("fact", state.turn, state.facts),
            statement,
            entities: Array.isArray(f.entities) ? f.entities.map(String) : [],
            validFromTurn: state.turn,
            validUntilTurn: null,
            ingestedAtTurn: state.turn,
            eventTimeLabel: state.worldTimeLabel || undefined,
            witnessIds,
            causeEvent: typeof f.causeEvent === "string" ? f.causeEvent : undefined,
          };
          rt.commitTx({ kind: "fact_add", fact });
          log.push(`+fact(${fact.id})`);
          previews.push(`事实：${statement.slice(0, 48)}`);
        }
      }

      if (Array.isArray(params.invalidate_facts)) {
        for (const inv of params.invalidate_facts as Array<Record<string, unknown>>) {
          const factId = String(inv.factId ?? "").trim();
          if (!factId) continue;
          rt.commitTx({
            kind: "fact_invalidate",
            factId,
            validUntilTurn: state.turn,
            supersededBy: typeof inv.supersededBy === "string" ? inv.supersededBy : undefined,
            reason: typeof inv.reason === "string" ? inv.reason : "superseded",
          });
          log.push(`-fact(${factId})`);
        }
      }

      if (Array.isArray(params.beliefs)) {
        for (const b of params.beliefs as Array<Record<string, unknown>>) {
          rt.commitTx({
            kind: "belief_update",
            actorId: String(b.actor ?? ""),
            target: String(b.target ?? ""),
            activatingEvent: String(b.activatingEvent ?? ""),
            belief: String(b.belief ?? ""),
            subjectiveInsight: typeof b.subjectiveInsight === "string" ? b.subjectiveInsight.trim() || undefined : undefined,
            emotionalTone: typeof b.emotionalTone === "string" ? b.emotionalTone.trim() || undefined : undefined,
            turn: state.turn,
          });
          log.push(`belief(${String(b.actor)}->${String(b.target)})`);
          previews.push(`信念 ${String(b.actor)}→${String(b.target)}：${String(b.belief ?? "").slice(0, 40)}`);
        }
      }

      if (Array.isArray(params.foresights)) {
        for (const h of params.foresights as Array<Record<string, unknown>>) {
          const summary = String(h.summary ?? "").trim();
          if (!summary) continue;
          const id =
            typeof h.id === "string" && h.id.trim()
              ? h.id.trim()
              : allocateUniqueId("hook", state.turn, state.foresights);
          const status = h.status === "paid_off" || h.status === "expired" ? h.status : "open";
          rt.commitTx({
            kind: "foresight_upsert",
            hook: {
              id,
              summary,
              entities: Array.isArray(h.entities) ? h.entities.map(String) : [],
              plantedTurn: state.turn,
              triggerHint: typeof h.triggerHint === "string" ? h.triggerHint : "",
              dueClockId: typeof h.dueClockId === "string" ? h.dueClockId : undefined,
              status,
            },
          });
          log.push(`foresight(${id}:${status})`);
          previews.push(`伏笔：${summary.slice(0, 44)}`);
        }
      }

      if (Array.isArray(params.agendas)) {
        for (const ag of params.agendas as Array<Record<string, unknown>>) {
          const actorId = String(ag.actor ?? "").trim();
          const currentActivity = String(ag.currentActivity ?? "").trim();
          const goal = String(ag.goal ?? currentActivity).trim();
          if (!actorId || !currentActivity) continue;
          const etaTurns = typeof ag.etaTurns === "number" && Number.isFinite(ag.etaTurns) ? Math.max(0, Math.round(ag.etaTurns)) : null;
          rt.commitTx({ kind: "agenda_upsert", agenda: { actorId, goal, currentActivity, etaTurns, updatedTurn: state.turn } });
          log.push(`agenda(${actorId})`);
          previews.push(`日程 ${actorId}：${currentActivity.slice(0, 40)}`);
        }
      }

      if (Array.isArray(params.pair_bonds)) {
        for (const pb of params.pair_bonds as Array<Record<string, unknown>>) {
          const actorA = String(pb.actorA ?? "").trim();
          const actorB = String(pb.actorB ?? "").trim();
          const stance = String(pb.stance ?? "").trim();
          if (!actorA || !actorB || actorA === actorB || !stance) continue;
          const [a, b] = [actorA, actorB].sort();
          const tension = typeof pb.tension === "number" && Number.isFinite(pb.tension) ? pb.tension : 0;
          const note = String(pb.note ?? "").trim();
          rt.commitTx({ kind: "pair_bond_upsert", bond: { id: `${a}::${b}`, actorA: a!, actorB: b!, stance, tension, note, updatedTurn: state.turn } });
          log.push(`bond(${a}<->${b})`);
          previews.push(`关系 ${a}↔${b}：${stance}`);
        }
      }

      return {
        content: [{ type: "text", text: log.length ? `Committed: ${log.join(", ")}` : "Nothing committed." }],
        details: { log, previews },
      };
    },
  });

  // 4. rp_recall (Unified worldbook list/read/search + memory books/facts/foresights)
  registerExtendedTool(pi, {
    name: "rp_recall",
    label: "RP 深度世界书检索",
    description:
      "Search/list/read worldbook entries (action='search'|'list'|'read'), plus memory books, facts, and open foresights.",
    promptSnippet: "Search, list, or read worldbook, memory books & facts.",
    defaultActive: false,
    annotations: { readOnlyHint: true },
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["search", "list", "read"], description: "'search' (default), 'list', or 'read'" },
        query: { type: "string", description: "Keywords or entry title (for search/read)" },
        offset: { type: "number", description: "List/read offset (default 0)" },
        limit: { type: "number", description: "Max list titles (default 30, max 100)" },
        token_budget: { type: "number", description: "Max search tokens (default 900)" },
      },
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      const act = String(args.action ?? "search");
      const label = act === "list" ? "浏览目录" : act === "read" ? `读取「${String(args.query ?? "")}」` : `“${String(args.query ?? "")}”`;
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "📜 档案检索")} ${styleDim(theme, label)}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { loreCount?: number; factCount?: number; mode?: string; total?: number };
      if (d.mode === "list") {
        return createLinesComponent(() => [styleFg(theme, "muted", `📜 世界书目录（共 ${d.total ?? 0} 条）`)]);
      }
      return createLinesComponent(() => [
        styleFg(theme, "muted", `📜 检索命中 ${d.loreCount ?? 0} 条设定 · ${d.factCount ?? 0} 条事实`),
      ]);
    },
    async execute(_id, rawParams) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      const card = rt.getCard();
      if (!state.active || !card) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const action = params.action === "list" || params.action === "read" ? params.action : "search";
      const query = String(params.query ?? "").trim();
      const allLore = getAllLoreEntries(rt);
      // Enforce spoiler gates across list, read, search, and semantic embedding search
      const visibleLore = allLore.filter(
        (e) => (state.loreOverrides[e.id] ?? e.enabled) && e.content.trim().length > 0 && evaluateGate(e.gate, state),
      );

      // Mode A: Paginated title directory (`list`) ported from dsh-tavern worldbook-files.js
      if (action === "list") {
        const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(params.limit) || 30)));
        const slice = visibleLore.slice(offset, offset + limit);
        const lines = slice.map((e, i) => `${offset + i + 1}. [${e.constant ? "常驻" : "动态"}] ${e.title}${e.keys.length ? ` (${e.keys.slice(0, 4).join("/")})` : ""}`);
        const nextOffset = offset + limit < visibleLore.length ? offset + limit : null;
        return {
          content: [
            {
              type: "text",
              text:
                `Worldbook Directory (${offset + 1}-${offset + slice.length} / ${visibleLore.length}):\n` +
                lines.join("\n") +
                (nextOffset !== null ? `\n(More entries available: pass offset=${nextOffset})` : ""),
            },
          ],
          details: { mode: "list", total: visibleLore.length, offset, nextOffset },
        };
      }

      // Mode B: Exact-title-first ranked full-text reader (`read`) ported from dsh-tavern worldbook-files.js
      if (action === "read") {
        if (!query) {
          return { isError: true, content: [{ type: "text", text: "query is required for action='read'." }] };
        }
        const norm = (v: string) => v.normalize("NFKC").trim().toLowerCase();
        const qNorm = norm(query);
        let bestRank = Infinity;
        let matches: CompiledLoreEntry[] = [];
        for (const e of visibleLore) {
          const titleNorm = norm(e.title);
          const keysNorm = e.keys.map(norm);
          const rank =
            titleNorm === qNorm
              ? 0
              : keysNorm.some((k) => k === qNorm)
                ? 1
                : titleNorm.includes(qNorm) || keysNorm.some((k) => k.includes(qNorm))
                  ? 2
                  : Infinity;
          if (!Number.isFinite(rank) || rank > bestRank) continue;
          if (rank < bestRank) {
            matches = [];
            bestRank = rank;
          }
          matches.push(e);
        }
        if (matches.length === 0) {
          matches = visibleLore.filter((e) => norm(e.content).includes(qNorm));
        }
        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No worldbook entry matched "${query}".` }], details: { mode: "read", loreCount: 0 } };
        }
        if (matches.length > 1) {
          const cands = matches.slice(0, 10).map((e, i) => `${i + 1}. ${e.title}`).join("\n");
          return {
            content: [{ type: "text", text: `Multiple worldbook entries matched "${query}" (${matches.length} total). Call rp_recall(action="read", query="<exact title>") with one of:\n${cands}` }],
            details: { mode: "read", loreCount: matches.length },
          };
        }
        const entry = matches[0]!;
        const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
        const chars = Array.from(entry.content);
        const end = Math.min(offset + 8000, chars.length);
        const text = chars.slice(offset, end).join("");
        const nextOffset = end < chars.length ? end : null;
        return {
          content: [
            {
              type: "text",
              text: `### ${entry.title}\n${text}${nextOffset !== null ? `\n\n[Truncated: call with offset=${nextOffset} to continue]` : ""}`,
            },
          ],
          details: { mode: "read", loreCount: 1, title: entry.title, nextOffset },
        };
      }

      if (!query) {
        return { isError: true, content: [{ type: "text", text: "query is required for action='search'." }] };
      }
      const budget = typeof params.token_budget === "number" ? Math.min(2400, Math.max(200, params.token_budget)) : 900;

      const loreRes = recallLoreWithGraphPpr({
        entries: visibleLore,
        state,
        recentText: query,
        tokenBudget: budget,
        manualQuery: query,
      });

      const qLower = query.toLowerCase();
      const qTokens = new Set(tokenizeHybrid(qLower));
      const matchedFacts = getActiveFacts(state)
        .filter((f) => {
          if (f.statement.toLowerCase().includes(qLower) || f.entities.some((e) => e.toLowerCase().includes(qLower))) {
            return true;
          }
          if (qTokens.size === 0) return false;
          const factTokens = tokenizeHybrid(`${f.statement} ${f.entities.join(" ")}`);
          let hits = 0;
          for (const t of factTokens) {
            if (qTokens.has(t)) hits++;
          }
          return hits >= Math.min(2, qTokens.size);
        })
        .slice(0, 6);

      const matchedBooks = Array.from(state.memoryBooks.values())
        .filter(
          (b) =>
            b.enabled &&
            (b.title.toLowerCase().includes(qLower) ||
              b.summary.toLowerCase().includes(qLower) ||
              b.keywords.some((k) => k.toLowerCase().includes(qLower)) ||
              b.entities.some((e) => e.toLowerCase().includes(qLower))),
        )
        .slice(0, 4);

      const matchedHooks = Array.from(state.foresights.values())
        .filter((h) => h.status === "open" && (h.summary.toLowerCase().includes(qLower) || h.triggerHint.toLowerCase().includes(qLower)))
        .slice(0, 4);

      // Optional Hybrid Semantic Embedding boost for worldbook entries when Embedding is enabled
      const recallEmbCfg = loadUiPrefs().embeddingConfig;
      if (recallEmbCfg?.enabled && visibleLore.length > 0) {
        const loreDocs = visibleLore.slice(0, 80).map((e) => `${e.title}: ${e.content.slice(0, 500)}`);
        const semHits = await rankBySemanticSimilarity(recallEmbCfg, query, loreDocs, 0.30);
        if (semHits && semHits.length > 0) {
          const existingIds = new Set(loreRes.selected.map((e) => e.id));
          let usedTokens = loreRes.selected.reduce((sum, e) => sum + Math.ceil(e.content.length / 3), 0);
          for (const hit of semHits.slice(0, 3)) {
            const entry = visibleLore[hit.index];
            if (entry && !existingIds.has(entry.id)) {
              const est = Math.ceil(entry.content.length / 3);
              if (usedTokens + est > budget && loreRes.selected.length > 0) continue;
              loreRes.selected.push(entry);
              existingIds.add(entry.id);
              usedTokens += est;
            }
          }
        }
      }

      const parts: string[] = [];
      if (loreRes.selected.length > 0) {
        parts.push(`## Recalled Lore\n${loreRes.selected.map((e) => `### ${e.title}\n${e.content}`).join("\n\n")}`);
      }
      if (matchedBooks.length > 0) {
        parts.push(
          `## Matching Memory Books\n${matchedBooks
            .map((b) => `### ${b.title} (T${b.turnRange[0]}-T${b.turnRange[1]})\n${b.summary}`)
            .join("\n\n")}`,
        );
      }
      if (matchedFacts.length > 0) {
        parts.push(`## Matching Facts\n${matchedFacts.map((f) => `- [${f.id} | T${f.validFromTurn}] ${f.statement}`).join("\n")}`);
      }
      if (matchedHooks.length > 0) {
        parts.push(`## Matching Foresights\n${matchedHooks.map((h) => `- [${h.id}] ${h.summary} (${h.triggerHint})`).join("\n")}`);
      }

      return {
        content: [{ type: "text", text: parts.length ? parts.join("\n\n") : `No records matched "${query}".` }],
        details: {
          loreCount: loreRes.selected.length,
          memoryBookCount: matchedBooks.length,
          factCount: matchedFacts.length,
        },
      };
    },
  });

  // 4b. rp_history_recall (Ported from dsh-tavern bm25.js + history-recall.js)
  registerExtendedTool(pi, {
    name: "rp_history_recall",
    label: "RP 历史原文召回",
    description:
      "Search/read past story turns verbatim via BM25. Pass `query` (keywords) OR `turn` (1-indexed) + optional `radius` (0-3). Max 6/turn.",
    promptSnippet: "Recall verbatim past turns by keyword or round #.",
    defaultActive: false,
    annotations: { readOnlyHint: true },
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (space-separated)" },
        turn: { type: "number", description: "1-indexed round to read verbatim" },
        radius: { type: "number", description: "Neighboring rounds (0-3, default 1)" },
        limit: { type: "number", description: "Max matches (1-8, default 5)" },
      },
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      const detail = typeof args.query === "string" && args.query.trim()
        ? `搜索 “${args.query.trim()}”`
        : `读取第 ${String(args.turn ?? "?")} 轮`;
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "🕰 历史召回")} ${styleDim(theme, detail)}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { mode?: string; matchCount?: number; roundCount?: number };
      const label = d.mode === "read" ? `读取 ${d.roundCount ?? 0} 轮原文` : `命中 ${d.matchCount ?? 0} 处历史片段`;
      return createLinesComponent(() => [styleFg(theme, "muted", `🕰 ${label}`)]);
    },
    async execute(_id, rawParams, _sig, _onUpdate, ctx) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const branch = ctx?.sessionManager?.getBranch?.() ?? [];
      const scope = rt.getHistoryRecallScope?.() ?? createTurnRecallScope();
      const cooldowns = rt.getHistoryRecallCooldowns?.() ?? [];
      try {
        const { result, nextCooldowns } = recallHistory({
          branch,
          query: typeof params.query === "string" ? params.query : undefined,
          turn: typeof params.turn === "number" ? params.turn : undefined,
          radius: typeof params.radius === "number" ? params.radius : undefined,
          limit: typeof params.limit === "number" ? params.limit : undefined,
          scope,
          cooldowns,
          cacheScopeId: state.cardSlug ?? "rp",
        });
        rt.setHistoryRecallCooldowns?.(nextCooldowns);

        // Optional Hybrid Semantic RRF fusion when Embedding endpoint is configured in Settings
        const embCfg = loadUiPrefs().embeddingConfig;
        if (result.mode === "search" && embCfg?.enabled && typeof params.query === "string" && params.query.trim()) {
          const allRounds = extractCommittedRounds(branch);
          const docs = allRounds.map((r) => r.messages.map((m) => m.text).join("\n").slice(0, 1200));
          const semRanked = await rankBySemanticSimilarity(embCfg, params.query.trim(), docs, 0.28);
          if (semRanked && semRanked.length > 0) {
            const bm25Turns = result.matches.map((m) => m.turn);
            const semTurns = semRanked.slice(0, 8).map((x) => allRounds[x.index]!.turn);
            const fused = reciprocalRankFusion(bm25Turns, semTurns);
            const existingByTurn = new Map(result.matches.map((m) => [m.turn, m]));
            const maxOut = Math.min(8, Math.max(1, Number(params.limit) || 5));
            const mergedMatches = fused.slice(0, maxOut).map(({ id: t }) => {
              const ex = existingByTurn.get(t);
              if (ex) return ex;
              const round = allRounds.find((r) => r.turn === t);
              const snippet = round ? round.messages.map((m) => m.text).join(" ").replace(/\s+/g, " ").slice(0, 220) : "";
              return { turn: t, excerpt: `〔语义召回〕${snippet}` };
            });
            result.matches = mergedMatches;
            if (mergedMatches.length > 0) result.found = true;
          }
        }

        return {
          content: [{ type: "text", text: renderHistoryRecall(result) }],
          details: {
            mode: result.mode,
            found: result.found,
            matchCount: result.matches.length,
            roundCount: result.rounds.length,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: (err as Error).message }],
        };
      }
    },
  });

  // 5. rp_era_advance
  registerExtendedTool(pi, {
    name: "rp_era_advance",
    label: "RP 幕次跃迁",
    description:
      "Advance the narrative era/act, unlock milestones, and optionally advance world time (days/time label) for a montage or chapter break.",
    promptSnippet: "Advance story era/act, unlock milestones, and skip world time.",
    defaultActive: false,
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        to_era: { type: "string", description: "New era/act name (e.g. 'Act II')" },
        milestones: { type: "array", items: { type: "string" }, description: "Milestone IDs unlocked" },
        day_delta: { type: "number", description: "Optional days elapsed" },
        world_time_label: { type: "string", description: "Optional new time label" },
        montage_summary: { type: "string", description: "Brief summary of what elapsed" },
      },
      required: ["to_era"],
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      return createLinesComponent(() => [
        `${styleFg(theme, "warning", "⏳ 幕次跃迁")} → ${styleBold(theme, String(args.to_era ?? ""))}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { fromEra?: string; toEra?: string; milestones?: string[] };
      const ms = d.milestones?.length ? ` · 解锁: ${d.milestones.join(", ")}` : "";
      return createLinesComponent(() => [
        styleFg(theme, "warning", `⏳ ${d.fromEra ?? ""} → ${d.toEra ?? ""}${ms}`),
      ]);
    },
    async execute(_id, rawParams, _sig, _onUpdate, ctx) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const fromEra = state.era;
      const prevWorldTimeLabel = state.worldTimeLabel;
      const toEra = String(params.to_era ?? state.era).trim() || state.era;
      const milestones = Array.isArray(params.milestones) ? params.milestones.map(String) : [];
      const montageSummary = typeof params.montage_summary === "string" ? params.montage_summary : "";

      // Compute calendar anchor using the BEFORE-tick `worldTimeLabel` prior to committing `clock_tick`
      let temporalNote = "";
      if (typeof params.day_delta === "number" && params.day_delta >= 365) {
        const yrs = Math.round(params.day_delta / 365);
        const anchor = computeCalendarAnchor(prevWorldTimeLabel, yrs, params.day_delta);
        if (anchor) temporalNote += ` | ${anchor.exactHint}`;
        const card = rt.getCard();
        const profile = detectLifespanProfile(
          `${card?.frozen.description ?? ""} ${card?.frozen.scenario ?? ""} ${state.archetype}`,
        );
        if (profile === "mortal" && yrs >= 60) {
          temporalNote += ` | Temporal warning: +${yrs} years exceeds normal mortal lifespan; reflect aging/mortality or generational shift rather than keeping mortal characters ageless.`;
        }
      }

      rt.commitTx({
        kind: "era_advance",
        fromEra,
        toEra,
        milestoneUnlocked: milestones,
        montageSummary,
        turn: state.turn,
      });

      if (typeof params.day_delta === "number" || typeof params.world_time_label === "string") {
        rt.commitTx({
          kind: "clock_tick",
          beatDelta: 0,
          dayDelta: typeof params.day_delta === "number" ? params.day_delta : undefined,
          worldTimeLabel: typeof params.world_time_label === "string" ? params.world_time_label : undefined,
        });
      }

      rt.refreshHud(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Era advanced: ${fromEra} -> ${toEra}${milestones.length ? ` (milestones: ${milestones.join(", ")})` : ""}${temporalNote}`,
          },
        ],
        details: { fromEra, toEra, milestones },
      };
    },
  });

  // 6. rp_npc_deliberate
  registerExtendedTool(pi, {
    name: "rp_npc_deliberate",
    label: "RP NPC 视角隔离推演",
    description:
      "Retrieve an NPC's strictly isolated epistemic view (ONLY facts they witnessed + their own CFSM state and DREAM beliefs) so you can decide their hidden-information reaction without leaking secrets.",
    promptSnippet: "Inspect an NPC's strictly isolated knowledge (FANToM epistemic boundary) before acting.",
    defaultActive: false,
    annotations: { readOnlyHint: true },
    parameters: {
      type: "object",
      properties: {
        actor: { type: "string", description: "NPC name/ID" },
        situation: { type: "string", description: "Current prompt or dilemma facing this NPC" },
      },
      required: ["actor"],
    },
    renderCall(rawArgs, theme) {
      const args = unwrapNestedArgs(rawArgs);
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "👁 视角隔离")} ${styleBold(theme, String(args.actor ?? ""))}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { actor?: string; visibleFacts?: number; beliefs?: number };
      return createLinesComponent(() => [
        styleFg(theme, "muted", `👁 ${d.actor ?? "NPC"} 可见事实 ${d.visibleFacts ?? 0} 条 · 信念 ${d.beliefs ?? 0} 条`),
      ]);
    },
    async execute(_id, rawParams) {
      const params = unwrapNestedArgs(rawParams);
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const actor = String(params.actor ?? "").trim();
      const situation = String(params.situation ?? "").trim();
      const visibleFacts = getActiveFacts(state).filter((f) => isFactVisibleToActor(f, actor));
      const actorBeliefs = state.beliefs.filter((b) => b.actorId.toLowerCase() === actor.toLowerCase()).slice(-6);
      const actorLower = actor.toLowerCase();
      const cfsmKey = Object.keys(state.cfsmStates).find((k) => k.toLowerCase() === actorLower);
      const actorCfsm = cfsmKey ? state.cfsmStates[cfsmKey] ?? {} : {};

      const lines: string[] = [`# Isolated Epistemic View: ${actor}`];
      if (situation) lines.push(`Situation: ${situation}`);
      if (Object.keys(actorCfsm).length > 0) {
        lines.push(`CFSM: ${Object.entries(actorCfsm).map(([a, r]) => `${a}=${r.state}`).join(", ")}`);
      }
      lines.push(
        `Known Facts (${visibleFacts.length}):\n` +
          (visibleFacts.length ? visibleFacts.map((f) => `- [T${f.validFromTurn}] ${f.statement}`).join("\n") : "- (none)"),
      );
      if (actorBeliefs.length > 0) {
        lines.push(
          `Personal Beliefs (DREAM ABC · DualMem):\n` +
            actorBeliefs
              .map((b) => {
                const sub = b.subjectiveInsight ? ` | inner subtext: ${b.subjectiveInsight}` : "";
                const tone = b.emotionalTone ? ` [${b.emotionalTone}]` : "";
                return `- About ${b.target}: ${b.belief}${tone} (from: ${b.activatingEvent})${sub}`;
              })
              .join("\n"),
        );
      }
      lines.push("Rule: This NPC MUST act strictly within the facts and beliefs above; do NOT leak unwitnessed player secrets.");

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { actor, visibleFacts: visibleFacts.length, beliefs: actorBeliefs.length },
      };
    },
  });
}

// Re-export RP_ENTRY_TYPE & applyRpTx for test convenience
export { RP_ENTRY_TYPE, applyRpTx };
