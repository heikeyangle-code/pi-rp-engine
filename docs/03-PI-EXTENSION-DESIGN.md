# 03 · 基于官方 Pi SDK 的标准扩展工程设计

> **核心承诺**：本扩展 **100% 仅使用官方 `@earendil-works/pi-coding-agent` 公开扩展 API**，不修改 `pi-android` 一行代码，不破坏桌面端 Pi 与手机端 `pi-android` 的 1:1 一致性。

---

## 一、严格单会话存活（Session-Only）与彻底退出生命周期模型

> **v2 重要架构修正**：已彻底废弃旧版 `<cwd>/.pi/rp/world.json` 项目级自动绑定机制！项目级自动绑定会导致同一项目下新建的普通编程会话误入 RP 模式。v2 强制执行 **「素材库被动存放，激活严格限定于单个会话，退出即彻底清零」**。

### 1. 安装与绝对静默机制（Zero-Pollution Dormancy）
- 扩展**全局安装一次**（如 `~/.pi/agent/extensions/pi-rp-engine/` 或 `pi install`）。
- 所有 6 个 RP 工具注册时均设置 **`defaultActive: false`**（Pi 1.6.1 `ToolDefinition` 原生字段，未激活时 0 工具 Token 注入）。
- **零第三方运行时依赖**：仅使用 Node 内置 `fs`/`os`/`path`/`zlib`/`crypto` 与 Pi 官方接口完成 PNG `ccv3`/`chara` 块提取、ZIP/CHARX 解包、真随机掷骰、BM25+PPR 召回与本地存储。
- 在任何未显式开启 RP 的普通编程会话中：
  - `before_agent_start`、`context`、`turn_end`、`session_before_compact` 全部直接 `return`（0 Token、0 耗时）；
  - `setStatus` / `setWidget` 全清（0 UI 占用）；
  - 原有编程工具表 100% 不受影响。

### 2. 被动素材库 vs 会话专属绑定
```text
静态素材库（绝不自动激活任何会话！）：
  ~/.pi/agent/rp-library/      # 全局角色库（默认推荐：跨目录复用卡片、预设、人设与上次导入目录偏好）
    cards/<slug>/
      card.compiled.json       # 保真编译后的标准卡（含 100% mes_example 与导入审计报告）
      card.raw.json            # 原始无损备份（随时可切 Raw Passthrough 重新编译）
      assets/                  # .charx / PNG 解包立绘与头像
    presets/<id>.json          # 编译后的酒馆预设
    personas.json              # 全局玩家人设档案
    ui-prefs.json              # 最近导入目录与默认人设偏好
  <cwd>/.pi/rp/                # 可选项目级素材库（同样纯被动存储，绝不连带其他会话）

单会话运行态（100% 绑定当前 Pi Session Tree）：
  └─ 仅当用户在当前会话执行 `/rp load` 或 `/rp import -> 立即开启` 时，
     才向当前会话树写入 `rp:tx { kind: "bind", ... }`；
  └─ 同项目里新建的其他会话因分支中没有 `bind`，永远保持纯净编程模式；
  └─ 同一会话内的 Session Tree 分叉/回溯会自动精确重放全部 L1 状态；
  └─ 执行 `/rp exit` / `/rp off` / `Alt+Shift+X` 写入 `rp:tx { kind: "unbind" }`，
     瞬间清空全部内存态（卡/共演/预设/OOC/世界书缓存）、恢复原有编程工具并清零 HUD。
```

**激活判定规则（`replayBranchState(branch)`）**：
1. 仅重放当前会话分支 `ctx.sessionManager.getBranch()` 中的 `rp:tx` 事件；
2. 遇到 `bind` 时自动先重置旧世界状态再绑定新卡；遇到 `unbind` 时彻底归零全部字段；
3. 若分支最终 `state.active === false` → **100% 休眠**，绝不读取任何项目自动激活配置。

---

## 二、核心 TypeScript 数据模型（通用底座，严禁为单卡写死）

```typescript
/** 1. 编译后角色卡（保留 100% 灵魂，剥离 1.0 前端壳） */
export interface CompiledCard {
  id: string;
  specOrigin: "v1" | "v2" | "v3" | "charx";
  rawPassthrough: boolean;
  identity: {
    name: string;
    nickname?: string;
    aliases: string[];
    avatarPath?: string;
    talkativeness?: number;
  };
  /** Zone 1 冻结内容（绝不精简） */
  frozen: {
    systemPrompt: string;           // 完整保留（含破甲/文风/约束）
    description: string;            // 完整保留（仅剥 HTML/JS 前端壳）
    personality: string;            // 完整保留
    scenario: string;               // 完整保留
    mesExample: string;             // 100% 完整对话实例，严禁截断！
    constantLoreIds: string[];      // constant=true 且属静态世界观的条目 ID
  };
  /** Zone 3 尾部高权重指令（完整保留） */
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
  /** 仅 UI 展示，0 Token */
  meta: {
    creator?: string;
    version?: string;
    tags: string[];
    creatorNotes?: string;
    creatorNotesMultilingual?: Record<string, string>;
    source?: string[];
  };
  /** 自动从 MVU / 宏抢救出的建议状态结构（用户可确认启用或编辑） */
  salvagedStateSchema?: SalvagedVariable[];
  importReport: ImportAuditReport;
}

/** 2. 物理门禁（NCP-Bench / TimeChara 防剧透与时序隔离） */
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

/** 3. 编译后世界书条目 */
export interface CompiledLoreEntry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  constant: boolean;
  manualRecallOnly: boolean;        // 来自 @@dont_activate
  keys: string[];
  secondaryKeys: string[];
  selective: boolean;
  selectiveLogic: "AND_ANY" | "NOT_ALL" | "NOT_ANY" | "AND_ALL";
  useRegex: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  priority: number;
  depthHint: number;                // 仅用于 Zone 3 内部排序，绝不插历史中间
  pinned: boolean;                  // 来自 ignore_budget
  stickyTurns: number;
  cooldownTurns: number;
  oneShot: boolean;
  probability: number;              // 0..100
  group?: string;
  groupWeight?: number;
  noGraphSpread: boolean;           // 来自 prevent_recursion / exclude_recursion
  graphSecondHopOnly: boolean;      // 来自 delay_until_recursion
  gate?: GateCondition;
  entities: string[];               // 自动抽取的实体索引词，供本地 PPR 图谱用
}

/** 4. 会话树事务日志（经 pi.appendEntry("rp:tx", tx) 持久化，随分叉/回溯自动重放） */
export type RpTxEntry =
  | { kind: "bind"; cardId: string; cardSource: "project" | "library"; worldDir: string; greetingIndex: number; activeCharacters: string[] }
  | { kind: "unbind" }
  | { kind: "clock_tick"; beatDelta: number; worldTimeLabel?: string; dayDelta?: number; phase?: string }
  | { kind: "location_set"; location: string; presentNpcs: string[] }
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

/** 5. 双时态事实（Zep/Graphiti + Epistemic Visibility） */
export interface BiTemporalFact {
  id: string;
  statement: string;
  entities: string[];
  validFromTurn: number;
  validUntilTurn: number | null;    // null = 当前生效；非 null = 历史已失效
  supersededBy?: string;
  witnessIds: string[] | "public";  // 认知域：仅在场者/公开知晓
  gate?: GateCondition;
  causeEvent?: string;
}

/** 6. 伏笔 / 契诃夫之枪（EverMemOS Foresight） */
export interface ForesightHook {
  id: string;
  summary: string;
  entities: string[];
  plantedTurn: number;
  triggerHint: string;
  dueClockId?: string;
  status: "open" | "paid_off" | "expired";
}
```

---

## 三、官方 Pi SDK（1.6.1 实测核验）Hook 时序与 KV-Cache 保护设计

> 以下全部事件名、参数结构与返回值均已逐条核对 `@earendil-works/pi-coding-agent@1.6.1` 的 `dist/core/extensions/types.d.ts` 与 `pi-android/docs/sdk-host/protocol.md`，**100% 为真实可用 API，无任何虚构钩子**。

### 1. 状态重放与分支同步（`session_start` / `session_tree`）
- **注意（1.6.1 实测纠偏）**：Pi 1.6.1 中**不存在**单独的 `session_switch` 或 `session_fork` 事件，全部统一收口为：
  - `pi.on("session_start", (event, ctx) => ...)`：其中 `event.reason` 精确区分 `"startup" | "reload" | "new" | "resume" | "fork"`；
  - `pi.on("session_tree", (event, ctx) => ...)`：当用户在会话树上跳转节点（`newLeafId`）时触发。
- 每次触发时，读取 `ctx.sessionManager.getBranch()`，按序扫描 `type === "custom"` 的状态条目（`rp:bind`、`rp:tx`、`rp:persona`、`rp:note`、`rp:hide`、`rp:cast`），在内存中**确定性重放（Event Sourcing Replay）**出当前分支的精确 `SessionRpState`（耗时 < 1ms）。
- **激活/休眠工具集**：
  - 仅在 RP 模式激活时，先备份用户原活跃工具表，再调用 `pi.setActiveTools(RP_TOOL_NAMES)` 一次性切换为固定的 **6 个静态 RP 工具**（隔离掉 `bash`/`edit`/`write` 等编程工具，避免模型在扮演时误调代码工具或被编程提示词污染），**整局期间绝不再增删工具列表**（保住 KV Cache）；
  - 当切回非 RP 会话或执行 `/rp off` 时，立刻恢复原始编程工具集并清空 `setStatus` / `setWidget`。

### 2. 输入拦截与场外通道（`input` 钩子）
- `pi.on("input", async (event, ctx) => ...)`（官方返回 `{ action: "continue" } | { action: "transform", text, images? } | { action: "handled" }`）：
  - 当用户开启了 OOC 自动识别且输入 `((...))` 或 `（（...））` 时，标记当前回合为 `isOocTurn = true` 并以标准 OOC 导演帧透传，使后续 `turn_end` / `agent_settled` **严禁将其写入角色记忆与事实账本**；
  - 支持将快捷指令或开场状态无感引导至 RP 管线。

### 3. Zone 1 冻结前缀与编程提示词隔离（`before_agent_start`）
- `pi.on("before_agent_start", async (event, ctx) => ...)`（官方 `BeforeAgentStartEventResult` 支持直接返回 `{ systemPrompt: string }`）：
  - **关键机制**：未激活 RP 时直接 `return`（100% 保持 Pi 原生编程系统提示词）；激活 RP 时返回纯 RP 的 `{ systemPrompt: zone1FrozenPrompt }`，**彻底隔离编程助手指令**，同时保持整局字节级冻结。
  - 固定组装顺序（严禁放入变化的时间戳、回合数、动态数值或动态世界书）：
    1. 精简通用引擎协议（~180 tokens：声明 L1 状态与工具真值以代码为准、不得凭空伪造状态变更、何时按需调工具）；
    2. 角色卡 `systemPrompt`（完整保留）；
    3. 角色卡 `description` + `personality` + `scenario`（完整保留，支持多角色同场卡组）；
    4. **角色卡 `mesExample`（100% 完整原样对话实例）**；
    5. 当前绑定初始 Persona 简介（若中途切 Persona，则把变更声明放到 Zone 3 以保住 Zone 1 缓存）；
    6. `constant: true` 的静态蓝灯世界书（按 `position` → `order` 确定性排序）。

### 4. Zone 2 & Zone 3 装配与楼层屏蔽（`context` 钩子）
- `pi.on("context", async (event, ctx) => ({ messages }))`（仅影响发往 LLM 的内存副本，**绝不篡改持久化 JSONL 历史**）：
  1. **非破坏性楼层屏蔽（`/rp hide`）**：根据当前分支 `rp:hide` 集合，将用户标记屏蔽的旧楼层从 `messages` 副本中剔除（可随时 `/rp unhide` 恢复）；
  2. **Zone 2 保护**：其余历史对话 `messages[0 .. n-2]` **原样保留，绝不回改**；
  3. **Zone 3 瞬态尾部帧**（仅附着在最后一条消息上）：
     - 门禁 + 检索流水线（纯本地 TS，< 5ms）：`GateEvaluator` 物理屏蔽未解锁时代 → 确定性关键词/四态布尔 + `sticky` + 本地 BM25 + 2 跳 PPR 实体图谱扩散 → 硬 Token 预算裁剪（默认 1800 tokens）→ 双时态有效事实（`validUntilTurn === null`）+ 认知盲区标签 + Top 3 活跃 `Foresight` 伏笔；
     - 确定性序列化：`<rp_state_frame>` + `<rp_recalled_context>` + 活跃导演便签/临时引导（`/rp note`）+ 作者 `depth_prompt`（完整保留）+ 作者 `post_history_instructions`（完整保留在最末尾）。

### 5. 幕间记忆归并（`session_before_compact`）
- 拦截 Pi 原生上下文压缩事件（`event.reason: "manual" | "threshold" | "overflow"`），返回自定义 `{ compaction }`：
  - 将即将被压缩的旧轮次总结为 **EverMemOS 风格 `MemScene`**（关键因果链 + 人物关系变化 + 未兑现伏笔 + 文风氛围备忘）；
  - 已落账的 L1 数值与双时态事实不在摘要中重复啰嗦。

### 6. 回合后确定性结算（`turn_end`）与零延迟异步边车（`agent_settled`）
- **`turn_end`（同步、确定性、< 2ms）**：
  - 若本轮为 `isOocTurn`，直接跳过世界时钟、`sticky`/`cooldown` 与记忆更新；
  - 否则递增回合与微观节拍、递减 `sticky`/`cooldown` 与临时 `/rp note` 剩余轮数、写入轻量 `rp:tx`、刷新 `ctx.ui.setStatus("rp", ...)` 与 `ctx.ui.setWidget("rp-hud", ...)`。
- **`agent_settled`（Pi 1.6.1 原生结算完结钩子，零流式延迟）**：
  - 仅在整轮流式输出、工具调用和重试**全部结束**且开启 `sidecar-light` 时触发；
  - 直接通过 Pi 1.6.1 内置 **`ctx.modelRegistry.complete(sidecarModel, context)`** 发起轻量单次 JSON 抽取（复用用户已有 Provider/OAuth 凭证，无需另配 Key），结果经代码校验合法后追加 `pi.appendEntry("rp:tx", ...)` 并静默刷新 HUD。

---

## 四、静态工具集设计（固定 6 个工具，永不中途增删）

所有工具均声明 `defaultActive: false`（仅 RP 激活时通过 `pi.setActiveTools` 一次性启用），并自带官方 `renderCall` / `renderResult` 实现（桌面 TUI 与 `pi-android` 均通过官方 `ToolExecutionComponent` 渲染为精致的叙事微卡，而非满屏 JSON）：

| 工具名 | 触发时机（按需拉取，常规对话 0 调用） | 确定性代码职责 |
| :--- | :--- | :--- |
| `rp_recall` | 模型需要查阅冷门历史、特定角色过往、某件旧物或 `@@dont_activate` 隐藏词条时 | 在门禁边界内执行全库 BM25 + 图谱深度检索（含历史失效事实查询），返回高信噪比结果 |
| `rp_roll_check` | 跑团/战斗/潜行/说服等需要真随机不确定判定的节点 | 用 Node `crypto.randomInt` 执行 `XdY+mod` 或百分比检定，读取 L1 属性修正与 DC，返回确定性结果（模型不得篡改） |
| `rp_state_patch` | 剧情中发生了明确的物品得失、血量/金钱/好感变动、地点转移、进度时钟推进或 CFSM 状态切换 | 代码强校验数值上下界（`min`/`max`）、背包数量不可为负、CFSM 转移边合法性；合法则写 `rp:tx` 并刷新 HUD |
| `rp_fact_commit` | 确立重大新事实、推翻旧认知（双时态失效）、更新 NPC 信念（DREAM ABC）或埋下/回收伏笔（Foresight） | 校验认知见证者与门禁标签，写入双时态账本并更新本地实体邻接图 |
| `rp_era_advance` | 满足里程碑条件，准备推进幕次/跨时间蒙太奇/解锁新时代设定 | 校验 `EraGate` 条件；通过后解锁新 Era 门禁、结算长期时钟、触发幕间蒙太奇自定义条目渲染 |
| `rp_npc_deliberate` | **仅限强「信息不对称 / 密室推理 / 反派暗算」节点**，需要某 NPC 在严格不知晓玩家底牌的前提下做独立思考 | 按认知标签过滤仅该 NPC 可见的记忆切片，调 `ctx.modelRegistry.complete()` 做一次短上下文隔离决策并返回意图，**默认极少调用、零常驻多 Agent 开销** |

---

## 五、100% 官方通用扩展 UI 设计（桌面 Pi & `pi-android` 1:1 零改造）

**绝不引入任何 `pi-android` 私有接口！** 以下每一项均已核对 `pi-android/docs/sdk-host/protocol.md` 确认 1:1 支持：

| 界面位 | 官方 Pi 1.6.1 API | 桌面 TUI 效果 | `pi-android` 原生映射（protocol.md 已确认） |
| :--- | :--- | :--- | :--- |
| **紧凑状态胶囊** | `ctx.ui.setStatus("rp", ...)` | 终端状态行 | `ui.status` → 输入框上方精致原生胶囊 |
| **常驻可折叠 HUD** | `ctx.ui.setWidget("rp-hud", ...)` | 终端折叠面板 | `ui.widget` → 原生 Compose 卡片（自动适配主题） |
| **主菜单 / 开场白 / 马甲选择** | `ctx.ui.select(title, options)` | 终端选择菜单 | `ui.select` → 原生底部选项 Sheet |
| **便签 / 人设多行编辑** | `ctx.ui.input` / `ctx.ui.editor` / `ctx.ui.confirm` | 终端对话框 | `ui.input` / `ui.editor` / `ui.confirm` → 原生 Material3 对话框 |
| **行动灵感回填输入框** | `ctx.ui.setEditorText(text)` | 填入终端输入框 | `ui.editorText` → 直接填入 App 聊天输入框供微调/发送 |
| **`/rp panel` 交互总控台** | `ctx.ui.custom(factory, { overlay: true })` | 终端交互面板 | `ui.surface` + `ui.mouse` → 原生触屏交互浮层 |
| **开场白 / 掷骰 / 时代卡** | `registerMessageRenderer` / `registerEntryRenderer` / `renderCall` | 官方组件渲染 | `render.message` / `render.entry` / `render.tool` 原生渲染 |
| **正文残留标签净化** | `pi.registerMarkdownTransformer(fn, { messageTypes: ["assistant"] })` | 终端干净正文 | `render.markdown` → 展示层自动过滤误吐的零星 HTML/状态标签，不篡改原记录 |
| **立绘 / 背景图展示** | `.charx` 解包至本地相对路径，在 Markdown 中引用 | 路径/说明展示 | `pi-android` 原生图片渲染器直接高清预览并支持全屏 |

---

## 六、酒馆高频实战功能 × Pi 1.6.1 1:1 API 对齐总表（单入口菜单 + 短命令双轨）

### 1. 明确丢弃的 1.0 包袱
- **STscript 伪编程语言**：`/let`、`/if`、管道符 `|`、`/setvar`、`/trigger`、DOM 按钮操作（已由 TypeScript 引擎 + 工具彻底替代，玩家无需背脚本）。
- **默认一角色一 Agent 串行群聊**：延迟高、成本翻倍、破坏文风与 KV Cache（已由单主脑同场群戏 + 按需 `rp_npc_deliberate` 替代）。

### 2. 直接复用 Pi 原生能力（不重复造轮子）
- **分支存档与多版本抽卡（替代 `/branch`、`/swipe`、`/regenerate`）**：Pi 原生 `Session Tree`（`/tree`、`ctx.fork()`、`ctx.navigateTree()`）天然支持任意楼层无限分叉与回溯，且 `rp:tx` 自动精准回滚状态；
- **模型/思考等级切换、流式打断与排队**：直接用 Pi 原生 `/model`、`/thinking`、`ctx.abort()`、`steer/followUp`。

### 3. 全量补齐的 11 项高频实战 RP 功能（100% 对应真实 Pi 1.6.1 API）

| # | 功能 | 对标酒馆能力 | Pi 1.6.1 真实 API 实现 | 用户触发方式（菜单 + 短命令双轨） |
| :--- | :--- | :--- | :--- | :--- |
| 1 | **开场白切换** | `alternate_greetings` | `ctx.ui.select()` + `pi.sendMessage({ customType: "rp:greeting", display: true }, { triggerTurn: false })` | 导入/开局自动弹出，或 `/rp greet` |
| 2 | **玩家马甲管理** | `/persona` + 锁定 | `.pi/rp/personas.json` + `ctx.ui.select/editor` + `pi.appendEntry("rp:persona", ...)`（中途切换入 Zone 3 保缓存） | `/rp` 菜单 或 `/rp persona` |
| 3 | **导演便签 / 临时引导** | `/note` + `/inject` + *Guided Generations* | `pi.appendEntry("rp:note", { text, ttl })` → `context` 钩子注入 Zone 3 瞬态尾部，`turn_end` 自动过期 | `/rp note [内容] [--ttl N]` |
| 4 | **无缝续写** | `/continue` | `pi.sendMessage({ customType: "rp:continue", content: "...", display: false }, { triggerTurn: true })` | `/rp` 菜单 或 `/rp c` / `/rp continue` |
| 5 | **行动灵感 / 代写** | `/impersonate` + 选项引导 | `ctx.modelRegistry.complete(ctx.model, ...)` 按 Persona 生成 3 个选项 → `ctx.ui.select()` → `ctx.ui.setEditorText(choice)` 回填输入框 | `/rp` 菜单 或 `/rp act [提示]` |
| 6 | **场外沟通（防污染）** | `/ooc` / `/sys` | `pi.on("input")` 识别 `((...))` 或 `/rp ooc` → 标记 `isOocTurn` → `turn_end`/`agent_settled` 严禁写入事实与状态账本 | 直接输入 `((...))` 或 `/rp ooc <内容>` |
| 7 | **楼层屏蔽 / 恢复** | `/hide` / `/unhide` | `ctx.sessionManager.getBranch()` + `pi.appendEntry("rp:hide", ...)` → `context` 钩子过滤副本，非破坏且随树回滚 | `/rp hide` / `/rp unhide` |
| 8 | **剧情书签 / 快速回档** | Checkpoints | **`pi.setLabel(leafId, "🔖 " + name)`** + **`ctx.navigateTree(targetId)`** / **`ctx.fork(entryId)`** | `/rp save <名>` / `/rp goto` |
| 9 | **手动掷骰 + 跳时间** | `/roll` + Timeskip | `crypto.randomInt` + `pi.appendEntry("rp:tx", ...)` + 推进时钟与幕后势力 + `rp:event` 渲染卡 | `/rp roll 1d20+3` / `/rp skip <时长>` |
| 10 | **多角色同场群戏** | Group Chat（次世代化） | `pi.appendEntry("rp:cast", { slugs })`：单主脑统一执笔，各角色独立认知状态，强盲推时按需触发 `rp_npc_deliberate` | `/rp cast [add\|remove\|list]` |
| 11 | **无损直通 + 显示净化** | Raw Mode + Regex Display | `/rp raw on` 跳过清洗直通；常规模式用 `pi.registerMarkdownTransformer` 在展示层净化残余标签 | `/rp raw [on\|off]` |

### 4. 手机友好的双轨交互入口（`pi.registerCommand("rp", ...)` + `getArgumentCompletions`）
- **零记忆成本（手机党主入口）**：直接输入 **`/rp`** 回车 → 弹出 `ctx.ui.select()` 交互式快捷菜单（覆盖全部高频功能：续写 / 帮我想行动 / 导演便签 / 场外 OOC / 切换马甲 / 开场白 / 书签回档 / 屏蔽楼层 / 状态总控台 / 换卡 / 退出 RP），彻底取代酒馆杂乱的 Quick Replies 按钮栏与数十个一级命令；
- **熟手快敲（带自动补全）**：支持 `/rp import <path>`、`/rp load [slug]`、`/rp new`、`/rp greet`、`/rp persona`、`/rp note`、`/rp c`、`/rp act`、`/rp ooc`、`/rp hide`、`/rp save`、`/rp goto`、`/rp roll`、`/rp skip`、`/rp cast`、`/rp panel`（快捷键 `ctrl+shift+r`）、`/rp hud [minimal|full|off]`、`/rp mode [off|tool-assisted|sidecar-light]`、`/rp raw [on|off]`、`/rp off`。
