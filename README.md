<div align="center">

<h1>Tavern Next</h1>

<p><b>专注于纯文字叙事的下一代酒馆角色扮演引擎</b></p>

<p>
  兼容 SillyTavern 存量 V1 / V2 / V3 / .charx 角色卡、世界书与预设。<br>
  清洗前端壳、代码管状态与记忆、隔离上下文与认知边界，让模型专注写正文。
</p>

<p>
  <a href="https://github.com/heikeyangle-code/pi-android"><img alt="手机端推荐 App" src="https://img.shields.io/badge/%E6%89%8B%E6%9C%BA%E7%AB%AF%E6%8E%A8%E8%8D%90-Pi%20for%20Android-4B67B4?style=flat-square&logo=android&logoColor=white&labelColor=2B3245"></a>
  <img alt="角色卡兼容" src="https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E5%8D%A1-V1%20%7C%20V2%20%7C%20V3%20%7C%20CHARX-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="零第三方依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E4%BE%9D%E8%B5%96-Zero%20Deps-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="许可证 MIT" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-4B67B4?style=flat-square&labelColor=2B3245">
</p>

<p>
  <a href="#怎么开始玩"><b>怎么开始玩</b></a> ·
  <a href="#专注于纯文字导入角色卡会发生什么">纯文字与变量说明</a> ·
  <a href="#对比传统酒馆sillytavern做了哪些改变">对比传统酒馆</a> ·
  <a href="#日常高频玩法">日常玩法</a> ·
  <a href="#底层机制拆解">硬核机制拆解</a>
</p>

</div>

<br>

<h3 align="center">怎么开始玩</h3>

<p align="center">不用折腾本地服务器，也不需要懂底层环境。手机装一个客户端，把本仓库链接发给 AI 就能用。</p>

### 方式一：手机端直接玩（推荐）

1. 下载并安装配套的 Android 客户端：**[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)**（免 Root、免 Termux，本机直接运行）。
2. 打开 App，把本仓库地址发给 AI，让它自己装好并启用：
   > 帮我安装并启用这个角色扮演扩展：`https://github.com/heikeyangle-code/tavern-next`
3. 装好后输入 `/rp` 或 `/rp import`，内置文件浏览器会自动扫描手机下载目录里的 `.png`、`.charx`、`.json`，直接选卡开玩。

### 方式二：电脑端使用

如果你已经在电脑上安装了 [Pi CLI](https://github.com/badlogic/pi-mono)，克隆到扩展目录并 `/reload` 即可：

```bash
git clone https://github.com/heikeyangle-code/tavern-next.git ~/.pi/agent/extensions/tavern-next
```

在终端输入 `/rp` 打开启动器，或用 `pi --rp-card <card-slug>` 直接在当前会话加载指定角色卡。

<br>

---

<h3 align="center">专注于纯文字：导入角色卡会发生什么？</h3>

<p align="center">这里把实际代码会做什么、不会做什么，老老实实一次讲清。</p>

- **所有前端美化与脚本壳，默认清洗为纯文字**
  - 导入 SillyTavern / RisuAI / Chub 角色卡时，编译器会用平衡标签扫描器剥离 `<script>`、`<style>`、`<iframe>`、带内联样式的 HTML 状态栏壳、`<UpdateVariable>`、纯前端美化正则以及 `live2d`/`vrm` 等 Web 资产。
  - **绝不删改叙事正文与灵魂字段**：`description`、`personality`、`scenario`、`mes_example`（对话示例）、`system_prompt`、`post_history_instructions`、`depth_prompt` 与有效世界书正文均原样保留；如果你不想做清洗，也随时可以通过 `/rp raw` 切换原味直通。
  - **明确的能力边界**：如果某张卡的核心玩法本身是一段浏览器 Canvas / Vue / React 互动网页小游戏，本引擎不运行浏览器 DOM，无法照原样运行其前端点击玩法。

- **会自动提取变量吗？没有变量的纯文字卡也会提取吗？**
  - **卡里本身写了变量（MVU / `InitVar` / YAML / 宏变量，或纯文本里明确写着 `体力：80/100`、`好感度：20`、Markdown 属性表）**：导入时（0 Token，纯本地规则）会在清洗前端壳**之前**自动把这些变量打捞出来，开局直接写入状态引擎。
  - **完全没有写变量的纯文字卡**：导入时**不会**凭空捏造数值变量，保持纯粹的文字对话体验。如果你希望引擎额外追踪物品、角色心态阶段、实体别名或防剧透门禁，可以手动执行一次 `/rp analyze`（调用当前模型分析 1 次并永久缓存），或在游玩时开启后台可选结算（`/rp mode sidecar-light`），也可以直接在 `/rp panel` 里手动记。

- **提取到的变量会自动展示在状态栏吗？**
  - **默认极简状态栏（`minimal`）**：只显示一行干净的 `◆ 角色名 · 时间 · 地点 · T轮数`（外加未收伏笔数与指令数），不会把一堆数值挤在单行里。
  - **完整状态栏（`/rp hud full`）**：在输入框上方展开多行原生状态条，自动把提取到的有界数值条（`▓▓▓░░ 80/100`）、角色心态阶段、背包物品、进度时钟与导演指令全部展示出来（桌面端与手机端通用）。
  - **世界面板（`/rp panel`）**：任何时候都可以打开面板，查看和直接修改全部数值、物品、心态、场景与记忆本。

- **变量计算、状态更新和聊天上下文彻底隔离（不会因为模型算错数而错乱）**
  - **传统酒馆是怎么做的**：在传统酒馆里，变量加减、`<UpdateVariable>` 补丁、HTML 状态栏代码全部混在主对话上下文里——每轮都要主模型一边写小说、一边在结尾自己算账吐代码；算错数、漏字段、格式崩坏是常态，而且几十轮过期的状态代码会永远堆在聊天历史里，严重污染上下文并拖垮文笔。
  - **我们的真实隔离机制**：
    1. **运算全部归代码，不让模型当算盘**：数值加减与上下界裁剪（`min`/`max`）、背包数量增减、进度时钟推进、真随机掷骰（`node:crypto`）、门禁校验全部由 TypeScript 代码确定性执行，模型只负责写正文或在需要时提交结构化意图，**不会因为模型算错数导致数值错乱**。
    2. **动态状态不进聊天历史（发完即丢）**：每轮最新世界状态（`<rp_state_frame>`）和召回的世界书/记忆，只通过 `context` 钩子**临时挂在本次请求的尾部（Zone 3）**，绝不落盘写入聊天记录。聊到第 100 轮时，主对话历史里依然只有干干净净的纯文字剧情，没有一坨过期状态栏垃圾。
    3. **后台抽取与辅助功能走独立隔离上下文**：开启 `sidecar-light` 后，事实/场景/变量提炼是在回复结束后另起一次**独立轻量模型请求**（校验后落账，不阻塞首字、不污染主对话流）；`/rp analyze` 建档、`/rp ask` 场外提问、`/rp imp` 代写主角同样走独立隔离请求，结果绝不塞进主剧情历史。
    4. **会话与剧情认知双隔离**：角色库纯静态存放，绝不污染其他普通会话（`/rp exit` 一键清零）；未解锁世界书在代码层物理拦截，私密事件按知情者列表标注认知盲区，防止提前剧透与 NPC 全知穿帮。

<br>

---

<h3 align="center">对比传统酒馆（SillyTavern），做了哪些改变？</h3>

<p align="center">两者底层架构不同：传统酒馆以浏览器前端 + 单体文本拼接为核心，本项目以纯文字叙事 + 确定性代码状态引擎为核心。</p>

| 对比项 | 传统酒馆（SillyTavern） | Tavern Next |
| :--- | :--- | :--- |
| **前端美化与状态栏** | 依赖模型在正文里输出 HTML/状态块，再用前端脚本与正则渲染 | 清洗前端壳，正文永远纯文字；状态由代码维护，通过原生状态栏与 `/rp panel` 展示 |
| **上下文组织** | 系统提示、世界书、`@D` 注入与聊天历史拼接在一起，中段插队易打断前缀缓存 | **三区架构**：冻结前缀 + 纯追加历史 + 仅附于当次请求尾部的瞬态状态帧 |
| **数值与背包追踪** | 靠 Prompt 约束模型自己算账，长对话容易算错或格式漂移 | 代码侧确定性校验（上下界裁剪、背包增减、真随机掷骰），状态与正文彻底解耦 |
| **世界书与长程记忆** | 关键词子串/正则扫描近期消息，旧设定与新事实容易并存冲突 | 本地 BM25 + 2 跳实体图谱（PPR）联想召回 + 双时态事实账本（旧事实非破坏性失效）+ 伏笔队列 |
| **重摇与回溯一致性** | 聊天记录与外置变量脚本分开存储，回退楼层后数值易错位 | 所有状态变更作为事务日志寄生在原生会话树（DAG）中，回溯/分叉分支时精确重放还原 |

<br>

### 对比其他「新时代 RP 架构」（多 Agent / 外置向量库）

除了传统酒馆，社区里还出现过两类常见的新路线——**全量多 Agent 编排**（导演 + 每个 NPC 独立一个 Agent + 裁判）和 **外置向量数据库 RAG**（独立跑向量库 + Embedding API）。我们没有走这两条路，原因很直接：

| 路线 | 典型做法 | 实际游玩时的痛点 | Tavern Next 的取舍与优点 |
| :--- | :--- | :--- | :--- |
| **全量多 Agent** | 导演、旁白、角色 A/B 各自独立上下文串行调用 | 串行多轮调用导致**首字等待慢**；每个 Agent 各算一份上下文，**Token 翻倍且前缀缓存几乎失效**；跨 Agent 交接摘要容易丢失情绪铺垫与文风连贯 | **单主脑统一执笔 + 代码管状态**：90% 日常与群戏只调 1 次主模型流式直出，文风统一、前缀缓存完整；仅在强信息不对称博弈时按需调用视角隔离视图 |
| **外置向量 RAG** | 依赖外部向量库与云端 Embedding 接口检索聊天记录 | 手机端本机部署麻烦、依赖额外 API；纯语义相似度不擅长处理**时间线更新**，旧事实与新事实经常同时被召回互相打架 | **本地纯代码零依赖召回**：纯 TypeScript 本地 BM25 + 2 跳实体图谱（PPR）毫秒级运行，配合**双时态事实失效**，旧事实作废后不再干扰当前回合 |
| **重度前端状态卡** | 用 HTML/CSS/JS 脚本把聊天框改造成网页游戏界面 | 提示词被大量前端格式指令挤占，容易崩格式、污染上下文 | **专注纯文字叙事**：剥离前端壳，正文永远干净，数值/背包/记忆全部交由代码引擎与原生面板维护 |

<br>

---

<h3 align="center">日常高频玩法</h3>

<p align="center">围绕真实长篇纯文字游玩习惯整理，日常卡清爽简洁，复杂卡按需展开。</p>

- **通用 5+1 世界面板（`/rp panel`）**
  - **当前场景与时间**：修改地点、在场人物、时间标签，或一键切场景/跳时间（`/rp skip`）。
  - **人物与关系**：查看或调整角色态度阶段、好感与数值、人物印象，切换玩家马甲（`/rp persona`）与同场共演（`/rp cast`）。
  - **剧情记忆本**：0 Token 瞬时生成前情提要（`/rp recap`）、记录公开/私密事件与伏笔，支持**一键「总结并隐藏较早的对话楼层」**（`/rp summarize`，把旧楼层压成记忆条目并对模型非破坏性隐藏，原记录随时可 `/rp unhide` 恢复）。
  - **世界书管理**：支持 300+ 条目关键词搜索、按状态/门禁筛选、分页开关，并可**从最近对话一键为新人物或新地点生成世界书条目**（`/rp loregen`）。
  - **导演台（Author's Note）**：调整叙事节奏（`/rp pace`），用多行编辑器写临时或常驻导演指令（`/rp note`）。
  - **跑团与世界机制**：背包、进度时钟、真随机掷骰（`/rp roll`）、剧情阶段与模块开关，按卡型自动展开或折叠。
- **高频创作辅助**
  - **帮我代写主角回复（`/rp imp`）**：以玩家人设视角起草一段回复并直接填入输入框，改两句就能发。
  - **零污染场外提问（`/rp ask`）**：随时查角色真实心理、核对前文线索或要剧情灵感，弹窗看完即关，**不写入聊天历史、不推进回合**。
  - **行内 `((OOC))` 讨论**：在输入框直接打 `((内容))` 或 `（（内容））`，自动识别为场外讨论，不推进剧情与时钟。
  - **分叉重摇与书签（`/rp reroll`、`/rp save`、`/rp goto`）**：重摇上一条回复时支持附带 1 轮微调方向，旧版本保留在原生 `/tree` 会话树里，随时切回。

<br>

---

<h3 align="center">底层机制拆解</h3>

<p align="center">以下内容全部对应仓库内实际实现的代码模块，面向关心底层工程设计与长程一致性的玩家与开发者。</p>

### 1. 三区 KV-Cache 上下文装配（`src/context/zone-builder.ts`）
- **Zone 1（冻结前缀，`before_agent_start`）**：按 SillyTavern 位置规范组装引擎极简协议、预设前段、`system_prompt`、`before_char`/`after_char`/`before_example`/`after_example` 常驻世界书、静态 `outlet`、角色核心设定、**100% 原样 `mes_example`** 与初始玩家人设。不包含回合数、时间戳或动态数值，跨回合字节级不变；中途更换玩家马甲时仅在 Zone 3 声明，不击穿前缀缓存。
- **Zone 2（Append-Only 历史流）**：永不修改历史消息对象。隐藏楼层同时记录 `entryId` 与基于 `role|timestamp|head` 的 SHA-1 指纹，在 `context` 钩子中做非破坏性过滤，不破坏原始 JSONL 会话文件。
- **Zone 3（瞬态尾部帧，`context`）**：仅挂接在发往模型的消息副本末尾，绝不落盘。按确定性键序序列化 `<rp_state_frame>`，依次附带召回世界书、现行有效事实、列表优先认知盲区（`- [HIDDEN FROM: NPC] ...`）、在场角色优先的信念边、开放伏笔、节奏与轻量防停滞提示、导演指令、`depth_prompt` 与 `post_history_instructions`。

### 2. 确定性状态机与会话树事件溯源（`src/engine/`）
- **事件溯源重放（`state-replay.ts`）**：所有状态变更（`bind`、`unbind`、`stat_patch`、`inventory_patch`、`location_set`、`cfsm_define`、`cfsm_transition`、`progress_clock`、`fact_add`、`fact_invalidate`、`belief_update`、`foresight_upsert`、`era_advance`、`clock_tick`、`lore_toggle`、`hide_toggle`、`profile_apply`）全部作为 `rp:tx` 事务写入原生会话树。每次会话启动、重连或切换分支（`session_start` / `session_tree`）时，沿当前分支从零确定性重放。
- **严谨回合边界（`settlement.ts`、`state-replay.ts`）**：`turn_end` 自动跳过工具调用中间步，且 `clock_tick` 仅在 `beatDelta > 0` 时递增回合与扣减临时导演指令 TTL，避免同回合多次结算。
- **代码侧规则校验（`cfsm.ts`、`dice.ts`、`gates.ts`）**：数值变更强制上下界裁剪；掷骰基于 `node:crypto` 真随机（支持 `NdM`、`kh`/`kl`、修正值与 DC）；门禁统一校验 `minTurn`、`requiredEra`、`requiredMilestones`、`requiredFlags`、`forbiddenFlags`、`requiredLocations`。

### 3. L0 / L1 / L2 三层通用抽取管道（`src/parser/`、`src/engine/settlement.ts`）
- **L0（导入时，0 Token，纯本地）**：解析 PNG `tEXt`/`iTXt`/`zTXt`（`ccv3` 优先于 `chara`）、`.charx`（Zip-Slip 安全校验与 `embeded://` 兼容）与 V1/V2/V3 JSON；清洗前打捞 MVU/YAML/宏及纯文本显式有界数值与时空锚点，推断卡型（`CardArchetype`）与模块开关（`WorldProfileModules`）。
- **L1（`/rp analyze`，按需 1 次调用永久缓存）**：通过统一的 `llm-helper.ts`（`ctx.modelRegistry.streamSimple().result()`）提取完整世界画像、初始物品、CFSM 建议轴、实体别名表（写回世界书条目提升召回率）与建议防剧透门禁，用户确认后持久化到 `card.compiled.json`，后续新开局 0 Token 复用。
- **L2（可选 `sidecar-light` 后台边车）**：挂载在 `agent_settled`/`agent_end`（每回合幂等保护、不阻塞首字输出），将现行事实 ID 传入边车模型，支持非破坏性旧事实失效（`invalidatedFactIds`）、场景/时间更新与按模块门控的数值/物品/时钟更新。

### 4. 本地无向量召回、认知隔离与长程压缩（`src/memory/`）
- **BM25 + 2 跳 PPR 实体图谱（`graph-ppr.ts`）**：完整支持 SillyTavern 关键词、次关键词、`@@exclude_keys`、内联 `/regex/flags`、概率、`sticky`/`cooldown`/`useOnce` 与 CCV3 装饰器；基于实体共现邻接表执行 2 轮幂迭代 Personalized PageRank（本地毫秒级），按 Token 预算截断送入 Zone 3。
- **双时态事实、伏笔与幕间压缩（`bitemporal.ts`、`foresight.ts`、`compaction.ts`）**：事实携带 `validFromTurn` / `validUntilTurn` / `witnessIds`；伏笔每轮按相关性筛选 Top 3；触发长对话压缩（`session_before_compact`）时将当前状态、有效事实、人物信念与开放伏笔归并为结构化幕级摘要。

### 5. 运行时隔离与底层扩展边界（`src/index.ts`、`src/ui/`）
- **默认休眠**：注册的 6 个内部工具均设 `defaultActive: false`，未开启 RP 时 0 工具 Token、0 UI 占用、0 Hook 开销；`rp:tx` 状态事务在对话流中完全静默不渲染，不打断正文阅读沉浸感；展示层通过 `registerMarkdownTransformer({ messageTypes: ["assistant", "custom"] })` 清理残留标签并执行酒馆 `AI_OUTPUT` 展示正则。
- **双端一致**：状态栏采用纯文本数组 Widget，输入框预填与多行编辑采用标准 UI 接口，在桌面端终端与移动端 [Pi for Android](https://github.com/heikeyangle-code/pi-android)（RPC 模式）下均可直接工作。

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
npm test            # 运行全部单元测试
```

</details>

---

<p align="center">
  MIT License · 手机端推荐使用 <a href="https://github.com/heikeyangle-code/pi-android"><b>Pi for Android</b></a>
</p>
