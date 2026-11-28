/**
 * Pure-Text World Simulation Engine (v6.5):
 *  1. Spatial Memory Graph (LLM-MapRepair 2026): incremental 1-hop local location topology.
 *  2. NPC Commitments / Promises Ledger (Craft 2026 gap): prevents NPCs from forgetting promises.
 *  3. Dynamic Rumor & Epistemic Propagation (IEEE ToG 2026): bonded NPCs share witnessed secrets.
 *  4. Faction Standing & Heat (Blades in the Dark): political pushback & entanglements.
 *  5. Lightweight Pure-Text Tactical Encounter Frame: stakes, round, and positions only during clashes.
 */

import type {
  ActiveEncounter,
  FactionStanding,
  LocationEdge,
  NpcCommitment,
  RpTxEntry,
  SessionRpState,
} from "../types.js";

export function normalizePlaceName(raw: string): string {
  return raw.replace(/[（(][^）)]*[）)]/g, "").trim();
}

export function makeRouteId(from: string, to: string): string {
  const a = normalizePlaceName(from).toLowerCase();
  const b = normalizePlaceName(to).toLowerCase();
  return [a, b].sort().join("<->");
}

/** Format ONLY the 1-hop spatial neighborhood of the current location (LLM-MapRepair local context). */
export function formatLocalTopology(state: SessionRpState): string | null {
  const cur = normalizePlaceName(state.location);
  if (!cur) return null;
  const curLow = cur.toLowerCase();
  const neighbors: string[] = [];
  for (const edge of Object.values(state.locationGraph)) {
    const aLow = normalizePlaceName(edge.from).toLowerCase();
    const bLow = normalizePlaceName(edge.to).toLowerCase();
    if (aLow === curLow) {
      neighbors.push(`${edge.to}${edge.travelNote ? `(${edge.travelNote})` : ""}`);
    } else if (bLow === curLow && !edge.oneWay) {
      neighbors.push(`${edge.from}${edge.travelNote ? `(${edge.travelNote})` : ""}`);
    }
  }
  if (neighbors.length === 0) return null;
  return neighbors.slice(0, 6).join(", ");
}

/** Select active NPC promises that are due or belong to a currently present NPC after >=3 turns. */
export function selectDueCommitments(state: SessionRpState): NpcCommitment[] {
  const presentLow = new Set(state.presentNpcs.map((n) => n.toLowerCase()));
  const out: NpcCommitment[] = [];
  for (const c of state.commitments.values()) {
    if (c.status !== "active") continue;
    const overdue = c.dueTurn !== undefined && state.turn >= c.dueTurn;
    const presentReminder = presentLow.has(c.actor.toLowerCase()) && state.turn - c.createdTurn >= 3;
    if (overdue || presentReminder) {
      out.push(c);
    }
  }
  return out.slice(0, 3);
}

/**
 * Deterministic zero-LLM Epistemic Propagation:
 * When an NPC who witnessed a non-player-only secret shares the current scene with another NPC
 * with whom they have a positive pair bond (tension >= 20), propagate knowledge naturally.
 * NEVER leaks secrets known exclusively by `"player"`.
 */
export function propagateSecretsOnScene(
  state: SessionRpState,
  commitTx: (tx: RpTxEntry) => void,
): number {
  if (state.presentNpcs.length < 2) return 0;
  let propagated = 0;

  // Build positive bond adjacency among present NPCs
  const trustedNeighbors = new Map<string, string[]>();
  const presentMap = new Map(state.presentNpcs.map((n) => [n.toLowerCase(), n]));
  for (const bond of Object.values(state.pairBonds)) {
    if (bond.tension < 20) continue;
    const aLow = bond.actorA.toLowerCase();
    const bLow = bond.actorB.toLowerCase();
    const aName = presentMap.get(aLow);
    const bName = presentMap.get(bLow);
    if (aName && bName) {
      if (!trustedNeighbors.has(aLow)) trustedNeighbors.set(aLow, []);
      if (!trustedNeighbors.has(bLow)) trustedNeighbors.set(bLow, []);
      trustedNeighbors.get(aLow)!.push(bName);
      trustedNeighbors.get(bLow)!.push(aName);
    }
  }
  if (trustedNeighbors.size === 0) return 0;

  for (const fact of state.facts.values()) {
    if (fact.validUntilTurn !== null || fact.witnessIds === "public") continue;
    if (state.turn - fact.validFromTurn < 2) continue; // Wait at least 2 turns before gossip spreads
    const witnessLow = new Set(fact.witnessIds.map((w) => w.toLowerCase()));
    const newRecipients: string[] = [];
    for (const w of fact.witnessIds) {
      const wl = w.toLowerCase();
      if (wl === "player" || wl === (state.currentPersona?.name ?? "").toLowerCase()) continue;
      const allies = trustedNeighbors.get(wl) ?? [];
      for (const ally of allies) {
        if (!witnessLow.has(ally.toLowerCase()) && !newRecipients.includes(ally)) {
          newRecipients.push(ally);
        }
      }
    }
    if (newRecipients.length > 0) {
      commitTx({
        kind: "fact_spread",
        factId: fact.id,
        newWitnesses: newRecipients,
        via: "bonded_scene",
      });
      propagated += newRecipients.length;
      if (propagated >= 3) break; // Cap per turn to keep world dynamics organic
    }
  }
  return propagated;
}

/** Select factions with high Heat (>=4) or hostile standing (<=-50) for <rp_drama_beat>. */
export function selectFactionPressures(state: SessionRpState): FactionStanding[] {
  const out: FactionStanding[] = [];
  for (const f of Object.values(state.factions)) {
    if (f.lastPressureTurn !== undefined && state.turn - f.lastPressureTurn > 1) continue;
    if (f.heat >= 4 || f.standing <= -50) {
      out.push(f);
    }
  }
  return out.slice(0, 2);
}

/** Format lightweight pure-text tactical encounter frame when an encounter is active. */
export function formatEncounterFrame(enc: ActiveEncounter | null): string | null {
  if (!enc) return null;
  const lines = [
    `<rp_encounter>`,
    `Active Encounter: ${enc.title} (Round ${enc.round}) | Stakes: ${enc.stakes || "survive / prevail"}`,
    ...(enc.combatants.length > 0
      ? [`Positions & Status: ${enc.combatants.map((c) => `${c.name}[${c.position || "engaged"}${c.status ? ` · ${c.status}` : ""}]`).join(" | ")}`]
      : []),
    `Keep action crisp with clear position, effect, and cost (update \`encounter:\` or \`encounter_end\` in [[RP_DELTA]]).`,
    `</rp_encounter>`,
  ];
  return lines.join("\n");
}
