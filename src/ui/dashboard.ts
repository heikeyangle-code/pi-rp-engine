/**
 * De-specialized, Human-Language `/rp panel` World Control Center.
 *
 * Organized around how real RP players actually play across ALL card archetypes:
 *  1. 当前场景与时间 (Location, Present NPCs, Time Label, 1-click Scene/Time Jump)
 *  2. 人物与关系 (Attitude/Emotion Stages [CFSM], Bounded Stats/Affection, Beliefs, Persona/Cast)
 *  3. 剧情记忆本 (0-Token Recap, Key Events w/ Public & Private Visibility, Hooks, Summarize & Hide Old Floors)
 *  4. 世界书管理 (Search, Filter, Paginated Toggle + Generate New Entry from Recent Dialogue)
 *  5. 导演台 (Author's Note: Pacing, Style/Length Presets, Multi-line Notes)
 *  6. 跑团与世界机制 (Inventory, Clocks, Quick Roll, Flags, Stage/Modules — highlighted for RPG/Mystery/Saga, tucked for Companion/Slice-of-Life)
 *  7. 会话总览与导入审计 (Context Usage, Card Audit, Creator Notes, Shortcuts)
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
  skipScene(ctx: PiExtensionContext): Promise<void>;
  recapStory(ctx: PiExtensionContext): Promise<void>;
  summarizeOldFloors(ctx: PiExtensionContext): Promise<void>;
  generateLoreEntry(ctx: PiExtensionContext): Promise<void>;
  switchPersona(ctx: PiExtensionContext): Promise<void>;
  manageCast(ctx: PiExtensionContext): Promise<void>;
  quickRoll(ctx: PiExtensionContext): Promise<void>;
}

function getAllLore(rt: DashboardRuntime): CompiledLoreEntry[] {
  const card = rt.getCard();
  if (!card) return [];
  return [...card.loreBook.entries, ...rt.getExtraCastCards().flatMap((c) => c.loreBook.entries)];
}

// ---------------------------------------------------------------------------
// 1. 当前场景与时间
// ---------------------------------------------------------------------------
async function openSceneSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const pick = await ctx.ui.select("╭─ 📍 当前场景与时间 ───────────────────────────", [
      `📍 修改地点与在场人物（当前：${s.location || "未设定"}${s.presentNpcs.length ? ` · ${s.presentNpcs.join("、")}` : ""}）`,
      `🕒 修改时间标签（当前：${s.worldTimeLabel || "未设定"}）`,
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
    } else if (pick.startsWith("⏳")) {
      await rt.skipScene(ctx);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 2. 人物与关系（态度阶段 / 好感与数值 / 人物印象 / 玩家马甲与共演）
// ---------------------------------------------------------------------------
async function openCharactersSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const statCount = Object.values(s.stats).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const cfsmCount = Object.values(s.cfsmStates).reduce((acc, rec) => acc + Object.keys(rec).length, 0);

    const pick = await ctx.ui.select("╭─ 👥 人物与关系 ───────────────────────────────", [
      `💭 角色态度与情绪阶段 (${cfsmCount} 项)`,
      `📊 好感与角色数值 (${statCount} 项)`,
      `◇ 人物印象与信念 (${s.beliefs.length} 条)`,
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
          const statesHint = def ? `  (${def.states.join("→")})` : "";
          axes.push({ label: `${actor} · ${axis}：${st.state}${statesHint}`, actor, axis, current: st.state });
        }
      }
      const opts = ["+ 新增角色态度/关系阶段", ...axes.map((a) => a.label), "← 返回"];
      const sub = await ctx.ui.select("角色态度与情绪阶段", opts);
      if (!sub || sub.startsWith("←")) continue;

      if (sub.startsWith("+")) {
        const actor = (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? "角色"))?.trim();
        if (!actor) continue;
        const axis = (await ctx.ui.input("维度名称（如：信任、亲密、警觉）", "信任"))?.trim();
        if (!axis) continue;
        const statesStr = (await ctx.ui.input("阶段列表（逗号分隔）", "陌生, 熟悉, 信任, 亲密"))?.trim();
        const statesList = (statesStr ?? "").split(/[,，→]/).map((x) => x.trim()).filter(Boolean);
        if (statesList.length < 2) continue;
        rt.commitTx({ kind: "cfsm_define", actorId: actor, def: { axis, states: statesList, initial: statesList[0]! } });
        rt.refreshHud(ctx);
        ctx.ui.notify(`已创建：${actor} · ${axis}（初态：${statesList[0]}）`, "info");
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
    } else if (pick.startsWith("📊")) {
      const existing: Array<{ label: string; actor: string; key: string }> = [];
      for (const [actor, rec] of Object.entries(s.stats)) {
        for (const [k, v] of Object.entries(rec)) {
          const b = s.statBounds[actor]?.[k];
          const gauge =
            typeof v === "number" && b && typeof b.max === "number" && b.max > 0
              ? `  ${renderProgressBar(v - (b.min ?? 0), b.max - (b.min ?? 0), 6)} ${v}/${b.max}`
              : ` = ${String(v)}`;
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
        `设置 ${actor} · ${key}（支持 +5 / -3 增减，或直接输入新值）`,
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
      ctx.ui.notify(`已更新 ${actor} · ${key} = ${String(rt.getState().stats[actor]?.[key])}`, "info");
    } else if (pick.startsWith("◇")) {
      const sub = await ctx.ui.select(
        `人物印象与信念（共 ${s.beliefs.length} 条）`,
        [
          "+ 手动记录一条人物印象",
          ...s.beliefs.slice(-10).reverse().map((b) => `◇ [T${b.turn}] ${b.actorId} → ${b.target}：${b.belief.slice(0, 48)}`),
          "← 返回",
        ],
      );
      if (sub?.startsWith("+")) {
        const actorId = (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? "角色"))?.trim();
        if (!actorId) continue;
        const target = (await ctx.ui.input("针对对象", s.currentPersona.name))?.trim();
        if (!target) continue;
        const activatingEvent = (await ctx.ui.input("因为发生了什么事", ""))?.trim();
        if (!activatingEvent) continue;
        const belief = (await ctx.ui.input("形成了什么看法/信念", ""))?.trim();
        if (!belief) continue;
        rt.commitTx({ kind: "belief_update", actorId, target, activatingEvent, belief, turn: s.turn });
        ctx.ui.notify(`已记录印象：${actorId} → ${target}`, "info");
      }
    } else if (pick.startsWith("🧑")) {
      await rt.switchPersona(ctx);
    } else if (pick.startsWith("👥")) {
      await rt.manageCast(ctx);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. 剧情记忆本（前情提要 / 重要事件与秘密 / 未完约定 / 总结并隐藏旧楼层）
// ---------------------------------------------------------------------------
async function openMemoryBookSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const activeFacts = getActiveFacts(s);
    const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open");

    const options: string[] = [
      "📜 查看前情提要（0 Token 瞬时合成）",
      "📦 总结并隐藏较早的对话楼层（省 Token 防失忆）",
      "+ 记录一条重要剧情/秘密（支持仅指定角色知情）",
      "+ 记录一条未完约定 / 伏笔",
      ...activeFacts.slice(-14).reverse().map((f) => {
        const vis = f.witnessIds === "public" ? "" : ` [仅:${f.witnessIds.join(",")}]`;
        return `▪ [T${f.validFromTurn}]${vis} ${f.statement.slice(0, 52)} (${f.id})`;
      }),
      ...openHooks.map((h) => `◇ [伏笔:${h.id}] ${h.summary.slice(0, 52)}`),
      "← 返回主面板",
    ];

    const pick = await ctx.ui.select(
      `╭─ 📖 剧情记忆本（事件 ${activeFacts.length} · 伏笔 ${openHooks.length} · 已隐藏 ${s.hiddenEntryIds.size} 楼）`,
      options,
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("📜")) {
      await rt.recapStory(ctx);
      return;
    }
    if (pick.startsWith("📦")) {
      await rt.summarizeOldFloors(ctx);
      continue;
    }
    if (pick.startsWith("+ 记录一条重要剧情")) {
      const statement = (await ctx.ui.input("输入重要事件或秘密内容", ""))?.trim();
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
      ctx.ui.notify(witnessIds === "public" ? "已记入剧情记忆本。" : `已记入私密事件（仅 ${witnessIds.join("、")} 知情）。`, "info");
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
      if (!factId) continue;
      const ok = await ctx.ui.confirm("标记为已过时", `将记忆 ${factId} 标记为失效（不再注入后续上下文）？`);
      if (ok) {
        rt.commitTx({ kind: "fact_invalidate", factId, validUntilTurn: s.turn, reason: "manual_panel" });
        ctx.ui.notify("已标记该记忆为过时。", "info");
      }
    } else if (pick.startsWith("◇ [伏笔:")) {
      const m = /\[伏笔:([^\]]+)\]/.exec(pick);
      const id = m?.[1];
      const hook = id ? s.foresights.get(id) : undefined;
      if (!hook) continue;
      const ok = await ctx.ui.confirm("标记已完成/回收", `将「${hook.summary}」标记为已回收？`);
      if (ok) {
        rt.commitTx({ kind: "foresight_upsert", hook: { ...hook, status: "paid_off" } });
        rt.refreshHud(ctx);
        ctx.ui.notify("已标记回收。", "info");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 世界书管理（搜索 / 筛选 / 分页开关 + 从对话一键生成新条目）
// ---------------------------------------------------------------------------
async function openLoreManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  type LoreFilterMode = "all" | "enabled" | "constant" | "gated";
  let searchQuery = "";
  let filterMode: LoreFilterMode = "all";
  let page = 0;
  const pageSize = 18;

  while (true) {
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
      "✨ 从最近剧情一键生成新世界书条目 (/rp loregen)",
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
      `╭─ 📚 世界书管理（匹配 ${filtered.length}/${allLore.length} 条 · 第 ${page + 1}/${totalPages} 页）`,
      [...navTop, ...itemOptions, ...navBottom],
    );
    if (!pick || pick.startsWith("←")) return;

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
    const action = await ctx.ui.select(
      `条目：${entry.title}（${currentEnabled ? "启用中" : "已禁用"} · 触发词：${entry.keys.join(", ") || "无"}）`,
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

// ---------------------------------------------------------------------------
// 5. 导演台 (Author's Note)
// ---------------------------------------------------------------------------
async function openNotesAndPacing(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const options = [
      `🎚 切换叙事节奏（当前：${s.pacingMode} · Alt+P）`,
      "+ 新增导演指令 (Author's Note)",
      ...s.notes.map(
        (n, i) => `▪ #${i + 1} ${n.text.slice(0, 56)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
      ),
      ...(s.notes.length > 0 ? ["🧹 清空全部导演指令"] : []),
      "← 返回主面板",
    ];
    const pick = await ctx.ui.select("╭─ 🎬 导演台 (Author's Note) ───────────────────", options);
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
    } else if (pick.startsWith("+")) {
      const text =
        typeof ctx.ui.editor === "function"
          ? (await ctx.ui.editor("编写导演指令（注入尾部，不破坏前缀缓存）", ""))?.trim()
          : (await ctx.ui.input("输入导演指令（注入尾部，不破坏缓存）", ""))?.trim();
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
// 6. 跑团与世界机制（按需展开：背包 / 进度时钟 / 掷骰 / Flags / 阶段与模块开关）
// ---------------------------------------------------------------------------
async function openRpgToolsSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const clockCount = Object.keys(s.clocks).length;
    const flagCount = Object.keys(s.flags).length;

    const pick = await ctx.ui.select("╭─ 🎲 跑团与世界机制 ───────────────────────────", [
      `🎒 背包物品 (${invCount} 项)`,
      `⏳ 进度时钟 (${clockCount} 个)`,
      "🎲 快捷掷骰检定 (/rp roll)",
      `🏁 剧情阶段 / 章节（当前：${s.era || "未启用"}）`,
      `⚙ 世界开关 Flags (${flagCount} 项) & 引擎模块开关`,
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🎒")) {
      const existing: Array<{ label: string; actor: string; item: string; qty: number }> = [];
      for (const [actor, rec] of Object.entries(s.inventory)) {
        for (const [item, qty] of Object.entries(rec)) {
          existing.push({ label: `${actor}  │  ${item} ×${qty}`, actor, item, qty });
        }
      }
      const opts = ["+ 新增物品", ...existing.map((e) => e.label), "← 返回"];
      const sub = await ctx.ui.select("背包管理（点击已有物品可快捷增减）", opts);
      if (!sub || sub.startsWith("←")) continue;

      if (sub.startsWith("+")) {
        const actor = (await ctx.ui.input("持有者（如 player）", "player"))?.trim();
        if (!actor) continue;
        const item = (await ctx.ui.input("物品名称", ""))?.trim();
        if (!item) continue;
        const delta = Number((await ctx.ui.input("数量变动（正数添加，负数扣除）", "1"))?.trim());
        if (!Number.isFinite(delta) || delta === 0) continue;
        rt.commitTx({ kind: "inventory_patch", actorId: actor, item, delta, note: "panel" });
        rt.refreshHud(ctx);
        ctx.ui.notify(`背包已更新：${item} (${delta > 0 ? `+${delta}` : delta})`, "info");
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
    } else if (pick.startsWith("⏳")) {
      const clocks = Object.values(s.clocks);
      const sub = await ctx.ui.select("进度时钟（Blades 风格倒计时/进度条）", [
        "+ 新建进度时钟",
        ...clocks.map(
          (c) => `⏳ [${c.clockId}] ${c.label}  ${renderProgressBar(c.value, c.max, 6)}  ${c.value}/${c.max}${c.completed ? " (完成)" : ""}`,
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
    }
  }
}

// ---------------------------------------------------------------------------
// 7. 会话总览与导入审计
// ---------------------------------------------------------------------------
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
    `◆ 玩家马甲    ${s.currentPersona.name}  │  同场共演: ${s.activeCharacters.length} 卡`,
    `◆ 场景进度    ${[s.era, s.worldTimeLabel, s.location, `T${s.turn}`].filter(Boolean).join(" · ")}`,
    `◆ 记忆账本    世界书 ${allLore.length} 条 · 记忆 ${activeFacts} 条 · 信念 ${s.beliefs.length} 条 · 伏笔 ${openHooks} 条 · 隐藏 ${s.hiddenEntryIds.size} 楼`,
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

  const pick = await ctx.ui.select("╭─ 🌍 会话总览与导入审计 ───────────────────────", [
    ...lines,
    `⌨️ 查看全部 ${RP_SHORTCUT_LIST.length} 项快捷键`,
    "← 返回主面板",
  ]);
  if (pick?.startsWith("⌨️")) {
    await ctx.ui.select(
      "╭─ RP 快捷键速查（Pi 原生 /hotkeys 可查看全部）",
      [...RP_SHORTCUT_LIST.map((k) => `${k.key.padEnd(14)}  ${k.label} — ${k.description}`), "← 返回"],
    );
  }
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
    const invCount = Object.values(s.inventory).reduce((acc, rec) => acc + Object.keys(rec).length, 0);
    const clockCount = Object.keys(s.clocks).length;
    const isRpgHeavy = s.archetype !== "companion" && s.archetype !== "slice-of-life";

    const title = `╭─ ◆ ${[card?.identity.name ?? s.cardSlug ?? "RP", s.era, s.worldTimeLabel, `T${s.turn}`].filter(Boolean).join(" · ")}`;
    const rpgRow = isRpgHeavy
      ? `6. 🎲 跑团与世界机制（背包 ${invCount} · 时钟 ${clockCount} · 掷骰 / 阶段 / Flags）`
      : `6. 🎲 跑团与世界机制（按需折叠 · 背包 / 时钟 / 掷骰 / 模块开关）`;

    const choice = await ctx.ui.select(title, [
      `1. 📍 当前场景与时间（${s.location || "未设定"}${s.worldTimeLabel ? ` · ${s.worldTimeLabel}` : ""}）`,
      `2. 👥 人物与关系（态度 / 好感数值 / 信念 / 马甲：${s.currentPersona.name}）`,
      `3. 📖 剧情记忆本（事件 ${getActiveFacts(s).length} · 伏笔 ${openHooks} · 总结隐藏旧楼）`,
      `4. 📚 世界书管理（${getAllLore(rt).length} 条 · 搜索 / 开关 / 从剧情生成新条）`,
      `5. 🎬 导演台 Author's Note（节奏:${s.pacingMode} · 指令 ${s.notes.length} 条）`,
      rpgRow,
      "7. 🌍 会话总览、上下文用量与导入审计",
      "8. 🚪 彻底退出本会话 RP 模式",
      "✕ 关闭面板",
    ]);

    if (!choice || choice.startsWith("✕")) return;
    if (choice.startsWith("1.")) await openSceneSection(rt, ctx);
    else if (choice.startsWith("2.")) await openCharactersSection(rt, ctx);
    else if (choice.startsWith("3.")) await openMemoryBookSection(rt, ctx);
    else if (choice.startsWith("4.")) await openLoreManager(rt, ctx);
    else if (choice.startsWith("5.")) await openNotesAndPacing(rt, ctx);
    else if (choice.startsWith("6.")) await openRpgToolsSection(rt, ctx);
    else if (choice.startsWith("7.")) await openOverviewAndAudit(rt, ctx);
    else if (choice.startsWith("8.")) {
      await rt.exitRp(ctx, true);
      return;
    }
  }
}
