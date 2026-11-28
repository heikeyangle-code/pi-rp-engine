/**
 * Refined Interactive `/rp panel` World Inspector & Live State Editor.
 *
 * Features:
 *  - World Overview (Card, Archetype, Modules, Cast, Stage/Time, Location, Persona, Pacing, Memory counts)
 *  - Live State Editor (Stats with gauges, Click-to-edit Inventory, Location & NPCs, Stage & World Time,
 *    CFSM Attitude/State Axes, World Flags, Module Toggles — all persisted via `rp:tx`)
 *  - Lorebook Live Manager (Search, filter by status/gate, paginated browsing across 300+ entries, live toggle)
 *  - Bi-Temporal Facts (public & witness-restricted secrets) & DREAM ABC Beliefs inspector / manual add & invalidation
 *  - Progress Clocks (with `▓▓▓▓░░` bars) & Open Foresights manager
 *  - Director Notes & Pacing control
 *  - Import Audit Report & Creator Notes viewer (0 LLM tokens!)
 *  - Shortcuts Quick Reference
 */

import type { CompiledCard, CompiledLoreEntry, PacingMode, PiExtensionContext, RpTxEntry, SessionRpState } from "../types.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import { evaluateGate } from "../engine/gates.js";
import { renderProgressBar } from "./renderers.js";
import { RP_SHORTCUT_LIST } from "./shortcuts.js";

export interface DashboardRuntime {
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  commitTx(tx: RpTxEntry): void;
  refreshHud(ctx: PiExtensionContext): void;
  exitRp(ctx: PiExtensionContext, askConfirm?: boolean): Promise<void>;
}

function getAllLore(rt: DashboardRuntime): CompiledLoreEntry[] {
  const card = rt.getCard();
  if (!card) return [];
  return [...card.loreBook.entries, ...rt.getExtraCastCards().flatMap((c) => c.loreBook.entries)];
}

async function openOverviewSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  const s = rt.getState();
  const card = rt.getCard();
  const activeFacts = getActiveFacts(s).length;
  const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open").length;
  const cfsmCount = Object.values(s.cfsmStates).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
  const allLore = getAllLore(rt);
  const enabledMods = Object.entries(s.modules)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(", ") || "仅基础叙事";

  const usage = ctx.getContextUsage?.();
  const usageText =
    usage && typeof usage.tokens === "number" && usage.contextWindow > 0
      ? `${(usage.tokens / 1000).toFixed(1)}k / ${Math.round(usage.contextWindow / 1000)}k (${Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100)}%)`
      : null;

  const lines = [
    `◆ 主角色      ${card ? `${card.identity.name} (${card.specOrigin.toUpperCase()})` : s.cardSlug ?? "未知"}`,
    `◆ 卡型与模块  ${s.archetype}  │  启用：${enabledMods}`,
    `◆ 同场共演    ${s.activeCharacters.join(" · ") || "单卡"}`,
    `◆ 玩家人设    ${s.currentPersona.name}${s.currentPersona.description ? ` — ${s.currentPersona.description.slice(0, 46)}` : ""}`,
    `◆ 阶段时间    ${[s.era, s.worldTimeLabel, `Turn ${s.turn} (Beat ${s.beat})`].filter(Boolean).join(" · ")}`,
    `◆ 场景位置    ${s.location || "(未设定)"}${s.presentNpcs.length ? `  │  在场: ${s.presentNpcs.join("、")}` : ""}`,
    `◆ 运行策略    节奏:${s.pacingMode} · 结算:${s.settlementMode} · HUD:${s.hudMode} · 原味:${s.rawPassthrough ? "开" : "关"}`,
    `◆ 记忆账本    世界书 ${allLore.length} 条 · 有效事实 ${activeFacts} 条 · 信念 ${s.beliefs.length} 条 · CFSM ${cfsmCount} 轴 · 伏笔 ${openHooks} 条 · 隐藏楼层 ${s.hiddenEntryIds.size} 条`,
    `◆ 酒馆预设    ${s.presetId ?? "未使用"}`,
    ...(usageText ? [`◆ 上下文用量  ${usageText}`] : []),
  ];

  await ctx.ui.select("╭─ 世界总览 (Overview) ─────────────────────────", [...lines, "← 返回主面板"]);
}

async function openLiveStateEditor(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const statCount = Object.values(s.stats).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const cfsmCount = Object.values(s.cfsmStates).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const flagCount = Object.keys(s.flags).length;

    const choice = await ctx.ui.select("╭─ 实时状态账本编辑 ────────────────────────────", [
      `1. 数值属性 (Stats · ${statCount} 项)`,
      `2. 背包物品 (Inventory · ${invCount} 项)`,
      `3. 场景地点与在场角色 (${s.location || "未设定"})`,
      `4. 阶段与世界时间 (${[s.era, s.worldTimeLabel].filter(Boolean).join(" · ") || "未设定"})`,
      `5. 角色心态与关系轴 (CFSM · ${cfsmCount} 轴)`,
      `6. 世界开关 (Flags · ${flagCount} 项) & 引擎模块开关`,
      "← 返回主面板",
    ]);
    if (!choice || choice.startsWith("←")) return;

    if (choice.startsWith("1.")) {
      const existing: Array<{ label: string; actor: string; key: string }> = [];
      for (const [actor, rec] of Object.entries(s.stats)) {
        for (const [k, v] of Object.entries(rec)) {
          const b = s.statBounds[actor]?.[k];
          const gauge =
            typeof v === "number" && b && typeof b.max === "number" && b.max > 0
              ? `  ${renderProgressBar(v - (b.min ?? 0), b.max - (b.min ?? 0), 6)} ${v}/${b.max}`
              : ` = ${String(v)}`;
          existing.push({ label: `${actor}.${k}${gauge}`, actor, key: k });
        }
      }
      const opts = ["+ 新增 / 修改数值", ...existing.map((e) => e.label), "← 返回"];
      const pick = await ctx.ui.select("选择要修改的数值或新增", opts);
      if (!pick || pick.startsWith("←")) continue;

      let actor = "player";
      let key = "";
      if (pick.startsWith("+")) {
        const aIn = await ctx.ui.input("角色/实体 ID（如 player 或角色名）", "player");
        if (!aIn?.trim()) continue;
        actor = aIn.trim();
        const kIn = await ctx.ui.input("属性名称（如 HP、好感度、金币）", "好感度");
        if (!kIn?.trim()) continue;
        key = kIn.trim();
      } else {
        const match = existing[opts.indexOf(pick) - 1];
        if (!match) continue;
        actor = match.actor;
        key = match.key;
      }

      const valStr = await ctx.ui.input(
        `设置 ${actor}.${key} 的值（支持 +5 / -3 增减，或直接输入新值）`,
        String(s.stats[actor]?.[key] ?? 50),
      );
      if (valStr === undefined || !valStr.trim()) continue;
      const trimmed = valStr.trim();
      if (/^[+-]\d+(\.\d+)?$/.test(trimmed)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "add", value: Number(trimmed), reason: "panel" });
      } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: Number(trimmed), reason: "panel" });
      } else if (trimmed === "true" || trimmed === "false") {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: trimmed === "true", reason: "panel" });
      } else {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: trimmed, reason: "panel" });
      }
      rt.refreshHud(ctx);
      ctx.ui.notify(`已更新 ${actor}.${key} = ${String(rt.getState().stats[actor]?.[key])}`, "info");
    } else if (choice.startsWith("2.")) {
      const existing: Array<{ label: string; actor: string; item: string; qty: number }> = [];
      for (const [actor, rec] of Object.entries(s.inventory)) {
        for (const [item, qty] of Object.entries(rec)) {
          existing.push({ label: `${actor}  │  ${item} ×${qty}`, actor, item, qty });
        }
      }
      const opts = ["+ 新增物品", ...existing.map((e) => e.label), "← 返回"];
      const pick = await ctx.ui.select("背包管理（点击已有物品可快捷增减）", opts);
      if (!pick || pick.startsWith("←")) continue;

      if (pick.startsWith("+")) {
        const actor = (await ctx.ui.input("持有者（如 player）", "player"))?.trim();
        if (!actor) continue;
        const item = (await ctx.ui.input("物品名称", "银钥匙"))?.trim();
        if (!item) continue;
        const deltaStr = (await ctx.ui.input("数量变动（正数添加，负数扣除）", "1"))?.trim();
        const delta = Number(deltaStr);
        if (!Number.isFinite(delta) || delta === 0) continue;
        rt.commitTx({ kind: "inventory_patch", actorId: actor, item, delta, note: "panel" });
        rt.refreshHud(ctx);
        ctx.ui.notify(`背包已更新：${actor} ${item} (${delta > 0 ? `+${delta}` : delta})`, "info");
      } else {
        const match = existing[opts.indexOf(pick) - 1];
        if (!match) continue;
        const op = await ctx.ui.select(`${match.actor} · ${match.item}（当前 ×${match.qty}）`, [
          "+1 增加 1 个",
          "-1 消耗 1 个",
          "✏️ 自定义数量变动",
          "🗑 清空该物品",
          "← 返回",
        ]);
        if (!op || op.startsWith("←")) continue;
        let delta = 0;
        if (op.startsWith("+1")) delta = 1;
        else if (op.startsWith("-1")) delta = -1;
        else if (op.startsWith("🗑")) delta = -match.qty;
        else {
          const d = Number((await ctx.ui.input("输入数量变动（正数添加，负数扣除）", "1"))?.trim());
          if (Number.isFinite(d)) delta = d;
        }
        if (delta !== 0) {
          rt.commitTx({ kind: "inventory_patch", actorId: match.actor, item: match.item, delta, note: "panel" });
          rt.refreshHud(ctx);
          ctx.ui.notify(`背包已更新：${match.item} (${delta > 0 ? `+${delta}` : delta})`, "info");
        }
      }
    } else if (choice.startsWith("3.")) {
      const loc = await ctx.ui.input("当前地点", s.location || "酒馆大厅");
      if (loc === undefined) continue;
      const npcsStr = await ctx.ui.input("在场角色（逗号分隔，留空表示无人）", s.presentNpcs.join(", "));
      const npcs = (npcsStr ?? "")
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      rt.commitTx({ kind: "location_set", location: loc.trim(), presentNpcs: npcs });
      rt.refreshHud(ctx);
      ctx.ui.notify(`场景已更新：${loc.trim() || "(空)"}`, "info");
    } else if (choice.startsWith("4.")) {
      const nextStage = await ctx.ui.input("当前阶段 / 章节（留空则隐藏不显示）", s.era);
      if (nextStage !== undefined) {
        const trimmedStage = nextStage.trim();
        if (trimmedStage !== s.era) {
          rt.commitTx({
            kind: "era_advance",
            fromEra: s.era,
            toEra: trimmedStage,
            milestoneUnlocked: [],
            montageSummary: "panel_edit",
            turn: s.turn,
          });
        }
      }
      const nextTime = await ctx.ui.input("当前世界时间标签（如：光绪二十四年冬 / 周五傍晚，留空则隐藏）", s.worldTimeLabel);
      if (nextTime !== undefined) {
        rt.commitTx({ kind: "clock_tick", beatDelta: 0, worldTimeLabel: nextTime.trim() });
      }
      rt.refreshHud(ctx);
      ctx.ui.notify("阶段与世界时间已更新。", "info");
    } else if (choice.startsWith("5.")) {
      const axes: Array<{ label: string; actor: string; axis: string; current: string }> = [];
      for (const [actor, rec] of Object.entries(s.cfsmStates)) {
        for (const [axis, st] of Object.entries(rec)) {
          const def = s.cfsmDefs[actor]?.[axis];
          const statesHint = def ? `  (${def.states.join("→")})` : "";
          axes.push({ label: `${actor}.${axis} = ${st.state}${statesHint}`, actor, axis, current: st.state });
        }
      }
      const opts = ["+ 新增心态/关系状态轴", ...axes.map((a) => a.label), "← 返回"];
      const pick = await ctx.ui.select("角色心态与关系轴 (CFSM)", opts);
      if (!pick || pick.startsWith("←")) continue;

      if (pick.startsWith("+")) {
        const defaultActor = rt.getCard()?.identity.name ?? "char";
        const actor = (await ctx.ui.input("角色名称", defaultActor))?.trim();
        if (!actor) continue;
        const axis = (await ctx.ui.input("状态轴名称（如：信任、警觉、好感阶段）", "信任"))?.trim();
        if (!axis) continue;
        const statesStr = (await ctx.ui.input("可选状态列表（逗号分隔）", "戒备, 试探, 信任, 托付"))?.trim();
        const statesList = (statesStr ?? "")
          .split(/[,，→]/)
          .map((x) => x.trim())
          .filter(Boolean);
        if (statesList.length < 2) continue;
        rt.commitTx({
          kind: "cfsm_define",
          actorId: actor,
          def: { axis, states: statesList, initial: statesList[0]! },
        });
        rt.refreshHud(ctx);
        ctx.ui.notify(`已创建状态轴：${actor}.${axis}（初态：${statesList[0]}）`, "info");
      } else {
        const match = axes[opts.indexOf(pick) - 1];
        if (!match) continue;
        const def = s.cfsmDefs[match.actor]?.[match.axis];
        let nextVal: string | undefined;
        if (def && def.states.length > 0) {
          const chosen = await ctx.ui.select(
            `切换 ${match.actor}.${match.axis}（当前：${match.current}）`,
            [...def.states, "✏️ 输入自定义状态", "← 返回"],
          );
          if (!chosen || chosen.startsWith("←")) continue;
          if (chosen.startsWith("✏️")) {
            nextVal = (await ctx.ui.input("输入新状态", match.current))?.trim();
          } else {
            nextVal = chosen;
          }
        } else {
          nextVal = (await ctx.ui.input(`设置 ${match.actor}.${match.axis} 新状态`, match.current))?.trim();
        }
        if (nextVal && nextVal !== match.current) {
          rt.commitTx({
            kind: "cfsm_transition",
            actorId: match.actor,
            axis: match.axis,
            from: match.current,
            to: nextVal,
            reason: "panel_manual",
            turn: s.turn,
          });
          rt.refreshHud(ctx);
          ctx.ui.notify(`已切换 ${match.actor}.${match.axis}：${match.current} → ${nextVal}`, "info");
        }
      }
    } else if (choice.startsWith("6.")) {
      const modLabels = [
        `⚙ 模块[数值 stats]：${s.modules.stats ? "● 开" : "○ 关"}`,
        `⚙ 模块[背包 inventory]：${s.modules.inventory ? "● 开" : "○ 关"}`,
        `⚙ 模块[时钟 clocks]：${s.modules.clocks ? "● 开" : "○ 关"}`,
        `⚙ 模块[阶段 stages]：${s.modules.stages ? "● 开" : "○ 关"}`,
      ];
      const flagItems = Object.entries(s.flags).map(([k, v]) => `${v ? "● 开" : "○ 关"}  ${k}`);
      const pick = await ctx.ui.select("世界开关 Flags 与引擎模块开关", [
        "+ 新增 Flag",
        ...modLabels,
        ...flagItems,
        "← 返回",
      ]);
      if (!pick || pick.startsWith("←")) continue;
      if (pick.startsWith("+")) {
        const name = (await ctx.ui.input("Flag 名称（如 met_duke）", ""))?.trim();
        if (!name) continue;
        rt.commitTx({ kind: "flag_set", flag: name, value: true });
        ctx.ui.notify(`已启用 Flag：${name}`, "info");
      } else if (pick.startsWith("⚙ 模块[")) {
        const m = /模块\[[^\s]+\s+(stats|inventory|clocks|stages)\]/.exec(pick);
        const modKey = m?.[1] as keyof SessionRpState["modules"] | undefined;
        if (modKey) {
          const nextMods = { ...s.modules, [modKey]: !s.modules[modKey] };
          rt.commitTx({ kind: "profile_apply", archetype: s.archetype, modules: nextMods });
          rt.refreshHud(ctx);
          ctx.ui.notify(`模块 ${modKey} 已${nextMods[modKey] ? "开启" : "关闭"}`, "info");
        }
      } else {
        const name = pick.replace(/^[●○]\s+[开关]\s+/, "");
        const nextVal = !Boolean(s.flags[name]);
        rt.commitTx({ kind: "flag_set", flag: name, value: nextVal });
        ctx.ui.notify(`Flag ${name} → ${nextVal ? "开启" : "关闭"}`, "info");
      }
    }
  }
}

async function openLoreManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  const allLore = getAllLore(rt);
  if (allLore.length === 0) {
    ctx.ui.notify("当前角色卡没有世界书条目。", "info");
    return;
  }

  let searchQuery = "";
  type LoreFilterMode = "all" | "enabled" | "constant" | "gated";
  let filterMode: LoreFilterMode = "all";
  let page = 0;
  const pageSize = 18;

  while (true) {
    const s = rt.getState();
    const filtered = allLore.filter((e) => {
      const enabled = s.loreOverrides[e.id] ?? e.enabled;
      const gated = !evaluateGate(e.gate, s);
      if (filterMode === "enabled" && !enabled) return false;
      if (filterMode === "constant" && !e.constant) return false;
      if (filterMode === "gated" && !gated) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const hay = `${e.title} ${e.keys.join(" ")} ${e.content.slice(0, 120)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (page >= totalPages) page = totalPages - 1;
    const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);

    const filterLabel: Record<LoreFilterMode, string> = {
      all: "全部",
      enabled: "仅启用",
      constant: "仅常驻",
      gated: "仅门禁锁定",
    };

    const navTop = [
      `🔍 搜索世界书${searchQuery ? `（当前：“${searchQuery}”，点击修改或清空）` : ""}`,
      `🗂 筛选：${filterLabel[filterMode]}（点击切换）`,
    ];

    const itemOptions = slice.map((e, idx) => {
      const enabled = s.loreOverrides[e.id] ?? e.enabled;
      const sticky = s.loreSticky[e.id] ? ` [粘滞:${s.loreSticky[e.id]}]` : "";
      const cd = s.loreCooldown[e.id] ? ` [冷却:${s.loreCooldown[e.id]}]` : "";
      const gated = !evaluateGate(e.gate, s) ? " [门禁锁]" : "";
      const tag = e.constant ? "常驻" : "动态";
      return `${page * pageSize + idx + 1}. ${enabled ? "●" : "○"} [${tag}] ${e.title}${sticky}${cd}${gated}`;
    });

    const navBottom: string[] = [];
    if (page > 0) navBottom.push(`◀ 上一页 (${page}/${totalPages})`);
    if (page + 1 < totalPages) navBottom.push(`▶ 下一页 (${page + 2}/${totalPages})`);
    navBottom.push("← 返回主面板");

    const pick = await ctx.ui.select(
      `╭─ 世界书管理（匹配 ${filtered.length}/${allLore.length} 条 · 第 ${page + 1}/${totalPages} 页）`,
      [...navTop, ...itemOptions, ...navBottom],
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🔍")) {
      const q = await ctx.ui.input("输入关键词过滤标题/触发词/正文（留空清除筛选）", searchQuery);
      if (q !== undefined) {
        searchQuery = q.trim();
        page = 0;
      }
      continue;
    }
    if (pick.startsWith("🗂")) {
      const order: LoreFilterMode[] = ["all", "enabled", "constant", "gated"];
      filterMode = order[(order.indexOf(filterMode) + 1) % order.length]!;
      page = 0;
      continue;
    }
    if (pick.startsWith("◀")) {
      page = Math.max(0, page - 1);
      continue;
    }
    if (pick.startsWith("▶")) {
      page = Math.min(totalPages - 1, page + 1);
      continue;
    }

    const numMatch = /^(\d+)\./.exec(pick);
    const entry = numMatch ? filtered[Number(numMatch[1]) - 1] : undefined;
    if (!entry) continue;

    const currentEnabled = s.loreOverrides[entry.id] ?? entry.enabled;
    const action = await ctx.ui.select(
      `条目：${entry.title}（${currentEnabled ? "启用中" : "已禁用"} · 关键词：${entry.keys.join(", ") || "无"}）`,
      [
        currentEnabled ? "○ 暂时禁用此条目（仅本会话）" : "● 重新启用此条目（仅本会话）",
        `预览：${entry.content.replace(/\s+/g, " ").slice(0, 74)}…`,
        "← 返回列表",
      ],
    );
    if (action?.startsWith("○") || action?.startsWith("●")) {
      rt.commitTx({ kind: "lore_toggle", entryId: entry.id, enabled: !currentEnabled });
      ctx.ui.notify(`世界书「${entry.title}」已${!currentEnabled ? "启用" : "禁用"}`, "info");
    }
  }
}

async function openFactsAndBeliefs(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const activeFacts = getActiveFacts(s);
    const shownFacts = activeFacts.slice(-20).reverse();
    const options: string[] = [
      "+ 手动记录一条新事实（支持公开 / 私密认知隔离）",
      "+ 手动记录一条人物信念 (DREAM ABC)",
      ...shownFacts.map((f) => {
        const vis = f.witnessIds === "public" ? "" : ` [仅:${f.witnessIds.join(",")}]`;
        return `▪ [T${f.validFromTurn}]${vis} ${f.statement.slice(0, 56)} (${f.id})`;
      }),
      ...s.beliefs.slice(-6).reverse().map((b) => `◇ ${b.actorId} → ${b.target}: ${b.belief.slice(0, 50)}`),
      "← 返回主面板",
    ];
    const pick = await ctx.ui.select(
      `╭─ 双时态事实 (${activeFacts.length}) 与人物信念 (${s.beliefs.length})`,
      options,
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+ 手动记录一条新事实")) {
      const statement = (await ctx.ui.input("输入要记录的世界事实", ""))?.trim();
      if (!statement) continue;
      const entitiesStr = (await ctx.ui.input("关联实体（逗号分隔，可选）", "")) ?? "";
      const entities = entitiesStr
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      const visPick = await ctx.ui.select("可见范围（认知隔离）", [
        "🌐 公开事实（在场或常识均可见）",
        "🔒 私密事实（仅指定知情角色可见，其余角色物理盲区）",
      ]);
      let witnessIds: string[] | "public" = "public";
      if (visPick?.startsWith("🔒")) {
        const wStr = (await ctx.ui.input("知情角色名（逗号分隔，如：玩家, 林晚）", s.currentPersona.name)) ?? "";
        const parsed = wStr
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean);
        witnessIds = parsed.length > 0 ? parsed : [s.currentPersona.name];
      }
      rt.commitTx({
        kind: "fact_add",
        fact: {
          id: `fact_manual_${Date.now().toString(36)}`,
          statement,
          entities,
          validFromTurn: s.turn,
          validUntilTurn: null,
          witnessIds,
        },
      });
      ctx.ui.notify(witnessIds === "public" ? "已写入公开事实。" : `已写入私密事实（仅 ${witnessIds.join("、")} 知情）。`, "info");
    } else if (pick.startsWith("+ 手动记录一条人物信念")) {
      const actorId = (await ctx.ui.input("信念主体角色", rt.getCard()?.identity.name ?? "char"))?.trim();
      if (!actorId) continue;
      const target = (await ctx.ui.input("针对对象（如玩家名或某 NPC）", s.currentPersona.name))?.trim();
      if (!target) continue;
      const activatingEvent = (await ctx.ui.input("触发事件 (Activating Event)", ""))?.trim();
      if (!activatingEvent) continue;
      const belief = (await ctx.ui.input("形成/修正的新信念 (Belief)", ""))?.trim();
      if (!belief) continue;
      rt.commitTx({
        kind: "belief_update",
        actorId,
        target,
        activatingEvent,
        belief,
        turn: s.turn,
      });
      ctx.ui.notify(`已记录人物信念：${actorId} → ${target}`, "info");
    } else if (pick.startsWith("▪")) {
      const idMatch = /\(([^)]+)\)$/.exec(pick);
      const factId = idMatch?.[1];
      if (!factId) continue;
      const ok = await ctx.ui.confirm("标记事实失效", `确定将事实 ${factId} 标记为已过时（失效于 Turn ${s.turn}）？`);
      if (ok) {
        rt.commitTx({
          kind: "fact_invalidate",
          factId,
          validUntilTurn: s.turn,
          reason: "manual_panel",
        });
        ctx.ui.notify(`事实 ${factId} 已标记失效。`, "info");
      }
    }
  }
}

async function openClocksAndForesights(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const clocks = Object.values(s.clocks);
    const hooks = Array.from(s.foresights.values()).filter((h) => h.status === "open");

    const options = [
      "+ 新建进度时钟",
      "+ 埋下新伏笔 (Foresight)",
      ...clocks.map(
        (c) =>
          `⏳ [${c.clockId}] ${c.label}  ${renderProgressBar(c.value, c.max, 6)}  ${c.value}/${c.max}${c.completed ? " (已完成)" : ""}`,
      ),
      ...hooks.map((h) => `◇ [${h.id}] ${h.summary.slice(0, 56)}`),
      "← 返回主面板",
    ];

    const pick = await ctx.ui.select("╭─ 进度时钟与未回收伏笔 ────────────────────────", options);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+ 新建进度时钟")) {
      const label = (await ctx.ui.input("时钟名称（如：卫兵警觉度）", ""))?.trim();
      if (!label) continue;
      const maxStr = (await ctx.ui.input("最大格数（如 4 / 6 / 8）", "4"))?.trim();
      const max = Math.max(1, Number(maxStr) || 4);
      const clockId = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").slice(0, 24) || `clk_${Date.now()}`;
      rt.commitTx({ kind: "progress_clock", clockId, label, delta: 0, max });
      rt.refreshHud(ctx);
      ctx.ui.notify(`已创建时钟：${label} (0/${max})`, "info");
    } else if (pick.startsWith("+ 埋下新伏笔")) {
      const summary = (await ctx.ui.input("伏笔内容", ""))?.trim();
      if (!summary) continue;
      const triggerHint = (await ctx.ui.input("触发条件/线索提示（可选）", ""))?.trim() ?? "";
      rt.commitTx({
        kind: "foresight_upsert",
        hook: {
          id: `hook_${Date.now().toString(36)}`,
          summary,
          entities: [],
          plantedTurn: s.turn,
          triggerHint,
          status: "open",
        },
      });
      rt.refreshHud(ctx);
      ctx.ui.notify("已埋下新伏笔。", "info");
    } else if (pick.startsWith("⏳")) {
      const m = /\[([^\]]+)\]/.exec(pick);
      const clockId = m?.[1];
      const clk = clockId ? s.clocks[clockId] : undefined;
      if (!clk) continue;
      const op = await ctx.ui.select(
        `时钟：${clk.label}  ${renderProgressBar(clk.value, clk.max, 6)}  ${clk.value}/${clk.max}`,
        ["+1 推进一格", "-1 回退一格", "← 返回"],
      );
      if (op?.startsWith("+1")) {
        rt.commitTx({ kind: "progress_clock", clockId: clk.clockId, label: clk.label, delta: 1, max: clk.max });
        rt.refreshHud(ctx);
      } else if (op?.startsWith("-1")) {
        rt.commitTx({ kind: "progress_clock", clockId: clk.clockId, label: clk.label, delta: -1, max: clk.max });
        rt.refreshHud(ctx);
      }
    } else if (pick.startsWith("◇")) {
      const m = /\[([^\]]+)\]/.exec(pick);
      const id = m?.[1];
      const hook = id ? s.foresights.get(id) : undefined;
      if (!hook) continue;
      const ok = await ctx.ui.confirm("回收伏笔", `将伏笔「${hook.summary}」标记为已回收 (paid_off)？`);
      if (ok) {
        rt.commitTx({ kind: "foresight_upsert", hook: { ...hook, status: "paid_off" } });
        rt.refreshHud(ctx);
        ctx.ui.notify("伏笔已标记回收。", "info");
      }
    }
  }
}

async function openNotesAndPacing(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const options = [
      `🎚 切换叙事节奏（当前：${s.pacingMode} · Alt+P）`,
      "+ 新增导演指令 (Director Note)",
      ...s.notes.map(
        (n, i) => `▪ #${i + 1} ${n.text.slice(0, 56)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
      ),
      ...(s.notes.length > 0 ? ["🧹 清空全部导演指令"] : []),
      "← 返回主面板",
    ];
    const pick = await ctx.ui.select("╭─ 导演指令与叙事节奏 ──────────────────────────", options);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🎚")) {
      const p = await ctx.ui.select("选择叙事节奏", [
        "relaxed — 舒缓细腻，注重氛围与日常心理描写",
        "balanced — 均衡自然（默认）",
        "dramatic — 紧凑强冲突，积极推进时钟与悬念",
      ]);
      if (p) {
        const mode = p.split(" ")[0] as PacingMode;
        rt.commitTx({ kind: "config_patch", pacingMode: mode });
        rt.refreshHud(ctx);
        ctx.ui.notify(`叙事节奏已切换为：${mode}`, "info");
      }
    } else if (pick.startsWith("+")) {
      const text = (await ctx.ui.input("输入导演指令（注入 Zone 3，不破坏缓存）", ""))?.trim();
      if (!text) continue;
      const ttlStr = (await ctx.ui.input("生效轮数（留空=永久常驻，输入数字如 3=生效3轮）", ""))?.trim();
      const ttl = ttlStr && /^\d+$/.test(ttlStr) ? Math.max(1, Number(ttlStr)) : null;
      rt.commitTx({
        kind: "note_set",
        note: { id: `note_${Date.now().toString(36)}`, text, remainingTurns: ttl },
      });
      rt.refreshHud(ctx);
      ctx.ui.notify("导演指令已添加。", "info");
    } else if (pick.startsWith("🧹")) {
      rt.commitTx({ kind: "note_clear" });
      rt.refreshHud(ctx);
      ctx.ui.notify("已清空全部导演指令。", "info");
    } else if (pick.startsWith("▪ #")) {
      const idx = Number(/^▪ #(\d+)/.exec(pick)?.[1]) - 1;
      const note = s.notes[idx];
      if (!note) continue;
      const del = await ctx.ui.confirm("删除导演指令", `删除「${note.text}」？`);
      if (del) {
        rt.commitTx({ kind: "note_clear", noteId: note.id });
        rt.refreshHud(ctx);
      }
    }
  }
}

async function openImportAuditSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  const card = rt.getCard();
  if (!card) return;
  const r = card.importReport;
  const lines = [
    `◆ 规格来源      ${r.specOrigin.toUpperCase()}  │  原味直通: ${r.rawPassthrough ? "是" : "否"}`,
    `◆ 对话示例      ${r.mesExampleCharsAfter}/${r.mesExampleCharsBefore} 字符 (100% 无损保留)`,
    `◆ 世界书统计    共 ${r.loreCount} 条（常驻 ${r.constantLoreCount} · 动态 ${r.dynamicLoreCount}）`,
    `◆ 前端壳净化    剥离 ${r.strippedItems.length} 处酒馆壳/HTML · 规则去重 ${r.deduplicatedRules.length} 处`,
    `◆ 打捞变量      ${r.salvagedVariables.length} 项 (MVU / YAML / 宏 / 纯文本)`,
    ...r.salvagedVariables.slice(0, 6).map((v) => `   · ${v.key} = ${String(v.initialValue)} [${v.source}]`),
    ...(card.worldProfile ? [`◆ 智能画像      ${card.worldProfile.archetype} [${card.worldProfile.source}]`] : []),
    ...(card.meta.creator ? [`◆ 角色卡作者    ${card.meta.creator}${card.meta.version ? ` v${card.meta.version}` : ""}`] : []),
    ...(card.meta.creatorNotes
      ? [`◆ 作者备注      ${card.meta.creatorNotes.replace(/\s+/g, " ").slice(0, 140)}`]
      : []),
    ...(r.warnings.length ? [`◆ 编译提示      ${r.warnings.slice(0, 3).join("；")}`] : []),
  ];
  await ctx.ui.select("╭─ 角色卡导入审计与作者备注 ────────────────────", [...lines, "← 返回主面板"]);
}

export async function openRpDashboard(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。按 Alt+R 或输入 /rp 打开启动器。", "info");
    return;
  }

  while (true) {
    const s = rt.getState();
    if (!s.active) return;
    const card = rt.getCard();
    const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open").length;
    const title = `╭─ ◆ ${[card?.identity.name ?? s.cardSlug ?? "RP", s.era, s.worldTimeLabel, `T${s.turn}`].filter(Boolean).join(" · ")}`;

    const choice = await ctx.ui.select(title, [
      "1. 🌍 世界总览 (Overview)",
      "2. 📊 实时状态编辑器 (数值 / 背包 / 地点 / 阶段时间 / CFSM / 模块)",
      `3. 📚 世界书搜索与实时开关 (${getAllLore(rt).length} 条)`,
      `4. 🧠 双时态事实（含私密隔离）与人物信念 (${getActiveFacts(s).length} / ${s.beliefs.length})`,
      `5. ⏳ 进度时钟与未回收伏笔 (${Object.keys(s.clocks).length} / ${openHooks})`,
      `6. 🎬 导演指令与叙事节奏 (${s.pacingMode} · ${s.notes.length}条)`,
      "7. 📋 导入审计报告与作者备注",
      `8. ⌨️ 快捷键速查表 (${RP_SHORTCUT_LIST.length} 项)`,
      "9. 🚪 彻底退出本会话 RP 模式",
      "✕ 关闭面板",
    ]);

    if (!choice || choice.startsWith("✕")) return;
    if (choice.startsWith("1.")) await openOverviewSection(rt, ctx);
    else if (choice.startsWith("2.")) await openLiveStateEditor(rt, ctx);
    else if (choice.startsWith("3.")) await openLoreManager(rt, ctx);
    else if (choice.startsWith("4.")) await openFactsAndBeliefs(rt, ctx);
    else if (choice.startsWith("5.")) await openClocksAndForesights(rt, ctx);
    else if (choice.startsWith("6.")) await openNotesAndPacing(rt, ctx);
    else if (choice.startsWith("7.")) await openImportAuditSection(rt, ctx);
    else if (choice.startsWith("8.")) {
      await ctx.ui.select(
        "╭─ RP 快捷键速查（Pi 原生 /hotkeys 可查看全部）",
        [...RP_SHORTCUT_LIST.map((k) => `${k.key.padEnd(14)}  ${k.label} — ${k.description}`), "← 返回主面板"],
      );
    } else if (choice.startsWith("9.")) {
      await rt.exitRp(ctx, true);
      return;
    }
  }
}
