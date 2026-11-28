<div align="center">

<h1>pi-rp-engine</h1>

<p><b>基于官方 Pi SDK 的通用角色扮演与世界模拟扩展</b></p>

<p>
  把状态追踪、长期记忆、世界书召回与防剧透门禁交给确定性 TypeScript 代码引擎，让大模型专注叙事与人物演绎。<br>
  零第三方运行时依赖 · 兼容 V1 / V2 / V3 / .charx 角色卡 · 严格单会话生效，退出即恢复纯净编程助手。
</p>

<p>
  <a href="https://github.com/heikeyangle-code/pi-android"><img alt="搭配 Pi for Android" src="https://img.shields.io/badge/%E6%89%8B%E6%9C%BA%E7%AB%AF%E6%8E%A8%E8%8D%90-Pi%20for%20Android-4B67B4?style=flat-square&logo=android&logoColor=white&labelColor=2B3245"></a>
  <img alt="零第三方依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E4%BE%9D%E8%B5%96-Zero%20Deps-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="支持 V1/V2/V3/CHARX" src="https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E5%8D%A1-V1%20%7C%20V2%20%7C%20V3%20%7C%20CHARX-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="TypeScript ESM" src="https://img.shields.io/badge/TypeScript-ESM-4B67B4?style=flat-square&logo=typescript&logoColor=white&labelColor=2B3245">
  <img alt="MIT License" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-4B67B4?style=flat-square&labelColor=2B3245">
</p>

<p>
  <a href="#怎么使用">怎么使用</a> ·
  <a href="#与传统酒馆sillytavern的架构差异">对比传统酒馆</a> ·
  <a href="#日常玩法与快捷键">日常玩法与快捷键</a> ·
  <a href="#核心机制与工程实现">硬核机制拆解</a> ·
  <a href="#文档与测试">文档与测试</a>
</p>

</div>

<br>

## 这是什么？

`pi-rp-engine` 是一个运行在 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 上的标准扩展。你可以直接导入现有的 SillyTavern / RisuAI / Chub 角色卡（`.png`、`.charx`、`.json`）、独立世界书和酒馆预设，在桌面端终端或手机端直接开始角色扮演。

和传统把所有设定、状态栏代码、世界书全拼进一段巨型文本的做法不同，本扩展把**「世界状态与记忆管理」**抽离到纯 TypeScript 代码层：

- 聊天正文不再夹杂 `<status>` 代码块或大段 HTML 状态栏；
- 数值、背包、场景、事实、伏笔与人物态度作为事件日志保存在 Pi 原生会话树里，回溯或分叉剧情时自动同步还原；
- 只在你主动开启 RP 的当前会话里生效，不影响同项目下的任何普通编程会话。

<br>

---

## 怎么使用

### 方式一：手机端使用（推荐 · 搭配 Pi for Android）

1. 先安装我的另一个 Android 客户端仓库：**[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)**（内置完整 Pi 运行环境，免 Root、免 Termux）。
2. 打开 App，直接把本仓库链接发给 AI，让它自动安装并启用：
   > 请帮我安装并启用这个 Pi 扩展：`https://github.com/heikeyangle-code/pi-rp-engine`
3. 安装完成后输入 `/rp` 或 `/rp import`：内置文件浏览器会自动扫描手机下载目录里的 `.png`、`.charx`、`.json` 文件并自动识别角色卡、世界书与酒馆预设，选中即可导入开局。

### 方式二：电脑端 Pi CLI / TUI

```bash
git clone https://github.com/heikeyangle-code/pi-rp-engine.git ~/.pi/agent/extensions/pi-rp-engine
```

在 Pi 中执行 `/reload`，按 **`Alt+R`** 或输入 **`/rp`** 打开启动器。也可以在命令行直接指定已有角色卡 slug 单会话启动：

```bash
pi --rp-card <card-slug>
```

退出时执行 `/rp exit` 或按 **`Alt+Shift+X`**，即可清空当前会话的 RP 状态与界面组件并恢复原有编程工具集。

<br>

---

## 与传统酒馆（SillyTavern）的架构差异

| 维度 | 传统酒馆（SillyTavern 1.0 范式） | `pi-rp-engine` 实际机制 |
| :--- | :--- | :--- |
| **上下文组织** | 每轮将系统提示、世界书、`@D` 注入与历史记录重拼为单一上下文，中段插入会打断 Prompt Prefix 缓存 | **三区分离**：Zone 1 冻结前缀（跨回合字节级不变）+ Zone 2 纯追加历史 + Zone 3 瞬态尾部帧（仅附于当次请求末尾，不写入历史） |
| **状态与数值** | 依赖模型在正文里输出 `<status>` / JSON / MVU 补丁，再用正则与前端 HTML 渲染，容易格式漂移并污染历史 | **代码侧确定性状态机**：数值上下界、背包增减、进度时钟、真随机掷骰由代码校验并记录，正文保持纯净 |
| **记忆与世界书** | 关键词子串/正则扫描最近 N 条消息；旧事实与新事实同时留在记录里容易矛盾 | **双时态事实账本 + 本地 BM25 / 2 跳实体图谱（PPR）+ 伏笔队列**：旧事实支持非破坏性失效，关联条目按实体图谱联想召回 |
| **防剧透与认知边界** | 主要依靠提示词软约束，长程交互中容易提前泄密或出现 NPC 全知视角 | **代码层物理门禁 + 列表优先盲区标注**：未达条件的条目不进入上下文；私密事实按 `witnessIds` 自动向不在场 NPC 标注盲区 |
| **重摇、回溯与分叉** | 聊天记录与外置变量脚本分离，回退楼层后状态容易错位 | **寄生 Pi 原生会话树（JSONL DAG）**：所有状态变更写入 `rp:tx` 事务，回溯/分叉分支时确定性重放还原 |

> **适用边界说明**：纯文字 1v1 角色卡、多角色群像卡、大型世界观/跑团卡、多幕悬疑卡以及带 HTML 状态栏/MVU 变量的卡片均可兼容（导入时会剥离无用的前端脚本壳并在剥离前打捞变量，同时 100% 原样保留 `mes_example`、`system_prompt`、`post_history_instructions` 与 `depth_prompt`）。如果某张卡的核心玩法本身是内嵌浏览器 Canvas / Vue / React 点击小游戏，因本扩展不运行浏览器 DOM 脚本，无法照原样运行其网页交互。

<br>

---

## 日常玩法与快捷键

### 通用 5+1 世界面板（`/rp panel` 或 `Ctrl+Shift+R`）

面板按真实游玩习惯组织，日常/陪伴卡保持界面简洁，跑团/沙盒/长篇卡自动展示完整数值与机制：

1. **当前场景与时间**：修改地点、在场人物、时间标签，或一键触发「切场景 / 跳时间」。
2. **人物与关系**：查看/调整角色态度与情绪阶段（CFSM）、好感与角色数值条、人物印象/信念，以及一键切换玩家马甲或同场共演阵容。
3. **剧情记忆本**：0 Token 瞬时合成前情提要、查看或录入公开/私密事件与未完伏笔、**一键「总结并隐藏较早的对话楼层」**（将旧楼层压缩进记忆本并对模型非破坏性隐藏，原记录随时可恢复）。
4. **世界书管理**：支持 300+ 条目关键词搜索、按状态/门禁筛选、分页实时开关，以及**「从最近对话一键为新 NPC/地点生成世界书条目」**。
5. **导演台（Author's Note）**：切换叙事节奏，使用多行编辑器编写临时或常驻导演指令（注入 Zone 3，不破坏前缀缓存）。
6. **跑团与世界机制** *(按卡型自适应显隐)*：背包物品快捷 `+1/-1`、进度时钟、快捷掷骰、剧情阶段、世界开关 Flags 与引擎模块开关。

### 14 项防终端冲突快捷键

> 避开 `Ctrl+I/M/J/H/C/Z/D/L/R/O` 等终端保留键位；在未开启 RP 的普通会话中除 `Alt+R` 外完全静默。在 RP 会话中直接输入 **`((内容))`** 或 **`（（内容））`** 即可无感触发 OOC 讨论，不推进剧情与时钟。

| 快捷键 | 功能 | 对应命令 |
| :--- | :--- | :--- |
| **`Alt+R`** | 打开 RP 主菜单 / 启动器 | `/rp` |
| **`Ctrl+Shift+R`** | 打开世界面板（场景/人物/记忆本/世界书/导演台） | `/rp panel` |
| **`Alt+I`** | **帮我代写主角回复（Impersonate）**：以玩家视角起草并填入输入框，修改后回车发送 | `/rp imp` |
| **`Alt+Q`** | **零污染场外提问（Side Prompt）**：查心理/核对线索/要灵感，看完即关，不写入历史 | `/rp ask` |
| **`Alt+W`** | **重摇上一条回复（Swipe）**：支持附带 1 轮微调方向，旧分支保留在 `/tree` | `/rp reroll` |
| **`Alt+K`** | 让角色无缝续写剧情 | `/rp continue` |
| **`Alt+A`** | 生成 3 个当下情境行动建议 | `/rp act` |
| **`Alt+N`** | 管理导演指令与常用文风/篇幅模板 | `/rp note` |
| **`Alt+P`** | 循环切换叙事节奏（舒缓 → 均衡 → 紧张） | `/rp pace` |
| **`Alt+T`** | 切场景 / 跳时间 | `/rp skip` |
| **`Alt+B`** | 保存当前剧情节点书签 | `/rp save` |
| **`Alt+J`** | 回溯或分叉至已保存的剧情书签 | `/rp goto` |
| **`Alt+H`** | 循环切换 HUD 显示模式（极简 → 完整 → 隐藏） | `/rp hud` |
| **`Alt+Shift+X`** | 确认后彻底退出当前会话 RP 模式 | `/rp exit` |

其他常用命令：`/rp import`、`/rp load`、`/rp analyze`（一键 AI 建档并永久缓存）、`/rp recap`（0 Token 前情提要）、`/rp summarize`（总结并隐藏旧楼层）、`/rp loregen`（剧情生成新世界书条目）、`/rp roll`（真随机掷骰）、`/rp hide` / `/rp unhide`、`/rp cast`、`/rp raw`。

<br>

---

## 核心机制与工程实现

以下机制全部对应仓库内实际可运行代码与单元测试，无外部数据库、无第三方运行时依赖（仅依赖 Node 内置模块与 Pi 官方扩展 API）：

### 1. 三区 KV-Cache 上下文装配（`src/context/zone-builder.ts`）
- **Zone 1（`before_agent_start` 冻结前缀）**：按 SillyTavern 位置规范组装引擎极简协议、Preset 前段、`system_prompt`、`before_char`/`after_char`/`before_example`/`after_example` 常驻世界书、静态 `outlet`、角色核心设定、**100% 原样 `mes_example`** 与初始玩家人设。不包含回合数、时间戳或动态数值，跨回合保持字节级一致。中途切换玩家马甲时仅在 Zone 3 声明变更，不破坏 Zone 1 冻结前缀。
- **Zone 2（Append-Only 对话流）**：严格不修改历史消息对象。`/rp hide` 与 `/rp summarize` 同时记录 `entryId` 与基于 `role|timestamp|head` 的 SHA-1 消息指纹，在 `context` 钩子中做非破坏性过滤，不删除 JSONL 原始日志。
- **Zone 3（`context` 钩子瞬态尾部帧）**：仅在发往模型的消息副本尾部挂接，绝不落盘。按确定性键序序列化 `<rp_state_frame>`，依次附带召回世界书、现行有效事实、列表优先认知盲区（`- [HIDDEN FROM: NPC] ...`）、在场角色优先排序的 DREAM 信念、开放伏笔、节奏与防停滞提示、导演指令、`depth_prompt` 与 `post_history_instructions`。

### 2. 确定性状态引擎与会话树事件溯源（`src/engine/`）
- **事件溯源重放（`state-replay.ts`）**：所有状态变更（`bind` / `unbind` / `stat_patch` / `inventory_patch` / `location_set` / `cfsm_define` / `cfsm_transition` / `progress_clock` / `fact_add` / `fact_invalidate` / `belief_update` / `foresight_upsert` / `era_advance` / `clock_tick` / `lore_toggle` / `hide_toggle` / `profile_apply`）均以 `pi.appendEntry("rp:tx", tx)` 写入 Pi 原生会话树。在 `session_start`（覆盖 `startup/reload/new/resume/fork`）和 `session_tree` 时沿 `ctx.sessionManager.getBranch()` 从零重放，确保分支切换后状态与剧情一致。
- **严谨回合边界（`settlement.ts`、`state-replay.ts`）**：`turn_end` 自动检测并跳过工具调用中间步（`isIntermediateToolCallMessage`），且 `clock_tick` 仅在 `beatDelta > 0` 时递增回合与扣减临时导演指令 TTL，避免一次交互内重复计回合。
- **规则校验（`cfsm.ts`、`dice.ts`、`gates.ts`）**：数值变更强制做上下界裁剪；掷骰使用 `node:crypto` 真随机，支持 `NdM`、`kh`/`kl` 优势劣势、`+/-` 修正与 DC 判定；门禁统一校验 `minTurn`、`requiredEra`、`requiredMilestones`、`requiredFlags`、`forbiddenFlags`、`requiredLocations`。

### 3. 保真解析与 L0 / L1 / L2 三层通用信息抽取（`src/parser/`、`src/engine/settlement.ts`）
- **容器解包与平衡括号清洗（`unpack.ts`、`sanitizer.ts`、`mvu-salvage.ts`）**：原生解析 PNG `tEXt`/`iTXt`/`zTXt`（严格 `ccv3` 优先于 `chara`）、`.charx` ZIP（带 Zip-Slip 路径校验与 `embeded://` 历史拼写兼容）及 V1/V2/V3 JSON；在剥离 HTML/脚本壳**之前**从原始常驻世界书与 `InitVar` 打捞 MVU/YAML 数值 Schema；使用平衡标签深度扫描器精确剥离嵌套 HTML 状态栏，不误删正文。
- **L0 零成本确定性抽取（`world-profile.ts`）**：导入时 0 Token 提取纯文本里的显式地点/时间/阶段锚点与有界数值（如 `体力：80/100`），并启发式推断卡型（`CardArchetype`）与启用模块（`WorldProfileModules`）。
- **L1 一键建档永久缓存（`analyzer.ts`）**：`/rp analyze` 调用当前模型做一次结构化画像提取（卡型、初态、初始物品、CFSM 建议轴、实体别名表、建议防剧透门禁），经用户确认后将别名反哺进世界书条目并永久写入 `card.compiled.json`，后续新开局 0 Token 复用。
- **L2 可选异步边车闭环（`settlement.ts`）**：开启 `sidecar-light` 后挂在 `agent_settled`/`agent_end`（每回合幂等保护、不阻塞首字输出），将现行事实 ID 传给边车模型，支持非破坏性作废旧事实（`invalidatedFactIds`）、刷新时空锚点与按模块门控的数值/物品/时钟更新。

### 4. 本地无向量召回与长程压缩（`src/memory/`）
- **BM25 + 2 跳 PPR 实体图谱（`graph-ppr.ts`）**：完整支持 SillyTavern 关键词、次关键词、`@@exclude_keys`、内联 `/regex/flags`、概率、`sticky`/`cooldown`/`useOnce` 以及 `@@activate_only_after` 等 CCV3 装饰器；在此基础上构建实体共现邻接表并执行 2 轮幂迭代 Personalized PageRank（本地毫秒级），按 Token 预算截断送入 Zone 3。
- **双时态事实、伏笔与幕间压缩（`bitemporal.ts`、`foresight.ts`、`compaction.ts`）**：事实携带 `validFromTurn` / `validUntilTurn` / `witnessIds`；伏笔按相关度与紧迫度每轮筛选 Top 3；`session_before_compact` 严格返回官方 `CompactionResult`，将关键状态、有效事实、人物信念与未收伏笔归并为结构化幕级摘要。

### 5. 官方 Pi SDK 接入与双端兼容边界（`src/index.ts`、`src/engine/llm-helper.ts`、`src/ui/`）
- **零跨会话污染**：所有 6 个 RP 工具均设 `defaultActive: false`；`~/.pi/agent/rp-library` 与 `.pi/rp/` 仅作为静态素材库，不自动激活任何会话。
- **官方 API 对齐**：
  - 统一通过 `ctx.modelRegistry.streamSimple(model, context, options).result()` 发起内部 LLM 调用（附带 `UserMessage.timestamp` 与 `ctx.signal`，兼容所有 `/login` 与自定义 Provider）；
  - 使用 `pi.on("input")` 实现行内 `((OOC))` 拦截；`pi.registerEntryRenderer("rp:tx")` 渲染 `/tree` 可读事务；`pi.registerMessageRenderer` 渲染细线框卡片；`pi.registerMarkdownTransformer(..., { messageTypes: ["assistant", "custom"] })` 处理展示层清洗与酒馆 `AI_OUTPUT` 正则；
  - 使用 `ctx.ui.setEditorText` 实现 `Alt+I` 代写填框，`ctx.ui.editor` 承载多行导演指令与零污染场外回答，`pi.setSessionName` / `ctx.ui.setTitle` / `ctx.ui.setWorkingMessage` / `ctx.getContextUsage` 提升原生沉浸感，`pi.registerFlag("rp-card")` 支持 CLI 单会话直启；
  - 严格区分 `ExtensionCommandContext` 与 `ExtensionContext`（快捷键无 `navigateTree` 时自动平滑降级），HUD 采用纯 `string[]` Widget，确保桌面 TUI 与 `pi-android`（RPC 模式）行为一致。

<br>

---

## 文档与测试

- [01 · 前沿学术调研（2025–2026 代表性论文索引）与架构映射](docs/01-RESEARCH-AND-ARCHITECTURE.md)
- [02 · V1 / V2 / V3 / .charx 角色卡与世界书保真解析规范](docs/02-CARD-SPEC-AND-PARSER.md)
- [03 · 官方 Pi SDK 扩展工程设计与 API 对齐清单](docs/03-PI-EXTENSION-DESIGN.md)
- [04 · 8 大社区角色卡型兼容性矩阵与边界说明](docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md)

```bash
npm run typecheck   # TypeScript 严格类型检查
npm test            # 运行全部单元测试（引擎、解析器、三层抽取与论坛玩法）
```

---

<p align="center">
  MIT License · <a href="https://github.com/heikeyangle-code/pi-android">Pi for Android</a> · <a href="https://github.com/badlogic/pi-mono">Pi Coding Agent</a>
</p>
