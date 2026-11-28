/**
 * EverMemOS MemScene Compaction (`session_before_compact`) & Inter-Act Montage generator.
 *
 * v3 Upgrade:
 *  - `buildSemanticMemSceneCompaction`: runs REAL LLM semantic narrative compaction using
 *    Pi's official `ctx.modelRegistry` (preferring `state.sidecarModel`, falling back to `ctx.model`),
 *    preserving plot causality, relationship shifts, promises, emotional beats, and clues.
 *  - Gracefully falls back to deterministic `buildMemSceneCompactionSummary` when offline or headless.
 */

import type { PiExtensionContext, PiMessage, SessionRpState } from "../types.js";
import { getActiveFacts } from "./bitemporal.js";
import { canCompleteWithRegistry, completeWithRegistry, resolveSidecarModel } from "../engine/llm-helper.js";

function extractMessagePlainText(msg: PiMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: "text"; text: string } => Boolean(b && b.type === "text" && typeof b.text === "string"))
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** Condense a slice of historical Pi messages into compact narrative beat bullets (local deterministic fallback). */
export function condenseMessagesToBeats(messages: PiMessage[] | undefined, maxBeats = 10): string {
  if (!messages || messages.length === 0) return "";
  const dialog = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.customType !== "rp:ooc" && m.customType !== "rp:event",
  );
  if (dialog.length === 0) return "";

  const picked: PiMessage[] = [];
  if (dialog.length <= maxBeats) {
    picked.push(...dialog);
  } else {
    const step = (dialog.length - 1) / (maxBeats - 1);
    for (let i = 0; i < maxBeats; i++) {
      picked.push(dialog[Math.round(i * step)]!);
    }
  }

  const lines: string[] = [];
  for (const m of picked) {
    const clean = extractMessagePlainText(m)
      .replace(/<rp_state_frame>[\s\S]*?<\/rp_state_frame>/gi, "")
      .replace(/<rp_recalled_context>[\s\S]*?<\/rp_recalled_context>/gi, "")
      .replace(/<rp_director_note>[\s\S]*?<\/rp_director_note>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) continue;
    const tag = m.role === "user" ? "玩家" : "叙事";
    lines.push(`- [${tag}] ${clean.slice(0, 140)}${clean.length > 140 ? "…" : ""}`);
  }
  return lines.join("\n");
}

export function buildMemSceneCompactionSummary(
  state: SessionRpState,
  options?: {
    messagesToSummarize?: PiMessage[];
    previousSummary?: string;
    droppedMessagesSummary?: string;
  },
): string {
  const lines: string[] = [
    `# MemScene 幕间记忆归并 (${[state.era, state.worldTimeLabel, `Turn ${state.turn}`].filter(Boolean).join(" · ")})`,
  ];

  if (state.location) {
    lines.push(
      `- 当前地点：${state.location}${state.presentNpcs.length ? `（在场角色：${state.presentNpcs.join("、")}）` : ""}`,
    );
  }

  if (state.sceneObjective) {
    lines.push(`- 当前场景目标：${state.sceneObjective}`);
  }

  const milestones = Array.from(state.milestones);
  if (milestones.length > 0) {
    lines.push(`- 已解锁里程碑：${milestones.join("、")}`);
  }

  const clocks = Object.values(state.clocks);
  if (clocks.length > 0) {
    lines.push(
      `- 进度时钟：${clocks.map((c) => `${c.label} ${c.value}/${c.max}${c.completed ? "(已完成)" : ""}`).join(" | ")}`,
    );
  }

  if (state.beliefs.length > 0) {
    const recentBeliefs = state.beliefs.slice(-6);
    lines.push("## 人物信念与主观洞察（DualMem）");
    for (const b of recentBeliefs) {
      const sub = b.subjectiveInsight ? `；内心解读「${b.subjectiveInsight}」` : "";
      lines.push(`- ${b.actorId} → ${b.target} [T${b.turn}]：因「${b.activatingEvent}」形成信念「${b.belief}」${sub}`);
    }
  }

  const openForesights = Array.from(state.foresights.values()).filter((h) => h.status === "open");
  if (openForesights.length > 0) {
    lines.push("## 未回收伏笔（Foresights）");
    for (const h of openForesights.slice(0, 6)) {
      lines.push(`- ${h.summary}${h.triggerHint ? `（触发线索：${h.triggerHint}）` : ""}`);
    }
  }

  const activeCount = getActiveFacts(state).length;
  const bookCount = state.memoryBooks.size;
  lines.push(
    `- 账本注记：${activeCount} 条有效事实、${bookCount} 卷场景记忆书与全部 L1 数值/背包实时挂载于 <rp_state_frame> / <rp_recalled_context>，此处不重复赘述。`,
  );

  if (options?.previousSummary?.trim()) {
    lines.push(`## 更早幕次脉络\n${options.previousSummary.trim().slice(0, 1200)}`);
  }

  const beats = options?.droppedMessagesSummary?.trim() || condenseMessagesToBeats(options?.messagesToSummarize);
  if (beats) {
    lines.push(`## 本段关键剧情节拍\n${beats}`);
  }

  return lines.join("\n");
}

/**
 * Semantic LLM-powered EverMemOS MemScene Compaction for `session_before_compact`.
 * Uses `state.sidecarModel` (or `ctx.model`) to synthesize causal plot progression instead of hard 140-char truncation.
 * Always falls back safely to `buildMemSceneCompactionSummary` on error/timeout/offline.
 */
export async function buildSemanticMemSceneCompaction(
  ctx: PiExtensionContext,
  state: SessionRpState,
  options?: {
    messagesToSummarize?: PiMessage[];
    previousSummary?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const dialog = (options?.messagesToSummarize ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.customType !== "rp:ooc" && m.customType !== "rp:event",
  );

  const model = resolveSidecarModel(ctx, state.sidecarModel);
  if (dialog.length < 2 || !canCompleteWithRegistry(ctx, model)) {
    return buildMemSceneCompactionSummary(state, options);
  }

  // Build compact transcript capped to ~8000 chars so compaction stays fast and cheap
  const lines: string[] = [];
  let charBudget = 8000;
  for (const m of dialog) {
    const clean = extractMessagePlainText(m)
      .replace(/<rp_state_frame>[\s\S]*?<\/rp_state_frame>/gi, "")
      .replace(/<rp_recalled_context>[\s\S]*?<\/rp_recalled_context>/gi, "")
      .replace(/<rp_director_note>[\s\S]*?<\/rp_director_note>/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) continue;
    const speaker = m.role === "user" ? state.currentPersona.name : "叙事";
    const snippet = `[${speaker}] ${clean.slice(0, 420)}`;
    if (charBudget - snippet.length < 0) break;
    charBudget -= snippet.length;
    lines.push(snippet);
  }

  if (lines.length === 0) {
    return buildMemSceneCompactionSummary(state, options);
  }

  try {
    const semanticSummary = await completeWithRegistry(ctx, model, {
      systemPrompt:
        "You are a narrative memory archivist compressing roleplay history into an EverMemOS MemScene summary. " +
        "Preserve: (1) concrete plot events in chronological order, (2) emotional/relationship turning points and character subtext, " +
        "(3) promises, secrets, clues, and unresolved tensions. Match the story's language. Be dense and accurate (max 380 Chinese chars or 220 English words). Output ONLY the summary bullets.",
      userPrompt:
        (options?.previousSummary ? `Prior Arc:\n${options.previousSummary.slice(0, 800)}\n\n` : "") +
        `Transcript to compress:\n${lines.join("\n")}`,
      maxTokens: 520,
      signal: options?.signal ?? ctx.signal,
    });

    if (semanticSummary.trim().length >= 24) {
      return buildMemSceneCompactionSummary(state, {
        ...options,
        droppedMessagesSummary: semanticSummary.trim(),
      });
    }
  } catch {
    // Graceful fallback to deterministic summary
  }

  return buildMemSceneCompactionSummary(state, options);
}
