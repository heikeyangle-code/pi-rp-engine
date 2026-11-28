/**
 * Core types for pi-rp-engine v3.
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

export interface PiTuiLike {
  requestRender?: () => void;
}

export interface PiKeybindingsLike {
  matches?: (data: string, action: string) => boolean;
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
    factory: (
      tui: PiTuiLike,
      theme: unknown,
      keybindings: PiKeybindingsLike,
      done: (result?: T) => void,
    ) => unknown,
    options?: { overlay?: boolean; overlayOptions?: Record<string, unknown> },
  ): Promise<T | undefined>;
}

export interface PiModelDescriptor {
  provider?: string;
  api?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  [key: string]: unknown;
}

export interface PiModelRegistry {
  getAvailable?(): PiModelDescriptor[];
  getAll?(): PiModelDescriptor[];
  find?(provider: string, modelId: string): PiModelDescriptor | undefined;
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
  mode?: "tui" | "rpc" | "print" | "json" | string;
  model?: unknown;
  ui: PiUiContext;
  sessionManager: PiSessionManager;
  modelRegistry?: PiModelRegistry;
  hasUI?: boolean;
  signal?: AbortSignal;
  isProjectTrusted?: () => boolean;
  isIdle?(): boolean;
  abort?(): Promise<void> | void;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  fork?(entryId: string, options?: Record<string, unknown>): Promise<{ cancelled?: boolean }>;
  navigateTree?(targetId: string, options?: Record<string, unknown>): Promise<{ cancelled?: boolean }>;
}

export interface TurnEndEvent {
  turnIndex?: number;
  message?: PiMessage;
  messageEntryId?: string;
  toolResultEntryIds?: string[];
  outcome?: "completed" | "aborted" | "error";
  [key: string]: unknown;
}

export interface SessionShutdownEvent {
  reason?: string;
  [key: string]: unknown;
}

export interface SessionCompactEvent {
  compactionEntry?: PiSessionEntry;
  fromExtension?: boolean;
  [key: string]: unknown;
}

export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  defaultActive?: boolean;
  executionMode?: "parallel" | "sequential";
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  prepareArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
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

export type ToolDefinition = PiToolDefinition;

export interface PiExtensionAPI {
  on(event: "turn_end", handler: (event: TurnEndEvent, ctx: PiExtensionContext) => any): void;
  on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: PiExtensionContext) => any): void;
  on(event: "session_compact", handler: (event: SessionCompactEvent, ctx: PiExtensionContext) => any): void;
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
  getAllTools?(): Array<{ name: string; [key: string]: unknown }>;
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
  source: "mvu" | "macro" | "first_mes" | "constant_lore" | "init_var" | "html_table" | "llm_analyze";
  /** Owner namespace: "player" | "world" | specific NPC/character name (defaults to card character if omitted) */
  actorId?: string;
  /** Semantic routing category so bind hydrates stats, inventory, flags, clocks & anchors into the right subsystem */
  category?: "stat" | "inventory" | "clock" | "flag" | "anchor";
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
  initialObjective?: string;
  initialPresentNpcs: string[];
  initialInventory: Array<{ actorId?: string; item: string; count: number }>;
  /** Permanently cached LLM-extracted or salvaged multi-actor initial stats */
  initialStats?: SalvagedVariable[];
  /** Multi-actor CFSM axes (`actorId` defaults to primary card if omitted) */
  suggestedCfsmAxes: Array<CfsmAxisDef & { actorId?: string }>;
  /** Initial RoleMemo DualMem character beliefs & emotional subtext */
  initialBeliefs?: Array<{
    actorId: string;
    target: string;
    activatingEvent: string;
    belief: string;
    subjectiveInsight?: string;
    emotionalTone?: string;
  }>;
  /** Initial world facts & hidden character secrets (FANToM witness boundaries) */
  initialFacts?: Array<{
    statement: string;
    entities: string[];
    witnessIds: string[] | "public";
  }>;
  /** Initial planted Chekhov's guns / foreshadowing hooks */
  initialForesights?: Array<{
    summary: string;
    triggerHint: string;
    entities: string[];
  }>;
  /** Initial condition-gated plot twists & dynamic storylets (QBN) */
  initialStorylets?: Array<{
    title: string;
    triggerPrompt: string;
    gate?: GateCondition;
    postEffects?: StoryletEntry["postEffects"];
    oneTime?: boolean;
  }>;
  /** Initial countdown / tension clocks */
  initialClocks?: Array<{
    clockId: string;
    label: string;
    value: number;
    max: number;
  }>;
  entityAliases: Record<string, string[]>;
  voiceAnchors?: VoiceAnchor[];
  suggestedLoreGates: Array<{ entryId: string; title: string; gate: GateCondition; reason: string }>;
  source: "heuristic" | "llm-analyzed";
}


export interface CardChapterNode {
  id: string;
  title: string;
  path: string;
  level: number;
  charOffset: number;
  charLength: number;
  tokens: number;
  excerpt: string;
  passageIds: string[];
}

export interface CardPassageNode {
  id: string;
  chapterId: string;
  chapterPath: string;
  text: string;
  contextualPrefix: string;
  charOffset: number;
  tokens: number;
  entities: string[];
}

export interface CardEntityNode {
  canonical: string;
  aliases: string[];
  chapterIds: string[];
  passageIds: string[];
  contextHints: string[];
}

export interface CardKnowledgeIndex {
  version: number;
  contentHash: string;
  totalChars: number;
  totalTokens: number;
  dualTrackActive: boolean;
  directTokenLimit: number;
  skeletonTokenLimit: number;
  zone1Skeleton: string;
  chapters: CardChapterNode[];
  passages: CardPassageNode[];
  entities: CardEntityNode[];
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
  promptRegexRules?: CompiledRegexRule[];
  knowledgeIndex?: CardKnowledgeIndex;
  forceFullZone1?: boolean;
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
  /** Optional numeric stat threshold checks (e.g. affection >= 60 or sanity <= 30) */
  statChecks?: Array<{ actorId?: string; key: string; gte?: number; lte?: number }>;
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
  preventRecursion?: boolean;
  excludeRecursion?: boolean;
  revision?: number;
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
// 3. L1 Deterministic World Engine, Memory Books, DualMem, Storylets & X-Ray
// ---------------------------------------------------------------------------

export interface PersonaProfile {
  id: string;
  name: string;
  description: string;
}

export interface QuickReplyItem {
  id: string;
  label: string;
  text: string;
  /** "send" = submit immediately, "editor" = prefill input editor, "steer" = add 1-turn director note */
  mode: "send" | "editor" | "steer";
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

export interface ClockCompletionEffect {
  setFlags?: Record<string, boolean>;
  triggerStoryletId?: string;
  note?: string;
}

export interface ProgressClock {
  clockId: string;
  label: string;
  value: number;
  max: number;
  completed: boolean;
  completedTurn?: number;
  onComplete?: ClockCompletionEffect;
}

export interface ActiveCondition {
  id: string;
  actorId: string;
  label: string;
  effect?: string;
  remainingTurns: number | null;
  appliedTurn: number;
}

export interface RollRecord {
  turn: number;
  actor?: string;
  expression: string;
  statKey?: string;
  statBonus?: number;
  rolls: number[];
  keptRolls: number[];
  modifier: number;
  total: number;
  dc?: number;
  success?: boolean;
  critical: "nat_max" | "nat_min" | null;
  reason?: string;
  source: "tool" | "manual";
}

export interface BiTemporalFact {
  id: string;
  statement: string;
  entities: string[];
  /** World validity axis (valid time): turn when this fact became true in-world */
  validFromTurn: number;
  /** World validity axis: turn when superseded/invalidated (null = currently true) */
  validUntilTurn: number | null;
  /** Transaction axis (ingestion time): turn when the ledger learned/recorded this fact */
  ingestedAtTurn?: number;
  /** Optional in-world calendar/clock label when the event occurred */
  eventTimeLabel?: string;
  supersededBy?: string;
  witnessIds: string[] | "public";
  gate?: GateCondition;
  causeEvent?: string;
}

/** RoleMemo / DualMem: separates objective event from character's persona-conditioned subjective insight. */
export interface DreamBelief {
  id?: string;
  actorId: string;
  target: string;
  activatingEvent: string;
  belief: string;
  /** Optional persona-conditioned emotional/psychological subtext (DualMem insight stream) */
  subjectiveInsight?: string;
  emotionalTone?: string;
  turn: number;
}

/** Memory Books: keyword/entity-recalled scene chapter archive that scales past 200+ turns without eviction. */
export interface MemoryBookEntry {
  id: string;
  title: string;
  summary: string;
  entities: string[];
  keywords: string[];
  turnRange: [number, number];
  enabled: boolean;
  pinned?: boolean;
  createdTurn: number;
}

/** Dynamic Storylet: condition-gated plot beat / tension trigger that activates when world state matches. */
export interface StoryletEntry {
  id: string;
  title: string;
  triggerPrompt: string;
  gate?: GateCondition;
  /** Optional postconditions automatically applied when the storylet completes */
  postEffects?: {
    setFlags?: Record<string, boolean>;
    nextObjective?: string;
  };
  oneTime?: boolean;
  status: "armed" | "triggered" | "completed";
  createdTurn: number;
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

/** First-class Choice Consequence Echo: tracks player decisions that boomerang back 3–30 turns later. */
export interface ConsequenceEcho {
  id: string;
  choice: string;
  consequence: string;
  entities: string[];
  weight: "low" | "medium" | "high";
  plantedTurn: number;
  status: "pending" | "echoed" | "resolved";
  echoedTurn?: number;
}

/** Spatial Memory Graph edge connecting two visited/known locations (LLM-MapRepair). */
export interface LocationEdge {
  id: string;
  from: string;
  to: string;
  travelNote?: string;
  oneWay?: boolean;
  discoveredTurn: number;
}

/** Explicit NPC commitment / promise ledger so NPCs never forget what they promised. */
export interface NpcCommitment {
  id: string;
  actor: string;
  target: string;
  promise: string;
  dueTurn?: number;
  dueLabel?: string;
  createdTurn: number;
  status: "active" | "fulfilled" | "broken";
}

/** Faction standing & Blades-in-the-Dark Heat tracker. */
export interface FactionStanding {
  name: string;
  standing: number; // -100 to +100
  heat: number;     // 0 to 6
  stance: string;
  note?: string;
  updatedTurn: number;
  lastPressureTurn?: number;
}

/** Lightweight pure-text tactical encounter state (only active during clashes/chases). */
export interface ActiveEncounter {
  title: string;
  stakes: string;
  round: number;
  combatants: Array<{ name: string; position?: string; status?: string }>;
  startedTurn: number;
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

export interface TxAuditRecord {
  id: string;
  turn: number;
  summary: string;
  source: "user" | "tool" | "sidecar" | "system";
  undoTx?: RpTxEntry;
}

export interface LoreRecallTraceItem {
  id: string;
  title: string;
  source: "lore" | "memory_book" | "card_knowledge";
  reason: "sticky" | "direct_key" | "ppr_2hop" | "bm25" | "static" | "pinned" | "semantic_rrf";
  matchedKey?: string;
  score: number;
  tokens: number;
}

export interface ContextXRaySnapshot {
  turn: number;
  timestamp: number;
  toolsHash?: string;
  zone1Hash: string;
  zone2PrefixMatch?: boolean;
  cacheInvalidationReason?: "first_turn" | "prefix_hit" | "tools_changed" | "zone1_changed" | "history_mutated";
  cacheHitStreak: number;
  zone1Tokens: number;
  zone2Tokens: number;
  zone3Tokens: number;
  loreTokens: number;
  loreBudget: number;
  recalled: LoreRecallTraceItem[];
  gatedOut: Array<{ id: string; title: string }>;
  budgetDropped: Array<{ id: string; title: string; tokens: number }>;
  activeFactCount: number;
  blindSpotCount: number;
  activeStoryletTitles: string[];
  hiddenFloorCount: number;
  /** Real lexical repetition overlap (0..1) across recent assistant replies */
  repetitionScore?: number;
  /** Turns elapsed since last meaningful world-state mutation */
  stagnantTurns?: number;
  aliasExpansions?: string[];
  zone3ConstLoreTokens?: number;
}


export interface VoiceAnchor {
  actorId: string;
  /** 2-3 verbatim short dialogue samples capturing cadence, slang, and speech rhythm */
  speechSamples: string[];
  /** Non-negotiable core stance / self-interest / anti-sycophancy boundary */
  backbone: string;
  /** Behaviors this character will NEVER do out of character */
  tabooBehaviors?: string;
}

export interface PhysicalSnapshot {
  actorId: string;
  attire?: string;
  outfit?: string;
  condition?: string;
  holding?: string;
  position?: string;
  posture?: string;
  updatedTurn: number;
}

export interface NpcAgenda {
  actorId: string;
  goal: string;
  currentActivity: string;
  /** Optional countdown turns until arrival / off-screen milestone triggers (0 = due now) */
  etaTurns?: number | null;
  updatedTurn: number;
}

export interface NpcPairBond {
  id: string;
  actorA: string;
  actorB: string;
  stance: string;
  tension: number;
  note: string;
  updatedTurn: number;
  lastCrisisTurn?: number;
}

export interface EmbeddingConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
}

export type SettlementMode = "off" | "tool-assisted" | "sidecar-light";
export type HudMode = "minimal" | "full" | "off";
export type PacingMode = "relaxed" | "balanced" | "dramatic";
export type ResponseLengthMode = "concise" | "standard" | "novel";
export type NarrativePovMode = "auto" | "second" | "third" | "first_char";

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
      responseLength?: ResponseLengthMode;
      narrativePov?: NarrativePovMode;
      bannedPhrases?: string[];
      rawPassthrough?: boolean;
      loreTokenBudget?: number;
      sidecarModel?: string | null;
      innerMonologue?: boolean;
      applyPresetSampling?: boolean;
    }
  | { kind: "persona_set"; persona: PersonaProfile }
  | { kind: "note_set"; note: DirectorNote }
  | { kind: "note_clear"; noteId?: string }
  | { kind: "hide_toggle"; entryIds: string[]; fingerprints?: string[]; hidden: boolean }
  | { kind: "cast_set"; slugs: string[] }
  | { kind: "lore_toggle"; entryId: string; enabled: boolean }
  | { kind: "clock_tick"; beatDelta: number; worldTimeLabel?: string; dayDelta?: number; phase?: string }
  | { kind: "location_set"; location: string; presentNpcs: string[] }
  | { kind: "scene_objective_set"; objective: string }
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
  | {
      kind: "progress_clock";
      clockId: string;
      label: string;
      delta: number;
      max: number;
      completed?: boolean;
      onComplete?: ClockCompletionEffect;
    }
  | { kind: "fact_add"; fact: BiTemporalFact }
  | { kind: "fact_update"; factId: string; statement?: string; witnessIds?: string[] | "public"; entities?: string[] }
  | { kind: "fact_invalidate"; factId: string; validUntilTurn: number; supersededBy?: string; reason: string }
  | {
      kind: "belief_update";
      id?: string;
      actorId: string;
      target: string;
      activatingEvent: string;
      belief: string;
      subjectiveInsight?: string;
      emotionalTone?: string;
      turn: number;
    }
  | { kind: "belief_remove"; index?: number; id?: string }
  | { kind: "memory_book_upsert"; entry: MemoryBookEntry }
  | { kind: "memory_book_delete"; entryId: string }
  | { kind: "storylet_upsert"; storylet: StoryletEntry }
  | { kind: "storylet_delete"; storyletId: string }
  | { kind: "foresight_upsert"; hook: ForesightHook }
  | { kind: "consequence_upsert"; echo: ConsequenceEcho }
  | { kind: "consequence_delete"; echoId: string }
  | { kind: "route_upsert"; edge: LocationEdge }
  | { kind: "route_delete"; routeId: string }
  | { kind: "commitment_upsert"; commitment: NpcCommitment }
  | { kind: "commitment_delete"; commitmentId: string }
  | { kind: "faction_upsert"; faction: FactionStanding }
  | { kind: "faction_delete"; name: string }
  | { kind: "fact_spread"; factId: string; newWitnesses: string[]; via?: string }
  | { kind: "encounter_set"; encounter: ActiveEncounter | null }
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
  | { kind: "voice_anchor_upsert"; anchor: VoiceAnchor }
  | { kind: "voice_anchor_delete"; actorId: string }
  | { kind: "physical_patch"; snapshot: PhysicalSnapshot; spatialNotes?: string; reason?: string }
  | { kind: "agenda_upsert"; agenda: NpcAgenda }
  | { kind: "clock_delete"; clockId: string }
  | { kind: "agenda_delete"; actorId: string }
  | { kind: "pair_bond_upsert"; bond: NpcPairBond }
  | { kind: "pair_bond_delete"; id: string }
  | { kind: "lore_runtime"; sticky: Record<string, number>; cooldown: Record<string, number>; consumedOneShots: string[] }
  | { kind: "anti_godmoding_set"; enabled: boolean }
  | { kind: "tension_set"; value: number; reason?: string }
  | { kind: "condition_upsert"; condition: ActiveCondition }
  | { kind: "condition_remove"; id: string; reason?: string }
  | { kind: "roll_record"; roll: RollRecord };

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
  responseLength: ResponseLengthMode;
  narrativePov: NarrativePovMode;
  bannedPhrases: string[];
  loreTokenBudget: number;
  loreBudgetUserSet?: boolean;
  sidecarModel?: string;
  innerMonologue: boolean;
  applyPresetSampling: boolean;
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
  sceneObjective: string;
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
  memoryBooks: Map<string, MemoryBookEntry>;
  storylets: Map<string, StoryletEntry>;
  foresights: Map<string, ForesightHook>;
  consequences: Map<string, ConsequenceEcho>;
  objectiveUpdatedTurn: number;
  locationGraph: Record<string, LocationEdge>;
  commitments: Map<string, NpcCommitment>;
  factions: Record<string, FactionStanding>;
  encounter: ActiveEncounter | null;
  notes: DirectorNote[];
  hiddenEntryIds: Set<string>;
  hiddenFingerprints: Set<string>;
  loreOverrides: Record<string, boolean>;
  loreSticky: Record<string, number>;
  loreCooldown: Record<string, number>;
  loreConsumedOneShots: Set<string>;
  /** Turn index of last meaningful world mutation (used by real stagnation detector) */
  lastMeaningfulProgressTurn: number;
  initialLocation: string;
  voiceAnchors: Record<string, VoiceAnchor>;
  physicalState: Record<string, PhysicalSnapshot>;
  spatialNotes: string;
  npcAgendas: Record<string, NpcAgenda>;
  pairBonds: Record<string, NpcPairBond>;
  auditLog: TxAuditRecord[];
  antiGodmoding?: boolean;
  sceneTension?: number;
  lastSidecarStatus?: { turn: number; ok: boolean; summary: string };
  slopCounts?: Record<string, number>;
  conditions: Record<string, ActiveCondition>;
  lastRoll: RollRecord | null;
}
