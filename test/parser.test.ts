import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { unpackBuffer, unpackFile, inspectImportFileQuick, rewriteEmbeddedAssetUri, sanitizeZipEntryPath } from "../src/parser/unpack.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { compileLoreBook, parseV3Decorators, parseInlineRegexKey } from "../src/parser/lore-compiler.js";
import { compileSillyTavernPreset } from "../src/parser/preset.js";
import { evaluateMacros } from "../src/parser/macros.js";
import { applyDisplayRegexRules, sanitizeFrontendShell, stripDisplayResiduals } from "../src/parser/sanitizer.js";
import { normalizeUserFilePath, smartDiscoverRpFiles } from "../src/ui/file-picker.js";

/** Helper: construct a minimal valid PNG buffer containing arbitrary tEXt / iTXt chunks. */
function makePngWithTextChunks(chunks: Array<{ type: "tEXt" | "iTXt"; key: string; value: string; compressed?: boolean }>): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const makeChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0);
  ihdrData.writeUInt32BE(1, 4);
  const parts: Buffer[] = [sig, makeChunk("IHDR", ihdrData)];
  for (const c of chunks) {
    if (c.type === "tEXt") {
      parts.push(makeChunk("tEXt", Buffer.concat([Buffer.from(c.key, "latin1"), Buffer.from([0]), Buffer.from(c.value, "latin1")])));
    } else {
      const payload = c.compressed ? zlib.deflateSync(Buffer.from(c.value, "utf8")) : Buffer.from(c.value, "utf8");
      const data = Buffer.concat([
        Buffer.from(c.key, "utf8"),
        Buffer.from([0, c.compressed ? 1 : 0, 0, 0, 0]),
        payload,
      ]);
      parts.push(makeChunk("iTXt", data));
    }
  }
  parts.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Helper: build a minimal STORE ZIP buffer (.charx). */
function makeStoreZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + e.data.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

test("PNG unpacker prefers ccv3 over chara and handles compressed iTXt UTF-8", () => {
  const v2 = { spec: "chara_card_v2", data: { name: "旧版莉莉", description: "V2" } };
  const v3 = { spec: "chara_card_v3", spec_version: "3.0", data: { name: "新版莉莉", description: "V3 完整设定" } };
  const png = makePngWithTextChunks([
    { type: "tEXt", key: "chara", value: Buffer.from(JSON.stringify(v2)).toString("base64") },
    { type: "iTXt", key: "ccv3", value: Buffer.from(JSON.stringify(v3)).toString("base64"), compressed: true },
  ]);

  const res = unpackBuffer(png, "lily.png");
  assert.equal(res.kind, "card");
  assert.equal(res.specOrigin, "v3");
  assert.equal((res.rawJson.data as any).name, "新版莉莉");
});

test("CHARX unpacker rejects Zip-Slip and rewrites embeded:// single-d typo URIs", () => {
  assert.throws(() => sanitizeZipEntryPath("../evil.txt"), /traversal/i);
  assert.equal(rewriteEmbeddedAssetUri("embeded://assets/icon/main.png"), "assets/icon/main.png");
  assert.equal(rewriteEmbeddedAssetUri("embedded://other/bg.webp"), "assets/other/bg.webp");

  const cardJson = {
    spec: "chara_card_v3",
    data: {
      name: "克莱尔",
      description: "优雅的学者",
      assets: [{ type: "icon", uri: "embeded://assets/icon/main.png", name: "main", ext: "png" }],
    },
  };
  const zip = makeStoreZip([
    { name: "card.json", data: Buffer.from(JSON.stringify(cardJson)) },
    { name: "assets/icon/main.png", data: Buffer.from("PNGDATA") },
  ]);
  const res = unpackBuffer(zip, "claire.charx");
  assert.equal(res.kind, "card");
  assert.equal(res.specOrigin, "charx");
  assert.equal(res.assets.length, 1);

  const compiled = compileCharacterCard(res.rawJson, "charx");
  assert.equal(compiled.assets[0]?.localPath, "assets/icon/main.png");
});

test("Sanitizer strips deeply nested styled HTML status bars cleanly while preserving 100% prose & mes_example", () => {
  const dirtyDesc = [
    "她是钟楼的守望者，说话克制而温和。",
    `<div class="status-panel" style="background:#111"><div class="row"><div class="bar">HP: 100</div></div><div class="footer">状态</div></div>`,
    "<style>.hud{color:red}</style><script>window.ST = 1;</script>",
    "```update\n_.set('好感度', 40)\n```",
    "她腰间常挂着一枚铜哨。",
  ].join("\n");

  const sanitized = sanitizeFrontendShell(dirtyDesc, "description");
  assert.ok(sanitized.cleaned.includes("她是钟楼的守望者"));
  assert.ok(sanitized.cleaned.includes("她腰间常挂着一枚铜哨"));
  assert.ok(!sanitized.cleaned.includes("<div"));
  assert.ok(!sanitized.cleaned.includes("</div>"));
  assert.ok(!sanitized.cleaned.includes("status-panel"));
  assert.ok(!sanitized.cleaned.includes("<script>"));
  assert.ok(sanitized.stripped.length >= 3);

  // Also test display residual stripping for nested status blocks in AI output
  const aiOut = "她轻轻叹了口气。\n<div class=\"st-bar\"><div>HP 90</div></div>\n<UpdateVariable>{\"hp\":90}</UpdateVariable>\n「我们走吧。」";
  const cleaned = stripDisplayResiduals(aiOut);
  assert.ok(cleaned.includes("她轻轻叹了口气。"));
  assert.ok(cleaned.includes("「我们走吧。」"));
  assert.ok(!cleaned.includes("<div"));
  assert.ok(!cleaned.includes("UpdateVariable"));
});

test("Card compiler salvages MVU/YAML variables from RAW constant lore BEFORE sanitization and preserves 100% mes_example", () => {
  const rawExample = "<START>\n{{user}}: 你好？\n{{char}}: *微微颔首，将怀表合上。* 「时间不多了。」\n<START>\n{{user}}: 为什么？\n{{char}}: 「潮水快涨起来了。」";
  const rawCard = {
    spec: "chara_card_v2",
    data: {
      name: "艾琳",
      description: "守夜人艾琳。",
      mes_example: rawExample,
      first_mes: "「你终于来了，{{user}}。」",
      creator_notes: "仅供界面展示的作者说明",
      character_book: {
        entries: [
          {
            uid: 1,
            comment: "InitVar",
            constant: true,
            position: "before_char",
            content:
              "```yaml\nInitVar:\n  好感度: 25\n  理智值: 80\n```\n<UpdateVariable>{\"金币\": 150}</UpdateVariable>\n```js\n_.set('信任度', 10, 0, 100)\n```",
          },
        ],
      },
      extensions: {
        regex_scripts: [
          {
            scriptName: "CleanThink",
            findRegex: "/<think>[\\s\\S]*?<\\/think>/gi",
            replaceString: "",
            placement: [2],
            markdownOnly: true,
          },
          {
            scriptName: "UserOnlyRule",
            findRegex: "/foo/g",
            replaceString: "bar",
            placement: [1],
          },
          {
            scriptName: "ReplaceWithTrim",
            findRegex: "/{{char}}说：(.+)/g",
            replaceString: "『{{match}}』",
            trimStrings: ["{{char}}说："],
            substituteRegex: 1,
            placement: [2],
          },
        ],
      },
    },
  };

  const compiled = compileCharacterCard(rawCard, "v2");
  assert.equal(compiled.frozen.mesExample, rawExample);
  assert.equal(compiled.importReport.mesExampleCharsBefore, rawExample.length);
  assert.equal(compiled.importReport.mesExampleCharsAfter, rawExample.length);

  // All variables salvaged from RAW constant lore BEFORE sanitization stripped the fenced blocks!
  const keys = compiled.salvagedStateSchema.map((v) => v.key);
  assert.ok(keys.includes("好感度"), `Expected 好感度 in ${keys.join(",")}`);
  assert.ok(keys.includes("理智值"), `Expected 理智值 in ${keys.join(",")}`);
  assert.ok(keys.includes("金币"), `Expected 金币 in ${keys.join(",")}`);
  assert.ok(keys.includes("信任度"), `Expected 信任度 in ${keys.join(",")}`);

  // Placement=1 (USER_INPUT) must NOT appear in displayRegexRules
  assert.ok(compiled.displayRegexRules.every((r) => r.placements.includes(2)));
  assert.equal(compiled.displayRegexRules.length, 2);

  // Test applyDisplayRegexRules with substituteRegex + trimStrings + {{match}}
  const transformed = applyDisplayRegexRules(
    "<think>inner monologue</think>艾琳说：出发吧",
    compiled.displayRegexRules,
    { charName: "艾琳", userName: "旅人" },
  );
  assert.equal(transformed, "『出发吧』");
});

test("CCV3 decorators: independent @@exclude_keys, @@activate, @@scan_depth, and real @@@ fallback", () => {
  const dec = parseV3Decorators(
    [
      "@@activate_only_after 5",
      "@@activate_only_every 2",
      "@@keep_activate_after_match",
      "@@additional_keys 雾港,灯塔",
      "@@exclude_keys 梦境,幻觉",
      "@@scan_depth 8",
      "@@reverse_depth 2",
      "@@role system",
      "@@use_regex",
      "@@unknown_future_decorator 123",
      "@@@depth 3",
      "真正的内容正文",
    ].join("\n"),
  );

  assert.equal(dec.minTurn, 5);
  assert.equal(dec.everyNTurns, 2);
  assert.equal(dec.stickyPermanent, true);
  assert.deepEqual(dec.additionalKeys, ["雾港", "灯塔"]);
  assert.deepEqual(dec.excludeKeys, ["梦境", "幻觉"]);
  assert.equal(dec.scanDepthOverride, 8);
  assert.equal(dec.reverseDepth, 2);
  assert.equal(dec.roleOverride, "system");
  assert.equal(dec.useRegexOverride, true);
  // @@@depth 3 was applied ONLY because @@unknown_future_decorator wasn't supported!
  assert.equal(dec.depthOverride, 3);
  assert.equal(dec.cleanedContent, "真正的内容正文");

  // Ensure @@exclude_keys does NOT clobber selectiveLogic="AND_ANY" & secondaryKeys!
  const book = compileLoreBook({
    entries: [
      {
        uid: 10,
        comment: "密室",
        keys: ["密室"],
        secondary_keys: ["钥匙"],
        selective: true,
        selectiveLogic: 0, // AND_ANY
        content: "@@exclude_keys 梦境\n真正的密室藏在书架后。",
      },
    ],
  });
  const entry = book.entries[0]!;
  assert.equal(entry.selectiveLogic, "AND_ANY");
  assert.deepEqual(entry.secondaryKeys, ["钥匙"]);
  assert.deepEqual(entry.excludeKeys, ["梦境"]);

  // Inline regex parser
  assert.deepEqual(parseInlineRegexKey("/dragon|wyvern/i"), { pattern: "dragon|wyvern", flags: "i" });
  assert.equal(parseInlineRegexKey("plain keyword"), null);
});

test("SillyTavern macro parity: legacy {{random:a,b}}, deterministic {{pick}}, {{trim}}, {{outlet::name}}, {{roll:d20}}", () => {
  const ctx = {
    charName: "莉娜",
    userName: "阿泽",
    personaDescription: "背着旧相机的记者",
    groupMembers: ["莉娜", "艾琳"],
    vars: { gold: 42 },
    outlets: { weather: "窗外正下着细雨。" },
    lastUserMessage: "我们进屋吧",
  };

  assert.equal(evaluateMacros("{{char}}对{{user}}说：{{persona}}", ctx), "莉娜对阿泽说：背着旧相机的记者");
  assert.equal(evaluateMacros("{{group}} / {{charIfNotGroup}}", ctx), "莉娜, 艾琳 / 莉娜, 艾琳");
  assert.equal(evaluateMacros("天气：{{outlet::weather}}", ctx), "天气：窗外正下着细雨。");
  assert.equal(evaluateMacros("A   {{trim}}   B", ctx), "AB");
  assert.equal(evaluateMacros("上次：{{lastUserMessage}}", ctx), "上次：我们进屋吧");

  // Legacy {{random:a,b,c}}
  const r = evaluateMacros("{{random:晴天,雨天,大雾}}", ctx);
  assert.ok(["晴天", "雨天", "大雾"].includes(r));

  // Deterministic {{pick::x::y::z}} produces identical output for same input
  const p1 = evaluateMacros("{{pick::红茶::咖啡::清酒}}", ctx);
  const p2 = evaluateMacros("{{pick::红茶::咖啡::清酒}}", ctx);
  assert.equal(p1, p2);
  assert.ok(["红茶", "咖啡", "清酒"].includes(p1));

  // {{roll:d20}} shorthand works
  const rolled = Number(evaluateMacros("{{roll:d20}}", ctx));
  assert.ok(Number.isInteger(rolled) && rolled >= 1 && rolled <= 20);
});

test("ST Preset compiler splits Zone 1 / Zone 3 cleanly and strips HTML/CoT jailbreak debris", () => {
  const rawPreset = {
    temperature: 0.85,
    prompts: [
      { identifier: "main", name: "Main", role: "system", content: "Write vivid literary fiction." },
      { identifier: "chatHistory", name: "Chat History", marker: true },
      { identifier: "jb", name: "Tail", role: "system", content: "<div style='color:red'>bad</div>Keep pacing natural." },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "jb", enabled: true },
        ],
      },
    ],
  };
  const compiled = compileSillyTavernPreset(rawPreset, { name: "my-preset" });
  assert.equal(compiled.zone1Prompts.length, 1);
  assert.equal(compiled.zone3Prompts.length, 1);
  assert.ok(!compiled.zone3Prompts[0]!.content.includes("<div"));
  assert.ok(compiled.zone3Prompts[0]!.content.includes("Keep pacing natural."));
});

test("Humanized File Picker normalizes drag-drop paths and auto-sniffs PNG/JSON assets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rp-picker-"));
  try {
    const cardPath = path.join(tmpDir, "hero.json");
    fs.writeFileSync(
      cardPath,
      JSON.stringify({ spec: "chara_card_v3", data: { name: "测试英雄", description: "勇敢的剑士" } }),
    );
    const presetPath = path.join(tmpDir, "style.json");
    fs.writeFileSync(presetPath, JSON.stringify({ temperature: 0.9, prompts: [] }));
    const unrelatedPath = path.join(tmpDir, "notes.json");
    fs.writeFileSync(unrelatedPath, JSON.stringify({ hello: "world" }));

    assert.equal(inspectImportFileQuick(cardPath)?.badge, "[角色卡 V3]");
    assert.equal(inspectImportFileQuick(presetPath)?.badge, "[酒馆预设]");
    assert.equal(inspectImportFileQuick(unrelatedPath), null);

    // Drag-and-drop quoted & escaped path normalization
    assert.equal(normalizeUserFilePath(`"${cardPath}"`, tmpDir), cardPath);
    assert.equal(normalizeUserFilePath(`'${cardPath}'`, tmpDir), cardPath);

    // Auto-discovery finds valid assets and skips unrelated JSON
    const found = smartDiscoverRpFiles(tmpDir, 10);
    const names = found.map((f) => f.name);
    assert.ok(names.includes("hero.json"));
    assert.ok(names.includes("style.json"));
    assert.ok(!names.includes("notes.json"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
