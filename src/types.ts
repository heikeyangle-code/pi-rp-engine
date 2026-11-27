/**
 * Core types for pi-rp-engine.
 * Zero runtime dependencies: includes structural types matching official
 * @earendil-works/pi-coding-agent (1.6.1+) ExtensionAPI so the extension
 * type-checks cleanly standalone and loads directly via Pi VIRTUAL_MODULES.
 */

// ---------------------------------------------------------------------------
// 1. Structural types for Official Pi SDK 1.6.1 ExtensionAPI
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

export type PiContentBlock = PiContentText | PiContentImage | Record<string, unknown>;

export interface PiMessage {
  role: "user" | "assistant" | "toolResult" | "custom" | string;
  content: string | PiContentBlock[];
  customType?: string;
  display?: boolean;
  details?: unknown;
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
  timestamp?: number;
  [key: string]: unknown;
}

export interface PiSessionManager {
  getBranch(fromId?: string): PiSessionEntry[];
  getEntries(): PiSessionEntry[];
  getLeafId(): string | null;
  getSessionId?(): string;
  getSessionFile?(): string | null;
  getCwd?(): string;
}

export interface PiUiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | ((tui: unknown, theme: unknown) => unknown) | undefined): void;
  setHeader?(factory: ((tui: unknown, theme: unknown) => unknown) | undefined): void;
  setFooter?(factory: ((tui: unknown, theme: unknown) => unknown) | undefined): void;
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
  complete?(
    model: unknown,
    context: { systemPrompt?: string; messages: Array<{ role: string; content: string | PiContentBlock[] }> },
    options?: Record<string, unknown>,
  ): Promise<{ content?: PiContentBlock[]; text?: string } | null>;
}

export interface PiExtensionContext {
  cwd: string;
  model?: unknown;
  ui: PiUiContext;
  sessionManager: PiSessionManager;
  modelRegistry?: PiModelRegistry;
  hasUI?: boolean;
  isIdle?(): boolean;
  abort?(): Promise<void> | void;
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
  renderResult?(result: { content: PiContentBlock[]; details?: unknown; isError?: boolean }, options: { expanded?: boolean; isPartial?: boolean }, theme: unknown): unknown;
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

export interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx: PiExtensionContext) => any): void;
  registerTool(tool: PiToolDefinition): void;
  registerCommand(name: string, def: PiCommandDefinition): void;
  registerShortcut?(shortcut: string, def: PiShortcutDefinition): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: { customType: string; content: string | PiContentBlock[]; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" },
  ): void;
  setLabel?(entryId: string, label: string): void;
  registerMarkdownTransformer?(
    fn: (markdown: string, ctx?: { messageType?: string; isStreaming?: boolean }) => string,
    options?: { messageTypes?: string[] },
  ): void;
  registerMessageRenderer?(customType: string, fn: (message: PiMessage, options: { expanded?: boolean }, theme: unknown) => unknown): void;
  registerEntryRenderer?(customType: string, fn: (entry: PiSessionEntry, options: { expanded?: boolean }, theme: unknown) => unknown): void;
}

// ---------------------------------------------------------------------------
// 2. Character Card, Lorebook & Preset Compilation Types
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
  /** Optional display-only regex rules (pure text, zero HTML/JS) */
  displayRegexRules: Array<{ name: string; pattern: string; flags: string; replacement: string }>;
  salvagedStateSchema: SalvagedVariable[];
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
  selective: boolean;
  selectiveLogic: SelectiveLogic;
  useRegex: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  priority: number;
  position: number;
  depthHint: number;
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
// 3. L1 Deterministic World Engine & Session Tree Event Sourcing
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

export type SettlementMode = "off" | "tool-assisted" | "sidecar-light";
export type HudMode = "minimal" | "full" | "off";

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
    }
  | { kind: "unbind" }
  | { kind: "preset_set"; presetId: string | null }
  | { kind: "config_patch"; hudMode?: HudMode; settlementMode?: SettlementMode; rawPassthrough?: boolean; loreTokenBudget?: number; sidecarModel?: string }
  | { kind: "persona_set"; persona: PersonaProfile }
  | { kind: "note_set"; note: DirectorNote }
  | { kind: "note_clear"; noteId?: string }
  | { kind: "hide_toggle"; entryIds: string[]; hidden: boolean }
  | { kind: "cast_set"; slugs: string[] }
  | { kind: "clock_tick"; beatDelta: number; worldTimeLabel?: string; dayDelta?: number; phase?: string }
  | { kind: "location_set"; location: string; presentNpcs: string[] }
  | { kind: "flag_set"; flag: string; value: boolean }
  | { kind: "cfsm_define"; actorId: string; def: CfsmAxisDef }
  | { kind: "cfsm_transition"; actorId: string; axis: string; from: string; to: string; reason: string; turn: number }
  | { kind: "stat_patch"; actorId: string; key: string; op: "set" | "add"; value: number | string | boolean; min?: number; max?: number; reason?: string }
  | { kind: "inventory_patch"; actorId: string; item: string; delta: number; note?: string }
  | { kind: "progress_clock"; clockId: string; label: string; delta: number; max: number; completed?: boolean }
  | { kind: "fact_add"; fact: BiTemporalFact }
  | { kind: "fact_invalidate"; factId: string; validUntilTurn: number; supersededBy?: string; reason: string }
  | { kind: "belief_update"; actorId: string; target: string; activatingEvent: string; belief: string; turn: number }
  | { kind: "foresight_upsert"; hook: ForesightHook }
  | { kind: "era_advance"; fromEra: string; toEra: string; milestoneUnlocked: string[]; montageSummary: string; turn: number }
  | { kind: "lore_runtime"; sticky: Record<string, number>; cooldown: Record<string, number>; consumedOneShots: string[] };

export interface SessionRpState {
  active: boolean;
  explicitlyUnbound: boolean;
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
  loreTokenBudget: number;
  sidecarModel?: string;
  initialPersona: PersonaProfile | null;
  currentPersona: PersonaProfile;
  personaChangedMidSession: boolean;
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
  loreSticky: Record<string, number>;
  loreCooldown: Record<string, number>;
  loreConsumedOneShots: Set<string>;
}

export interface ProjectWorldConfig {
  defaultCardSlug: string;
  defaultPresetId?: string;
  defaultPersonaId?: string;
  activeCharacters?: string[];
  rawPassthrough?: boolean;
  hudMode?: HudMode;
  settlementMode?: SettlementMode;
  loreTokenBudget?: number;
}
