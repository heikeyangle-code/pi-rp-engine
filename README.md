# pi-rp-engine · 下一代通用 Agentic 角色扮演与世界模拟器（Pi 扩展施工蓝图）

> **定位**：基于官方 **Pi SDK（`@earendil-works/pi-coding-agent`）** 构建的 **100% 标准单扩展通用底座**（零 App 魔改、桌面端 Pi CLI/TUI 与移动端 `pi-android` 1:1 通用），以「确定性代码状态机 + 双时态事实图谱 + 物理时代门禁 + KV-Cache 零碎裂三区上下文 + 无损保真 V2/V3 角色卡兼容」取代传统 SillyTavern 1.0 时代纯文本拼接与前端套壳范式。

---

## 一、四个最关键的架构定调（开工前先拍板）

### 1. 界面怎么做？会破坏 `pi-android` 与官方 Pi 的 1:1 吗？
**完全不会，零侵入、零破坏，100% 只用官方 Pi 扩展通用 UI 接口！**
- 之前提到的“手机原生 HUD”并非去魔改 `pi-android` 客户端代码，而是指 **`pi-android` 已经 1:1 实现了官方 Pi SDK 的全套 `ExtensionUIContext` 接口**，并用原生 Jetpack Compose 渲染：
  - `ctx.ui.setStatus(key, text)` → 桌面端渲染在底栏状态条，`pi-android` 原生渲染在输入框上方可横滑胶囊；
  - `ctx.ui.setWidget(key, linesOrFactory)` / `setHeader` / `setFooter` → 桌面端渲染在 TUI 面板，`pi-android` 原生渲染为可折叠 Compose 卡片（自动跟随 12 套主题）；
  - `ctx.ui.custom(factory)` → 桌面端是 TUI 交互弹层，`pi-android` 原生渲染为底部交互抽屉面板（自带按键条）；
  - `ctx.ui.select / confirm / input / editor / notify` → 原生选项弹窗、确认框、输入框、提示条；
  - `pi.registerTool({ renderCall, renderResult })` / `pi.registerEntryRenderer` / `pi.registerMessageRenderer` → 官方组件渲染链，桌面与手机 1:1 一致。
- **硬性红线**：本扩展 **严禁** 依赖任何 `pi-android` 私有接口，也不要求修改 `pi-android` 一行代码；安装后在 Linux/macOS/Windows 桌面 `pi` 与 `pi-android` 上运行效果完全一致。

### 2. 角色卡按「项目（Project）」还是按「对话（Session）」组织？
**结论：扩展全局只装一次，平时完全静默（0 Token、0 HUD、不干扰写代码）；玩法层同时支持「一世界一项目」为主、「单库按对话切卡」为辅，状态永远绑定在 Pi 原生会话树里。**

| 层级 | 职责 | 为什么这是最优解 |
| :--- | :--- | :--- |
| **扩展代码本身** | 全局安装一次（`~/.pi/agent/extensions/pi-rp-engine` 或 `pi install`） | 所有工具注册为 `defaultActive: false`；未激活 RP 模式时，写代码/日常聊天 **0 开销、0 污染** |
| **推荐主模式：一长篇大卡 / 一世界观 = 一个项目（Workspace）** | 项目 `.pi/rp/` 存放卡资产（`.charx` 解包立绘/背景图）、清洗后的标准卡包、外挂世界书、自定义时代/规则模板 | ① 文件与立绘归属清晰，在 `pi-android`「项目与文件」里一目了然；② 同一个项目里开多个「新对话」，就是同一个世界的多条攻略线 / 不同 `alternate_greetings` 开局，共享世界书与立绘；③ 切回编程项目瞬间退出 RP 模式 |
| **轻量兼容模式：统一角色库项目 + 按对话绑定卡** | 在同一个“酒馆/短打”项目里，每个对话通过 `/rp load <card>` 或 `/rp import <file>` 单独绑定一张卡 | 适合一次性短打小卡，不必每张轻卡都新建文件夹；绑定记录写入 `pi.appendEntry("rp:bind", ...)`，各对话互不串台 |
| **局内状态 / 存档 / 路线分叉 = 会话树（Session Tree）** | 所有 FSM 状态跃迁、双时态事实、伏笔、进度时钟、时代解锁都通过 `pi.appendEntry("rp:tx", delta)` 写入当前对话 JSONL 树 | 在 Pi / `pi-android` 的「会话树」里任意回退到 30 轮前或分叉重选，**世界状态、背包、好感、时代锁 100% 自动随分支回滚，零脱节** |

### 3. 存量角色卡兼容的「绝对保真红线」
- **绝不精简 `mes_example`（对话实例）**：一字不删、完整进入冻结前缀（Zone 1），锁死角色语感、口癖、节奏与文风。
- **绝不阉割 `system_prompt`、`post_history_instructions`、`depth_prompt`（含破甲/文风/视角/作者规则）**：原样保留、绝不做内容审查。
- **只剥离新时代彻底无用的 1.0 前端壳子**：`<script>`、`<style>`、`<iframe>`、HTML/CSS 状态栏排版代码、`tavern_helper` / JS-Slash-Runner 前端 DOM 脚本、纯前端渲染型 `regex_scripts`、Web 专属 `live2d`/`vrm` 二进制。
- **仅合并跨字段完全重复的防越权/防抢话套话**：不重复的规则与设定绝不剥离；且内置 **「无损直通开关（Raw Passthrough）」**，一键可关闭任何去重与状态接管。

### 4. 所有类型的角色卡都能用吗？
详见 [`docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md`](./docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md)：
- **7 大主流卡型 100% 原生支持且体验显著超越酒馆**：纯文字 1v1 / 陪伴卡、大型世界观 / 跑团 TRPG 卡、数值养成 / SLG / MVU 状态栏卡、多角色 / 群像 / 后宫模拟卡、多时代 / 悬疑推理 / 剧本杀卡、强文风 / 文学小说 / 重破甲卡、V3 `.charx` 富媒体立绘卡。
- **唯一诚实划界的 1 类**：把核心玩法本身写成浏览器 JS 小游戏 / Canvas 交互网页的“伪前端网页卡”（剥离 JS 后失去定制 Canvas UI，仅能退化为纯文本+状态机交互）。

---

## 二、施工文档导航

| 文档 | 内容 |
| :--- | :--- |
| [`docs/01-RESEARCH-AND-ARCHITECTURE.md`](./docs/01-RESEARCH-AND-ARCHITECTURE.md) | 2025–2026 前沿 9 项论文与工程机制深度综述、三层存储与 KV-Cache 零碎裂三区架构、低延迟双轨闭环 |
| [`docs/02-CARD-SPEC-AND-PARSER.md`](./docs/02-CARD-SPEC-AND-PARSER.md) | SillyTavern V1/V2/V3 角色卡（PNG / `.charx` / JSON）+ World Info 30+ 扩展字段 + Decorators + `extensions` + 宏的全量解析/保留/剥离施工规范 |
| [`docs/03-PI-EXTENSION-DESIGN.md`](./docs/03-PI-EXTENSION-DESIGN.md) | 基于官方 Pi SDK 的完整工程设计：TypeScript 数据结构、Hook 时序、静态工具集、会话树事务回放、通用 Pi UI 交互、项目/对话双模式生命周期 |
| [`docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md`](./docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md) | 8 大角色卡类型兼容性矩阵、分阶段施工路线图（Phase 0 → Phase 4）、目录结构、自动化测试与验收标准 |
