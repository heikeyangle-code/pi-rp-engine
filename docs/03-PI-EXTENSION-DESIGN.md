# 03 · 基于官方 Pi SDK 的标准扩展工程设计

> **核心承诺**：本扩展 **100% 仅使用官方 `@earendil-works/pi-coding-agent` 公开扩展 API**，不修改 `pi-android` 一行代码，不破坏桌面端 Pi 与手机端 `pi-android` 的 1:1 一致性。

---

## 一、项目（Project）vs 对话（Session）生命周期模型

这是让用户日常写代码与玩 RP 彻底互不干扰、同时又兼顾「大世界长篇」与「轻量短打」的最优双模式设计：

### 1. 安装与静默机制（Zero-Pollution Dormancy）
- 扩展**全局安装一次**（如 `~/.pi/agent/extensions/pi-rp-engine/` 或 `pi install`）。
- 所有 RP 工具注册时均设置 **`defaultActive: false`**。
- 在任何未激活 RP 模式的普通对话/编程项目里：
  - `before_agent_start` 直接 `return`（0 Token 注入）；
  - `context` 直接原样放行；
  - `setStatus` / `setWidget` 全清（0 UI 占用）；
  - RP 工具不出现在工具表里（0 工具定义 Token）。

### 2. 双模式无缝统一：以「一世界 = 一项目」为主，支持「单库按对话切卡」
```text
模式 A（推荐主模式）：一长篇大卡 / 一世界观 = 一个 Project（Workspace）
  <project-root>/
    .pi/rp/
      world.json              # 项目级默认绑定世界/卡包配置（打开该项目自动识别 RP 模式）
      cards/<slug>/
        card.compiled.json    # 清洗并保真编译后的标准卡（含完整 mes_example 与导入报告）
        card.raw.json         # 原始无损备份（随时可切 Raw Passthrough 或重新编译）
        lore.compiled.json    # 编译后世界书 + 实体别名图谱索引
        assets/               # .charx / PNG 解包立绘、头像、背景图
      persona.json            # 玩家在此世界里的 Persona 设定
  └─ 该项目下的每个 Session（新对话） = 该世界的一条独立攻略线 / 不同开场白开局
  └─ 同一 Session 内的 Session Tree 分叉 = 剧情分支存档（所有 L1 状态随分支 100% 自动回滚）

模式 B（轻量兼容模式）：一个「酒馆角色库」Project + 按 Session 独立绑卡
  ~/.pi/agent/rp-library/     # 或共享工作区的 .pi/rp/library/，存放多张轻卡
  └─ 对话 1：运行 `/rp load alice` → 写入 `pi.appendEntry("rp:bind", { cardRef: "alice" })`
  └─ 对话 2：运行 `/rp load detective` → 写入 `pi.appendEntry("rp:bind", { cardRef: "detective" })`
  └─ 两个对话互不串台，状态各自住在自己的 JSONL 会话树里！
```

**激活判定优先级（`resolveRpBinding(cwd, branch)`）**：
1. 优先读当前会话分支上的 `rp:bind` 条目（会话级显式绑定 / 显式关闭 `rp:unbind` 优先级最高）；
2. 若当前会话无显式绑定，检查当前工作区是否存在 `<cwd>/.pi/rp/world.json`（项目级自动绑定）；
3. 若都没有 → **完全静默休眠**，直到用户手动运行 `/rp import`、`/rp load` 或 `/rp new`。

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

## 三、官方 Pi SDK Hook 时序与 KV-Cache 保护设计

所有钩子严格基于 `@earendil-works/pi-coding-agent` 现行公开 API：

### 1. 状态重放与分支同步（`session_start` / `session_switch` / `session_fork` / `session_tree`）
- 每次会话启动、切换或树回溯时，读取 `ctx.sessionManager.getBranch()`，过滤出 `type === "custom" && customType === "rp:tx"` 的条目，在内存中 **确定性重放（Event Sourcing Replay）** 出当前分支的精确 `SessionRpState`（耗时 < 1ms）。
- **激活/休眠工具集**：
  - 仅在 RP 模式激活时，通过 `pi.setActiveTools([...baseTools, ...RP_TOOL_NAMES])` 一次性开启全部 5 个静态 RP 工具，**整局期间绝不再增删工具列表**（遵守 Manus 原则，防止工具定义变动击穿 KV Cache）；
  - 切回非 RP 会话时，立刻把 RP 工具从 active tools 移除并清空 `setStatus` / `setWidget`。

### 2. Zone 1 冻结前缀（`before_agent_start`）
- 仅在 RP 模式激活时执行。
- 拼装**确定性、字节级稳定**的 `systemPrompt` 段落（按固定顺序，严禁放入变化的时间戳、回合数、动态数值或动态世界书！）：
  1. 精简通用引擎协议（~180 tokens：声明 L1 状态与工具真值以代码为准、不得凭空伪造状态变更、何时按需调工具）；
  2. 角色卡 `systemPrompt`（完整保留）；
  3. 角色卡 `description` + `personality` + `scenario`（完整保留）；
  4. **角色卡 `mesExample`（100% 完整原样对话实例）**；
  5. `constant: true` 的静态蓝灯世界书（按 `position` → `order` 确定性排序）。
- **缓存效果**：只要不换卡、不跨时代改冻结层，Zone 1 整局 **100% 字节不变**。

### 3. Zone 2 & Zone 3 装配（`context` 钩子）
- `messages[0 .. n-2]`（所有历史对话）：**原样保留，绝不回改！**（彻底保护 Prefix KV Cache）。
- 对最后一条当前用户消息 `messages[n-1]`（仅在本次请求发给模型前的内存副本上临时附着，**绝不写回 JSONL 持久化消息**）：
  1. **门禁 + 检索流水线**（纯本地 TS，< 5ms）：
     - 从当前分支状态取 `currentEra`, `currentTurn`, `location`, `presentNpcs`, `flags`；
     - 用 `GateEvaluator` 物理筛掉所有未解锁的世界书与事实；
     - 用最近 2 轮对话 + 当前地点/在场 NPC 作为种子，跑「确定性关键词/四态布尔逻辑 + sticky 延续 + 本地 BM25 + 2 跳 PPR 实体图谱扩散」；
     - 按 `pinned (ignore_budget)` → `sticky` → `综合相关分 × priority` 做硬 Token 预算裁剪（默认 1800 tokens，可配）；
     - 过滤双时态有效事实（`validUntilTurn === null`）并按在场 NPC 标注认知盲区（Epistemic Tag）；
     - 取出 Top 3 活跃 `Foresight` 伏笔与最新 DREAM 信念边。
  2. **确定性序列化 Zone 3 尾部帧**（固定键序，高信噪比紧凑排版）：
     - `<rp_state_frame>`（时间/地点/在场角色/CFSM状态/数值/进度时钟/背包摘要）
     - `<rp_recalled_context>`（门禁放行的世界书 + 现行有效事实 + 认知边界 + 活跃伏笔）
     - 作者 `depth_prompt`（若非空，完整保留）
     - 作者 `post_history_instructions`（若非空，完整保留在最末尾！）

### 4. 幕间记忆归并（`session_before_compact`）
- 拦截 Pi 原生上下文压缩事件，避免普通代码压缩模板把 RP 氛围与因果全压没：
  - 将即将被压缩的旧轮次总结为 **EverMemOS 风格 `MemScene`**（关键事件因果链 + 人物关系变化 + 已兑现与未兑现伏笔 + 文风氛围备忘）；
  - 已写入 L1 双时态账本与 FSM 的硬状态无需在摘要里重复罗嗦，节省大量上下文预算。

### 5. 回合后确定性结算（`turn_end`）
- 递增 `turn` / 微观节拍；递减所有 `sticky` / `cooldown` 计数；更新 `rp:tx` 事务；
- 刷新官方通用 UI：`ctx.ui.setStatus("rp", ...)` 与 `ctx.ui.setWidget("rp-hud", ...)`；
- 若开启 `sidecar-light` 模式，异步/后置调用用户配置的轻量快速模型跑单次紧凑 JSON 抽取（`binary_q` 跃迁检查 + 事实增删 + 伏笔登记），结果校验合法后写入 `pi.appendEntry("rp:tx", ...)` 并自动刷新 HUD。

---

## 四、静态工具集设计（固定 5 个工具，永不中途增删）

所有工具均声明 `defaultActive: false`（仅 RP 激活时启用），并自带官方 `renderCall` / `renderResult` 实现（在桌面 TUI 与 `pi-android` 卡片里均呈现为极简精致的叙事微卡，而非满屏 JSON）：

| 工具名 | 触发时机（按需拉取，常规对话 0 调用） | 确定性代码职责 |
| :--- | :--- | :--- |
| `rp_recall` | 模型需要查阅冷门历史、特定角色过往、某件旧物或 `@@dont_activate` 隐藏词条时 | 在门禁边界内执行全库 BM25 + 图谱深度检索（含历史失效事实查询），返回高信噪比结果 |
| `rp_roll_check` | 跑团/战斗/潜行/说服等需要真随机不确定判定的节点 | 用确定性/真随机代码执行 `XdY+mod` 或百分比检定，读取 L1 属性修正与 DC，返回明确成功/大成功/失败/大失败结果（模型不得篡改） |
| `rp_state_patch` | 剧情中发生了明确的物品得失、血量/金钱/好感变动、地点转移、进度时钟推进或 CFSM 状态切换 | 代码强校验数值上下界（`min`/`max`）、背包数量不可为负、CFSM 转移边是否合法；合法则写 `rp:tx` 并刷新 HUD |
| `rp_fact_commit` | 确立重大新事实、推翻旧认知（双时态失效）、更新 NPC 信念（DREAM ABC）或埋下/回收伏笔（Foresight） | 校验认知见证者与门禁标签，写入双时态账本并更新本地实体邻接图 |
| `rp_era_advance` | 满足里程碑条件，准备推进幕次/跨时间蒙太奇/解锁新时代设定 | 校验 `EraGate` 条件；通过后解锁新 Era 门禁、结算长期时钟、触发幕间蒙太奇自定义条目渲染 |

---

## 五、100% 官方通用扩展 UI 设计（桌面 Pi & `pi-android` 1:1 零改造）

**绝不引入任何 `pi-android` 私有接口！** 全部只调 `ExtensionUIContext` 标准 API：

| 界面位 | 官方 Pi SDK API | 桌面 TUI 效果 | `pi-android` 原生效果 |
| :--- | :--- | :--- | :--- |
| **顶部/底栏紧凑状态** | `ctx.ui.setStatus("rp", "📍雾港酒馆 · 暮色 · Act I · ❤️68")` | 终端状态行 | 输入框上方精致可横滑原生胶囊 |
| **常驻可折叠 HUD** | `ctx.ui.setWidget("rp-hud", factory)` | 终端折叠面板 | 原生 Compose 卡片（进度时钟条、CFSM 状态、活跃伏笔），自动适配 12 套主题 |
| **开场白 / 卡包选择** | `ctx.ui.select(title, options)` | 终端选择菜单 | 原生底部选项 Sheet |
| **参数 / Persona 编辑** | `ctx.ui.input` / `ctx.ui.editor` / `ctx.ui.confirm` | 终端对话框 | 原生 Material3 对话框 |
| **`/rp` 交互式总控台** | `ctx.ui.custom(factory)` | 终端交互面板（Tab 切状态/世界书/事实/伏笔/导入报告） | 原生底部交互抽屉 + 方向/确认按键条 |
| **掷骰/时代解锁叙事卡** | `renderCall` / `renderResult` + `registerEntryRenderer("rp:era", ...)` | 官方组件 ANSI 渲染 | 官方 `ToolExecutionComponent` / `CustomEntryComponent` 原生渲染 |
| **立绘/背景图展示** | `.charx` 解包到本地相对路径，在 Markdown/自定义消息里标准引用 | 路径/说明展示 | `pi-android` 原生图片渲染器直接高清预览并支持点开全屏 |

### 斜杠命令体系（`pi.registerCommand` + 参数自动补全）
- `/rp import <path>`：导入 `.png` / `.charx` / `.json` 角色卡或世界书，展示清洗审计报告并确认启用；
- `/rp load [slug]`：在当前会话绑定/切换已导入角色卡（支持 `alternate_greetings` 选择）；
- `/rp new`：基于当前世界项目开新攻略线（重置开场白选择，保留共享世界书与立绘）；
- `/rp panel`（快捷键 `ctrl+shift+r`）：打开 `ctx.ui.custom` 交互式总控台（查看/手动调整 FSM 状态、数值、时代门禁、双时态事实、伏笔队列、世界书开关）；
- `/rp hud [minimal|full|off]`：一键切换 HUD 展示密度；
- `/rp montage`：手动触发「幕间蒙太奇」跨时间推进与记忆归并；
- `/rp mode [off|tool-assisted|sidecar-light]`：切换回合后结算模式；
- `/rp raw [on|off]`：一键切换「无损直通模式」（跳过前端清洗与重复合并，100% 原始透传）；
- `/rp off`：退出当前会话的 RP 模式，恢复纯净编程/通用对话态。
