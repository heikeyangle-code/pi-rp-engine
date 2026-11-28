<div align="center">

<h1>Tavern Next</h1>

<p><b>专注于纯文字叙事的下一代酒馆角色扮演引擎</b></p>

<p>
  兼容 SillyTavern 存量 V1 / V2 / V3 / .charx 角色卡、世界书与预设。<br>
  清洗前端壳、代码管状态与记忆、计算与叙事上下文彻底隔离，专为手机端与终端长篇文游打磨。
</p>

<p>
  <a href="https://github.com/heikeyangle-code/pi-android"><img alt="手机端推荐 App" src="https://img.shields.io/badge/%E6%89%8B%E6%9C%BA%E7%AB%AF%E6%8E%A8%E8%8D%90-Pi%20for%20Android-4B67B4?style=flat-square&logo=android&logoColor=white&labelColor=2B3245"></a>
  <img alt="角色卡兼容" src="https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E5%8D%A1-V1%20%7C%20V2%20%7C%20V3%20%7C%20CHARX-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="零第三方依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E4%BE%9D%E8%B5%96-Zero%20Deps-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="许可证 MIT" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-4B67B4?style=flat-square&labelColor=2B3245">
</p>

<p>
  <a href="#怎么开始玩"><b>怎么开始玩</b></a> ·
  <a href="#纯文字变量与上下文隔离说明">纯文字与上下文隔离</a> ·
  <a href="#对比传统酒馆与其他新架构">架构对比</a> ·
  <a href="#核心游玩功能">游玩功能</a> ·
  <a href="#硬核机制拆解">硬核机制拆解</a>
</p>

</div>

<br>

<h3 align="center">怎么开始玩</h3>

<p align="center">不用折腾本地服务器，也不需要配环境。整个面板、状态栏与所有交互流程均已针对手机触控进行专门优化。</p>

### 方式一：手机端直接玩（推荐）

1. 下载并安装配套 Android 客户端：**[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)**（免 Root、免 Termux，本机直接运行）。
2. 打开 App，把本仓库链接发给 AI，让它自动安装并启用：
   > 请帮我安装并启用这个角色扮演扩展：`https://github.com/heikeyangle-code/tavern-next`
3. 装好后输入 `/rp` 或 `/rp import`，内置文件浏览器会自动扫描手机下载目录里的 `.png`、`.charx`、`.json`，选卡即可开玩。所有面板均采用手机原生可搜索底部弹窗与一键点选交互，单手触控顺手，并支持一键撤销状态误操作。

### 方式二：电脑端使用

如果已在电脑上安装 [Pi CLI](https://github.com/earendil-works/pi)，克隆到扩展目录并 `/reload` 即可：

```bash
git clone https://github.com/heikeyangle-code/tavern-next.git ~/.pi/agent/extensions/tavern-next
```

输入 `/rp` 打开启动器，或用 `pi --rp-card <card-slug>` 单会话直启指定角色卡。

<br>

---

<h3 align="center">纯文字、变量与上下文隔离说明</h3>

<p align="center">把实际代码会做什么、不会做什么，老老实实一次讲清。</p>

- **所有前端美化与脚本壳，默认清洗为纯文字**
  - 导入 SillyTavern / RisuAI / Chub 角色卡时，平衡标签扫描器会剥离 `<script>`、`<style>`、`<iframe>`、内联样式 HTML 状态栏壳、`<UpdateVariable>`、纯前端美化正则及 `live2d`/`vrm` 等 Web 资产。
  - **100% 原样保留灵魂字段**：`description`、`personality`、`scenario`、`mes_example`（对话示例）、`system_prompt`、`post_history_instructions`、`depth_prompt` 与有效世界书正文绝不删改；随时可通过 `/rp raw` 切换原味直通。
  - **能力边界**：如果某张卡的核心玩法本身是内嵌浏览器 Canvas / Vue / React 点击小游戏，本引擎不运行浏览器 DOM，无法照原样运行其网页交互。

- **变量怎么提取？没有变量的纯文字卡也会提取吗？**
  - **带变量的卡（MVU `_.set`/`_.add`/`_.assign`、JSONPatch、禁用状态的 `[InitVar]` 嵌套 YAML、HTML 属性表，或纯文本里明确写着 `体力：80/100` 等属性）**：导入时（L0，0 Token，纯本地）会在清洗前端壳**之前**无损打捞变量与上下界（支持负值与双极属性），开局直接写入状态引擎。
  - **完全没有写变量的纯文字卡**：导入时**不会**凭空捏造变量。如果你希望为纯文字卡建立完整世界档案，可执行一次 `/rp analyze`（L1，7 维度深度提取并永久缓存到编译卡中，后续新开局 0 Token 复用），或在游玩中开启可选后台边车（`/rp mode sidecar-light`）与面板手动管理。

- **提取到的变量会自动展示在状态栏吗？**
  - **默认极简状态栏（`minimal`）**：底部单行只显示干净的 `◆ 角色名 · 阶段 · 时间 · 地点 · T轮数`（及未收伏笔数与导演指令数），不堆叠杂乱数值。
  - **完整状态栏（`/rp hud full`）**：在输入框上方展开多行原生状态条，自动展示有界数值条（含双向正负条）、角色心态阶段、背包物品、进度时钟与当前指令。
  - **世界面板（`/rp panel`）**：随时以原生底部弹窗查看、搜索、编辑全部状态，并支持一键撤销上次变更。

- **变量计算、状态更新与叙事上下文彻底隔离（不会因为模型算错数而错乱）**
  - **运算归代码，不让模型当算盘**：数值加减与上下界裁剪、背包数量校验（禁止扣成负数）、进度时钟推进、真随机掷骰、条件门禁校验全部由 TypeScript 代码确定性执行。
  - **动态状态发完即丢，永不写进聊天历史**：每轮 `<rp_state_frame>` 与召回记忆仅通过 `context` 钩子临时附在当次请求尾部（Zone 3），绝不落盘进历史记录。聊到第 100 轮时，主对话历史里依然只有干净纯文字剧情，没有堆积的过期状态代码。
  - **后台结算与辅助功能走独立隔离上下文**：开启 `sidecar-light` 时，事实、信念与状态提炼在回复结束后另起独立轻量模型请求（且主叙事模型不背状态写入工具，专注写正文）；`/rp analyze`、`/rp ask`、`/rp imp`、`/rp act` 全部走独立隔离请求，不污染主剧情上下文。
  - **会话与剧情认知双隔离**：角色库纯静态存放，绝不污染普通编程会话（`/rp exit` 一键清零）；未解锁世界书物理拦截，私密事件按知情者列表标注认知盲区。

<br>

---

<h3 align="center">对比传统酒馆与其他新架构</h3>

| 路线 | 典型做法 | 实际游玩时的痛点 | Tavern Next 的取舍与机制 |
| :--- | :--- | :--- | :--- |
| **传统酒馆 1.0（SillyTavern）** | 单体文本拼接 + Prompt 逼模型吐 `<status>` / HTML 状态栏 + 关键词子串扫世界书 | 聊久了状态栏崩格式、历史堆满过期代码、前缀缓存频繁碎裂、回溯后变量与剧情错位 | **三区零碎裂缓存 + 代码管真值 + 会话树事件溯源**：正文永远纯文字，回溯/分叉时所有状态 100% 同步还原 |
| **全量多 Agent 编排** | 导演、旁白、每个 NPC 各自独立上下文串行调用 | 首字等待慢、Token 翻倍且前缀缓存几乎失效、跨 Agent 交接摘要易丢失文风连贯性 | **单主脑统一执笔 + 代码引擎 + 按需隔离**：日常与群戏只调 1 次主模型流式直出，仅在强信息不对称博弈时按需调用视角隔离视图 |
| **外置向量 RAG** | 依赖独立向量库与云端 Embedding API 检索旧聊天 | 手机本机难部署、依赖额外服务；纯语义相似度不擅长处理时间线更新，新旧事实易并存打架 | **本地纯代码零依赖召回**：纯 TypeScript 本地 BM25 + 统一 2 跳 PPR 实体图谱毫秒级运行 + 双时态事实非破坏性失效 |

<br>

---

<h3 align="center">核心游玩功能</h3>

- **原生触控世界面板（`/rp panel`）**：
  - **场景、目标与动态剧情卡（Storylets）**：管理地点、在场人物、当前场景目标、带属性/门禁条件的 Storylets（完成后自动触发后续效果），以及**幕间世界推演（`/rp skip`）**——跳时间时在后台推演时钟进展、幕后势力暗流与新场景切入镜头，确认后再落盘。
  - **人物与关系**：管理角色心态阶段（CFSM）、好感与多角色数值、背包物品、人物印象与信念，随时切换玩家马甲（`/rp persona`）与同场共演（`/rp cast`）。
  - **记忆书、事实与秘密**：支持把较早的对话楼层一键总结归档为「记忆书章节」并隐藏旧楼层（`/rp summarize`），管理公开/私密事实与未收伏笔，0 Token 查看前情提要（`/rp recap`）。
  - **世界书完整管理**：支持 300+ 条目搜索、筛选、全文编辑、新增/删除、实时开关，以及从最近对话一键生成新世界书条目（`/rp loregen`）。
  - **导演台、快捷回复与 X-Ray 透视**：切换叙事节奏、管理内心戏开关、常用快捷回复宏（`/rp qr`）、查看真实 3 层上下文与 KV-Cache 命中连击（`/rp xray`）、一键撤销误操作。
- **零污染创作辅助**：
  - **帮我代写主角回复（`/rp imp`）**：以玩家人设起草一段回复直接填入输入框，改两字就能发；
  - **一键行动建议（`/rp act`）**：隔离生成 3 条贴合当下情境的直接可发选项，点选即填入输入框，不污染聊天记录；
  - **零污染场外提问（`/rp ask`）**：随时查角色心理、核对线索或构思走向，看完即关，不写入历史；
  - **行内 `((OOC))` 语法**：直接输入 `((内容))` 或 `（（内容））` 自动识别为场外讨论，不推进剧情与时钟；
  - **分叉重摇与书签（`/rp reroll`、`/rp save`、`/rp goto`）**：支持定向微调重摇，旧分支完整保留在原生 `/tree` 中。

<br>

---

<h3 align="center">硬核机制拆解</h3>

<p align="center">以下全部对应仓库内实际代码与 46 项自动化单元测试，无外部数据库、无第三方运行时依赖。</p>

### 1. 三区 KV-Cache 上下文装配与 X-Ray 透视（`src/context/zone-builder.ts`）
- **Zone 1（冻结前缀，`before_agent_start`）**：按 SillyTavern 位置规范组装引擎极简协议、预设前段、`system_prompt`、常驻世界书、静态 `outlet`、角色设定、**100% 原样 `mes_example`** 与初始玩家人设；所有宏采用确定性种子求值，跨回合通过 SHA-256 哈希校验保证字节级一致。
- **Zone 2（Append-Only 历史流）**：绝不篡改历史消息对象；隐藏楼层同时记录 `entryId` 与消息指纹做非破坏性过滤。
- **Zone 3（瞬态尾部帧，`context`）**：仅挂接在当次请求末尾，不落盘。包含确定性键序 `<rp_state_frame>`、召回世界书、实体匹配的双时态事实、列表优先认知盲区（`- [HIDDEN FROM: NPC] ...`）、RoleMemo DualMem 信念、开放伏笔、激活 Storylets、真实叙事健康度防停滞提示（`stagnation.ts` 基于复读率与世界推进状态动态检测）、导演指令、`depth_prompt` 与 `post_history_instructions`。

### 2. 无损 7 维抽取与 L0 / L1 / L2 闭环管道（`src/parser/`、`src/engine/settlement.ts`）
- **L0 本地无损打捞（`mvu-salvage.ts`、`world-profile.ts`）**：支持禁用态 `[InitVar]` 嵌套 YAML、官方 MVU `_.set`/`_.add`/`_.assign`、JSONPatch、HTML 表格与纯文本有界数值，多角色隔离且保留负值边界。
- **L1 一键 7 维建档（`analyzer.ts`）**：`/rp analyze` 一次性提取卡型、模块、时空初态、初始物品、数值、CFSM 建议轴、实体别名表（反哺世界书召回）与防剧透门禁，永久缓存至 `card.compiled.json`。
- **L2 异步边车闭环（`settlement.ts`、`llm-helper.ts`）**：支持在 `/rp sidecar` 指定独立的廉价极速模型，挂载于 `agent_settled`/`agent_end`（零首字延迟），输出双时态失效（`invalidatedFactIds`）、RoleMemo 主观洞见与情绪基调、场景/时钟/数值更新；兼容推理模型思考标签剥离与平衡括号 JSON 提取。

### 3. 统一 HippoRAG 2 图谱召回与双时态记忆（`src/memory/`）
- **统一 2 跳 PPR（`graph-ppr.ts`）**：将世界书条目、双时态事实与记忆书章节桥接在同一本地实体共现图上执行 2 轮幂迭代 Personalized PageRank（本地毫秒级），保证长篇多轮对话中早期关键设定依然可被准确召回。
- **语义幕间压缩（`compaction.ts`）**：`session_before_compact` 支持异步语义 MemScene 归并并具备安全回退机制，严格遵循官方 `CompactionResult` 契约。

### 4. 确定性事件溯源、可逆审计与零污染生命周期（`src/engine/state-replay.ts`、`src/index.ts`）
- 所有状态变更以 `rp:tx` 事务写入原生会话树并维护可逆审计日志（`auditLog`），支持一键撤销与分支重放；
- 6 个内部工具均设 `defaultActive: false`；在 `sidecar-light` / `off` 模式下自动向主模型隐藏状态写入工具以节省 Schema Token 并减少工具格式干扰；
- 所有内部模型调用统一走 Pi 官方 `ctx.modelRegistry.streamSimple().result()`（附带 `timestamp` 与 `ctx.signal`），并严格遵循 Pi 官方 UI 契约，保证桌面端与 [Pi for Android](https://github.com/heikeyangle-code/pi-android) 行为一致。

<br>

---

<details>
<summary><b>深度设计文档与本地开发测试</b></summary>

- [01 · 2025–2026 角色扮演与记忆领域研究索引及架构映射](docs/01-RESEARCH-AND-ARCHITECTURE.md)
- [02 · V1 / V2 / V3 / .charx 角色卡与世界书保真解析规范](docs/02-CARD-SPEC-AND-PARSER.md)
- [03 · 标准扩展生命周期设计与 API 对齐清单](docs/03-PI-EXTENSION-DESIGN.md)
- [04 · 8 大社区角色卡型兼容性矩阵与边界说明](docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md)

```bash
npm run typecheck   # TypeScript 严格类型检查
npm test            # 运行全部 46 项引擎、解析器、图谱召回与交互单元测试
```

</details>

---

<p align="center">
  MIT License · 手机端推荐使用 <a href="https://github.com/heikeyangle-code/pi-android"><b>Pi for Android</b></a>
</p>
