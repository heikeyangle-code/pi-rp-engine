/**
 * EverMemOS MemScene Compaction (`session_before_compact`) & Inter-Act Montage generator.
 * Condenses older turns into structured narrative MemScenes without duplicating live L1 state,
 * and returns official Pi SDK `{ summary, firstKeptEntryId, tokensBefore, details }`.
 */

import type { PiMessage, SessionRpState } from "../types.js";
import { getActiveFacts } from "./bitemporal.js";

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

/** Condense a slice of historical Pi messages into compact narrative beat bullets. */
export function condenseMessagesToBeats(messages: PiMessage[] | undefined, maxBeats = 10): string {
  if (!messages || messages.length === 0) return "";
  const dialog = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (dialog.length === 0) return "";

  // Sample evenly if there are many messages so both early and late turning points survive
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
    lines.push("## 人物信念演化（DREAM ABC）");
    for (const b of recentBeliefs) {
      lines.push(`- ${b.actorId} → ${b.target} [T${b.turn}]：因「${b.activatingEvent}」形成信念「${b.belief}」`);
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
  lines.push(`- 账本注记：${activeCount} 条有效双时态事实与全部 L1 数值/背包实时挂载于 <rp_state_frame>，此处不重复赘述。`);

  if (options?.previousSummary?.trim()) {
    lines.push(`## 更早幕次脉络\n${options.previousSummary.trim().slice(0, 1200)}`);
  }

  const beats = options?.droppedMessagesSummary?.trim() || condenseMessagesToBeats(options?.messagesToSummarize);
  if (beats) {
    lines.push(`## 本段关键剧情节拍\n${beats}`);
  }

  return lines.join("\n");
}
