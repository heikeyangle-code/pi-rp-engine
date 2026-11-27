/**
 * Dual-mode workspace & global library persistence for pi-rp-engine:
 *  - Mode A (Project World): `<cwd>/.pi/rp/` (cards/, presets/, lore/, personas.json, world.json)
 *  - Mode B (Global Library): `~/.pi/agent/rp-library/` (shared cards/, presets/, personas.json)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CompiledCard,
  CompiledLoreBook,
  CompiledPreset,
  PersonaProfile,
  ProjectWorldConfig,
} from "../types.js";
import type { UnpackedAsset } from "../parser/unpack.js";
import { sanitizeZipEntryPath } from "../parser/unpack.js";

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

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function loadProjectWorldConfig(cwd: string): { worldDir: string; config: ProjectWorldConfig } | null {
  const worldDir = getProjectRpDir(cwd);
  const config = readJsonSafe<ProjectWorldConfig>(path.join(worldDir, "world.json"));
  if (!config || !config.defaultCardSlug) return null;
  return { worldDir, config };
}

export function saveProjectWorldConfig(cwd: string, config: ProjectWorldConfig): string {
  const worldDir = getProjectRpDir(cwd);
  writeJson(path.join(worldDir, "world.json"), config);
  return worldDir;
}

export function saveCompiledCard(options: {
  baseDir: string;
  card: CompiledCard;
  rawJson: Record<string, unknown>;
  avatarPng?: Buffer;
  assets?: UnpackedAsset[];
}): string {
  const cardDir = path.join(options.baseDir, "cards", options.card.slug);
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
  writeJson(path.join(cardDir, "card.compiled.json"), options.card);
  return cardDir;
}

export function loadCompiledCard(baseDir: string, slug: string): CompiledCard | null {
  return readJsonSafe<CompiledCard>(path.join(baseDir, "cards", slug, "card.compiled.json"));
}

export function loadRawCardJson(baseDir: string, slug: string): Record<string, unknown> | null {
  return readJsonSafe<Record<string, unknown>>(path.join(baseDir, "cards", slug, "card.raw.json"));
}

export function listCardSlugs(baseDir: string): string[] {
  const cardsDir = path.join(baseDir, "cards");
  if (!fs.existsSync(cardsDir)) return [];
  return fs
    .readdirSync(cardsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(cardsDir, d.name, "card.compiled.json")))
    .map((d) => d.name)
    .sort();
}

/** Resolve a card by slug from project `.pi/rp/` first, then global library. */
export function resolveCardBySlug(
  cwd: string,
  slug: string,
): { card: CompiledCard; baseDir: string; source: "project" | "library" } | null {
  const projDir = getProjectRpDir(cwd);
  const projCard = loadCompiledCard(projDir, slug);
  if (projCard) return { card: projCard, baseDir: projDir, source: "project" };

  const libDir = getGlobalLibraryDir();
  const libCard = loadCompiledCard(libDir, slug);
  if (libCard) return { card: libCard, baseDir: libDir, source: "library" };

  return null;
}

export function saveCompiledPreset(baseDir: string, preset: CompiledPreset): string {
  const dest = path.join(baseDir, "presets", `${preset.id}.json`);
  writeJson(dest, preset);
  return dest;
}

export function loadCompiledPreset(cwd: string, presetId: string): CompiledPreset | null {
  const proj = readJsonSafe<CompiledPreset>(path.join(getProjectRpDir(cwd), "presets", `${presetId}.json`));
  if (proj) return proj;
  return readJsonSafe<CompiledPreset>(path.join(getGlobalLibraryDir(), "presets", `${presetId}.json`));
}

export function listPresetIds(cwd: string): string[] {
  const ids = new Set<string>();
  for (const base of [getProjectRpDir(cwd), getGlobalLibraryDir()]) {
    const dir = path.join(base, "presets");
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".json")) ids.add(f.slice(0, -5));
    }
  }
  return Array.from(ids).sort();
}

export function mergeExternalLoreBook(baseDir: string, slug: string, extraBook: CompiledLoreBook): CompiledCard | null {
  const card = loadCompiledCard(baseDir, slug);
  if (!card) return null;
  const existingIds = new Set(card.loreBook.entries.map((e) => e.id));
  for (const entry of extraBook.entries) {
    const uniqueId = existingIds.has(entry.id) ? `ext_${entry.id}_${existingIds.size}` : entry.id;
    existingIds.add(uniqueId);
    card.loreBook.entries.push({ ...entry, id: uniqueId });
    if (entry.enabled && entry.constant && [0, 1, 5, 6].includes(entry.position)) {
      card.frozen.constantLoreIds.push(uniqueId);
    }
  }
  writeJson(path.join(baseDir, "cards", slug, "card.compiled.json"), card);
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

export function savePersona(cwd: string, persona: PersonaProfile, scope: "project" | "library" = "project"): void {
  const baseDir = scope === "project" ? getProjectRpDir(cwd) : getGlobalLibraryDir();
  const filePath = path.join(baseDir, "personas.json");
  const list = readJsonSafe<PersonaProfile[]>(filePath) ?? [];
  const idx = list.findIndex((p) => p.id === persona.id);
  if (idx >= 0) list[idx] = persona;
  else list.push(persona);
  writeJson(filePath, list);
}
