import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as zlib from "node:zlib";
import {
  extractPngCardJson,
  readZipEntries,
  rewriteEmbeddedAssetUri,
  sanitizeZipEntryPath,
  unpackBuffer,
} from "../src/parser/unpack.js";
import { compileCharacterCard } from "../src/parser/card-compiler.js";
import { compileLoreBook, isSafeRegexPattern, parseV3Decorators } from "../src/parser/lore-compiler.js";
import { compileSillyTavernPreset } from "../src/parser/preset.js";
import { evaluateMacros } from "../src/parser/macros.js";
import {
  deduplicateBoilerplateAcrossFields,
  sanitizeFrontendShell,
  stripDisplayResiduals,
} from "../src/parser/sanitizer.js";

/** Helper: build a minimal valid PNG with custom tEXt chunks. */
function makePngWithTextChunks(chunks: Array<{ key: string; text: string }>): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Buffer[] = [sig];
  const writeChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); // CRC not checked by unpacker
    parts.push(len, typeBuf, data, crc);
  };
  for (const c of chunks) {
    const data = Buffer.concat([Buffer.from(c.key, "latin1"), Buffer.from([0]), Buffer.from(c.text, "latin1")]);
    writeChunk("tEXt", data);
  }
  writeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat(parts);
}

/** Helper: build a minimal valid ZIP archive in memory (stored or deflated). */
function makeZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const compressed = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);

    localParts.push(lfh, nameBuf, compressed);
    cdParts.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

describe("Phase 1 · Container Unpacker (PNG, .charx, JSON)", () => {
  it("strictly prefers ccv3 chunk over chara chunk in PNG cards", () => {
    const v2 = { spec: "chara_card_v2", data: { name: "OldV2", description: "v2" } };
    const v3 = { spec: "chara_card_v3", data: { name: "NewV3", nickname: "V3Nick", description: "v3" } };
    const png = makePngWithTextChunks([
      { key: "chara", text: Buffer.from(JSON.stringify(v2)).toString("base64") },
      { key: "ccv3", text: Buffer.from(JSON.stringify(v3)).toString("base64") },
    ]);
    const res = extractPngCardJson(png);
    assert.equal(res.chunkKey, "ccv3");
    assert.equal((res.rawJson.data as Record<string, unknown>).name, "NewV3");
  });

  it("unpacks .charx ZIP safely, rejects Zip-Slip, and rewrites embeded:// URIs", () => {
    const cardJson = {
      spec: "chara_card_v3",
      data: {
        name: "黑水",
        description: "冻土与暴风雪",
        assets: [
          { type: "emotion", name: "snow", uri: "embeded://assets/snow.png", ext: "png" },
          { type: "live2d", name: "model", uri: "embedded://assets/model.moc3", ext: "moc3" },
        ],
      },
    };
    const zip = makeZip([
      { name: "card.json", data: Buffer.from(JSON.stringify(cardJson), "utf8"), deflate: true },
      { name: "assets/snow.png", data: Buffer.from("fake-png") },
    ]);
    const unpacked = unpackBuffer(zip, "guandong.charx");
    assert.equal(unpacked.kind, "card");
    assert.equal(unpacked.specOrigin, "charx");
    assert.equal(unpacked.assets.length, 1);

    const compiled = compileCharacterCard(unpacked.rawJson, unpacked.specOrigin);
    assert.equal(compiled.assets.length, 1);
    assert.equal(compiled.assets[0]!.localPath, "assets/snow.png");
    assert.equal(compiled.importReport.skippedAssets.length, 1);
    assert.equal(compiled.importReport.skippedAssets[0]!.type, "live2d");

    assert.equal(rewriteEmbeddedAssetUri("embeded://foo/bar.png"), "assets/foo/bar.png");
    assert.throws(() => sanitizeZipEntryPath("../etc/passwd"), /Zip-Slip/);

    const evilZip = makeZip([{ name: "../../evil.txt", data: Buffer.from("boom") }]);
    assert.throws(() => readZipEntries(evilZip), /Zip-Slip/);
  });
});

describe("Phase 1 · Fidelity Sanitizer, MVU Salvage & Lorebook Compiler", () => {
  it("preserves 100% of mes_example and jailbreak while surgically stripping 1.0 HTML/MVU shells", () => {
    const mesExample = "<START>\n{{user}}: 你好\n{{char}}: <微微皱眉> 风雪太大了，进屋再说。";
    const cardJson = {
      spec: "chara_card_v3",
      data: {
        name: "柳春娘",
        system_prompt:
          "保持第三人称有限视角，冷峻白描。\n严禁替{{user}}决策、行动或发言。\n<script>alert(1)</script><style>.hud{color:red}</style>",
        description:
          "明末流民厨娘。<div style=\"display:flex;background:#111\">HP:100</div>",
        mes_example: mesExample,
        post_history_instructions:
          "保持心理描写克制。\n不要替{{user}}行动或发言。\n<UpdateVariable>{\"hp\": 85, \"silver\": 12}</UpdateVariable>",
        first_mes: "雪下了一夜。\n{{setvar::hunger::30}}\n<StatusPlaceHolderImpl/>",
        extensions: {
          depth_prompt: { prompt: "始终维持时代质感，绝不使用现代网络词。", depth: 2, role: "system" },
          regex_scripts: [
            { scriptName: "HTML Status Card", findRegex: "/<status>/g", replaceString: "<div class=\"card\">$1</div>" },
            { scriptName: "Clean Extra Space", findRegex: "/  +/g", replaceString: " " },
          ],
        },
        character_book: {
          token_budget: 2048,
          entries: [
            {
              id: "e1",
              comment: "关东粮价",
              keys: ["粮价", "米"],
              secondary_keys: ["太平"],
              selective: true,
              selectiveLogic: 2, // NOT_ANY
              delay: 3,
              sticky: 2,
              cooldown: 4,
              content: "@@activate_only_after 5\n@@keep_activate_after_match\n@@exclude_keys 丰收\n崇祯末年关外粮价暴涨。",
            },
            {
              id: "e2",
              comment: "常驻基调",
              constant: true,
              position: 0,
              content: "极寒与荒年是全剧底色。",
            },
          ],
        },
      },
    };

    const compiled = compileCharacterCard(cardJson, "v3");
    // 100% mes_example retention (including literary <微微皱眉>)
    assert.equal(compiled.frozen.mesExample, mesExample);
    assert.equal(compiled.importReport.mesExampleCharsBefore, compiled.importReport.mesExampleCharsAfter);
    // Jailbreak / style rules 100% preserved, script/style/div/MVU stripped
    assert.ok(compiled.frozen.systemPrompt.includes("保持第三人称有限视角，冷峻白描。"));
    assert.ok(!compiled.frozen.systemPrompt.includes("<script>"));
    assert.ok(!compiled.frozen.description.includes("display:flex"));
    assert.ok(compiled.tailInstructions.postHistoryInstructions.includes("保持心理描写克制。"));
    assert.ok(!compiled.tailInstructions.postHistoryInstructions.includes("UpdateVariable"));
    assert.equal(compiled.tailInstructions.depthPrompt?.content, "始终维持时代质感，绝不使用现代网络词。");
    // Duplicate anti-godmoding deduplicated (kept in system_prompt, removed in post_history)
    assert.equal(compiled.importReport.deduplicatedRules.length, 1);
    assert.equal(compiled.importReport.deduplicatedRules[0]!.field, "post_history_instructions");
    // MVU & macro variables salvaged
    const keys = compiled.salvagedStateSchema.map((v) => v.key);
    assert.ok(keys.includes("hp"));
    assert.ok(keys.includes("silver"));
    assert.ok(keys.includes("hunger"));
    // Frontend regex stripped, pure-text regex kept
    assert.equal(compiled.displayRegexRules.length, 1);
    assert.equal(compiled.displayRegexRules[0]!.name, "Clean Extra Space");
    // Lorebook decorators & gate compiled
    const e1 = compiled.loreBook.entries.find((e) => e.id === "e1")!;
    assert.equal(e1.gate?.minTurn, 5);
    assert.equal(e1.stickyPermanent, true);
    assert.ok(!e1.content.includes("@@"));
    assert.ok(e1.secondaryKeys.includes("丰收"));
    assert.deepEqual(compiled.frozen.constantLoreIds, ["e2"]);
  });

  it("supports rawPassthrough mode without stripping or deduplicating", () => {
    const html = "<div style=\"display:flex\">keep me</div>";
    const { cleaned } = sanitizeFrontendShell(html, "description", true);
    assert.equal(cleaned, html);

    const dedup = deduplicateBoilerplateAcrossFields(
      [
        { field: "a", text: "严禁替{{user}}说话" },
        { field: "b", text: "严禁替{{user}}说话" },
      ],
      true,
    );
    assert.equal(dedup.deduplicated.length, 0);
    assert.equal(stripDisplayResiduals("正文<UpdateVariable>x</UpdateVariable>结尾"), "正文结尾");
  });

  it("handles ReDoS-unsafe regexes and V3 decorators safely", () => {
    assert.equal(isSafeRegexPattern("(a+)+$"), false);
    assert.equal(isSafeRegexPattern("关东|老金沟"), true);
    const dec = parseV3Decorators("@@dont_activate\n@@activate_only_every 3\n@@additional_keys 冰原,黑水\n真正正文");
    assert.equal(dec.manualRecallOnly, true);
    assert.equal(dec.everyNTurns, 3);
    assert.deepEqual(dec.additionalKeys, ["冰原", "黑水"]);
    assert.equal(dec.cleanedContent, "真正正文");

    const dictBook = compileLoreBook({
      entries: {
        "0": { uid: 0, comment: "坏正则", key: ["(a+)+$"], use_regex: true, content: "正文" },
      },
    });
    assert.equal(dictBook.entries[0]!.useRegex, false);
    assert.equal(dictBook.warnings.length, 1);
  });

  it("evaluates macros safely and never leaks raw setvar/comments", () => {
    const out = evaluateMacros(
      "{{// secret comment}}{{char}}看着{{user}}，骰出{{roll:1d6+2}}点，随机{{random::雪::霜}}，银两{{getvar::silver}}{{setvar::x::1}}",
      { charName: "黑水", userName: "阿明", vars: { silver: 12 }, deterministicSeed: 42 },
    );
    assert.ok(out.startsWith("黑水看着阿明"));
    assert.ok(out.includes("银两12"));
    assert.ok(!out.includes("{{"));
  });
});

describe("Phase 1 · SillyTavern OpenAI Preset Compiler", () => {
  it("splits enabled prompts into Zone 1 (before chatHistory) and Zone 3 (after chatHistory / @D) cleanly", () => {
    const stPreset = {
      name: "文学白描预设",
      temperature: 0.85,
      top_p: 0.92,
      openai_max_tokens: 4096,
      continue_nudge_prompt: "请紧接上文继续写，不要重复。",
      impersonation_prompt: "以玩家口吻给出下一步行动。",
      prompts: [
        { identifier: "main", name: "Main", role: "system", content: "你是文学级叙事引擎。" },
        { identifier: "style", name: "Style", role: "system", content: "多用感官细节。<style>.x{}</style>" },
        { identifier: "chatHistory", name: "Chat History", marker: true },
        { identifier: "depth_rule", name: "Depth Rule", role: "system", content: "保持悬念。", injection_position: 1, injection_depth: 2 },
        { identifier: "jailbreak", name: "Post", role: "system", content: "遵守人物逻辑，不强行说教。" },
        { identifier: "disabled_one", name: "Off", role: "system", content: "不应出现" },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "style", enabled: true },
            { identifier: "disabled_one", enabled: false },
            { identifier: "chatHistory", enabled: true },
            { identifier: "depth_rule", enabled: true },
            { identifier: "jailbreak", enabled: true },
          ],
        },
      ],
    };

    const unpacked = unpackBuffer(Buffer.from(JSON.stringify(stPreset), "utf8"), "preset.json");
    assert.equal(unpacked.kind, "preset");

    const compiled = compileSillyTavernPreset(unpacked.rawJson);
    assert.equal(compiled.zone1Prompts.length, 2);
    assert.equal(compiled.zone1Prompts[0]!.identifier, "main");
    assert.ok(!compiled.zone1Prompts[1]!.content.includes("<style>"));
    assert.equal(compiled.zone3Prompts.length, 2);
    // Depth 2 comes before depth 0 (closest to generation)
    assert.equal(compiled.zone3Prompts[0]!.identifier, "depth_rule");
    assert.equal(compiled.zone3Prompts[1]!.identifier, "jailbreak");
    assert.equal(compiled.sampling.temperature, 0.85);
    assert.equal(compiled.utilityPrompts.continueNudge, "请紧接上文继续写，不要重复。");
  });
});
