/**
 * Zero-dependency container unpacker for SillyTavern / RisuAI / Chub formats:
 *  - PNG character cards: scans tEXt / iTXt / zTXt chunks, strictly preferring `ccv3` over `chara`.
 *  - .charx (CCV3 ZIP): parses ZIP EOCD & Central Directory via Node built-in zlib,
 *    with strict Zip-Slip protection, entry count & total uncompressed size caps, and `embeded://` rewriting.
 *  - Standalone JSON: auto-sniffs CCV3, CCV2, V1, Standalone Lorebook (array or dict), and ST OpenAI Preset.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { CardSpecOrigin } from "../types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_TEXT_BYTES = 16 * 1024 * 1024; // 16 MiB cap for inflated PNG text chunks
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MiB cap

export interface UnpackedAsset {
  entryName: string;
  data: Buffer;
}

export type UnpackedInput =
  | {
      kind: "card";
      specOrigin: CardSpecOrigin;
      rawJson: Record<string, unknown>;
      avatarPng?: Buffer;
      assets: UnpackedAsset[];
      warnings: string[];
    }
  | {
      kind: "lorebook";
      rawJson: Record<string, unknown>;
      warnings: string[];
    }
  | {
      kind: "preset";
      rawJson: Record<string, unknown>;
      warnings: string[];
    };

/** Parse a PNG buffer and extract `ccv3` (preferred) or `chara` JSON payload. */
export function extractPngCardJson(buf: Buffer): {
  rawJson: Record<string, unknown>;
  chunkKey: "ccv3" | "chara";
  warnings: string[];
} {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Invalid PNG file: missing 8-byte PNG signature");
  }

  const warnings: string[] = [];
  const found = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) {
      warnings.push(`Truncated PNG chunk "${type}" at offset ${offset}`);
      break;
    }
    const chunkData = buf.subarray(dataStart, dataEnd);

    if (type === "tEXt") {
      const nul = chunkData.indexOf(0);
      if (nul > 0) {
        const key = chunkData.subarray(0, nul).toString("latin1").toLowerCase();
        if (key === "ccv3" || key === "chara") {
          const valueBytes = chunkData.subarray(nul + 1);
          const utf8Candidate = valueBytes.toString("utf8").replace(/^\uFEFF/, "").trim();
          found.set(key, utf8Candidate.startsWith("{") ? utf8Candidate : valueBytes.toString("latin1"));
        }
      }
    } else if (type === "zTXt") {
      const nul = chunkData.indexOf(0);
      if (nul > 0 && nul + 2 <= chunkData.length) {
        const key = chunkData.subarray(0, nul).toString("latin1").toLowerCase();
        const compressionMethod = chunkData[nul + 1];
        if ((key === "ccv3" || key === "chara") && compressionMethod === 0) {
          try {
            const inflated = zlib.inflateSync(chunkData.subarray(nul + 2), {
              maxOutputLength: MAX_PNG_TEXT_BYTES,
            });
            found.set(key, inflated.toString("utf8"));
          } catch (err) {
            warnings.push(`Failed to inflate zTXt chunk "${key}": ${(err as Error).message}`);
          }
        } else if (key === "ccv3" || key === "chara") {
          warnings.push(`Unsupported zTXt compression method ${compressionMethod} in chunk "${key}"`);
        }
      }
    } else if (type === "iTXt") {
      const nul = chunkData.indexOf(0);
      if (nul > 0 && nul + 3 <= chunkData.length) {
        const key = chunkData.subarray(0, nul).toString("latin1").toLowerCase();
        if (key === "ccv3" || key === "chara") {
          const compressionFlag = chunkData[nul + 1];
          const compressionMethod = chunkData[nul + 2];
          const langEnd = chunkData.indexOf(0, nul + 3);
          const transEnd = langEnd >= 0 ? chunkData.indexOf(0, langEnd + 1) : -1;
          if (transEnd >= 0) {
            const textBytes = chunkData.subarray(transEnd + 1);
            try {
              if (compressionFlag === 1) {
                if (compressionMethod !== 0) {
                  warnings.push(`Unsupported iTXt compression method ${compressionMethod} in chunk "${key}"`);
                } else {
                  const decoded = zlib
                    .inflateSync(textBytes, { maxOutputLength: MAX_PNG_TEXT_BYTES })
                    .toString("utf8");
                  found.set(key, decoded);
                }
              } else if (compressionFlag === 0) {
                found.set(key, textBytes.toString("utf8"));
              } else {
                warnings.push(`Unsupported iTXt compression flag ${compressionFlag} in chunk "${key}"`);
              }
            } catch (err) {
              warnings.push(`Failed to decode iTXt chunk "${key}": ${(err as Error).message}`);
            }
          }
        }
      }
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  const candidates: Array<"ccv3" | "chara"> = [];
  if (found.has("ccv3")) candidates.push("ccv3");
  if (found.has("chara")) candidates.push("chara");

  if (candidates.length === 0) {
    throw new Error("PNG does not contain a ccv3 or chara metadata chunk");
  }

  let lastError: Error | null = null;
  for (const key of candidates) {
    try {
      const payload = found.get(key)!.replace(/^\uFEFF/, "").trim();
      const jsonText = (payload.startsWith("{") ? payload : Buffer.from(payload, "base64").toString("utf8"))
        .replace(/^\uFEFF/, "")
        .trim();

      const parsed = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`PNG ${key} payload is not a JSON object`);
      }
      return { rawJson: parsed as Record<string, unknown>, chunkKey: key, warnings };
    } catch (err) {
      lastError = err as Error;
      if (key === "ccv3" && candidates.includes("chara")) {
        warnings.push(`Failed to parse PNG ccv3 chunk, falling back to chara: ${lastError.message}`);
      }
    }
  }

  throw lastError ?? new Error("Failed to parse PNG card metadata");
}

/** Validate a ZIP entry path against Zip-Slip traversal attacks. */
export function sanitizeZipEntryPath(entryName: string): string {
  if (!entryName || entryName.includes("\0")) {
    throw new Error(`Unsafe ZIP entry path: "${entryName}"`);
  }
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Unsafe ZIP entry path: "${entryName}"`);
  }
  const rawSegments = normalized.split("/");
  const segments: string[] = [];
  for (const seg of rawSegments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      throw new Error(`Zip-Slip traversal detected in entry: "${entryName}"`);
    }
    if (/^[a-z]:/i.test(seg)) {
      throw new Error(`Unsafe ZIP entry path: "${entryName}"`);
    }
    segments.push(seg);
  }
  if (segments.length === 0) {
    throw new Error(`Unsafe ZIP entry path: "${entryName}"`);
  }
  return segments.join("/");
}

/**
 * Pure-Node ZIP reader supporting stored (method 0) and deflated (method 8) entries,
 * with strict Zip-Slip, entry count, and uncompressed byte limits.
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const minEocd = 22;
  if (buf.length < minEocd) {
    throw new Error("Invalid ZIP/CHARX buffer: too short");
  }
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let pos = buf.length - minEocd; pos >= searchStart; pos--) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(pos + 20);
      if (pos + minEocd + commentLen === buf.length) {
        eocdOffset = pos;
        break;
      }
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP/CHARX buffer: EOCD record not found");
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP/CHARX exceeds entry limit (${totalEntries} > ${MAX_ZIP_ENTRIES})`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new Error("Invalid ZIP/CHARX: central directory out of bounds");
  }

  const entries = new Map<string, Buffer>();
  let actualTotalBytes = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory header at index ${i}`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue;

    const safeName = sanitizeZipEntryPath(rawName);
    if (actualTotalBytes >= MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`ZIP/CHARX exceeds uncompressed size limit (${MAX_ZIP_TOTAL_BYTES} bytes)`);
    }

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local file header for "${safeName}"`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated ZIP entry data for "${safeName}"`);
    }

    const compressed = buf.subarray(dataStart, dataEnd);
    const remainingBudget = MAX_ZIP_TOTAL_BYTES - actualTotalBytes;
    let data: Buffer;
    if (method === 0) {
      if (compressed.length > remainingBudget) {
        throw new Error(`ZIP/CHARX exceeds uncompressed size limit (${MAX_ZIP_TOTAL_BYTES} bytes)`);
      }
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, remainingBudget) });
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for "${safeName}"`);
    }

    actualTotalBytes += data.length;
    if (actualTotalBytes > MAX_ZIP_TOTAL_BYTES) {
      throw new Error(`ZIP/CHARX exceeds uncompressed size limit (${MAX_ZIP_TOTAL_BYTES} bytes)`);
    }

    entries.set(safeName, data);
  }

  return entries;
}

/** Rewrite CCV3 `embeded://` (historical single-d typo) and `embedded://` URIs to workspace-relative paths. */
export function rewriteEmbeddedAssetUri(uri: string, assetsPrefix = "assets"): string {
  const m = /^embedd?ed:\/\/(.+)$/i.exec(uri.trim());
  if (!m) return uri;
  const rel = sanitizeZipEntryPath(m[1]!);
  if (rel.startsWith(`${assetsPrefix}/`)) return rel;
  return `${assetsPrefix}/${rel}`;
}

/** Auto-sniff a parsed JSON object into Card (V1/V2/V3), Lorebook, or ST OpenAI Preset. */
export function sniffJsonInput(obj: Record<string, unknown>): UnpackedInput {
  const spec = typeof obj.spec === "string" ? obj.spec : "";
  if (spec === "chara_card_v3") {
    return { kind: "card", specOrigin: "v3", rawJson: obj, assets: [], warnings: [] };
  }
  if (spec === "chara_card_v2") {
    return { kind: "card", specOrigin: "v2", rawJson: obj, assets: [], warnings: [] };
  }
  if (
    Array.isArray(obj.prompts) &&
    (Array.isArray(obj.prompt_order) ||
      typeof obj.temperature === "number" ||
      typeof obj.openai_max_context === "number")
  ) {
    return { kind: "preset", rawJson: obj, warnings: [] };
  }
  if (
    obj.entries !== undefined &&
    (Array.isArray(obj.entries) || (typeof obj.entries === "object" && obj.entries !== null))
  ) {
    return { kind: "lorebook", rawJson: obj, warnings: [] };
  }
  if (typeof obj.name === "string" && (typeof obj.description === "string" || typeof obj.first_mes === "string")) {
    return { kind: "card", specOrigin: "v1", rawJson: obj, assets: [], warnings: [] };
  }
  throw new Error(
    "无法识别的 JSON 格式：请提供 V1/V2/V3 角色卡、独立世界书（含 entries）或 SillyTavern 对话预设（含 prompts）。",
  );
}

/** Unpack a file from disk (`.png`, `.charx`, `.zip`, `.json`) or buffer with filename hint. */
export function unpackBuffer(buf: Buffer, filename = "input.json"): UnpackedInput {
  const ext = path.extname(filename).toLowerCase();

  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const { rawJson, chunkKey, warnings } = extractPngCardJson(buf);
    const specOrigin: CardSpecOrigin =
      chunkKey === "ccv3" || rawJson.spec === "chara_card_v3"
        ? "v3"
        : rawJson.spec === "chara_card_v2"
          ? "v2"
          : "v1";
    return {
      kind: "card",
      specOrigin,
      rawJson,
      avatarPng: buf,
      assets: [],
      warnings,
    };
  }

  if (ext === ".charx" || ext === ".zip" || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
    const entries = readZipEntries(buf);
    const cardBuf = entries.get("card.json");
    if (!cardBuf) {
      throw new Error(".charx 压缩包缺少根目录 card.json");
    }
    const rawJson = JSON.parse(cardBuf.toString("utf8").replace(/^\uFEFF/, "").trim()) as Record<string, unknown>;
    const assets: UnpackedAsset[] = [];
    for (const [entryName, data] of entries.entries()) {
      if (entryName === "card.json") continue;
      assets.push({ entryName, data });
    }
    return {
      kind: "card",
      specOrigin: "charx",
      rawJson,
      assets,
      warnings: [],
    };
  }

  const text = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON 文件顶层必须是对象");
  }
  return sniffJsonInput(parsed as Record<string, unknown>);
}

export function unpackFile(filePath: string): UnpackedInput {
  const buf = fs.readFileSync(filePath);
  return unpackBuffer(buf, path.basename(filePath));
}

/**
 * Fast, non-compiling asset sniffer for the interactive file picker.
 * Verifies PNG `ccv3`/`chara` chunks (never decodes pixels), `.charx` archives,
 * and JSON character cards / worldbooks / presets.
 */
export function inspectImportFileQuick(
  filePath: string,
): { kind: "card" | "lorebook" | "preset"; badge: string } | null {
  const ext = path.extname(filePath).toLowerCase();
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    if (ext === ".charx") {
      return { kind: "card", badge: "[角色卡 CHARX]" };
    }
    if (ext === ".png") {
      if (stat.size > 35 * 1024 * 1024) return null;
      const buf = fs.readFileSync(filePath);
      if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
      const { chunkKey, rawJson } = extractPngCardJson(buf);
      const isV3 = chunkKey === "ccv3" || rawJson.spec === "chara_card_v3";
      return { kind: "card", badge: isV3 ? "[角色卡 V3]" : "[角色卡 V2]" };
    }
    if (ext === ".json") {
      if (stat.size > 12 * 1024 * 1024) return null;
      const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const sniffed = sniffJsonInput(parsed as Record<string, unknown>);
      if (sniffed.kind === "preset") return { kind: "preset", badge: "[酒馆预设]" };
      if (sniffed.kind === "lorebook") return { kind: "lorebook", badge: "[世界书]" };
      return {
        kind: "card",
        badge: sniffed.specOrigin === "v3" ? "[角色卡 V3]" : sniffed.specOrigin === "v2" ? "[角色卡 V2]" : "[角色卡 V1]",
      };
    }
  } catch {
    return null;
  }
  return null;
}
