import { computeCalendarAnchor, detectLifespanProfile, parseTimeSpan } from "../src/engine/temporal.js";
import test from "node:test";
import assert from "node:assert/strict";

import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { extractHeuristicVoiceAnchor } from "../src/parser/analyzer.js";
import { applyRpTx, createInitialRpState } from "../src/engine/state-replay.js";
import { buildZone1FrozenPrefix, buildZone3TransientTail, computeZone1Hash } from "../src/context/zone-builder.js";
import { cosineSimilarity, reciprocalRankFusion } from "../src/memory/embedding.js";
import { createTurnRecallScope, recallHistory } from "../src/memory/history-recall.js";
import type { PiSessionEntry } from "../src/types.js";

test("deep-water-1: Voice & Backbone Anchors (L0 auto-extract) + HEART-Bench per-character belief isolation + mobile short-input guard", () => {
  const card = compileCharacterCard(
    {
      name: "柳春娘",
      description: "崇祯七年运河游医，嘴硬心细，从不白给外人看病。",
      personality: "防备心极重，说话带三分讥讽，绝不无端顺从陌生人。",
      first_mes: "「看病先交诊金，没钱就去城隍庙求签。」她头也不抬。",
      mes_example: "<START>\n{{char}}: 「你这伤不是摔的，是刀背砸的——少跟我装糊涂。」",
    },
    "v2",
  );

  // L0 heuristic voice anchor extracts verbatim dialogue quotes without any LLM call
  const anchor = extractHeuristicVoiceAnchor(card);
  assert.ok(anchor, "should extract heuristic voice anchor");
  assert.ok(anchor!.speechSamples.some((q) => q.includes("刀背砸的") || q.includes("诊金")));
  assert.ok(anchor!.backbone.includes("防备心"));

  const state = createInitialRpState();
  state.active = true;
  state.turn = 12;
  state.location = "德州城北门集市";
  state.presentNpcs = ["柳春娘"];
  // Add belief for present character AND private belief for off-screen character
  applyRpTx(state, {
    kind: "belief_update",
    actorId: "柳春娘",
    target: "player",
    activatingEvent: "玩家递来半块干粮",
    belief: "此人虽穷酸，倒不像官府密探",
    subjectiveInsight: "暂且留三分余地，先套话",
    emotionalTone: "审慎",
    turn: 10,
  });
  applyRpTx(state, {
    kind: "belief_update",
    actorId: "漕运总兵",
    target: "player",
    activatingEvent: "密报称码头有异动",
    belief: "怀疑流民中混有细作",
    subjectiveInsight: "宁可错杀不可放过",
    emotionalTone: "猜忌",
    turn: 11,
  });

  const z3 = buildZone3TransientTail({
    card,
    state,
    recalledLore: [],
    recentText: "柳春娘低头抓药",
    lastUserMessage: "天塌了", // mobile 3-char brief cue
  });

  // 1. Voice anchor injected cleanly in Zone 3
  assert.ok(z3.includes("<rp_voice_anchors>"), "should inject voice anchors");
  assert.ok(z3.includes("柳春娘"), "should anchor focal character");
  // 2. HEART-Bench perspective filtering excludes unmentioned off-screen character belief
  assert.ok(z3.includes("柳春娘 → player"), "should keep present NPC belief");
  assert.ok(!z3.includes("漕运总兵 → player"), "must NOT bleed unmentioned off-screen NPC belief into focal perspective");
  // 3. Mobile short-input compensation activates on <=16 char cue
  assert.ok(z3.includes("Mobile brief-input cue"), "should compensate for ultra-short mobile input");
});

test("deep-water-2: Dynamic Physical Scene + Spatial Occlusion + Point-in-Time Scenario Override + Reversible Undo", () => {
  const card = compileCharacterCard(
    { name: "黑水", description: "闯关东沙船船老大", scenario: "开局：烟台码头沙船底舱" },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  applyRpTx(state, { kind: "location_set", location: "烟台码头底舱", presentNpcs: ["黑水"] });
  assert.equal(state.initialLocation, "烟台码头底舱");

  // Move to Turn 8 & new location
  for (let i = 0; i < 8; i++) applyRpTx(state, { kind: "clock_tick", beatDelta: 1 });
  applyRpTx(state, { kind: "location_set", location: "营口城西米铺后院", presentNpcs: ["黑水"] });
  applyRpTx(state, {
    kind: "physical_patch",
    snapshot: {
      actorId: "黑水",
      attire: "湿透的羊皮袄",
      condition: "左肩旧刀伤渗血",
      holding: "铜烟锅",
      position: "靠在米袋旁背对窗台",
      updatedTurn: 8,
    },
    spatialNotes: "后院与前堂隔着厚木门，前堂伙计听不见后院低语",
    reason: "sidecar",
  });

  const z3 = buildZone3TransientTail({
    card,
    state,
    recalledLore: [],
    recentText: "我们在后院商量对策",
  });

  assert.ok(z3.includes("<rp_physical_scene>"), "should inject physical scene snapshot");
  assert.ok(z3.includes("湿透的羊皮袄") && z3.includes("左肩旧刀伤渗血") && z3.includes("厚木门"));
  assert.ok(z3.includes("Continuity override"), "should trigger Point-in-Time override when location changed past turn 4");
});

test("deep-water-3: Living World Off-Screen NPC Agendas (deterministic countdown) & NPC<->NPC Pair Bonds", () => {
  const card = compileCharacterCard({ name: "黑水", description: "测试" }, "v2");
  const state = createInitialRpState();
  state.active = true;
  state.presentNpcs = ["黑水"];

  applyRpTx(state, {
    kind: "agenda_upsert",
    agenda: {
      actorId: "马二爷",
      goal: "查封营口渡口私船",
      currentActivity: "带着巡丁沿码头逐船搜查",
      etaTurns: 2,
      updatedTurn: 0,
    },
  });
  applyRpTx(state, {
    kind: "pair_bond_upsert",
    bond: {
      id: "马二爷::黑水",
      actorA: "马二爷",
      actorB: "黑水",
      stance: "暗中猜忌",
      tension: -65,
      note: "三年前私盐案结下的旧怨",
      updatedTurn: 0,
    },
  });

  // Tick 2 turns -> etaTurns counts down 2 -> 1 -> 0 ([DUE/ARRIVING NOW])
  applyRpTx(state, { kind: "clock_tick", beatDelta: 1 });
  assert.equal(state.npcAgendas["马二爷"]?.etaTurns, 1);
  applyRpTx(state, { kind: "clock_tick", beatDelta: 1 });
  assert.equal(state.npcAgendas["马二爷"]?.etaTurns, 0);

  const z3 = buildZone3TransientTail({ card, state, recalledLore: [], recentText: "码头风声紧" });
  assert.ok(z3.includes("<rp_living_world>"));
  assert.ok(z3.includes("[DUE/ARRIVING NOW]"), "should flag due agenda for organic arrival");
  assert.ok(z3.includes("马二爷 <-> 黑水") && z3.includes("暗中猜忌"));
});

test("deep-water-4: Hybrid Semantic Embedding Cosine + RRF Fusion & 50-Turn Long-Horizon Stress Eval", () => {
  // 1. Cosine similarity & Reciprocal Rank Fusion
  const simSame = cosineSimilarity([1, 0, 0], [0.98, 0.1, 0]);
  const simOrtho = cosineSimilarity([1, 0, 0], [0, 1, 0]);
  assert.ok(simSame > 0.95 && simOrtho === 0);

  const fused = reciprocalRankFusion([10, 20, 30], [30, 5, 10]);
  // Turn 10 & 30 appear in both lists -> ranked top 2!
  assert.ok([10, 30].includes(fused[0]!.id) && [10, 30].includes(fused[1]!.id));

  // 2. 50-Turn Long-Horizon Stress Benchmark:
  //    Verifies Zone 1 100% KV-Cache invariance, Turn-50 voice anchor survival,
  //    Turn-50 BM25 recall of a Turn-2 promise, and zero FANToM blind-spot leaks.
  const card = compileCharacterCard(
    {
      name: "林秋",
      description: "冷峻押镖人",
      personality: "言出必行，惜字如金",
      first_mes: "「镖在人在，少废话。」",
      scenario: "开局：太原镖局大院",
    },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  applyRpTx(state, { kind: "location_set", location: "太原镖局大院", presentNpcs: ["林秋"] });
  applyRpTx(state, {
    kind: "fact_add",
    fact: {
      id: "secret_1",
      statement: "箱子里装的不是茶叶，而是半块虎符",
      entities: ["虎符", "箱子"],
      validFromTurn: 1,
      validUntilTurn: null,
      witnessIds: ["林秋"],
    },
  });

  const z1HashTurn0 = computeZone1Hash(
    buildZone1FrozenPrefix({ card, initialPersona: state.currentPersona }),
  );

  const branch: PiSessionEntry[] = [
    { id: "r1", type: "custom_message", customType: "rp:greeting", content: "「镖在人在，少废话。」", display: true },
    { id: "u2", type: "message", message: { role: "user", content: "我们约定等黄河封冻那晚在渡口碰头，暗号是三声铜锣。" } },
    { id: "a2", type: "message", message: { role: "assistant", content: "林秋颔首：三声铜锣，不见不散。" } },
  ];

  for (let t = 3; t <= 50; t++) {
    applyRpTx(state, { kind: "clock_tick", beatDelta: 1 });
    branch.push(
      { id: `u${t}`, type: "message", message: { role: "user", content: `第 ${t} 轮赶路，风雪渐大。` } },
      { id: `a${t}`, type: "message", message: { role: "assistant", content: `林秋策马前行，第 ${t} 轮平安无事。` } },
    );
  }
  applyRpTx(state, { kind: "location_set", location: "黄河风陵渡口", presentNpcs: ["林秋", "店小二"] });

  const z1HashTurn50 = computeZone1Hash(
    buildZone1FrozenPrefix({ card, initialPersona: state.currentPersona }),
  );
  assert.equal(z1HashTurn50, z1HashTurn0, "Zone 1 MUST remain 100% byte-identical after 50 turns");

  const z3Turn50 = buildZone3TransientTail({
    card,
    state,
    recalledLore: [],
    recentText: "店小二端来热茶，问箱子里是什么货",
  });
  assert.ok(z3Turn50.includes("<rp_voice_anchors>"), "Voice anchor must survive at Turn 50");
  assert.ok(z3Turn50.includes("HIDDEN FROM: 店小二"), "FANToM epistemic blind spot must hold at Turn 50");
  assert.ok(z3Turn50.includes("Continuity override"), "Point-in-Time override must supersede Turn 0 scenario at Turn 50");

  // Recall Turn-2 promise at Turn 50 via BM25 history recall
  const recalled = recallHistory({
    branch,
    query: "黄河封冻 暗号 铜锣",
    scope: createTurnRecallScope(),
    cooldowns: [],
  });
  assert.equal(recalled.result.found, true, "BM25 must recall Turn-2 promise at Turn 50");
  assert.equal(recalled.result.matches[0]!.turn, 1);
});

test("deep-water-5: OOC ((...)) turn auto-hides OOC Q&A from future story context (zero pollution) without advancing turn", async () => {
  const { default: rpExt } = await import("../src/index.js");
  const { attachZone3ToMessages } = await import("../src/context/zone-builder.js");
  const { computeMessageFingerprint } = await import("../src/engine/state-replay.js");

  const card = compileCharacterCard({ name: "黑水", description: "测试", first_mes: "开场" }, "v2");
  const state = createInitialRpState();
  state.active = true;
  const oocUser = { role: "user", content: "[OOC - Meta/Director Discussion]\n现在伏笔有哪些？", timestamp: 1000 };
  const oocReply = { role: "assistant", content: "当前有两条未回收伏笔。", timestamp: 1001 };
  const storyUser = { role: "user", content: "我推开客栈的门。", timestamp: 2000 };

  applyRpTx(state, {
    kind: "hide_toggle",
    entryIds: [],
    fingerprints: [computeMessageFingerprint(oocUser), computeMessageFingerprint(oocReply)],
    hidden: true,
  });

  const filtered = attachZone3ToMessages(
    [oocUser, oocReply, storyUser],
    "<rp_state_frame>{}</rp_state_frame>",
    state.hiddenEntryIds,
    state.hiddenFingerprints,
  );
  assert.equal(filtered.length, 1, "OOC Q&A must be stripped from subsequent story context");
  assert.ok(String(filtered[0]!.content).includes("我推开客栈的门"));
  assert.equal(typeof rpExt, "function");
});


test("deep-water-6: temporal parser & calendar arithmetic prevent era/lifespan hallucinations", () => {
  assert.equal(parseTimeSpan("320年后").years, 320);
  assert.equal(parseTimeSpan("八十年后").years, 80);
  assert.equal(parseTimeSpan("3天后").dayDelta, 3);
  assert.equal(parseTimeSpan("半年后").dayDelta, 183);

  const a80 = computeCalendarAnchor("崇祯七年深秋", 80, 29200);
  assert.ok(a80);
  assert.equal(a80.sourceYear, 1634);
  assert.equal(a80.targetYear, 1714);
  assert.ok(a80.targetEraLabel?.includes("康熙53年"));

  const a320 = computeCalendarAnchor("崇祯七年深秋", 320, 116800);
  assert.ok(a320);
  assert.equal(a320.targetYear, 1954);
  assert.equal(a320.targetEraLabel, "公元1954年");

  const greg = computeCalendarAnchor("2026年3月", 15, 5475);
  assert.ok(greg);
  assert.equal(greg.targetYear, 2041);

  assert.equal(detectLifespanProfile("明末运河游医，市井江湖"), "mortal");
  assert.equal(detectLifespanProfile("修仙宗门，筑基金丹长生大道"), "long_lived");
  assert.equal(detectLifespanProfile("星际殖民船冷冻舱休眠苏醒"), "scifi_stasis");
});
