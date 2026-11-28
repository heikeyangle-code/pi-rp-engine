# 01 · 前沿学术调研与下一代架构设计

本文档系统汇总 2025–2026 年角色扮演 Agent、长程记忆、叙事控制、认知隔离与上下文工程领域的代表性工作，并将其收敛为一套**无需外部向量库、零额外云端依赖、可在手机端毫秒级运行的纯 TypeScript 通用架构**。

---

## 一、为什么传统酒馆（SillyTavern 1.0）必须被下一代架构替代

| 维度 | SillyTavern 1.0 范式 | 结构性缺陷 | `pi-rp-engine` 2.0 范式 |
| :--- | :--- | :--- | :--- |
| **上下文组织** | 单体巨型字符串每轮重拼，世界书与 `@D` 随意插队 | 只要前/中段变动 1 token，Prompt Prefix KV Cache 立刻全线失效；长程触发 Chroma *Context Rot* | **三区架构**：冻结前缀（Zone 1）+ Append-Only 干净历史（Zone 2）+ 仅挂当前请求尾部的瞬态状态帧（Zone 3） |
| **状态与数值** | 靠 Prompt 逼模型输出 `<status>` / JSON / MVU 补丁，再用正则 + 前端 HTML/JS 渲染 | LLM 既演戏又当算盘和前端，格式一歪全盘崩溃，且历史里堆满几十坨过期状态栏垃圾 | **确定性代码 FSM**：代码管真值、边界、时钟与检定；正文永远干净 |
| **世界书与记忆** | 关键词子串/正则扫描最近 N 句 | 代词（“他/那把剑”）漏触发、通用词误触发污染上下文、旧事实与新事实互相打架 | **物理门禁 + 双时态事实账本 + 本地 HippoRAG PPR 1–2 跳实体图谱 + BM25** |
| **剧透与认知隔离** | 靠“请勿提前剧透”软约束 | *NCP-Bench (2026)* 证实多轮交互后软约束必然崩溃，NPC 常常全知穿帮 | **EraGate 物理隔离 + 见证者/认知域隔离**：未解锁或未在场的秘密根本不进模型上下文 |
| **分支与回溯** | 聊天记录与外置变量文件/正则脚本割裂 | 回退或重摇极易导致数值与剧情错位 | **`pi.appendEntry("rp:tx", delta)` 寄生在 Pi 原生会话树（JSONL DAG）**，分叉/回退 100% 确定性重放 |

---

## 二、2025–2026 前沿研究与机制映射（9 大理论支柱）

### 1. CFSM / CPFSM — 确定性与概率有限状态机（ICLR 2026）
- **来源**：*Codified Finite-state Machines for Role-playing* (Peng et al., UCSD / ICLR 2026)
- **核心发现**：纯 Prompt 只能描述静态表面行为，无法维持隐状态（心理防线、信任阶段、生理伤势、立场切换）的长期一致性。将角色/世界规则代码化为显式状态机（CFSM）与概率状态机（CPFSM），并用极轻量的 **`binary_q` 布尔谓词**判定状态转移，可让一致性产生质变。
- **落地机制**：
  - 通用 `CfsmMachine` 定义（每张卡/世界可自定义任意状态轴，如 `trust_stage: guarded → wary → trusting → devoted`，绝不为单卡写死）；
  - 状态转移由确定性规则（数值阈值/物品/时钟）或回合末轻量 `binary_q` 驱动；
  - 每次转移写入会话树事务日志，带原因与触发回合号。

### 2. DREAM — ABC 认知模型与事件感知记忆图（2026）
- **来源**：*DREAM: LLM-based Dynamic Role-playing via Event-Aware Memory Graph* (2026) & *TCM Benchmark*
- **核心发现**：角色成长不是靠改人设文本，而是靠 **Activating Event（触发事件）→ Belief（形成/修正信念）→ Consequence（行为倾向变化）** 的因果链。
- **落地机制**：
  - 关键事件节点记录 `{ event, actors, witnessIds, beliefUpdates[], causalParentIds[] }`；
  - 当某 NPC 再次面对主角时，检索器顺着因果边把“为什么我现在不信任你”的精确事件与当前信念送入 Zone 3。

### 3. Zep / Graphiti — 双时态知识图谱与非破坏性失效（2025–2026）
- **来源**：*Zep: A Temporal Knowledge Graph Architecture for Agent Memory* / Graphiti
- **核心发现**：普通记忆库往里追加“林远是盟友”和“林远在第 42 轮背叛了主角”，检索时两条同时出现会让模型精神分裂。
- **落地机制**：
  - 每条事实带故事内双时态边界：`validFromTurn` / `validUntilTurn`（或世界时钟时间戳）及 `supersededBy`；
  - 事实改变时**非破坏性作废旧事实**（`validUntilTurn = currentTurn`），常规召回只喂 `validUntilTurn === null` 的现行有效事实，需要回忆“过去曾怎样”时才按需查询历史态。

### 4. NCP-Bench & TimeChara & FANToM — 叙事承诺、时代门禁与认知隔离（2025–2026）
- **来源**：*Can LLM Agents Stick to the Script? (NCP-Bench, 2026)*、*TimeChara*、*FANToM / ToMBench / Adaptive ToM*
- **核心发现**：
  - 长程剧情里仅靠提示词无法守住剧本承诺与时间线；
  - 多角色交互中，大模型天然具有“上帝全知偏置（Omniscience Bias）”，会把主角私下干的事说成不在场 NPC 也知道。
- **落地机制**：
  - **Era / Milestone Gate（物理隔离）**：任何世界书条目、隐藏设定、秘密事实可挂 `gate: { minTurn?, requiredEra?, requiredMilestones?, forbiddenFlags?, requiredLocations? }`，未通过校验的条目**在代码层直接物理拦截**；
  - **Epistemic Visibility（多角色认知域）**：事实条目记录 `witnessIds: string[] | "public"`。在多角色或单 NPC 场景里，为在场 NPC 自动标注「已知事实」与「不在场盲区」，避免全知穿帮。

### 5. EverMemOS（2026）& A-MEM（NeurIPS 2025）— 分层演化记忆与「伏笔账本（Foresight）」
- **来源**：*EverMemOS: A Self-Organizing Memory Operating System (2026.1)*、*A-Mem: Agentic Memory for LLM Agents (NeurIPS 2025)*
- **核心发现**：记忆不只是回顾过去，长篇故事更关键的是 **Foresight（伏笔、约定、隐患、倒计时、未竟目标）**，以及新旧记忆之间的双向关联更新。
- **落地机制**：
  - **MemCells（微观事实/事件原子）** → 在 `session_before_compact` 幕间压缩时归并为 **MemScenes（幕级情节摘要）**；
  - 独立维护 **`ForesightStore`（伏笔/契诃夫之枪队列）**：记录 `{ id, summary, plantedTurn, triggerHint, dueClock?, status: "open" | "paid_off" | "expired" }`，每轮按相关性与紧迫度把 Top 2–3 条未收伏笔送入 Zone 3。

### 6. HippoRAG 2 — 本地无向量轻量实体图 + 1–2 跳 PPR 联想召回
- **来源**：*HippoRAG / HippoRAG 2*（海马体索引理论 + Personalized PageRank）
- **核心发现**：纯向量相似度不擅长多跳关联；而在手机离线环境下也不应强依赖外部 Embedding API。
- **落地机制**：
  - 用纯 TypeScript 维护轻量「实体-别名-共现/关系邻接表」+ 本地 BM25 词项索引（中英文双字 n-gram + 英文词干 + 角色/世界书实体别名表）；
  - 每轮从最近 2 轮对话提取种子实体，在邻接表上跑 **2 轮幂迭代 Personalized PageRank（< 2ms）**，把直接命中与 1–2 跳强关联的 Lore、事实、伏笔按综合分 + `priority` 精准拉出。

### 7. CoDi / Open-Theatre / Dramamancer（2025–2026）— 轻量导演层与张力节奏控制
- **来源**：*CoDi*、*Open-Theatre*、*Dramamancer (Storylets)*
- **核心发现**：无引导的纯自由对话很容易陷入无意义的日常死循环或平淡水字数；而强硬轨道化又毁掉玩家自由度。
- **落地机制**：
  - 可选开启轻量 **Director Pacing（张力与节奏提示）**（默认低侵入，对日常治愈卡自动保持温柔低张力，对冒险/悬疑卡通过 **Progress Clocks 进度时钟** 驱动自然升级，不强行按头走剧本）。

### 8. Agentopia（2026）— 多时间尺度仿真
- **来源**：*Agentopia: Long-Term Multi-Agent Life Simulation (2026)*
- **落地机制**：
  - **微观节拍（Micro Beat）**：单轮场景内互动（几秒～几分钟）；
  - **宏观进度时钟（Macro Progress Clocks）**：类似《暗影之刃 / Blades in the Dark》的 `k / N` 格进度条（例如 `城卫警觉 2/4`、`好感突破 4/6`、`暴雨倒计时 3/5`）；
  - **幕间蒙太奇（Inter-Act Montage）**：支持跳时间（几天/数月/数年），自动触发记忆归并（MemScene）、时钟结算与时代推进。

### 9. D&D Agents / D20bench + Manus Context Engineering & Chroma Context Rot
- **来源**：*D&D Agents (NeurIPS)*、*D20bench*、*Chroma Context Rot*、*Manus Context Engineering*
- **落地机制**：
  - **规则真值归代码**：掷骰、物品消耗、冷却、数值上下界全部代码校验，杜绝 LLM 凭空变道具或偷偷改血量；
  - **三区 KV-Cache 铁律**：Zone 1 永不突变 + 工具表静态不变 + Zone 2 严格 Append-Only + Zone 3 瞬态尾部拼接且不入历史 + 确定性 JSON 键序序列化。

---

## 三、核心架构总览图

```text
╔══════════════════════════════════════════════════════════════════════════╗
║                       pi-rp-engine (标准 Pi 扩展)                        ║
╠══════════════════════════════════════════════════════════════════════════╣
║  [导入与编译层]  PNG(ccv3/chara) · .charx(ZIP+assets) · JSON Lorebook    ║
║      │  ① 前端壳外科剥离 (HTML/CSS/JS/iframe/MVU渲染/Web资产)            ║
║      │  ② 100% 完整保留 mes_example / system_prompt / post_history / 破甲 ║
║      │  ③ 仅合并完全重复的防越权套话 + 提取 MVU 变量 Schema              ║
║      ▼                                                                   ║
║  ┌──────────────────┐  ┌─────────────────────────┐  ┌─────────────────┐ ║
║  │ L0 冻结圣典层     │  │ L1 确定性世界引擎        │  │ L2 门禁记忆与    │ ║
║  │ (项目/卡静态文件) │  │ (Pi 会话树 rp:tx 事件溯源)│  │    图谱检索层    │ ║
║  │ • 引擎极简协议    │  │ • 多尺度世界时钟/进度钟  │  │ • 编译后世界书   │ ║
║  │ • system_prompt  │  │ • CFSM/CPFSM 状态机      │  │ • 物理门禁过滤   │ ║
║  │ • 角色核心设定    │  │ • 背包/数值/关系账本     │  │ • 双时态事实库   │ ║
║  │ • 完整mes_example│  │ • EraGate 时代里程碑锁   │  │ • DREAM 信念边   │ ║
║  │ • 蓝灯常驻世界书  │  │ • sticky/cooldown 计数   │  │ • Foresight 伏笔 │ ║
║  └────────┬─────────┘  └───────────┬─────────────┘  │ • 本地BM25+PPR图 │ ║
║           │                        │                └────────┬────────┘ ║
║           ▼                        ▼                         ▼          ║
║  ┌───────────────────────────────────────────────────────────────────┐  ║
║  │                三区 KV-Cache 零击穿上下文装配器                     │  ║
║  │  [Zone 1: before_agent_start 冻结前缀 — ~100% KV Cache 命中]       │  ║
║  │  [Zone 2: Append-Only 干净对话流 — 永不篡改历史，幕间再压缩]       │  ║
║  │  [Zone 3: context 钩子瞬态尾部帧 — 仅挂本次请求末，绝不落盘进历史] │  ║
║  │           = 实时HUD + Top-K有效事实/世界书 + 伏笔 + 尾注/depth      │  ║
║  └───────────────────────────────────────────────────────────────────┘  ║
║                                    │                                    ║
║  ┌─────────────────────────────────┴─────────────────────────────────┐  ║
║  │   100% 官方 Pi ExtensionUIContext（桌面 TUI & pi-android 1:1 通用）│  ║
║  │   setStatus · setWidget · custom · select · registerToolRenderer   │  ║
║  └───────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════════╝
```

---

## 四、双轨低延迟运行闭环（保住 RP 的文笔流畅度与首字速度）

RP 最大的体验杀手是“每说一句话模型都要先调 3 个工具，等 10 秒才吐第一个字”。因此采用 **「回合前零延迟推 + 回合中按需拉 + 回合后轻量结算」**：

1. **Pre-Turn（`context` 钩子，纯本地 TS，耗时 < 5ms，0 额外 LLM 调用）**
   - 从当前分支重放/读取缓存的 L1 世界状态快照；
   - 执行「物理门禁过滤 → sticky/cooldown 判定 → 关键词/布尔逻辑 + 本地 BM25 + 2 跳 PPR 实体图谱召回 → Token 预算裁剪」；
   - 组装 **Zone 3 瞬态尾部帧** 附在本次最后一条用户消息后（绝不改写历史消息）；
   - 主模型**直接首字流式输出正文**，零多余停顿。
2. **Mid-Turn（按需 Pull，仅关键节点触发）**
   - 仅当需要硬核检定（真随机掷骰）、深挖冷门历史档案、或立即落地重大物品/时代变迁时，主模型调用静态工具集（`rp_recall` / `rp_roll_check` / `rp_state_patch` / `rp_fact_commit` / `rp_era_advance`）。
   - 常规纯对话/情感互动回合 **0 工具调用**，行云流水。
3. **Post-Turn（`turn_end` 确定性结算 + 可选轻量 Extractor）**
   - **必跑（0 耗时纯代码）**：递增微观节拍计数、推进 `sticky`/`cooldown`、检验纯数值/回合门禁、刷新 `setStatus` 与 `setWidget`；
   - **可选增强模式（`settlementMode` 三档可调）**：
     - `off`（纯代码 + 显式工具，零额外 token）；
     - `tool-assisted`（引导主模型在剧情发生实质变化时顺手调一次 `rp_state_patch` / `rp_fact_commit`，无额外模型请求）；
     - `sidecar-light`（异步/后置调用用户指定的廉价极速模型做极简 JSON 抽取：`binary_q` 状态跃迁 + 新事实/失效事实 + 伏笔登记，主叙事模型 100% 专注演戏）。


---

## 五、多 Agent vs 单主脑架构裁决与纯文字卡范式结论

### 1. 为什么默认坚决不采用「一角色一 Agent」的全量多 Agent 架构？
2025–2026 的交互式叙事与多 Agent 基准（*ToMATO*, *Decrypto*, ICML 2025 *Literal vs Functional ToM* 及大量生产复盘）给出非常一致的工程结论：

| 维度 | 全量多 Agent（导演 + 角色A + 角色B + 叙述者） | 单主脑 + 确定性引擎 + 按需隔离（本方案） |
| :--- | :--- | :--- |
| **首字延迟（手机体感）** | 串行多轮 LLM 调用，动辄 8–20s 才开始输出 | **单次 LLM 流式直出**，本地代码引擎耗时 < 5ms |
| **Token 成本与 KV Cache** | 每个角色维护独立上下文，Token 翻 N 倍且 Prefix Cache 几乎归零 | **Zone 1 冻结前缀 + Zone 2 仅追加**，Prefix Cache 命中率最大化 |
| **文笔连贯度与潜台词** | 受数据处理不等式制约，跨 Agent 摘要交接必然丢失情绪铺垫与文风统一性 | **统一执笔**，人物对手戏节奏、伏笔呼应与文风高度一致 |
| **信息不对称 / 盲推** | 天然隔离，但为 10% 场景让 90% 日常交互承受 4 倍慢与贵 | 仅在真正需要防上帝视角泄密时，通过 **`rp_npc_deliberate` 按需拉起单次视角隔离调用** |

### 2. 三档执行模型（兼顾极致流畅与硬核博弈）
1. **默认档（90% 日常扮演/群戏）**：1 个主 Agent 负责全部文风与同场多角色演技 + 纯 TypeScript 确定性引擎（CFSM、双时态事实账本、时代门禁、HippoRAG PPR 召回）。
2. **可选后台异步边车（`sidecar-light`，默认关）**：挂载在 Pi 1.6.1 的 **`agent_settled`** 钩子——主模型流式输出完全结束后才在后台用 `ctx.modelRegistry.complete()` 跑一次极便宜轻量模型抽取事实与推进幕后势力时钟，**对当前回合首字延迟为 0**。
3. **可选按需隔离思考工具（`rp_npc_deliberate`）**：当进入密室推理、阵营谍战、反派暗算等强信息不对称节点时，主脑或玩家可触发该工具：代码引擎仅截取「该 NPC 认知可见（Epistemic Filter）」的记忆子集，通过 `ctx.modelRegistry.complete()` 执行一次无历史污染的短上下文思考，只返回该 NPC 的秘密决策/意图，再交回主脑统一演绎。

### 3. 为什么「纯文字卡」才是新时代 Agent 引擎的最佳拍档？
- **重度前端卡是 1.0 时代的畸形补丁**：酒馆缺乏原生状态机与 UI 扩展框架，迫使作者把 HTML/CSS/JS、`JS-Slash-Runner` 与数千 Token 的格式教条塞进 Prompt，既严重消耗上下文、拉低模型文笔与推理智商，又把业务逻辑死耦在浏览器 DOM 中。
- **纯文字卡 + 新时代引擎 = 彻底解耦**：纯文字卡 100% Token 服务于人设、对话示例（`mes_example`）、文风与世界观；数值、物品、好感、进度时钟和状态面板全部由代码引擎接管，通过 Pi 官方通用扩展 UI 稳定渲染——**永不崩格式、不污染历史上下文、释放 100% 模型文笔**。
- **中度前端卡（纯文字 + HTML 状态栏/MVU 变量表）**：剥离前端壳、抢救变量 Schema 转入原生引擎后，实际体验会显著优于原版酒馆；而把聊天框改造成 H5 点击小游戏的重度前端卡则明确标记为不兼容。


---

## 六、2026 下半年最新前沿论文增补与通用抽取/防停滞演进

在前述 9 大理论支柱基础上，结合 2026 年 3 月至 11 月角色扮演 Agent 与互动叙事领域的最新论文，引擎进一步补齐了**全卡型自适应三层抽取（L0/L1/L2）**、**列表优先认知边界隔离**、**防剧情停滞控制**与**记忆到决策长程推理**：

### 10. ReverieMem & The Curse of Knowledge — 视角受限三层记忆与「列表优先」防泄密（2026.06 / 2026.10）
- **来源**：
  - *Staying In Character: Role-Playing Agents with Perspective-Bounded Memory (ReverieMem)* ([arXiv:2606.25632](https://arxiv.org/abs/2606.25632), Jun 2026)
  - *The Curse of Knowledge in Role-Playing Language Models* ([arXiv:2610.17327](https://arxiv.org/pdf/2610.17327), Oct 2026)
- **核心发现**：
  - ReverieMem 将角色记忆拆为第一人称情景层、可见性标记语义层与情境化人格层，在 KBF-QA（4,386 题）上将知识边界保真度提升 **+34.6 个百分点**，并在 BookWorld 对决中取得 **78.86%** 胜率。
  - *The Curse of Knowledge* 证明：输入格式与**列表优先的视角过滤（List-First Character View）**对防止角色说出“不可能知道的事实”起决定性作用。
- **落地机制**：
  - Zone 3 盲区提示升级为列表优先隔离格式（`- [HIDDEN FROM: NPC] <fact>`）；
  - `/rp panel` 双时态事实编辑器支持直接录入「公开事实 / 私密事实（指定知情者 `witnessIds`）」。

### 11. SKT Tri-Agent Epistemic Pacing — 结构化知识树与认知节奏门禁（2026.09）
- **来源**：*Enforcing Narrative Reliability and Epistemic Pacing in LLM-Driven Detective Games* ([arXiv:2609.23043v1](https://arxiv.org/html/2609.23043v1), Sep 2026)
- **核心发现**：将故事前置条件编码为结构化知识树（SKT）并把“逻辑检索 / 表演生成 / 事实验证”解耦，可在悬疑与多幕剧情中彻底杜绝提前剧透与过早招供。
- **落地机制**：
  - `/rp analyze`（L1 一次性建档）自动扫描世界书条目，为后期真相/剧透条目生成可审核的 `GateCondition` 并永久缓存至 `card.compiled.json`。

### 12. NARRA-Gym & SENSE — 防剧情停滞控制与多轨情绪节奏导航（2026.05 / 2026.10）
- **来源**：
  - *NARRA-Gym for Evaluating Interactive Narrative Agents* ([arXiv:2605.08503v1](https://arxiv.org/html/2605.08503v1), May 2026)
  - *SENSE: State-aware Emotion Navigation Storytelling Engine* ([arXiv:2610.07666](https://arxiv.org/abs/2610.07666), Oct 2026)
- **核心发现**：纯自由对话长程极易陷入原地打转（Stagnation）；将状态感知、防停滞控制（Anti-Stagnation Control）与情绪/张力轨迹解耦到外部引擎可显著改善长程体验。
- **落地机制**：
  - `Alt+P` 一键循环切换叙事节奏（`relaxed` / `balanced` / `dramatic`）；
  - 对非陪伴/非日常卡在均衡模式下每 5 轮自动在 Zone 3 注入极轻量防停滞提示，陪伴与日常治愈卡保持 0 侵入。

### 13. MemRole & MRPrompt/MREval — 从记忆到长程决策与分阶段记忆利用（2026.03 / 2026.11）
- **来源**：
  - *MemRole: From Memories to Decisions for Long-Horizon Reasoning in Role-Playing Agents* ([arXiv:2611.01778](https://arxiv.org/html/2611.01778), Nov 2026)
  - *Memory-Driven Role-Playing: Evaluation and Enhancement of Long-Term Memory* ([ACL 2026 Findings](https://aclanthology.org/2026.findings-acl.1175.pdf) / [arXiv:2603.19313v1](https://arxiv.org/html/2603.19313v1), Mar 2026)
- **核心发现**：单纯把旧片段塞进上下文不足以支撑角色做出一致的长程决策；需要把历史事件按角色视角与时间线组织，并在关键决策点显式激活相关信念与记忆（LHMT / MRPrompt）。
- **落地机制**：
  - 结合 `DREAM ABC` 信念边与 `CFSM` 心态轴，在 Zone 3 中优先排序在场 NPC 的最新信念与状态，并用 `/rp recap` 提供 0-Token 瞬时局势前情提要。

### 14. 全卡型通用三层抽取体系（L0 / L1 / L2）与无硬编码时空语义
- **来源参考**：*Reconstructing Persistent Worlds from Narratives* ([arXiv:2608.04037](https://arxiv.org/html/2608.04037), Aug 2026)、*MemTX* ([arXiv:2607.23929v2](https://arxiv.org/html/2607.23929v2), Jul 2026)、*Mem0 State of AI Agent Memory 2026* ([Mem0 Blog](https://mem0.ai/blog/state-of-ai-agent-memory-2026))
- **落地机制**：
  - **彻底移除硬编码 `Act I` / `Day 1`**：只有当角色卡本身或剧情显式声明阶段/时间时才在状态栏与 `<rp_state_frame>` 展示；
  - **L0（0ms, 0 Token）**：导入时确定性提取纯文字卡中的显式锚点（地点/时间/阶段）与有界数值，并自动推断卡型（`CardArchetype`）与模块开关（`WorldProfileModules`）；
  - **L1（`/rp analyze`, 1 次 LLM 调用永久缓存）**：通过 Pi 官方 `ctx.modelRegistry.streamSimple().result()` 提取完整世界画像、实体别名（反哺世界书 PPR 召回）与建议防剧透门禁；
  - **L2（`sidecar-light` 闭环结算）**：回合后将现行事实 ID 喂给边车模型，实现非破坏性旧事实失效（`invalidatedFactIds`）、时空锚点刷新与按模块门控的数值/物品/时钟更新。
