/**
 * Passive asset library storage for pi-rp-engine (ZERO auto-activation across sessions!):
 *  - Project Asset Library: `<cwd>/.pi/rp/` (cards/, presets/, personas.json)
 *  - Global Asset Library:  `~/.pi/agent/rp-library/` (shared cards/, presets/, personas.json)
 *
 * IMPORTANT: Storing a card in `.pi/rp/` NEVER auto-activates RP mode in other sessions.
 * Only an explicit `bind` event inside a specific session's branch activates RP mode there.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompiledCard, CompiledLoreBook, CompiledPreset, PersonaProfile } from "../types.js";
import type { UnpackedAsset } from "../parser/unpack.js";
import { sanitizeZipEntryPath } from "../parser/unpack.js";
import { compileCardKnowledgeIndex, computeCardKnowledgeHash } from "../parser/card-knowledge.js";

export function getProjectRpDir(cwd: string): string {
  return path.join(cwd, ".pi", "rp");
}

export function getGlobalLibraryDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "rp-library");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function assertSafeSegment(id: string, label: string): string {
  if (
    typeof id !== "string" ||
    !id.trim() ||
    id === "." ||
    id === ".." ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`Invalid ${label}: "${String(id)}"`);
  }
  return id;
}

function resolveInsideRoot(rootDir: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootDir);
  const target = path.resolve(resolvedRoot, ...segments);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path traversal rejected: ${target}`);
  }
  return target;
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function saveCompiledCard(options: {
  baseDir: string;
  card: CompiledCard;
  rawJson: Record<string, unknown>;
  avatarPng?: Buffer;
  assets?: UnpackedAsset[];
}): string {
  const safeSlug = assertSafeSegment(options.card.slug, "card slug");
  const cardsRoot = path.join(options.baseDir, "cards");
  const cardDir = resolveInsideRoot(cardsRoot, safeSlug);
  ensureDir(cardDir);

  if (options.avatarPng) {
    const avatarFile = path.join(cardDir, "assets", "avatar.png");
    ensureDir(path.dirname(avatarFile));
    fs.writeFileSync(avatarFile, options.avatarPng);
    options.card.identity.avatarPath = "assets/avatar.png";
  }

  for (const asset of options.assets ?? []) {
    const safeRel = sanitizeZipEntryPath(asset.entryName);
    const dest = path.resolve(cardDir, safeRel);
    if (!dest.startsWith(path.resolve(cardDir) + path.sep)) continue;
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, asset.data);
  }

  writeJson(path.join(cardDir, "card.raw.json"), options.rawJson);
  if (options.card.knowledgeIndex) {
    writeJson(path.join(cardDir, "knowledge.index.json"), options.card.knowledgeIndex);
  }
  const { knowledgeIndex: _ki, ...cardWithoutHeavyIndex } = options.card;
  writeJson(path.join(cardDir, "card.compiled.json"), cardWithoutHeavyIndex);
  return cardDir;
}

export function loadCompiledCard(baseDir: string, slug: string): CompiledCard | null {
  try {
    const safeSlug = assertSafeSegment(slug, "card slug");
    const cardDir = resolveInsideRoot(path.join(baseDir, "cards"), safeSlug);
    const card = readJsonSafe<CompiledCard>(path.join(cardDir, "card.compiled.json"));
    if (!card) return null;
    const expectedHash = computeCardKnowledgeHash(
      card.frozen.description || "",
      card.frozen.personality || "",
      card.frozen.scenario || "",
    );
    const cachedKi = card.knowledgeIndex ?? readJsonSafe<CompiledCard["knowledgeIndex"]>(path.join(cardDir, "knowledge.index.json"));
    if (cachedKi && cachedKi.contentHash === expectedHash) {
      card.knowledgeIndex = cachedKi;
    } else {
      card.knowledgeIndex = compileCardKnowledgeIndex(card);
      try {
        writeJson(path.join(cardDir, "knowledge.index.json"), card.knowledgeIndex);
      } catch {
        // Non-fatal if read-only
      }
    }
    return card;
  } catch {
    return null;
  }
}

export function loadRawCardJson(baseDir: string, slug: string): Record<string, unknown> | null {
  try {
    const safeSlug = assertSafeSegment(slug, "card slug");
    const target = resolveInsideRoot(path.join(baseDir, "cards"), safeSlug, "card.raw.json");
    return readJsonSafe<Record<string, unknown>>(target);
  } catch {
    return null;
  }
}

export function listCardSlugs(baseDir: string): string[] {
  const cardsDir = path.join(baseDir, "cards");
  try {
    if (!fs.existsSync(cardsDir)) return [];
    return fs
      .readdirSync(cardsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(cardsDir, d.name, "card.compiled.json")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export interface CardSummaryEntry {
  slug: string;
  name: string;
  specOrigin: string;
  loreCount: number;
  tags: string[];
  source: "project" | "library";
  baseDir: string;
}

/** List all available cards across project and global library with rich human-readable metadata. */
export function listAllCardSummaries(cwd: string): CardSummaryEntry[] {
  const results: CardSummaryEntry[] = [];
  const seen = new Set<string>();
  const dirs: Array<{ baseDir: string; source: "project" | "library" }> = [
    { baseDir: getProjectRpDir(cwd), source: "project" },
    { baseDir: getGlobalLibraryDir(), source: "library" },
  ];

  for (const { baseDir, source } of dirs) {
    for (const slug of listCardSlugs(baseDir)) {
      const key = `${source}:${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const card = loadCompiledCard(baseDir, slug);
      if (!card) continue;
      results.push({
        slug,
        name: card.identity.name,
        specOrigin: card.specOrigin,
        loreCount: card.loreBook.entries.length,
        tags: card.meta.tags.slice(0, 3),
        source,
        baseDir,
      });
    }
  }
  return results;
}

/** Auto-discover importable `.png`, `.charx`, `.json` files in `cwd` (depth <= 2) for 1-click import. */
export function discoverImportableFiles(cwd: string, limit = 20): string[] {
  const found: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
  const validExts = new Set([".png", ".charx", ".json"]);

  const scan = (dir: string, depth: number) => {
    if (depth > 2 || found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= limit) break;
      if (ent.name.startsWith(".") && ent.name !== ".pi") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        // Skip already-compiled internal card folders
        if (full.includes(`${path.sep}.pi${path.sep}rp${path.sep}cards`)) continue;
        scan(full, depth + 1);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (!validExts.has(ext)) continue;
        if (
          ent.name === "package.json" ||
          ent.name === "package-lock.json" ||
          ent.name === "tsconfig.json" ||
          ent.name === "personas.json" ||
          ent.name === "card.compiled.json" ||
          ent.name === "card.raw.json"
        ) {
          continue;
        }
        found.push(path.relative(cwd, full));
      }
    }
  };

  scan(cwd, 0);
  return found.sort();
}

/** Resolve a card by slug from project `.pi/rp/` first, then global library. */
export function resolveCardBySlug(
  cwd: string,
  slug: string,
  preferredSource?: "project" | "library",
): { card: CompiledCard; baseDir: string; source: "project" | "library" } | null {
  const order: Array<"project" | "library"> =
    preferredSource === "library" ? ["library", "project"] : ["project", "library"];

  for (const source of order) {
    const baseDir = source === "project" ? getProjectRpDir(cwd) : getGlobalLibraryDir();
    const card = loadCompiledCard(baseDir, slug);
    if (card) return { card, baseDir, source };
  }
  return null;
}

export function saveCompiledPreset(baseDir: string, preset: CompiledPreset): string {
  const safeId = assertSafeSegment(preset.id, "preset id");
  const dest = resolveInsideRoot(path.join(baseDir, "presets"), `${safeId}.json`);
  writeJson(dest, preset);
  return dest;
}

export function loadCompiledPreset(cwd: string, presetId: string): CompiledPreset | null {
  let safeId: string;
  try {
    safeId = assertSafeSegment(presetId, "preset id");
  } catch {
    return null;
  }
  const projPath = resolveInsideRoot(path.join(getProjectRpDir(cwd), "presets"), `${safeId}.json`);
  const proj = readJsonSafe<CompiledPreset>(projPath);
  if (proj) return proj;
  const libPath = resolveInsideRoot(path.join(getGlobalLibraryDir(), "presets"), `${safeId}.json`);
  return readJsonSafe<CompiledPreset>(libPath);
}

export function listPresetIds(cwd: string): string[] {
  const ids = new Set<string>();
  for (const base of [getProjectRpDir(cwd), getGlobalLibraryDir()]) {
    const dir = path.join(base, "presets");
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".json")) ids.add(f.slice(0, -5));
      }
    } catch {
      // Skip inaccessible preset directory
    }
  }
  return Array.from(ids).sort();
}

export function saveUpdatedCard(baseDir: string, card: CompiledCard): void {
  const safeSlug = assertSafeSegment(card.slug, "card slug");
  card.frozen.constantLoreIds = card.loreBook.entries
    .filter((e) => e.enabled && e.constant && [0, 1, 5, 6].includes(e.position))
    .map((e) => e.id);
  const constantCount = card.loreBook.entries.filter((e) => e.constant).length;
  card.importReport.loreCount = card.loreBook.entries.length;
  card.importReport.constantLoreCount = constantCount;
  card.importReport.dynamicLoreCount = Math.max(0, card.loreBook.entries.length - constantCount);
  const cardDir = resolveInsideRoot(path.join(baseDir, "cards"), safeSlug);
  card.knowledgeIndex = compileCardKnowledgeIndex(card);
  writeJson(path.join(cardDir, "knowledge.index.json"), card.knowledgeIndex);
  const { knowledgeIndex: _ki, ...cardWithoutHeavyIndex } = card;
  writeJson(path.join(cardDir, "card.compiled.json"), cardWithoutHeavyIndex);
}

export function deleteCompiledCard(baseDir: string, slug: string): boolean {
  const safeSlug = assertSafeSegment(slug, "card slug");
  const cardDir = resolveInsideRoot(path.join(baseDir, "cards"), safeSlug);
  if (!fs.existsSync(cardDir)) return false;
  fs.rmSync(cardDir, { recursive: true, force: true });
  return true;
}

export function deleteCompiledPreset(cwd: string, presetId: string): boolean {
  const safeId = assertSafeSegment(presetId, "preset id");
  let removed = false;
  for (const base of [getProjectRpDir(cwd), getGlobalLibraryDir()]) {
    const file = resolveInsideRoot(path.join(base, "presets"), `${safeId}.json`);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed = true;
    }
  }
  return removed;
}

export function mergeExternalLoreBook(baseDir: string, slug: string, extraBook: CompiledLoreBook): CompiledCard | null {
  const card = loadCompiledCard(baseDir, slug);
  if (!card) return null;
  const existingIds = new Set(card.loreBook.entries.map((e) => e.id));
  for (const entry of extraBook.entries) {
    let candidate = entry.id;
    let suffix = 1;
    while (existingIds.has(candidate)) {
      candidate = `ext_${entry.id}_${suffix++}`;
    }
    existingIds.add(candidate);
    card.loreBook.entries.push({ ...entry, id: candidate });
  }
  saveUpdatedCard(baseDir, card);
  return card;
}

export function loadPersonas(cwd: string): PersonaProfile[] {
  const proj = readJsonSafe<PersonaProfile[]>(path.join(getProjectRpDir(cwd), "personas.json")) ?? [];
  const lib = readJsonSafe<PersonaProfile[]>(path.join(getGlobalLibraryDir(), "personas.json")) ?? [];
  const byId = new Map<string, PersonaProfile>();
  for (const p of [...lib, ...proj]) {
    if (p?.id && p?.name) byId.set(p.id, p);
  }
  return Array.from(byId.values());
}

export function savePersona(cwd: string, persona: PersonaProfile, scope: "project" | "library" = "library"): void {
  const baseDir = scope === "project" ? getProjectRpDir(cwd) : getGlobalLibraryDir();
  const filePath = path.join(baseDir, "personas.json");
  let list: PersonaProfile[] = [];
  if (fs.existsSync(filePath)) {
    const parsed = readJsonSafe<PersonaProfile[]>(filePath);
    if (Array.isArray(parsed)) {
      list = parsed;
    } else {
      try {
        fs.renameSync(filePath, `${filePath}.corrupt.${Date.now()}`);
      } catch {
        // Non-fatal if corrupt backup cannot be renamed
      }
    }
  }
  const idx = list.findIndex((p) => p.id === persona.id);
  if (idx >= 0) list[idx] = persona;
  else list.push(persona);
  writeJson(filePath, list);
}

export function deletePersona(cwd: string, personaId: string): boolean {
  let removed = false;
  for (const base of [getProjectRpDir(cwd), getGlobalLibraryDir()]) {
    const filePath = path.join(base, "personas.json");
    const list = readJsonSafe<PersonaProfile[]>(filePath);
    if (!list) continue;
    const next = list.filter((p) => p.id !== personaId);
    if (next.length !== list.length) {
      writeJson(filePath, next);
      removed = true;
    }
  }
  return removed;
}

