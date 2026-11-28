import test from "node:test";
import assert from "node:assert/strict";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { extractPlainTextAnchors, extractPlainTextStats } from "../src/parser/world-profile.js";
import { applyAnalyzedProfileToCard, parseAnalyzeResponse } from "../src/parser/analyzer.js";
import { createInitialRpState, applyRpTx } from "../src/engine/state-replay.js";
import { formatRpStatusLine } from "../src/ui/hud.js";
import { buildZone3TransientTail } from "../src/context/zone-builder.js";
import { runSidecarLightSettlement } from "../src/engine/settlement.js";
import type { PiExtensionAPI, PiExtensionContext, RpTxEntry } from "../src/types.js";

test("Universal semantics: plain companion card omits Act I / Day 1 from HUD and Zone 3", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: {
        name: "林晚",
        description: "温柔的书店老板，喜欢在雨天煮红茶。",
        scenario: "周五傍晚的小书店。",
        first_mes: "门铃响了一声，她抬头对你笑了笑。",
      },
    },
    "v2",
  );

  assert.equal(card.worldProfile?.modules.stages, false);
  assert.equal(card.worldProfile?.initialStage, undefined);

  const state = createInitialRpState();
  state.active = true;
  state.cardSlug = card.slug;
  if (card.worldProfile) {
    applyRpTx(state, {
      kind: "profile_apply",
      archetype: card.worldProfile.archetype,
      modules: card.worldProfile.modules,
      initialStage: card.worldProfile.initialStage,
      initialTime: card.worldProfile.initialTime,
    });
  }

  const statusLine = formatRpStatusLine(state, card);
  assert.equal(statusLine.includes("Act I"), false);
  assert.equal(statusLine.includes("Day 1"), false);
  assert.equal(statusLine, "◆ 林晚 · T0");

  const z3 = buildZone3TransientTail({ card, state, recalledLore: [], recentText: "你好" });
  assert.equal(z3.includes("Act I"), false);
  assert.equal(z3.includes("Day 1"), false);
});

test("L0 zero-cost extractor pulls explicit plain-text stage, time, location, and bounded stats", () => {
  const scenario = [
    "【当前纪元·纪元一：蛮荒与金砂】",
    "对应时间：光绪二十四年冬",
    "玩家初始位置：山东老家 → 准备出关",
    "体力：80/100 · 好感度：15",
  ].join("\n");

  const anchors = extractPlainTextAnchors({ scenario });
  assert.equal(anchors.initialStage, "纪元一：蛮荒与金砂");
  assert.equal(anchors.initialTime, "光绪二十四年冬");
  assert.equal(anchors.initialLocation, "山东老家");

  const stats = extractPlainTextStats(scenario);
  const byKey = new Map(stats.map((s) => [s.key, s]));
  assert.equal(byKey.get("体力")?.initialValue, 80);
  assert.equal(byKey.get("体力")?.max, 100);
  assert.equal(byKey.get("好感度")?.initialValue, 15);
});

test("L1 /rp analyze parser extracts profile, propagates entity aliases to lorebook, and applies spoiler gates", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v3",
      data: {
        name: "黑水",
        description: "关东大地",
        first_mes: "你收拾了半袋杂面窝头和一把柴刀。",
        character_book: {
          entries: [
            { id: "e_boss", comment: "李掌柜", keys: ["李掌柜"], content: "老金沟的掌柜。" },
            { id: "e_late", comment: "纪元二铁路", keys: ["铁路"], content: "中东铁路通车后的剧变。" },
          ],
        },
      },
    },
    "v3",
  );

  const mockJson = JSON.stringify({
    archetype: "epic-saga",
    modules: { stats: true, inventory: true, clocks: true, stages: true },
    initialLocation: "山东老家",
    initialTime: "光绪二十四年",
    initialStage: "纪元一：拓荒期",
    initialPresentNpcs: ["村长"],
    initialInventory: [{ item: "杂面窝头", count: 1 }, { item: "柴刀", count: 1 }],
    initialStats: [{ key: "体力", initialValue: 90, min: 0, max: 100 }],
    suggestedCfsmAxes: [{ axis: "信任", states: ["戒备", "试探", "信任"], initial: "戒备" }],
    entityAliases: { 李掌柜: ["淘金帮主", "老李"] },
    suggestedLoreGates: [{ entryId: "e_late", requiredEra: "纪元二", reason: "后期铁路事件" }],
  });

  const parsed = parseAnalyzeResponse(mockJson, card);
  assert.ok(parsed);
  assert.equal(parsed!.profile.archetype, "epic-saga");
  assert.equal(parsed!.profile.initialInventory.length, 2);
  assert.equal(parsed!.initialStats[0]?.key, "体力");

  applyAnalyzedProfileToCard(card, parsed!.profile, true);
  const bossEntry = card.loreBook.entries.find((e) => e.id === "e_boss")!;
  assert.ok(bossEntry.entities.includes("淘金帮主"));
  const lateEntry = card.loreBook.entries.find((e) => e.id === "e_late")!;
  assert.equal(lateEntry.gate?.requiredEra, "纪元二");
});

test("L2 closed-loop sidecar-light invalidates old facts, updates spatio-temporal anchors, and obeys module gating", async () => {
  const state = createInitialRpState();
  state.active = true;
  state.settlementMode = "sidecar-light";
  state.turn = 5;
  state.modules = { stats: false, inventory: false, clocks: false, stages: false };
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "fact_old",
      statement: "李掌柜是可靠盟友",
      entities: ["李掌柜"],
      validFromTurn: 1,
      validUntilTurn: null,
      witnessIds: "public",
    },
  });

  const appended: RpTxEntry[] = [];
  const mockPi = {
    appendEntry(_type: string, data: unknown) {
      appended.push(data as RpTxEntry);
    },
  } as unknown as PiExtensionAPI;

  const mockCtx = {
    cwd: "/tmp",
    model: { id: "mock-fast" },
    modelRegistry: {
      async complete() {
        return {
          text: JSON.stringify({
            location: "老金沟客栈",
            presentNpcs: ["月兰"],
            worldTimeLabel: "深冬子夜",
            invalidatedFactIds: [{ id: "fact_old", reason: "李掌柜已背叛" }],
            facts: [{ statement: "李掌柜暗中出卖了玩家", entities: ["李掌柜"], public: true }],
            // Even if model hallucinates inventory on a companion card, module gating must block it
            inventory: [{ actorId: "player", item: "神剑", delta: 1 }],
          }),
        };
      },
    },
  } as unknown as PiExtensionContext;

  const committed = await runSidecarLightSettlement({
    pi: mockPi,
    ctx: mockCtx,
    state,
    lastUserText: "我推开客栈的门",
    lastAssistantText: "月兰压低声音说，李掌柜已经把你卖了。",
  });

  assert.ok(committed >= 4);
  assert.equal(state.location, "老金沟客栈");
  assert.deepEqual(state.presentNpcs, ["月兰"]);
  assert.equal(state.worldTimeLabel, "深冬子夜");
  assert.equal(state.facts.get("fact_old")?.validUntilTurn, 5);
  assert.equal(Object.keys(state.inventory).length, 0, "Inventory must remain blocked when modules.inventory is false");
});

test("HUD full mode renders CFSM, inventory, foresights, and mobile-safe footer without Act I / Day 1", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: { name: "林晚", description: "书店老板", scenario: "书店", first_mes: "欢迎" },
    },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  state.hudMode = "full";
  state.archetype = "mystery";
  state.modules = { stats: true, inventory: true, clocks: true, stages: false };
  applyRpTx(state, { kind: "cfsm_define", actorId: "林晚", def: { axis: "信任", states: ["戒备", "信任"], initial: "戒备" } });
  applyRpTx(state, { kind: "inventory_patch", actorId: "player", item: "铜钥匙", delta: 1 });
  applyRpTx(state, {
    kind: "foresight_upsert",
    hook: { id: "h1", summary: "密室暗门", entities: ["书店"], plantedTurn: 1, triggerHint: "书架", status: "open" },
  });
  // beatDelta=0 clock_tick must NOT increment turn or burn note TTL
  applyRpTx(state, { kind: "note_set", note: { id: "n1", text: "保持悬疑", remainingTurns: 2 } });
  applyRpTx(state, { kind: "clock_tick", beatDelta: 0, worldTimeLabel: "深秋雨夜" });
  assert.equal(state.turn, 0);
  assert.equal(state.notes[0]?.remainingTurns, 2);

  const statusLine = formatRpStatusLine(state, card);
  assert.ok(statusLine.includes("深秋雨夜"));
  assert.ok(statusLine.includes("伏笔:1"));
  assert.equal(statusLine.includes("Act I"), false);
});

test("Zone 3 applies List-First Epistemic Boundaries and NARRA-Gym anti-stagnation only on non-companion cards", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: { name: "侦探", description: "推理解谜", scenario: "古宅", first_mes: "门锁上了。" },
    },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  state.archetype = "mystery";
  state.turn = 5;
  state.presentNpcs = ["管家"];
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "f_secret",
      statement: "玩家藏起了遗嘱原件",
      entities: ["遗嘱"],
      validFromTurn: 2,
      validUntilTurn: null,
      witnessIds: ["旅人"],
    },
  });

  const z3Mystery = buildZone3TransientTail({ card, state, recalledLore: [], recentText: "遗嘱" });
  assert.ok(z3Mystery.includes("[HIDDEN FROM: 管家] 玩家藏起了遗嘱原件"));
  assert.ok(z3Mystery.includes("Anti-stagnation cue"));

  state.archetype = "companion";
  const z3Companion = buildZone3TransientTail({ card, state, recalledLore: [], recentText: "你好" });
  assert.equal(z3Companion.includes("Anti-stagnation cue"), false);
});

test("ModelRegistry helper prefers official streamSimple().result() with timestamp and AbortSignal", async () => {
  const state = createInitialRpState();
  state.active = true;
  state.settlementMode = "sidecar-light";
  state.turn = 2;
  const appended: RpTxEntry[] = [];
  let sawTimestamp = false;
  let sawStreamSimple = false;
  const mockPi = {
    appendEntry(_type: string, data: unknown) {
      appended.push(data as RpTxEntry);
    },
  } as unknown as PiExtensionAPI;
  const mockCtx = {
    cwd: "/tmp",
    model: { id: "fast-model" },
    modelRegistry: {
      streamSimple(_model: unknown, context: { messages: Array<{ timestamp?: number }> }) {
        sawStreamSimple = true;
        sawTimestamp = typeof context.messages[0]?.timestamp === "number";
        return {
          async result() {
            return { content: [{ type: "text", text: JSON.stringify({ location: "北门茶馆" }) }] };
          },
        };
      },
    },
  } as unknown as PiExtensionContext;

  const committed = await runSidecarLightSettlement({
    pi: mockPi,
    ctx: mockCtx,
    state,
    lastUserText: "我去北门茶馆",
    lastAssistantText: "你推门走进北门茶馆。",
  });
  assert.equal(sawStreamSimple, true);
  assert.equal(sawTimestamp, true);
  assert.ok(committed >= 1);
  assert.equal(state.location, "北门茶馆");
});

test("Forum workflows: actionImpersonate prefills editor via setEditorText without mutating session, actionSidePrompt is zero-pollution", async () => {
  const { actionImpersonate, actionSidePrompt } = await import("../src/ui/actions.js");
  const card = compileCharacterCard(
    { spec: "chara_card_v2", data: { name: "林晚", description: "书店老板", scenario: "小书店", first_mes: "欢迎。" } },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  state.cardSlug = card.slug;
  state.location = "旧书店";

  let editorPrefill = "";
  let sideEditorTitle = "";
  let sideEditorText = "";
  let txCount = 0;
  let sentCount = 0;

  const mockRt = {
    pi: {
      sendMessage() {
        sentCount++;
      },
    } as unknown as PiExtensionAPI,
    getState: () => state,
    getCard: () => card,
    getExtraCastCards: () => [],
    getPreset: () => null,
    commitTx() {
      txCount++;
    },
    reloadRuntime() {},
    refreshHud() {},
    activateRpTools() {},
    restoreCodingTools() {},
    markNextTurnOoc() {},
    teardownSessionRuntime() {},
  };

  const mockCtx = {
    cwd: "/tmp",
    model: { id: "mock" },
    sessionManager: {
      getBranch: () => [
        { id: "m1", type: "message", message: { role: "assistant", content: "雨越下越大了，要喝杯热茶吗？" } },
      ],
      getEntries: () => [],
      getLeafId: () => "m1",
    },
    modelRegistry: {
      streamSimple() {
        return {
          async result() {
            return { content: [{ type: "text", text: "我收起雨伞点点头：麻烦你了，来杯红茶吧。" }] };
          },
        };
      },
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      setWorkingMessage() {},
      async select() {
        return undefined;
      },
      async confirm() {
        return true;
      },
      async input() {
        return "";
      },
      async editor(title: string, initialText?: string) {
        sideEditorTitle = title;
        sideEditorText = initialText ?? "";
        return initialText;
      },
      setEditorText(text: string) {
        editorPrefill = text;
      },
    },
  } as unknown as PiExtensionContext;

  await actionImpersonate(mockRt, mockCtx, "答应喝茶");
  assert.equal(editorPrefill, "我收起雨伞点点头：麻烦你了，来杯红茶吧。");
  assert.equal(txCount, 0);
  assert.equal(sentCount, 0);

  await actionSidePrompt(mockRt, mockCtx, "她此刻的心情如何？");
  assert.ok(sideEditorTitle.includes("场外回答"));
  assert.equal(sideEditorText, "我收起雨伞点点头：麻烦你了，来杯红茶吧。");
  assert.equal(txCount, 0);
  assert.equal(sentCount, 0);
});
