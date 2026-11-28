import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import rpEngineExtension from "../src/index.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { parseNestedYamlVariables, salvageMvuVariables } from "../src/parser/mvu-salvage.js";
import { applyAnalyzedProfileToCard, parseAnalyzeResponse } from "../src/parser/analyzer.js";
import { applyRpTx, createInitialRpState, RP_ENTRY_TYPE } from "../src/engine/state-replay.js";
import { evaluateGate } from "../src/engine/gates.js";
import { evaluateNarrativeHealth } from "../src/engine/stagnation.js";
import { selectFactsForConflictCheck, selectFactsForZone3 } from "../src/memory/bitemporal.js";
import { recallLoreWithGraphPpr, selectRelevantBeliefs } from "../src/memory/graph-ppr.js";
import {
  attachZone3ToMessages,
  buildZone1FrozenPrefix,
  buildZone3TransientTail,
  evaluateActiveStorylets,
} from "../src/context/zone-builder.js";
import { hydrateWorldProfileAndVariables, type RpRuntimeHandle } from "../src/ui/actions.js";
import { displayWidth, renderBipolarBar, renderSmartStatBar } from "../src/ui/renderers.js";
import { createRpOverlayController } from "../src/ui/tui-overlay.js";
import { saveCompiledCard } from "../src/storage/workspace-store.js";
import type {
  ContextXRaySnapshot,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  PiSessionEntry,
  RpTxEntry,
} from "../src/types.js";

test("v4-1: Lossless disabled [InitVar] nested YAML extraction (bounds, $meta skip, prose block skip, inventory lists)", () => {
  const yaml = `
$meta:
  version: 2
  schema: hidden
悠纪:
  好感度: -15 # -100~100 初始戒备
  服装:
    上衣: 黑色水手服
  描述: |
    不可解析的正文: 假冒键值
  空字段: null
玩家:
  理智: 75/100
  背包:
    - 柴刀
    - 干粮 x3
世界:
  当前地点: 雾港老车站
  警戒度: 2 # 0-6
`;
  const parsed = parseNestedYamlVariables(yaml);
  const byPath = new Map(parsed.map((p) => [p.path, p]));
  assert.equal(byPath.get("悠纪.好感度")?.value, -15);
  assert.equal(byPath.get("悠纪.好感度")?.min, -100);
  assert.equal(byPath.get("悠纪.好感度")?.max, 100);
  assert.equal(byPath.get("悠纪.服装.上衣")?.value, "黑色水手服");
  assert.equal(byPath.get("玩家.理智")?.value, 75);
  assert.equal(byPath.get("玩家.理智")?.max, 100);
  assert.equal(byPath.get("玩家.背包.柴刀")?.value, 1);
  assert.equal(byPath.get("玩家.背包.干粮")?.value, 3);
  assert.equal(byPath.has("$meta.version"), false);
  assert.equal(byPath.has("悠纪.描述.不可解析的正文"), false);
  assert.equal(byPath.has("悠纪.空字段"), false);

  // Disabled & non-constant [InitVar] lore entry MUST still be salvaged by compileCharacterCard!
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: {
        name: "悠纪",
        description: "雨夜孤岛上的少女。",
        first_mes: "她低头握紧手里的灯笼。",
        character_book: {
          entries: [
            {
              id: 1,
              comment: "[InitVar] 初始化变量",
              keys: ["init"],
              content: yaml,
              enabled: false,
              constant: false,
            },
          ],
        },
      },
    },
    "v2",
  );

  const byKey = new Map(card.salvagedStateSchema.map((v) => [`${v.actorId ?? ""}::${v.key}`, v]));
  assert.equal(byKey.get("悠纪::好感度")?.initialValue, -15);
  assert.equal(byKey.get("悠纪::好感度")?.category, "stat");
  assert.equal(byKey.get("悠纪::服装.上衣")?.initialValue, "黑色水手服");
  assert.equal(byKey.get("player::柴刀")?.category, "inventory");
  assert.equal(byKey.get("player::干粮")?.initialValue, 3);
  assert.equal(byKey.get("world::当前地点")?.category, "anchor");
  assert.equal(byKey.get("world::警戒度")?.category, "clock");
});

test("v4-2: Official MVU _.set(path, oldVal, newVal), _.add, _.assign, JSONPatch, HTML tables & multi-actor isolation", () => {
  const vars = salvageMvuVariables({
    rawAllLoreEntries: [
      {
        name: "[InitVar] MVU规则",
        enabled: false,
        constant: false,
        content: `
请遵循规则：不要误把这行解析成变量
_.set('悠纪.好感度', 10, 35);// -100~100 约定后好感上升
_.set('林雾.好感度', 0, -20);// -100~100 敌意
_.add('玩家.金币', 50);
_.assign('林雾', { "信任": 40, "武器": "折扇" });
<UpdateVariable>
[{"op": "replace", "path": "/世界/雾气浓度", "value": 80}]
</UpdateVariable>
`,
      },
    ],
    firstMes: `<table><tr><td>体力</td><td>88/100</td></tr></table> <%= getvar('玩家.线索数') %>`,
  });

  const map = new Map(vars.map((v) => [`${v.actorId ?? ""}::${v.key}`, v]));
  // Official MVU 3-arg _.set MUST take newVal (35), NOT oldVal (10)!
  assert.equal(map.get("悠纪::好感度")?.initialValue, 35);
  assert.equal(map.get("林雾::好感度")?.initialValue, -20);
  assert.equal(map.get("player::金币")?.initialValue, 50);
  assert.equal(map.get("林雾::信任")?.initialValue, 40);
  assert.equal(map.get("林雾::武器")?.initialValue, "折扇");
  assert.equal(map.get("world::雾气浓度")?.initialValue, 80);
  assert.equal(map.get("player::线索数")?.initialValue, 0);
  assert.ok(vars.some((v) => v.key === "体力" && v.initialValue === 88 && v.max === 100 && v.source === "html_table"));
  assert.equal(
    vars.some((v) => v.key.includes("请遵循规则")),
    false,
    "Prose before _.set in structured InitVar must NOT pollute variables",
  );
});

test("v4-3: 7-Dimension pure-text /rp analyze extraction, permanent caching & idempotent mid-session hydration", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: {
        name: "沈青璃",
        description: "表面温润的古董店女掌柜，实为前朝密探。",
        scenario: "民国旧巷雨夜，玩家带着一枚残缺青铜印前来鉴定。",
        first_mes: "她推了推金丝眼镜，目光停在你袖口的青铜印上。",
        character_book: {
          entries: [
            { id: 10, comment: "密探真身", keys: ["青铜印", "密探"], content: "沈青璃真正效忠于隐秘组织黑羽阁。" },
          ],
        },
      },
    },
    "v2",
  );

  const llmJson = JSON.stringify({
    archetype: "mystery",
    modules: { stats: true, inventory: true, clocks: true, stages: false },
    initialLocation: "旧巷古董店",
    initialTime: "民国二十三年·秋雨夜",
    initialObjective: "试探沈青璃对青铜印的真实态度",
    initialPresentNpcs: ["沈青璃"],
    initialInventory: [{ actorId: "player", item: "残缺青铜印", count: 1 }],
    initialStats: [
      { actorId: "沈青璃", key: "信任度", initialValue: -10, category: "stat", min: -100, max: 100, note: "怀疑玩家来历" },
      { actorId: "world", key: "雨夜暗探", initialValue: false, category: "flag" },
    ],
    suggestedCfsmAxes: [
      { actorId: "沈青璃", axis: "戒心", states: ["高度戒备", "暗中试探", "有限合作", "彻底信任"], initial: "高度戒备" },
    ],
    initialBeliefs: [
      {
        actorId: "沈青璃",
        target: "player",
        activatingEvent: "玩家携带青铜印上门",
        belief: "对方极可能是冲着黑羽阁旧案而来",
        subjectiveInsight: "必须先稳住此人，切不可显露破绽",
        emotionalTone: "冷静戒备",
      },
    ],
    initialFacts: [
      { statement: "沈青璃真实身份是前朝密探", entities: ["沈青璃", "黑羽阁"], witnessIds: ["沈青璃"] },
      { statement: "旧巷正下着冷雨", entities: ["旧巷"], witnessIds: "public" },
    ],
    initialForesights: [
      { summary: "青铜印背面的暗纹指向城南当铺", triggerHint: "当玩家仔细端详印章或提及城南时", entities: ["青铜印", "城南当铺"] },
    ],
    initialStorylets: [
      {
        title: "后院暗门开启",
        triggerPrompt: "沈青璃终于决定信任玩家，推开博古架后的密室暗门。",
        gate: { statChecks: [{ actorId: "沈青璃", key: "信任度", gte: 40 }] },
        postEffects: { setFlags: { secret_room_open: true }, nextObjective: "查阅密室中的黑羽阁名册" },
        oneTime: true,
      },
    ],
    initialClocks: [{ clockId: "patrol_alert", label: "巡捕房逼近", value: 1, max: 6 }],
    entityAliases: { 沈青璃: ["女掌柜", "沈老板"] },
    suggestedLoreGates: [
      { entryId: card.loreBook.entries[0]!.id, requiredFlags: ["secret_room_open"], reason: "prevent_identity_spoiler" },
    ],
  });

  const parsed = parseAnalyzeResponse(llmJson, card);
  assert.ok(parsed);
  applyAnalyzedProfileToCard(card, parsed.profile, true, parsed.initialStats);

  assert.equal(card.worldProfile?.source, "llm-analyzed");
  assert.ok(card.identity.aliases.includes("女掌柜"));
  assert.deepEqual(card.loreBook.entries[0]!.gate?.requiredFlags, ["secret_room_open"]);
  assert.ok(card.salvagedStateSchema.some((v) => v.actorId === "沈青璃" && v.key === "信任度" && v.initialValue === -10));

  // Hydrate into a session
  const state = createInitialRpState();
  state.active = true;
  const rt = {
    getState: () => state,
    commitTx: (tx: RpTxEntry) => applyRpTx(state, tx),
  } as unknown as RpRuntimeHandle;

  hydrateWorldProfileAndVariables(rt, card, "salvaged");
  assert.equal(state.location, "旧巷古董店");
  assert.equal(state.sceneObjective, "试探沈青璃对青铜印的真实态度");
  assert.equal(state.stats["沈青璃"]?.["信任度"], -10);
  assert.equal(state.inventory["player"]?.["残缺青铜印"], 1);
  assert.equal(state.cfsmStates["沈青璃"]?.["戒心"]?.state, "高度戒备");
  assert.equal(state.beliefs.length, 1);
  assert.equal(state.beliefs[0]?.subjectiveInsight, "必须先稳住此人，切不可显露破绽");
  assert.equal(state.facts.size, 2);
  assert.equal(state.foresights.size, 1);
  assert.equal(state.storylets.size, 1);
  assert.equal(state.clocks["patrol_alert"]?.value, 1);
  assert.equal(state.auditLog.length, 0, "Turn-0 initial hydration should not spam auditLog");

  // Simulate gameplay mutation then re-run hydration (e.g. mid-session /rp analyze) -> MUST BE IDEMPOTENT!
  state.turn = 4;
  applyRpTx(state, { kind: "stat_patch", actorId: "沈青璃", key: "信任度", op: "set", value: 45, reason: "tool" });
  hydrateWorldProfileAndVariables(rt, card, "llm_analyze");
  assert.equal(state.stats["沈青璃"]?.["信任度"], 45, "Re-hydration must NEVER overwrite live gameplay stats!");
  assert.equal(state.inventory["player"]?.["残缺青铜印"], 1, "Re-hydration must NEVER double-count inventory!");
  assert.equal(state.clocks["patrol_alert"]?.value, 1, "Re-hydration must NEVER double-tick clocks!");
});

test("v4-4: GateCondition.statChecks gates Storylets & completion auto-applies postEffects", () => {
  const state = createInitialRpState();
  state.active = true;
  state.turn = 3;
  applyRpTx(state, { kind: "stat_patch", actorId: "沈青璃", key: "信任度", op: "set", value: 20, min: -100, max: 100 });
  applyRpTx(state, {
    kind: "storylet_upsert",
    storylet: {
      id: "st_secret_door",
      title: "暗门开启",
      triggerPrompt: "推开密室暗门",
      gate: { statChecks: [{ actorId: "沈青璃", key: "信任度", gte: 40 }] },
      postEffects: { setFlags: { door_opened: true }, nextObjective: "进入密室调查" },
      oneTime: true,
      status: "armed",
      createdTurn: 0,
    },
  });

  // Below threshold -> gate fails
  assert.equal(evaluateActiveStorylets(state).length, 0);
  assert.equal(evaluateGate({ statChecks: [{ key: "信任度", gte: 40 }] }, state), false);

  // Raise stat to 45 -> gate passes!
  applyRpTx(state, { kind: "stat_patch", actorId: "沈青璃", key: "信任度", op: "set", value: 45 });
  const active = evaluateActiveStorylets(state);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.id, "st_secret_door");

  // Completing storylet auto-applies postEffects.setFlags & postEffects.nextObjective!
  const st = state.storylets.get("st_secret_door")!;
  applyRpTx(state, { kind: "storylet_upsert", storylet: { ...st, status: "completed" } });
  assert.equal(state.flags["door_opened"], true);
  assert.equal(state.sceneObjective, "进入密室调查");
  assert.equal(evaluateActiveStorylets(state).length, 0);
});

test("v4-5: True bi-temporal timestamps & Turn-100 entity-matched fact + FANToM secret recall (no Turn-15 blind spot!)", () => {
  const state = createInitialRpState();
  state.active = true;
  state.worldTimeLabel = "初冬霜夜";
  state.presentNpcs = ["管家"];

  // Turn 1 facts: one public entity fact + one FANToM secret hidden from 管家
  state.turn = 1;
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "f_turn1_amulet",
      statement: "黑曜石护符曾被封存在钟楼地下室",
      entities: ["黑曜石护符", "钟楼"],
      validFromTurn: 1,
      validUntilTurn: null,
      witnessIds: "public",
    },
  });
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "f_turn1_secret",
      statement: "玩家悄悄调包了保险箱里的遗嘱",
      entities: ["遗嘱", "保险箱"],
      validFromTurn: 1,
      validUntilTurn: null,
      witnessIds: ["旅人"],
    },
  });

  const stamped = state.facts.get("f_turn1_amulet")!;
  assert.equal(stamped.ingestedAtTurn, 1);
  assert.equal(stamped.eventTimeLabel, "初冬霜夜");

  // Add 25 unrelated newer facts across Turns 10..34
  for (let i = 0; i < 25; i++) {
    state.turn = 10 + i;
    applyRpTx(state, {
      kind: "fact_add",
      fact: {
        id: `f_noise_${i}`,
        statement: `第 ${i} 天集市卖出了新鲜面包与茶叶`,
        entities: ["集市", `面包${i}`],
        validFromTurn: 10 + i,
        validUntilTurn: null,
        witnessIds: "public",
      },
    });
  }

  // At Turn 100: Sidecar conflict check mentioning "黑曜石护符" MUST still retrieve Turn-1 fact!
  state.turn = 100;
  const conflictList = selectFactsForConflictCheck(state, "我们在花园发现了黑曜石护符的碎片", 10, 15);
  assert.ok(conflictList.some((f) => f.id === "f_turn1_amulet"), "Turn-1 fact must survive 25+ newer facts via entity match");

  // Zone 3 fact selection MUST ALSO preserve the Turn-1 FANToM blind spot even when "遗嘱" isn't mentioned!
  const z3List = selectFactsForZone3(state, "管家递来一杯热茶", 8, 6);
  assert.ok(
    z3List.some((f) => f.id === "f_turn1_secret"),
    "Live FANToM secret hidden from present NPC must NEVER be evicted from Zone 3!",
  );
});

test("v4-6: Real evaluateNarrativeHealth detects prose looping & world stagnation without fake turn%5 firing", () => {
  const state = createInitialRpState();
  state.active = true;
  state.archetype = "mystery";
  state.pacingMode = "balanced";
  state.turn = 5;
  state.lastMeaningfulProgressTurn = 5; // Just made progress -> NOT stagnant!

  const healthyMsgs: PiMessage[] = [
    { role: "assistant", content: "雨滴敲打着阁楼的天窗，老旧的铜钟发出一声低沉的嗡鸣，你发现地板缝隙里卡着半张车票。" },
    { role: "assistant", content: "沈青璃忽然推开木门，手里端着一盏煤油灯，眉头紧锁地看着你掌中那枚生锈的铁钥匙。" },
  ];
  const healthy = evaluateNarrativeHealth(state, healthyMsgs);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.antiRepetitionCue, null);
  assert.equal(healthy.antiStagnationCue, null);

  // High repetition prose -> fires antiRepetitionCue!
  const loopMsgs: PiMessage[] = [
    { role: "assistant", content: "她轻轻叹了口气，手指无意识地摩挲着杯沿，眼神深邃地望向窗外淅淅沥沥的夜雨。" },
    { role: "assistant", content: "她再次轻轻叹了口气，手指无意识地摩挲着杯沿，眼神深邃地望向窗外淅淅沥沥的夜雨。" },
  ];
  const repeating = evaluateNarrativeHealth(state, loopMsgs);
  assert.equal(repeating.status, "repeating");
  assert.ok(repeating.repetitionScore >= 0.42);
  assert.ok(repeating.antiRepetitionCue);

  // Real stagnation (4+ turns without meaningful progress) -> fires antiStagnationCue on mystery, silent on slice-of-life!
  state.turn = 9;
  state.lastMeaningfulProgressTurn = 4;
  const stagnant = evaluateNarrativeHealth(state, healthyMsgs);
  assert.equal(stagnant.status, "stagnant");
  assert.equal(stagnant.stagnantTurns, 5);
  assert.ok(stagnant.antiStagnationCue);

  state.archetype = "slice-of-life";
  const slice = evaluateNarrativeHealth(state, healthyMsgs);
  assert.equal(slice.antiStagnationCue, null);
});

test("v4-7: Unified HippoRAG 2 PPR bridges Bi-Temporal Facts & Memory Books to 2-hop Lore + DualMem query ranking", () => {
  const state = createInitialRpState();
  state.active = true;
  state.turn = 6;
  state.presentNpcs = ["林雾"];

  // Fact links "青铜钥匙" <-> "沉星图书馆" (even though neither lore entry directly mentions the other's key!)
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "f_bridge",
      statement: "青铜钥匙能打开沉星图书馆的地下密室",
      entities: ["青铜钥匙", "沉星图书馆"],
      validFromTurn: 3,
      validUntilTurn: null,
      witnessIds: "public",
    },
  });

  const loreEntries = [
    {
      id: "lore_lib",
      title: "沉星图书馆禁书区",
      keys: ["沉星图书馆"],
      secondaryKeys: [],
      excludeKeys: [],
      selective: false,
      selectiveLogic: "AND_ANY" as const,
      content: "沉星图书馆深处收藏着失落的星象卷轴。",
      entities: ["沉星图书馆"],
      constant: false,
      enabled: true,
      position: 1,
      priority: 100,
      depthHint: 4,
      useRegex: false,
      caseSensitive: false,
      matchWholeWords: false,
      probability: 100,
      useProbability: false,
      stickyTurns: 0,
      stickyPermanent: false,
      cooldownTurns: 0,
      oneShot: false,
      group: "",
      groupOverride: false,
      groupWeight: 100,
      useGroupScoring: false,
      pinned: false,
      lowBudgetPriority: false,
      manualRecallOnly: false,
      noGraphSpread: false,
      graphSecondHopOnly: false,
      staticPrebound: false,
    },
  ];

  // Player ONLY mentions "青铜钥匙" -> Fact co-occurrence bridge MUST recall "沉星图书馆" via HippoRAG 2 PPR!
  const res = recallLoreWithGraphPpr({
    entries: loreEntries,
    state,
    recentText: "我摸了摸口袋里的青铜钥匙。",
    tokenBudget: 1000,
  });
  assert.ok(res.selected.some((e) => e.id === "lore_lib"), "Fact bridge must trigger 2-hop PPR recall of linked lore");

  // Query-relevant RoleMemo DualMem belief ranking (not naive .slice(-6)!)
  for (let i = 0; i < 8; i++) {
    applyRpTx(state, {
      kind: "belief_update",
      id: `b_other_${i}`,
      actorId: `路人${i}`,
      target: "旅人",
      activatingEvent: "闲聊天气",
      belief: "今天天气不错",
      turn: i + 1,
    });
  }
  applyRpTx(state, {
    kind: "belief_update",
    id: "b_key",
    actorId: "林雾",
    target: "旅人",
    activatingEvent: "交出青铜钥匙",
    belief: "旅人愿意与我并肩探查沉星图书馆",
    subjectiveInsight: "或许我可以试着相信这一次",
    emotionalTone: "微暖",
    turn: 1,
  });
  const topBeliefs = selectRelevantBeliefs(state, "关于青铜钥匙和沉星图书馆的事", 3);
  assert.equal(topBeliefs[0]?.id, "b_key", "Present NPC + query-matched older belief must rank #1 over newer noise!");
});

test("v4-8: Bulletproof KV-Cache: deterministic Zone 1 macros, tail-only toolResult attach, and honest 3-layer X-Ray", async () => {
  // (a) Zone 1 with {{random::...}} and {{roll:1d20}} MUST be 100% byte-identical across repeated builds!
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: {
        name: "星见",
        description: "她习惯佩戴{{random::红玉::蓝晶::翠羽}}发饰，幸运值{{roll:1d20}}。",
        scenario: "天文台。",
        first_mes: "欢迎来到天文台。",
      },
    },
    "v2",
  );
  const z1a = buildZone1FrozenPrefix({ card, initialPersona: { id: "p", name: "旅人", description: "" } });
  const z1b = buildZone1FrozenPrefix({ card, initialPersona: { id: "p", name: "旅人", description: "" } });
  const z1c = buildZone1FrozenPrefix({ card, initialPersona: { id: "p", name: "旅人", description: "" } });
  assert.equal(z1a, z1b);
  assert.equal(z1b, z1c);
  assert.equal(z1a.includes("{{random"), false);

  // (b) attachZone3ToMessages with trailing toolResult MUST attach ONLY to out[last], NEVER mutating earlier user msg!
  const loopMessages: PiMessage[] = [
    { role: "user", content: "我检查抽屉。" },
    { role: "assistant", content: [{ type: "toolCall", name: "rp_roll_check" }] },
    { role: "toolResult", content: "Roll 1d20 = 18 -> SUCCESS" },
  ];
  const out = attachZone3ToMessages(loopMessages, "<rp_state_frame>{}</rp_state_frame>", new Set());
  assert.equal(out[0]?.content, "我检查抽屉。", "Earlier user message MUST NOT be mutated during tool loop!");
  assert.ok(String(out[2]?.content).includes("<rp_state_frame>"), "Zone 3 MUST attach strictly to trailing toolResult!");

  // (c) Full extension lifecycle test: first_turn -> prefix_hit (x2) -> tools_changed -> history_mutated!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v4-kv-"));
  const worldDir = path.join(tmpDir, ".pi", "rp");
  saveCompiledCard({ baseDir: worldDir, card, rawJson: {} });

  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let activeTools = ["rp_roll_check", "rp_state_patch", "rp_fact_commit", "rp_recall", "rp_era_advance", "rp_npc_deliberate"];
  const branch: PiSessionEntry[] = [
    {
      id: "e0",
      type: "custom",
      customType: RP_ENTRY_TYPE,
      data: {
        kind: "bind",
        cardId: card.id,
        cardSlug: card.slug,
        cardSource: "project",
        worldDir,
        greetingIndex: 0,
        activeCharacters: [card.slug],
      } satisfies RpTxEntry,
    },
  ];
  let capturedXRay: ContextXRaySnapshot | null = null;
  let lastHudStatus = "";

  const mockPi: PiExtensionAPI = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    appendEntry(customType, data) {
      branch.push({ id: `e_${branch.length}`, type: "custom", customType, data });
    },
    sendMessage() {},
    sendUserMessage() {},
    getActiveTools: () => activeTools,
    setActiveTools(names) {
      activeTools = [...names];
    },
  };
  const mockCtx = {
    cwd: tmpDir,
    mode: "tui",
    sessionManager: { getBranch: () => branch },
    ui: {
      notify() {},
      setStatus(_k: string, text: string | undefined) {
        lastHudStatus = text ?? "";
      },
      setWidget() {},
      setTitle() {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
    },
  } as unknown as PiExtensionContext;

  rpEngineExtension(mockPi);
  for (const h of handlers.get("session_start") ?? []) await h({ reason: "startup" }, mockCtx);

  const runTurn = async (msgs: PiMessage[]) => {
    for (const h of handlers.get("before_agent_start") ?? []) await h({ prompt: "继续" }, mockCtx);
    for (const h of handlers.get("context") ?? []) await h({ messages: msgs }, mockCtx);
    for (const h of handlers.get("turn_end") ?? []) await h({ message: { role: "assistant", content: "星光洒落。" } }, mockCtx);
  };

  const m0: PiMessage = { id: "m0", role: "user", content: "你好" };
  const m1: PiMessage = { id: "m1", role: "assistant", content: "欢迎" };
  const m2: PiMessage = { id: "m2", role: "user", content: "看星星" };
  const m3: PiMessage = { id: "m3", role: "assistant", content: "星光璀璨" };
  const m4: PiMessage = { id: "m4", role: "user", content: "再看一眼" };

  // Turn 1: first_turn
  await runTurn([m0, m1, m2]);
  // Turn 2: prefix_hit (streak 2)
  await runTurn([m0, m1, m2, m3, m4]);
  assert.ok(lastHudStatus.includes("⚡KV×2"), `Expected ⚡KV×2 in HUD status, got: ${lastHudStatus}`);

  // Turn 3: mutate tools -> MUST detect tools_changed & reset streak to 1!
  activeTools = ["rp_roll_check", "bash"];
  await runTurn([m0, m1, m2, m3, m4, { role: "assistant", content: "风吹过" }, { role: "user", content: "继续" }]);
  assert.ok(lastHudStatus.includes("⚠KV刷新"), `Expected ⚠KV刷新 after tools change, got: ${lastHudStatus}`);

  // Turn 4: stable tools again -> prefix_hit (streak 2)
  await runTurn([m0, m1, m2, m3, m4, { role: "assistant", content: "风吹过" }, { role: "user", content: "继续" }, { role: "assistant", content: "嗯" }, { role: "user", content: "再继续" }]);
  assert.ok(lastHudStatus.includes("⚡KV×2"), `Expected ⚡KV×2 when stable again, got: ${lastHudStatus}`);

  // Turn 5: mutate earlier history (e.g. floor hidden or edited) -> MUST detect history_mutated!
  await runTurn([m0, { id: "m1", role: "assistant", content: "被篡改的历史" }, m2, m3, m4, { role: "assistant", content: "风吹过" }, { role: "user", content: "继续" }, { role: "assistant", content: "嗯" }, { role: "user", content: "再继续" }, { role: "assistant", content: "好" }, { role: "user", content: "最后" }]);
  assert.ok(lastHudStatus.includes("⚠KV刷新"), `Expected ⚠KV刷新 after history mutation, got: ${lastHudStatus}`);
  void capturedXRay;

  // Also test v4-9 right inside this live extension: session_before_compact MUST persist MemScene into memoryBooks!
  const compactHandlers = handlers.get("session_before_compact") ?? [];
  assert.equal(compactHandlers.length, 1);
  const compactRes = await compactHandlers[0]!({
    preparation: {
      messagesToSummarize: [m0, m1, m2, m3],
      firstKeptEntryId: "m4",
      tokensBefore: 4200,
    },
  }, mockCtx);
  assert.ok(compactRes?.compaction?.summary.includes("MemScene"));
  const postCompactHandlers = handlers.get("session_compact") ?? [];
  assert.equal(postCompactHandlers.length, 1);
  await postCompactHandlers[0]!({ compactionEntry: { summary: compactRes.compaction.summary } }, mockCtx);
  assert.ok(
    branch.some((e) => e.customType === RP_ENTRY_TYPE && (e.data as RpTxEntry).kind === "memory_book_upsert"),
    "session_compact MUST persist consolidated MemScene into Memory Books!",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("v4-10: Bipolar stat bar rendering & smart adaptive 7-tab TUI Overlay width safety at 60/80/96 cols", () => {
  const negBar = renderBipolarBar(-50, -100, 100, 4);
  const posBar = renderBipolarBar(50, -100, 100, 4);
  const zeroBar = renderBipolarBar(0, -100, 100, 4);
  assert.equal(negBar, "░░▓▓│░░░░");
  assert.equal(posBar, "░░░░│▓▓░░");
  assert.equal(zeroBar, "░░░░│░░░░");
  assert.ok(renderSmartStatBar(-30, -100, 100, 4)?.includes("│") && renderSmartStatBar(-30, -100, 100, 4)?.includes("-30"));
  assert.ok(renderSmartStatBar(30, -100, 100, 4)?.includes("+30"));
  assert.ok(renderSmartStatBar(60, 0, 100, 5)?.includes("60/100"));

  const state = createInitialRpState();
  state.active = true;
  state.turn = 8;
  state.location = "旧巷古董店";
  state.sceneObjective = "找出密室机关";
  state.modules = { stats: true, inventory: true, clocks: true, stages: false };
  applyRpTx(state, { kind: "stat_patch", actorId: "沈青璃", key: "信任度", op: "set", value: -25, min: -100, max: 100 });
  applyRpTx(state, { kind: "inventory_patch", actorId: "player", item: "青铜印", delta: 1 });
  applyRpTx(state, { kind: "progress_clock", clockId: "alert", label: "巡捕逼近", delta: 3, max: 6 });

  const xray: ContextXRaySnapshot = {
    turn: 8,
    timestamp: Date.now(),
    toolsHash: "a1b2c3d4e5f6",
    zone1Hash: "112233445566",
    zone2PrefixMatch: true,
    cacheInvalidationReason: "prefix_hit",
    cacheHitStreak: 5,
    zone1Tokens: 900,
    zone2Tokens: 1800,
    zone3Tokens: 450,
    loreTokens: 320,
    loreBudget: 1800,
    recalled: [],
    gatedOut: [],
    budgetDropped: [],
    activeFactCount: 3,
    blindSpotCount: 2,
    activeStoryletTitles: ["暗门开启"],
    hiddenFloorCount: 0,
    repetitionScore: 0.12,
    stagnantTurns: 1,
  };

  for (const tab of [0, 1, 2, 3, 4, 5, 6] as const) {
    const ctrl = createRpOverlayController({
      state,
      card: null,
      allLore: [],
      xray,
      initialTab: tab,
      done: () => {},
    });
    for (const width of [60, 80, 96]) {
      const lines = ctrl.render(width);
      assert.ok(lines.length >= 6);
      for (const line of lines) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
        assert.ok(
          displayWidth(plain) <= width,
          `Tab ${tab} line exceeded width ${width}: (${displayWidth(plain)}) ${plain}`,
        );
      }
    }
  }
});
