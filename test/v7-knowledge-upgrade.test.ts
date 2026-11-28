import test from "node:test";
import assert from "node:assert/strict";
import { compileCharacterCard, exportCardToCcv3Json } from "../src/parser/card-compiler.js";
import { compileLoreBook } from "../src/parser/lore-compiler.js";
import { buildAnalyzePrompt } from "../src/parser/analyzer.js";
import { recallCardKnowledge } from "../src/parser/card-knowledge.js";
import { buildEntityRegistry } from "../src/memory/entity-registry.js";
import { recallLoreWithGraphPpr } from "../src/memory/graph-ppr.js";
import { buildZone1FrozenPrefix, buildZone3TransientTailWithStats } from "../src/context/zone-builder.js";
import { estimateTokens } from "../src/context/token-budget.js";
import { createInitialRpState, applyRpTx } from "../src/engine/state-replay.js";
import { parseAndValidateInlineDelta } from "../src/engine/inline-delta.js";
import { selectFactsForZone3 } from "../src/memory/bitemporal.js";
import { partitionEpistemicFacts } from "../src/engine/gates.js";

test("v7-1: Giant 270K pure-text card compiles into Dual-Track Zone 1 Skeleton + lossless Parent-Child recall & 5/5 L1 coverage", () => {
  const filler = "运河沿岸自临清至沧州七十二处水闸，南来北往粮船商旅云集，地方州县与帮派暗中牵制。\n";
  const parts: string[] = [
    "# 第一卷：总纲\n主角：沈青璃（绰号「沉水娘子」，化名「苏晚」）。核心铁律：持「玄铁鱼符」可免三关，但子时过冰河闸失效，唯总督朱批手令例外。\n",
  ];
  for (let ch = 2; ch <= 11; ch++) {
    let sec = `\n# 第${ch}卷：行省志（卷${ch}）\n`;
    for (let i = 0; i < 620; i++) sec += filler;
    if (ch === 6) {
      sec += "\n## 隐秘人物：陆沉舟（外号「断指铁算盘」、「黑水先生」）\n陆沉舟实为青衣盐帮暗堂掌柜，左手缺无名指，掌管十年前盐引冤案真账本。\n";
    }
    if (ch === 11) {
      sec += "\n# 终卷：历史密档\n终卷密档修正：玄铁鱼符实为四枚，第四枚早已沉入德州旧闸底部的青石暗格。\n";
    }
    parts.push(sec);
  }
  const card = compileCharacterCard(
    {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "沈青璃",
        description: parts.join("\n"),
        personality: "外冷内热",
        scenario: "德州北门",
        first_mes: "细雨落下。",
        mes_example: "<START>\n{{char}}: 「账目差了三钱。」",
      },
    },
    "v3",
  );

  assert.ok(card.knowledgeIndex?.dualTrackActive, "giant card should activate dual-track mode");
  const z1 = buildZone1FrozenPrefix({
    card,
    initialPersona: { id: "p1", name: "林客", description: "" },
  });
  assert.ok(estimateTokens(z1) < 16000, `Zone 1 skeleton must stay compact, got ${estimateTokens(z1)}`);

  const analyze = buildAnalyzePrompt(card);
  assert.ok(analyze.userPrompt.includes("玄铁鱼符"), "L1 sees head");
  assert.ok(analyze.userPrompt.includes("陆沉舟"), "L1 sees mid-card needle via head/mid/tail sampling");
  assert.ok(analyze.userPrompt.includes("青石暗格"), "L1 sees tail-card needle");

  const reg = buildEntityRegistry({ card });
  const midHit = recallCardKnowledge({
    knowledgeIndex: card.knowledgeIndex,
    queryText: "断指铁算盘黑水先生掌管什么账本？",
    registry: reg,
    tokenBudget: 2400,
  });
  assert.ok(midHit.passages.some((p) => p.text.includes("陆沉舟")), "alias query recalls mid-card character verbatim");

  const tailHit = recallCardKnowledge({
    knowledgeIndex: card.knowledgeIndex,
    queryText: "第四枚玄铁鱼符沉在哪里？",
    registry: reg,
    tokenBudget: 2400,
  });
  assert.ok(tailHit.passages.some((p) => p.text.includes("青石暗格")), "tail-card revision recalled verbatim");
});

test("v7-2: Denoised BM25 eliminates 4-turn background noise, honors matchWholeWords, excludeRecursion & WeakMap refresh", () => {
  const entries: any[] = [
    { id: "e_cjk", comment: "玄铁鱼符", keys: ["玄铁鱼符"], content: "玄铁鱼符可免三关盘查。", enabled: true },
    { id: "e_en", comment: "Aether", keys: ["Aether"], match_whole_words: true, content: "The Aether Protocol governs relay towers.", enabled: true },
    { id: "e_hop1", comment: "白马渡", keys: ["白马渡"], content: "白马渡与九幽会有关。", enabled: true },
    { id: "e_hop2", comment: "九幽会", keys: ["九幽会"], content: "九幽会由枯梅道人暗中操控。", enabled: true },
    { id: "e_ex", comment: "枯梅道人", keys: ["枯梅道人"], exclude_recursion: true, content: "绝不能被其他条目递归触发。", enabled: true },
  ];
  for (let i = 0; i < 60; i++) {
    entries.push({
      id: `bg_${i}`,
      comment: `地方风物 #${i}`,
      keys: [`冷门_${i}`],
      content: `这是第${i}处日常记录。人们喝茶赶路议论天气与生意，夜里点起灯笼注意安全，没有特别的秘密也没有冲突发生。`,
      enabled: true,
    });
  }
  const book = compileLoreBook({ entries });
  const state = createInitialRpState();
  state.active = true;

  // Whole-word guard not bypassed by "the"
  const enMiss = recallLoreWithGraphPpr({
    entries: book.entries,
    state,
    recentText: "The weather is cold and leather boots are wet.",
    tokenBudget: 4000,
  });
  assert.ok(!enMiss.selected.some((e) => e.id === "e_en"), "matchWholeWords must not be bypassed by BM25 stopwords");

  // 4-turn noisy Chinese text triggers zero background noise
  const noisy = recallLoreWithGraphPpr({
    entries: book.entries,
    state,
    recentText: "今天天气真不错，人们喝茶赶路议论生意，夜里点起灯笼注意安全，没有特别的秘密也没有冲突发生。".repeat(5) + "掏出玄铁鱼符。",
    tokenBudget: 4000,
  });
  assert.ok(noisy.selected.some((e) => e.id === "e_cjk"));
  assert.equal(noisy.selected.filter((e) => e.id.startsWith("bg_")).length, 0, "0 background noise entries");

  // exclude_recursion blocks incoming 2-hop trigger
  const hop = recallLoreWithGraphPpr({
    entries: book.entries,
    state,
    recentText: "说起白马渡的往事。",
    tokenBudget: 4000,
  });
  assert.ok(hop.selected.some((e) => e.id === "e_hop2"));
  assert.ok(!hop.selected.some((e) => e.id === "e_ex"), "exclude_recursion must block incoming hop-2 activation");

  // WeakMap cache refreshes when middle entry content is edited with identical length
  const mid = book.entries[25]!;
  mid.content = "皇陵暗道机关秘钥藏在玉匣之中。".padEnd(mid.content.length, "。");
  const refreshed = recallLoreWithGraphPpr({
    entries: book.entries,
    state,
    recentText: "皇陵暗道机关秘钥藏在玉匣之中",
    tokenBudget: 4000,
  });
  assert.ok(refreshed.selected.some((e) => e.id === mid.id), "edited middle entry must refresh WeakMap BM25 cache");
});

test("v7-3: Inline-delta phys outfit/pose, storylet_done postEffects, auto-superseded facts, alias blind-spot & exact X-Ray stats", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "沈青璃",
        description: "主角：沈青璃（绰号「沉水娘子」）。",
      },
    },
    "v3",
  );
  const reg = buildEntityRegistry({ card });
  const state = createInitialRpState();
  state.active = true;
  state.turn = 10;
  state.presentNpcs = ["沈青璃"];
  applyRpTx(state, {
    kind: "storylet_upsert",
    storylet: {
      id: "st_gate",
      title: "夜探旧闸",
      triggerPrompt: "夜色中旧闸异动",
      status: "triggered",
      createdTurn: 1,
      postEffects: { setFlags: { gate_inspected: true }, nextObjective: "追查盐引去向" },
    },
  });
  applyRpTx(state, {
    kind: "fact_add",
    fact: { id: "f_old", statement: "玄铁鱼符共有三枚。", entities: ["玄铁鱼符"], witnessIds: "public", validFromTurn: 2, validUntilTurn: null },
  });
  applyRpTx(state, {
    kind: "fact_add",
    fact: { id: "f_sec", statement: "林客腰间藏着北镇抚司令牌。", entities: ["林客"], witnessIds: ["player"], validFromTurn: 3, validUntilTurn: null },
  });

  const delta = parseAndValidateInlineDelta(
    `phys: 沈青璃 | outfit=青布棉袄 | pose=倚窗磨药\nstorylet_done: st_gate\nfact: 「玄铁鱼符」实为四枚，第四枚沉在旧闸底。`,
    state,
    reg,
  );
  for (const tx of delta.txs) applyRpTx(state, tx);

  assert.equal(state.flags.gate_inspected, true, "storylet_done must apply postEffects.setFlags");
  assert.equal(state.sceneObjective, "追查盐引去向", "storylet_done must apply postEffects.nextObjective");

  const activeFacts = selectFactsForZone3(state, "玄铁鱼符", 14, 12, reg);
  assert.ok(!activeFacts.some((f) => f.id === "f_old"), "superseded old fact must be auto-invalidated");
  assert.ok(activeFacts.some((f) => f.statement.includes("实为四枚")));

  const { text: z3, stats } = buildZone3TransientTailWithStats({
    card,
    state,
    recalledLore: [],
    recentText: "玄铁鱼符",
    registry: reg,
  });
  assert.ok(z3.includes("青布棉袄") && z3.includes("倚窗磨药"), "phys outfit/pose must render in Zone 3");
  assert.equal(stats.knownFactCount, 1, "exact X-Ray knownFactCount");
  assert.equal(stats.blindSpotCount, 1, "exact X-Ray blindSpotCount");

  // Alias witness must NOT be misclassified as ignorant
  const part = partitionEpistemicFacts(
    [{ id: "f_w", statement: "密室钥匙在佛龛下", entities: ["沈青璃"], witnessIds: ["沈青璃"], validFromTurn: 4, validUntilTurn: null }],
    ["沉水娘子"],
    reg,
  );
  assert.equal(part.blindSpots.length, 0);
  assert.equal(part.known.length, 1);

  // Lossless CCV3 export preserves edited lorebook & fields
  const exported = exportCardToCcv3Json({ spec: "chara_card_v3", spec_version: "3.0", data: { extensions: { custom: 1 } } }, card);
  assert.equal(exported.spec, "chara_card_v3");
  assert.equal((exported.data as any).extensions.custom, 1);
});
