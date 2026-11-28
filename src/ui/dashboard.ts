/**
 * v3 World Control Center (`/rp panel` & `Ctrl+Shift+R`):
 *  - On Desktop TUI (`ctx.mode === "tui"`): launches the genuine 7-tab Interactive TUI Overlay
 *    (`ctx.ui.custom(..., { overlay: true })`), dispatching every edit/action seamlessly and
 *    returning right back to the same tab.
 *  - On RPC / Mobile (`pi-android`) / Narrow clients: provides the full-CRUD `ctx.ui.select`
 *    dashboard with zero feature loss.
 *
 * Full CRUD Capabilities:
 *  1. 场景、目标与 Storylets（地点、时间、Scene Objective、条件剧情卡增删改）
 *  2. 人物与关系（CFSM 含跃迁边可视化、负值安全数值编辑器 `=设值 / +/-增减`、DualMem 信念全文查看与删除、马甲/共演）
 *  3. 记忆书、事实与伏笔（Memory Books 章节全文编辑/置顶/开关/删除、事实全文编辑与知情范围修改、伏笔管理、归档旧楼层）
 *  4. 世界书完整管理（搜索/筛选/分页 + 全文查看 + 编辑标题/触发词/正文/常驻 + 手动新增 + AI 生成 + 删除）
 *  5. 导演台与快捷动作（节奏、Author's Note、内心独白开关、Quick Replies 管理）
 *  6. 上下文 X-Ray 透视 & 状态变更审计撤销
 *  7. 跑团机制、引擎高级设置与资产库（背包/时钟/掷骰/Flags/模块、Sidecar 专职模型、世界书预算、预设采样开关、资产库删卡）
 */

import type {
  CompiledCard,
  CompiledLoreEntry,
  ContextXRaySnapshot,
  MemoryBookEntry,
  PacingMode,
  PiExtensionContext,
  RpTxEntry,
  SessionRpState,
  StoryletEntry,
} from "../types.js";
import { getActiveFacts } from "../memory/bitemporal.js";
import { evaluateGate, partitionEpistemicFacts } from "../engine/gates.js";
import { evaluateActiveStorylets } from "../context/zone-builder.js";
import { compileLoreBook } from "../parser/lore-compiler.js";
import { saveUpdatedCard } from "../storage/workspace-store.js";
import { renderProgressBar, renderSmartStatBar } from "./renderers.js";
import { RP_SHORTCUT_LIST } from "./shortcuts.js";
import { openTuiOverlayDashboard, type OverlayTabIndex } from "./tui-overlay.js";

export interface DashboardRuntime {
  getState(): SessionRpState;
  getCard(): CompiledCard | null;
  getExtraCastCards(): CompiledCard[];
  getLastXRay(): ContextXRaySnapshot | null;
  commitTx(tx: RpTxEntry): void;
  reloadRuntime(ctx: PiExtensionContext): void;
  refreshHud(ctx: PiExtensionContext): void;
  exitRp(ctx: PiExtensionContext, askConfirm?: boolean): Promise<void>;
  skipScene(ctx: PiExtensionContext): Promise<void>;
  recapStory(ctx: PiExtensionContext): Promise<void>;
  summarizeOldFloors(ctx: PiExtensionContext): Promise<void>;
  generateLoreEntry(ctx: PiExtensionContext): Promise<void>;
  analyzeCard(ctx: PiExtensionContext): Promise<void>;
  switchPersona(ctx: PiExtensionContext): Promise<void>;
  manageCast(ctx: PiExtensionContext): Promise<void>;
  quickRoll(ctx: PiExtensionContext): Promise<void>;
  openXRay(ctx: PiExtensionContext): Promise<void>;
  undoLast(ctx: PiExtensionContext, autoLast?: boolean): Promise<void>;
  openQuickReplies(ctx: PiExtensionContext): Promise<void>;
  pickSidecarModel(ctx: PiExtensionContext): Promise<void>;
  manageLibrary(ctx: PiExtensionContext): Promise<void>;
}

function getAllLore(rt: DashboardRuntime): CompiledLoreEntry[] {
  const card = rt.getCard();
  if (!card) return [];
  return [...card.loreBook.entries, ...rt.getExtraCastCards().flatMap((c) => c.loreBook.entries)];
}

/** Clean native bottom-sheet header on RPC/mobile (no terminal `╭─` box-drawing noise). */
function sheetHeader(_ctx: PiExtensionContext, title: string): string {
  return title;
}

async function editLongText(ctx: PiExtensionContext, title: string, initial: string): Promise<string | undefined> {
  if (typeof ctx.ui.editor === "function") {
    return ctx.ui.editor(title, initial);
  }
  return ctx.ui.input(title, initial);
}

// ---------------------------------------------------------------------------
// 1. 当前场景、目标与动态剧情卡 (Storylets)
// ---------------------------------------------------------------------------
async function openStoryletsManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const list = Array.from(s.storylets.values());
    const activeSet = new Set(evaluateActiveStorylets(s).map((x) => x.id));
    const opts = [
      "+ 新建条件剧情卡 (Storylet)",
      ...list.map((st) => {
        const badge =
          st.status === "completed"
            ? "✅已完成"
            : activeSet.has(st.id)
              ? "🔥已触发"
              : "⏳待触发";
        const gateSummary = st.gate
          ? ` [${[
              st.gate.minTurn ? `T>=${st.gate.minTurn}` : null,
              st.gate.requiredLocations?.length ? `地点:${st.gate.requiredLocations.join("/")}` : null,
              st.gate.requiredFlags?.length ? `Flag:${st.gate.requiredFlags.join("/")}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "无门禁"}]`
          : "";
        return `${badge} ${st.title}${gateSummary}`;
      }),
      "← 返回",
    ];
    const pick = await ctx.ui.select(`🃏 动态剧情卡 Storylets（共 ${list.length} 张，条件满足时自动注入导演台）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const title = (await ctx.ui.input("剧情卡标题（如：雨夜敲门声）", ""))?.trim();
      if (!title) continue;
      const triggerPrompt = (await editLongText(ctx, "触发时注入给 AI 的剧情引导内容", ""))?.trim();
      if (!triggerPrompt) continue;
      const minTurnStr = (await ctx.ui.input("最早触发回合 minTurn（可选，留空不限）", ""))?.trim();
      const locStr = (await ctx.ui.input("限定地点（逗号分隔，可选，留空不限）", ""))?.trim();
      const flagStr = (await ctx.ui.input("需要已开启的 Flag（逗号分隔，可选，留空不限）", ""))?.trim();
      const gate: StoryletEntry["gate"] = {};
      if (minTurnStr && /^\d+$/.test(minTurnStr)) gate.minTurn = Number(minTurnStr);
      if (locStr) gate.requiredLocations = locStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (flagStr) gate.requiredFlags = flagStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      rt.commitTx({
        kind: "storylet_upsert",
        storylet: {
          id: `st_${Date.now().toString(36)}`,
          title,
          triggerPrompt,
          gate: Object.keys(gate).length > 0 ? gate : undefined,
          status: "armed",
          createdTurn: s.turn,
        },
      });
      ctx.ui.notify(`已添加剧情卡「${title}」`, "info");
      continue;
    }

    const chosen = list[opts.indexOf(pick) - 1];
    if (!chosen) continue;
    const act = await ctx.ui.select(`🃏 ${chosen.title}（${chosen.status}）`, [
      "✏️ 编辑引导正文",
      chosen.status === "triggered" ? "⏳ 恢复为条件待触发 (armed)" : "🔥 立即手动触发 (triggered)",
      chosen.status === "completed" ? "↺ 重新启用 (armed)" : "✅ 标记为已完成 (completed)",
      "🗑 删除此剧情卡",
      "← 返回",
    ]);
    if (!act || act.startsWith("←")) continue;
    if (act.startsWith("✏️")) {
      const edited = (await editLongText(ctx, `编辑剧情卡「${chosen.title}」`, chosen.triggerPrompt))?.trim();
      if (edited) {
        rt.commitTx({ kind: "storylet_upsert", storylet: { ...chosen, triggerPrompt: edited } });
        ctx.ui.notify("已更新剧情卡内容。", "info");
      }
    } else if (act.startsWith("🔥")) {
      rt.commitTx({ kind: "storylet_upsert", storylet: { ...chosen, status: "triggered" } });
    } else if (act.startsWith("⏳") || act.startsWith("↺")) {
      rt.commitTx({ kind: "storylet_upsert", storylet: { ...chosen, status: "armed" } });
    } else if (act.startsWith("✅")) {
      rt.commitTx({ kind: "storylet_upsert", storylet: { ...chosen, status: "completed" } });
    } else if (act.startsWith("🗑")) {
      rt.commitTx({ kind: "storylet_delete", storyletId: chosen.id });
      ctx.ui.notify(`已删除剧情卡「${chosen.title}」`, "info");
    }
  }
}

export async function openSceneSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const activeSt = evaluateActiveStorylets(s).length;
    const clocks = Object.values(s.clocks);
    const xray = rt.getLastXRay();
    const healthRow = xray
      ? (() => {
          const repPct = Math.round((xray.repetitionScore ?? 0) * 100);
          const stag = xray.stagnantTurns ?? 0;
          if (repPct >= 42) return `⚠ 叙事预警：复读倾向 ${repPct}%（已自动注入去重引导）`;
          if (stag >= 4) return `⚠ 叙事预警：连续 ${stag} 轮无进展（建议触发剧情卡）`;
          return `🟢 叙事健康：复读率 ${repPct}% · 距上次推进 ${stag} 轮`;
        })()
      : null;

    const pick = await ctx.ui.select(sheetHeader(ctx, "📍 当前场景、目标与剧情卡"), [
      `📍 修改地点与在场人物（当前：${s.location || "未设定"}${s.presentNpcs.length ? ` · ${s.presentNpcs.join("、")}` : ""}）`,
      `🕒 修改时间标签（当前：${s.worldTimeLabel || "未设定"}）`,
      `🎯 设定当前场景目标（当前：${s.sceneObjective || "未设定"}）`,
      `🃏 管理动态剧情卡 Storylets（共 ${s.storylets.size} 张 · 已触发 ${activeSt} 张）`,
      ...(s.modules.clocks || clocks.length > 0
        ? [
            `⏱ 进度时钟（${clocks.length > 0 ? clocks.slice(0, 2).map((c) => `${c.label} ${c.value}/${c.max}`).join(" · ") : "暂无，点此新建"}）`,
          ]
        : []),
      ...(healthRow ? [healthRow] : []),
      "⏳ 切场景 / 跳时间（触发过渡剧情 · Alt+T）",
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("📍")) {
      const loc = await ctx.ui.input("当前地点", s.location || "");
      if (loc === undefined) continue;
      const npcsStr = await ctx.ui.input("在场人物（逗号分隔，留空表示无人）", s.presentNpcs.join(", "));
      const npcs = (npcsStr ?? "")
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      rt.commitTx({ kind: "location_set", location: loc.trim(), presentNpcs: npcs });
      rt.refreshHud(ctx);
      ctx.ui.notify(`场景已更新：${loc.trim() || "(未设定)"}`, "info");
    } else if (pick.startsWith("🕒")) {
      const nextTime = await ctx.ui.input("世界时间标签（如：周五傍晚、雨夜、次日清晨；留空隐藏）", s.worldTimeLabel);
      if (nextTime !== undefined) {
        rt.commitTx({ kind: "clock_tick", beatDelta: 0, worldTimeLabel: nextTime.trim() });
        rt.refreshHud(ctx);
        ctx.ui.notify(`时间已更新：${nextTime.trim() || "(已隐藏)"}`, "info");
      }
    } else if (pick.startsWith("🎯")) {
      const obj = await ctx.ui.input("当前场景目标（如：说服店长交出密室钥匙；留空清除）", s.sceneObjective);
      if (obj !== undefined) {
        rt.commitTx({ kind: "scene_objective_set", objective: obj.trim() });
        rt.refreshHud(ctx);
        ctx.ui.notify(obj.trim() ? `场景目标已设为：${obj.trim()}` : "已清空场景目标。", "info");
      }
    } else if (pick.startsWith("🃏")) {
      await openStoryletsManager(rt, ctx);
    } else if (pick.startsWith("⏱")) {
      await openRpgToolsSection(rt, ctx);
    } else if (pick.startsWith("⚠") || pick.startsWith("🟢")) {
      await rt.openXRay(ctx);
    } else if (pick.startsWith("⏳")) {
      await rt.skipScene(ctx);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 人物与关系（CFSM 跃迁边 / 负值安全数值 / DualMem 信念 / 马甲与共演）
// ---------------------------------------------------------------------------
export async function openInventoryManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const existing: Array<{ label: string; actor: string; item: string; qty: number }> = [];
    for (const [actor, rec] of Object.entries(s.inventory)) {
      for (const [item, qty] of Object.entries(rec)) {
        existing.push({ label: `${actor}  │  ${item} ×${qty}`, actor, item, qty });
      }
    }
    const opts = ["+ 新增物品", ...existing.map((e) => e.label), "← 返回"];
    const sub = await ctx.ui.select(`🎒 随身物品与装备管理（共 ${existing.length} 项）`, opts);
    if (!sub || sub.startsWith("←")) return;

    if (sub.startsWith("+")) {
      const actor = (await ctx.ui.input("持有者（如 player 或角色名）", "player"))?.trim();
      if (!actor) continue;
      const item = (await ctx.ui.input("物品名称", ""))?.trim();
      if (!item) continue;
      const delta = Number((await ctx.ui.input("数量变动（正数添加，负数扣除）", "1"))?.trim());
      if (!Number.isFinite(delta) || delta === 0) continue;
      rt.commitTx({ kind: "inventory_patch", actorId: actor, item, delta, note: "panel" });
      rt.refreshHud(ctx);
      ctx.ui.notify(`物品已更新：${actor} · ${item} (${delta > 0 ? `+${delta}` : delta})`, "info");
    } else {
      const match = existing[opts.indexOf(sub) - 1];
      if (!match) continue;
      const op = await ctx.ui.select(`${match.actor} · ${match.item}（当前 ×${match.qty}）`, [
        "+1 增加 1 个",
        "-1 消耗 1 个",
        "✏️ 自定义变动",
        "🗑 清空该物品",
        "← 返回",
      ]);
      if (!op || op.startsWith("←")) continue;
      let delta = 0;
      if (op.startsWith("+1")) delta = 1;
      else if (op.startsWith("-1")) delta = -1;
      else if (op.startsWith("🗑")) delta = -match.qty;
      else {
        const d = Number((await ctx.ui.input("数量变动", "1"))?.trim());
        if (Number.isFinite(d)) delta = d;
      }
      if (delta !== 0) {
        rt.commitTx({ kind: "inventory_patch", actorId: match.actor, item: match.item, delta, note: "panel" });
        rt.refreshHud(ctx);
      }
    }
  }
}

export async function openSecretsInspector(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const active = getActiveFacts(s);
    const secrets = active.filter((f) => f.witnessIds !== "public");
    const { blindSpots } = partitionEpistemicFacts(active, s.presentNpcs);
    const blindById = new Map(blindSpots.map((b) => [b.fact.id, b.ignorantNpcs]));

    const opts = [
      "+ 新增一条隐藏秘密（指定仅谁知情）",
      ...secrets.map((f) => {
        const witnesses = Array.isArray(f.witnessIds) ? f.witnessIds.join("、") : "公开";
        const blind = blindById.get(f.id);
        const blindTag = blind?.length ? `  [盲区:${blind.join("、")}]` : "";
        return `🔒 [仅:${witnesses}]${blindTag} ${f.statement.slice(0, 42)} (${f.id})`;
      }),
      "← 返回",
    ];
    const pick = await ctx.ui.select(
      `🔒 FANToM 秘密与认知盲区（秘密 ${secrets.length} 条 · 当前场内生效盲区 ${blindSpots.length} 处）`,
      opts,
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const statement = (await editLongText(ctx, "输入秘密内容（仅指定角色知情，其他角色不可穿帮）", ""))?.trim();
      if (!statement) continue;
      const wStr = (await ctx.ui.input("谁知道这个秘密？（逗号分隔）", rt.getCard()?.identity.name ?? s.currentPersona.name)) ?? "";
      const witnesses = wStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      rt.commitTx({
        kind: "fact_add",
        fact: {
          id: `fact_manual_${Date.now().toString(36)}`,
          statement,
          entities: witnesses,
          validFromTurn: s.turn,
          validUntilTurn: null,
          witnessIds: witnesses.length > 0 ? witnesses : [s.currentPersona.name],
        },
      });
      ctx.ui.notify("已添加隐藏秘密并启用认知隔离。", "info");
      continue;
    }

    const idMatch = /\(([^)]+)\)$/.exec(pick);
    const fact = idMatch?.[1] ? s.facts.get(idMatch[1]) : undefined;
    if (!fact) continue;
    const act = await ctx.ui.select(`🔒 秘密 [${fact.id}]`, [
      "📖 查看 / 编辑秘密全文",
      "🌐 公开此秘密（让在场所有角色知情）",
      "👁 修改知情角色名单",
      "🗑 标记为已过时（失效）",
      "← 返回",
    ]);
    if (!act || act.startsWith("←")) continue;
    if (act.startsWith("📖")) {
      const next = (await editLongText(ctx, `编辑秘密 ${fact.id}`, fact.statement))?.trim();
      if (next && next !== fact.statement) rt.commitTx({ kind: "fact_update", factId: fact.id, statement: next });
    } else if (act.startsWith("🌐")) {
      rt.commitTx({ kind: "fact_update", factId: fact.id, witnessIds: "public" });
      ctx.ui.notify("该秘密已公开！", "info");
    } else if (act.startsWith("👁")) {
      const cur = Array.isArray(fact.witnessIds) ? fact.witnessIds.join(", ") : "";
      const w = (await ctx.ui.input("知情角色（逗号分隔）", cur)) ?? "";
      const list = w.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (list.length > 0) rt.commitTx({ kind: "fact_update", factId: fact.id, witnessIds: list });
    } else if (act.startsWith("🗑")) {
      rt.commitTx({ kind: "fact_invalidate", factId: fact.id, validUntilTurn: s.turn, reason: "manual_panel" });
    }
  }
}

export async function openCharactersSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const statCount = Object.values(s.stats).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const cfsmCount = Object.values(s.cfsmStates).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);

    const pick = await ctx.ui.select(sheetHeader(ctx, "👥 人物与变量"), [
      `💭 角色态度与情绪阶段 CFSM (${cfsmCount} 项)`,
      `📊 角色数值与变量 (${statCount} 项 · 双极刻度 / =设负值 / +/-增减)`,
      ...(s.modules.inventory || invCount > 0 ? [`🎒 随身物品与装备 (${invCount} 项)`] : []),
      `◇ DualMem 人物信念与潜台词 (${s.beliefs.length} 条 · 可查看全文与删除)`,
      `🧑 切换玩家马甲（当前：${s.currentPersona.name}）`,
      `👥 同场共演管理（当前：${s.activeCharacters.length} 张卡）`,
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("💭")) {
      const axes: Array<{ label: string; actor: string; axis: string; current: string }> = [];
      for (const [actor, rec] of Object.entries(s.cfsmStates)) {
        for (const [axis, st] of Object.entries(rec)) {
          const def = s.cfsmDefs[actor]?.[axis];
          const allowed = def?.transitions?.[st.state];
          const hint = allowed?.length ? `  [可跃迁→ ${allowed.join("/")}]` : def ? `  (${def.states.join("→")})` : "";
          axes.push({ label: `${actor} · ${axis}：${st.state}${hint}`, actor, axis, current: st.state });
        }
      }
      const opts = ["+ 新增角色态度/关系阶段", ...axes.map((a) => a.label), "← 返回"];
      const sub = await ctx.ui.select("角色态度与情绪阶段 (CFSM)", opts);
      if (!sub || sub.startsWith("←")) continue;

      if (sub.startsWith("+")) {
        const actor = (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? "角色"))?.trim();
        if (!actor) continue;
        const axis = (await ctx.ui.input("维度名称（如：信任、亲密、警觉）", "信任"))?.trim();
        if (!axis) continue;
        const statesStr = (await ctx.ui.input("阶段列表（按递进顺序，逗号分隔）", "陌生, 熟悉, 信任, 亲密"))?.trim();
        const statesList = (statesStr ?? "").split(/[,，→]/).map((x) => x.trim()).filter(Boolean);
        if (statesList.length < 2) continue;
        rt.commitTx({ kind: "cfsm_define", actorId: actor, def: { axis, states: statesList, initial: statesList[0]! } });
        rt.refreshHud(ctx);
        ctx.ui.notify(`已创建：${actor} · ${axis}（自动生成相邻跃迁保护，初态：${statesList[0]}）`, "info");
      } else {
        const match = axes[opts.indexOf(sub) - 1];
        if (!match) continue;
        const def = s.cfsmDefs[match.actor]?.[match.axis];
        let nextVal: string | undefined;
        if (def && def.states.length > 0) {
          const chosen = await ctx.ui.select(
            `切换 ${match.actor} · ${match.axis}（当前：${match.current}）`,
            [...def.states, "✏️ 自定义状态", "← 返回"],
          );
          if (!chosen || chosen.startsWith("←")) continue;
          nextVal = chosen.startsWith("✏️") ? (await ctx.ui.input("输入新状态", match.current))?.trim() : chosen;
        } else {
          nextVal = (await ctx.ui.input(`设置 ${match.actor} · ${match.axis} 新状态`, match.current))?.trim();
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
          ctx.ui.notify(`已更新：${match.actor} · ${match.axis} → ${nextVal}`, "info");
        }
      }
    } else if (pick.startsWith("🎒")) {
      await openInventoryManager(rt, ctx);
    } else if (pick.startsWith("📊")) {
      const existing: Array<{ label: string; actor: string; key: string }> = [];
      for (const [actor, rec] of Object.entries(s.stats)) {
        for (const [k, v] of Object.entries(rec)) {
          const b = s.statBounds[actor]?.[k];
          const smartBar = typeof v === "number" && b ? renderSmartStatBar(v, b.min, b.max, 6) : null;
          const gauge = smartBar ? `  ${smartBar}` : ` = ${String(v)}`;
          existing.push({ label: `${actor} · ${k}${gauge}`, actor, key: k });
        }
      }
      const opts = ["+ 新增 / 修改数值", ...existing.map((e) => e.label), "← 返回"];
      const sub = await ctx.ui.select("好感与角色数值", opts);
      if (!sub || sub.startsWith("←")) continue;

      let actor = rt.getCard()?.identity.name ?? "player";
      let key = "";
      if (sub.startsWith("+")) {
        const aIn = await ctx.ui.input("角色名称（如角色名或 player）", actor);
        if (!aIn?.trim()) continue;
        actor = aIn.trim();
        const kIn = await ctx.ui.input("属性名称（如好感度、体力、金币）", "好感度");
        if (!kIn?.trim()) continue;
        key = kIn.trim();
      } else {
        const match = existing[opts.indexOf(sub) - 1];
        if (!match) continue;
        actor = match.actor;
        key = match.key;
      }

      const valStr = await ctx.ui.input(
        `修改 ${actor} · ${key}（+5/-3 为增减；=10 或 =-20 强制设为精确值；直接输数字设值）`,
        String(s.stats[actor]?.[key] ?? 50),
      );
      if (valStr === undefined || !valStr.trim()) continue;
      const trimmed = valStr.trim();
      if (trimmed.startsWith("=")) {
        const rhs = trimmed.slice(1).trim();
        const parsed = /^-?\d+(\.\d+)?$/.test(rhs)
          ? Number(rhs)
          : rhs === "true"
            ? true
            : rhs === "false"
              ? false
              : rhs;
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: parsed, reason: "panel" });
      } else if (/^[+-]\d+(\.\d+)?$/.test(trimmed)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "add", value: Number(trimmed), reason: "panel" });
      } else if (/^\d+(\.\d+)?$/.test(trimmed)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: Number(trimmed), reason: "panel" });
      } else if (trimmed === "true" || trimmed === "false") {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: trimmed === "true", reason: "panel" });
      } else {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: trimmed, reason: "panel" });
      }
      rt.refreshHud(ctx);
      ctx.ui.notify(`已更新 ${actor} · ${key} = ${String(rt.getState().stats[actor]?.[key])}`, "info");
    } else if (pick.startsWith("◇")) {
      const recentBeliefs = s.beliefs.slice(-14).reverse();
      const opts = [
        "+ 手动记录一条人物信念 (DualMem)",
        ...recentBeliefs.map(
          (b) =>
            `◇ [T${b.turn}] ${b.actorId} → ${b.target}${b.emotionalTone ? ` [${b.emotionalTone}]` : ""}：${b.belief.slice(0, 42)}`,
        ),
        "← 返回",
      ];
      const sub = await ctx.ui.select(`人物信念与主观潜台词（共 ${s.beliefs.length} 条）`, opts);
      if (!sub || sub.startsWith("←")) continue;

      if (sub.startsWith("+")) {
        const actorId = (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? "角色"))?.trim();
        if (!actorId) continue;
        const target = (await ctx.ui.input("针对对象", s.currentPersona.name))?.trim();
        if (!target) continue;
        const activatingEvent = (await ctx.ui.input("因为发生了什么客观事件", ""))?.trim();
        if (!activatingEvent) continue;
        const belief = (await ctx.ui.input("形成了什么看法/信念", ""))?.trim();
        if (!belief) continue;
        const subjectiveInsight = (await ctx.ui.input("角色主观潜台词/内心独白（可选）", ""))?.trim() || undefined;
        const emotionalTone = (await ctx.ui.input("情绪基调（如：警惕/悸动/愧疚，可选）", ""))?.trim() || undefined;
        rt.commitTx({
          kind: "belief_update",
          actorId,
          target,
          activatingEvent,
          belief,
          subjectiveInsight,
          emotionalTone,
          turn: s.turn,
        });
        ctx.ui.notify(`已记录 DualMem 信念：${actorId} → ${target}`, "info");
      } else {
        const chosen = recentBeliefs[opts.indexOf(sub) - 1];
        if (!chosen) continue;
        const detail = [
          `角色：${chosen.actorId} → ${chosen.target}（第 ${chosen.turn} 轮）`,
          chosen.emotionalTone ? `情绪基调：${chosen.emotionalTone}` : null,
          `触发事件：${chosen.activatingEvent}`,
          `核心信念：${chosen.belief}`,
          chosen.subjectiveInsight ? `主观潜台词：${chosen.subjectiveInsight}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        const act = await ctx.ui.select(`信念详情：${chosen.actorId} → ${chosen.target}`, [
          "📖 查看完整内容",
          "🗑 删除此条信念",
          "← 返回",
        ]);
        if (act?.startsWith("📖")) {
          await editLongText(ctx, `DualMem 信念 · ${chosen.actorId}`, detail);
        } else if (act?.startsWith("🗑")) {
          const origIdx = s.beliefs.indexOf(chosen);
          rt.commitTx({ kind: "belief_remove", id: chosen.id, index: origIdx >= 0 ? origIdx : undefined });
          ctx.ui.notify("已删除该条信念。", "info");
        }
      }
    } else if (pick.startsWith("🧑")) {
      await rt.switchPersona(ctx);
    } else if (pick.startsWith("👥")) {
      await rt.manageCast(ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. 剧情记忆书 (Memory Books)、双时态事实与伏笔
// ---------------------------------------------------------------------------
async function openMemoryBookChapters(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const books = Array.from(s.memoryBooks.values()).reverse();
    const opts = [
      "+ 手动新建一章记忆书",
      "📦 自动总结并隐藏旧楼层 → 写入新章节",
      ...books.map(
        (b) =>
          `${b.pinned ? "📌" : b.enabled ? "●" : "○"} ${b.title} (T${b.turnRange[0]}-T${b.turnRange[1]}) — ${b.summary.slice(0, 38)}`,
      ),
      "← 返回",
    ];
    const pick = await ctx.ui.select(`📚 记忆书章节 Memory Books（共 ${books.length} 章，按关键词/实体动态召回）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const title = (await ctx.ui.input("章节标题", `第 ${books.length + 1} 章`))?.trim();
      if (!title) continue;
      const summary = (await editLongText(ctx, `编写章节「${title}」摘要`, ""))?.trim();
      if (!summary) continue;
      const kwStr = (await ctx.ui.input("触发关键词/人物实体（逗号分隔）", rt.getCard()?.identity.name ?? "")) ?? "";
      const keywords = kwStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const entry: MemoryBookEntry = {
        id: `book_${Date.now().toString(36)}`,
        title,
        summary,
        entities: keywords,
        keywords,
        turnRange: [Math.max(1, s.turn - 5), s.turn],
        enabled: true,
        pinned: false,
        createdTurn: s.turn,
      };
      rt.commitTx({ kind: "memory_book_upsert", entry });
      rt.refreshHud(ctx);
      ctx.ui.notify(`已创建记忆书章节「${title}」`, "info");
      continue;
    }

    if (pick.startsWith("📦")) {
      await rt.summarizeOldFloors(ctx);
      continue;
    }

    const chosen = books[opts.indexOf(pick) - 2];
    if (!chosen) continue;
    const act = await ctx.ui.select(
      `📖 ${chosen.title}（${chosen.enabled ? "启用" : "禁用"}${chosen.pinned ? " · 常驻置顶" : ""} · 词：${chosen.keywords.join("、") || "无"}）`,
      [
        "✏️ 查看 / 编辑章节摘要正文",
        "🏷 编辑标题与触发词",
        chosen.pinned ? "📍 取消置顶（恢复按词召回）" : "📌 置顶常驻（每轮必带）",
        chosen.enabled ? "○ 禁用此章节" : "● 启用此章节",
        "🗑 删除此章节",
        "← 返回",
      ],
    );
    if (!act || act.startsWith("←")) continue;
    if (act.startsWith("✏️")) {
      const nextSummary = (await editLongText(ctx, `编辑记忆书「${chosen.title}」`, chosen.summary))?.trim();
      if (nextSummary && nextSummary !== chosen.summary) {
        rt.commitTx({ kind: "memory_book_upsert", entry: { ...chosen, summary: nextSummary } });
        ctx.ui.notify("已保存记忆书修改。", "info");
      }
    } else if (act.startsWith("🏷")) {
      const nextTitle = (await ctx.ui.input("章节标题", chosen.title))?.trim() || chosen.title;
      const nextKw = (await ctx.ui.input("触发关键词（逗号分隔）", chosen.keywords.join(", "))) ?? "";
      const kws = nextKw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      rt.commitTx({
        kind: "memory_book_upsert",
        entry: { ...chosen, title: nextTitle, keywords: kws, entities: Array.from(new Set([...chosen.entities, ...kws])) },
      });
      ctx.ui.notify("已更新章节标题与触发词。", "info");
    } else if (act.startsWith("📌") || act.startsWith("📍")) {
      rt.commitTx({ kind: "memory_book_upsert", entry: { ...chosen, pinned: !chosen.pinned } });
      ctx.ui.notify(chosen.pinned ? "已取消置顶。" : "已置顶该记忆书章节。", "info");
    } else if (act.startsWith("○") || act.startsWith("●")) {
      rt.commitTx({ kind: "memory_book_upsert", entry: { ...chosen, enabled: !chosen.enabled } });
    } else if (act.startsWith("🗑")) {
      const ok = await ctx.ui.confirm("删除记忆书章节", `永久删除「${chosen.title}」？`);
      if (ok) {
        rt.commitTx({ kind: "memory_book_delete", entryId: chosen.id });
        rt.refreshHud(ctx);
      }
    }
  }
}

export async function openMemoryBookSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const activeFacts = getActiveFacts(s);
    const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open");

    const secretCount = activeFacts.filter((f) => f.witnessIds !== "public").length;
    const { blindSpots } = partitionEpistemicFacts(activeFacts, s.presentNpcs);
    const options: string[] = [
      `📚 记忆书章节 Memory Books（${s.memoryBooks.size} 章 — 全文编辑/置顶/归档）`,
      `🔒 秘密与认知盲区 FANToM（秘密 ${secretCount} 条 · 生效盲区 ${blindSpots.length} 处）`,
      "📜 查看前情提要（0 Token 瞬时合成）",
      "📦 总结并隐藏较早的对话楼层 → 写入记忆书",
      "+ 记录一条重要剧情/秘密（支持仅指定角色知情）",
      "+ 记录一条未完约定 / 伏笔",
      ...activeFacts.slice(-14).reverse().map((f) => {
        const vis = f.witnessIds === "public" ? "" : ` [仅:${f.witnessIds.join(",")}]`;
        return `▪ [T${f.validFromTurn}]${vis} ${f.statement.slice(0, 48)} (${f.id})`;
      }),
      ...openHooks.map((h) => `◇ [伏笔:${h.id}] ${h.summary.slice(0, 50)}`),
      "← 返回主面板",
    ];

    const pick = await ctx.ui.select(
      sheetHeader(
        ctx,
        `📖 记忆书、事实与秘密（章节 ${s.memoryBooks.size} · 事实 ${activeFacts.length} · 盲区 ${blindSpots.length} · 伏笔 ${openHooks.length}）`,
      ),
      options,
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("📚")) {
      await openMemoryBookChapters(rt, ctx);
      continue;
    }
    if (pick.startsWith("🔒")) {
      await openSecretsInspector(rt, ctx);
      continue;
    }
    if (pick.startsWith("📜")) {
      await rt.recapStory(ctx);
      return;
    }
    if (pick.startsWith("📦")) {
      await rt.summarizeOldFloors(ctx);
      continue;
    }
    if (pick.startsWith("+ 记录一条重要剧情")) {
      const statement = (await editLongText(ctx, "输入重要事件或秘密内容", ""))?.trim();
      if (!statement) continue;
      const entitiesStr = (await ctx.ui.input("关联人物/地点（逗号分隔，可选）", "")) ?? "";
      const entities = entitiesStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const visPick = await ctx.ui.select("谁知道这件事？", [
        "🌐 公开事件（大家都知道）",
        "🔒 私密事件（仅指定角色知情，防止其他角色穿帮）",
      ]);
      let witnessIds: string[] | "public" = "public";
      if (visPick?.startsWith("🔒")) {
        const wStr = (await ctx.ui.input("知情角色名（逗号分隔）", s.currentPersona.name)) ?? "";
        const parsed = wStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
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
      ctx.ui.notify(witnessIds === "public" ? "已记入长期事实。" : `已记入私密事件（仅 ${witnessIds.join("、")} 知情）。`, "info");
    } else if (pick.startsWith("+ 记录一条未完约定")) {
      const summary = (await ctx.ui.input("约定或伏笔内容", ""))?.trim();
      if (!summary) continue;
      const triggerHint = (await ctx.ui.input("何时提醒/相关线索（可选）", ""))?.trim() ?? "";
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
      ctx.ui.notify("已记入未完约定/伏笔。", "info");
    } else if (pick.startsWith("▪")) {
      const idMatch = /\(([^)]+)\)$/.exec(pick);
      const factId = idMatch?.[1];
      const fact = factId ? s.facts.get(factId) : undefined;
      if (!fact) continue;
      const visText = fact.witnessIds === "public" ? "公开" : `仅 ${fact.witnessIds.join("、")} 知情`;
      const act = await ctx.ui.select(`事实 [${fact.id}]（${visText}）`, [
        "✏️ 查看 / 编辑事实全文",
        "👁 修改知情范围（公开 / 私密隔离）",
        "🗑 标记为已过时（失效）",
        "← 返回",
      ]);
      if (!act || act.startsWith("←")) continue;
      if (act.startsWith("✏️")) {
        const nextStmt = (await editLongText(ctx, `编辑事实 ${fact.id}`, fact.statement))?.trim();
        if (nextStmt && nextStmt !== fact.statement) {
          rt.commitTx({ kind: "fact_update", factId: fact.id, statement: nextStmt });
          ctx.ui.notify("已更新事实内容。", "info");
        }
      } else if (act.startsWith("👁")) {
        const vPick = await ctx.ui.select("修改知情范围", ["🌐 改为公开（所有角色可知）", "🔒 改为私密（指定知情者）"]);
        if (vPick?.startsWith("🌐")) {
          rt.commitTx({ kind: "fact_update", factId: fact.id, witnessIds: "public" });
          ctx.ui.notify("已设为公开事实。", "info");
        } else if (vPick?.startsWith("🔒")) {
          const cur = Array.isArray(fact.witnessIds) ? fact.witnessIds.join(", ") : s.currentPersona.name;
          const w = (await ctx.ui.input("知情角色名（逗号分隔）", cur)) ?? "";
          const list = w.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
          if (list.length > 0) {
            rt.commitTx({ kind: "fact_update", factId: fact.id, witnessIds: list });
            ctx.ui.notify(`已更新知情范围：${list.join("、")}`, "info");
          }
        }
      } else if (act.startsWith("🗑")) {
        rt.commitTx({ kind: "fact_invalidate", factId: fact.id, validUntilTurn: s.turn, reason: "manual_panel" });
        ctx.ui.notify("已标记该记忆为过时。", "info");
      }
    } else if (pick.startsWith("◇ [伏笔:")) {
      const m = /\[伏笔:([^\]]+)\]/.exec(pick);
      const id = m?.[1];
      const hook = id ? s.foresights.get(id) : undefined;
      if (!hook) continue;
      const act = await ctx.ui.select(`伏笔：${hook.summary}`, [
        "✅ 标记为已回收 (paid_off)",
        "✏️ 修改伏笔内容",
        "🗑 标记为已废弃 (expired)",
        "← 返回",
      ]);
      if (act?.startsWith("✅")) {
        rt.commitTx({ kind: "foresight_upsert", hook: { ...hook, status: "paid_off" } });
        rt.refreshHud(ctx);
      } else if (act?.startsWith("✏️")) {
        const nextSum = (await ctx.ui.input("修改伏笔内容", hook.summary))?.trim();
        if (nextSum) rt.commitTx({ kind: "foresight_upsert", hook: { ...hook, summary: nextSum } });
      } else if (act?.startsWith("🗑")) {
        rt.commitTx({ kind: "foresight_upsert", hook: { ...hook, status: "expired" } });
        rt.refreshHud(ctx);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 世界书完整 CRUD 管理（查看全文 / 编辑标题触发词正文 / 手动新增 / AI 生成 / 删除）
// ---------------------------------------------------------------------------
export async function openLoreManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  type LoreFilterMode = "all" | "enabled" | "constant" | "gated";
  let searchQuery = "";
  let filterMode: LoreFilterMode = "all";
  let page = 0;
  const pageSize = 16;

  while (true) {
    const primaryCard = rt.getCard();
    const allLore = getAllLore(rt);
    const s = rt.getState();
    const filtered = allLore.filter((e) => {
      const enabled = s.loreOverrides[e.id] ?? e.enabled;
      const gated = !evaluateGate(e.gate, s);
      if (filterMode === "enabled" && !enabled) return false;
      if (filterMode === "constant" && !e.constant) return false;
      if (filterMode === "gated" && !gated) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const hay = `${e.title} ${e.keys.join(" ")} ${e.content.slice(0, 160)}`.toLowerCase();
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
      "+ 手动新建世界书条目",
      "✨ 从最近剧情 AI 生成新世界书条目 (/rp loregen)",
      `🔍 搜索世界书${searchQuery ? `（当前：“${searchQuery}”）` : ""}`,
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
      sheetHeader(
        ctx,
        `📚 世界书完整管理（匹配 ${filtered.length}/${allLore.length} 条 · 第 ${page + 1}/${totalPages} 页）`,
      ),
      [...navTop, ...itemOptions, ...navBottom],
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+ 手动新建")) {
      if (!primaryCard) continue;
      const title = (await ctx.ui.input("世界书条目标题", ""))?.trim();
      if (!title) continue;
      const keysRaw = (await ctx.ui.input("触发词（逗号分隔）", title)) ?? "";
      const keys = keysRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const content = (await editLongText(ctx, `编写「${title}」正文`, ""))?.trim();
      if (!content) continue;
      const isConst = await ctx.ui.confirm("设为常驻设定？", "选择「确认」则每轮固定注入 Zone 1；选择「取消」则按关键词动态召回。");
      const compiled = compileLoreBook({
        entries: [
          {
            id: `lore_man_${Date.now().toString(36)}`,
            comment: title,
            keys,
            content,
            enabled: true,
            constant: isConst,
            insertion_order: 100,
          },
        ],
      });
      if (compiled.entries[0]) {
        primaryCard.loreBook.entries.push(compiled.entries[0]);
        if (s.worldDir) saveUpdatedCard(s.worldDir, primaryCard);
        rt.reloadRuntime(ctx);
        ctx.ui.notify(`✅ 已新增世界书条目「${title}」`, "info");
      }
      continue;
    }
    if (pick.startsWith("✨")) {
      await rt.generateLoreEntry(ctx);
      continue;
    }
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
    const isPrimaryEntry = Boolean(primaryCard?.loreBook.entries.some((e) => e.id === entry.id));

    const action = await ctx.ui.select(
      `条目：${entry.title}（${currentEnabled ? "启用中" : "已禁用"} · ${entry.constant ? "常驻" : "动态"} · 词：${entry.keys.join(", ") || "无"}）`,
      [
        currentEnabled ? "○ 暂时禁用此条目（仅本会话）" : "● 重新启用此条目（仅本会话）",
        "📖 查看 / 编辑完整正文",
        ...(isPrimaryEntry
          ? [
              "🏷 编辑标题与触发词",
              entry.constant ? "🔄 改为动态按词召回" : "📌 改为常驻设定 (Zone 1)",
              "🗑 永久删除此条目",
            ]
          : []),
        "← 返回列表",
      ],
    );
    if (!action || action.startsWith("←")) continue;

    if (action.startsWith("○") || action.startsWith("●")) {
      rt.commitTx({ kind: "lore_toggle", entryId: entry.id, enabled: !currentEnabled });
      ctx.ui.notify(`世界书「${entry.title}」已${!currentEnabled ? "启用" : "禁用"}`, "info");
    } else if (action.startsWith("📖")) {
      const edited = await editLongText(ctx, `世界书全文 · ${entry.title}`, entry.content);
      if (isPrimaryEntry && primaryCard && edited !== undefined && edited.trim() && edited.trim() !== entry.content) {
        entry.content = edited.trim();
        if (s.worldDir) saveUpdatedCard(s.worldDir, primaryCard);
        rt.reloadRuntime(ctx);
        ctx.ui.notify(`已保存「${entry.title}」正文修改。`, "info");
      }
    } else if (action.startsWith("🏷") && isPrimaryEntry && primaryCard) {
      const nextTitle = (await ctx.ui.input("条目标题", entry.title))?.trim() || entry.title;
      const nextKeysRaw = (await ctx.ui.input("触发词（逗号分隔）", entry.keys.join(", "))) ?? "";
      entry.title = nextTitle;
      entry.keys = nextKeysRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (s.worldDir) saveUpdatedCard(s.worldDir, primaryCard);
      rt.reloadRuntime(ctx);
      ctx.ui.notify("已更新标题与触发词。", "info");
    } else if ((action.startsWith("🔄") || action.startsWith("📌")) && isPrimaryEntry && primaryCard) {
      entry.constant = !entry.constant;
      if (s.worldDir) saveUpdatedCard(s.worldDir, primaryCard);
      rt.reloadRuntime(ctx);
      ctx.ui.notify(`已设为：${entry.constant ? "常驻 Zone 1" : "动态召回"}`, "info");
    } else if (action.startsWith("🗑") && isPrimaryEntry && primaryCard) {
      const ok = await ctx.ui.confirm("删除世界书条目", `永久删除「${entry.title}」？`);
      if (ok) {
        primaryCard.loreBook.entries = primaryCard.loreBook.entries.filter((e) => e.id !== entry.id);
        if (s.worldDir) saveUpdatedCard(s.worldDir, primaryCard);
        rt.reloadRuntime(ctx);
        ctx.ui.notify(`已删除世界书条目「${entry.title}」`, "info");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 导演台 (Author's Note, Pacing, Inner Monologue, Quick Replies)
// ---------------------------------------------------------------------------
export async function openNotesAndPacing(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const options = [
      `🎚 切换叙事节奏（当前：${s.pacingMode} · Alt+P）`,
      `💭 角色内心独白 (<thought>)：${s.innerMonologue ? "● 已开启（点击关闭）" : "○ 已关闭（点击开启）"}`,
      "⚡ 管理与触发快捷回复 / 动作宏 (Alt+E)",
      `✨ 一键 AI 深度建档 (/rp analyze · ${rt.getCard()?.worldProfile?.source === "llm-analyzed" ? "已建档" : "启发式"})`,
      "+ 新增导演指令 (Author's Note)",
      ...s.notes.map(
        (n, i) => `▪ #${i + 1} ${n.text.slice(0, 52)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
      ),
      ...(s.notes.length > 0 ? ["🧹 清空全部导演指令"] : []),
      "← 返回主面板",
    ];
    const pick = await ctx.ui.select(sheetHeader(ctx, "🎬 导演台与快捷动作"), options);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🎚")) {
      const p = await ctx.ui.select("选择叙事节奏", [
        "relaxed — 舒缓细腻，注重氛围与日常互动",
        "balanced — 均衡自然（默认）",
        "dramatic — 紧凑强冲突，积极推进悬念与冲突",
      ]);
      if (p) {
        const mode = p.split(" ")[0] as PacingMode;
        rt.commitTx({ kind: "config_patch", pacingMode: mode });
        rt.refreshHud(ctx);
        ctx.ui.notify(`叙事节奏已切换为：${mode}`, "info");
      }
    } else if (pick.startsWith("💭")) {
      const next = !s.innerMonologue;
      rt.commitTx({ kind: "config_patch", innerMonologue: next });
      rt.refreshHud(ctx);
      ctx.ui.notify(`角色内心独白已${next ? "开启（将以精致引文块呈现潜台词）" : "关闭"}`, "info");
    } else if (pick.startsWith("⚡")) {
      await rt.openQuickReplies(ctx);
    } else if (pick.startsWith("✨")) {
      await rt.analyzeCard(ctx);
    } else if (pick.startsWith("+")) {
      const text = (await editLongText(ctx, "编写导演指令（注入尾部，不破坏前缀缓存）", ""))?.trim();
      if (!text) continue;
      const ttlStr = (await ctx.ui.input("生效轮数（留空=永久常驻，输入数字如 3=生效3轮）", ""))?.trim();
      const ttl = ttlStr && /^\d+$/.test(ttlStr) ? Math.max(1, Number(ttlStr)) : null;
      rt.commitTx({
        kind: "note_set",
        note: { id: `note_${Date.now().toString(36)}`, text, remainingTurns: ttl },
      });
      rt.refreshHud(ctx);
      ctx.ui.notify("导演指令已生效。", "info");
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

// ---------------------------------------------------------------------------
// 6. 上下文 X-Ray 透视 & 状态变更审计撤销
// ---------------------------------------------------------------------------
async function openXRayAndAuditSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const xray = rt.getLastXRay();
    const undoable = s.auditLog.filter((r) => Boolean(r.undoTx)).length;
    const summaryLine = xray
      ? `⚡ Zone1=${xray.zone1Tokens}t (KV×${xray.cacheHitStreak}) · Zone2=${xray.zone2Tokens}t · Zone3=${xray.zone3Tokens}t · 召回 ${xray.recalled.length} 条`
      : "尚未捕获 X-Ray 快照（发送一轮对话后自动生成）";

    const pick = await ctx.ui.select(sheetHeader(ctx, "🔎 上下文 X-Ray 透视 & 审计撤销"), [
      `🔎 输出完整 X-Ray 透视卡片（${summaryLine}）`,
      `↩ 查看状态变更审计日志并一键撤销（可撤销 ${undoable} 条）`,
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🔎")) {
      await rt.openXRay(ctx);
      return;
    }
    if (pick.startsWith("↩")) {
      await rt.undoLast(ctx, false);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. 跑团机制、引擎高级设置与资产库
// ---------------------------------------------------------------------------
async function openRpgToolsSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const clockCount = Object.keys(s.clocks).length;
    const flagCount = Object.keys(s.flags).length;

    const pick = await ctx.ui.select(sheetHeader(ctx, "🎲 跑团机制与引擎高级设置"), [
      `🎒 背包物品 (${invCount} 项)`,
      `⏳ 进度时钟 (${clockCount} 个)`,
      "🎲 快捷掷骰检定 (/rp roll)",
      `🏁 剧情阶段 / 章节（当前：${s.era || "未启用"}）`,
      `⚙ 世界开关 Flags (${flagCount} 项) & 引擎模块开关`,
      `🤖 Sidecar 后台专职模型（当前：${s.sidecarModel || "跟随主模型"}）`,
      `📏 动态世界书 Token 预算（当前：${s.loreTokenBudget} tokens）`,
      `🎛 应用预设采样参数 (before_provider_request)：${s.applyPresetSampling ? "● 开" : "○ 关"}`,
      "🗂 资产库管理（删除角色卡 / 预设 / 马甲）",
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🎒")) {
      await openInventoryManager(rt, ctx);
    } else if (pick.startsWith("⏳")) {
      const clocks = Object.values(s.clocks);
      const sub = await ctx.ui.select("进度时钟（Blades 风格倒计时/进度条）", [
        "+ 新建进度时钟",
        ...clocks.map(
          (c) =>
            `⏳ [${c.clockId}] ${c.label}  ${renderProgressBar(c.value, c.max, 6)}  ${c.value}/${c.max}${c.completed ? " (完成)" : ""}`,
        ),
        "← 返回",
      ]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("+")) {
        const label = (await ctx.ui.input("时钟名称（如：警觉度、任务倒计时）", ""))?.trim();
        if (!label) continue;
        const max = Math.max(1, Number((await ctx.ui.input("总格数（如 4 / 6 / 8）", "4"))?.trim()) || 4);
        const clockId = label.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_").slice(0, 24) || `clk_${Date.now()}`;
        rt.commitTx({ kind: "progress_clock", clockId, label, delta: 0, max });
        rt.refreshHud(ctx);
      } else if (sub.startsWith("⏳")) {
        const clockId = /\[([^\]]+)\]/.exec(sub)?.[1];
        const clk = clockId ? s.clocks[clockId] : undefined;
        if (!clk) continue;
        const op = await ctx.ui.select(`${clk.label} (${clk.value}/${clk.max})`, ["+1 推进一格", "-1 回退一格", "← 返回"]);
        if (op?.startsWith("+1")) {
          rt.commitTx({ kind: "progress_clock", clockId: clk.clockId, label: clk.label, delta: 1, max: clk.max });
          rt.refreshHud(ctx);
        } else if (op?.startsWith("-1")) {
          rt.commitTx({ kind: "progress_clock", clockId: clk.clockId, label: clk.label, delta: -1, max: clk.max });
          rt.refreshHud(ctx);
        }
      }
    } else if (pick.startsWith("🎲")) {
      await rt.quickRoll(ctx);
    } else if (pick.startsWith("🏁")) {
      const nextStage = await ctx.ui.input("当前阶段 / 章节（留空则隐藏不显示）", s.era);
      if (nextStage !== undefined && nextStage.trim() !== s.era) {
        rt.commitTx({
          kind: "era_advance",
          fromEra: s.era,
          toEra: nextStage.trim(),
          milestoneUnlocked: [],
          montageSummary: "panel_edit",
          turn: s.turn,
        });
        rt.refreshHud(ctx);
        ctx.ui.notify(`阶段已更新：${nextStage.trim() || "(已隐藏)"}`, "info");
      }
    } else if (pick.startsWith("⚙")) {
      const modLabels = [
        `⚙ 模块[数值 stats]：${s.modules.stats ? "● 开" : "○ 关"}`,
        `⚙ 模块[背包 inventory]：${s.modules.inventory ? "● 开" : "○ 关"}`,
        `⚙ 模块[时钟 clocks]：${s.modules.clocks ? "● 开" : "○ 关"}`,
        `⚙ 模块[阶段 stages]：${s.modules.stages ? "● 开" : "○ 关"}`,
      ];
      const flagItems = Object.entries(s.flags).map(([k, v]) => `${v ? "● 开" : "○ 关"}  ${k}`);
      const sub = await ctx.ui.select("世界开关 Flags 与引擎模块开关", ["+ 新增 Flag", ...modLabels, ...flagItems, "← 返回"]);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("+")) {
        const name = (await ctx.ui.input("Flag 名称", ""))?.trim();
        if (name) {
          rt.commitTx({ kind: "flag_set", flag: name, value: true });
          ctx.ui.notify(`已启用 Flag：${name}`, "info");
        }
      } else if (sub.startsWith("⚙ 模块[")) {
        const m = /模块\[[^\s]+\s+(stats|inventory|clocks|stages)\]/.exec(sub);
        const modKey = m?.[1] as keyof SessionRpState["modules"] | undefined;
        if (modKey) {
          const nextMods = { ...s.modules, [modKey]: !s.modules[modKey] };
          rt.commitTx({ kind: "profile_apply", archetype: s.archetype, modules: nextMods });
          rt.refreshHud(ctx);
          ctx.ui.notify(`模块 ${modKey} 已${nextMods[modKey] ? "开启" : "关闭"}`, "info");
        }
      } else {
        const name = sub.replace(/^[●○]\s+[开关]\s+/, "");
        rt.commitTx({ kind: "flag_set", flag: name, value: !Boolean(s.flags[name]) });
      }
    } else if (pick.startsWith("🤖")) {
      await rt.pickSidecarModel(ctx);
    } else if (pick.startsWith("📏")) {
      const budgetStr = (await ctx.ui.input("动态世界书 Token 预算（建议 800 ~ 4000）", String(s.loreTokenBudget)))?.trim();
      const val = Number(budgetStr);
      if (Number.isFinite(val) && val >= 200) {
        rt.commitTx({ kind: "config_patch", loreTokenBudget: Math.min(8000, Math.round(val)) });
        ctx.ui.notify(`动态世界书预算已调整为 ${Math.min(8000, Math.round(val))} tokens`, "info");
      }
    } else if (pick.startsWith("🎛")) {
      const next = !s.applyPresetSampling;
      rt.commitTx({ kind: "config_patch", applyPresetSampling: next });
      ctx.ui.notify(`应用酒馆预设采样参数（temperature/top_p/max_tokens）：${next ? "已开启" : "已关闭"}`, "info");
    } else if (pick.startsWith("🗂")) {
      await rt.manageLibrary(ctx);
    }
  }
}

async function openOverviewAndAudit(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  const s = rt.getState();
  const card = rt.getCard();
  const activeFacts = getActiveFacts(s).length;
  const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open").length;
  const allLore = getAllLore(rt);
  const usage = ctx.getContextUsage?.();
  const usageText =
    usage && typeof usage.tokens === "number" && usage.contextWindow > 0
      ? `${(usage.tokens / 1000).toFixed(1)}k / ${Math.round(usage.contextWindow / 1000)}k (${Math.round(usage.percent ?? (usage.tokens / usage.contextWindow) * 100)}%)`
      : null;

  const lines = [
    `◆ 主角色      ${card ? `${card.identity.name} (${card.specOrigin.toUpperCase()})` : s.cardSlug ?? "未知"}`,
    `◆ 卡型模式    ${s.archetype}  │  节奏:${s.pacingMode} · 结算:${s.settlementMode} · HUD:${s.hudMode}`,
    `◆ 后台模型    ${s.sidecarModel || "跟随主对话模型"}  │  世界书预算: ${s.loreTokenBudget}t`,
    `◆ 玩家马甲    ${s.currentPersona.name}  │  同场共演: ${s.activeCharacters.length} 卡`,
    `◆ 场景进度    ${[s.era, s.worldTimeLabel, s.location, `T${s.turn}`].filter(Boolean).join(" · ")}`,
    `◆ 记忆账本    世界书 ${allLore.length} · 记忆书 ${s.memoryBooks.size} 章 · 事实 ${activeFacts} · 信念 ${s.beliefs.length} · 伏笔 ${openHooks} · 隐藏 ${s.hiddenEntryIds.size} 楼`,
    ...(usageText ? [`◆ 上下文用量  ${usageText}`] : []),
    ...(card
      ? [
          `◆ 对话示例    ${card.importReport.mesExampleCharsAfter}/${card.importReport.mesExampleCharsBefore} 字符 (100% 原样保留)`,
          `◆ 导入净化    剥离 ${card.importReport.strippedItems.length} 处酒馆前端壳 · 打捞变量 ${card.importReport.salvagedVariables.length} 项`,
        ]
      : []),
    ...(card?.meta.creator ? [`◆ 作者信息    ${card.meta.creator}${card.meta.version ? ` v${card.meta.version}` : ""}`] : []),
    ...(card?.meta.creatorNotes
      ? [`◆ 作者备注    ${card.meta.creatorNotes.replace(/\s+/g, " ").slice(0, 120)}`]
      : []),
  ];

  const pick = await ctx.ui.select(sheetHeader(ctx, "🌍 会话总览与导入审计"), [
    ...lines,
    `⌨️ 查看全部 ${RP_SHORTCUT_LIST.length} 项快捷键`,
    "← 返回主面板",
  ]);
  if (pick?.startsWith("⌨️")) {
    await ctx.ui.select(
      sheetHeader(ctx, "RP 快捷键速查（Pi 原生 /hotkeys 可查看全部）"),
      [...RP_SHORTCUT_LIST.map((k) => `${k.key.padEnd(14)}  ${k.label} — ${k.description}`), "← 返回"],
    );
  }
}

async function dispatchOverlayAction(rt: DashboardRuntime, ctx: PiExtensionContext, actionKey: string): Promise<boolean> {
  switch (actionKey) {
    case "scene:location":
    case "scene:time":
    case "scene:objective":
      await openSceneSection(rt, ctx);
      return true;
    case "scene:storylets":
      await openStoryletsManager(rt, ctx);
      return true;
    case "scene:skip":
      await rt.skipScene(ctx);
      return false;
    case "char:persona":
      await rt.switchPersona(ctx);
      return true;
    case "char:cast":
      await rt.manageCast(ctx);
      return true;
    case "char:cfsm":
    case "char:stats":
    case "char:beliefs":
      await openCharactersSection(rt, ctx);
      return true;
    case "char:inventory":
      await openInventoryManager(rt, ctx);
      return true;
    case "mem:books":
      await openMemoryBookChapters(rt, ctx);
      return true;
    case "mem:secrets":
      await openSecretsInspector(rt, ctx);
      return true;
    case "mem:recap":
      await rt.recapStory(ctx);
      return false;
    case "mem:summarize":
      await rt.summarizeOldFloors(ctx);
      return true;
    case "mem:facts":
    case "mem:hooks":
      await openMemoryBookSection(rt, ctx);
      return true;
    case "lore:manage":
      await openLoreManager(rt, ctx);
      return true;
    case "lore:gen":
      await rt.generateLoreEntry(ctx);
      return true;
    case "dir:pacing":
    case "dir:notes":
      await openNotesAndPacing(rt, ctx);
      return true;
    case "dir:monologue": {
      const next = !rt.getState().innerMonologue;
      rt.commitTx({ kind: "config_patch", innerMonologue: next });
      rt.refreshHud(ctx);
      ctx.ui.notify(`角色内心独白已${next ? "开启" : "关闭"}`, "info");
      return true;
    }
    case "dir:qr":
      await rt.openQuickReplies(ctx);
      return false;
    case "dir:analyze":
      await rt.analyzeCard(ctx);
      return true;
    case "xray:full":
      await rt.openXRay(ctx);
      return false;
    case "xray:undo":
      await rt.undoLast(ctx, false);
      return true;
    case "rpg:clocks":
    case "set:rpg":
      await openRpgToolsSection(rt, ctx);
      return true;
    case "set:sidecar":
      await rt.pickSidecarModel(ctx);
      return true;
    case "set:budget": {
      const cur = rt.getState().loreTokenBudget;
      const val = Number((await ctx.ui.input("动态世界书 Token 预算（200-8000）", String(cur)))?.trim());
      if (Number.isFinite(val) && val >= 200) {
        rt.commitTx({ kind: "config_patch", loreTokenBudget: Math.min(8000, Math.round(val)) });
        ctx.ui.notify(`动态世界书预算已调整为 ${Math.min(8000, Math.round(val))} tokens`, "info");
      }
      return true;
    }
    case "set:sampling": {
      const next = !rt.getState().applyPresetSampling;
      rt.commitTx({ kind: "config_patch", applyPresetSampling: next });
      ctx.ui.notify(`预设采样参数注入：${next ? "已开启" : "已关闭"}`, "info");
      return true;
    }
    case "set:library":
      await rt.manageLibrary(ctx);
      return true;
    case "set:overview":
      await openOverviewAndAudit(rt, ctx);
      return true;
    case "set:exit":
      await rt.exitRp(ctx, true);
      return false;
    default:
      return true;
  }
}

export async function openRpDashboard(
  rt: DashboardRuntime,
  ctx: PiExtensionContext,
  initialTab: OverlayTabIndex = 0,
  preferTuiOverlay = false,
): Promise<void> {
  const state = rt.getState();
  if (!state.active) {
    ctx.ui.notify("当前会话未开启 RP 模式。按 Alt+R 或输入 /rp 打开启动器。", "info");
    return;
  }

  // Optional Desktop-keyboard 7-tab TUI overlay (opt-in via `/rp panel tui` so mobile pi-android
  // always opens the crisp native touch Bottom Sheet instead of a tiny 97x16 virtual terminal!)
  if (preferTuiOverlay && ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    let tab: OverlayTabIndex = initialTab;
    while (rt.getState().active) {
      const action = await openTuiOverlayDashboard(ctx, {
        state: rt.getState(),
        card: rt.getCard(),
        allLore: getAllLore(rt),
        xray: rt.getLastXRay(),
        initialTab: tab,
      });
      if (!action || action.kind === "close") return;
      tab = action.tab;
      if (action.kind === "undo_last") {
        await rt.undoLast(ctx, true);
        continue;
      }
      const keepOpen = await dispatchOverlayAction(rt, ctx, action.actionKey);
      if (!keepOpen) return;
    }
    return;
  }

  // Full-CRUD RPC / Mobile (`pi-android`) interactive select dashboard
  while (true) {
    const s = rt.getState();
    if (!s.active) return;
    const card = rt.getCard();
    const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open").length;
    const xray = rt.getLastXRay();

    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const activeFactsList = getActiveFacts(s);
    const secretCount = activeFactsList.filter((f) => f.witnessIds !== "public").length;
    const title = sheetHeader(
      ctx,
      `◆ ${[card?.identity.name ?? s.cardSlug ?? "RP", s.era, s.worldTimeLabel, `T${s.turn}`].filter(Boolean).join(" · ")}`,
    );
    const choice = await ctx.ui.select(title, [
      `1. 📍 场景、目标与 Storylets（${s.location || "未设定"}${s.sceneObjective ? ` · 🎯${s.sceneObjective.slice(0, 14)}` : ""}）`,
      `2. 👥 人物与关系（CFSM / 数值${s.modules.inventory || invCount > 0 ? ` / 背包:${invCount}` : ""} / 信念 / 马甲：${s.currentPersona.name}）`,
      `3. 📚 记忆书、事实与秘密（书 ${s.memoryBooks.size} · 事实 ${activeFactsList.length}${secretCount > 0 ? ` · 🔒秘密 ${secretCount}` : ""} · 伏笔 ${openHooks}）`,
      `4. 🗂 世界书完整管理（${getAllLore(rt).length} 条 · 搜索 / 全文编辑 / 新增 / AI生成 / 删除）`,
      `5. 🎬 导演台、快捷回复与 AI建档（节奏:${s.pacingMode} · 内心戏:${s.innerMonologue ? "开" : "关"} · ${card?.worldProfile?.source === "llm-analyzed" ? "✨已建档" : "启发式"}）`,
      `6. 🔎 上下文 X-Ray 透视 & 审计撤销（${xray ? `KV×${xray.cacheHitStreak} · 召回${xray.recalled.length}` : "待捕获"} · 审计 ${s.auditLog.length}）`,
      `7. ⚙ 跑团机制、Sidecar 模型、预算与资产库`,
      "8. 🌍 会话总览、上下文用量与导入审计",
      ...(s.auditLog.length > 0 ? [`↩ 撤销上次状态变更（${s.auditLog[s.auditLog.length - 1]!.summary.slice(0, 26)}）`] : []),
      "9. 🚪 彻底退出本会话 RP 模式",
      "✕ 关闭面板",
    ]);

    if (!choice || choice.startsWith("✕")) return;
    if (choice.startsWith("↩")) {
      await rt.undoLast(ctx, true);
      continue;
    }
    if (choice.startsWith("1.")) await openSceneSection(rt, ctx);
    else if (choice.startsWith("2.")) await openCharactersSection(rt, ctx);
    else if (choice.startsWith("3.")) await openMemoryBookSection(rt, ctx);
    else if (choice.startsWith("4.")) await openLoreManager(rt, ctx);
    else if (choice.startsWith("5.")) await openNotesAndPacing(rt, ctx);
    else if (choice.startsWith("6.")) await openXRayAndAuditSection(rt, ctx);
    else if (choice.startsWith("7.")) await openRpgToolsSection(rt, ctx);
    else if (choice.startsWith("8.")) await openOverviewAndAudit(rt, ctx);
    else if (choice.startsWith("9.")) {
      await rt.exitRp(ctx, true);
      return;
    }
  }
}
