/**
 * Core types for pi-rp-engine v2.
 * Zero third-party runtime dependencies: structural types match the official
 * @earendil-works/pi-coding-agent (1.6.1+) ExtensionAPI so the extension compiles
 * cleanly standalone and loads directly via Pi VIRTUAL_MODULES.
 */

// ---------------------------------------------------------------------------
// 1. Structural types for Official Pi SDK (1.6.1+) ExtensionAPI
// ---------------------------------------------------------------------------

export interface PiContentText {
  type: "text";
  text: string;
}

export interface PiContentImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface PiContentToolCall {
  type: "toolCall" | "tool_use";
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export type PiContentBlock = PiContentText | PiContentImage | PiContentToolCall | Record<string, unknown>;

export interface PiMessage {
  role: "user" | "assistant" | "toolResult" | "custom" | string;
  content: string | PiContentBlock[];
  customType?: string;
  display?: boolean;
  details?: unknown;
  stopReason?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface PiSessionEntry {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: unknown;
  message?: PiMessage;
  targetId?: string;
  label?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface PiSessionManager {
  getBranch(fromId?: string): PiSessionEntry[];
  getEntries(): PiSessionEntry[];
  getLeafId(): string | null;
  getLabel?(entryId: string): string | undefined;
  getSessionId?(): string;
  getSessionFile?(): string | null;
  getCwd?(): string;
}

export interface PiUiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | ((tui: unknown, theme: unknown) => unknown) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  setHeader?(factory: ((tui: unknown, theme: unknown) => unknown) | undefined): void;
  setFooter?(factory: ((tui: unknown, theme: unknown) => unknown) | undefined): void;
  setTitle?(title: string): void;
  setWorkingMessage?(message?: string): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, initialText?: string): Promise<string | undefined>;
  setEditorText(text: string): void;
  custom?<T = unknown>(
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result?: T) => void) => unknown,
    options?: { overlay?: boolean },
  ): Promise<T | undefined>;
}

export interface PiModelRegistry {
  getAvailable?(): unknown[];
  find?(provider: string, modelId: string): unknown;
  streamSimple?(
    model: unknown,
    context: { systemPrompt?: string; messages: Array<{ role: string; content: string | PiContentBlock[]; timestamp?: number }> },
    options?: Record<string, unknown>,
  ): { result(): Promise<{ content?: PiContentBlock[]; text?: string } | null> };
  complete?(
    model: unknown,
    context: { systemPrompt?: string; messages: Array<{ role: string; content: string | PiContentBlock[]; timestamp?: number }> },
    options?: Record<string, unknown>,
  ): Promise<{ content?: PiContentBlock[]; text?: string } | null>;
}

export interface PiExtensionContext {
  cwd: string;
  mode?: "tui" | "rpc" | "print" | string;
  model?: unknown;
  ui: PiUiContext;
  sessionManager: PiSessionManager;
  modelRegistry?: PiModelRegistry;
  hasUI?: boolean;
  signal?: AbortSignal;
  isIdle?(): boolean;
  abort?(): Promise<void> | void;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  fork?(entryId: string, options?: Record<string, unknown>): Promise<{ cancelled?: boolean }>;
  navigateTree?(targetId: string, options?: Record<string, unknown>): Promise<{ cancelled?: boolean }>;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  defaultActive?: boolean;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
    ctx?: PiExtensionContext,
  ): Promise<{ content: PiContentBlock[]; details?: unknown; isError?: boolean }>;
  renderCall?(args: Record<string, unknown>, theme: unknown): unknown;
  renderResult?(
    result: { content: PiContentBlock[]; details?: unknown; isError?: boolean },
    options: { expanded?: boolean; isPartial?: boolean },
    theme: unknown,
  ): unknown;
}

export interface PiCommandDefinition {
  description: string;
  getArgumentCompletions?(prefix: string): Array<{ value: string; label?: string; description?: string }> | null;
  handler(args: string, ctx: PiExtensionContext): Promise<void> | void;
}

export interface PiShortcutDefinition {
  description: string;
  handler(ctx: PiExtensionContext): Promise<void> | void;
}

export interface PiCompactionPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  messagesToSummarize?: PiMessage[];
  previousSummary?: string;
}

export interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx: PiExtensionContext) => any): void;
  registerTool(tool: PiToolDefinition): void;
  registerCommand(name: string, def: PiCommandDefinition): void;
  registerShortcut?(shortcut: string, def: PiShortcutDefinition): void;
  registerFlag?(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag?(name: string): boolean | string | undefined;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: { customType: string; content: string | PiContentBlock[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage?(
    content: string | PiContentBlock[],
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void;
  setSessionName?(name: string): void;
  getSessionName?(): string | undefined;
  setLabel?(entryId: string, label: string | undefined): void;
  registerMarkdownTransformer?(
    fn: (markdown: string, ctx?: { messageType?: string; isStreaming?: boolean }) => string,
    options?: { messageTypes?: string[] },
  ): void;
  registerMessageRenderer?(
    customType: string,
    fn: (message: PiMessage, options: { expanded?: boolean }, theme: unknown) => unknown,
  ): void;
  registerEntryRenderer?(
    customType: string,
    fn: (entry: PiSessionEntry, options: { expanded?: boolean }, theme: unknown) => unknown,
  ): void;
}

// ---------------------------------------------------------------------------
// 2. Character Card, Lorebook, Regex & Preset Compilation Types
// ---------------------------------------------------------------------------

export type CardSpecOrigin = "v1" | "v2" | "v3" | "charx";

export interface SalvagedVariable {
  key: string;
  initialValue: number | string | boolean;
  source: "mvu" | "macro" | "first_mes" | "constant_lore";
  min?: number;
  max?: number;
  note?: string;
}

export interface CompiledRegexRule {
  name: string;
  pattern: string;
  flags: string;
  replacement: string;
  /** Official SillyTavern placements: 1=USER_INPUT, 2=AI_OUTPUT, 3=SLASH, 5=WORLD_INFO, 6=REASONING */
  placements: number[];
  trimStrings: string[];
  /** 0=NONE, 1=RAW, 2=ESCAPED */
  substituteRegex: 0 | 1 | 2;
  markdownOnly: boolean;
  promptOnly: boolean;
  minDepth?: number;
  maxDepth?: number;
}

export interface ImportAuditReport {
  specOrigin: CardSpecOrigin;
  rawPassthrough: boolean;
  preservedFields: string[];
  mesExampleCharsBefore: number;
  mesExampleCharsAfter: number;
  strippedItems: Array<{ field: string; kind: string; preview: string; charsRemoved: number }>;
  deduplicatedRules: Array<{ field: string; preview: string }>;
  salvagedVariables: SalvagedVariable[];
  loreCount: number;
  constantLoreCount: number;
  dynamicLoreCount: number;
  skippedAssets: Array<{ type: string; name: string; reason: string }>;
  warnings: string[];
}

export type CardArchetype =
  | "companion"
  | "slice-of-life"
  | "rpg-sandbox"
  | "mystery"
  | "epic-saga"
  | "ensemble";

export interface WorldProfileModules {
  stats: boolean;
  inventory: boolean;
  clocks: boolean;
  stages: boolean;
}

export interface CardWorldProfile {
  archetype: CardArchetype;
  modules: WorldProfileModules;
  initialLocation?: string;
  initialTime?: string;
  initialStage?: string;
  initialPresentNpcs: string[];
  initialInventory: Array<{ item: string; count: number }>;
  suggestedCfsmAxes: CfsmAxisDef[];
  entityAliases: Record<string, string[]>;
  suggestedLoreGates: Array<{ entryId: string; title: string; gate: GateCondition; reason: string }>;
  source: "heuristic" | "llm-analyzed";
}

export interface CompiledCard {
  id: string;
  slug: string;
  specOrigin: CardSpecOrigin;
  rawPassthrough: boolean;
  identity: {
    name: string;
    nickname?: string;
    aliases: string[];
    avatarPath?: string;
    talkativeness?: number;
  };
  /** Zone 1 frozen content (100% preserved soul fields) */
  frozen: {
    systemPrompt: string;
    description: string;
    personality: string;
    scenario: string;
    mesExample: string;
    constantLoreIds: string[];
  };
  /** Zone 3 high-attention tail instructions (100% preserved) */
  tailInstructions: {
    depthPrompt?: { content: string; depth: number; role: "system" | "user" | "assistant" };
    postHistoryInstructions: string;
  };
  greetings: {
    firstMes: string;
    alternates: string[];
    groupOnly: string[];
  };
  assets: Array<{ type: string; name: string; localPath: string; ext: string }>;
  /** UI-only metadata (0 LLM tokens) */
  meta: {
    creator?: string;
    version?: string;
    tags: string[];
    creatorNotes?: string;
    creatorNotesMultilingual?: Record<string, string>;
    source?: string[];
  };
  /** Pure-text display regex rules (AI_OUTPUT, zero HTML/JS) */
  displayRegexRules: CompiledRegexRule[];
  salvagedStateSchema: SalvagedVariable[];
  worldProfile?: CardWorldProfile;
  loreBook: CompiledLoreBook;
  importReport: ImportAuditReport;
}

export interface GateCondition {
  minTurn?: number;
  everyNTurns?: number;
  requiredEra?: string;
  requiredMilestones?: string[];
  forbiddenFlags?: string[];
  requiredFlags?: string[];
  requiredLocations?: string[];
  requiredNpcPresent?: string[];
}

export type SelectiveLogic = "AND_ANY" | "NOT_ALL" | "NOT_ANY" | "AND_ALL";

export interface CompiledLoreEntry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  constant: boolean;
  manualRecallOnly: boolean;
  keys: string[];
  secondaryKeys: string[];
  /** Independent CCV3 @@exclude_keys (never clobbers selectiveLogic!) */
  excludeKeys: string[];
  selective: boolean;
  selectiveLogic: SelectiveLogic;
  useRegex: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  priority: number;
  /** 0=before_char, 1=after_char, 2=an_top, 3=an_bottom, 4=in_chat(@D), 5=before_example, 6=after_example, 7=outlet */
  position: number;
  depthHint: number;
  reverseDepth?: number;
  role?: "system" | "user" | "assistant";
  scanDepthOverride?: number;
  pinned: boolean;
  lowBudgetPriority: boolean;
  stickyTurns: number;
  stickyPermanent: boolean;
  cooldownTurns: number;
  oneShot: boolean;
  probability: number;
  useProbability: boolean;
  group?: string;
  groupOverride?: boolean;
  groupWeight: number;
  useGroupScoring?: boolean;
  noGraphSpread: boolean;
  graphSecondHopOnly: boolean;
  outletName?: string;
  staticPrebound: boolean;
  gate?: GateCondition;
  entities: string[];
}

export interface CompiledLoreBook {
  name?: string;
  description?: string;
  tokenBudget: number;
  scanDepth: number;
  entries: CompiledLoreEntry[];
  warnings: string[];
}

/** Compiled SillyTavern OpenAI / Chat Completion Preset mapped cleanly to Zone 1 + Zone 3 */
export interface CompiledPresetPrompt {
  identifier: string;
  name: string;
  role: "system" | "user" | "assistant";
  content: string;
  zone: "zone1" | "zone3";
  depth: number;
  order: number;
}

export interface CompiledPreset {
  id: string;
  name: string;
  zone1Prompts: CompiledPresetPrompt[];
  zone3Prompts: CompiledPresetPrompt[];
  utilityPrompts: {
    newChat?: string;
    continueNudge?: string;
    impersonation?: string;
    wiFormat?: string;
  };
  sampling: {
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    maxTokens?: number;
    maxContext?: number;
  };
  strippedCount: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 3. L1 Deterministic World Engine & Session-Only Event Sourcing
// ---------------------------------------------------------------------------

export interface PersonaProfile {
  id: string;
  name: string;
  description: string;
}

export interface CfsmAxisDef {
  axis: string;
  states: string[];
  initial: string;
  transitions?: Record<string, string[]>;
}

export interface CfsmStateRecord {
  actorId: string;
  axis: string;
  state: string;
  updatedTurn: number;
  reason?: string;
}

export interface ProgressClock {
  clockId: string;
  label: string;
  value: number;
  max: number;
  completed: boolean;
}

export interface BiTemporalFact {
  id: string;
  statement: string;
  entities: string[];
  validFromTurn: number;
  validUntilTurn: number | null;
  supersededBy?: string;
  witnessIds: string[] | "public";
  gate?: GateCondition;
  causeEvent?: string;
}

export interface DreamBelief {
  actorId: string;
  target: string;
  activatingEvent: string;
  belief: string;
  turn: number;
}

export interface ForesightHook {
  id: string;
  summary: string;
  entities: string[];
  plantedTurn: number;
  triggerHint: string;
  dueClockId?: string;
  status: "open" | "paid_off" | "expired";
}

export interface DirectorNote {
  id: string;
  text: string;
  remainingTurns: number | null; // null = permanent until cleared
}

export interface HiddenFloorTarget {
  entryId: string;
  fingerprint?: string;
}

export type SettlementMode = "off" | "tool-assisted" | "sidecar-light";
export type HudMode = "minimal" | "full" | "off";
export type PacingMode = "relaxed" | "balanced" | "dramatic";

export type RpTxEntry =
  | {
      kind: "bind";
      cardId: string;
      cardSlug: string;
      cardSource: "project" | "library";
      worldDir: string;
      greetingIndex: number;
      activeCharacters: string[];
      presetId?: string;
      rawPassthrough?: boolean;
      persona?: PersonaProfile;
    }
  | { kind: "unbind" }
  | { kind: "preset_set"; presetId: string | null }
  | {
      kind: "config_patch";
      hudMode?: HudMode;
      settlementMode?: SettlementMode;
      pacingMode?: PacingMode;
      rawPassthrough?: boolean;
      loreTokenBudget?: number;
      sidecarModel?: string;
    }
  | { kind: "persona_set"; persona: PersonaProfile }
  | { kind: "note_set"; note: DirectorNote }
  | { kind: "note_clear"; noteId?: string }
  | { kind: "hide_toggle"; entryIds: string[]; fingerprints?: string[]; hidden: boolean }
  | { kind: "cast_set"; slugs: string[] }
  | { kind: "lore_toggle"; entryId: string; enabled: boolean }
  | { kind: "clock_tick"; beatDelta: number; worldTimeLabel?: string; dayDelta?: number; phase?: string }
  | { kind: "location_set"; location: string; presentNpcs: string[] }
  | { kind: "flag_set"; flag: string; value: boolean }
  | { kind: "cfsm_define"; actorId: string; def: CfsmAxisDef }
  | { kind: "cfsm_transition"; actorId: string; axis: string; from: string; to: string; reason: string; turn: number }
  | {
      kind: "stat_patch";
      actorId: string;
      key: string;
      op: "set" | "add";
      value: number | string | boolean;
      min?: number;
      max?: number;
      reason?: string;
    }
  | { kind: "inventory_patch"; actorId: string; item: string; delta: number; note?: string }
  | { kind: "progress_clock"; clockId: string; label: string; delta: number; max: number; completed?: boolean }
  | { kind: "fact_add"; fact: BiTemporalFact }
  | { kind: "fact_invalidate"; factId: string; validUntilTurn: number; supersededBy?: string; reason: string }
  | { kind: "belief_update"; actorId: string; target: string; activatingEvent: string; belief: string; turn: number }
  | { kind: "foresight_upsert"; hook: ForesightHook }
  | {
      kind: "era_advance";
      fromEra: string;
      toEra: string;
      milestoneUnlocked: string[];
      montageSummary: string;
      turn: number;
    }
  | {
      kind: "profile_apply";
      archetype: CardArchetype;
      modules: WorldProfileModules;
      initialStage?: string;
      initialTime?: string;
    }
  | { kind: "lore_runtime"; sticky: Record<string, number>; cooldown: Record<string, number>; consumedOneShots: string[] };

export interface SessionRpState {
  active: boolean;
  cardId: string | null;
  cardSlug: string | null;
  cardSource: "project" | "library" | null;
  worldDir: string | null;
  greetingIndex: number;
  activeCharacters: string[];
  presetId: string | null;
  rawPassthrough: boolean;
  hudMode: HudMode;
  settlementMode: SettlementMode;
  pacingMode: PacingMode;
  loreTokenBudget: number;
  sidecarModel?: string;
  initialPersona: PersonaProfile | null;
  currentPersona: PersonaProfile;
  personaChangedMidSession: boolean;
  archetype: CardArchetype;
  modules: WorldProfileModules;
  turn: number;
  beat: number;
  day: number;
  worldTimeLabel: string;
  phase: string;
  era: string;
  milestones: Set<string>;
  flags: Record<string, boolean>;
  location: string;
  presentNpcs: string[];
  stats: Record<string, Record<string, number | string | boolean>>;
  statBounds: Record<string, Record<string, { min?: number; max?: number }>>;
  inventory: Record<string, Record<string, number>>;
  cfsmDefs: Record<string, Record<string, CfsmAxisDef>>;
  cfsmStates: Record<string, Record<string, CfsmStateRecord>>;
  clocks: Record<string, ProgressClock>;
  facts: Map<string, BiTemporalFact>;
  beliefs: DreamBelief[];
  foresights: Map<string, ForesightHook>;
  notes: DirectorNote[];
  hiddenEntryIds: Set<string>;
  hiddenFingerprints: Set<string>;
  loreOverrides: Record<string, boolean>;
  loreSticky: Record<string, number>;
  loreCooldown: Record<string, number>;
  loreConsumedOneShots: Set<string>;
}
