/**
 * L0 Zero-Cost Universal World Profile & Plain-Text Heuristic Extractor (0ms, 0 LLM tokens).
 *
 * Eliminates single-card bias (such as hardcoded "Act I" / "Day 1" on every card):
 *  - Extracts explicit plain-text spatio-temporal anchors (`location`, `time`, `stage`) from
 *    `scenario`, `first_mes`, and `description` when clearly labeled.
 *  - Extracts conservative plain-text key-value stats (e.g. `体力：80/100`, `HP: 100/100`,
 *    or Markdown `| 属性 | 数值 |` tables) for plain-text cards without MVU/JSON blocks.
 *  - Infers `CardArchetype` and `WorldProfileModules` so companion/slice-of-life cards stay
 *    clean and uncluttered while epic/RPG/mystery cards automatically enable stages/inventory/clocks.
 */

import type {
  CardArchetype,
  CardWorldProfile,
  CompiledLoreEntry,
  SalvagedVariable,
  WorldProfileModules,
} from "../types.js";

function cleanPhrase(raw: string): string {
  return raw
    .replace(/^[\s：:·\-—]+/, "")
    .replace(/[\s。；;]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract explicitly labeled location, time, or stage/arc from plain-text scenario/first_mes. */
export function extractPlainTextAnchors(sources: {
  scenario?: string;
  firstMes?: string;
  description?: string;
}): { initialLocation?: string; initialTime?: string; initialStage?: string } {
  const pool = [sources.scenario ?? "", sources.firstMes ?? "", sources.description ?? ""].join("\n");

  let initialStage: string | undefined;
  let initialTime: string | undefined;
  let initialLocation: string | undefined;

  // Stage / Era / Act / Chapter header (ONLY when explicitly written by the card author)
  const stagePatterns = [
    /【(?:当前纪元|当前阶段|当前幕次|当前章节|序幕|第一幕)[·：:\s]*([^】\n]{2,36})】/,
    /(?:^|\n)\s*(?:当前纪元|当前阶段|当前幕次|当前章节|Current\s+(?:Era|Stage|Act|Chapter))\s*[：:]\s*([^\n]{2,36})/i,
  ];
  for (const re of stagePatterns) {
    const m = re.exec(pool);
    if (m && m[1]) {
      initialStage = cleanPhrase(m[1]);
      break;
    }
  }

  // Time / Date label
  const timePatterns = [
    /【(?:当前时间|时间|对应时间|日期|年代)[·：:\s]*([^】\n]{2,36})】/,
    /(?:^|\n)\s*(?:当前时间|对应时间|初始时间|时间|日期|Time|Date)\s*[：:]\s*([^\n]{2,36})/i,
  ];
  for (const re of timePatterns) {
    const m = re.exec(pool);
    if (m && m[1]) {
      const candidate = cleanPhrase(m[1]).split(/[，,。；;]/)[0]?.trim() ?? "";
      if (candidate.length >= 2 && candidate.length <= 36) {
        initialTime = candidate;
        break;
      }
    }
  }

  // Location label
  const locationPatterns = [
    /【(?:当前地点|初始位置|玩家初始位置|所在地点|地点|位置)[·：:\s]*([^】\n]{2,36})】/,
    /(?:^|\n)\s*(?:玩家初始位置|初始位置|当前地点|所在地点|初始地点|地点|Location)\s*[：:]\s*([^\n]{2,40})/i,
  ];
  for (const re of locationPatterns) {
    const m = re.exec(pool);
    if (m && m[1]) {
      const candidate = cleanPhrase(m[1]).split(/[→。；;（(]/)[0]?.trim() ?? "";
      if (candidate.length >= 2 && candidate.length <= 36) {
        initialLocation = candidate;
        break;
      }
    }
  }

  return { initialLocation, initialTime, initialStage };
}

/**
 * Conservatively extract explicit plain-text stat pairs (e.g. `体力：80/100`, `HP: 100/100`,
 * `好感度：20`, or Markdown 2-column `| 属性 | 数值 |` rows) from plain-text cards.
 */
export function extractPlainTextStats(text: string): SalvagedVariable[] {
  if (!text) return [];
  const found = new Map<string, SalvagedVariable>();

  const register = (key: string, val: number, max?: number) => {
    const clean = key.trim();
    if (!clean || clean.length > 24) return;
    // Skip obvious non-stat labels like years, chapters, dates, ages in prose
    if (/^(?:年份|年代|公元|第|章|节|幕|轮|回合|时间|日期|年龄|身高|体重|year|date|time|turn|chapter|act)$/i.test(clean)) {
      return;
    }
    if (!found.has(clean)) {
      found.set(clean, {
        key: clean,
        initialValue: val,
        min: 0,
        max,
        source: "first_mes",
      });
    }
  };

  // 1. Bounded fraction form: `体力：80/100`, `HP: 100/100`, `理智 65/100`
  const boundedRe = /(?:^|[\n|｜·•\s【\[])([\u4e00-\u9fa5A-Za-z]{2,12})\s*[：:=]\s*(\d{1,5})\s*\/\s*(\d{1,5})(?=$|[\n|｜·•\s】\]，,。])/g;
  let m: RegExpExecArray | null;
  while ((m = boundedRe.exec(text)) !== null) {
    const val = Number(m[2]);
    const max = Number(m[3]);
    if (Number.isFinite(val) && Number.isFinite(max) && max > 0 && val <= max * 2) {
      register(m[1]!, val, max);
    }
  }

  // 2. Explicit RPG/SLG scalar keywords: `好感度：20`, `金钱：500`, `银两：10`
  const knownStatRe =
    /(?:^|[\n|｜·•\s【\[])(好感度|好感|信任度|亲密度|体力|生命|血量|精力|理智|饥饿度|饱食度|金钱|银两|铜钱|大洋|金币|声望|压力|HP|MP|SP|SAN|Gold|Affection|Trust|Stamina)\s*[：:=]\s*(-?\d{1,6})(?=$|[\n|｜·•\s】\]，,。%])/gi;
  while ((m = knownStatRe.exec(text)) !== null) {
    const val = Number(m[2]);
    if (Number.isFinite(val)) {
      register(m[1]!, val);
    }
  }

  return Array.from(found.values());
}

/**
 * Infer a universal `CardWorldProfile` heuristically at import time (0 tokens).
 * Keeps slice-of-life / companion cards minimal and activates advanced modules only when relevant.
 */
export function inferHeuristicWorldProfile(options: {
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  loreEntries: CompiledLoreEntry[];
  salvagedVariables: SalvagedVariable[];
  hasGroupGreetings: boolean;
}): CardWorldProfile {
  const anchors = extractPlainTextAnchors({
    scenario: options.scenario,
    firstMes: options.firstMes,
    description: options.description,
  });

  const combined = `${options.description}\n${options.personality}\n${options.scenario}\n${options.firstMes}`;
  const hasGatedLore = options.loreEntries.some(
    (e) => Boolean(e.gate?.requiredEra) || (e.gate?.minTurn ?? 0) > 0 || Boolean(e.gate?.requiredMilestones?.length),
  );

  const mentionsStage =
    Boolean(anchors.initialStage) ||
    hasGatedLore ||
    /(?:纪元[一二三四\d]|第一幕|第二幕|阶段[一二三\d]|Act\s+[I1-4]|Chapter\s+\d)/i.test(combined);

  const mentionsStats =
    options.salvagedVariables.length > 0 ||
    /(?:好感度|生命值|体力值|理智值|属性检定|掷骰|\bHP\b|\bMP\b|\bSAN\b|d20|d100)/i.test(combined);

  const mentionsInventory =
    /(?:行囊|背包|随身物品|道具栏|装备栏|携带物品|inventory|equipment|backpack)/i.test(combined);

  const mentionsClocks =
    /(?:倒计时|进度条|警觉度|悬疑|凶手|线索|案发现场|势力|阵营|countdown|investigation|faction|clock)/i.test(combined);

  const mentionsMystery = /(?:凶手|推理|剧本杀|嫌疑人|密室|线索|detective|mystery|murder|suspect)/i.test(combined);
  const mentionsEnsemble = options.hasGroupGreetings || options.loreEntries.length >= 20;

  let archetype: CardArchetype = "companion";
  if (mentionsMystery) {
    archetype = "mystery";
  } else if (mentionsStage && options.loreEntries.length >= 6) {
    archetype = "epic-saga";
  } else if (mentionsStats || mentionsInventory) {
    archetype = "rpg-sandbox";
  } else if (mentionsEnsemble) {
    archetype = "ensemble";
  } else if (/(?:县城|都市|现代|校园|日常|经营|小店|生活|office|modern|slice of life)/i.test(combined)) {
    archetype = "slice-of-life";
  }

  const modules: WorldProfileModules = {
    stats: mentionsStats,
    inventory: mentionsInventory,
    clocks: mentionsClocks || archetype === "mystery" || archetype === "epic-saga",
    stages: mentionsStage,
  };

  return {
    archetype,
    modules,
    initialLocation: anchors.initialLocation,
    initialTime: anchors.initialTime,
    initialStage: anchors.initialStage,
    initialPresentNpcs: [],
    initialInventory: [],
    suggestedCfsmAxes: [],
    entityAliases: {},
    suggestedLoreGates: [],
    source: "heuristic",
  };
}
