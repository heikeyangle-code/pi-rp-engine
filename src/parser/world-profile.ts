/**
 * L0 Zero-Cost Universal World Profile & Plain-Text State Extractor.
 *
 * v3 Fixes:
 *  - Negative initial stats (e.g. `好感度：-15`, `声望：-20`) no longer get clamped to 0 by a hardcoded `min: 0`!
 *    Bipolar relationship/alignment scales preserve negative bounds (`min: -100` or `min: Math.min(-100, val)`).
 *  - Rich single-character worldbook cards (>= 20 lore entries) are NO LONGER misclassified as `ensemble`
 *    unless genuine multi-character signals (group greetings or explicit multi-protagonist cues) exist.
 */

import type {
  CardArchetype,
  CardWorldProfile,
  CompiledLoreEntry,
  SalvagedVariable,
  WorldProfileModules,
} from "../types.js";

const STAGE_PATTERNS: RegExp[] = [
  /【\s*当前(?:纪元|阶段|章节|幕次)[·:：\s]+([^】\n]{2,36})\s*】/i,
  /(?:当前(?:纪元|阶段|章节|幕次)|纪元|章节|阶段)\s*[:：]\s*([^\n，。,.;；】]{2,36})/i,
  /(?:^|\n)\s*(第[一二三四五六七八九十百0-9]+[幕章篇卷](?:[·\s：:][^\n]{1,24})?)/m,
  /(?:^|\n)\s*((?:Act|Chapter|Arc|Episode)\s+[IVX0-9]+(?:[:\s\-–][^\n]{1,24})?)/im,
];

const TIME_PATTERNS: RegExp[] = [
  /(?:当前时间|对应时间|初始时间|时间|日期|时刻)\s*[:：]\s*([^\n，。,.;；]{2,36})/i,
  /\b(?:Time|Date)\s*[:：]\s*([^\n,;]{2,36})/i,
];

const LOCATION_PATTERNS: RegExp[] = [
  /(?:玩家初始位置|初始(?:地点|位置|场景)|当前(?:地点|位置|场景)|地点|场景|位置)\s*[:：]\s*([^\n，。,.;；]{2,40})/i,
  /\b(?:Location|Place|Setting)\s*[:：]\s*([^\n,;]{2,40})/i,
];

const BIPOLAR_STAT_RE = /(?:好感|关系|声望|信任|阵营|善恶|倾向|态度|亲密|情绪|affection|trust|reputation|karma|alignment|disposition|affinity)/i;

/** Extract explicit plain-text stats like `好感度：50/100` or `好感度：-15` or `HP: 80/100` (zero LLM cost). */
export function extractPlainTextStats(text: string): SalvagedVariable[] {
  if (!text) return [];
  const results = new Map<string, SalvagedVariable>();

  const boundedRe =
    /(?:^|[\n|｜·•\s【\[])([\u4e00-\u9fffA-Za-z_]{1,16})\s*[:：=]\s*(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = boundedRe.exec(text)) !== null) {
    const key = m[1]!.trim();
    const val = Number(m[2]);
    const max = Number(m[3]);
    if (!key || !Number.isFinite(val) || !Number.isFinite(max) || max <= 0) continue;
    if (
      /^(?:http|https|date|time|birthday|birth|score|ratio|page|chapter|年|月|日|日期|时间|生日|诞辰|比分|得分|战绩|页码|页|章节)$/i.test(
        key,
      )
    ) {
      continue;
    }
    if (!results.has(key)) {
      const allowNegative = val < 0 || BIPOLAR_STAT_RE.test(key);
      const min = allowNegative ? Math.min(-max, val) : 0;
      results.set(key, {
        key,
        initialValue: val,
        min,
        max,
        source: "first_mes",
      });
    }
  }

  const singleStatRe =
    /(?:^|[\n|｜·•\s【\[])(好感度?|信任度?|亲密度?|理智值?|SAN|压力值?|HP|MP|生命值?|体力值?|魔力值?|金币|金钱|银币|铜币|声望|警觉度?|Affection|Trust|Sanity|Stress|Stamina|Gold|Credits|Reputation|Karma)\s*[:：=]\s*(-?\d+(?:\.\d+)?)(?!\s*\/)/gi;
  while ((m = singleStatRe.exec(text)) !== null) {
    const key = m[1]!.trim();
    const val = Number(m[2]);
    if (!key || !Number.isFinite(val) || results.has(key)) continue;
    const isCurrency = /^(?:金币|金钱|银币|铜币|gold|credits)$/i.test(key);
    const isBipolar = val < 0 || BIPOLAR_STAT_RE.test(key);
    results.set(key, {
      key,
      initialValue: val,
      min: isCurrency ? 0 : isBipolar ? Math.min(-100, val) : 0,
      max: isCurrency ? undefined : Math.max(100, Math.abs(val)),
      source: "first_mes",
    });
  }

  return Array.from(results.values());
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]?.trim()) {
      return m[1].trim().replace(/[*_`]+/g, "").trim();
    }
  }
  return undefined;
}

/** Extract explicit plain-text stage, time, and starting location anchors (zero LLM cost). */
export function extractPlainTextAnchors(input: {
  scenario?: string;
  firstMes?: string;
  description?: string;
}): {
  initialStage?: string;
  initialTime?: string;
  initialLocation?: string;
} {
  const anchorPool = [input.scenario ?? "", input.firstMes ?? "", input.description ?? ""].filter(Boolean).join("\n");
  const initialStage = firstMatch(anchorPool, STAGE_PATTERNS);
  const initialTime = firstMatch(anchorPool, TIME_PATTERNS);
  const rawLocation = firstMatch(anchorPool, LOCATION_PATTERNS);
  const initialLocation = rawLocation ? rawLocation.split(/\s*(?:→|->|=>)\s*/)[0]?.trim() || rawLocation : undefined;
  return { initialStage, initialTime, initialLocation };
}

/**
 * Infer a universal CardWorldProfile strictly from card structure & text signals (0 LLM tokens).
 * Guarantees that pure companion/slice-of-life cards never get forced RPG inventory/clocks/Act I,
 * while RPG/mystery/epic-saga cards automatically enable the mechanics they actually use.
 */
export function inferHeuristicWorldProfile(input: {
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  loreEntries: CompiledLoreEntry[];
  salvagedVariables: SalvagedVariable[];
  hasGroupGreetings?: boolean;
}): CardWorldProfile {
  const combined = `${input.description}\n${input.personality}\n${input.scenario}\n${input.firstMes}`;
  const { initialStage, initialTime, initialLocation } = extractPlainTextAnchors({
    scenario: input.scenario,
    firstMes: input.firstMes,
    description: input.description,
  });

  const hasRpgSignals =
    /(?:\bHP\b|\bMP\b|\bATK\b|\bDEF\b|\bLV\b|\bEXP\b|\bD20\b|背包|物品栏|道具栏|装备|属性面板|生命值|魔力值|技能检定|投骰|掷骰|经验值|地下城|冒险者|公会|inventory|hit points|spell slot|skill check)/i.test(
      combined,
    );
  const hasMysterySignals =
    /(?:案件|侦探|凶手|悬疑|推理|密室|嫌疑人|调查员|克苏鲁|\bCoC\b|\bdetective\b|\bmurder\b|\bsuspect\b|\binvestigation\b|\bwhodunit\b)/i.test(
      combined,
    );
  const hasEpicSignals =
    Boolean(initialStage) ||
    /(?:纪元|帝国|王国|大陆|编年史|战争|势力|派系|宗门|朝代|王朝|星际|修仙|史诗|chronicle|kingdom|empire|faction|dynasty|realm|saga)/i.test(
      combined,
    );
  const hasEnsembleCues =
    Boolean(input.hasGroupGreetings) ||
    /(?:群像|多角色|攻略对象|后宫|角色列表|人物表|\bmain cast\b|\bensemble cast\b|\bmultiple characters\b)/i.test(
      `${input.description}\n${input.scenario}`,
    );
  const hasSliceSignals =
    /(?:日常|校园|同居|合租|咖啡馆|青梅竹马|社团|同学|邻家|下班|周末|slice of life|roommate|cafe|school life)/i.test(
      combined,
    );

  let archetype: CardArchetype = "companion";
  if (hasEnsembleCues) archetype = "ensemble";
  else if (hasMysterySignals) archetype = "mystery";
  else if (hasRpgSignals) archetype = "rpg-sandbox";
  else if (hasEpicSignals && input.loreEntries.length >= 6) archetype = "epic-saga";
  else if (hasSliceSignals) archetype = "slice-of-life";
  else archetype = "companion";

  const hasExplicitStats = input.salvagedVariables.length > 0;
  const hasInventoryWords = /(?:背包|物品栏|持有物|道具|装备|金币|inventory|backpack|items?:)/i.test(combined);
  const hasClockWords =
    /(?:倒计时|警戒度|警觉度|警戒值|进度条|期限|\bcountdown\b|\bprogress clock\b|\bdoom clock\b|\balert level\b)/i.test(
      combined,
    );

  const modules: WorldProfileModules = {
    stats: hasExplicitStats || archetype === "rpg-sandbox" || archetype === "mystery" || archetype === "epic-saga",
    inventory: hasInventoryWords || archetype === "rpg-sandbox" || archetype === "mystery",
    clocks: hasClockWords || archetype === "mystery" || archetype === "epic-saga" || archetype === "rpg-sandbox",
    stages: Boolean(initialStage) || archetype === "epic-saga",
  };

  return {
    archetype,
    modules,
    initialLocation,
    initialTime,
    initialStage: modules.stages ? initialStage : undefined,
    initialPresentNpcs: [],
    initialInventory: [],
    suggestedCfsmAxes: [],
    entityAliases: {},
    suggestedLoreGates: [],
    source: "heuristic",
  };
}
