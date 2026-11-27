/**
 * Humanized Interactive File Picker & Smart Asset Sniffer for `/rp import`.
 *
 * Eliminates the pain of typing long paths:
 *  - Auto-scans current project, Downloads (`~/Downloads`, `/sdcard/Download`), Desktop, Documents,
 *    and last-used import directory (saved in global library `ui-prefs.json`).
 *  - Auto-sniffs every `.png`, `.charx`, `.json` file BEFORE import to display a real badge:
 *    `[角色卡 V3]`, `[角色卡 V2]`, `[CHARX]`, `[世界书]`, `[预设]`, plus file size & relative path.
 *  - Full directory navigation (`📁 子目录`, `↩ 上级目录`, quick-jump roots).
 *  - Cleanly parses drag-and-dropped paths (strips surrounding quotes and `\ ` escapes).
 *  - Supports single-file import OR batch-importing all character cards in a folder!
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PiExtensionContext } from "../types.js";
import { getGlobalLibraryDir } from "../storage/workspace-store.js";
import { inspectImportFileQuick } from "../parser/unpack.js";

export interface CandidateFile {
  fullPath: string;
  displayPath: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
  kindBadge: string;
  isCard: boolean;
}

interface UiPrefs {
  lastImportDir?: string;
  lastPersonaId?: string;
}

const VALID_EXTS = new Set([".png", ".charx", ".json"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".cache"]);
const SKIP_JSON_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "personas.json",
  "card.compiled.json",
  "card.raw.json",
  "ui-prefs.json",
  "world.json",
]);

function getPrefsPath(): string {
  return path.join(getGlobalLibraryDir(), "ui-prefs.json");
}

export function loadUiPrefs(): UiPrefs {
  try {
    const p = getPrefsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) as UiPrefs;
  } catch {
    return {};
  }
}

export function saveUiPrefs(patch: Partial<UiPrefs>): void {
  try {
    const p = getPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const next = { ...loadUiPrefs(), ...patch };
    fs.writeFileSync(p, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Non-fatal
  }
}

/** Normalize user-pasted or dragged-and-dropped file paths (strip quotes, ~, escaped spaces). */
export function normalizeUserFilePath(raw: string, cwd: string): string {
  let cleaned = raw.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  cleaned = cleaned.replace(/\\ /g, " ");
  if (cleaned.startsWith("~/")) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }
  return path.isAbsolute(cleaned) ? cleaned : path.resolve(cwd, cleaned);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Quickly inspect a file on disk to classify it without full compilation. */
export function classifyCandidateFile(fullPath: string, baseDisplayDir?: string): CandidateFile | null {
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    const ext = path.extname(fullPath).toLowerCase();
    if (!VALID_EXTS.has(ext)) return null;
    const name = path.basename(fullPath);
    if (SKIP_JSON_NAMES.has(name.toLowerCase())) return null;

    const quick = inspectImportFileQuick(fullPath);
    if (!quick) return null;

    const displayPath = baseDisplayDir ? path.relative(baseDisplayDir, fullPath) || name : fullPath;
    return {
      fullPath,
      displayPath,
      name,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      kindBadge: quick.badge,
      isCard: quick.kind === "card",
    };
  } catch {
    return null;
  }
}

/** Collect well-known candidate directories on Desktop, Linux, macOS, and Android/Termux. */
export function getQuickImportRoots(cwd: string): Array<{ label: string; dir: string }> {
  const home = os.homedir();
  const prefs = loadUiPrefs();
  const candidates: Array<{ label: string; dir: string }> = [];
  const seen = new Set<string>();

  const add = (label: string, dir: string | undefined) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(resolved);
        candidates.push({ label, dir: resolved });
      }
    } catch {
      // ignore inaccessible directories
    }
  };

  if (prefs.lastImportDir) add("🕘 上次导入目录", prefs.lastImportDir);
  add("📂 当前工作区", cwd);
  add("📥 下载目录 (Downloads)", path.join(home, "Downloads"));
  add("📥 Android 下载 (/sdcard/Download)", "/sdcard/Download");
  add("🖥 桌面 (Desktop)", path.join(home, "Desktop"));
  add("📄 文档 (Documents)", path.join(home, "Documents"));
  add("🏠 用户主目录 (~)", home);

  return candidates;
}

/** Smartly scan workspace + common download folders for verified RP assets (sorted newest first). */
export function smartDiscoverRpFiles(cwd: string, limit = 24): CandidateFile[] {
  const results: CandidateFile[] = [];
  const seen = new Set<string>();
  const home = os.homedir();
  const prefs = loadUiPrefs();

  const scanDir = (dir: string, maxDepth: number, baseLabel: string) => {
    const walk = (curr: string, depth: number) => {
      if (depth > maxDepth || results.length >= limit) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(curr, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (results.length >= limit) break;
        if (ent.name.startsWith(".") && ent.name !== ".pi") continue;
        const full = path.join(curr, ent.name);
        if (ent.isDirectory()) {
          if (SKIP_DIRS.has(ent.name)) continue;
          if (full.includes(`${path.sep}.pi${path.sep}rp${path.sep}cards`)) continue;
          walk(full, depth + 1);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (!VALID_EXTS.has(ext) || seen.has(full)) continue;
          const info = classifyCandidateFile(full, dir);
          if (info) {
            seen.add(full);
            results.push({
              ...info,
              displayPath: baseLabel ? `${baseLabel}/${info.displayPath}` : info.displayPath,
            });
          }
        }
      }
    };
    walk(dir, 0);
  };

  // Scan workspace up to depth 2
  scanDir(cwd, 2, ".");
  // Scan last import dir (depth 1)
  if (prefs.lastImportDir && path.resolve(prefs.lastImportDir) !== path.resolve(cwd)) {
    scanDir(prefs.lastImportDir, 1, "上次目录");
  }
  // Scan Downloads (depth 1) — super common place for SillyTavern PNG/JSON downloads!
  for (const dl of [path.join(home, "Downloads"), "/sdcard/Download"]) {
    if (fs.existsSync(dl)) {
      scanDir(dl, 1, "Downloads");
    }
  }

  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

/** Interactive directory browser letting the user click through folders & pick 1 or batch files. */
async function browseDirectory(ctx: PiExtensionContext, startDir: string): Promise<string[] | null> {
  let currentDir = path.resolve(startDir);

  while (true) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      ctx.ui.notify(`无法读取目录：${currentDir}`, "warning");
      return null;
    }

    const subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const files: CandidateFile[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!VALID_EXTS.has(ext)) continue;
      const info = classifyCandidateFile(path.join(currentDir, e.name), currentDir);
      if (info) files.push(info);
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const parentDir = path.dirname(currentDir);
    const options: string[] = [];
    const actions: Array<() => Promise<string[] | "continue" | null>> = [];

    if (parentDir !== currentDir) {
      options.push(`↩ 上级目录 (${parentDir})`);
      actions.push(async () => {
        currentDir = parentDir;
        return "continue";
      });
    }

    const cardFiles = files.filter((f) => f.isCard);
    if (cardFiles.length >= 2) {
      options.push(`📦 一键批量导入本目录全部 ${cardFiles.length} 张角色卡`);
      actions.push(async () => cardFiles.map((f) => f.fullPath));
    }

    for (const f of files.slice(0, 30)) {
      options.push(`${f.kindBadge} ${f.name}  (${formatFileSize(f.sizeBytes)})`);
      actions.push(async () => [f.fullPath]);
    }

    for (const d of subdirs.slice(0, 25)) {
      options.push(`📁 ${d}/`);
      actions.push(async () => {
        currentDir = path.join(currentDir, d);
        return "continue";
      });
    }

    options.push("← 返回导入入口");
    actions.push(async () => null);

    const shortDir = currentDir.length > 52 ? `…${currentDir.slice(-49)}` : currentDir;
    const pick = await ctx.ui.select(
      `📂 浏览目录：${shortDir}（${files.length} 个可导入文件）`,
      options,
    );
    if (!pick) return null;
    const idx = options.indexOf(pick);
    if (idx < 0) return null;
    const res = await actions[idx]!();
    if (res === "continue") continue;
    return res;
  }
}

/**
 * Launch the Humanized Interactive Import Picker.
 * Returns one or more resolved absolute file paths to import, or `null` if cancelled.
 */
export async function pickFilesToImport(ctx: PiExtensionContext): Promise<string[] | null> {
  const discovered = smartDiscoverRpFiles(ctx.cwd, 18);
  const roots = getQuickImportRoots(ctx.cwd);

  while (true) {
    const options: string[] = [];
    const handlers: Array<() => Promise<string[] | "continue" | null>> = [];

    // 1. Direct smart-discovered files right at the top (1-click import!)
    if (discovered.length > 0) {
      for (const f of discovered.slice(0, 8)) {
        options.push(`${f.kindBadge} ${f.name}  ·  ${f.displayPath} (${formatFileSize(f.sizeBytes)})`);
        handlers.push(async () => [f.fullPath]);
      }
      if (discovered.length > 8) {
        options.push(`🔎 查看全部 ${discovered.length} 个已自动识别的文件…`);
        handlers.push(async () => {
          const subOpts = [
            ...discovered.map((f) => `${f.kindBadge} ${f.name} · ${f.displayPath} (${formatFileSize(f.sizeBytes)})`),
            "← 返回",
          ];
          const chosen = await ctx.ui.select("🔎 自动识别的 RP 文件（按最近修改排序）", subOpts);
          if (!chosen || chosen === "← 返回") return "continue";
          const i = subOpts.indexOf(chosen);
          return i >= 0 && discovered[i] ? [discovered[i]!.fullPath] : "continue";
        });
      }
    }

    // 2. Directory browser shortcuts
    for (const root of roots) {
      options.push(`${root.label} — 浏览文件夹`);
      handlers.push(async () => {
        const picked = await browseDirectory(ctx, root.dir);
        return picked ?? "continue";
      });
    }

    // 3. Manual / drag-and-drop fallback
    options.push("⌨️ 粘贴或拖入文件路径（支持相对路径、~ 与引号）");
    handlers.push(async () => {
      const raw = await ctx.ui.input(
        "粘贴或拖入 .png / .charx / .json 路径",
        "./character.png",
      );
      if (!raw?.trim()) return "continue";
      const resolved = normalizeUserFilePath(raw, ctx.cwd);
      if (!fs.existsSync(resolved)) {
        ctx.ui.notify(`找不到文件：${resolved}`, "error");
        return "continue";
      }
      if (fs.statSync(resolved).isDirectory()) {
        const picked = await browseDirectory(ctx, resolved);
        return picked ?? "continue";
      }
      return [resolved];
    });

    options.push("✕ 取消导入");
    handlers.push(async () => null);

    const title =
      discovered.length > 0
        ? `📥 导入角色卡 / 世界书 / 预设（已自动识别 ${discovered.length} 个文件，点选即导入）`
        : "📥 导入角色卡 / 世界书 / 预设（选择目录浏览或拖入路径）";

    const choice = await ctx.ui.select(title, options);
    if (!choice) return null;
    const idx = options.indexOf(choice);
    if (idx < 0) return null;
    const result = await handlers[idx]!();
    if (result === "continue") continue;
    if (result && result.length > 0) {
      saveUiPrefs({ lastImportDir: path.dirname(result[0]!) });
    }
    return result;
  }
}
