/**
 * Universal Temporal Arithmetic, Calendar Anchoring & Lifespan Continuity Engine.
 *
 * Solves two root causes of broken AI roleplay time skips across ALL worldviews:
 * 1. LLM calendar/era math hallucination (e.g. miscalculating imperial reigns or Gregorian offsets).
 * 2. Sycophantic lifespan violations (e.g. jumping 320 years in a mortal world while keeping
 *    mortal protagonists and NPCs magically alive and unchanged).
 */

export type SpanTier = "hours" | "days" | "months" | "years" | "generational";
export type LifespanProfile = "mortal" | "long_lived" | "scifi_stasis";
export type ContinuityMode = "natural_aging" | "generational_legacy" | "stasis_or_portal" | "immortal_span";

export interface ParsedTimeSpan {
  dayDelta: number;
  years: number;
  spanTier: SpanTier;
}

export interface CalendarAnchor {
  system: "chinese_era" | "gregorian" | "fictional_year";
  sourceYear: number;
  targetYear: number;
  targetEraLabel?: string;
  exactHint: string;
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Parse Arabic digits or Chinese numerals (e.g. "元"->1, "五十三"->53, "三百二十"->320, "二零二六"->2026, "320"->320). */
export function parseFlexNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "元" || s === "首") return 1;
  if (s === "半") return 0.5;

  // Handle trailing "半" (e.g. "一半" -> 1.5, "两半" -> 2.5)
  if (s.length > 1 && s.endsWith("半")) {
    const base = parseFlexNumber(s.slice(0, -1));
    if (base !== null) return base + 0.5;
  }

  // Handle digit-by-digit Chinese numerals (e.g. "二零二六" -> 2026, "一九四五" -> 1945)
  // Guard against Chinese approximate pairs like "两三" (2-3) or "三五" (3-5) being parsed as 23 / 35!
  const chars = Array.from(s);
  if (chars.length >= 2 && chars.every((ch) => CN_DIGITS[ch] !== undefined)) {
    if (chars.length >= 4 || chars.includes("零") || chars.includes("〇")) {
      let val = 0;
      for (const ch of chars) {
        val = val * 10 + CN_DIGITS[ch]!;
      }
      return val;
    }
    // Approximate pair (e.g. "两三" -> 3, "三五" -> 4): take rounded midpoint
    const a = CN_DIGITS[chars[0]!] ?? 0;
    const b = CN_DIGITS[chars[chars.length - 1]!] ?? a;
    return Math.round((a + b) / 2);
  }

  let total = 0;
  let current = 0;
  let matchedAny = false;

  for (const ch of chars) {
    const digit = CN_DIGITS[ch];
    if (digit !== undefined) {
      current = digit;
      matchedAny = true;
    } else if (ch === "十") {
      total += (current || 1) * 10;
      current = 0;
      matchedAny = true;
    } else if (ch === "百") {
      total += (current || 1) * 100;
      current = 0;
      matchedAny = true;
    } else if (ch === "千") {
      total += (current || 1) * 1000;
      current = 0;
      matchedAny = true;
    } else if (ch === "万" || ch === "萬") {
      total = (total + current || 1) * 10000;
      current = 0;
      matchedAny = true;
    } else {
      return null;
    }
  }
  if (!matchedAny) return null;
  return total + current;
}

const NUM_TOKEN = "(?:\\d+(?:\\.\\d+)?|[零〇一二两兩三四五六七八九十百千万萬元半]+)";

/**
 * Compact historical Chinese reign table (Gregorian year of Year 1 & last year).
 * Covers major Ming/Qing/Republic + well-known Han/Tang/Song/Yuan eras for exact arithmetic.
 */
interface EraSpan {
  name: string;
  startYear: number;
  endYear: number;
}

const CHINESE_ERAS: EraSpan[] = [
  // Han / Three Kingdoms
  { name: "建安", startYear: 196, endYear: 220 },
  // Tang
  { name: "贞观", startYear: 627, endYear: 649 },
  { name: "开元", startYear: 713, endYear: 741 },
  { name: "天宝", startYear: 742, endYear: 756 },
  // Song
  { name: "熙宁", startYear: 1068, endYear: 1077 },
  { name: "宣和", startYear: 1119, endYear: 1125 },
  { name: "绍兴", startYear: 1131, endYear: 1162 },
  // Ming
  { name: "洪武", startYear: 1368, endYear: 1398 },
  { name: "建文", startYear: 1399, endYear: 1402 },
  { name: "永乐", startYear: 1403, endYear: 1424 },
  { name: "洪熙", startYear: 1425, endYear: 1425 },
  { name: "宣德", startYear: 1426, endYear: 1435 },
  { name: "正统", startYear: 1436, endYear: 1449 },
  { name: "景泰", startYear: 1450, endYear: 1457 },
  { name: "天顺", startYear: 1457, endYear: 1464 },
  { name: "成化", startYear: 1465, endYear: 1487 },
  { name: "弘治", startYear: 1488, endYear: 1505 },
  { name: "正德", startYear: 1506, endYear: 1521 },
  { name: "嘉靖", startYear: 1522, endYear: 1566 },
  { name: "隆庆", startYear: 1567, endYear: 1572 },
  { name: "万历", startYear: 1573, endYear: 1620 },
  { name: "泰昌", startYear: 1620, endYear: 1620 },
  { name: "天启", startYear: 1621, endYear: 1627 },
  { name: "崇祯", startYear: 1628, endYear: 1644 },
  // Qing
  { name: "顺治", startYear: 1644, endYear: 1661 },
  { name: "康熙", startYear: 1662, endYear: 1722 },
  { name: "雍正", startYear: 1723, endYear: 1735 },
  { name: "乾隆", startYear: 1736, endYear: 1795 },
  { name: "嘉庆", startYear: 1796, endYear: 1820 },
  { name: "道光", startYear: 1821, endYear: 1850 },
  { name: "咸丰", startYear: 1851, endYear: 1861 },
  { name: "同治", startYear: 1862, endYear: 1874 },
  { name: "光绪", startYear: 1875, endYear: 1908 },
  { name: "宣统", startYear: 1909, endYear: 1911 },
  // Republic of China
  { name: "民国", startYear: 1912, endYear: 1949 },
];

const ERA_NAMES_RE_PART = CHINESE_ERAS.map((e) => e.name).join("|");
const ABSOLUTE_YEAR_PREFIX_RE = new RegExp(
  `(?:公元|AD|BC|CE|[\\u4e00-\\u9fffA-Za-z]+历|纪元|跳到|直到|来到|回到|穿越到|到达|到|至|于|${ERA_NAMES_RE_PART})\\s*$`,
  "i",
);

/** Deterministically parse a free-text time jump description into dayDelta, years, and tier. */
export function parseTimeSpan(desc: string): ParsedTimeSpan {
  const text = desc.trim();
  if (!text) return { dayDelta: 0, years: 0, spanTier: "hours" };

  let years = 0;
  let days = 0;

  const centuryMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:个?世纪|centur(?:y|ies))`, "i").exec(text);
  if (centuryMatch) {
    const n = parseFlexNumber(centuryMatch[1] ?? "");
    if (n && n > 0) years += n * 100;
  }

  const yearMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:余?年|载|載|years?|yrs?)(\\s*半)?`, "i").exec(text);
  if (yearMatch) {
    const prefix = text.slice(0, yearMatch.index);
    const suffix = text.slice(yearMatch.index + yearMatch[0].length);
    const isAbsoluteYear = ABSOLUTE_YEAR_PREFIX_RE.test(prefix);
    const n = parseFlexNumber(yearMatch[1] ?? "");
    const isBareCalendarYear = Boolean(n && n >= 1000 && !/^(?:\s*(?:后|後|之后|之後|以后|以後|later|ahead))/i.test(suffix));
    if (!isAbsoluteYear && !isBareCalendarYear) {
      if (n && n > 0) {
        years += n + (yearMatch[2] ? 0.5 : 0);
      }
    }
  } else if (/百年|一世纪/i.test(text) && years === 0) {
    years = 100;
  } else if (/半年/i.test(text) && years === 0) {
    years = 0.5;
  } else if (/来年|明年|翌年|次年/i.test(text) && years === 0) {
    years = 1;
  }

  const seasonMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:个?季度?|seasons?)`, "i").exec(text);
  if (seasonMatch) {
    const n = parseFlexNumber(seasonMatch[1] ?? "");
    if (n && n > 0) days += Math.round(n * 90);
  }

  const monthMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:个?月|months?)(\\s*半)?`, "i").exec(text);
  if (monthMatch) {
    const n = parseFlexNumber(monthMatch[1] ?? "");
    if (n && n > 0) {
      const totalMonths = n + (monthMatch[2] ? 0.5 : 0);
      if (totalMonths >= 12) {
        const fullYears = Math.floor(totalMonths / 12);
        const remMonths = totalMonths - fullYears * 12;
        years += fullYears;
        days += Math.round(remMonths * 30);
      } else {
        days += Math.round(totalMonths * 30);
      }
    }
  } else if (/半月|半个月/i.test(text)) {
    days += 15;
  }

  const weekMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:周|星期|礼拜|weeks?)`, "i").exec(text);
  if (weekMatch) {
    const n = parseFlexNumber(weekMatch[1] ?? "");
    if (n && n > 0) days += Math.round(n * 7);
  }

  const dayMatch = new RegExp(`(${NUM_TOKEN})\\s*(?:天|日|昼夜|days?)(\\s*半)?`, "i").exec(text);
  if (dayMatch) {
    const n = parseFlexNumber(dayMatch[1] ?? "");
    if (n && n > 0) days += Math.round(n + (dayMatch[2] ? 0.5 : 0));
  } else if (days === 0 && years === 0 && /次日|明天|隔日|翌日|明早/i.test(text)) {
    days = 1;
  }

  const totalDays = Math.round(years * 365 + days);
  const totalYears = totalDays / 365;

  let spanTier: SpanTier = "hours";
  if (totalYears >= 30) spanTier = "generational";
  else if (totalYears >= 1) spanTier = "years";
  else if (totalDays >= 20) spanTier = "months";
  else if (totalDays >= 1) spanTier = "days";

  return {
    dayDelta: totalDays,
    years: Number(totalYears.toFixed(2)),
    spanTier,
  };
}

function formatYearInChineseEras(gregorianYear: number): string {
  for (const era of CHINESE_ERAS) {
    if (gregorianYear >= era.startYear && gregorianYear <= era.endYear) {
      const regnal = gregorianYear - era.startYear + 1;
      const regnalStr = regnal === 1 ? "元" : String(regnal);
      return `${era.name}${regnalStr}年（公元${gregorianYear}年）`;
    }
  }
  return `公元${gregorianYear}年`;
}

/**
 * Compute an authoritative mathematical year anchor when `currentLabel` contains
 * a recognizable Chinese reign year, fictional calendar year, or Gregorian year.
 */
export function computeCalendarAnchor(
  currentLabel: string,
  yearsDelta: number,
  dayDelta: number,
): CalendarAnchor | null {
  const label = currentLabel.trim();
  const wholeYears =
    yearsDelta >= 1
      ? Math.round(yearsDelta)
      : dayDelta >= 360
        ? Math.max(1, Math.round(dayDelta / 365))
        : Math.floor(dayDelta / 365);
  if (!label || wholeYears === 0) return null;

  // 1. Chinese imperial reign year (e.g. "崇祯七年", "康熙53年", "乾隆元年")
  // Strip parenthetical comparative notes like "（距崇祯七年整八十年）" first, and pick the earliest match by index!
  const primaryLabel = label.replace(/[（(][^）)]*[）)]/g, " ").trim() || label;
  const searchCandidates = primaryLabel !== label ? [primaryLabel, label] : [label];
  for (const candidate of searchCandidates) {
    let best: { idx: number; eraName: string; rawNum: string; startYear: number; regnal: number } | null = null;
    for (const era of CHINESE_ERAS) {
      const re = new RegExp(`${era.name}\\s*(${NUM_TOKEN})\\s*年`);
      const m = re.exec(candidate);
      if (m) {
        const regnal = parseFlexNumber(m[1] ?? "");
        if (regnal && regnal >= 1 && regnal <= 100) {
          if (!best || m.index < best.idx) {
            best = { idx: m.index, eraName: era.name, rawNum: m[1]!, startYear: era.startYear, regnal };
          }
        }
      }
    }
    if (best) {
      const sourceYear = best.startYear + Math.round(best.regnal) - 1;
      const targetYear = sourceYear + wholeYears;
      const targetEraLabel = formatYearInChineseEras(targetYear);
      return {
        system: "chinese_era",
        sourceYear,
        targetYear,
        targetEraLabel,
        exactHint: `Exact calendar math: ${best.eraName}${best.rawNum}年 = ${sourceYear} CE; +${wholeYears} years = ${targetEraLabel}. Do NOT invent a different year or era.`,
      };
    }
  }

  // 2. Fictional calendar year BEFORE Gregorian (e.g. "星历 2380 年", "第三纪元412年", "Year 412")
  const ficMatch = /([\u4e00-\u9fffA-Za-z]+历|[\u4e00-\u9fffA-Za-z]*纪元|Year)\s*(\d+)\s*年?/i.exec(label);
  if (ficMatch && !/^(?:公历|西历)$/i.test(ficMatch[1] ?? "")) {
    const sourceYear = Number(ficMatch[2]);
    const targetYear = sourceYear + wholeYears;
    return {
      system: "fictional_year",
      sourceYear,
      targetYear,
      targetEraLabel: `${ficMatch[1]} ${targetYear}`,
      exactHint: `Exact fictional calendar math: ${ficMatch[1]} ${sourceYear} + ${wholeYears} years = ${ficMatch[1]} ${targetYear}.`,
    };
  }

  // 3. Explicit Gregorian year (e.g. "2026年", "公元1634年", "1945-08")
  const gregMatch = /(?:公元|AD\s*)?(\d{3,4})\s*(?:年|[-/.]|CE\b)/i.exec(label);
  if (gregMatch) {
    const sourceYear = Number(gregMatch[1]);
    if (sourceYear >= 100 && sourceYear <= 9999) {
      const targetYear = sourceYear + wholeYears;
      return {
        system: "gregorian",
        sourceYear,
        targetYear,
        targetEraLabel: `${targetYear}年`,
        exactHint: `Exact calendar math: ${sourceYear} + ${wholeYears} years = ${targetYear}. Do NOT invent a different year.`,
      };
    }
  }

  return null;
}

/** Card-agnostic detection of worldview longevity signals. */
export function detectLifespanProfile(worldText: string): LifespanProfile {
  const s = worldText || "";
  if (/(?:修仙|修真|长生|長生|筑基|金丹|元婴|化神|飞升|仙界|永生|不老|吸血鬼|血族|精灵|精靈|神明|神族|不死|immortal|cultivation|xianxia|vampire|elf|elven|demigod|ageless)/i.test(s)) {
    return "long_lived";
  }
  if (/(?:休眠|冬眠|冷冻舱|冷凍艙|星际|星際|亚光速|时间膨胀|时空穿越|时间旅行|cryo|stasis|hibernation|relativistic|time travel|time loop)/i.test(s)) {
    return "scifi_stasis";
  }
  return "mortal";
}

/** Build continuity rules injected into the downtime simulator prompt. */
export function buildContinuityDirective(
  mode: ContinuityMode,
  years: number,
  profile: LifespanProfile,
): string {
  switch (mode) {
    case "generational_legacy":
      return (
        `CONTINUITY MODE = GENERATIONAL LEGACY (+${years} years). ` +
        `Original mortal characters have aged out or passed away; transition focus to descendants, successors, or historical echoes of their deeds. ` +
        `Clear deceased mortal NPCs from presentNpcs and reflect institutional/architectural/era evolution.`
      );
    case "stasis_or_portal":
      return (
        `CONTINUITY MODE = STASIS / SEAL / TIME-PORTAL (+${years} years). ` +
        `The protagonist's body remained suspended/displaced across ${years} years while the outside world moved on. ` +
        `Unless an NPC is explicitly immortal, mortal acquaintances from before the jump are old or long deceased.`
      );
    case "immortal_span":
      return (
        `CONTINUITY MODE = LONG-LIVED / IMMORTAL WORLD (+${years} years, profile=${profile}). ` +
        `Long-lived beings survive and evolve (cultivation/power/factions shift), while ordinary mortal surroundings still age and turn over across generations.`
      );
    case "natural_aging":
    default:
      return years >= 10
        ? `CONTINUITY MODE = NATURAL AGING (+${years} years, profile=${profile}). Explicitly reflect realistic aging, career/status progression, and world changes for all characters.`
        : `CONTINUITY MODE = CONTINUOUS TIMELINE. Keep character ages, injuries, and active threads consistent with the elapsed span.`;
  }
}
