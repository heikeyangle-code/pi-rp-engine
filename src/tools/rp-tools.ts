/**
 * Six RP-exclusive tools registered with `defaultActive: false` (0 tokens in dormant coding sessions).
 * All tools include narrative `renderCall` / `renderResult` TUI micro-cards and operate strictly
 * through deterministic L1 event sourcing (`rp:tx`).
 */

import type {
  BiTemporalFact,
  CompiledCard,
  CompiledLoreEntry,
  PiExtensionAPI,
  RpTxEntry,
  SessionRpState,
} from "../types.js";
import { RP_ENTRY_TYPE, applyRpTx } from "../engine/state-replay.js";
import { rollDiceCheck } from "../engine/dice.js";
import { computeCheckedStatValue, validateCfsmTransition, validateInventoryPatch } from "../engine/cfsm.js";
import { recallLoreWithGraphPpr, tokenizeHybrid } from "../memory/graph-ppr.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import { isFactVisibleToActor } from "../engine/gates.js";
import { createLinesComponent, styleBold, styleDim, styleFg, wrapDisplayLine } from "../ui/renderers.js";

export const RP_TOOL_NAMES = [
  "rp_roll_check",
  "rp_state_patch",
  "rp_fact_commit",
  "rp_recall",
  "rp_era_advance",
  "rp_npc_deliberate",
] as const;

export interface RpToolRuntime {
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  commitTx(tx: RpTxEntry): void;
  refreshHud(ctx?: any): void;
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
  pi.registerTool({
    name: "rp_roll_check",
    label: "RP 掷骰检定",
    description:
      "Execute a deterministic dice roll or skill check (supports e.g. '1d20+3', 'd20', '2d20kh1', '2d20kl1', '2d6', '1d100'). Use ONLY when an outcome is genuinely uncertain or contested.",
    promptSnippet: "Roll dice or resolve an uncertain skill/combat check deterministically.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Dice formula like '1d20+3', '2d20kh1', '2d6+1', '1d100'" },
        dc: { type: "number", description: "Optional difficulty target number" },
        reason: { type: "string", description: "What is being attempted" },
        actor: { type: "string", description: "Actor performing the check" },
      },
      required: ["expression"],
    },
    renderCall(args, theme) {
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
    async execute(_id, params) {
      const expr = String(params.expression ?? "1d20");
      const dc = typeof params.dc === "number" ? params.dc : undefined;
      const reason = typeof params.reason === "string" ? params.reason : undefined;
      const actor = typeof params.actor === "string" ? params.actor : undefined;
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
        const outcomeText = outcomeLabel ? ` -> ${outcomeLabel} (DC ${dc})` : "";
        const keptInfo =
          res.keptRolls.length !== res.rolls.length ? ` kept [${res.keptRolls.join(", ")}]` : "";
        const summary = `Roll ${res.expression}${actor ? ` [${actor}]` : ""}${reason ? ` (${reason})` : ""}: rolls [${res.rolls.join(", ")}]${keptInfo}${res.modifier ? ` ${res.modifier >= 0 ? "+" : ""}${res.modifier}` : ""} = ${res.total}${outcomeText}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { ...res, actor, reason },
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
  pi.registerTool({
    name: "rp_state_patch",
    label: "RP 状态账本更新",
    description:
      "Commit deterministic world state updates (stats, inventory, location, present NPCs, flags, progress clocks, CFSM axis definitions & transitions). All numeric bounds and CFSM transitions are code-validated.",
    promptSnippet: "Update authoritative world stats, inventory, location, flags, clocks, or CFSM states.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "New scene location" },
        present_npcs: { type: "array", items: { type: "string" }, description: "NPC names currently present" },
        stats: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actor: { type: "string" },
              key: { type: "string" },
              op: { type: "string", enum: ["set", "add"] },
              value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }], description: "Numeric, string, or boolean value" },
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
        flags: { type: "object", description: "Map of boolean flags to set" },
        clocks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              clockId: { type: "string" },
              label: { type: "string" },
              delta: { type: "number" },
              max: { type: "number" },
            },
            required: ["clockId", "delta"],
          },
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
              transitions: { type: "object" },
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
      },
    },
    renderCall(args, theme) {
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
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }

      const applied: string[] = [];
      const rejected: string[] = [];

      if (typeof params.location === "string" || Array.isArray(params.present_npcs)) {
        const loc = typeof params.location === "string" ? params.location : state.location;
        const npcs = Array.isArray(params.present_npcs) ? params.present_npcs.map(String) : state.presentNpcs;
        rt.commitTx({ kind: "location_set", location: loc, presentNpcs: npcs });
        applied.push(`location=${loc}${npcs.length ? ` [${npcs.join(", ")}]` : ""}`);
      }

      if (Array.isArray(params.stats)) {
        for (const s of params.stats as Array<Record<string, unknown>>) {
          const actorId = String(s.actor ?? "player");
          const key = String(s.key ?? "");
          const op = s.op === "add" ? "add" : "set";
          const val = s.value as number | string | boolean;
          const min = typeof s.min === "number" ? s.min : undefined;
          const max = typeof s.max === "number" ? s.max : undefined;
          if (!key) continue;
          const checked = computeCheckedStatValue(state, actorId, key, op, val, min, max);
          if (!checked.ok) {
            rejected.push(`${actorId}.${key}: ${checked.error ?? "invalid"}`);
            continue;
          }
          rt.commitTx({
            kind: "stat_patch",
            actorId,
            key,
            op,
            value: val,
            min,
            max,
            reason: typeof s.reason === "string" ? s.reason : undefined,
          });
          applied.push(`${actorId}.${key}=${String(checked.clampedValue)}`);
        }
      }

      if (Array.isArray(params.inventory)) {
        for (const item of params.inventory as Array<Record<string, unknown>>) {
          const actorId = String(item.actor ?? item.actorId ?? "player");
          const name = String(item.item ?? "");
          const delta = Number(item.delta ?? 0);
          if (!name || !Number.isFinite(delta) || delta === 0) continue;
          const invCheck = validateInventoryPatch(state, actorId, name, delta);
          if (!invCheck.ok) {
            rejected.push(`${actorId}.inv[${name}]: ${invCheck.error ?? "insufficient"}`);
            continue;
          }
          rt.commitTx({
            kind: "inventory_patch",
            actorId,
            item: name,
            delta,
            note: typeof item.note === "string" ? item.note : undefined,
          });
          applied.push(`${actorId}.inv[${name}] ${delta > 0 ? `+${delta}` : delta}`);
        }
      }

      if (params.flags && typeof params.flags === "object" && !Array.isArray(params.flags)) {
        for (const [k, v] of Object.entries(params.flags as Record<string, unknown>)) {
          rt.commitTx({ kind: "flag_set", flag: k, value: Boolean(v) });
          applied.push(`flag.${k}=${Boolean(v)}`);
        }
      }

      if (Array.isArray(params.clocks)) {
        for (const c of params.clocks as Array<Record<string, unknown>>) {
          const clockId = String(c.clockId ?? "");
          const delta = Number(c.delta ?? 0);
          const max = typeof c.max === "number" ? c.max : state.clocks[clockId]?.max ?? 4;
          const label = typeof c.label === "string" ? c.label : state.clocks[clockId]?.label ?? clockId;
          if (!clockId || !Number.isFinite(delta)) continue;
          rt.commitTx({ kind: "progress_clock", clockId, label, delta, max });
          const now = state.clocks[clockId];
          applied.push(`clock[${label}]=${now?.value ?? 0}/${now?.max ?? max}`);
        }
      }

      if (Array.isArray(params.define_cfsm)) {
        for (const d of params.define_cfsm as Array<Record<string, unknown>>) {
          const actorId = String(d.actor ?? "");
          const axis = String(d.axis ?? "");
          const states = Array.isArray(d.states) ? d.states.map(String) : [];
          const initial = String(d.initial ?? states[0] ?? "");
          if (!actorId || !axis || states.length === 0 || !initial) continue;
          rt.commitTx({
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
          });
          applied.push(`cfsm.define(${actorId}.${axis}=${initial})`);
        }
      }

      if (Array.isArray(params.cfsm)) {
        for (const t of params.cfsm as Array<Record<string, unknown>>) {
          const actorId = String(t.actor ?? "");
          const axis = String(t.axis ?? "");
          const to = String(t.to ?? "");
          const reason = String(t.reason ?? "");
          const check = validateCfsmTransition(state, actorId, axis, to);
          if (!check.ok) {
            rejected.push(`cfsm ${actorId}.${axis}->${to}: ${check.error ?? "invalid"}`);
            continue;
          }
          const from = state.cfsmStates[actorId]?.[axis]?.state ?? "initial";
          rt.commitTx({ kind: "cfsm_transition", actorId, axis, from, to, reason, turn: state.turn });
          applied.push(`cfsm ${actorId}.${axis}: ${from}->${to}`);
        }
      }

      rt.refreshHud(ctx);
      const lines = [
        applied.length ? `Applied: ${applied.join("; ")}` : "No state changes applied.",
        rejected.length ? `Rejected: ${rejected.join("; ")}` : "",
      ].filter(Boolean);

      return {
        isError: applied.length === 0 && rejected.length > 0 ? true : undefined,
        content: [{ type: "text", text: lines.join("\n") }],
        details: { applied, rejected },
      };
    },
  });

  // 3. rp_fact_commit
  pi.registerTool({
    name: "rp_fact_commit",
    label: "RP 事实与伏笔归档",
    description:
      "Commit bi-temporal facts (with witnesses for epistemic isolation), invalidate outdated facts, update DREAM ABC character beliefs, or plant/resolve foresight hooks.",
    promptSnippet: "Record durable world facts, invalidate superseded facts, update character beliefs, or manage foresights.",
    defaultActive: false,
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
              witnesses: { description: "'public' or array of witness names" },
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
              subjectiveInsight: { type: "string", description: "Optional character-subjective inner subtext (DualMem)" },
              emotionalTone: { type: "string", description: "Optional emotional tone label" },
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
      },
    },
    renderCall(args, theme) {
      const counts: string[] = [];
      if (Array.isArray(args.add_facts) && args.add_facts.length) counts.push(`+事实×${args.add_facts.length}`);
      if (Array.isArray(args.invalidate_facts) && args.invalidate_facts.length) counts.push(`失效×${args.invalidate_facts.length}`);
      if (Array.isArray(args.beliefs) && args.beliefs.length) counts.push(`信念×${args.beliefs.length}`);
      if (Array.isArray(args.foresights) && args.foresights.length) counts.push(`伏笔×${args.foresights.length}`);
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "🧠 记忆归档")} ${styleDim(theme, counts.join(" · ") || "记录事件")}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { log?: string[] };
      const count = d.log?.length ?? 0;
      return createLinesComponent(() => [
        styleFg(theme, "muted", `🧠 已写入 ${count} 条长期记忆/伏笔记录`),
      ]);
    },
    async execute(_id, params) {
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }

      const log: string[] = [];
      let idx = 0;

      if (Array.isArray(params.add_facts)) {
        for (const f of params.add_facts as Array<Record<string, unknown>>) {
          const statement = String(f.statement ?? "").trim();
          if (!statement) continue;
          const fact: BiTemporalFact = {
            id: typeof f.id === "string" && f.id.trim() ? f.id.trim() : `fact_t${state.turn}_${idx++}`,
            statement,
            entities: Array.isArray(f.entities) ? f.entities.map(String) : [],
            validFromTurn: state.turn,
            validUntilTurn: null,
            ingestedAtTurn: state.turn,
            eventTimeLabel: state.worldTimeLabel || undefined,
            witnessIds: Array.isArray(f.witnesses) ? f.witnesses.map(String) : "public",
            causeEvent: typeof f.causeEvent === "string" ? f.causeEvent : undefined,
          };
          rt.commitTx({ kind: "fact_add", fact });
          log.push(`+fact(${fact.id})`);
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
        }
      }

      if (Array.isArray(params.foresights)) {
        for (const h of params.foresights as Array<Record<string, unknown>>) {
          const summary = String(h.summary ?? "").trim();
          if (!summary) continue;
          const id = typeof h.id === "string" && h.id.trim() ? h.id.trim() : `hook_t${state.turn}_${idx++}`;
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
        }
      }

      return {
        content: [{ type: "text", text: log.length ? `Committed: ${log.join(", ")}` : "Nothing committed." }],
        details: { log },
      };
    },
  });

  // 4. rp_recall
  pi.registerTool({
    name: "rp_recall",
    label: "RP 深度世界书检索",
    description:
      "Search the compiled worldbook (including primary + co-cast cards and manual-only entries), bi-temporal facts, beliefs, and open foresights for a specific topic, entity, or historical detail.",
    promptSnippet: "Deep-search world lore, historical facts, beliefs, and open foresights.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, entity name, or question" },
        token_budget: { type: "number", description: "Max tokens to return (default 900)" },
      },
      required: ["query"],
    },
    renderCall(args, theme) {
      return createLinesComponent(() => [
        `${styleFg(theme, "accent", "📜 档案检索")} ${styleDim(theme, `“${String(args.query ?? "")}”`)}`,
      ]);
    },
    renderResult(result, _options, theme) {
      const d = (result.details ?? {}) as { loreCount?: number; factCount?: number };
      return createLinesComponent(() => [
        styleFg(theme, "muted", `📜 检索命中 ${d.loreCount ?? 0} 条设定 · ${d.factCount ?? 0} 条事实`),
      ]);
    },
    async execute(_id, params) {
      const state = rt.getState();
      const card = rt.getCard();
      if (!state.active || !card) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const query = String(params.query ?? "").trim();
      const budget = typeof params.token_budget === "number" ? Math.min(2400, Math.max(200, params.token_budget)) : 900;
      const allLore = getAllLoreEntries(rt);

      const loreRes = recallLoreWithGraphPpr({
        entries: allLore,
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
        parts.push(`## Matching Facts\n${matchedFacts.map((f) => `- [T${f.validFromTurn}] ${f.statement}`).join("\n")}`);
      }
      if (matchedHooks.length > 0) {
        parts.push(`## Matching Foresights\n${matchedHooks.map((h) => `- ${h.summary} (${h.triggerHint})`).join("\n")}`);
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

  // 5. rp_era_advance
  pi.registerTool({
    name: "rp_era_advance",
    label: "RP 幕次跃迁",
    description:
      "Advance the narrative era/act, unlock milestones, and optionally advance world time (days/time label) for a montage or chapter break.",
    promptSnippet: "Advance story era/act, unlock milestones, and skip world time.",
    defaultActive: false,
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
    renderCall(args, theme) {
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
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const state = rt.getState();
      if (!state.active) {
        return { isError: true, content: [{ type: "text", text: "RP mode is not active." }] };
      }
      const fromEra = state.era;
      const toEra = String(params.to_era ?? state.era).trim() || state.era;
      const milestones = Array.isArray(params.milestones) ? params.milestones.map(String) : [];
      const montageSummary = typeof params.montage_summary === "string" ? params.montage_summary : "";

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
            text: `Era advanced: ${fromEra} -> ${toEra}${milestones.length ? ` (milestones: ${milestones.join(", ")})` : ""}`,
          },
        ],
        details: { fromEra, toEra, milestones },
      };
    },
  });

  // 6. rp_npc_deliberate
  pi.registerTool({
    name: "rp_npc_deliberate",
    label: "RP NPC 视角隔离推演",
    description:
      "Retrieve an NPC's strictly isolated epistemic view (ONLY facts they witnessed + their own CFSM state and DREAM beliefs) so you can decide their hidden-information reaction without leaking secrets.",
    promptSnippet: "Inspect an NPC's strictly isolated knowledge (FANToM epistemic boundary) before acting.",
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        actor: { type: "string", description: "NPC name/ID" },
        situation: { type: "string", description: "Current prompt or dilemma facing this NPC" },
      },
      required: ["actor"],
    },
    renderCall(args, theme) {
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
    async execute(_id, params) {
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
