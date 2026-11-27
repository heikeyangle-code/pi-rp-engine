/**
 * Zero-dependency container unpacker for SillyTavern / RisuAI / Chub formats:
 *  - PNG character cards: scans tEXt / iTXt / zTXt chunks, strictly preferring `ccv3` over `chara`.
 *  - .charx (CCV3 ZIP): parses ZIP End-of-Central-Directory & Central Directory via Node built-in zlib,
 *    with strict Zip-Slip protection, entry count & total uncompressed size caps, and `embeded://` rewriting.
 *  - Standalone JSON: auto-sniffs CCV3, CCV2, V1, Standalone Lorebook (array or dict), and ST OpenAI Preset.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { CardSpecOrigin } from "../types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
          found.set(key, chunkData.subarray(nul + 1).toString("latin1"));
        }
      }
    } else if (type === "zTXt") {
      const nul = chunkData.indexOf(0);
      if (nul > 0 && nul + 2 <= chunkData.length) {
        const key = chunkData.subarray(0, nul).toString("latin1").toLowerCase();
        const compressionMethod = chunkData[nul + 1];
        if ((key === "ccv3" || key === "chara") && compressionMethod === 0) {
          try {
            const inflated = zlib.inflateSync(chunkData.subarray(nul + 2));
            found.set(key, inflated.toString("utf8"));
          } catch (err) {
            warnings.push(`Failed to inflate zTXt chunk "${key}": ${(err as Error).message}`);
          }
        }
      }
    } else if (type === "iTXt") {
      const nul = chunkData.indexOf(0);
      if (nul > 0 && nul + 3 <= chunkData.length) {
        const key = chunkData.subarray(0, nul).toString("latin1").toLowerCase();
        if (key === "ccv3" || key === "chara") {
          const compressionFlag = chunkData[nul + 1];
          const compressionMethod = chunkData[nul + 2];
          // Skip language tag (\0) and translated keyword (\0)
          const langEnd = chunkData.indexOf(0, nul + 3);
          const transEnd = langEnd >= 0 ? chunkData.indexOf(0, langEnd + 1) : -1;
          if (transEnd >= 0) {
            const textBytes = chunkData.subarray(transEnd + 1);
            try {
              const decoded =
                compressionFlag === 1 && compressionMethod === 0
                  ? zlib.inflateSync(textBytes).toString("utf8")
                  : textBytes.toString("utf8");
              found.set(key, decoded);
            } catch (err) {
              warnings.push(`Failed to decode iTXt chunk "${key}": ${(err as Error).message}`);
            }
          }
        }
      }
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4; // skip 4-byte CRC
  }

  const chosenKey: "ccv3" | "chara" | null = found.has("ccv3")
    ? "ccv3"
    : found.has("chara")
      ? "chara"
      : null;

  if (!chosenKey) {
    throw new Error("PNG does not contain a ccv3 or chara metadata chunk");
  }

  const payload = found.get(chosenKey)!.trim();
  let jsonText: string;
  if (payload.startsWith("{")) {
    jsonText = payload;
  } else {
    jsonText = Buffer.from(payload, "base64").toString("utf8");
  }

  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`PNG ${chosenKey} payload is not a JSON object`);
  }
  return { rawJson: parsed as Record<string, unknown>, chunkKey: chosenKey, warnings };
}

/** Validate a ZIP entry path against Zip-Slip traversal attacks. */
export function sanitizeZipEntryPath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`Unsafe ZIP entry path: "${entryName}"`);
  }
  const segments = normalized.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new Error(`Zip-Slip traversal detected in entry: "${entryName}"`);
    }
  }
  return segments.join("/");
}

/**
 * Pure-Node ZIP reader supporting stored (method 0) and deflated (method 8) entries,
 * with strict Zip-Slip, entry count, and uncompressed byte limits.
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of file.
  const minEocd = 22;
  if (buf.length < minEocd) {
    throw new Error("Invalid ZIP/CHARX buffer: too short");
  }
  const searchStart = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let pos = buf.length - minEocd; pos >= searchStart; pos--) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
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
  let totalUncompressed = 0;
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory header at index ${i}`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue; // directory entry

    const safeName = sanitizeZipEntryPath(rawName);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_TOTAL_BYTES) {
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
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_TOTAL_BYTES });
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for "${safeName}"`);
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
  // SillyTavern OpenAI / Chat Completion Preset
  if (Array.isArray(obj.prompts) && (Array.isArray(obj.prompt_order) || typeof obj.temperature === "number" || typeof obj.openai_max_context === "number")) {
    return { kind: "preset", rawJson: obj, warnings: [] };
  }
  // Standalone Lorebook / World Info (entries as array or keyed object dictionary)
  if (obj.entries !== undefined && (Array.isArray(obj.entries) || (typeof obj.entries === "object" && obj.entries !== null))) {
    return { kind: "lorebook", rawJson: obj, warnings: [] };
  }
  // V1 character card (flat fields at root)
  if (typeof obj.name === "string" && (typeof obj.description === "string" || typeof obj.first_mes === "string")) {
    return { kind: "card", specOrigin: "v1", rawJson: obj, assets: [], warnings: [] };
  }
  throw new Error("Unrecognized JSON schema: expected CCV3/CCV2/V1 card, standalone lorebook, or SillyTavern preset");
}

/** Unpack a file from disk (`.png`, `.charx`, `.zip`, `.json`) or buffer with filename hint. */
export function unpackBuffer(buf: Buffer, filename = "input.json"): UnpackedInput {
  const ext = path.extname(filename).toLowerCase();

  // PNG magic bytes take precedence
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

  // ZIP / .charx magic bytes (PK\x03\x04)
  if (ext === ".charx" || ext === ".zip" || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
    const entries = readZipEntries(buf);
    const cardBuf = entries.get("card.json");
    if (!cardBuf) {
      throw new Error(".charx archive is missing root card.json");
    }
    const rawJson = JSON.parse(cardBuf.toString("utf8")) as Record<string, unknown>;
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

  // JSON
  const text = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON input must be an object");
  }
  return sniffJsonInput(parsed as Record<string, unknown>);
}

export function unpackFile(filePath: string): UnpackedInput {
  const buf = fs.readFileSync(filePath);
  return unpackBuffer(buf, path.basename(filePath));
}
