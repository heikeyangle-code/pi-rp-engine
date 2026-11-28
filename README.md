<div align="center">

<h1>Tavern Next</h1>

<p><b>为纯文字长篇文游而生的下一代 AI 角色扮演引擎</b></p>

<p>
  兼容 SillyTavern 存量 V1 / V2 / V3 / <code>.charx</code> 角色卡、世界书与预设。<br>
  <b>让大模型专心当作家，让确定性代码接管规则、记忆与世界演化</b>——彻底告别酒馆 1.0 时代的状态栏崩坏、缓存碎裂、AI 抢戏与手机端卡顿。
</p>

<p>
  <a href="https://github.com/heikeyangle-code/pi-android"><img alt="手机端最佳拍档" src="https://img.shields.io/badge/%E6%89%8B%E6%9C%BA%E7%AB%AF%E6%9C%80%E4%BD%B3%E6%8B%8D%E6%A1%A3-Pi%20for%20Android-2563EB?style=flat-square&logo=android&logoColor=white&labelColor=0F172A"></a>
  <img alt="角色卡兼容" src="https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E5%8D%A1-V1%20%7C%20V2%20%7C%20V3%20%7C%20CHARX-2563EB?style=flat-square&labelColor=0F172A">
  <img alt="Pi 扩展" src="https://img.shields.io/badge/Pi%20SDK-v1.7%2B-2563EB?style=flat-square&labelColor=0F172A">
  <img alt="零第三方依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E4%BE%9D%E8%B5%96-Zero%20Deps-059669?style=flat-square&labelColor=0F172A">
  <img alt="测试通过" src="https://img.shields.io/badge/%E8%87%AA%E5%8A%A8%E5%8C%96%E6%B5%8B%E8%AF%95-69%20Passing-059669?style=flat-square&labelColor=0F172A">
  <img alt="许可证 MIT" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-475569?style=flat-square&labelColor=0F172A">
</p>

<p>
  <a href="#第一阶段--3-分钟上手小白直接看这里"><b>3 分钟上手</b></a> ·
  <a href="#第二阶段--为什么玩起来像顶级文游">核心体验</a> ·
  <a href="#第三阶段--新时代对比酒馆-10-vs-agent-项目-vs-tavern-next">架构对比</a> ·
  <a href="#第四阶段--硬核工程与学术架构拆解">硬核拆解</a>
</p>

</div>

> **📱 手机玩家强烈推荐配套客户端：[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)**
>
> 免 Root、免 Termux、免折腾本地服务器，Android 本机直接跑。`Tavern Next` 的全部交互都围绕 `Pi for Android` 做了原生触控打磨——**扩展中心 9 枚一键快捷胶囊 + 5 分区 Material 底部弹窗 + 36–44 列窄屏专属状态栏**，整局玩下来**不用手打一行斜杠命令**，单手就能顺滑推完百轮长篇。

---

## 第一阶段 · 3 分钟上手（小白直接看这里）

### 方式一：手机端直接玩（推荐）

1. 安装配套 Android 客户端：**[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)**。
2. 打开 App，把本仓库链接发给 AI，让它自动安装并启用：
   > 请帮我安装并启用这个角色扮演扩展：`https://github.com/heikeyangle-code/tavern-next`
3. 装好后点开「扩展中心 → **主菜单**」（或发一句 `/rp`），内置文件选择器会自动扫描手机下载目录里的 `.png`、`.charx`、`.json` 角色卡、世界书与预设，点一下即可开玩。

### 方式二：电脑端使用

如果你已在电脑上安装 [Pi CLI](https://github.com/earendil-works/pi)，一行命令克隆到扩展目录并 `/reload` 即可：

```bash
git clone https://github.com/heikeyangle-code/tavern-next.git ~/.pi/agent/extensions/tavern-next
```

输入 `/rp` 打开启动器，或用 `pi --rp-card <card-slug>` 单会话直启指定角色卡。

### 新手最关心的 3 个问题（大白话版）

- **1. 手机上要记一堆命令和快捷键吗？**
  完全不用。在 `Pi for Android` 的「扩展中心」里，引擎只保留了 **9 枚最高频的一键胶囊**（刚好排成 3×3：`主菜单`、`世界面板`、`快捷回复`、`重摇回复`、`局部改写`、`续写剧情`、`代写回复`、`场外提问`、`导演指令`）；其余全部功能收在 **5 分区原生世界面板**里，点选即用、随时一键撤销误操作。
- **2. 纯文字卡没有变量怎么办？必须建档吗？**
  **不强制建档，默认秒开。**
  - 卡里自带 MVU/YAML/HTML 状态栏或明写着 `好感度：20/100` 的，导入时（`<2ms`、0 Token）自动无损打捞变量。
  - 纯文字日常卡不硬造数值，直接秒进剧情；如果你打算长线深玩一张 100+ 条世界书的宏大纯文字卡，导入时会问你一次要不要点 **「AI 深度建档」**——跑一次就永久缓存到本地，一次性挖出隐藏秘密、防剧透门禁、角色心态轴和声线锚点，以后再开这张卡同样秒开。
- **3. 我只用一个主模型，还是需要额外配便宜小模型？**
  **怎么用都顺手，系统自动适配：**
  - **只挂单个主模型（默认）**：自动走 `tool-assisted`（工具实时控账），**0 额外后台 API 调用**，主模型边写边记账且仅携带精简工具集。
  - **配了便宜快的后台小模型**（如 Flash / Mini）：自动切为 `sidecar-light`（纯文学优先 + 后台异步记账），主模型专心写小说、首字秒出，记账全部在后台静默完成。随时可在「世界面板 → 5. 导演与设置 → 记账模式」一键切换。

---

## 第二阶段 · 为什么玩起来像“顶级文游”？

传统 AI 跑团和酒馆玩到第 20 轮以后，最让人出戏的无非七件事：**AI 替你说话抢戏、角色三句话秒软变舔狗、满屏“眼底闪过一丝/臭氧味”AI 味套话、群聊变成礼貌电话会议、聊着聊着忘记受伤换装、跨年时间线算错乱、以及回溯分叉后账本全乱。**

`Tavern Next` 把这些痛点逐一拆进了底层机制里：

- **🛡️ 防抢戏守卫（默认开启）**：严格锁定玩家能动性，禁止模型替你写台词、心理活动或替你做决定性动作，每轮留足互动空间。
- **🧊 反顺从阻力（告别“秒爱/无冲突”）**：角色处于戒备、冷淡、敌对心态或负好感时，引擎自动施加阻力提示——拒绝模型天生的讨好惯性，必须靠真实筹码或剧情推进才能破冰。
- **🔦 多角色聚光灯调度**：群像/同场共演场景下，结合角色 `talkativeness` 权重自动指定当轮 1–2 名焦点角色，告别“所有 NPC 排排坐轮流发言”的僵硬感。
- **🧹 动态反套话（Runtime SlopTracker）**：不靠容易触发“粉红大象效应”的死板词表，而是实时监测**当前会话近几轮真正在复读的句式与陈词**，只在超标时精准提醒避让。
- **⏳ 代码级历法与寿命守卫（幕间世界推演）**：跳时间（如“十年后”“跳到康熙五十三年”）时，由确定性代码推算公历、明清年号与虚构星历，并根据世界观寿命配置自动提醒角色衰老/代际更替，顺带在后台推演离场 NPC 日程与势力暗流。
- **✍️ 全套零污染创作辅助**：
  - **帮我代写（`/rp imp`）** & **行动建议（`/rp act`）**：隔离生成草稿直接填入输入框，不污染聊天记录；
  - **场外提问（`/rp ask`）** & **行内 `((OOC))`**：随时查心理、问设定、纠偏走向，回答完自动对后续正文隐身；
  - **定向分叉重摇 & 局部改写**：旧版本完整保留在会话树中，改写后的楼层无损替换、随时可找回；
  - **纯净小说导出 & 可移植世界存档**：一键导出不含 OOC 与系统提示的纯净 Markdown 小说，或将整局世界状态（记忆书、事实、好感、背包、时钟、伏笔）导出为 `.rp-save.json`，百轮长篇随时无损迁移到新会话。

---

## 第三阶段 · 新时代对比：酒馆 1.0 vs Agent 项目 vs Tavern Next

我们确实已经走出“纯文本拼接”的酒馆 1.0 时代了。但新时代的路线分化很严重——下表把不同路线的**真实优势与各自代价**摊开讲清楚：

| 维度 | 传统酒馆 1.0<br>（SillyTavern 等） | 多 Agent / 云端 AI RPG<br>（Friends & Fables / Craft / 多 Agent 编排） | 外置向量 RAG 插件<br>（Chroma / 向量记忆扩展） | **Tavern Next** |
| :--- | :--- | :--- | :--- | :--- |
| **状态与数值管理** | 靠 Prompt 逼模型手吐 `<status>` / HTML 状态栏，聊久了极易崩格式 | 专用后端或代码规则引擎强管控，往往绑定特定规则体系（如 5e） | 只负责检索文本片段，无法管理确定性数值、背包与状态机 | **代码确定性事件溯源（`rp:tx`）+ 双极数值 + CFSM 状态机 + 同义键归并**，兼容任意世界观 |
| **文笔与延迟** | 单次请求，但巨型 Mega-Preset 与历史残留代码严重稀释文风 | 多 Agent 串行调用导致首字慢、Token 翻倍，易丢失统一文学质感 | 单次主调用，但检索噪声容易把旧片段硬塞进上下文 | **单主脑统一执笔 + 自适应双轨结算**，正文永远干净纯文字，零 HTML/状态栏污染 |
| **Prompt Caching（省钱与提速）** | 动态世界书插在历史中部，极易反复击穿前缀缓存 | 多角色独立上下文，跨轮前缀缓存命中率极低 | 动态召回位置不固定，缓存命中不稳定 | **三区字节冻结（Zone 1 零改动 + Zone 2 追加历史 + Zone 3 瞬态尾帧）**，实测高连击命中 |
| **回溯 / 分叉一致性** | 切分支或重摇后，外部状态栏与剧情经常脱节错位 | 多数平台不支持自由树状分叉，或需要付费点数 | 向量库与对话分支脱节，删楼层后旧向量残留造成“幽灵记忆” | **原生挂载 Pi Session Tree DAG**，任何回溯、分叉、撤销均 100% 确定性重放还原 |
| **手机端与部署门槛** | 桌面 Web 架构硬套小屏，长对话易卡顿，需自建后端或 Termux | 商业 SaaS 开箱即用，但按月订阅、闭源且数据不归自己 | 需额外维护向量数据库与 Embedding API | **本地优先 + BYOK + 零外部依赖**，搭配 `Pi for Android` 原生触控开箱即用 |

### 诚实说明：Tavern Next 的边界与取舍

我们不画大饼，明确告诉你**什么不是我们的目标**：
- **不运行浏览器前端小游戏**：导入角色卡时默认清洗 `<script>`、`<style>`、`<iframe>`、内联 HTML 状态栏和 `live2d`/`vrm` 等 Web 壳（100% 原样保留 `description`、`personality`、`scenario`、`mes_example`、世界书与有效正则；随时可切原味直通）。如果一张卡的乐趣本身是内嵌 Vue/Canvas 网页点击小游戏，它更适合桌面浏览器酒馆。
- **不绑定闭源云端与生图/配音全家桶**：核心只做一件事——把**纯文字互动叙事的文笔、记忆、逻辑一致性和手机端手感**推到极致。

---

## 第四阶段 · 硬核工程与学术架构拆解

如果你是开发者或重度技术玩家，下面对应仓库里每一层真实代码与 2024–2026 顶会论文落地（全库 **0 第三方运行时依赖**、**69 项自动化测试全绿**）。

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Zone 1 · 冻结前缀 (before_agent_start · SHA-256 校验字节级恒定 · 满载 KV-Cache) │
│  协议(与激活工具集同步) + 预设前段 + 卡面设定 + 100% 原样 mes_example + 常驻世界书   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Zone 2 · Append-Only 纯净历史流 (绝不篡改旧消息 · 隐藏楼层/OOC 非破坏性过滤)      │
│  [开场白] → [玩家1] → [叙事1] → ... → [玩家N]   (所有状态更新仅存为隐藏 rp:tx 节点) │
├─────────────────────────────────────────────────────────────────────────────┤
│  Zone 3 · 瞬态尾部帧 (context 钩子发完即丢 · 永不落盘 · 硬预算 ≤ 2,200–3,600 tok)  │
│  状态快照 | 物理场景 | 2-hop PPR 召回世界书+记忆书 | 双时态事实+认知盲区 | 导演指令  │
└─────────────────────────────────────────────────────────────────────────────┘
```

<details>
<summary><b>1. 学术论文落地映射（为什么这样设计？）</b></summary>

- **确定性状态机优于 LLM 记账**：[Don't Ask the LLM to Track Freshness (2026)](https://arxiv.org/html/2606.01435v1) 实证表明，靠 LLM 判断事实新旧（Zep 7%、Mem0 18%、HippoRAG 2 54%）远逊于确定性代码排序；[CFSM (ICLR 2026)](https://arxiv.org/html/2602.05905v1) 证明开局提取显式状态机 + 代码校验流转比每轮 CoT 推理快 25 倍且零幻觉。对应 `src/engine/state-replay.ts`、`src/engine/cfsm.ts`、`src/memory/bitemporal.ts`。
- **生成与结构化提取解耦**：[OpenReview 2025](https://openreview.net/forum?id=vYkz5tzzjV) 与 [arXiv 2607.18476 (2026)](https://arxiv.org/abs/2607.18476) 量化了结构化约束对创意（-17% ~ -26%）和多样性的折损。因此我们在 `sidecar-light` 模式下彻底剥离写工具，在 `tool-assisted` 模式下精简 Schema 并移除低频/伪隔离工具。
- **长上下文腐化与短距聚焦**：[EMNLP 2025 Findings](https://arxiv.org/abs/2510.05381) 证明即便完美检索，线性 Token 距离拉长本身也会导致性能骤降；[Prompting Against Persona Drift (2026)](https://arxiv.org/abs/2609.24532) 证明尾部定向微调比重复粘贴整卡更有效。对应 Zone 3 硬预算收紧与定向导演指令。
- **反八股气球效应与反派崩塌**：依据 [Character-Name Concentration (2026)](https://arxiv.org/pdf/2611.01284) 用会话级动态 `SlopTracker` 替代死板黑名单；依据 [Too Good to be Bad (2025)](https://arxiv.org/abs/2511.04962) 为戒备/敌对/负好感角色注入显式反顺从阻力。
- **认知盲区与统一图谱召回**：依据 [FANToM](https://arxiv.org/abs/2310.15421) / [DToM-Track (2026)](https://arxiv.org/abs/2603.14646) 按见证者列表生成 `HIDDEN FROM` 隔离；依据 [HippoRAG 2 (2025)](https://arxiv.org/abs/2502.14802) 在本地实体共现图上执行预索引 2-hop PPR 召回。

</details>

<details>
<summary><b>2. 核心子系统源码地图与工程加固细节</b></summary>

- **三区上下文与预算控制（`src/context/`）**：`zone-builder.ts` 实现确定性 FNV-1a 宏种子、Zone 1 工具协议同步、Zone 3 硬预算裁剪、蓝灯 `@D`（`position = 2/3/4`）常驻世界书注入与三层 X-Ray 校验；`token-budget.ts` 针对 CJK、假名、韩文与 Emoji 做精准估算。
- **状态引擎与 L0/L1/L2 管道（`src/engine/`、`src/parser/`）**：
  - `state-replay.ts`：单调自增审计 ID、防递归撤销、局部 `physical_patch` 非空合并、钳制型时钟/背包精准回滚；
  - `settlement.ts`：叶节点 CAS 并发防脏写、按卡型动态裁剪 Sidecar Schema、同义数值键自动归并、运行状态可观测；
  - `temporal.ts`：虚构历法优先匹配、明清年号表（含洪熙/天顺/泰昌）、中文逐位数字与绝对年份防误判；
  - `unpack.ts` / `lore-compiler.ts` / `macros.ts` / `sanitizer.ts` / `mvu-salvage.ts`：PNG/CHARX 解压真实字节上限防 OOM 炸弹、支持 `./card.json`、嵌套 ReDoS 精准防护、`$&`/`$100` 替换注入防护、平衡括号 `_.set` 与 JSON5 无损打捞。
- **本地记忆与检索（`src/memory/`）**：`bm25.ts`（支持 CJK + 假名 + 韩文 + 拉丁 + 停用词过滤）、`graph-ppr.ts`（WeakMap 静态预索引 + 32 位哈希互斥组加权 + 严格 `AND_ANY`/`AND_ALL` 门控）、`history-recall.ts`（严格对齐 `state.turn`）、`compaction.ts`（头尾预算优先保留最新剧情 + 清理 `<thought>` 与 Zone 3 标签）、`embedding.ts`（32 条分批请求 + LRU 缓存）。
- **Pi v1.7.0 契约与安全存储（`src/index.ts`、`src/tools/rp-tools.ts`、`src/storage/workspace-store.ts`）**：对齐 `turn_end`（`messageEntryId` / `outcome`）、`session_shutdown`、`session_compact` 两阶段记忆书落盘、多供应商 `before_provider_request` 采样映射、工具 `executionMode: "sequential"` 与 `readOnlyHint`、DeepSeek/vLLM 嵌套 `{"arguments":"{...}"}` 自动解包、两阶段原子校验提交、`rp_recall` 强制剧透门控，以及路径穿越隔离与临时文件原子 JSON 落盘。

</details>

<details>
<summary><b>3. 设计文档与本地测试命令</b></summary>

- [AGENTS.md — 移动端 `pi-android` 交互铁律与接手开发规范](AGENTS.md)
- [01 · 2025–2026 角色扮演与记忆领域研究索引及架构映射](docs/01-RESEARCH-AND-ARCHITECTURE.md)
- [02 · V1 / V2 / V3 / .charx 角色卡与世界书保真解析规范](docs/02-CARD-SPEC-AND-PARSER.md)
- [03 · 标准扩展生命周期设计与 API 对齐清单](docs/03-PI-EXTENSION-DESIGN.md)
- [04 · 8 大社区角色卡型兼容性矩阵与边界说明](docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md)

```bash
npm run typecheck   # TypeScript 严格类型检查
npm test            # 运行全部 69 项引擎、解析器、图谱召回与交互自动化测试
```

</details>

---

<p align="center">
  MIT License · 手机端最佳拍档：<a href="https://github.com/heikeyangle-code/pi-android"><b>Pi for Android (`heikeyangle-code/pi-android`)</b></a>
</p>
