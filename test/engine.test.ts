import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import rpEngineExtension from "../src/index.js";
import { completeWithRegistry, stripThinkingBlocks } from "../src/engine/llm-helper.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { saveCompiledCard, getProjectRpDir } from "../src/storage/workspace-store.js";
import { RP_ENTRY_TYPE, applyRpTx, computeMessageFingerprint, createInitialRpState, replayBranchState } from "../src/engine/state-replay.js";
import { rollDiceCheck } from "../src/engine/dice.js";
import { validateCfsmTransition } from "../src/engine/cfsm.js";
import { recallLoreWithGraphPpr, tickLoreRuntime } from "../src/memory/graph-ppr.js";
import { attachZone3ToMessages, buildZone1FrozenPrefix, buildZone3TransientTail } from "../src/context/zone-builder.js";
import { collectLabeledBookmarks } from "../src/ui/actions.js";
import type { PiExtensionAPI, PiExtensionContext, PiMessage, PiSessionEntry, PiToolDefinition, RpTxEntry } from "../src/types.js";

/** Lightweight official-Pi-SDK-compliant mock harness for end-to-end extension verification. */
function createMockPiHarness(cwd: string) {
  const handlers = new Map<string, Array<(event: any, ctx: PiExtensionContext) => any>>();
  const tools = new Map<string, PiToolDefinition>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const messageRenderers = new Map<string, any>();
  const markdownTransformers: Array<(md: string, ctx?: any) => string> = [];
  const entries: PiSessionEntry[] = [];
  const labels = new Map<string, string>();
  const sentMessages: any[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  let activeTools = ["read", "write", "edit", "bash"];
  let statusRp: string | undefined;
  let widgetRp: any;

  const pi: PiExtensionAPI = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerShortcut(key, def) {
      shortcuts.set(key, def);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names) {
      activeTools = [...names];
    },
    appendEntry(customType, data) {
      entries.push({
        id: `e_${entries.length + 1}`,
        type: "custom",
        customType,
        data,
        timestamp: Date.now(),
      });
    },
    sendMessage(msg, opts) {
      sentMessages.push({ msg, opts });
    },
    setLabel(entryId, label) {
      if (label === undefined) labels.delete(entryId);
      else labels.set(entryId, label);
    },
    registerMarkdownTransformer(fn) {
      markdownTransformers.push(fn);
    },
    registerMessageRenderer(customType, fn) {
      messageRenderers.set(customType, fn);
    },
  };

  const ctx: PiExtensionContext = {
    cwd,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, text) {
        if (key === "rp") statusRp = text;
      },
      setWidget(key, content) {
        if (key === "rp-hud") widgetRp = content;
      },
      async select() {
        return undefined;
      },
      async confirm() {
        return true;
      },
      async input() {
        return undefined;
      },
      async editor() {
        return undefined;
      },
      setEditorText() {},
    },
    sessionManager: {
      getBranch() {
        return [...entries];
      },
      getEntries() {
        return [...entries];
      },
      getLeafId() {
        return entries.length > 0 ? entries[entries.length - 1]!.id : null;
      },
      getLabel(id) {
        return labels.get(id);
      },
    },
  };

  async function emit(event: string, payload: any = {}) {
    let lastRes: any;
    for (const fn of handlers.get(event) ?? []) {
      const r = await fn(payload, ctx);
      if (r !== undefined) lastRes = r;
    }
    return lastRes;
  }

  return {
    pi,
    ctx,
    tools,
    commands,
    shortcuts,
    messageRenderers,
    markdownTransformers,
    entries,
    labels,
    sentMessages,
    notifications,
    emit,
    getActiveTools: () => activeTools,
    getStatusRp: () => statusRp,
    getWidgetRp: () => widgetRp,
  };
}

test("Dice engine supports d20 shorthand, advantage (2d20kh1), disadvantage (2d20kl1), and modifiers", () => {
  const r1 = rollDiceCheck({ expression: "d20+2", dc: 15 });
  assert.equal(r1.rolls.length, 1);
  assert.equal(r1.modifier, 2);
  assert.equal(r1.total, r1.rolls[0]! + 2);

  const adv = rollDiceCheck({ expression: "2d20kh1" });
  assert.equal(adv.rolls.length, 2);
  assert.equal(adv.keptRolls.length, 1);
  assert.equal(adv.total, Math.max(...adv.rolls));

  const dis = rollDiceCheck({ expression: "2d20kl1+3" });
  assert.equal(dis.rolls.length, 2);
  assert.equal(dis.keptRolls.length, 1);
  assert.equal(dis.total, Math.min(...dis.rolls) + 3);
});

test("Strict session-only isolation: cards saved in .pi/rp NEVER auto-activate RP in new sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-iso-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "孤岛守望者", description: "神秘的灯塔看守" } };
    const card = compileCharacterCard(rawCard, "v2");
    saveCompiledCard({ baseDir: getProjectRpDir(tmpDir), card, rawJson: rawCard });

    // Start a brand-new coding session in the same project directory
    const h = createMockPiHarness(tmpDir);
    rpEngineExtension(h.pi);
    await h.emit("session_start");

    // MUST remain 100% dormant: coding tools untouched, HUD empty, before_agent_start returns undefined!
    assert.deepEqual(h.getActiveTools(), ["read", "write", "edit", "bash"]);
    assert.equal(h.getStatusRp(), undefined);
    assert.equal(await h.emit("before_agent_start", { prompt: "fix bug" }), undefined);
    assert.equal(await h.emit("context", { messages: [{ role: "user", content: "hello" }] }), undefined);
    assert.equal(await h.emit("session_before_compact", { preparation: { firstKeptEntryId: "e1", tokensBefore: 5000 } }), undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Complete exit (/rp exit) wipes state, restores coding tools, clears HUD, and re-bind cleanly resets old stats", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-exit-"));
  try {
    const rawCard = {
      spec: "chara_card_v2",
      data: { name: "赛琳", description: "炼金术师", first_mes: "你好！" },
    };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createMockPiHarness(tmpDir);
    rpEngineExtension(h.pi);

    // Bind in THIS session
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "bind",
      cardId: card.id,
      cardSlug: card.slug,
      cardSource: "project",
      worldDir: baseDir,
      greetingIndex: 0,
      activeCharacters: [card.slug],
    } satisfies RpTxEntry);
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "stat_patch",
      actorId: "player",
      key: "HP",
      op: "set",
      value: 42,
    } satisfies RpTxEntry);

    await h.emit("session_start");
    assert.ok(h.getActiveTools().includes("rp_roll_check"));
    assert.ok(!h.getActiveTools().includes("bash"));
    assert.ok(h.getStatusRp()?.includes("赛琳"));

    // Exit RP via `/rp exit`
    await h.commands.get("rp").handler("exit", h.ctx);

    // Coding tools 100% restored, HUD 100% cleared, hooks 100% dormant!
    assert.deepEqual(h.getActiveTools(), ["read", "write", "edit", "bash"]);
    assert.equal(h.getStatusRp(), undefined);
    assert.equal(h.getWidgetRp(), undefined);
    assert.equal(await h.emit("before_agent_start", { prompt: "code" }), undefined);

    // Re-bind again: old HP=42 MUST NOT leak into the fresh run!
    const replayed = replayBranchState([
      ...h.entries,
      {
        id: "e_rebind",
        type: "custom",
        customType: RP_ENTRY_TYPE,
        data: {
          kind: "bind",
          cardId: card.id,
          cardSlug: card.slug,
          cardSource: "project",
          worldDir: baseDir,
          greetingIndex: 0,
          activeCharacters: [card.slug],
        },
      },
    ]);
    assert.equal(replayed.active, true);
    assert.equal(replayed.stats.player?.HP, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Intermediate tool-call turn_end does NOT double-increment turns or burn sticky/note TTLs", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-turn-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "罗兰", description: "侦探" } };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createMockPiHarness(tmpDir);
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
    h.pi.appendEntry(RP_ENTRY_TYPE, {
      kind: "note_set",
      note: { id: "n1", text: "保持悬疑感", remainingTurns: 2 },
    } satisfies RpTxEntry);
    await h.emit("session_start");

    // Step 1: Intermediate toolCall assistant step -> MUST be skipped!
    await h.emit("turn_end", {
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "tc1", name: "rp_roll_check", arguments: { expression: "1d20" } }],
      },
    });
    let st = replayBranchState(h.entries);
    assert.equal(st.turn, 0);
    assert.equal(st.notes[0]?.remainingTurns, 2);

    // Step 2: Final narrative assistant step -> increments turn to 1, decrements TTL to 1
    await h.emit("turn_end", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "他推开了积灰的橡木门。" }],
      },
    });
    st = replayBranchState(h.entries);
    assert.equal(st.turn, 1);
    assert.equal(st.notes[0]?.remainingTurns, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("World Info inline /regex/flags, @@exclude_keys, sticky=0 cooldown, and 2-hop Graph-PPR", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v3",
      data: {
        name: "维多利亚",
        description: "学园导师",
        character_book: {
          entries: [
            {
              uid: 1,
              comment: "黑塔禁书",
              keys: ["/black\\s+tower|黑塔/i"],
              content: "@@exclude_keys 幻觉\n黑塔中收藏着【苍白星图】，与大图书馆的秘史相连。",
              cooldown: 3,
              sticky: 0,
            },
            {
              uid: 2,
              comment: "苍白星图",
              keys: ["苍白星图"],
              content: "苍白星图记载了远古星陨之夜的坐标。",
            },
          ],
        },
      },
    },
    "v3",
  );

  const state = createInitialRpState();
  state.active = true;

  // Excluded by @@exclude_keys when "幻觉" is present
  const blocked = recallLoreWithGraphPpr({
    entries: card.loreBook.entries,
    state,
    recentText: "这只是关于黑塔的一场幻觉。",
    tokenBudget: 1500,
  });
  assert.ok(!blocked.selected.some((e) => e.title === "黑塔禁书"));

  // Inline regex triggers "黑塔禁书" AND 2-hop PPR pulls in "苍白星图"!
  const hit = recallLoreWithGraphPpr({
    entries: card.loreBook.entries,
    state,
    recentText: "We approached the Black   Tower at dusk.",
    tokenBudget: 1500,
  });
  assert.ok(hit.selected.some((e) => e.title === "黑塔禁书"));
  assert.ok(hit.selected.some((e) => e.title === "苍白星图"));

  // Non-sticky entry with cooldown=3 MUST enter cooldown on turn_end!
  const ticked = tickLoreRuntime(card.loreBook.entries, hit.nextSticky, hit.nextCooldown, hit.activatedIds);
  const towerId = card.loreBook.entries.find((e) => e.title === "黑塔禁书")!.id;
  assert.equal(ticked.cooldown[towerId], 3);
});

test("Zone 1 stays 100% byte-identical across 20 turns while Zone 3 carries beliefs, flags, pacing & fingerprint hiding", () => {
  const card = compileCharacterCard(
    {
      spec: "chara_card_v2",
      data: {
        name: "芙蕾雅",
        description: "北境女骑士",
        mes_example: "<START>\n{{user}}: 冷吗？\n{{char}}: 「风雪会让人清醒。」",
        post_history_instructions: "保持克制而史诗的口吻。",
      },
    },
    "v2",
  );

  const state = createInitialRpState();
  state.active = true;
  state.initialPersona = { id: "p1", name: "旅人", description: "游吟诗人" };
  state.currentPersona = { ...state.initialPersona };

  const z1Turn0 = buildZone1FrozenPrefix({ card, initialPersona: state.initialPersona });

  // Simulate 20 turns of heavy state mutations, beliefs, flags, pacing, mid-session persona change
  for (let i = 0; i < 20; i++) {
    applyRpTx(state, { kind: "clock_tick", beatDelta: 1, worldTimeLabel: `Day ${i + 1}` });
  }
  applyRpTx(state, { kind: "flag_set", flag: "oath_sworn", value: true });
  applyRpTx(state, { kind: "config_patch", pacingMode: "dramatic" });
  applyRpTx(state, {
    kind: "belief_update",
    actorId: "芙蕾雅",
    target: "旅人",
    activatingEvent: "在暴风雪中分出干粮",
    belief: "旅人虽然嘴硬，但值得托付后背",
    turn: 20,
  });
  applyRpTx(state, { kind: "persona_set", persona: { id: "p2", name: "北境使节", description: "佩剑的使者" } });

  const z1Turn20 = buildZone1FrozenPrefix({ card, initialPersona: state.initialPersona! });
  assert.equal(z1Turn20, z1Turn0, "Zone 1 MUST be 100% byte-identical across 20 turns for KV-cache hits");

  const z3 = buildZone3TransientTail({
    card,
    state,
    recalledLore: [],
    recentText: "风雪",
  });
  assert.ok(z3.includes("oath_sworn"));
  assert.ok(z3.includes("Character Beliefs (DREAM ABC)"));
  assert.ok(z3.includes("值得托付后背"));
  assert.ok(z3.includes("Pacing cue:"));
  assert.ok(z3.includes("北境使节"));

  // Fingerprint-based hiding works on Pi AgentMessage[] that lack entryId!
  const msg1: PiMessage = { role: "user", content: "第一句秘密", timestamp: 1001 };
  const msg2: PiMessage = { role: "user", content: "第二句公开", timestamp: 1002 };
  const fp1 = computeMessageFingerprint(msg1);
  const out = attachZone3ToMessages([msg1, msg2], z3, new Set(), new Set([fp1]));
  assert.equal(out.length, 1);
  assert.ok(String(out[0]!.content).includes("第二句公开"));
  assert.ok(String(out[0]!.content).includes("<rp_state_frame>"));
});

test("Official Pi SDK contracts: compaction result, getLabel bookmarks, CFSM, renderers & 14 shortcuts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-sdk-"));
  try {
    const rawCard = { spec: "chara_card_v2", data: { name: "诺亚", description: "星舰领航员" } };
    const card = compileCharacterCard(rawCard, "v2");
    const baseDir = getProjectRpDir(tmpDir);
    saveCompiledCard({ baseDir, card, rawJson: rawCard });

    const h = createMockPiHarness(tmpDir);
    rpEngineExtension(h.pi);

    // 16 shortcuts registered + 3 message renderers + 6 tools (all defaultActive: false)
    assert.equal(h.shortcuts.size, 18);
    assert.ok(h.shortcuts.has("alt+r"));
    assert.ok(h.shortcuts.has("alt+e"));
    assert.ok(h.shortcuts.has("alt+x"));
    assert.ok(h.shortcuts.has("alt+shift+x"));
    assert.equal(h.messageRenderers.size, 3);
    assert.equal(h.tools.size, 6);
    for (const tool of h.tools.values()) {
      assert.equal(tool.defaultActive, false);
      assert.equal(typeof tool.renderCall, "function");
      assert.equal(typeof tool.renderResult, "function");
    }

    // Activate session
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

    // Bookmark via official Pi SDK setLabel + sessionManager.getLabel
    const leaf = h.ctx.sessionManager.getLeafId()!;
    h.pi.setLabel!(leaf, "星门决战前夜");
    const bookmarks = collectLabeledBookmarks(h.ctx);
    assert.equal(bookmarks.length, 1);
    assert.equal(bookmarks[0]!.label, "星门决战前夜");

    // session_before_compact returns official `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`
    const compactRes = await h.emit("session_before_compact", {
      preparation: {
        firstKeptEntryId: "entry_42",
        tokensBefore: 18500,
        messagesToSummarize: [
          { role: "user", content: "我们启动跃迁引擎吧。" },
          { role: "assistant", content: "诺亚按下蓝光开关，星门缓缓展开。" },
        ],
      },
    });
    assert.equal(compactRes.compaction.firstKeptEntryId, "entry_42");
    assert.equal(compactRes.compaction.tokensBefore, 18500);
    assert.ok(compactRes.compaction.summary.includes("MemScene"));
    assert.ok(compactRes.compaction.summary.includes("跃迁引擎"));

    // CFSM strict state machine validation
    const cfsmState = createInitialRpState();
    applyRpTx(cfsmState, {
      kind: "cfsm_define",
      actorId: "诺亚",
      def: {
        axis: "trust",
        states: ["wary", "ally", "devoted"],
        initial: "wary",
        transitions: { wary: ["ally"], ally: ["wary", "devoted"] },
      },
    });
    assert.equal(validateCfsmTransition(cfsmState, "诺亚", "trust", "devoted").ok, false);
    assert.equal(validateCfsmTransition(cfsmState, "诺亚", "trust", "ally").ok, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Thinking-model safety: completeWithRegistry enforces >=4096 maxTokens floor & stripThinkingBlocks drops unclosed <think>", async () => {
  assert.equal(stripThinkingBlocks("<think>unclosed reasoning that ran out of tokens"), "");
  assert.equal(stripThinkingBlocks("visible prose<think>trailing unclosed"), "visible prose");

  let capturedMaxTokens = 0;
  const fakeCtx = {
    cwd: process.cwd(),
    model: { provider: "deepseek", id: "deepseek-flash" },
    modelRegistry: {
      streamSimple(_model: unknown, _ctx: unknown, opts?: Record<string, unknown>) {
        capturedMaxTokens = Number(opts?.maxTokens ?? 0);
        return {
          async result() {
            return { content: [{ type: "text", text: "<think>step</think>干净正文" }] };
          },
        };
      },
    },
    ui: { notify() {}, setStatus() {}, setWidget() {}, select: async () => undefined, confirm: async () => true, input: async () => undefined, editor: async () => undefined, setEditorText() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => null },
  };
  const out = await completeWithRegistry(fakeCtx as never, fakeCtx.model, { userPrompt: "hi", maxTokens: 320 });
  assert.equal(out, "干净正文");
  assert.ok(capturedMaxTokens >= 4096, `expected >= 4096, got ${capturedMaxTokens}`);
});

test("actionRewriteLast guards against identical output & actionExportNovel includes custom_message to cwd/rp-exports", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-rewrite-export-"));
  try {
    const h = createMockPiHarness(tmpDir);
    rpEngineExtension(h.pi);
    const rawCard = { name: "林秋", description: "测试角色", first_mes: "开场白：码头起雾了。" };
    const card = compileCharacterCard(rawCard, "v2");
    saveCompiledCard({ baseDir: path.join(tmpDir, ".pi", "rp"), card, rawJson: rawCard });

    const notifications: string[] = [];
    h.ctx.ui.notify = (msg: string) => notifications.push(msg);
    h.ctx.ui.confirm = async () => true;
    h.ctx.ui.select = async (_title: string, opts: string[]) => opts[0];

    // Bind card
    await h.commands.get("rp")!.handler(`load ${card.slug}`, h.ctx);

    // Seed branch with native Pi custom_message greeting + user + assistant + custom_message era
    h.entries.push(
      { id: "e_greet", type: "custom_message", customType: "rp:greeting", content: "开场白：码头起雾了。", display: true },
      { id: "e_u1", type: "message", message: { role: "user", content: "我走上跳板。", timestamp: 100 } },
      { id: "e_a1", type: "message", message: { role: "assistant", content: "船老大抬眼看你，吐了口烟。", timestamp: 200 } },
      { id: "e_era", type: "custom_message", customType: "rp:era", content: "[时间推进：次日清晨]", display: true },
    );

    // 1. Identical output from model must be blocked (no fake replacement!)
    let rewriteOutput = "船老大抬眼看你，吐了口烟。";
    h.ctx.model = { provider: "deepseek", id: "deepseek-flash" };
    h.ctx.modelRegistry = {
      streamSimple() {
        return {
          async result() {
            return { content: [{ type: "text", text: rewriteOutput }] };
          },
        };
      },
    };
    const sentBefore = h.sentMessages.length;
    await h.commands.get("rp")!.handler("rewrite 语气更冷硬", h.ctx);
    assert.equal(h.sentMessages.length, sentBefore, "identical rewrite should not send rp:rewrite");
    assert.ok(notifications.some((n) => n.includes("几乎一致")));

    // 2. Genuine changed rewrite succeeds & creates rp:rewrite
    rewriteOutput = "船老大连眼皮都没抬，只拿烟杆往船舷上一敲，冷声道：上船交钱。";
    await h.commands.get("rp")!.handler("rewrite 语气更冷硬", h.ctx);
    assert.equal(h.sentMessages.length, sentBefore + 1);
    const rwMsg = h.sentMessages[h.sentMessages.length - 1]!;
    assert.equal(rwMsg.msg.customType, "rp:rewrite");

    // Push the rp:rewrite as custom_message into branch to verify export includes it & hides original
    h.entries.push({
      id: "e_rw1",
      type: "custom_message",
      customType: "rp:rewrite",
      content: rewriteOutput,
      display: true,
    });

    // 3. Export novel writes directly to cwd/rp-exports/ and includes custom_message greeting + era + rewrite
    await h.commands.get("rp")!.handler("export my_novel", h.ctx);
    const outFile = path.join(tmpDir, "rp-exports", "my_novel.md");
    assert.ok(fs.existsSync(outFile), `expected export file at ${outFile}`);
    const exported = fs.readFileSync(outFile, "utf-8");
    assert.ok(exported.includes("开场白：码头起雾了。"), "should include rp:greeting custom_message");
    assert.ok(exported.includes("我走上跳板。"), "should include user message");
    assert.ok(exported.includes("船老大连眼皮都没抬"), "should include rp:rewrite custom_message");
    assert.ok(exported.includes("## 第 2 节"), "should include rp:era chapter divider");
    assert.ok(!exported.includes("吐了口烟"), "should exclude replaced/hidden original assistant floor");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
