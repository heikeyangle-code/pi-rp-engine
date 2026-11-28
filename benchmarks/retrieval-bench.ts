import { performance } from "node:perf_hooks";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { compileLoreBook } from "../src/parser/lore-compiler.js";
import { buildAnalyzePrompt } from "../src/parser/analyzer.js";
import { recallLoreWithGraphPpr } from "../src/memory/graph-ppr.js";
import { buildEntityRegistry } from "../src/memory/entity-registry.js";
import { recallCardKnowledge } from "../src/parser/card-knowledge.js";
import { buildZone1FrozenPrefix, buildZone3TransientTailWithStats } from "../src/context/zone-builder.js";
import { estimateTokens } from "../src/context/token-budget.js";
import { createInitialRpState, applyRpTx } from "../src/engine/state-replay.js";
import { parseAndValidateInlineDelta } from "../src/engine/inline-delta.js";
import { selectFactsForZone3 } from "../src/memory/bitemporal.js";
import { partitionEpistemicFacts } from "../src/engine/gates.js";

function build272kPureTextCard() {
  const sections: string[] = [
    `# 第一卷：沧溟纪元总纲与核心人物
主角：沈青璃（绰号「沉水娘子」、「三小姐」，化名「苏晚」）。
核心铁律：凡持「玄铁鱼符」者可免三关盘查，但子时过冰河闸失效，唯总督朱批手令例外。`,
  ];
  const filler =
    "运河沿岸自临清至沧州共计七十二处水闸与三十六座草市，每逢霜降前后，南来北往的粮船、盐驳与商旅在堤岸集结，地方州县与帮派暗中牵制。\n";
  for (let ch = 2; ch <= 11; ch++) {
    let body = `\n# 第${ch}卷：行省志（卷${ch}）\n`;
    for (let i = 0; i < 420; i++) body += filler;
    if (ch === 6) {
      body += `\n## 隐秘人物：陆沉舟（外号「断指铁算盘」、「黑水先生」）\n陆沉舟实为青衣盐帮暗堂掌柜，左手缺无名指，掌管十年前盐引冤案真账本。\n`;
      body += `\n## 同名人物甲：林霜（北门药铺学徒）\n十六岁少年药童，性格怯懦，擅长辨认草药。\n`;
      body += `\n## 同名人物乙：林霜（锦衣卫百户·代号「霜刃」）\n三十四岁冷面武官，隶属北镇抚司，暗查私盐案。\n`;
      body += `\n密会中人们低声提及幕后操盘手——「枯梅道人」，藏身太行山废观伪造户部印信。\n`;
    }
    if (ch === 11) {
      body += `\n# 终卷：历史密档\n终卷密档修正：玄铁鱼符实为四枚，第四枚沉入德州旧闸底部的青石暗格。\n`;
    }
    sections.push(body);
  }
  return compileCharacterCard(
    {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "沈青璃",
        nickname: "青璃",
        description: sections.join("\n"),
        personality: "外冷内热",
        scenario: "德州城北门集市",
        first_mes: "细雨打在青瓦上。",
        mes_example: "<START>\n{{char}}: 「账目差了三钱银子。」",
      },
    },
    "v3",
  );
}

const t0 = performance.now();
const card = build272kPureTextCard();
const compileMs = performance.now() - t0;
const z1Tokens = estimateTokens(
  buildZone1FrozenPrefix({ card, initialPersona: { id: "p1", name: "林客", description: "" } }),
);
const reg = buildEntityRegistry({ card });
const analyze = buildAnalyzePrompt(card);

const queries = [
  { name: "开头铁律", q: "玄铁鱼符子时过冰河闸", needle: "朱批手令" },
  { name: "中段别名(陆沉舟)", q: "断指铁算盘黑水先生账本", needle: "陆沉舟" },
  { name: "无标题人物(枯梅道人)", q: "太行山废观枯梅道人印信", needle: "枯梅道人" },
  { name: "同名消歧(锦衣卫霜刃)", q: "北镇抚司锦衣卫林霜霜刃", needle: "北镇抚司" },
  { name: "末尾修正(第四枚)", q: "第四枚玄铁鱼符沉在哪里", needle: "青石暗格" },
];
const hits = queries.filter((x) => {
  const res = recallCardKnowledge({ knowledgeIndex: card.knowledgeIndex, queryText: x.q, registry: reg, tokenBudget: 2400 });
  return res.passages.some((p) => `${p.chapterPath}\n${p.text}`.includes(x.needle));
});

const rawLore: any[] = [
  { id: "e_cjk", comment: "玄铁鱼符", keys: ["玄铁鱼符"], content: "玄铁鱼符可免三关盘查。", enabled: true },
  { id: "e_en", comment: "Aether", keys: ["Aether"], match_whole_words: true, content: "The Aether Protocol governs relay towers.", enabled: true },
  { id: "e_alias", comment: "陆沉舟", keys: ["陆沉舟"], content: "陆沉舟实为暗堂掌柜。", enabled: true },
];
for (let i = 0; i < 197; i++) {
  rawLore.push({
    id: `bg_${i}`,
    comment: `风物志 #${i}`,
    keys: [`冷门_${i}`],
    content: `第${i}处日常记录。人们喝茶赶路议论天气与生意，夜里点起灯笼注意安全，没有特别的秘密也没有冲突发生。`,
    enabled: true,
  });
}
const book = compileLoreBook({ entries: rawLore });
const state = createInitialRpState();
state.active = true;
state.turn = 10;
state.presentNpcs = ["沈青璃"];

const noisy = recallLoreWithGraphPpr({
  entries: book.entries,
  state,
  recentText: "今天天气真不错，人们喝茶赶路议论生意，夜里点起灯笼注意安全，没有特别的秘密也没有冲突发生。".repeat(6) + "玄铁鱼符",
  tokenBudget: 4000,
  registry: reg,
});
const bgNoise = noisy.selected.filter((e) => e.id.startsWith("bg_")).length;

const aliasHit = recallLoreWithGraphPpr({
  entries: book.entries,
  state,
  recentText: "断指铁算盘最近在沧州东市露面了。",
  tokenBudget: 4000,
  registry: reg,
});

// Verify 100-turn state/delta invariants
applyRpTx(state, {
  kind: "fact_add",
  fact: { id: "f_old", statement: "玄铁鱼符共有三枚。", entities: ["玄铁鱼符"], witnessIds: "public", validFromTurn: 1, validUntilTurn: null },
});
const delta = parseAndValidateInlineDelta(
  `phys: 沈青璃 | outfit=青布棉袄 | pose=倚窗磨药\nfact: 「玄铁鱼符」实为四枚，第四枚沉在旧闸底。`,
  state,
  reg,
);
for (const tx of delta.txs) applyRpTx(state, tx);
const z3 = buildZone3TransientTailWithStats({ card, state, recalledLore: [], recentText: "玄铁鱼符", registry: reg });
const activeFacts = selectFactsForZone3(state, "玄铁鱼符", 14, 12, reg);
const aliasPart = partitionEpistemicFacts(
  [{ id: "f_s", statement: "密室钥匙", entities: ["沈青璃"], witnessIds: ["沈青璃"], validFromTurn: 2, validUntilTurn: null }],
  ["沉水娘子"],
  reg,
);

const report = {
  compileMs: Number(compileMs.toFixed(1)),
  zone1Tokens: z1Tokens,
  l1PromptChars: analyze.userPrompt.length,
  cardNeedlesHit: `${hits.length}/${queries.length}`,
  lore4TurnBgNoise: bgNoise,
  aliasRecallOk: aliasHit.selected.some((e) => e.id === "e_alias"),
  physInjectedOk: z3.text.includes("青布棉袄") && z3.text.includes("倚窗磨药"),
  oldFactAutoInvalidated: !activeFacts.some((f) => f.id === "f_old"),
  aliasEpistemicOk: aliasPart.blindSpots.length === 0,
  xrayKnownCount: z3.stats.knownFactCount,
};

console.log(JSON.stringify(report, null, 2));
if (
  hits.length < queries.length ||
  bgNoise > 0 ||
  !report.aliasRecallOk ||
  !report.physInjectedOk ||
  !report.oldFactAutoInvalidated ||
  !report.aliasEpistemicOk
) {
  process.exitCode = 1;
}
