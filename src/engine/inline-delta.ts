/**
 * Single-Model Zero-RTT Inline Delta Sync (`[[RP_DELTA]]...[[/RP_DELTA]]`).
 *
 * Grounded in 2025-2026 LLM creative-writing research:
 *  - Pre-prose forced tool/JSON calls degrade creative prose quality (-17% to -26%) and add extra RTT.
 *  - Post-prose compact custom-delimited blocks preserve literary flow and diversity while enabling
 *    deterministic code-level validation, entity hygiene, stat synonym dedup, and event-sourced `rp:tx` commits.
 *  - Stripped automatically from Zone 2 history & display output so prose history stays 100% pure.
 */

import type { RpTxEntry, SessionRpState } from "../types.js";
import {
  computeCheckedStatValue,
  resolveCanonicalStatKey,
  validateInventoryPatch,
} from "./cfsm.js";
import { canonicalizeActorName, isNonCharacterEntity, sanitizeNpcList } from "./entity-hygiene.js";
import { makeRouteId, normalizePlaceName } from "./world-sim.js";

const DELTA_OPEN_RE = /\[\[RP_DELTA\]\]/i;
const DELTA_FULL_RE = /\[\[RP_DELTA\]\]([\s\S]*?)(?:\[\[\/RP_DELTA\]\]|$)/gi;

export interface ExtractedInlineDelta {
  cleanProse: string;
  rawBlock: string | null;
}

export function extractInlineDelta(text: string): ExtractedInlineDelta {
  if (!text || !DELTA_OPEN_RE.test(text)) {
    return { cleanProse: text, rawBlock: null };
  }
  let lastBlock: string | null = null;
  const cleaned = text.replace(DELTA_FULL_RE, (_m, body: string) => {
    const trimmed = (body ?? "").trim();
    if (trimmed) lastBlock = trimmed;
    return "";
  });
  return {
    cleanProse: cleaned.trimEnd(),
    rawBlock: lastBlock,
  };
}

export function stripInlineDelta(text: string): string {
  if (!text || !DELTA_OPEN_RE.test(text)) return text;
  return text.replace(DELTA_FULL_RE, "").trimEnd();
}

/** Streaming-safe stripper: hides complete [[RP_DELTA]] blocks AND any partial trailing `[[RP_DEL...` prefix. */
export function stripInlineDeltaStreaming(text: string): string {
  if (!text) return text;
  let out = stripInlineDelta(text);
  out = out.replace(/\n*\[(?:\[(?:R(?:P(?:_(?:D(?:E(?:L(?:T(?:A(?:\](?:\])?)?)?)?)?)?)?)?)?)?)?$/i, "");
  return out;
}

export interface ParsedDeltaResult {
  applied: string[];
  txs: RpTxEntry[];
}

function hygieneCtx(state: SessionRpState) {
  return {
    personaName: state.currentPersona?.name,
    knownCharacterNames: [
      ...state.presentNpcs,
      ...Object.keys(state.voiceAnchors),
      ...Object.keys(state.cfsmStates),
    ],
  };
}

/**
 * Parse a compact `[[RP_DELTA]]` block and produce validated deterministic `RpTxEntry[]`.
 * Tolerant of Chinese/English colons, bullet prefixes, and partial/truncated trailing lines.
 */
export function parseAndValidateInlineDelta(
  rawBlock: string,
  state: SessionRpState,
): ParsedDeltaResult {
  const txs: RpTxEntry[] = [];
  const applied: string[] = [];
  const hctx = hygieneCtx(state);

  const lines = rawBlock
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);

  for (const line of lines) {
    const sepIdx = line.search(/[:：]/);
    if (sepIdx <= 0) continue;
    const key = line.slice(0, sepIdx).trim().toLowerCase();
    const val = line.slice(sepIdx + 1).trim();
    if (!val) continue;

    if (key === "loc" || key === "location") {
      const [locPart, npcPart] = val.split("|").map((s) => s.trim());
      const nextLoc = locPart || state.location;
      const nextNpcs = npcPart !== undefined
        ? sanitizeNpcList(
            npcPart
              .split(/[,，、]/)
              .map((s) => s.trim())
              .filter(Boolean),
            hctx,
          )
        : state.presentNpcs;
      txs.push({ kind: "location_set", location: nextLoc, presentNpcs: nextNpcs });
      applied.push(`loc=${nextLoc}`);
      continue;
    }

    if (key === "time" || key === "world_time") {
      txs.push({ kind: "clock_tick", beatDelta: 0, dayDelta: 0, worldTimeLabel: val });
      applied.push(`time=${val}`);
      continue;
    }

    if (key === "stage" || key === "era") {
      if (val !== state.era) {
        txs.push({
          kind: "era_advance",
          fromEra: state.era,
          toEra: val,
          milestoneUnlocked: [],
          montageSummary: "inline_delta",
          turn: state.turn,
        });
        applied.push(`stage=${val}`);
      }
      continue;
    }

    if (key === "obj" || key === "objective" || key === "scene_objective") {
      const cleanObj = /^(?:none|clear|无|清空)$/i.test(val) ? "" : val;
      txs.push({ kind: "scene_objective_set", objective: cleanObj });
      applied.push(`obj=${cleanObj.slice(0, 18) || "(clear)"}`);
      continue;
    }

    if (key === "stat") {
      // e.g. `柳春娘.信任 +5` or `player.体力 = 80`
      const m = /^([^.=]+)\.([^\s=+=-]+)\s*([+=]|-=)\s*(-?\d+(?:\.\d+)?|.+)$/.exec(val)
        ?? /^([^.\s]+)\.([^\s]+)\s+([+-]\d+(?:\.\d+)?)$/.exec(val);
      if (!m) continue;
      const rawActor = m[1]!.trim();
      const rawKey = m[2]!.trim();
      const canonActor = canonicalizeActorName(rawActor, hctx);
      if (!canonActor || (canonActor !== "player" && isNonCharacterEntity(canonActor, hctx))) continue;
      const statKey = resolveCanonicalStatKey(state, canonActor, rawKey);
      let op: "set" | "add" = "add";
      let numOrStr: number | string = 0;
      if (m.length === 4) {
        op = "add";
        numOrStr = Number(m[3]);
      } else {
        const opToken = m[3]!;
        const rhs = m[4]!.trim();
        if (opToken === "=") {
          op = "set";
          numOrStr = /^-?\d+(?:\.\d+)?$/.test(rhs) ? Number(rhs) : rhs;
        } else {
          op = "add";
          const n = Number(rhs);
          numOrStr = opToken === "-=" ? -Math.abs(n) : n;
        }
      }
      const checked = computeCheckedStatValue(state, canonActor, statKey, op, numOrStr);
      if (checked.ok && checked.clampedValue !== undefined) {
        txs.push({ kind: "stat_patch", actorId: canonActor, key: statKey, op, value: checked.clampedValue, reason: "inline_delta" });
        applied.push(`${canonActor}.${statKey}`);
      }
      continue;
    }

    if (key === "inv" || key === "inventory") {
      // e.g. `player.旧腰刀 -1` or `旧腰刀 +1`
      const m = /^(?:([^.\s]+)\.)?(.+?)\s*([+-]\d+)$/.exec(val);
      if (!m) continue;
      const rawActor = (m[1] ?? "player").trim();
      const item = m[2]!.trim();
      const delta = Number(m[3]);
      const canonActor = canonicalizeActorName(rawActor, hctx) || "player";
      if (!item || !Number.isInteger(delta) || delta === 0) continue;
      const check = validateInventoryPatch(state, canonActor, item, delta);
      if (check.ok) {
        txs.push({ kind: "inventory_patch", actorId: canonActor, item, delta });
        applied.push(`inv:${item}${delta > 0 ? `+${delta}` : delta}`);
      }
      continue;
    }

    if (key === "flag") {
      const m = /^([^=]+?)(?:\s*=\s*(true|false|1|0|on|off|开|关))?$/i.exec(val);
      if (!m) continue;
      const flag = m[1]!.trim();
      if (!flag) continue;
      const rawBool = (m[2] ?? "true").toLowerCase();
      const bVal = !["false", "0", "off", "关"].includes(rawBool);
      txs.push({ kind: "flag_set", flag, value: bVal });
      applied.push(`flag:${flag}=${bVal}`);
      continue;
    }

    if (key === "clock") {
      // e.g. `clk_season +1` or `运河封冻 +1/6`
      const m = /^([^\s+-]+)\s*([+-]\d+)(?:\/(\d+))?(?:\s*\|\s*(.+))?$/.exec(val);
      if (!m) continue;
      const cid = m[1]!.trim();
      const delta = Number(m[2]);
      const max = m[3] ? Number(m[3]) : undefined;
      const label = m[4]?.trim();
      if (!cid || !Number.isFinite(delta) || delta === 0) continue;
      // Match by clockId OR existing label
      const matchedClock =
        state.clocks[cid] ??
        Object.values(state.clocks).find((c) => c.label === cid);
      const clockId = matchedClock?.clockId ?? cid;
      txs.push({
        kind: "progress_clock",
        clockId,
        label: label ?? matchedClock?.label ?? cid,
        delta,
        max: max ?? matchedClock?.max ?? 6,
      });
      applied.push(`clock:${matchedClock?.label ?? cid}${delta > 0 ? `+${delta}` : delta}`);
      continue;
    }

    if (key === "storylet_done" || key === "storylet") {
      const st = state.storylets.get(val) ?? Array.from(state.storylets.values()).find((s) => s.title === val);
      if (st && st.status !== "completed") {
        txs.push({ kind: "storylet_upsert", storylet: { ...st, status: "completed" } });
        applied.push(`storylet_done:${st.title}`);
      }
      continue;
    }

    if (key === "fact") {
      let statement = val;
      let witnessIds: "public" | string[] = "public";
      const wMatch = /\[witness(?:es)?[:：]\s*([^\]]+)\]/i.exec(statement);
      if (wMatch) {
        statement = statement.replace(wMatch[0], "").trim();
        const rawW = wMatch[1]!.trim();
        if (!/^(?:public|all|所有人)$/i.test(rawW)) {
          witnessIds = rawW.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        }
      }
      if (!statement) continue;
      const id = `fact_t${state.turn}_d${txs.length}`;
      txs.push({
        kind: "fact_add",
        fact: {
          id,
          statement,
          entities: state.presentNpcs.slice(0, 4),
          witnessIds,
          validFromTurn: state.turn,
          validUntilTurn: null,
        },
      });
      applied.push(`fact:${statement.slice(0, 16)}`);
      continue;
    }

    if (key === "fact_off" || key === "invalidate_fact") {
      if (state.facts.has(val)) {
        txs.push({ kind: "fact_invalidate", factId: val, validUntilTurn: state.turn, reason: "inline_delta" });
        applied.push(`fact_off:${val}`);
      }
      continue;
    }

    if (key === "belief") {
      // e.g. `柳春娘 -> player: 对方并非官府细作 | 见其舍身挡刀`
      const m = /^(.+?)\s*(?:->|→)\s*(.+?)\s*[:：]\s*(.+)$/.exec(val);
      if (!m) continue;
      const actor = canonicalizeActorName(m[1]!.trim(), hctx);
      if (!actor || isNonCharacterEntity(actor, hctx)) continue;
      const target = m[2]!.trim();
      const [beliefText, eventText] = m[3]!.split("|").map((s) => s.trim());
      if (!beliefText) continue;
      txs.push({
        kind: "belief_update",
        actorId: actor,
        target,
        activatingEvent: eventText || "近期互动",
        belief: beliefText,
        turn: state.turn,
      });
      applied.push(`belief:${actor}→${target}`);
      continue;
    }

    if (key === "hook" || key === "foresight") {
      const [summary, hint] = val.split("|").map((s) => s.trim());
      if (!summary) continue;
      const id = `hook_t${state.turn}_d${txs.length}`;
      txs.push({
        kind: "foresight_upsert",
        hook: {
          id,
          summary,
          entities: state.presentNpcs.slice(0, 3),
          plantedTurn: state.turn,
          triggerHint: hint || "",
          status: "open",
        },
      });
      applied.push(`hook:${summary.slice(0, 16)}`);
      continue;
    }

    if (key === "hook_done") {
      const existing = state.foresights.get(val);
      if (existing && existing.status === "open") {
        txs.push({ kind: "foresight_upsert", hook: { ...existing, status: "paid_off" } });
        applied.push(`hook_done:${val}`);
      }
      continue;
    }

    if (key === "echo" || key === "consequence") {
      // e.g. `当街喊反清复明 -> 暗桩开始排查 [weight: high] [entities: 提灯先生, 德州城]`
      let body = val;
      let weight: "low" | "medium" | "high" = "medium";
      let entities: string[] = [...state.presentNpcs.slice(0, 3), ...(state.location ? [state.location] : [])];
      const wM = /\[weight[:：]\s*(low|medium|high)\]/i.exec(body);
      if (wM) {
        weight = wM[1]!.toLowerCase() as "low" | "medium" | "high";
        body = body.replace(wM[0], "").trim();
      }
      const eM = /\[entities[:：]\s*([^\]]+)\]/i.exec(body);
      if (eM) {
        entities = eM[1]!.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        body = body.replace(eM[0], "").trim();
      }
      const arrowParts = body.split(/(?:->|→)/).map((s) => s.trim());
      const choice = arrowParts[0] || body;
      const consequence = arrowParts[1] || body;
      const id = `echo_t${state.turn}_d${txs.length}`;
      txs.push({
        kind: "consequence_upsert",
        echo: {
          id,
          choice,
          consequence,
          entities,
          weight,
          plantedTurn: state.turn,
          status: "pending",
        },
      });
      applied.push(`echo:${choice.slice(0, 14)}`);
      continue;
    }

    if (key === "echo_done") {
      const existing = state.consequences.get(val);
      if (existing && existing.status !== "resolved") {
        txs.push({ kind: "consequence_upsert", echo: { ...existing, status: "resolved", echoedTurn: state.turn } });
        applied.push(`echo_done:${val}`);
      }
      continue;
    }

    if (key === "route" || key === "map") {
      const [edgePart, travelPart] = val.split("|").map((s) => s.trim());
      const oneWay = !edgePart?.includes("<->") && !edgePart?.includes("↔");
      const nodes = (edgePart ?? "").split(/(?:<->|↔|->|→)/).map((s) => normalizePlaceName(s));
      if (nodes.length >= 2 && nodes[0] && nodes[1]) {
        const rid = makeRouteId(nodes[0], nodes[1]);
        txs.push({
          kind: "route_upsert",
          edge: { id: rid, from: nodes[0], to: nodes[1], travelNote: travelPart || undefined, oneWay, discoveredTurn: state.turn },
        });
        applied.push(`route:${nodes[0]}↔${nodes[1]}`);
      }
      continue;
    }

    if (key === "promise" || key === "commitment") {
      const m = /^(.+?)\s*(?:->|→)\s*(.+?)\s*[:：]\s*(.+)$/.exec(val);
      if (!m) continue;
      const actor = canonicalizeActorName(m[1]!.trim(), hctx);
      if (!actor || isNonCharacterEntity(actor, hctx)) continue;
      const target = m[2]!.trim();
      const [promiseText, duePart] = m[3]!.split("|").map((s) => s.trim());
      if (!promiseText) continue;
      let dueTurn: number | undefined;
      let dueLabel: string | undefined;
      if (duePart) {
        const tm = /T?(\d+)/i.exec(duePart);
        if (tm) dueTurn = Number(tm[1]);
        dueLabel = duePart.replace(/^due[:：]\s*/i, "").trim();
      }
      const id = `prom_t${state.turn}_d${txs.length}`;
      txs.push({
        kind: "commitment_upsert",
        commitment: { id, actor, target, promise: promiseText, dueTurn, dueLabel, createdTurn: state.turn, status: "active" },
      });
      applied.push(`promise:${actor}`);
      continue;
    }

    if (key === "promise_done" || key === "promise_broken") {
      const existing = state.commitments.get(val);
      if (existing && existing.status === "active") {
        txs.push({
          kind: "commitment_upsert",
          commitment: { ...existing, status: key === "promise_done" ? "fulfilled" : "broken" },
        });
        applied.push(`${key}:${val}`);
      }
      continue;
    }

    if (key === "spread" || key === "rumor") {
      const m = /^([^\s->→]+)\s*(?:->|→)\s*(.+)$/.exec(val);
      if (m && state.facts.has(m[1]!.trim())) {
        const newWitnesses = m[2]!.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
        if (newWitnesses.length > 0) {
          txs.push({ kind: "fact_spread", factId: m[1]!.trim(), newWitnesses, via: "inline_delta" });
          applied.push(`spread:${m[1]!.trim()}`);
        }
      }
      continue;
    }

    if (key === "faction") {
      const [head, note] = val.split("|").map((s) => s.trim());
      const nameMatch = /^([^\s]+)(.*)$/.exec(head ?? "");
      if (!nameMatch) continue;
      const name = nameMatch[1]!.trim();
      const rest = nameMatch[2] ?? "";
      const prev = state.factions[name];
      let standing = prev?.standing ?? 0;
      let heat = prev?.heat ?? 0;
      const stM = /standing\s*=\s*([+-]?)(\d+)/i.exec(rest);
      if (stM) {
        const n = Number(stM[2]);
        standing = stM[1] === "+" ? standing + n : stM[1] === "-" ? (prev ? standing - n : -n) : n;
      }
      const htM = /heat\s*=\s*([+-]?)(\d+)/i.exec(rest);
      if (htM) {
        const n = Number(htM[2]);
        heat = htM[1] === "+" ? heat + n : htM[1] === "-" ? heat - n : n;
      }
      const stance = standing <= -50 ? "敌对" : standing <= -15 ? "戒备" : standing >= 50 ? "盟友" : standing >= 15 ? "友善" : "中立";
      txs.push({
        kind: "faction_upsert",
        faction: { name, standing, heat, stance, note: note || prev?.note, updatedTurn: state.turn },
      });
      applied.push(`faction:${name}`);
      continue;
    }

    if (key === "encounter") {
      if (/^(?:end|off|none|结束)$/i.test(val)) {
        txs.push({ kind: "encounter_set", encounter: null });
        applied.push("encounter:end");
        continue;
      }
      const parts = val.split("|").map((s) => s.trim()).filter(Boolean);
      const title = parts[0] || "遭遇战";
      let stakes = state.encounter?.stakes ?? "";
      const combatants: Array<{ name: string; position?: string; status?: string }> = [];
      for (const p of parts.slice(1)) {
        if (/^stakes\s*=/i.test(p)) {
          stakes = p.replace(/^stakes\s*=/i, "").trim();
        } else {
          for (const item of p.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)) {
            const cm = /^([^（(]+?)(?:[（(]([^）)]+)[）)])?$/.exec(item);
            if (cm) combatants.push({ name: cm[1]!.trim(), position: cm[2]?.trim() });
          }
        }
      }
      txs.push({
        kind: "encounter_set",
        encounter: {
          title,
          stakes,
          round: state.encounter?.title === title ? state.encounter.round : 1,
          combatants: combatants.length > 0 ? combatants : (state.encounter?.combatants ?? []),
          startedTurn: state.encounter?.startedTurn ?? state.turn,
        },
      });
      applied.push(`encounter:${title}`);
      continue;
    }

    if (key === "encounter_end") {
      txs.push({ kind: "encounter_set", encounter: null });
      applied.push("encounter:end");
      continue;
    }

    if (key === "phys" || key === "physical") {
      // e.g. `player | pose=双手反绑 | held=无 | outfit=湿透粗布衫`
      const parts = val.split("|").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const actor = canonicalizeActorName(parts[0]!, hctx);
      if (!actor || (actor !== "player" && isNonCharacterEntity(actor, hctx))) continue;
      const snap: Record<string, string | number> = { actorId: actor, updatedTurn: state.turn };
      for (const seg of parts.slice(1)) {
        const eq = seg.indexOf("=");
        if (eq <= 0) continue;
        const field = seg.slice(0, eq).trim().toLowerCase();
        const fv = seg.slice(eq + 1).trim();
        if (field === "outfit" || field === "着装") snap.outfit = fv;
        else if (field === "pose" || field === "posture" || field === "姿态") snap.posture = fv;
        else if (field === "held" || field === "holding" || field === "手持") snap.holding = fv;
        else if (field === "pos" || field === "position" || field === "站位") snap.position = fv;
        else if (field === "condition" || field === "状态") snap.condition = fv;
      }
      txs.push({
        kind: "physical_patch",
        snapshot: snap as { actorId: string; updatedTurn: number; outfit?: string; posture?: string; holding?: string; position?: string; condition?: string },
      });
      applied.push(`phys:${actor}`);
      continue;
    }
  }

  return { applied, txs };
}
