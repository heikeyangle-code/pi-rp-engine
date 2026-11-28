import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import rpEngineExtension from "../src/index.js";
import { extractJsonObject, stripThinkingBlocks, listRegistryModels, resolveSidecarModel } from "../src/engine/llm-helper.js";
import { extractPlainTextStats, inferHeuristicWorldProfile } from "../src/parser/world-profile.js";
import { normalizeCfsmAxisDef, validateCfsmTransition, validateInventoryPatch } from "../src/engine/cfsm.js";
import { applyRpTx, createInitialRpState, RP_ENTRY_TYPE } from "../src/engine/state-replay.js";
import { buildZone3TransientTail, computeZone1Hash, evaluateActiveStorylets } from "../src/context/zone-builder.js";
import { recallMemoryBooks } from "../src/memory/graph-ppr.js";
import { buildSemanticMemSceneCompaction } from "../src/memory/compaction.js";
import { runSidecarLightSettlement } from "../src/engine/settlement.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { compileLoreBook } from "../src/parser/lore-compiler.js";
import {
  deleteCompiledCard,
  deleteCompiledPreset,
  deletePersona,
  getProjectRpDir,
  loadCompiledCard,
  loadCompiledPreset,
  loadPersonas,
  mergeExternalLoreBook,
  saveCompiledCard,
  saveCompiledPreset,
  savePersona,
  saveUpdatedCard,
} from "../src/storage/workspace-store.js";
import { createRpOverlayController, type OverlayAction } from "../src/ui/tui-overlay.js";
import { displayWidth, formatThoughtBlocks } from "../src/ui/renderers.js";
import { renderRpHud } from "../src/ui/hud.js";
import { actionReroll, actionSummarizeOldFloors } from "../src/ui/actions.js";
import type {
  PiContentBlock,
  PiExtensionAPI,
  PiExtensionContext,
  PiMessage,
  PiSessionEntry,
  PiToolDefinition,
  RpTxEntry,
} from "../src/types.js";

function createV3Harness(cwd: string, options?: { mode?: "tui" | "rpc"; isIdle?: boolean }) {
  const entries: PiSessionEntry[] = [];
  const handlers = new Map<string, Array<(event: any, ctx: PiExtensionContext) => any>>();
  const tools = new Map<string, PiToolDefinition>();
  const markdownTransformers: Array<(md: string, ctx?: { messageType?: string; isStreaming?: boolean }) => string> = [];
  const sentMessages: Array<{ msg: any; opts: any }> = [];
  const navigatedIds: string[] = [];
  const userMessages: Array<{ content: string | PiContentBlock[]; opts: any }> = [];
  const widgets = new Map<string, any>();
  let llmCallCount = 0;
  let mockLlmResponse = JSON.stringify({ location: "铁匠铺" });
  let mockLlmShouldFail = false;

  const ctx: PiExtensionContext = {
    cwd,
    mode: options?.mode ?? "tui",
    isIdle: () => options?.isIdle ?? true,
    model: { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
        { provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
      ],
      find: (provider: string, id: string) => {
        if (provider === "google" && id === "gemini-2.5-flash") {
          return { provider, id, name: "Gemini 2.5 Flash" };
        }
        return undefined;
      },
      streamSimple() {
        llmCallCount++;
        if (mockLlmShouldFail) {
          return {
            async result() {
              throw new Error("Simulated offline failure");
            },
          };
        }
        return {
          async result() {
            return { content: [{ type: "text", text: mockLlmResponse }] };
          },
        };
      },
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => entries[entries.length - 1]?.id ?? null,
    },
    navigateTree: async (targetId: string) => {
      navigatedIds.push(targetId);
      return { cancelled: false };
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget(key: string, content: any) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
      setWorkingMessage() {},
      async select(_title: string, opts: string[]) {
        return opts[0];
      },
      async confirm() {
        return true;
      },
      async input(_title: string, placeholder?: string) {
        return placeholder ?? "";
      },
      async editor(_title: string, text?: string) {
        return text;
      },
      setEditorText() {},
    },
  };

  const pi: PiExtensionAPI = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    registerMarkdownTransformer(fn) {
      markdownTransformers.push(fn);
    },
    appendEntry(customType, data) {
      entries.push({
        id: `e_${entries.length + 1}`,
        type: "custom",
        customType,
        data,
      });
    },
    sendMessage(message, opts) {
      sentMessages.push({ msg: message, opts });
    },
    sendUserMessage(content, opts) {
      userMessages.push({ content, opts });
    },
    getActiveTools: () => ["read", "edit", "bash"],
    setActiveTools() {},
  };

  return {
    pi,
    ctx,
    entries,
    tools,
    markdownTransformers,
    sentMessages,
    navigatedIds,
    userMessages,
    widgets,
    getLlmCalls: () => llmCallCount,
    setMockLlmResponse: (text: string) => {
      mockLlmResponse = text;
    },
    setMockLlmShouldFail: (fail: boolean) => {
      mockLlmShouldFail = fail;
    },
    async emit(event: string, payload?: any) {
      const list = handlers.get(event) ?? [];
      let last: any = undefined;
      for (const h of list) {
        const res = await h(payload ?? {}, ctx);
        if (res !== undefined) last = res;
      }
      return last;
    },
  };
}

test("1. Thinking-tag stripping & balanced-brace JSON extraction survive CoT braces", () => {
  const raw = `<think>I should return {"fake": true} first, maybe {broken} too.</think>
Here is the structured output:
\`\`\`json
{"location": "青石镇", "stats": [{"actorId": "player", "key": "好感", "op": "add", "value": 5}]}
\`\`\`
Note: ignore {trailing prose}.`;

  assert.equal(stripThinkingBlocks(raw).includes("fake"), false);
  const parsed = extractJsonObject<{ location: string; stats: unknown[] }>(raw);
  assert.ok(parsed);
  assert.equal(parsed!.location, "青石镇");
  assert.equal(parsed!.stats.length, 1);

  const unfenced = `Reasoning {brief} done -> {"ok": true, "nested": {"k": "v"}} end`;
  const parsed2 = extractJsonObject<{ ok: boolean; nested: { k: string } }>(unfenced);
  assert.equal(parsed2?.ok, true);
  assert.equal(parsed2?.nested.k, "v");
});

test("2. Negative initial stats preserve negative bounds & single-char rich worldbook is not misclassified as ensemble", () => {
  const stats = extractPlainTextStats("好感度：-20\n声望：-15/100\n体力：80/100\n金币：50");
  const byKey = new Map(stats.map((s) => [s.key, s]));
  assert.equal(byKey.get("好感度")?.initialValue, -20);
  assert.ok((byKey.get("好感度")?.min ?? 0) <= -100, "Bipolar negative stat must NOT clamp min to 0");
  assert.equal(byKey.get("声望")?.initialValue, -15);
  assert.equal(byKey.get("声望")?.min, -100);
  assert.equal(byKey.get("体力")?.min, 0);

  // Single character with 25 lorebook entries should be epic-saga / companion, NOT ensemble
  const book = compileLoreBook({
    entries: Array.from({ length: 25 }, (_, i) => ({
      id: `l_${i}`,
      comment: `设定${i}`,
      keys: [`词${i}`],
      content: "古老帝国的历史",
      enabled: true,
    })),
  });
  const profile = inferHeuristicWorldProfile({
    description: "一位独行的女剑士，在漫长纪元中寻找失落的剑鞘。",
    personality: "冷静寡言",
    scenario: "边境驿站",
    firstMes: "她擦拭着长剑。",
    loreEntries: book.entries,
    salvagedVariables: [],
  });
  assert.notEqual(profile.archetype, "ensemble");
  assert.equal(profile.archetype, "epic-saga");
});

test("3. CFSM auto-generates adjacent transitions when omitted & rp_state_patch blocks negative inventory", async () => {
  const normalized = normalizeCfsmAxisDef({
    axis: "态度",
    states: ["敌对", "戒备", "友善", "挚友"],
    initial: "敌对",
  });
  assert.deepEqual(normalized.transitions?.["敌对"], ["戒备"]);
  assert.deepEqual(normalized.transitions?.["戒备"], ["敌对", "友善"]);

  const state = createInitialRpState();
  applyRpTx(state, { kind: "cfsm_define", actorId: "艾琳", def: normalized });
  assert.equal(validateCfsmTransition(state, "艾琳", "态度", "挚友").ok, false, "Must block jumping from 敌对 straight to 挚友");
  assert.equal(validateCfsmTransition(state, "艾琳", "态度", "戒备").ok, true, "Adjacent step must succeed");

  applyRpTx(state, { kind: "inventory_patch", actorId: "player", item: "药水", delta: 1 });
  assert.equal(validateInventoryPatch(state, "player", "药水", -2).ok, false);
  assert.equal(validateInventoryPatch(state, "player", "药水", -1).ok, true);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-tool-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "艾琳", description: "冒险者" } };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createV3Harness(tmpDir);
    rpEngineExtension(h.pi);
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "bind",
      cardId: card.id,
      cardSlug: card.slug,
      cardSource: "project",
      worldDir: baseDir,
      greetingIndex: 0,
      activeCharacters: [card.slug],
    } satisfies RpTxEntry);
    await h.emit("session_start");

    const patchTool = h.tools.get("rp_state_patch")!;
    const badRes = await patchTool.execute(
      "tc1",
      { inventory: [{ actorId: "player", item: "不存在的剑", delta: -1 }] },
      undefined,
      undefined,
      h.ctx,
    );
    assert.equal(badRes.isError, true);
    const firstBlock = badRes.content[0];
    assert.ok(firstBlock && firstBlock.type === "text" && typeof firstBlock.text === "string" && firstBlock.text.includes("Insufficient"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("4. OOC turns never trigger sidecar-light settlement, and abort/agent_end resets OOC flag cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-ooc-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "苏叶", description: "茶馆老板", first_mes: "请进。" } };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createV3Harness(tmpDir);
    rpEngineExtension(h.pi);
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "bind",
      cardId: card.id,
      cardSlug: card.slug,
      cardSource: "project",
      worldDir: baseDir,
      greetingIndex: 0,
      activeCharacters: [card.slug],
    } satisfies RpTxEntry);
    h.pi.appendEntry(RP_ENTRY_TYPE, { kind: "config_patch", settlementMode: "sidecar-light" } satisfies RpTxEntry);
    await h.emit("session_start");

    // Turn 1: OOC prompt ((...)) -> must NOT run sidecar LLM!
    await h.emit("before_agent_start", { prompt: "((请问主角现在几岁？))", systemPrompt: "" });
    h.entries.push({ id: "u1", type: "message", message: { role: "user", content: "((请问主角现在几岁？))" } });
    h.entries.push({ id: "a1", type: "message", message: { role: "assistant", content: "（场外回答：24岁）" } });
    await h.emit("turn_end", { message: { role: "assistant", content: "（场外回答：24岁）" } });
    await h.emit("agent_settled");
    await h.emit("agent_end");
    assert.equal(h.getLlmCalls(), 0, "OOC turn MUST NOT invoke sidecar-light LLM");

    // Turn 2: normal IC turn -> MUST invoke sidecar-light LLM!
    await h.emit("before_agent_start", { prompt: "我推开茶馆后门走向铁匠铺。", systemPrompt: "" });
    h.entries.push({ id: "u2", type: "message", message: { role: "user", content: "我推开茶馆后门走向铁匠铺。" } });
    h.entries.push({ id: "a2", type: "message", message: { role: "assistant", content: "你来到热浪扑面的铁匠铺。" } });
    await h.emit("turn_end", { message: { role: "assistant", content: "你来到热浪扑面的铁匠铺。" } });
    await h.emit("agent_settled");
    await h.emit("agent_end");
    assert.equal(h.getLlmCalls(), 1, "Normal IC turn after OOC must resume sidecar-light settlement");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("5. Official Pi hooks: session_switch, {{lastCharMessage}} on rp:greeting, markdown transformer isStreaming guard, before_provider_request", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-hooks-"));
  try {
    const rawCard = {
      spec: "chara_card_v2",
      data: {
        name: "汐音",
        description: "灯塔守望者",
        first_mes: "海雾漫过灯塔石阶。",
        post_history_instructions: "衔接上一句：{{lastCharMessage}}",
      },
    };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });
    saveCompiledPreset(baseDir, {
      id: "warm_story",
      name: "Warm Story",
      zone1Prompts: [],
      zone3Prompts: [],
      utilityPrompts: {},
      sampling: { temperature: 0.92, topP: 0.95, maxTokens: 1200 },
      strippedCount: 0,
      warnings: [],
    });

    const h = createV3Harness(tmpDir);
    rpEngineExtension(h.pi);

    // Activate via session_switch (not just session_start)
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "bind",
      cardId: card.id,
      cardSlug: card.slug,
      cardSource: "project",
      worldDir: baseDir,
      greetingIndex: 0,
      activeCharacters: [card.slug],
    } satisfies RpTxEntry);
    h.pi.appendEntry(RP_ENTRY_TYPE, { kind: "preset_set", presetId: "warm_story" } satisfies RpTxEntry);
    await h.emit("session_switch");

    // Context hook recognizes rp:greeting for {{lastCharMessage}}
    const ctxRes = await h.emit("context", {
      messages: [
        { role: "custom", customType: "rp:greeting", content: "海雾漫过灯塔石阶。" },
        { role: "user", content: "我提着煤油灯走上台阶。" },
      ],
    });
    const lastUserContent = String(ctxRes.messages[ctxRes.messages.length - 1].content);
    assert.ok(lastUserContent.includes("衔接上一句：海雾漫过灯塔石阶。"));

    // before_provider_request: OFF by default -> does not mutate payload
    const untouched = await h.emit("before_provider_request", { payload: { model: "gpt-4.1", temperature: 0.5 } });
    assert.equal(untouched, undefined);

    // Enable applyPresetSampling -> mutates temperature/top_p/max_tokens cleanly
    h.pi.appendEntry(RP_ENTRY_TYPE, { kind: "config_patch", applyPresetSampling: true } satisfies RpTxEntry);
    await h.emit("session_tree");
    const patched = await h.emit("before_provider_request", { payload: { model: "gpt-4.1", temperature: 0.5 } });
    assert.equal(patched.temperature, 0.92);
    assert.equal(patched.top_p, 0.95);
    assert.equal(patched.max_tokens, 1200);

    // Markdown transformer skips streaming & thinking, formats <thought> when complete
    assert.equal(h.markdownTransformers.length, 1);
    const tx = h.markdownTransformers[0]!;
    const rawMd = "<thought>他竟然真的来了。</thought>\n她把门拉开半寸。";
    assert.equal(tx(rawMd, { messageType: "assistant-text", isStreaming: true }), rawMd);
    assert.equal(tx(rawMd, { messageType: "assistant-thinking", isStreaming: false }), rawMd);
    const rendered = tx(rawMd, { messageType: "assistant-text", isStreaming: false });
    assert.ok(rendered.includes("> 💭 *他竟然真的来了。*"));
    assert.equal(formatThoughtBlocks(rawMd), rendered);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("6. Async session_before_compact runs LLM semantic MemScene compaction & falls back safely on error", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-compact-"));
  try {
    const h = createV3Harness(tmpDir);
    const state = createInitialRpState();
    state.active = true;
    state.location = "旧港仓库";
    state.sceneObjective = "找出账本下落";
    state.sidecarModel = "google/gemini-2.5-flash";

    const msgs: PiMessage[] = [
      { role: "user", content: "我撬开了仓库二楼的木箱。" },
      { role: "assistant", content: "你在箱底摸到半本烧焦的账本，码头巡逻队的哨声同时响起。" },
    ];

    h.setMockLlmResponse("- 玩家潜入旧港仓库二楼撬开木箱，寻获半本烧焦账本。\n- 巡逻队哨声响起，撤离窗口极短。");
    const semantic = await buildSemanticMemSceneCompaction(h.ctx, state, { messagesToSummarize: msgs });
    assert.ok(semantic.includes("寻获半本烧焦账本"));
    assert.ok(semantic.includes("当前场景目标：找出账本下落"));

    h.setMockLlmShouldFail(true);
    const fallback = await buildSemanticMemSceneCompaction(h.ctx, state, { messagesToSummarize: msgs });
    assert.ok(fallback.includes("MemScene 幕间记忆归并"));
    assert.ok(fallback.includes("撬开了仓库二楼的木箱"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("7. Memory Books, Storylets, Scene Objective, Inner Monologue & RoleMemo DualMem flow into Zone 3", () => {
  const card = compileCharacterCard(
    { spec: "chara_card_v2", data: { name: "白露", description: "药师", first_mes: "药香弥漫。" } },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  state.turn = 8;
  state.presentNpcs = ["白露"];
  applyRpTx(state, { kind: "scene_objective_set", objective: "在暴雨前采到雪莲" });
  applyRpTx(state, { kind: "config_patch", innerMonologue: true });
  applyRpTx(state, { kind: "flag_set", flag: "met_herbalist", value: true });
  applyRpTx(state, {
    kind: "storylet_upsert",
    storylet: {
      id: "st_storm",
      title: "山道塌方危机",
      triggerPrompt: "暴雨导致北坡山道塌方，必须借道矿洞。",
      gate: { requiredFlags: ["met_herbalist"] },
      status: "armed",
      createdTurn: 8,
    },
  });
  applyRpTx(state, {
    kind: "memory_book_upsert",
    entry: {
      id: "mb_1",
      title: "第一卷·药庐初遇",
      summary: "玩家在雪夜救下受伤的白露，她赠予一枚青铜铃铛作为信物。",
      entities: ["白露"],
      keywords: ["青铜铃铛", "药庐"],
      turnRange: [1, 4],
      enabled: true,
      pinned: false,
      createdTurn: 4,
    },
  });
  applyRpTx(state, {
    kind: "belief_update",
    actorId: "白露",
    target: "旅人",
    activatingEvent: "冒雨送回药篓",
    belief: "旅人是罕见的守信之人",
    subjectiveInsight: "嘴上嫌弃对方鲁莽，心里却暗暗松了口气",
    emotionalTone: "柔软而克制",
    turn: 8,
  });

  const recalled = recallMemoryBooks(state, "我摸了摸怀里的青铜铃铛", 4);
  assert.equal(recalled.chapters.length, 1);
  assert.equal(recalled.chapters[0]!.id, "mb_1");

  const activeStorylets = evaluateActiveStorylets(state);
  assert.equal(activeStorylets.length, 1);
  assert.equal(activeStorylets[0]!.title, "山道塌方危机");

  const z3 = buildZone3TransientTail({
    card,
    state,
    recalledLore: [],
    recalledMemoryBooks: recalled.chapters,
    recentText: "青铜铃铛",
  });
  assert.ok(z3.includes("在暴雨前采到雪莲"));
  assert.ok(z3.includes("第一卷·药庐初遇"));
  assert.ok(z3.includes("山道塌方危机"));
  assert.ok(z3.includes("嘴上嫌弃对方鲁莽"));
  assert.ok(z3.includes("<thought>"));
});

test("8. Reversible State Audit Log & 1-click Undo restores stats, inventory & location", () => {
  const state = createInitialRpState();
  state.active = true;
  state.location = "起点广场";
  applyRpTx(state, { kind: "stat_patch", actorId: "player", key: "HP", op: "set", value: 100, min: 0, max: 100 });
  applyRpTx(state, { kind: "stat_patch", actorId: "player", key: "HP", op: "add", value: -30 });
  applyRpTx(state, { kind: "inventory_patch", actorId: "player", item: "铁剑", delta: 1 });
  applyRpTx(state, { kind: "location_set", location: "幽暗森林", presentNpcs: ["猎人"] });

  assert.equal(state.stats.player?.HP, 70);
  assert.equal(state.inventory.player?.["铁剑"], 1);
  assert.equal(state.location, "幽暗森林");
  assert.ok(state.auditLog.length >= 4);

  // Undo location_set
  const lastLocAudit = state.auditLog[state.auditLog.length - 1]!;
  assert.ok(lastLocAudit.undoTx);
  applyRpTx(state, lastLocAudit.undoTx!);
  assert.equal(state.location, "起点广场");

  // Undo inventory_patch
  const invAudit = state.auditLog.find((a) => a.undoTx?.kind === "inventory_patch")!;
  applyRpTx(state, invAudit.undoTx!);
  assert.equal(state.inventory.player?.["铁剑"], undefined);

  // Undo HP -30 (the only stat_patch with a prior value to restore)
  const hpAudits = state.auditLog.filter((a) => a.undoTx?.kind === "stat_patch");
  const dmgAudit = hpAudits[0]!;
  applyRpTx(state, dmgAudit.undoTx!);
  assert.equal(state.stats.player?.HP, 100);
});

test("9. actionSummarizeOldFloors archives exact floor count (not swapped!) & writes Memory Book chapter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-sum-"));
  try {
    const h = createV3Harness(tmpDir);
    const state = createInitialRpState();
    state.active = true;
    state.turn = 10;
    const committed: RpTxEntry[] = [];

    // 20 dialogue entries: "保留最近 6 条，其余 14 条归档" MUST archive 14 entries, NOT 6!
    for (let i = 1; i <= 20; i++) {
      h.entries.push({
        id: `m_${i}`,
        type: "message",
        message: { role: i % 2 === 1 ? "user" : "assistant", content: `第 ${i} 层剧情内容` },
      });
    }

    const card = compileCharacterCard(
      { spec: "chara_card_v2", data: { name: "矿洞向导", description: "老矿工", first_mes: "跟我来。" } },
      "v2",
    );
    h.ctx.ui.select = async (_title: string, opts: string[]) => opts.find((o) => o.includes("仅保留最近 6 条")) ?? opts[0];
    h.setMockLlmResponse("玩家与角色在前十四层中完成了矿洞探险并取得密钥。");
    const mockRt = {
      pi: h.pi,
      getState: () => state,
      getCard: () => card,
      getExtraCastCards: () => [],
      getPreset: () => null,
      getLastXRay: () => null,
      commitTx(tx: RpTxEntry) {
        committed.push(tx);
        applyRpTx(state, tx);
      },
      reloadRuntime() {},
      refreshHud() {},
      activateRpTools() {},
      restoreCodingTools() {},
      markNextTurnOoc() {},
      teardownSessionRuntime() {},
    };

    await actionSummarizeOldFloors(mockRt, h.ctx, "");

    const hideTx = committed.find((t) => t.kind === "hide_toggle");
    assert.ok(hideTx && hideTx.kind === "hide_toggle");
    assert.equal(hideTx.entryIds.length, 14, "Must hide 14 older entries and keep the latest 6");

    const bookTx = committed.find((t) => t.kind === "memory_book_upsert");
    assert.ok(bookTx && bookTx.kind === "memory_book_upsert", "Must persist summarized floor archive into Memory Books");
    assert.equal(state.memoryBooks.size, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("10. actionReroll respects isIdle() guard & rewinds to continue trigger rather than older user turn", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-reroll-"));
  try {
    const busyH = createV3Harness(tmpDir, { isIdle: false });
    const state = createInitialRpState();
    state.active = true;
    const mockRt = {
      pi: busyH.pi,
      getState: () => state,
      getCard: () => null,
      getExtraCastCards: () => [],
      getPreset: () => null,
      getLastXRay: () => null,
      commitTx() {},
      reloadRuntime() {},
      refreshHud() {},
      activateRpTools() {},
      restoreCodingTools() {},
      markNextTurnOoc() {},
      teardownSessionRuntime() {},
    };
    await actionReroll(mockRt, busyH.ctx, "");
    assert.equal(busyH.navigatedIds.length, 0);

    // Idle agent after `/rp continue` custom trigger -> rewinds to parent `a_1` right before `c_cont` (NOT older `u_1`)!
    const idleH = createV3Harness(tmpDir, { isIdle: true });
    idleH.entries.push(
      { id: "u_1", type: "message", message: { role: "user", content: "第一句玩家行动" } },
      { id: "a_1", parentId: "u_1", type: "message", message: { role: "assistant", content: "第一段回复" } },
      {
        id: "c_cont",
        parentId: "a_1",
        type: "custom_message",
        customType: "rp:event",
        data: { kind: "continue" },
        message: { role: "custom", customType: "rp:event", content: "（请顺着上文自然续写下一段剧情）", details: { kind: "continue" } },
      },
      { id: "a_2", parentId: "c_cont", type: "message", message: { role: "assistant", content: "续写内容" } },
    );
    const idleRt = { ...mockRt, pi: idleH.pi };
    await actionReroll(idleRt, idleH.ctx, "增加环境氛围");
    assert.deepEqual(idleH.navigatedIds, ["a_1"], "Must rewind to parent right before the latest continue trigger");
    assert.equal(idleH.sentMessages.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("11. Context X-Ray & KV-Cache hit streak track byte-identical Zone 1 across turns", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-xray-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "凌霜", description: "雪山向导", first_mes: "风雪渐紧。" } };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createV3Harness(tmpDir);
    rpEngineExtension(h.pi);
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "bind",
      cardId: card.id,
      cardSlug: card.slug,
      cardSource: "project",
      worldDir: baseDir,
      greetingIndex: 0,
      activeCharacters: [card.slug],
    } satisfies RpTxEntry);
    await h.emit("session_start");

    const r1 = await h.emit("before_agent_start", { prompt: "我们出发吧。", systemPrompt: "base" });
    await h.emit("context", { messages: [{ role: "user", content: "我们出发吧。" }] });
    const r2 = await h.emit("before_agent_start", { prompt: "往前走。", systemPrompt: "base" });
    await h.emit("context", { messages: [{ role: "user", content: "往前走。" }] });

    assert.equal(r1.systemPrompt, r2.systemPrompt);
    assert.equal(computeZone1Hash(r1.systemPrompt), computeZone1Hash(r2.systemPrompt));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("12. 7-Tab TUI Overlay renders strictly within terminal width & handles keyboard navigation + HUD dual-mode", () => {
  const card = compileCharacterCard(
    { spec: "chara_card_v2", data: { name: "暮雪", description: "古董商", first_mes: "请看这枚玉佩。" } },
    "v2",
  );
  const state = createInitialRpState();
  state.active = true;
  state.turn = 4;
  state.location = "琉璃厂古董铺";
  state.sceneObjective = "辨认玉佩真伪";
  state.hudMode = "full";

  let closedAction: OverlayAction | undefined;
  const ctrl = createRpOverlayController({
    state,
    card,
    allLore: card.loreBook.entries,
    xray: null,
    done: (a) => {
      closedAction = a;
    },
  });

  // Render every single tab (1-7) at width 80 and assert zero horizontal overflow!
  for (let t = 1; t <= 7; t++) {
    ctrl.handleInput(String(t));
    assert.equal(ctrl.getTab(), t - 1);
    const lines = ctrl.render(80);
    assert.ok(lines.length >= 6);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 80, `Tab ${t} line overflowed 80 cols: ${displayWidth(line)}`);
    }
  }

  ctrl.handleInput("1");
  ctrl.handleInput("j");
  assert.equal(ctrl.getSelectedIndex(), 1);
  ctrl.handleInput("u");
  assert.deepEqual(closedAction, { kind: "undo_last", tab: 0 });

  // Dual-mode HUD: TUI uses component factory; RPC uses string[]
  const tuiH = createV3Harness("/tmp", { mode: "tui" });
  renderRpHud(tuiH.ctx, state, card);
  assert.equal(typeof tuiH.widgets.get("rp-hud"), "function");
  const tuiComp = tuiH.widgets.get("rp-hud")({}, {});
  const hudLines: string[] = tuiComp.render(72);
  assert.ok(hudLines.some((l) => l.includes("辨认玉佩真伪")));

  const rpcH = createV3Harness("/tmp", { mode: "rpc" });
  renderRpHud(rpcH.ctx, state, card);
  assert.ok(Array.isArray(rpcH.widgets.get("rp-hud")));
});

test("13. Workspace store CRUD & ModelRegistry sidecar selection work cleanly", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-v3-store-"));
  try {
    const baseDir = getProjectRpDir(tmpDir);
    const rawCard = { spec: "chara_card_v2", data: { name: "云舒", description: "书画修复师" } };
    const card = compileCharacterCard(rawCard, "v2");
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const extraBook = compileLoreBook({
      entries: [{ id: "e1", comment: "古画", keys: ["古画"], content: "明代真迹", constant: false, enabled: true }],
    });
    const merged = mergeExternalLoreBook(baseDir, card.slug, extraBook);
    assert.ok(merged);
    assert.equal(merged!.importReport.loreCount, 1);
    assert.equal(merged!.importReport.dynamicLoreCount, 1);

    merged!.identity.nickname = "云掌柜";
    saveUpdatedCard(baseDir, merged!);
    assert.equal(loadCompiledCard(baseDir, card.slug)?.identity.nickname, "云掌柜");
    assert.equal(deleteCompiledCard(baseDir, card.slug), true);
    assert.equal(loadCompiledCard(baseDir, card.slug), null);

    saveCompiledPreset(baseDir, {
      id: "p_del",
      name: "Test",
      zone1Prompts: [],
      zone3Prompts: [],
      utilityPrompts: {},
      sampling: {},
      strippedCount: 0,
      warnings: [],
    });
    assert.ok(loadCompiledPreset(tmpDir, "p_del"));
    assert.equal(deleteCompiledPreset(tmpDir, "p_del"), true);
    assert.equal(loadCompiledPreset(tmpDir, "p_del"), null);

    savePersona(tmpDir, { id: "per_1", name: "顾川", description: "鉴定师" });
    assert.equal(loadPersonas(tmpDir).some((p) => p.id === "per_1"), true);
    assert.equal(deletePersona(tmpDir, "per_1"), true);
    assert.equal(loadPersonas(tmpDir).some((p) => p.id === "per_1"), false);

    const h = createV3Harness(tmpDir);
    const list = listRegistryModels(h.ctx);
    assert.equal(list[0]?.key, "google/gemini-2.5-flash");
    assert.equal(list[0]?.isFastHint, true);
    const resolved = resolveSidecarModel(h.ctx, "google/gemini-2.5-flash") as { id?: string };
    assert.equal(resolved?.id, "gemini-2.5-flash");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("14. Sidecar settlement writes RoleMemo DualMem subjectiveInsight & emotionalTone", async () => {
  const state = createInitialRpState();
  state.active = true;
  state.settlementMode = "sidecar-light";
  state.turn = 3;
  const h = createV3Harness("/tmp");
  h.setMockLlmResponse(
    JSON.stringify({
      beliefs: [
        {
          actorId: "沈墨",
          target: "旅人",
          activatingEvent: "独自挡住追兵",
          belief: "旅人值得生死相托",
          subjectiveInsight: "表面冷淡，其实已将旅人视作唯一的软肋",
          emotionalTone: "克制的动容",
        },
      ],
    }),
  );

  const count = await runSidecarLightSettlement({
    pi: h.pi,
    ctx: h.ctx,
    state,
    lastUserText: "你们先走，我断后。",
    lastAssistantText: "沈墨回头看了你一眼，指节攥紧剑柄。",
  });
  assert.ok(count >= 1);
  assert.equal(state.beliefs[0]?.subjectiveInsight, "表面冷淡，其实已将旅人视作唯一的软肋");
  assert.equal(state.beliefs[0]?.emotionalTone, "克制的动容");
});
