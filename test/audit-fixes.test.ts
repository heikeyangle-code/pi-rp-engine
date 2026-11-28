import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import rpExtension from "../src/index.js";
import { createInitialRpState, applyRpTx } from "../src/engine/state-replay.js";
import { parseTimeSpan, computeCalendarAnchor } from "../src/engine/temporal.js";
import { validateCfsmTransition } from "../src/engine/cfsm.js";
import { extractJsonObject, stripThinkingBlocks } from "../src/engine/llm-helper.js";
import { buildZone3TransientTail } from "../src/context/zone-builder.js";
import { recallLoreWithGraphPpr } from "../src/memory/graph-ppr.js";
import { extractCommittedRounds } from "../src/memory/history-recall.js";
import { buildMemSceneCompactionSummary } from "../src/memory/compaction.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { compileLoreBook } from "../src/parser/lore-compiler.js";
import { evaluateMacros } from "../src/parser/macros.js";
import { sanitizeZipEntryPath } from "../src/parser/unpack.js";
import { applyDisplayRegexRules, isFrontendRegexScript } from "../src/parser/sanitizer.js";
import { deleteCompiledCard } from "../src/storage/workspace-store.js";
import { registerRpTools } from "../src/tools/rp-tools.js";
import { openRpDashboard } from "../src/ui/dashboard.js";
import { actionOoc, actionGreeting, actionExportNovel } from "../src/ui/actions.js";
import type {
  CompiledCard,
  PiContentBlock,
  PiExtensionAPI,
  PiExtensionContext,
  PiSessionEntry,
  PiToolDefinition,
  RpTxEntry,
} from "../src/types.js";

function makeCard(overrides?: Partial<CompiledCard>): CompiledCard {
  const base = compileCharacterCard(
    {
      name: "林秋",
      description: "冷静镖师",
      personality: "寡言",
      scenario: "风雪渡口",
      first_mes: "主开场白：雪落渡口。",
      alternate_greetings: ["备选开场白：茶馆听雨。"],
    },
    "v2",
  );
  return { ...base, ...overrides };
}

function blockText(block: PiContentBlock | undefined): string {
  return block && block.type === "text" && typeof block.text === "string" ? block.text : "";
}

test("audit-1: physical_patch partial update preserves existing attire/holding & undo never loops", () => {
  const state = createInitialRpState();
  state.active = true;
  applyRpTx(state, {
    kind: "physical_patch",
    snapshot: { actorId: "林秋", attire: "黑色风衣", holding: "左轮手枪", condition: "完好", updatedTurn: 1 },
  });
  // Partial patch with explicit undefined fields must NOT wipe attire/holding
  applyRpTx(state, {
    kind: "physical_patch",
    snapshot: {
      actorId: "林秋",
      attire: undefined,
      holding: undefined,
      condition: "左臂擦伤",
      position: undefined,
      updatedTurn: 2,
    },
  });
  assert.equal(state.physicalState["林秋"]?.attire, "黑色风衣");
  assert.equal(state.physicalState["林秋"]?.holding, "左轮手枪");
  assert.equal(state.physicalState["林秋"]?.condition, "左臂擦伤");

  // Clamped progress clock undo restores exact previous value & does not append new audit entry
  applyRpTx(state, {
    kind: "progress_clock",
    clockId: "alert",
    label: "警戒",
    delta: 3,
    max: 4,
  });
  applyRpTx(state, {
    kind: "progress_clock",
    clockId: "alert",
    label: "警戒",
    delta: 3, // clamped 3 -> 4 (actual delta = +1)
    max: 4,
  });
  assert.equal(state.clocks["alert"]?.value, 4);
  const lastUndo = state.auditLog.filter((r) => r.undoTx).at(-1)!;
  const auditCountBeforeUndo = state.auditLog.length;
  applyRpTx(state, lastUndo.undoTx!);
  assert.equal(state.clocks["alert"]?.value, 3);
  assert.equal(state.auditLog.length, auditCountBeforeUndo, "Undo must not push a new auditLog entry");
});

test("audit-2: exclusive group weighted pick reaches entries beyond index 0 & respects AND_ALL", () => {
  const lore = compileLoreBook({
    entries: [
      { uid: 1, keys: ["天气"], content: "晴天", group: "weather", group_weight: 100, use_group_scoring: false, enabled: true },
      { uid: 2, keys: ["天气"], content: "暴雨", group: "weather", group_weight: 100, use_group_scoring: false, enabled: true },
      { uid: 3, keys: ["天气"], content: "大雪", group: "weather", group_weight: 100, use_group_scoring: false, enabled: true },
      {
        uid: 4,
        keys: ["圣剑"],
        secondary_keys: ["祭坛"],
        selective: true,
        selectiveLogic: 3, // AND_ALL
        content: "隐藏剧透：圣剑实为钥匙",
        enabled: true,
      },
    ],
  });
  const pickedIds = new Set<string>();
  for (let turn = 1; turn <= 30; turn++) {
    const state = createInitialRpState();
    state.active = true;
    state.turn = turn;
    const res = recallLoreWithGraphPpr({
      entries: lore.entries,
      state,
      recentText: "今天天气怎么样？圣剑很锋利。",
      tokenBudget: 1200,
    });
    for (const e of res.selected) {
      if (e.group === "weather") pickedIds.add(e.id);
      assert.notEqual(e.id, "4", "AND_ALL entry must NOT be activated when secondary key is missing");
    }
  }
  assert.ok(pickedIds.size >= 2, `Expected exclusive group to select >1 distinct entry across 30 turns, got ${pickedIds.size}`);
});

test("audit-3: temporal fictional calendars, absolute years, Ming eras, CFSM case-insensitivity & llm-helper JSON", () => {
  const fictional = computeCalendarAnchor("星历 2380 年", 5, 1825);
  assert.ok(fictional?.targetEraLabel?.includes("星历"), `Expected 星历 prefix preserved, got ${fictional?.targetEraLabel}`);
  assert.equal(fictional?.targetYear, 2385);

  const absJump = parseTimeSpan("跳到公元1644年");
  assert.equal(absJump.years, 0, "Absolute year target must not be parsed as 1644-year relative span");

  const ming = computeCalendarAnchor("永乐22年", 1, 365);
  assert.ok(ming?.targetEraLabel?.includes("洪熙"), `Expected 洪熙 era for 1425, got ${ming?.targetEraLabel}`);

  const state = createInitialRpState();
  state.cfsmDefs["Alice"] = {
    trust: {
      axis: "trust",
      initial: "guarded",
      states: ["guarded", "neutral", "trusted"],
      transitions: { guarded: ["neutral"], neutral: ["guarded", "trusted"], trusted: ["neutral"] },
    },
  };
  state.cfsmStates["Alice"] = { trust: { actorId: "Alice", axis: "trust", state: "guarded", updatedTurn: 1 } };
  const bad = validateCfsmTransition(state, "alice", "TRUST", "trusted");
  assert.equal(bad.ok, false, "Lowercase actor/axis must not bypass CFSM adjacency rules");

  assert.equal(stripThinkingBlocks("<thought>secret plan</thought>最终回复"), "最终回复");
  const json = extractJsonObject<{ ok: boolean }>('She grabbed the 5" dagger. {"ok": true}');
  assert.deepEqual(json, { ok: true });
});

test("audit-4: security & parser fixes (path traversal, ./card.json, ReDoS, macros $&, sanitizer $100, constant @D lore)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-audit-"));
  try {
    assert.throws(() => deleteCompiledCard(tmpDir, "../escape"), /Invalid|traversal|unsafe/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.equal(sanitizeZipEntryPath("./card.json"), "card.json");
  assert.throws(() => sanitizeZipEntryPath("../evil.json"));

  const lore = compileLoreBook({
    entries: [
      { uid: 1, keys: ["/(the\\s+)?empire/i"], use_regex: true, content: "合法可选组", enabled: true },
      { uid: 2, keys: ["/((a)+)+$/"], use_regex: true, content: "嵌套ReDoS", enabled: true },
      { uid: 3, keys: ["蓝灯"], constant: true, position: 4, content: "蓝灯深度常驻设定", enabled: true },
    ],
  });
  assert.equal(lore.entries[0]?.useRegex, true, "Safe optional group /(the\\s+)?empire/i must not be false-positived");

  const card = makeCard({ loreBook: lore });
  const state = createInitialRpState();
  state.active = true;
  const z3 = buildZone3TransientTail({ card, state, recentText: "普通对话", recalledLore: [] });
  assert.ok(z3.includes("蓝灯深度常驻设定"), "position=4 constant lore must be injected into Zone 3");

  const expanded = evaluateMacros("用户说：{{lastUserMessage}}", {
    charName: "林秋",
    userName: "玩家",
    lastUserMessage: "悬赏 $&100 元",
  });
  assert.equal(expanded, "用户说：悬赏 $&100 元");

  assert.equal(
    isFrontendRegexScript({ findRegex: "/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g", replaceString: "" }),
    false,
    "Pure cleanup regex (replaceString='') must not be stripped as frontend script",
  );

  const replaced = applyDisplayRegexRules("价格是 $100 元", [
    { name: "r1", pattern: "\\$100", flags: "g", replacement: "[{{match}}]", placements: [2], substituteRegex: 0, trimStrings: [], markdownOnly: true, promptOnly: false },
  ], { charName: "林秋", userName: "玩家" });
  assert.equal(replaced, "价格是 [$100] 元");
});

test("audit-5: rp_recall enforces EraGate & rp_fact_commit accepts single-string witness without public leak", async () => {
  const lore = compileLoreBook({
    entries: [
      { uid: 1, keys: ["真相"], content: "幕后黑手是县令", enabled: true },
    ],
  });
  lore.entries[0]!.gate = { requiredFlags: ["unlocked_truth"] };
  const card = makeCard({ loreBook: lore });
  const state = createInitialRpState();
  state.active = true;
  const tools = new Map<string, PiToolDefinition>();
  const committed: RpTxEntry[] = [];
  const mockPi = {
    on() {},
    registerTool(def: PiToolDefinition) { tools.set(def.name, def); },
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
    getActiveTools: () => [],
    setActiveTools() {},
  } as unknown as PiExtensionAPI;

  registerRpTools(mockPi, {
    getState: () => state,
    getCard: () => card,
    getExtraCastCards: () => [],
    commitTx: (tx) => { committed.push(tx); applyRpTx(state, tx); },
    refreshHud: () => {},
  });

  const recallTool = tools.get("rp_recall")!;
  assert.equal(recallTool.annotations?.readOnlyHint, true);
  const listRes = await recallTool.execute("c1", { action: "list" }, undefined, undefined, {} as PiExtensionContext);
  assert.ok(!blockText(listRes.content[0]).includes("幕后黑手"), "Locked spoiler must not appear in rp_recall list");
  const readRes = await recallTool.execute("c2", { action: "read", query: "真相" }, undefined, undefined, {} as PiExtensionContext);
  assert.ok(!blockText(readRes.content[0]).includes("幕后黑手"), "Locked spoiler must not be readable before gate unlocks");

  const factTool = tools.get("rp_fact_commit")!;
  assert.equal(factTool.executionMode, "sequential");
  await factTool.execute(
    "c3",
    { add_facts: [{ statement: "暗格里有密信", witnesses: "林秋" }] },
    undefined,
    undefined,
    {} as PiExtensionContext,
  );
  const allFacts = Array.from(state.facts.values());
  const added = allFacts.at(-1);
  assert.deepEqual(added?.witnessIds, ["林秋"], "Single string witness must stay private, never downgraded to 'public'");
});

test("audit-6: compaction preserves newest turns & history-recall keeps Turn 0 for greeting", async () => {
  const branch: PiSessionEntry[] = [
    { id: "g0", type: "custom_message", customType: "rp:greeting", content: "开场白内容", display: true },
    { id: "u1", type: "message", message: { role: "user", content: "第一轮玩家行动" } },
    { id: "a1", type: "message", message: { role: "assistant", content: "第一轮回复" } },
  ];
  const rounds = extractCommittedRounds(branch);
  assert.equal(rounds[0]?.turn, 0);
  assert.equal(rounds[1]?.turn, 1);

  const state = createInitialRpState();
  state.active = true;
  const summary = buildMemSceneCompactionSummary(state, {
    messagesToSummarize: [
      { role: "user", content: "旧消息" },
      { role: "assistant", content: "<thought>内部推理不要保留</thought>最新关键转折" },
    ],
  });
  assert.ok(!summary.includes("内部推理不要保留"));
  assert.ok(summary.includes("最新关键转折"));
});

test("audit-7: dashboard cancel safety, OOC isIdle guard, pickGreeting cancel & novel export chapter 1", async () => {
  const state = createInitialRpState();
  state.active = true;
  state.turn = 3;
  const card = makeCard();
  const committed: RpTxEntry[] = [];
  const sent: unknown[] = [];
  let oocMarked = false;
  let exportCalled = false;

  const mockRt = {
    pi: {
      sendMessage: (m: unknown) => { sent.push(m); },
    },
    getState: () => state,
    getCard: () => card,
    commitTx: (tx: RpTxEntry) => { committed.push(tx); applyRpTx(state, tx); },
    refreshHud: () => {},
    reloadRuntime: () => {},
    markNextTurnOoc: () => { oocMarked = true; },
  } as any;

  // 1. actionOoc must abort when ctx.isIdle() === false
  await actionOoc(mockRt, {
    cwd: os.tmpdir(),
    isIdle: () => false,
    sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "l1" },
    ui: { notify() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, setEditorText() {} },
  } as unknown as PiExtensionContext, "场外提问");
  assert.equal(oocMarked, false, "OOC must not mark active streaming turn as OOC");
  assert.equal(sent.length, 0);

  // 2. actionGreeting cancel must NOT send greeting #0
  await actionGreeting(mockRt, {
    cwd: os.tmpdir(),
    sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "l1" },
    ui: { notify() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, setEditorText() {} },
  } as unknown as PiExtensionContext);
  assert.equal(sent.length, 0, "Cancelling pickGreeting must not send greeting #0");

  // 3. Dashboard section 4 dispatches export novel (was dead code before fix)
  let selectStep = 0;
  await openRpDashboard(
    {
      ...mockRt,
      getExtraCastCards: () => [],
    getActivePreset: () => null,
      getLastXRay: () => null,
      exportNovel: async () => { exportCalled = true; },
      actionToggleHide: async () => {},
      actionSummarizeOldFloors: async () => {},
      actionGenerateLoreEntry: async () => {},
      actionRecap: async () => {},
      actionUndoTx: async () => {},
    } as any,
    {
      cwd: os.tmpdir(),
      mode: "rpc",
      sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => "l1" },
      ui: {
        notify() {},
        select: async (_title: string, opts: string[]) => {
          selectStep += 1;
          if (selectStep === 1) return opts.find((o) => o.includes("导出纯净 Markdown 小说"));
          return undefined;
        },
        input: async () => undefined,
        confirm: async () => false,
        setEditorText() {},
      },
    } as unknown as PiExtensionContext,
    3, // section 4: Memory & Lorebook
  );
  assert.equal(exportCalled, true, "Dashboard section 4 must invoke actionExportNovel");

  // 4. actionExportNovel starts first rp:era at 第 1 节 (not 第 2 节)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tavern-export-"));
  try {
    await actionExportNovel(
      mockRt,
      {
        cwd: tmpDir,
        sessionManager: {
          getBranch: () => [
            { id: "e1", type: "custom_message", customType: "rp:era", content: "第一幕开端", display: true },
            { id: "e2", type: "message", message: { role: "assistant", content: "风雪交加。" } },
          ],
          getEntries: () => [],
          getLeafId: () => "e2",
        },
        ui: { notify() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false, setEditorText() {} },
      } as unknown as PiExtensionContext,
      "novel-check",
    );
    const md = fs.readFileSync(path.join(tmpDir, "rp-exports", "novel-check.md"), "utf-8");
    assert.ok(md.includes("## 第 1 节"), `Expected ## 第 1 节, got:\n${md}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("audit-8: Pi v1.7.0 session_shutdown & session_compact lifecycle hooks", async () => {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const workingCalls: Array<string | undefined> = [];
  const mockPi: PiExtensionAPI = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool() {},
    registerCommand() {},
    registerShortcut() {},
    registerMessageRenderer() {},
    appendEntry() {},
    sendMessage() {},
    getActiveTools: () => [],
    setActiveTools() {},
  };
  rpExtension(mockPi);
  assert.ok(handlers.has("session_shutdown"), "Must register Pi v1.7.0 session_shutdown hook");
  assert.ok(handlers.has("session_compact"), "Must register Pi v1.7.0 session_compact hook");

  for (const h of handlers.get("session_shutdown") ?? []) {
    await h({}, {
      cwd: os.tmpdir(),
      sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => null },
      ui: {
        notify() {},
        setWorkingMessage: (m?: string) => workingCalls.push(m),
        setTitle() {},
      },
    });
  }
  assert.ok(workingCalls.includes(undefined), "session_shutdown must clear workingMessage");
});

test("audit-9: v5 Prose-First default, Anti-Godmoding/Anti-Sycophancy/Spotlight & Runtime SlopTracker", async () => {
  const { detectRuntimeSlop } = await import("../src/engine/stagnation.js");
  const state = createInitialRpState();
  assert.equal(state.settlementMode, "sidecar-light", "Default settlementMode must be Prose-First sidecar-light");
  assert.equal(state.antiGodmoding, true, "Anti-Godmoding must default to enabled");

  state.active = true;
  state.presentNpcs = ["林秋", "账房先生"];
  state.cfsmStates["林秋"] = { trust: { actorId: "林秋", axis: "trust", state: "guarded", updatedTurn: 1 } };
  const card = makeCard();
  const z3 = buildZone3TransientTail({ card, state, recentText: "我们继续往前走。", recalledLore: [] });
  assert.ok(z3.includes("Player Agency") || z3.includes("NEVER speak"), "Zone 3 must include Anti-Godmoding guard");
  assert.ok(z3.includes("Character Resistance") || z3.includes("guarded"), "Zone 3 must include Anti-Sycophancy resistance");
  assert.ok(z3.includes("Spotlight") || z3.includes("林秋"), "Zone 3 must include Multi-NPC Spotlight cue");

  const slop = detectRuntimeSlop([
    "他眼底闪过一丝冷意，转身看向窗外。",
    "她眼底闪过一丝犹豫，手指轻轻敲击桌面。",
    "众人沉默不语，眼底闪过一丝不易察觉的慌乱。",
  ]);
  assert.ok(slop.phrases.length >= 1, "Runtime SlopTracker must detect repeated CJK clichés across recent turns");
});
