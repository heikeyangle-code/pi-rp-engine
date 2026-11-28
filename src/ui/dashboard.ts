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
  PhysicalSnapshot,
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
import { renderProgressBar } from "./renderers.js";
import { RP_SHORTCUT_LIST } from "./shortcuts.js";
import { loadUiPrefs, saveUiPrefs } from "./file-picker.js";
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
  rewriteLast?(ctx: PiExtensionContext): Promise<void>;
  styleControl?(ctx: PiExtensionContext): Promise<void>;
  banPhrases?(ctx: PiExtensionContext): Promise<void>;
  spotlightNpc?(ctx: PiExtensionContext): Promise<void>;
  interludeScene?(ctx: PiExtensionContext): Promise<void>;
  exportNovel?(ctx: PiExtensionContext): Promise<void>;
  toggleHide?(ctx: PiExtensionContext): Promise<void>;
}

function getAllLore(rt: DashboardRuntime): CompiledLoreEntry[] {
  const card = rt.getCard();
  if (!card) return [];
  return [...card.loreBook.entries, ...rt.getExtraCastCards().flatMap((c) => c.loreBook.entries)];
}

async function editLongText(ctx: PiExtensionContext, title: string, initial: string): Promise<string | undefined> {
  if (typeof ctx.ui.editor === "function") {
    return ctx.ui.editor(title, initial);
  }
  return ctx.ui.input(title, initial);
}

function persistCardSafely(worldDir: string | null, card: CompiledCard, ctx: PiExtensionContext): boolean {
  if (!worldDir) {
    ctx.ui.notify("当前角色卡缺少持久化目录，修改仅在本次会话内存中生效。", "warning");
    return false;
  }
  try {
    saveUpdatedCard(worldDir, card);
    return true;
  } catch (err) {
    ctx.ui.notify(`保存角色卡失败：${(err as Error).message}`, "error");
    return false;
  }
}

function persistUiPrefsSafely(patch: Parameters<typeof saveUiPrefs>[0], ctx: PiExtensionContext): boolean {
  try {
    saveUiPrefs(patch);
    return true;
  } catch (err) {
    ctx.ui.notify(`保存界面偏好失败：${(err as Error).message}`, "error");
    return false;
  }
}

async function editPhysicalSnapshot(
  rt: DashboardRuntime,
  ctx: PiExtensionContext,
  actorId: string,
  cur: PhysicalSnapshot | undefined,
  turn: number,
): Promise<void> {
  const attireRaw = await ctx.ui.input(`${actorId} 当前着装/外貌（可选）`, cur?.attire ?? "");
  if (attireRaw === undefined) return;
  const conditionRaw = await ctx.ui.input(`${actorId} 身体状态/伤势（可选）`, cur?.condition ?? "");
  if (conditionRaw === undefined) return;
  const holdingRaw = await ctx.ui.input(`${actorId} 当前手持物（可选）`, cur?.holding ?? "");
  if (holdingRaw === undefined) return;
  const positionRaw = await ctx.ui.input(`${actorId} 当前空间站位（可选）`, cur?.position ?? "");
  if (positionRaw === undefined) return;

  const snapshot: PhysicalSnapshot = { actorId, updatedTurn: turn };
  let changed = false;
  const nextAttire = attireRaw.trim();
  if (nextAttire !== (cur?.attire ?? "")) {
    snapshot.attire = nextAttire;
    changed = true;
  }
  const nextCondition = conditionRaw.trim();
  if (nextCondition !== (cur?.condition ?? "")) {
    snapshot.condition = nextCondition;
    changed = true;
  }
  const nextHolding = holdingRaw.trim();
  if (nextHolding !== (cur?.holding ?? "")) {
    snapshot.holding = nextHolding;
    changed = true;
  }
  const nextPosition = positionRaw.trim();
  if (nextPosition !== (cur?.position ?? "")) {
    snapshot.position = nextPosition;
    changed = true;
  }

  if (!changed) {
    ctx.ui.notify(`「${actorId}」外貌与站位未作修改。`, "info");
    return;
  }

  rt.commitTx({ kind: "physical_patch", snapshot, reason: "panel" });
  ctx.ui.notify(`已更新「${actorId}」外貌与站位。`, "info");
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
    const pick = await ctx.ui.select(`🃏 动态剧情卡（共 ${list.length} 张）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const title = (await ctx.ui.input("剧情卡标题（如：雨夜敲门声）", ""))?.trim();
      if (!title) continue;
      const triggerPrompt = (await editLongText(ctx, "触发时的剧情引导内容", ""))?.trim();
      if (!triggerPrompt) continue;
      const minTurnRaw = await ctx.ui.input("最早触发回合（可选，留空不限）", "");
      if (minTurnRaw === undefined) continue;
      const locRaw = await ctx.ui.input("限定地点（逗号分隔，可选，留空不限）", "");
      if (locRaw === undefined) continue;
      const flagRaw = await ctx.ui.input("需要已开启的状态标记（逗号分隔，可选）", "");
      if (flagRaw === undefined) continue;
      const minTurnStr = minTurnRaw.trim();
      const locStr = locRaw.trim();
      const flagStr = flagRaw.trim();
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


async function openFlagsAndModulesManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const flagItems = Object.entries(s.flags).map(([k, v]) => `${v ? "● 开" : "○ 关"}  ${k}`);
    const modLabels = [
      `⚙ 模块[数值 stats]：${s.modules.stats ? "● 开" : "○ 关"}`,
      `⚙ 模块[背包 inventory]：${s.modules.inventory ? "● 开" : "○ 关"}`,
      `⚙ 模块[时钟 clocks]：${s.modules.clocks ? "● 开" : "○ 关"}`,
      `⚙ 模块[阶段 stages]：${s.modules.stages ? "● 开" : "○ 关"}`,
    ];
    const sub = await ctx.ui.select(
      `🚩 世界状态 Flags (${Object.values(s.flags).filter(Boolean).length} 激活) 与模块开关`,
      ["+ 新增状态标记 (Flag)", ...flagItems, ...modLabels, "← 返回"],
    );
    if (!sub || sub.startsWith("←")) return;
    if (sub.startsWith("+")) {
      const name = (await ctx.ui.input("Flag 名称（如：身负通缉、已获密钥）", ""))?.trim();
      if (name) {
        rt.commitTx({ kind: "flag_set", flag: name, value: true });
        ctx.ui.notify(`已启用状态标记：${name}`, "info");
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

async function openClocksManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const clocks = Object.values(s.clocks);
    const sub = await ctx.ui.select(`⏱ 进度时钟与倒计时（共 ${clocks.length} 个）`, [
      "+ 新建进度时钟",
      ...clocks.map(
        (c) =>
          `⏳ [${c.clockId}] ${c.label}  ${renderProgressBar(c.value, c.max, 6)}  ${c.value}/${c.max}${c.completed ? " (完成)" : ""}`,
      ),
      "← 返回",
    ]);
    if (!sub || sub.startsWith("←")) return;
    if (sub.startsWith("+")) {
      const label = (await ctx.ui.input("时钟名称（如：警觉度、任务倒计时）", ""))?.trim();
      if (!label) continue;
      const maxRaw = await ctx.ui.input("总格数（如 4 / 6 / 8）", "4");
      if (maxRaw === undefined) continue;
      const max = Math.max(1, Number(maxRaw.trim()) || 4);
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
  }
}

async function openBeliefsManager(rt: DashboardRuntime, ctx: PiExtensionContext, filterActor?: string): Promise<void> {
  while (true) {
    const s = rt.getState();
    const list = (filterActor
      ? s.beliefs.filter((b) => b.actorId === filterActor)
      : s.beliefs
    )
      .slice(-20)
      .reverse();
    const opts = [
      "+ 手动记录一条人物看法/信念",
      ...list.map(
        (b) =>
          `◇ [T${b.turn}] ${b.actorId} → ${b.target}${b.emotionalTone ? ` [${b.emotionalTone}]` : ""}：${b.belief.slice(0, 40)}`,
      ),
      "← 返回",
    ];
    const title = filterActor ? `◇ ${filterActor} 对他人的看法与潜台词 (${list.length} 条)` : `◇ 人物信念与潜台词（共 ${s.beliefs.length} 条）`;
    const sub = await ctx.ui.select(title, opts);
    if (!sub || sub.startsWith("←")) return;

    if (sub.startsWith("+")) {
      const actorId = filterActor || (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? "角色"))?.trim();
      if (!actorId) continue;
      const target = (await ctx.ui.input("针对对象", s.currentPersona.name))?.trim();
      if (!target) continue;
      const activatingEvent = (await ctx.ui.input("因为发生了什么事件", ""))?.trim();
      if (!activatingEvent) continue;
      const belief = (await ctx.ui.input("形成了什么看法/信念", ""))?.trim();
      if (!belief) continue;
      const insightRaw = await ctx.ui.input("内心潜台词（可选）", "");
      if (insightRaw === undefined) continue;
      const toneRaw = await ctx.ui.input("情绪基调（可选）", "");
      if (toneRaw === undefined) continue;
      const subjectiveInsight = insightRaw.trim() || undefined;
      const emotionalTone = toneRaw.trim() || undefined;
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
      ctx.ui.notify(`已记录信念：${actorId} → ${target}`, "info");
      continue;
    }

    const chosen = list[opts.indexOf(sub) - 1];
    if (!chosen) continue;
    const detail = [
      `角色：${chosen.actorId} → ${chosen.target}（第 ${chosen.turn} 轮）`,
      chosen.emotionalTone ? `情绪基调：${chosen.emotionalTone}` : null,
      `触发事件：${chosen.activatingEvent}`,
      `核心看法：${chosen.belief}`,
      chosen.subjectiveInsight ? `内心潜台词：${chosen.subjectiveInsight}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const act = await ctx.ui.select(`信念：${chosen.actorId} → ${chosen.target}`, [
      "📖 查看完整内容",
      "🗑 删除此条信念",
      "← 返回",
    ]);
    if (act?.startsWith("📖")) {
      await editLongText(ctx, `人物信念 · ${chosen.actorId}`, detail);
    } else if (act?.startsWith("🗑")) {
      const origIdx = s.beliefs.indexOf(chosen);
      rt.commitTx({ kind: "belief_remove", id: chosen.id, index: origIdx >= 0 ? origIdx : undefined });
      ctx.ui.notify("已删除该条信念。", "info");
    }
  }
}

async function openActorProfile(rt: DashboardRuntime, ctx: PiExtensionContext, actor: string): Promise<void> {
  while (true) {
    const s = rt.getState();
    const cfsmEntries = Object.entries(s.cfsmStates[actor] ?? {});
    const statEntries = Object.entries(s.stats[actor] ?? {});
    const invEntries = Object.entries(s.inventory[actor] ?? {});
    const phys = s.physicalState[actor];
    const anchor = s.voiceAnchors[actor];
    const agenda = s.npcAgendas[actor];
    const actorBeliefs = s.beliefs.filter((b) => b.actorId === actor);

    const physSummary = phys
      ? [phys.attire, phys.condition, phys.holding, phys.position].filter(Boolean).join(" · ").slice(0, 34)
      : "未记录";
    const cfsmSummary = cfsmEntries.map(([ax, st]) => `${ax}:${st.state}`).join(" · ") || "暂无";
    const statSummary = statEntries.slice(0, 3).map(([k, v]) => `${k}=${String(v)}`).join(" · ") || "暂无";

    const pick = await ctx.ui.select(`👤 人物档案：${actor}`, [
      `💭 心态与关系阶段（${cfsmSummary}）`,
      `📊 数值变量（${statSummary}）`,
      `🧥 着装、伤势、手持与站位（${physSummary}）`,
      `🎙 口癖样本与防漂移底线（${anchor ? anchor.backbone.slice(0, 26) : "自动默认"}）`,
      `◇ TA 对他人的看法与潜台词（${actorBeliefs.length} 条）`,
      `🎒 随身物品与装备（${invEntries.length} 项）`,
      `🕰 后台日程与去向（${agenda ? `${agenda.currentActivity.slice(0, 24)}${typeof agenda.etaTurns === "number" ? ` · 剩${agenda.etaTurns}轮` : ""}` : "无"}）`,
      "← 返回人物列表",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("💭")) {
      const opts = [
        "+ 新增心态/关系维度",
        ...cfsmEntries.map(([axis, st]) => `${axis}：${st.state}`),
        "← 返回",
      ];
      const sub = await ctx.ui.select(`${actor} 的心态阶段`, opts);
      if (!sub || sub.startsWith("←")) continue;
      if (sub.startsWith("+")) {
        const axis = (await ctx.ui.input("维度名称（如：信任、警觉、好感）", "信任"))?.trim();
        if (!axis) continue;
        const statesRaw = await ctx.ui.input("阶段顺序（逗号分隔）", "戒备, 试探, 信任, 亲近");
        if (statesRaw === undefined) continue;
        const statesList = statesRaw.split(/[,，→]/).map((x) => x.trim()).filter(Boolean);
        if (statesList.length >= 2) {
          rt.commitTx({ kind: "cfsm_define", actorId: actor, def: { axis, states: statesList, initial: statesList[0]! } });
          rt.refreshHud(ctx);
        }
      } else {
        const pair = cfsmEntries[opts.indexOf(sub) - 1];
        if (!pair) continue;
        const [axis, st] = pair;
        const def = s.cfsmDefs[actor]?.[axis];
        const nextVal = def?.states.length
          ? await ctx.ui.select(`切换 ${actor} · ${axis}（当前：${st.state}）`, [...def.states, "← 返回"])
          : (await ctx.ui.input(`设置 ${actor} · ${axis}`, st.state))?.trim();
        if (nextVal && !nextVal.startsWith("←") && nextVal !== st.state) {
          rt.commitTx({ kind: "cfsm_transition", actorId: actor, axis, from: st.state, to: nextVal, reason: "panel_manual", turn: s.turn });
          rt.refreshHud(ctx);
        }
      }
    } else if (pick.startsWith("📊")) {
      const opts = ["+ 新增数值", ...statEntries.map(([k, v]) => `${k} = ${String(v)}`), "← 返回"];
      const sub = await ctx.ui.select(`${actor} 的数值变量`, opts);
      if (!sub || sub.startsWith("←")) continue;
      const key = sub.startsWith("+")
        ? (await ctx.ui.input("属性名称（如：好感度、体力）", "好感度"))?.trim()
        : statEntries[opts.indexOf(sub) - 1]?.[0];
      if (!key) continue;
      const valStr = (await ctx.ui.input(`修改 ${actor} · ${key}（+5/-3 增减；=10 设值）`, String(s.stats[actor]?.[key] ?? 0)))?.trim();
      if (!valStr) continue;
      if (valStr.startsWith("=")) {
        const rhs = valStr.slice(1).trim();
        const parsed = /^-?\d+(\.\d+)?$/.test(rhs) ? Number(rhs) : rhs === "true" ? true : rhs === "false" ? false : rhs;
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: parsed, reason: "panel" });
      } else if (/^[+-]\d+(\.\d+)?$/.test(valStr)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "add", value: Number(valStr), reason: "panel" });
      } else if (/^\d+(\.\d+)?$/.test(valStr)) {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: Number(valStr), reason: "panel" });
      } else {
        rt.commitTx({ kind: "stat_patch", actorId: actor, key, op: "set", value: valStr, reason: "panel" });
      }
      rt.refreshHud(ctx);
    } else if (pick.startsWith("🧥")) {
      await editPhysicalSnapshot(rt, ctx, actor, phys, s.turn);
    } else if (pick.startsWith("🎙")) {
      const backboneRaw = await ctx.ui.input(`${actor} 核心立场与防迎合底线`, anchor?.backbone ?? "");
      if (backboneRaw === undefined || !backboneRaw.trim()) continue;
      const samplesRaw = await ctx.ui.input("典型说话原话（用 | 分隔 2-3 句，可选）", anchor?.speechSamples.join(" | ") ?? "");
      if (samplesRaw === undefined) continue;
      const tabooRaw = await ctx.ui.input("绝对禁止的 OOC 行为（可选）", anchor?.tabooBehaviors ?? "");
      if (tabooRaw === undefined) continue;
      const backbone = backboneRaw.trim();
      const taboo = tabooRaw.trim() || undefined;
      rt.commitTx({
        kind: "voice_anchor_upsert",
        anchor: { actorId: actor, backbone, speechSamples: samplesRaw.split("|").map((x) => x.trim()).filter(Boolean).slice(0, 3), tabooBehaviors: taboo },
      });
      ctx.ui.notify(`已保存「${actor}」口癖与底线。`, "info");
    } else if (pick.startsWith("◇")) {
      await openBeliefsManager(rt, ctx, actor);
    } else if (pick.startsWith("🎒")) {
      await openInventoryManager(rt, ctx);
    } else if (pick.startsWith("🕰")) {
      const goalRaw = await ctx.ui.input(`${actor} 的目的（清空确认则删除日程）`, agenda?.goal ?? "");
      if (goalRaw === undefined) continue;
      const goal = goalRaw.trim();
      if (!goal) {
        if (agenda) {
          rt.commitTx({ kind: "agenda_delete", actorId: actor });
          ctx.ui.notify(`已移除「${actor}」后台日程。`, "info");
        }
        continue;
      }
      const activityRaw = await ctx.ui.input("此刻幕后正在做什么", agenda?.currentActivity ?? goal);
      if (activityRaw === undefined) continue;
      const currentActivity = activityRaw.trim() || goal;
      const etaRaw = await ctx.ui.input("预计几轮后抵达/触发（留空不倒计时）", agenda?.etaTurns != null ? String(agenda.etaTurns) : "");
      if (etaRaw === undefined) continue;
      const etaStr = etaRaw.trim();
      const etaTurns = etaStr && /^\d+$/.test(etaStr) ? Number(etaStr) : null;
      rt.commitTx({ kind: "agenda_upsert", agenda: { actorId: actor, goal, currentActivity, etaTurns, updatedTurn: s.turn } });
      ctx.ui.notify(`已更新「${actor}」后台日程。`, "info");
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

    const pick = await ctx.ui.select("📍 场景与世界", [
      `📍 地点与在场人物（${s.location || "未设定"}${s.presentNpcs.length ? ` · ${s.presentNpcs.join("、")}` : ""}）`,
      `🕒 时间标签（${s.worldTimeLabel || "未设定"}）`,
      `🎯 场景目标（${s.sceneObjective || "未设定"}）`,
      `🃏 动态剧情卡（${s.storylets.size} 张 · 已触发 ${activeSt}）`,
      `🚩 世界状态 Flags（${Object.entries(s.flags).filter(([, v]) => Boolean(v)).map(([k]) => k).slice(0, 4).join("、") || "暂无"}）`,
      ...(s.modules.clocks || clocks.length > 0
        ? [
            `⏱ 进度时钟（${clocks.length > 0 ? clocks.slice(0, 2).map((c) => `${c.label} ${c.value}/${c.max}`).join(" · ") : "暂无，点此新建"}）`,
          ]
        : []),
      ...(healthRow ? [healthRow] : []),
      "⏳ 幕间世界推演 / 切场景",
      "🔦 群像镜头切换（指定下一轮主导 NPC）",
      "🎞 幕后插叙 / 小剧场",
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("📍")) {
      const loc = await ctx.ui.input("当前地点", s.location || "");
      if (loc === undefined) continue;
      const npcsStr = await ctx.ui.input("在场人物（逗号分隔，留空表示无人）", s.presentNpcs.join(", "));
      if (npcsStr === undefined) continue;
      const npcs = npcsStr
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
    } else if (pick.startsWith("🚩")) {
      await openFlagsAndModulesManager(rt, ctx);
    } else if (pick.startsWith("⏱")) {
      await openClocksManager(rt, ctx);
    } else if (pick.startsWith("⚠") || pick.startsWith("🟢")) {
      await rt.openXRay(ctx);
    } else if (pick.startsWith("⏳")) {
      await rt.skipScene(ctx);
      return;
    } else if (pick.startsWith("🔦")) {
      await rt.spotlightNpc?.(ctx);
      return;
    } else if (pick.startsWith("🎞")) {
      await rt.interludeScene?.(ctx);
      continue;
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
      const deltaRaw = await ctx.ui.input("数量变动（正数添加，负数扣除）", "1");
      if (deltaRaw === undefined) continue;
      const delta = Number(deltaRaw.trim());
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
        const dRaw = await ctx.ui.input("数量变动", "1");
        if (dRaw === undefined) continue;
        const d = Number(dRaw.trim());
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
      `🔒 秘密与认知盲区（秘密 ${secrets.length} · 场内盲区 ${blindSpots.length}）`,
      opts,
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const statement = (await editLongText(ctx, "输入秘密内容（仅指定角色知情，其他角色不可穿帮）", ""))?.trim();
      if (!statement) continue;
      const wStr = await ctx.ui.input("谁知道这个秘密？（逗号分隔）", rt.getCard()?.identity.name ?? s.currentPersona.name);
      if (wStr === undefined) continue;
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
      const w = await ctx.ui.input("知情角色（逗号分隔）", cur);
      if (w === undefined) continue;
      const list = w.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (list.length > 0) rt.commitTx({ kind: "fact_update", factId: fact.id, witnessIds: list });
    } else if (act.startsWith("🗑")) {
      rt.commitTx({ kind: "fact_invalidate", factId: fact.id, validUntilTurn: s.turn, reason: "manual_panel" });
    }
  }
}


async function openVoiceAnchorsManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const list = Object.values(s.voiceAnchors);
    const opts = [
      "+ 新增/更新角色口癖与底线锚点",
      ...list.map((a) => `🎙 ${a.actorId} — ${a.backbone.slice(0, 38)} (${a.speechSamples.length} 句样本)`),
      "← 返回",
    ];
    const pick = await ctx.ui.select(`🎙 角色口癖与底线锚点（共 ${list.length} 角色）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const actorId = (await ctx.ui.input("角色名称", rt.getCard()?.identity.name ?? ""))?.trim();
      if (!actorId) continue;
      const cur = s.voiceAnchors[actorId];
      const backboneRaw = await ctx.ui.input("核心立场与防迎合底线（如：极度防备外人，绝不无端软化）", cur?.backbone ?? "");
      if (backboneRaw === undefined || !backboneRaw.trim()) continue;
      const samplesRaw = await ctx.ui.input("典型说话原话样本（用 | 分隔 2-3 句，可选）", cur?.speechSamples.join(" | ") ?? "");
      if (samplesRaw === undefined) continue;
      const tabooRaw = await ctx.ui.input("绝对禁止的 OOC 行为（可选）", cur?.tabooBehaviors ?? "");
      if (tabooRaw === undefined) continue;
      const backbone = backboneRaw.trim();
      const taboo = tabooRaw.trim() || undefined;
      rt.commitTx({
        kind: "voice_anchor_upsert",
        anchor: {
          actorId,
          speechSamples: samplesRaw.split("|").map((x) => x.trim()).filter(Boolean).slice(0, 3),
          backbone,
          tabooBehaviors: taboo,
        },
      });
      ctx.ui.notify(`已保存「${actorId}」的口癖与底线锚点。`, "info");
      continue;
    }

    const chosen = list[opts.indexOf(pick) - 1];
    if (!chosen) continue;
    const act = await ctx.ui.select(`🎙 ${chosen.actorId}`, [
      "✏️ 编辑立场与口癖样本",
      "🗑 删除此锚点",
      "← 返回",
    ]);
    if (act?.startsWith("✏️")) {
      const backboneRaw = await ctx.ui.input("核心立场与防迎合底线", chosen.backbone);
      if (backboneRaw === undefined) continue;
      const samplesRaw = await ctx.ui.input("典型原话样本（用 | 分隔）", chosen.speechSamples.join(" | "));
      if (samplesRaw === undefined) continue;
      const tabooRaw = await ctx.ui.input("禁止的 OOC 行为（可选）", chosen.tabooBehaviors ?? "");
      if (tabooRaw === undefined) continue;
      const backbone = backboneRaw.trim() || chosen.backbone;
      const taboo = tabooRaw.trim() || undefined;
      rt.commitTx({
        kind: "voice_anchor_upsert",
        anchor: {
          actorId: chosen.actorId,
          speechSamples: samplesRaw.split("|").map((x) => x.trim()).filter(Boolean).slice(0, 3),
          backbone,
          tabooBehaviors: taboo,
        },
      });
      ctx.ui.notify(`已更新「${chosen.actorId}」锚点。`, "info");
    } else if (act?.startsWith("🗑")) {
      rt.commitTx({ kind: "voice_anchor_delete", actorId: chosen.actorId });
      ctx.ui.notify(`已删除「${chosen.actorId}」锚点。`, "info");
    }
  }
}

async function openPhysicalSceneManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const list = Object.values(s.physicalState);
    const opts = [
      "+ 更新某角色当前着装/伤势/手持/站位",
      `📐 空间布局与视线遮挡备注（${s.spatialNotes ? s.spatialNotes.slice(0, 32) : "未设定"}）`,
      ...list.map((p) => {
        const parts = [p.attire, p.condition, p.holding, p.position].filter(Boolean).join(" · ");
        return `🧥 ${p.actorId}：${parts.slice(0, 44) || "(空)"}`;
      }),
      "← 返回",
    ];
    const pick = await ctx.ui.select(`🧥 动态外貌、物理状态与空间站位（防瞬移与着装失忆）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("📐")) {
      const next = await ctx.ui.input("输入当前空间站位与视线/听觉遮挡说明（留空清除）", s.spatialNotes);
      if (next !== undefined) {
        rt.commitTx({ kind: "physical_patch", snapshot: { actorId: "", updatedTurn: s.turn }, spatialNotes: next, reason: "panel" });
        ctx.ui.notify("已更新空间布局备注。", "info");
      }
      continue;
    }

    let actorId = rt.getCard()?.identity.name ?? "player";
    if (pick.startsWith("+")) {
      const entered = (await ctx.ui.input("角色名（或 player）", actorId))?.trim();
      if (!entered) continue;
      actorId = entered;
    } else {
      const chosen = list[opts.indexOf(pick) - 2];
      if (!chosen) continue;
      actorId = chosen.actorId;
    }
    const cur = s.physicalState[actorId];
    await editPhysicalSnapshot(rt, ctx, actorId, cur, s.turn);
  }
}

async function openLivingWorldManager(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const agendas = Object.values(s.npcAgendas);
    const bonds = Object.values(s.pairBonds);
    const opts = [
      "+ 新增离线 NPC 后台日程 (Agenda)",
      "+ 新增 NPC↔NPC 人物关系网 (Pair Bond)",
      ...agendas.map((a) => `🕰 [日程] ${a.actorId}${typeof a.etaTurns === "number" ? ` (剩余${a.etaTurns}轮)` : ""}：${a.currentActivity.slice(0, 32)}`),
      ...bonds.map((b) => `🕸 [关系] ${b.actorA}↔${b.actorB}：${b.stance} (${b.tension})`),
      "← 返回",
    ];
    const pick = await ctx.ui.select(`🕸 鲜活世界：NPC 后台日程 (${agendas.length}) 与人物关系网 (${bonds.length})`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+ 新增离线")) {
      const actorId = (await ctx.ui.input("NPC 名称", ""))?.trim();
      if (!actorId) continue;
      const goal = (await ctx.ui.input("TA 的长期或短期目的", ""))?.trim();
      if (!goal) continue;
      const activityRaw = await ctx.ui.input("此刻幕后正在做什么", goal);
      if (activityRaw === undefined) continue;
      const currentActivity = activityRaw.trim() || goal;
      const etaRaw = await ctx.ui.input("预计几轮后抵达/产生波纹（留空不倒计时）", "");
      if (etaRaw === undefined) continue;
      const etaStr = etaRaw.trim();
      const etaTurns = etaStr && /^\d+$/.test(etaStr) ? Number(etaStr) : null;
      rt.commitTx({ kind: "agenda_upsert", agenda: { actorId, goal, currentActivity, etaTurns, updatedTurn: s.turn } });
      ctx.ui.notify(`已设置「${actorId}」后台日程。`, "info");
    } else if (pick.startsWith("+ 新增 NPC")) {
      const actorA = (await ctx.ui.input("角色 A 名称", ""))?.trim();
      if (!actorA) continue;
      const actorB = (await ctx.ui.input("角色 B 名称", ""))?.trim();
      if (!actorB || actorA === actorB) continue;
      const stance = (await ctx.ui.input("彼此关系立场（如：暗中猜忌 / 生死同盟 / 宿敌）", ""))?.trim();
      if (!stance) continue;
      const tensionRaw = await ctx.ui.input("关系张力 (-100 敌对 ~ +100 亲密)", "0");
      if (tensionRaw === undefined) continue;
      const tension = Number(tensionRaw.trim()) || 0;
      const noteRaw = await ctx.ui.input("原因或流言备注（可选）", "");
      if (noteRaw === undefined) continue;
      const note = noteRaw.trim();
      const [a, b] = [actorA, actorB].sort();
      rt.commitTx({
        kind: "pair_bond_upsert",
        bond: { id: `${a}::${b}`, actorA: a!, actorB: b!, stance, tension, note, updatedTurn: s.turn },
      });
      ctx.ui.notify(`已记录 ${a} ↔ ${b} 关系。`, "info");
    } else if (pick.startsWith("🕰")) {
      const idx = opts.indexOf(pick) - 2;
      const ag = agendas[idx];
      if (!ag) continue;
      const del = await ctx.ui.confirm(`移除「${ag.actorId}」后台日程？`, `${ag.currentActivity}（目标：${ag.goal}）`);
      if (del) rt.commitTx({ kind: "agenda_delete", actorId: ag.actorId });
    } else if (pick.startsWith("🕸")) {
      const idx = opts.indexOf(pick) - 2 - agendas.length;
      const bond = bonds[idx];
      if (!bond) continue;
      const del = await ctx.ui.confirm(`移除 ${bond.actorA}↔${bond.actorB} 关系？`, `${bond.stance} (${bond.tension}) ${bond.note}`);
      if (del) rt.commitTx({ kind: "pair_bond_delete", id: bond.id });
    }
  }
}

async function openEmbeddingConfigManager(ctx: PiExtensionContext): Promise<void> {
  const prefs = loadUiPrefs();
  const cur = prefs.embeddingConfig ?? { enabled: false, endpoint: "http://localhost:11434/v1/embeddings", model: "bge-m3", apiKey: "" };
  const pick = await ctx.ui.select(
    `🧠 语义向量混合召回 Embedding（当前：${cur.enabled ? `● 已开启 · ${cur.model}` : "○ 未开启 · 纯零依赖 BM25"}）`,
    [
      cur.enabled ? "○ 关闭语义向量（退回纯 BM25）" : "● 开启并配置 OpenAI/Ollama Embedding 端点",
      "✏️ 修改 Endpoint / 模型 / API Key",
      "← 返回",
    ],
  );
  if (!pick || pick.startsWith("←")) return;
  if (pick.startsWith("○")) {
    if (persistUiPrefsSafely({ embeddingConfig: { ...cur, enabled: false } }, ctx)) {
      ctx.ui.notify("已关闭语义向量召回。", "info");
    }
    return;
  }
  const endpoint = (await ctx.ui.input("Embedding 接口地址（支持 OpenAI / SiliconFlow / Ollama）", cur.endpoint))?.trim();
  if (!endpoint) return;
  const model = (await ctx.ui.input("Embedding 模型名（如 text-embedding-3-small / BAAI/bge-m3）", cur.model))?.trim();
  if (!model) return;
  const apiKeyRaw = await ctx.ui.input("API Key（本地 Ollama 可留空）", cur.apiKey ?? "");
  if (apiKeyRaw === undefined) return;
  const apiKey = apiKeyRaw.trim();
  if (persistUiPrefsSafely({ embeddingConfig: { enabled: true, endpoint, model, apiKey: apiKey || undefined } }, ctx)) {
    ctx.ui.notify(`✅ 已启用语义向量混合召回：${model}`, "info");
  }
}

export async function openCharactersSection(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const card = rt.getCard();
    const actorSet = new Set<string>();
    if (card?.identity.name) actorSet.add(card.identity.name);
    for (const n of s.presentNpcs) if (n.trim()) actorSet.add(n.trim());
    for (const a of Object.keys(s.cfsmStates)) actorSet.add(a);
    for (const a of Object.keys(s.stats)) actorSet.add(a);
    for (const a of Object.keys(s.physicalState)) actorSet.add(a);
    for (const a of Object.keys(s.voiceAnchors)) actorSet.add(a);
    for (const a of Object.keys(s.npcAgendas)) actorSet.add(a);
    for (const a of Object.keys(s.inventory)) actorSet.add(a);
    for (const b of s.beliefs) if (b.actorId.trim()) actorSet.add(b.actorId.trim());
    actorSet.add("player");

    const actors = Array.from(actorSet);
    const presentSet = new Set(s.presentNpcs);
    const actorRows = actors.map((a) => {
      const tag = a === "player" ? "玩家" : presentSet.has(a) ? "在场" : "场外";
      const cfsm = Object.entries(s.cfsmStates[a] ?? {}).map(([k, v]) => `${k}:${v.state}`).slice(0, 1).join("");
      const stat = Object.entries(s.stats[a] ?? {}).map(([k, v]) => `${k}=${String(v)}`).slice(0, 1).join("");
      const ag = s.npcAgendas[a] ? "·有日程" : "";
      const summary = [cfsm, stat].filter(Boolean).join(" · ") || (s.physicalState[a]?.attire ? s.physicalState[a]!.attire!.slice(0, 14) : "点此查看档案");
      return `👤 [${tag}] ${a} — ${summary}${ag}`;
    });

    const pick = await ctx.ui.select("👥 人物与关系", [
      ...actorRows,
      `🕸 人物关系网（NPC↔NPC ${Object.keys(s.pairBonds).length} 条 · 后台日程 ${Object.keys(s.npcAgendas).length} 个）`,
      `🧑 切换玩家马甲（当前：${s.currentPersona.name}）`,
      `🎭 同场共演角色卡管理（当前：${s.activeCharacters.length} 张卡）`,
      "+ 新增其他人物档案",
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🕸")) {
      await openLivingWorldManager(rt, ctx);
    } else if (pick.startsWith("🧑")) {
      await rt.switchPersona(ctx);
    } else if (pick.startsWith("🎭")) {
      await rt.manageCast(ctx);
    } else if (pick.startsWith("+")) {
      const name = (await ctx.ui.input("输入新人物名称", ""))?.trim();
      if (name) await openActorProfile(rt, ctx, name);
    } else {
      const idx = actorRows.indexOf(pick);
      const chosen = actors[idx];
      if (chosen) await openActorProfile(rt, ctx, chosen);
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
    const pick = await ctx.ui.select(`📚 记忆书章节（共 ${books.length} 章）`, opts);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+")) {
      const title = (await ctx.ui.input("章节标题", `第 ${books.length + 1} 章`))?.trim();
      if (!title) continue;
      const summary = (await editLongText(ctx, `编写章节「${title}」摘要`, ""))?.trim();
      if (!summary) continue;
      const kwStr = await ctx.ui.input("触发关键词/人物实体（逗号分隔）", rt.getCard()?.identity.name ?? "");
      if (kwStr === undefined) continue;
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
      const nextTitleRaw = await ctx.ui.input("章节标题", chosen.title);
      if (nextTitleRaw === undefined) continue;
      const nextKwRaw = await ctx.ui.input("触发关键词（逗号分隔）", chosen.keywords.join(", "));
      if (nextKwRaw === undefined) continue;
      const nextTitle = nextTitleRaw.trim() || chosen.title;
      const kws = nextKwRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
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
      `🗂 世界书管理（${getAllLore(rt).length} 条）`,
      `📚 记忆书归档章节（${s.memoryBooks.size} 章）`,
      `🔒 秘密与认知盲区（秘密 ${secretCount} · 盲区 ${blindSpots.length}）`,
      `◇ 人物信念与潜台词（${s.beliefs.length} 条${s.beliefs.length > 0 ? ` · ${s.beliefs[s.beliefs.length - 1]!.actorId}→${s.beliefs[s.beliefs.length - 1]!.belief.slice(0, 16)}` : ""}）`,
      "📜 查看前情提要",
      "📦 总结并隐藏旧楼层 → 写入记忆书",
      "🙈 隐藏或恢复对话楼层",
      "📖 导出纯净 Markdown 小说",
      "+ 记录一条重要剧情/秘密",
      "+ 记录一条未完约定 / 伏笔",
      ...activeFacts.slice(-14).reverse().map((f) => {
        const vis = f.witnessIds === "public" ? "" : ` [仅:${f.witnessIds.join(",")}]`;
        return `▪ [T${f.validFromTurn}]${vis} ${f.statement.slice(0, 48)} (${f.id})`;
      }),
      ...openHooks.map((h) => `◇ [伏笔:${h.id}] ${h.summary.slice(0, 50)}`),
      "← 返回主面板",
    ];

    const pick = await ctx.ui.select(
      `📖 记忆、伏笔与世界书（事实 ${activeFacts.length} · 伏笔 ${openHooks.length}）`,
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
    if (pick.startsWith("◇ 人物信念")) {
      await openBeliefsManager(rt, ctx);
      continue;
    }
    if (pick.startsWith("🗂 世界书")) {
      await openLoreManager(rt, ctx);
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
    if (pick.startsWith("🙈")) {
      await rt.toggleHide?.(ctx);
      continue;
    }
    if (pick.startsWith("📖")) {
      await rt.exportNovel?.(ctx);
      continue;
    }
    if (pick.startsWith("+ 记录一条重要剧情")) {
      const statement = (await editLongText(ctx, "输入重要事件或秘密内容", ""))?.trim();
      if (!statement) continue;
      const entitiesStr = await ctx.ui.input("关联人物/地点（逗号分隔，可选）", "");
      if (entitiesStr === undefined) continue;
      const entities = entitiesStr.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const visPick = await ctx.ui.select("谁知道这件事？", [
        "🌐 公开事件（大家都知道）",
        "🔒 私密事件（仅指定角色知情，防止其他角色穿帮）",
      ]);
      if (!visPick) continue;
      let witnessIds: string[] | "public" = "public";
      if (visPick.startsWith("🔒")) {
        const wStr = await ctx.ui.input("知情角色名（逗号分隔）", s.currentPersona.name);
        if (wStr === undefined) continue;
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
      const triggerHintRaw = await ctx.ui.input("何时提醒/相关线索（可选）", "");
      if (triggerHintRaw === undefined) continue;
      const triggerHint = triggerHintRaw.trim();
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
          const w = await ctx.ui.input("知情角色名（逗号分隔）", cur);
          if (w === undefined) continue;
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
      "✨ 从最近剧情 AI 生成新条目",
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
      `📚 世界书管理（${filtered.length}/${allLore.length} · ${page + 1}/${totalPages} 页）`,
      [...navTop, ...itemOptions, ...navBottom],
    );
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("+ 手动新建")) {
      if (!primaryCard) continue;
      const title = (await ctx.ui.input("世界书条目标题", ""))?.trim();
      if (!title) continue;
      const keysRaw = await ctx.ui.input("触发词（逗号分隔）", title);
      if (keysRaw === undefined) continue;
      const keys = keysRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      const content = (await editLongText(ctx, `编写「${title}」正文`, ""))?.trim();
      if (!content) continue;
      const isConst = await ctx.ui.confirm("设为常驻设定？", "选择「确认」则每轮常驻生效；选择「取消」则按关键词动态召回。");
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
        if (persistCardSafely(s.worldDir, primaryCard, ctx)) {
          rt.reloadRuntime(ctx);
        }
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
              entry.constant ? "🔄 改为动态按词召回" : "📌 改为常驻设定",
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
        if (persistCardSafely(s.worldDir, primaryCard, ctx)) {
          rt.reloadRuntime(ctx);
        }
        ctx.ui.notify(`已保存「${entry.title}」正文修改。`, "info");
      }
    } else if (action.startsWith("🏷") && isPrimaryEntry && primaryCard) {
      const nextTitleRaw = await ctx.ui.input("条目标题", entry.title);
      if (nextTitleRaw === undefined) continue;
      const nextKeysRaw = await ctx.ui.input("触发词（逗号分隔）", entry.keys.join(", "));
      if (nextKeysRaw === undefined) continue;
      entry.title = nextTitleRaw.trim() || entry.title;
      entry.keys = nextKeysRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (persistCardSafely(s.worldDir, primaryCard, ctx)) {
        rt.reloadRuntime(ctx);
      }
      ctx.ui.notify("已更新标题与触发词。", "info");
    } else if ((action.startsWith("🔄") || action.startsWith("📌")) && isPrimaryEntry && primaryCard) {
      entry.constant = !entry.constant;
      if (persistCardSafely(s.worldDir, primaryCard, ctx)) {
        rt.reloadRuntime(ctx);
      }
      ctx.ui.notify(`已设为：${entry.constant ? "常驻设定" : "动态召回"}`, "info");
    } else if (action.startsWith("🗑") && isPrimaryEntry && primaryCard) {
      const ok = await ctx.ui.confirm("删除世界书条目", `永久删除「${entry.title}」？`);
      if (ok) {
        primaryCard.loreBook.entries = primaryCard.loreBook.entries.filter((e) => e.id !== entry.id);
        if (persistCardSafely(s.worldDir, primaryCard, ctx)) {
          rt.reloadRuntime(ctx);
        }
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
      `🎚 叙事节奏（${s.pacingMode}）`,
      `✒️ 回复篇幅与视角（${s.responseLength} · ${s.narrativePov}）`,
      `🚫 反套话禁词表（${s.bannedPhrases.length} 词）`,
      "✂️ 局部定向改写上一条回复",
      `💭 角色内心独白：${s.innerMonologue ? "● 已开启" : "○ 已关闭"}`,
      "⚡ 快捷回复 / 动作宏",
      `✨ AI 深度建档（${rt.getCard()?.worldProfile?.source === "llm-analyzed" ? "已建档" : "启发式"}）`,
      "+ 新增导演指令",
      ...s.notes.map(
        (n, i) => `▪ #${i + 1} ${n.text.slice(0, 52)}${n.remainingTurns !== null ? ` (${n.remainingTurns}轮)` : " (常驻)"}`,
      ),
      ...(s.notes.length > 0 ? ["🧹 清空全部导演指令"] : []),
      "⚙ 高级设置、状态透视与资产库",
      "← 返回主面板",
    ];
    const pick = await ctx.ui.select("🎬 导演台与设置", options);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("✒️")) {
      await rt.styleControl?.(ctx);
      continue;
    } else if (pick.startsWith("🚫")) {
      await rt.banPhrases?.(ctx);
      continue;
    } else if (pick.startsWith("✂️")) {
      await rt.rewriteLast?.(ctx);
      return;
    } else if (pick.startsWith("🎚")) {
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
      const text = (await editLongText(ctx, "编写导演指令", ""))?.trim();
      if (!text) continue;
      const ttlRaw = await ctx.ui.input("生效轮数（留空=常驻，输入数字如 3=生效 3 轮）", "");
      if (ttlRaw === undefined) continue;
      const ttlStr = ttlRaw.trim();
      const ttl = ttlStr && /^\d+$/.test(ttlStr) ? Math.max(1, Number(ttlStr)) : null;
      rt.commitTx({
        kind: "note_set",
        note: { id: `note_${Date.now().toString(36)}`, text, remainingTurns: ttl },
      });
      rt.refreshHud(ctx);
      ctx.ui.notify("导演指令已生效。", "info");
    } else if (pick.startsWith("⚙")) {
      await openRpgToolsSection(rt, ctx);
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
      ? `总计 ~${xray.zone1Tokens + xray.zone2Tokens + xray.zone3Tokens}t · 召回 ${xray.recalled.length} 条`
      : "尚未捕获快照（发送一轮对话后生成）";

    const pick = await ctx.ui.select("🔎 上下文透视与审计撤销", [
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

    const pick = await ctx.ui.select("⚙ 高级设置与资产库", [
      "🔎 上下文透视与审计撤销",
      "🌍 会话总览与导入审计",
      `🎒 背包物品（${invCount} 项）`,
      `⏳ 进度时钟（${clockCount} 个）`,
      "🎲 快捷掷骰检定",
      `🏁 剧情阶段 / 章节（${s.era || "未启用"}）`,
      `⚙ 世界状态 Flags（${flagCount}）与模块开关`,
      `🤖 后台结算模型（${s.sidecarModel || "跟随主模型"}）`,
      `🧠 语义向量召回（${loadUiPrefs().embeddingConfig?.enabled ? "● 开" : "○ 关"}）`,
      `📏 动态世界书预算（${s.loreTokenBudget} tokens）`,
      `🎛 应用预设采样参数：${s.applyPresetSampling ? "● 开" : "○ 关"}`,
      "🗂 资产库管理（角色卡 / 预设 / 马甲）",
      "← 返回主面板",
    ]);
    if (!pick || pick.startsWith("←")) return;

    if (pick.startsWith("🔎")) {
      await openXRayAndAuditSection(rt, ctx);
    } else if (pick.startsWith("🌍")) {
      await openOverviewAndAudit(rt, ctx);
    } else if (pick.startsWith("🎒")) {
      await openInventoryManager(rt, ctx);
    } else if (pick.startsWith("⏳")) {
      await openClocksManager(rt, ctx);
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
      await openFlagsAndModulesManager(rt, ctx);
    } else if (pick.startsWith("🤖")) {
      await rt.pickSidecarModel(ctx);
    } else if (pick.startsWith("🧠")) {
      await openEmbeddingConfigManager(ctx);
    } else if (pick.startsWith("📏")) {
      const budgetRaw = await ctx.ui.input("动态世界书 Token 预算（建议 800 ~ 4000）", String(s.loreTokenBudget));
      if (budgetRaw === undefined) continue;
      const val = Number(budgetRaw.trim());
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

  const pick = await ctx.ui.select("🌍 会话总览与导入审计", [
    ...lines,
    "📖 导出纯净 Markdown 小说",
    `⌨️ 查看快捷键列表（${RP_SHORTCUT_LIST.length} 项）`,
    "← 返回主面板",
  ]);
  if (pick?.startsWith("📖")) {
    await rt.exportNovel?.(ctx);
    return;
  }
  if (pick?.startsWith("⌨️")) {
    await ctx.ui.select(
      "RP 快捷键速查",
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
      const valRaw = await ctx.ui.input("动态世界书 Token 预算（200-8000）", String(cur));
      if (valRaw === undefined) return true;
      const val = Number(valRaw.trim());
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


async function openLedgerOverview(rt: DashboardRuntime, ctx: PiExtensionContext): Promise<void> {
  while (true) {
    const s = rt.getState();
    const activeFacts = getActiveFacts(s);
    const openHooks = Array.from(s.foresights.values()).filter((h) => h.status === "open");
    const activeFlags = Object.entries(s.flags).filter(([, v]) => Boolean(v)).map(([k]) => k);
    const recentWrites = s.auditLog.slice(-6).reverse();

    const opts: string[] = [
      ...recentWrites.map((r) => `📝 [T${r.turn}] ${r.summary}`),
      ...(activeFlags.length > 0 ? [`🚩 当前激活 Flags (${activeFlags.length})：${activeFlags.slice(0, 5).join(" · ")}`] : []),
      `▪ 长期事实 (${activeFacts.length} 条) → 点此查看/编辑`,
      `◇ 人物信念 (${s.beliefs.length} 条) → 点此查看/编辑`,
      `🔖 未回收伏笔 (${openHooks.length} 条) → 点此查看/编辑`,
      ...(Object.keys(s.physicalState).length > 0 || s.spatialNotes
        ? [`🧥 外貌与物理状态 (${Object.keys(s.physicalState).length} 角色) → 点此编辑`]
        : []),
      ...(Object.keys(s.npcAgendas).length > 0 || Object.keys(s.pairBonds).length > 0
        ? [`🕸 后台日程 (${Object.keys(s.npcAgendas).length}) / NPC 关系 (${Object.keys(s.pairBonds).length}) → 点此管理`]
        : []),
      "← 返回主面板",
    ];

    const pick = await ctx.ui.select("📋 本局动态一览", opts);
    if (!pick || pick.startsWith("←")) return;
    if (pick.startsWith("📝")) {
      await rt.undoLast(ctx, false);
    } else if (pick.startsWith("🚩")) {
      await openFlagsAndModulesManager(rt, ctx);
    } else if (pick.startsWith("▪") || pick.startsWith("🔖")) {
      await openMemoryBookSection(rt, ctx);
    } else if (pick.startsWith("◇")) {
      await openBeliefsManager(rt, ctx);
    } else if (pick.startsWith("🧥")) {
      await openPhysicalSceneManager(rt, ctx);
    } else if (pick.startsWith("🕸")) {
      await openLivingWorldManager(rt, ctx);
    }
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
    ctx.ui.notify("当前会话未开启 RP 模式，请先加载一张角色卡。", "info");
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
    const activeFactsList = getActiveFacts(s);
    const title = `◆ ${[card?.identity.name ?? s.cardSlug ?? "RP", s.era, s.worldTimeLabel, `T${s.turn}`].filter(Boolean).join(" · ")}`;
    const activeFlagsCount = Object.values(s.flags).filter(Boolean).length;
    const lastUndoable = s.auditLog.filter((r) => Boolean(r.undoTx)).at(-1);
    const choice = await ctx.ui.select(title, [
      `1. 📋 本局动态一览（写入 ${s.auditLog.length} · 事实 ${activeFactsList.length} · 伏笔 ${openHooks}${activeFlagsCount ? ` · Flags ${activeFlagsCount}` : ""}）`,
      `2. 📍 场景与世界（${s.location || "未设定"} · 时钟 ${Object.keys(s.clocks).length}）`,
      `3. 👥 人物与关系（档案 · 关系网 · 马甲：${s.currentPersona.name}）`,
      `4. 📖 记忆、伏笔与世界书（事实 ${activeFactsList.length} · 世界书 ${getAllLore(rt).length} · 导出）`,
      `5. 🎬 导演台与设置（节奏:${s.pacingMode} · 风格 · 高级设置）`,
      ...(lastUndoable ? [`↩ 撤销上次状态变更（${lastUndoable.summary.slice(0, 26)}）`] : []),
      "6. 🚪 彻底退出本会话 RP 模式",
      "✕ 关闭面板",
    ]);

    if (!choice || choice.startsWith("✕")) return;
    if (choice.startsWith("↩")) {
      await rt.undoLast(ctx, true);
      continue;
    }
    if (choice.startsWith("1.")) await openLedgerOverview(rt, ctx);
    else if (choice.startsWith("2.")) await openSceneSection(rt, ctx);
    else if (choice.startsWith("3.")) await openCharactersSection(rt, ctx);
    else if (choice.startsWith("4.")) await openMemoryBookSection(rt, ctx);
    else if (choice.startsWith("5.")) await openNotesAndPacing(rt, ctx);
    else if (choice.startsWith("6.")) {
      await rt.exitRp(ctx, true);
      return;
    }
  }
}
