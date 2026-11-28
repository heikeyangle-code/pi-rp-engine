<div align="center">

<h1>pi-rp-engine</h1>

<p><b>把 SillyTavern（酒馆）角色卡带入下一代 Agent 引擎：不炸状态栏、长聊不失忆、NPC 不穿帮、KV 缓存省一半钱。</b></p>

<p>
  基于官方 <a href="https://github.com/badlogic/pi-mono">Pi SDK</a> 打造的通用角色扮演与世界模拟扩展。<br>
  零第三方依赖 · 桌面端与手机端 1:1 通用 · 严格单会话生效，退出即恢复纯净编程助手。
</p>

<p>
  <a href="https://github.com/heikeyangle-code/pi-android"><img alt="推荐搭配 Pi for Android" src="https://img.shields.io/badge/%E6%8E%A8%E8%8D%90%E6%90%AD%E9%85%8D-Pi%20for%20Android-4B67B4?style=flat-square&logo=android&logoColor=white&labelColor=2B3245"></a>
  <img alt="零第三方依赖" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E4%BE%9D%E8%B5%96-Zero%20Deps-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="兼容 V1/V2/V3/CHARX" src="https://img.shields.io/badge/%E8%A7%92%E8%89%B2%E5%8D%A1-V1%20%7C%20V2%20%7C%20V3%20%7C%20CHARX-4B67B4?style=flat-square&labelColor=2B3245">
  <img alt="TypeScript ESM" src="https://img.shields.io/badge/TypeScript-ESM-4B67B4?style=flat-square&logo=typescript&logoColor=white&labelColor=2B3245">
  <img alt="License MIT" src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-4B67B4?style=flat-square&labelColor=2B3245">
</p>

<p>
  <a href="#怎么使用推荐手机一键开玩"><b>怎么使用（手机 1 分钟上手）</b></a> ·
  <a href="#为什么比传统酒馆强">对比传统酒馆</a> ·
  <a href="#核心亮点一眼看懂">核心亮点</a> ·
  <a href="#日常高频玩法与快捷键">常用玩法与快捷键</a> ·
  <a href="#硬核架构与-20252026-论文底座">底层架构</a>
</p>

</div>

<br>

## 为什么比传统酒馆强？

用过传统酒馆（SillyTavern）跑长篇剧情的人，大概率都踩过这几个坑：**聊到 30 轮开始失忆、好感度/血量算错、HTML 状态栏突然崩成乱码、配角莫名其妙知道主角背地里干的事、世界书每次插队把 Prompt 缓存全打碎（既慢又烧钱）。**

原因很简单：传统酒馆是 **1.0 纯文本拼接时代**的产物——既要让大模型演戏写文笔，又要逼它顺便当算盘、管背包、画前端网页。

`pi-rp-engine` 把这两件事彻底拆开：**代码管真值与记忆，大模型 100% 专心演戏和写文笔。**

| 你最在意的体验 | 传统酒馆（SillyTavern 1.0） | `pi-rp-engine`（下一代 Agent 引擎） |
| :--- | :--- | :--- |
| **数值 / 背包 / 状态栏** | 靠 Prompt 逼模型吐 `<status>` 或大段 HTML，聊久了必崩格式，聊天记录堆满废代码 | **确定性代码引擎接管**：数值上下界、背包增减、进度时钟、真随机掷骰全由代码校验，正文永远干干净净 |
| **长对话记忆与世界书** | 简单关键词匹配，说“他/那把剑”就漏触发，旧设定和新剧情互相打架 | **双时态事实账本 + 本地 2 跳实体图谱（HippoRAG PPR）+ 伏笔队列**：旧事实自动失效、关联设定自动联想，手机本地毫秒级运行 |
| **防剧透 / 防 NPC 全知穿帮** | 靠“请勿提前剧透”口头叮嘱，多轮必穿帮 | **物理门禁 + 视角认知隔离**：未到阶段的剧情与不在场 NPC 的盲区，在代码层物理拦截，根本不进模型上下文 |
| **速度与 Token 费用** | 世界书和状态块插在历史中间，改 1 个字就让整段 KV Cache 失效 | **三区零碎裂缓存架构**：冻结前缀 + 纯追加历史 + 瞬态尾部状态帧，长篇对话前缀缓存命中率拉满，又快又省钱 |
| **重摇 / 回溯 / 分叉剧情** | 聊天记录和外置变量各管各的，回退一下数值就错乱 | **寄生在 Pi 原生会话树（DAG）**：回溯、分叉、重摇（Swipe）时，所有数值、背包、事实、伏笔 **100% 同步精准还原** |
| **手机端体验** | 需要电脑开服务 / 折腾 Termux / 浏览器小屏难操作 | **配合 [Pi for Android](https://github.com/heikeyangle-code/pi-android) 本机直跑**：发个仓库链接让 AI 自己装好，直接扫描手机下载目录导入角色卡开玩 |

<br>

---

## 怎么使用（推荐手机一键开玩）

### 方式一：手机端零折腾（强烈推荐 · 搭配 Pi for Android）

不需要电脑、不需要配环境、不用记复杂命令：

1. **安装手机端 App**：前往我的另一个开源项目 **[Pi for Android (`heikeyangle-code/pi-android`)](https://github.com/heikeyangle-code/pi-android)** 下载并安装 Android 客户端（内置完整 Pi 运行环境，免 Root、免 Termux）。
2. **一句话让 AI 自动安装本扩展**：打开 App，把本仓库链接直接发给 AI：
   > 帮我安装并启用这个 Pi 扩展：`https://github.com/heikeyangle-code/pi-rp-engine`
3. **导入角色卡，直接开玩**：
   - 输入 `/rp`（或 `/rp import`），内置文件浏览器会**自动扫描手机下载目录**里的 `.png`、`.charx`、`.json` 文件，自动识别 `[角色卡 V3]`、`[世界书]`、`[酒馆预设]`，点一下即可导入并开局；
   - 玩完输入 `/rp exit`，当前会话瞬间清空 RP 状态，**绝不污染你的其他普通聊天或编程会话**。

### 方式二：电脑端 Pi CLI / TUI

如果你已在电脑上使用官方 Pi（`@earendil-works/pi-coding-agent` 1.6.1+）：

```bash
# 克隆到 Pi 全局扩展目录
git clone https://github.com/heikeyangle-code/pi-rp-engine.git ~/.pi/agent/extensions/pi-rp-engine
```

进入 Pi 后执行 `/reload`，按 **`Alt+R`** 或输入 **`/rp`** 即可打开启动器。

<br>

---

## 核心亮点，一眼看懂

### 1. 所有存量酒馆卡直接导入，绝不阉割灵魂
- **全格式通吃**：直接读取 PNG（优先 `ccv3` 块）、`.charx`（ZIP 资源包 + 安全路径校验）、V1/V2/V3 JSON、独立世界书、酒馆预设（Preset）与 `AI_OUTPUT` 展示正则。
- **100% 保真红线**：`mes_example`（对话示例）、`description`、`personality`、`scenario`、`system_prompt`、`post_history_instructions`、`depth_prompt` **一字不删、绝不做任何内容阉割**；只做外科式剥离 1.0 时代无用的 `<script>` / `<style>` / 嵌套 HTML 状态栏壳，并顺手把 MVU / YAML 数值变量打捞进原生引擎（也随时支持 `/rp raw` 一键原味直通）。

### 2. 纯文字卡也能智能提取，不再满屏尴尬的 `Act I · Day 1`
- **自适应时空语义**：陪伴/日常卡不会强行显示 `Act I · Day 1`，只有角色卡本身或剧情推进定义了阶段与时间时才展示。
- **三层智能抽取（L0 / L1 / L2）**：
  - **L0（0 耗时、0 Token）**：导入时自动识别卡型（陪伴/日常/沙盒/悬疑/史诗/群像）、提取纯文本里的显式地点/时间/阶段与数值；
  - **L1（`/rp analyze` 一键建档，永久缓存）**：用 1 次模型调用深度读懂角色卡与世界书，自动提炼初始物品、心态轴（CFSM）、实体别名（反哺世界书联想）与防剧透门禁，缓存后每次新开局 0 Token 复用；
  - **L2（可选后台边车 `sidecar-light`）**：回合结束后后台静默提炼新事实、作废过时旧事实、刷新场景与人物信念，**不影响首字输出速度**。

### 3. 手机与电脑都顺手的原生交互
- **行内 `((OOC))` 零摩擦讨论**：聊天框里直接打 `((问一下角色现在真实想法))` 或 `（（...））`，自动进入场外 OOC 讨论，不推进剧情、不走时钟。
- **实时世界面板（`/rp panel`）**：数值条、背包一键 `+1/-1`、地点与在场 NPC、阶段与时间、角色心态轴（CFSM）、300+ 条世界书搜索分页开关、公开/私密事实录入、进度时钟与伏笔管理、实时上下文占比全在一处搞定。
- **可读的 `/tree` 会话树**：所有世界状态变更在 Pi 原生 `/tree` 里都渲染成直观中文事件标签，回溯分叉一目了然。
- **严格单会话存活 & 彻底干净退出**：角色卡存进库里只是静态素材，**绝不会让其他编程会话误入 RP 模式**；输入 `/rp exit` 或按 `Alt+Shift+X` 一键清零 HUD、恢复原有编程工具。

<br>

---

## 日常高频玩法与快捷键

> 所有 14 个快捷键均避开终端保留键位，桌面端与手机外接键盘通用；在未开启 RP 的普通会话中除 `Alt+R` 外完全静默。

| 快捷键 | 功能 | 对应命令 |
| :--- | :--- | :--- |
| **`Alt+R`** | 打开 RP 主菜单 / 启动器 | `/rp` |
| **`Ctrl+Shift+R`** | 打开实时世界面板（数值/背包/CFSM/世界书搜索/事实/伏笔） | `/rp panel` |
| **`Alt+W`** | **重摇上一条回复（Swipe）**，支持附带微调提示，旧版本保留在 `/tree` | `/rp reroll` |
| **`Alt+K`** | 让角色无缝续写剧情 | `/rp continue` |
| **`Alt+A`** | 生成 3 个贴合当下情境的行动建议 | `/rp act` |
| **`Alt+N`** | 管理导演指令与常用模板（不破坏缓存） | `/rp note` |
| **`Alt+P`** | 一键循环切换叙事节奏（舒缓 → 均衡 → 紧张） | `/rp pace` |
| **`Alt+O`** | 发起场外 OOC 讨论（也可直接输入 `((内容))`） | `/rp ooc` |
| **`Alt+G`** | 快捷掷骰检定器（1d20 / 优势 / 劣势 / 百分骰 / 自定义 DC） | `/rp roll` |
| **`Alt+T`** | 跳过时间 / 幕间蒙太奇 | `/rp skip` |
| **`Alt+B`** | 保存当前剧情节点书签 | `/rp save` |
| **`Alt+J`** | 回溯或分叉至已有书签 | `/rp goto` |
| **`Alt+H`** | 循环切换 HUD 状态栏（极简 → 完整 → 隐藏） | `/rp hud` |
| **`Alt+Shift+X`** | 确认后彻底退出当前会话 RP 模式 | `/rp exit` |

其他常用命令：`/rp import`（交互式扫描导入）、`/rp load`（选卡开局）、`/rp analyze`（一键 AI 智能建档）、`/rp recap`（0 Token 瞬时前情提要）、`/rp cast`（多角色同场共演）、`/rp hide` / `/rp unhide`（非破坏性隐藏楼层）。

<br>

---

## 硬核架构与 2025–2026 论文底座

如果你关心引擎为什么能做到「零外部向量库、手机本地毫秒级、长程不崩」，本项目的核心机制直接落地了 2025–2026 年角色扮演与 Agent 记忆领域的代表性研究（完整论文索引与机制对照见 [`docs/01-RESEARCH-AND-ARCHITECTURE.md`](docs/01-RESEARCH-AND-ARCHITECTURE.md)）：

- **三区 KV-Cache 上下文装配**：Zone 1 冻结前缀（`before_agent_start`）+ Zone 2 纯追加历史 + Zone 3 瞬态状态帧（`context` 尾部挂接、绝不落盘），对抗长程 *Context Rot*。
- **确定性状态与认知边界**：落地 **CFSM (ICLR 2026)** 心态状态机、**DREAM (2026)** ABC 事件-信念因果链、**Zep / Graphiti** 双时态非破坏性事实失效、**ReverieMem & The Curse of Knowledge (2026)** 列表优先视角认知隔离、**SKT (2026)** 防剧透门禁。
- **长程召回与节奏控制**：本地纯 TS **BM25 + HippoRAG 2 跳 PPR** 实体联想、**EverMemOS (2026)** 伏笔账本与幕间 MemScene 归并、**NARRA-Gym & SENSE (2026)** 防停滞与张力节奏导航、**MemRole (2026)** 记忆驱动角色决策。

<details>
<summary><b>展开查看全量技术文档与开发命令</b></summary>

- [01 · 前沿学术调研（14 项 2025–2026 论文）与下一代架构设计](docs/01-RESEARCH-AND-ARCHITECTURE.md)
- [02 · V1/V2/V3/.charx 角色卡与世界书全量字段解析与保真规范](docs/02-CARD-SPEC-AND-PARSER.md)
- [03 · 基于最新官方 Pi SDK 的标准扩展工程设计与 API 对齐清单](docs/03-PI-EXTENSION-DESIGN.md)
- [04 · 8 大社区角色卡型兼容性矩阵与能力边界](docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md)

```bash
npm run typecheck   # TypeScript 严格类型检查
npm test            # 运行全部 22 项引擎、解析器与抽取单元测试
```

</details>

---

<p align="center">
  MIT License · 欢迎搭配 <a href="https://github.com/heikeyangle-code/pi-android"><b>Pi for Android</b></a> 在手机上随时开跑你的下一段故事
</p>
