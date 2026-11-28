/**
 * EverMemOS MemScene Compaction (`session_before_compact`) & Inter-Act Montage generator.
 *
 * v3 Upgrade:
 *  - `buildSemanticMemSceneCompaction`: runs REAL LLM semantic narrative compaction using
 *    Pi's official `ctx.modelRegistry` (preferring `state.sidecarModel`, falling back to `ctx.model`),
 *    preserving plot causality, relationship shifts, promises, emotional beats, and clues.
 *  - Gracefully falls back to deterministic `buildMemSceneCompactionSummary` when offline or headless.
 */

import type { MemoryBookEntry, PiExtensionContext, PiMessage, SessionRpState } from "../types.js";
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

function stripCompactionNoise(raw: string): string {
  return raw
    .replace(/<(?:think|thinking|thought|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|thought|reasoning)\s*>/gi, "")
    .replace(/<rp_state_frame>[\s\S]*?<\/rp_state_frame>/gi, "")
    .replace(/<rp_drama_beat>[\s\S]*?<\/rp_drama_beat>/gi, "")
    .replace(/<rp_recalled_context>[\s\S]*?<\/rp_recalled_context>/gi, "")
    .replace(/<rp_director_note>[\s\S]*?<\/rp_director_note>/gi, "")
    .replace(/<lorebook_title_hints>[\s\S]*?<\/lorebook_title_hints>/gi, "")
    .replace(/<rp_recent_changes>[\s\S]*?<\/rp_recent_changes>/gi, "")
    .replace(/<rp_voice_anchors>[\s\S]*?<\/rp_voice_anchors>/gi, "")
    .replace(/<rp_physical_scene>[\s\S]*?<\/rp_physical_scene>/gi, "")
    .replace(/<rp_living_world>[\s\S]*?<\/rp_living_world>/gi, "")
    .replace(/<rp_persona_update>[\s\S]*?<\/rp_persona_update>/gi, "")
    .replace(/<rp_monologue_cue>[\s\S]*?<\/rp_monologue_cue>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Condense a slice of historical Pi messages into compact narrative beat bullets (local deterministic fallback). */
export function condenseMessagesToBeats(messages: PiMessage[] | undefined, maxBeats = 10): string {
  if (!messages || messages.length === 0 || maxBeats <= 0) return "";
  const dialog = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && m.customType !== "rp:ooc" && m.customType !== "rp:event",
  );
  if (dialog.length === 0) return "";

  const picked: PiMessage[] = [];
  if (dialog.length <= maxBeats) {
    picked.push(...dialog);
  } else if (maxBeats === 1) {
    picked.push(dialog[dialog.length - 1]!);
  } else {
    const step = (dialog.length - 1) / (maxBeats - 1);
    for (let i = 0; i < maxBeats; i++) {
      picked.push(dialog[Math.round(i * step)]!);
    }
  }

  const lines: string[] = [];
  for (const m of picked) {
    const clean = stripCompactionNoise(extractMessagePlainText(m));
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
    signal?: AbortSignal;
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
    lines.push(`## 更早幕次脉络\n${options.previousSummary.trim().slice(0, 3200)}`);
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
 * Preserves newest messages via head + tail budget allocation so recent beats are never truncated away.
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

  const allSnippets: string[] = [];
  for (const m of dialog) {
    const clean = stripCompactionNoise(extractMessagePlainText(m));
    if (!clean) continue;
    const speaker = m.role === "user" ? state.currentPersona.name : "叙事";
    allSnippets.push(`[${speaker}] ${clean.slice(0, 1200)}`);
  }

  if (allSnippets.length === 0) {
    return buildMemSceneCompactionSummary(state, options);
  }

  // Head + Tail budget allocation (~8000 chars total: 2000 head + 6000 tail) so newest messages are ALWAYS preserved!
  const TOTAL_BUDGET = 24000;
  const HEAD_BUDGET = 6000;
  const TAIL_BUDGET = TOTAL_BUDGET - HEAD_BUDGET;

  const totalChars = allSnippets.reduce((sum, s) => sum + s.length, 0);
  let lines: string[];
  if (totalChars <= TOTAL_BUDGET) {
    lines = allSnippets;
  } else {
    const head: string[] = [];
    let headUsed = 0;
    let headCount = 0;
    for (let i = 0; i < allSnippets.length; i++) {
      const s = allSnippets[i]!;
      if (headUsed + s.length > HEAD_BUDGET && head.length > 0) break;
      head.push(s);
      headUsed += s.length;
      headCount = i + 1;
    }

    const tail: string[] = [];
    let tailUsed = 0;
    for (let i = allSnippets.length - 1; i >= headCount; i--) {
      const s = allSnippets[i]!;
      if (tailUsed + s.length > TAIL_BUDGET && tail.length > 0) break;
      tail.push(s);
      tailUsed += s.length;
    }
    tail.reverse();

    const omitted = allSnippets.length - head.length - tail.length;
    lines = omitted > 0 ? [...head, `[... ${omitted} earlier turns omitted ...]`, ...tail] : [...head, ...tail];
  }

  try {
    const semanticSummary = await completeWithRegistry(ctx, model, {
      systemPrompt:
        "You are a narrative memory archivist compressing roleplay history into an EverMemOS MemScene summary. " +
        "Preserve: (1) concrete plot events in chronological order, (2) emotional/relationship turning points and character subtext, " +
        "(3) promises, secrets, clues, and unresolved tensions. Match the story's language. Be dense and accurate (max 900 Chinese chars or 500 English words). Output ONLY the summary bullets.",
      userPrompt:
        (options?.previousSummary ? `Prior Arc:\n${options.previousSummary.slice(0, 2400)}\n\n` : "") +
        `Transcript to compress:\n${lines.join("\n")}`,
      maxTokens: 1500,
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

/**
 * Automatic Episodic -> Semantic Scene Consolidation (zero extra LLM cost).
 * Fires when a scene location shifts after >=5 turns, story era/stage advances,
 * or 12+ turns have elapsed since the last archived Memory Book chapter.
 */
export function maybeBuildAutoSceneChapter(
  state: SessionRpState,
  prevLocation: string,
  prevEra: string,
  recentProseHighlight?: string,
  branchMessages?: PiMessage[],
): MemoryBookEntry | null {
  if (!state.active || state.turn < 5) return null;

  let lastEndTurn = 0;
  for (const ch of state.memoryBooks.values()) {
    if (ch.turnRange[1] > lastEndTurn) lastEndTurn = ch.turnRange[1];
  }
  const span = state.turn - lastEndTurn;
  if (span < 5) return null;

  const locationShifted = Boolean(prevLocation && state.location && prevLocation !== state.location);
  const eraShifted = Boolean(prevEra && state.era && prevEra !== state.era);
  const periodicDue = span >= 12;

  if (!locationShifted && !eraShifted && !periodicDue) return null;

  const startTurn = Math.max(1, lastEndTurn + 1);
  const endTurn = state.turn;
  const chapterNum = state.memoryBooks.size + 1;
  const label = (prevLocation || state.location || prevEra || state.era || "剧情片段")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim()
    .slice(0, 18);

  const sliceFacts = Array.from(state.facts.values())
    .filter((f) => f.validFromTurn >= startTurn && f.validFromTurn <= endTurn)
    .slice(-5)
    .map((f) => f.statement);
  const sliceAudit = state.auditLog
    .filter((a) => a.turn >= startTurn && a.turn <= endTurn)
    .slice(-6)
    .map((a) => a.summary);
  const sliceHooks = Array.from(state.foresights.values())
    .filter((h) => h.status === "open" && h.plantedTurn >= startTurn)
    .slice(-3)
    .map((h) => `伏笔：${h.summary}`);
  const sliceEchoes = Array.from(state.consequences.values())
    .filter((e) => e.status === "pending" && e.plantedTurn >= startTurn)
    .slice(-3)
    .map((e) => `因果：${e.choice} → ${e.consequence}`);

  const bullets = [...sliceFacts, ...sliceHooks, ...sliceEchoes];
  if (bullets.length === 0 && sliceAudit.length > 0) {
    bullets.push(...sliceAudit.slice(0, 4));
  }
  if (bullets.length === 0 && branchMessages && branchMessages.length > 0) {
    const recentSlice = branchMessages.slice(-Math.min(12, span * 2));
    const condensed = condenseMessagesToBeats(recentSlice, 4);
    if (condensed) {
      for (const line of condensed.split("\n").filter(Boolean)) {
        bullets.push(line.replace(/^-\s*/, ""));
      }
    }
  }
  if (bullets.length === 0 && recentProseHighlight && recentProseHighlight.trim().length >= 16) {
    bullets.push(`在「${label}」的关键情节：${recentProseHighlight.replace(/\s+/g, " ").trim().slice(0, 260)}`);
  }
  if (bullets.length === 0) {
    bullets.push(`在「${label}」经历了第 ${startTurn}–${endTurn} 轮的剧情推进（时间：${state.worldTimeLabel || "未知"}）。`);
  }

  const entities = Array.from(
    new Set([
      ...state.presentNpcs,
      ...(prevLocation ? [prevLocation.replace(/[（(][^）)]*[）)]/g, "").trim()] : []),
      ...(state.location ? [state.location.replace(/[（(][^）)]*[）)]/g, "").trim()] : []),
    ].filter(Boolean)),
  ).slice(0, 8);

  return {
    id: `mb_auto_t${startTurn}_${endTurn}`,
    title: `第 ${chapterNum} 幕 · ${label}`,
    summary: bullets.map((b) => `- ${b}`).join("\n"),
    entities,
    keywords: entities,
    turnRange: [startTurn, endTurn],
    enabled: true,
    pinned: false,
    createdTurn: endTurn,
  };
}
