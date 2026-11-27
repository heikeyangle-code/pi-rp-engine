import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piRpEngine from "../src/index.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { RP_ENTRY_TYPE, createInitialRpState, replayBranchState, applyRpTx } from "../src/engine/state-replay.js";
import { buildZone1FrozenPrefix, buildZone3TransientTail, attachZone3ToMessages } from "../src/context/zone-builder.js";
import { recallLoreWithGraphPpr, tickLoreRuntime } from "../src/memory/graph-ppr.js";
import { evaluateGate, partitionEpistemicFacts } from "../src/engine/gates.js";
import { saveCompiledCard, saveProjectWorldConfig, getProjectRpDir } from "../src/storage/workspace-store.js";
import type {
  PiCommandDefinition,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  PiSessionEntry,
  PiToolDefinition,
  RpTxEntry,
} from "../src/types.js";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function makeSampleCard() {
  return compileCharacterCard(
    {
      spec: "chara_card_v3",
      data: {
        name: "黑水",
        nickname: "黑水",
        system_prompt: "你是关东大地，保持冷峻白描。",
        description: "1890s 至 1930s 的东北冻土。",
        personality: "沉默、残酷、只呈现。",
        scenario: "光绪二十四年，山东大旱，闯关东前夜。",
        mes_example: "<START>\n{{user}}: 往前走多远？\n{{char}}: 雪没过脚踝，风从北边灌过来。",
        post_history_instructions: "每轮至少一个感官锚点，不报纪元名。",
        first_mes: "光绪二十四年，山东大旱。",
        character_book: {
          token_budget: 1800,
          entries: [
            {
              id: "core_tone",
              comment: "极寒底色",
              constant: true,
              position: 0,
              content: "极寒与暴风雪贯穿全篇。",
            },
            {
              id: "act2_railway",
              comment: "中东铁路（二幕机密）",
              keys: ["铁路", "蒸汽机车"],
              extensions: { gate: { requiredEra: "Act II" } },
              content: "ACT2_SECRET_RAILWAY_LORE",
            },
            {
              id: "laojingou",
              comment: "老金沟",
              keys: ["老金沟"],
              sticky: 2,
              cooldown: 2,
              content: "老金沟盛产金砂，李掌柜把持着当地的淘金帮。",
            },
            {
              id: "li_boss",
              comment: "李掌柜",
              keys: ["李掌柜"],
              content: "李掌柜暗中往绥芬河走私砂金，脾气阴晴不定。",
            },
            {
              id: "selective_not_any",
              comment: "夜路禁忌",
              keys: ["夜路"],
              secondary_keys: ["白昼"],
              selective: true,
              selectiveLogic: 2, // NOT_ANY
              content: "老林子走夜路忌讳回头。",
            },
          ],
        },
      },
    },
    "v3",
  );
}

describe("Phase 2 · Session Tree Event Sourcing & Branch Rewind", () => {
  it("rolls back stats, inventory, era, bi-temporal facts, and sticky counts identically on branch rewind", () => {
    const entries: PiSessionEntry[] = [];
    const pushTx = (id: string, tx: RpTxEntry) => {
      entries.push({ id, type: "custom", customType: RP_ENTRY_TYPE, data: tx });
    };

    pushTx("e1", {
      kind: "bind",
      cardId: "heishui",
      cardSlug: "heishui",
      cardSource: "project",
      worldDir: "/tmp/world",
      greetingIndex: 0,
      activeCharacters: ["heishui"],
    });
    pushTx("e2", { kind: "stat_patch", actorId: "player", key: "hp", op: "set", value: 100, min: 0, max: 100 });
    pushTx("e3", { kind: "inventory_patch", actorId: "player", item: "窝头", delta: 3 });
    pushTx("e4", {
      kind: "fact_add",
      fact: {
        id: "f1",
        statement: "李掌柜目前是盟友",
        entities: ["李掌柜"],
        validFromTurn: 1,
        validUntilTurn: null,
        witnessIds: "public",
      },
    });
    pushTx("e5", { kind: "lore_runtime", sticky: { laojingou: 2 }, cooldown: {}, consumedOneShots: [] });
    // Snapshot at Turn 8 (branch point)
    const branchAtTurn8 = entries.slice();

    // Advance to Turn 20: take damage, eat food, advance era, invalidate fact f1
    pushTx("e6", { kind: "stat_patch", actorId: "player", key: "hp", op: "add", value: -45 });
    pushTx("e7", { kind: "inventory_patch", actorId: "player", item: "窝头", delta: -2 });
    pushTx("e8", {
      kind: "era_advance",
      fromEra: "Act I",
      toEra: "Act II",
      milestoneUnlocked: ["crossed_border"],
      montageSummary: "越过柳条边",
      turn: 15,
    });
    pushTx("e9", { kind: "fact_invalidate", factId: "f1", validUntilTurn: 18, reason: "betrayed" });

    const stateAt20 = replayBranchState(entries);
    assert.equal(stateAt20.stats.player?.hp, 55);
    assert.equal(stateAt20.inventory.player?.["窝头"], 1);
    assert.equal(stateAt20.era, "Act II");
    assert.equal(stateAt20.facts.get("f1")?.validUntilTurn, 18);

    // Rewind to branch point Turn 8 -> 100% deterministic rollback
    const stateRewound = replayBranchState(branchAtTurn8);
    assert.equal(stateRewound.stats.player?.hp, 100);
    assert.equal(stateRewound.inventory.player?.["窝头"], 3);
    assert.equal(stateRewound.era, "Act I");
    assert.equal(stateRewound.facts.get("f1")?.validUntilTurn, null);
    assert.equal(stateRewound.loreSticky.laojingou, 2);
  });
});

describe("Phase 2 · KV-Cache Byte Invariance & Physical Era/Epistemic Isolation", () => {
  it("keeps Zone 1 byte-identical across 20 turns and never mutates Zone 2 history", () => {
    const card = makeSampleCard();
    const state = createInitialRpState();
    state.active = true;
    state.initialPersona = { id: "p1", name: "阿明", description: "逃荒少年" };
    state.currentPersona = { ...state.initialPersona };

    const zone1Initial = buildZone1FrozenPrefix({ card, initialPersona: state.initialPersona });
    const zone1Hash = sha256(zone1Initial);

    const history: PiMessage[] = [];
    for (let turn = 1; turn <= 20; turn++) {
      applyRpTx(state, { kind: "clock_tick", beatDelta: 1 });
      applyRpTx(state, { kind: "stat_patch", actorId: "player", key: "hp", op: "set", value: 100 - turn });

      // Zone 1 must remain 100% byte-identical even as stats, turn, and persona change!
      if (turn === 10) {
        applyRpTx(state, { kind: "persona_set", persona: { id: "p2", name: "老猎户", description: "换装" } });
      }
      const z1 = buildZone1FrozenPrefix({ card, initialPersona: state.initialPersona });
      assert.equal(sha256(z1), zone1Hash, `Zone 1 hash drifted at turn ${turn}`);

      history.push({ role: "user", content: `第${turn}轮行动` });
      const snapshotBefore = history.slice(0, -1).map((m) => m.content);

      const z3 = buildZone3TransientTail({ card, state, recalledLore: [], recentText: `第${turn}轮行动` });
      const outbound = attachZone3ToMessages(history, z3, state.hiddenEntryIds);

      // Zone 2 (all prior messages) must remain 100% untouched
      assert.deepEqual(
        outbound.slice(0, -1).map((m) => m.content),
        snapshotBefore,
      );
      // Persisted history's last message must also remain clean (Zone 3 never persisted)
      assert.equal(history[history.length - 1]!.content, `第${turn}轮行动`);
      assert.ok(String(outbound[outbound.length - 1]!.content).includes("<rp_state_frame>"));

      history.push({ role: "assistant", content: `第${turn}轮回复` });
    }
  });

  it("physically blocks Act II lore in Act I and isolates NPC epistemic blind spots", () => {
    const card = makeSampleCard();
    const state = createInitialRpState();
    state.active = true;
    state.era = "Act I";
    state.presentNpcs = ["月兰", "雁翎"];

    // Act II secret lore MUST NOT appear in Act I even when user says "铁路 蒸汽机车"
    const act1Recall = recallLoreWithGraphPpr({
      entries: card.loreBook.entries,
      state,
      recentText: "我想打听铁路和蒸汽机车的事",
      tokenBudget: 1800,
    });
    assert.equal(
      act1Recall.selected.some((e) => e.id === "act2_railway"),
      false,
    );

    // Advance to Act II -> gate unlocks
    state.era = "Act II";
    assert.equal(evaluateGate({ requiredEra: "Act II" }, state), true);
    const act2Recall = recallLoreWithGraphPpr({
      entries: card.loreBook.entries,
      state,
      recentText: "铁路和蒸汽机车",
      tokenBudget: 1800,
    });
    assert.equal(
      act2Recall.selected.some((e) => e.id === "act2_railway"),
      true,
    );

    // Epistemic visibility: secret witnessed only by 月兰 must be marked blind spot for 雁翎
    const { known, blindSpots } = partitionEpistemicFacts(
      [
        {
          id: "pub",
          statement: "大雪封山了",
          entities: ["大雪"],
          validFromTurn: 1,
          validUntilTurn: null,
          witnessIds: "public",
        },
        {
          id: "sec",
          statement: "玩家偷偷藏了半袋金砂",
          entities: ["金砂"],
          validFromTurn: 2,
          validUntilTurn: null,
          witnessIds: ["月兰"],
        },
      ],
      ["月兰", "雁翎"],
    );
    assert.equal(known.length, 1);
    assert.equal(blindSpots.length, 1);
    assert.deepEqual(blindSpots[0]!.ignorantNpcs, ["雁翎"]);
  });
});

describe("Phase 3 · Local BM25 + 2-Hop PPR Entity Graph & World Info Matrix", () => {
  it("recalls 2-hop connected lore (老金沟 -> 李掌柜), honors NOT_ANY, sticky & cooldown", () => {
    const card = makeSampleCard();
    const state = createInitialRpState();
    state.active = true;

    // Mentioning ONLY "老金沟" should pull both "老金沟" (hop 1) AND "李掌柜" (hop 2 via entity graph)!
    const r1 = recallLoreWithGraphPpr({
      entries: card.loreBook.entries,
      state,
      recentText: "我们准备明天动身去老金沟",
      tokenBudget: 1800,
    });
    const ids1 = r1.selected.map((e) => e.id);
    assert.ok(ids1.includes("laojingou"), "Direct key hit expected");
    assert.ok(ids1.includes("li_boss"), "2-hop PPR associative recall expected");
    assert.equal(r1.nextSticky.laojingou, 2);

    // NOT_ANY selectiveLogic: "夜路" triggers when "白昼" absent, blocked when "白昼" present
    const rNight = recallLoreWithGraphPpr({
      entries: card.loreBook.entries,
      state,
      recentText: "今晚要不要走夜路",
      tokenBudget: 1800,
    });
    assert.ok(rNight.selected.some((e) => e.id === "selective_not_any"));

    const rDay = recallLoreWithGraphPpr({
      entries: card.loreBook.entries,
      state,
      recentText: "白昼走夜路不怕",
      tokenBudget: 1800,
    });
    assert.equal(rDay.selected.some((e) => e.id === "selective_not_any"), false);

    // Sticky expiry transitions into cooldown
    const t1 = tickLoreRuntime(card.loreBook.entries, { laojingou: 2 }, {});
    assert.equal(t1.sticky.laojingou, 1);
    const t2 = tickLoreRuntime(card.loreBook.entries, t1.sticky, t1.cooldown);
    assert.equal(t2.sticky.laojingou, undefined);
    assert.equal(t2.cooldown.laojingou, 2);
  });
});

describe("Phase 4 · End-to-End Mock Pi 1.6.1 Extension Integration", () => {
  it("stays 100% dormant in non-RP workspace, activates cleanly in RP workspace, and isolates OOC turns", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-test-"));
    try {
      const handlers = new Map<string, Array<(e: any, ctx: PiExtensionContext) => any>>();
      const registeredTools = new Map<string, PiToolDefinition>();
      const commands = new Map<string, PiCommandDefinition>();
      const branch: PiSessionEntry[] = [];
      let activeTools = ["bash", "read", "edit"];
      let statusVal: string | undefined;
      let widgetVal: unknown;

      const mockPi: PiExtensionAPI = {
        on(event, fn) {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(fn);
        },
        registerTool(t) {
          registeredTools.set(t.name, t);
        },
        registerCommand(name, def) {
          commands.set(name, def);
        },
        getActiveTools: () => activeTools,
        setActiveTools: (names) => {
          activeTools = [...names];
        },
        appendEntry(customType, data) {
          branch.push({ id: `ent_${branch.length + 1}`, type: "custom", customType, data });
        },
        sendMessage() {},
      };

      const mockCtx: PiExtensionContext = {
        cwd: tmpDir,
        ui: {
          notify() {},
          setStatus(_k, v) {
            statusVal = v;
          },
          setWidget(_k, v) {
            widgetVal = v;
          },
          async select(_t, opts) {
            return opts[0];
          },
          async confirm() {
            return true;
          },
          async input() {
            return "";
          },
          async editor() {
            return "";
          },
          setEditorText() {},
        },
        sessionManager: {
          getBranch: () => branch,
          getEntries: () => branch,
          getLeafId: () => branch[branch.length - 1]?.id ?? null,
        },
      };

      piRpEngine(mockPi);

      // All 6 tools registered with defaultActive: false
      assert.equal(registeredTools.size, 6);
      for (const tool of registeredTools.values()) {
        assert.equal(tool.defaultActive, false);
      }
      assert.ok(commands.has("rp"));

      // 1. Non-RP workspace -> 100% dormant (0 tools changed, 0 systemPrompt, 0 UI)
      handlers.get("session_start")!.forEach((fn) => fn({ reason: "startup" }, mockCtx));
      assert.deepEqual(activeTools, ["bash", "read", "edit"]);
      assert.equal(statusVal, undefined);
      assert.equal(handlers.get("before_agent_start")![0]!({}, mockCtx), undefined);

      // 2. Save a card + project world.json -> session_start activates RP mode & switches to 6 RP tools
      const card = makeSampleCard();
      saveCompiledCard({ baseDir: getProjectRpDir(tmpDir), card, rawJson: {} });
      saveProjectWorldConfig(tmpDir, { defaultCardSlug: card.slug, activeCharacters: [card.slug] });

      handlers.get("session_start")!.forEach((fn) => fn({ reason: "new" }, mockCtx));
      assert.equal(activeTools.length, 6);
      assert.ok(activeTools.includes("rp_roll_check"));
      assert.ok(String(statusVal ?? "").includes("黑水"));

      // 3. OOC turn `((...))` transforms input and does NOT advance turn counter
      const oocRes = handlers.get("input")![0]!({ text: "((稍微放慢节奏))" }, mockCtx);
      assert.equal(oocRes.action, "transform");
      handlers.get("turn_end")![0]!({ message: { role: "assistant", content: "好的，已放慢节奏。" } }, mockCtx);
      assert.equal(replayBranchState(branch, { worldDir: getProjectRpDir(tmpDir), config: { defaultCardSlug: card.slug } }).turn, 0);

      // 4. Normal turn advances turn counter and invokes rp_roll_check cleanly
      handlers.get("input")![0]!({ text: "我推开大车店的门" }, mockCtx);
      const roll = await registeredTools.get("rp_roll_check")!.execute("call_1", { expression: "1d20+2", dc: 10 }, undefined, undefined, mockCtx);
      assert.ok((roll.content[0] as { text: string }).text.includes("🎲"));
      handlers.get("turn_end")![0]!({ message: { role: "assistant", content: "门轴吱呀一声响。" } }, mockCtx);
      assert.equal(replayBranchState(branch, { worldDir: getProjectRpDir(tmpDir), config: { defaultCardSlug: card.slug } }).turn, 1);

      // 5. `/rp off` restores original coding tools & clears HUD
      await commands.get("rp")!.handler("off", mockCtx);
      assert.deepEqual(activeTools, ["bash", "read", "edit"]);
      assert.equal(statusVal, undefined);
      assert.equal(widgetVal, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
