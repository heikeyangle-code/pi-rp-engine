/**
 * Unified Entity Hygiene & Actor Canonicalization Guard.
 *
 * Eliminates the #1 character/relationship pollution bug in AI RP engines:
 *  - Prevents non-character containers, system namespaces, places, organizations,
 *    and item/stat category names (`world`, `任务`, `属性`, `经济`, `系统`, `酒馆`, `帝国`)
 *    from leaking into `presentNpcs`, `pairBonds`, `npcAgendas`, or the Character Panel.
 *  - Canonicalizes player aliases (`player`, `user`, `玩家`, `主角`, `我`, persona name)
 *    to `"player"` so the player never appears as 2–3 duplicate entries.
 *  - Canonicalizes symmetric NPC pair-bond keys (`A::B` == `B::A`) and blocks self-bonds.
 */

export const PLAYER_ALIAS_RE =
  /^(?:player|user|pc|mc|protagonist|hero|玩家|主角|我|自己|自身|本人|你|阁下)$/i;

export const NON_CHARACTER_EXACT_RE =
  /^(?:world|global|env|environment|scene|system|meta|narrator|gm|dm|ai|default|unknown|none|null|undefined|n\/a|all|everyone|everybody|nobody|anybody|other|others|misc|general|info|status|stats|stat|state|data|vars?|flags?|clocks?|inventory|items?|equipment|skills?|quests?|missions?|events?|story|plot|timeline|time|date|weather|location|place|map|economy|money|gold|currency|faction|factions|guild|party|team|group|世界|全局|环境|场景|系统|旁白|叙事|主持人|默认|未知|无|无人|没有|空|大家|所有人|众人|全体|其他|信息|状态|状态栏|属性|数值|变量|标记|时钟|背包|物品|物品栏|道具|装备|技能|任务|主线|支线|事件|剧情|世界观|时间|日期|天气|地点|位置|地图|经济|金钱|金币|货币|资源|阵营|势力|派系|组织|公会|团队|队伍|关系|关系网|好感|好感度|规则|设置|进度|日志|记录|备注)$/i;

const NON_CHARACTER_SUFFIX_RE =
  /(?:模拟器|模组|剧本|世界|空间|指南|物语|风云|传说|纪元|编年史|计划|系统|合集|大全|市|省|县|镇|村|城|国|帝国|王国|公国|共和国|联邦|王朝|朝廷|政府|议会|法院|学院|大学|学校|医院|公司|集团|企业|协会|公会|商会|教团|教会|宗门|门派|帮派|部队|军团|警局|部门|厅|馆|店|铺|楼|阁|殿|宫|院|室|房|屋|街|巷|路|桥|港|站|山|岭|峰|谷|林|森|河|江|湖|海|岛|洞|窟|塔|堡|营|地|区|域|界|境|栏|表|单|录|志|图|谱|书|册|卷|章|节|幕)$/i;

const CARD_TITLE_OR_METAPHOR_RE =
  /(?:模拟器|模组|剧本|世界观|主神空间|指南|rpg|trpg|simulator|scenario|chronicle|game\s*master|gm|narrator|仿佛|宛如|犹如|就像|如同|般的|一般|一样|之影|之刃|之手|齿轮|阴影|风暴|深渊|命运|宿命)/i;

/** Descriptive Chinese noun-phrases / metaphors like "黑夜中的幽灵" or "沉睡的巨兽" are not character names. */
const DESCRIPTIVE_PHRASE_RE = /(?:[一-鿿]{2,}的[一-鿿]{1,}|[一-鿿]{2,}之[一-鿿]{2,})/;

export interface EntityHygieneContext {
  knownCharacterNames?: Iterable<string>;
  personaName?: string;
}

function buildKnownSet(known?: Iterable<string>): Set<string> {
  const set = new Set<string>();
  if (!known) return set;
  for (const name of known) {
    const clean = name.trim().toLowerCase();
    if (clean) set.add(clean);
  }
  return set;
}

/**
 * Returns true if `raw` is clearly a system namespace, container word, placeholder,
 * or non-character place/organization/object (unless explicitly whitelisted as a known character).
 */
export function isNonCharacterEntity(raw: string, ctx?: EntityHygieneContext): boolean {
  const clean = raw.trim();
  if (!clean) return true;
  if (clean.length > 28) return true;
  if (/^[\d\s\-_.,:;!?/\\@#$%^&*()+=\[\]{}<>|~`]+$/.test(clean)) return true;

  const lower = clean.toLowerCase();
  const known = buildKnownSet(ctx?.knownCharacterNames);
  if (known.has(lower)) return false;

  if (NON_CHARACTER_EXACT_RE.test(clean)) return true;
  if (CARD_TITLE_OR_METAPHOR_RE.test(clean)) return true;
  if (DESCRIPTIVE_PHRASE_RE.test(clean)) return true;

  // Multi-word sentence fragments (e.g. "所有人都在场", "a guard standing nearby") are not character names
  if (/[，。！？；：,.!?;:]/.test(clean)) return true;
  if (clean.split(/\s+/).length > 4) return true;

  // Filter obvious place/org/UI suffixes for CJK names of length >= 2 when not whitelisted
  if (clean.length >= 2 && NON_CHARACTER_SUFFIX_RE.test(clean)) {
    // Allow common 2-char Chinese surnames/names ending in e.g. 山/海/林/江/河/峰/宇 only if length === 2
    const allowed2CharNameSuffix = /[山海林江河峰林宇城]$/;
    if (!(clean.length === 2 && allowed2CharNameSuffix.test(clean))) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalize an actor identifier:
 *  - Maps player aliases & current persona name to `"player"`
 *  - Returns `null` if the name is empty or a non-character entity
 */
export function canonicalizeActorName(raw: string, ctx?: EntityHygieneContext): string | null {
  const clean = raw.trim().replace(/^["'`【\[]+|["'`】\]]+$/g, "").trim();
  if (!clean) return null;

  if (PLAYER_ALIAS_RE.test(clean)) {
    return "player";
  }
  if (ctx?.personaName && clean.toLowerCase() === ctx.personaName.trim().toLowerCase()) {
    return "player";
  }
  if (isNonCharacterEntity(clean, ctx)) {
    return null;
  }
  return clean;
}

/** Filter and deduplicate an NPC list (used for `presentNpcs`), removing non-characters and `"player"`. */
export function sanitizeNpcList(rawList: string[], ctx?: EntityHygieneContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of rawList) {
    const canon = canonicalizeActorName(item, ctx);
    if (!canon || canon === "player") continue;
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canon);
  }
  return out;
}

/** Build a canonical symmetric pair-bond key (`A::B` == `B::A`) and reject invalid/self pairs. */
export function canonicalizePairBondActors(
  rawA: string,
  rawB: string,
  ctx?: EntityHygieneContext,
): { id: string; actorA: string; actorB: string } | null {
  const a = canonicalizeActorName(rawA, ctx);
  const b = canonicalizeActorName(rawB, ctx);
  if (!a || !b) return null;
  if (a.toLowerCase() === b.toLowerCase()) return null;
  const [first, second] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return {
    id: `${first.toLowerCase()}::${second.toLowerCase()}`,
    actorA: first,
    actorB: second,
  };
}
