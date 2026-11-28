# pi-rp-engine v2 · 新时代通用 Agentic 角色扮演与世界模拟器（官方 Pi SDK 扩展）

> **定位**：100% 基于官方 **Pi SDK（`@earendil-works/pi-coding-agent` 1.6.1+）** 构建的 **零第三方运行时依赖、纯 TypeScript/ESM 单扩展通用底座**（桌面端 Pi CLI/TUI 与移动端 `pi-android` 1:1 通用）。以「确定性代码状态机（CFSM）+ 双时态事实图谱（Graphiti）+ 物理时代门禁（TimeChara/NCP-Bench）+ DREAM ABC 人物信念 + 本地 HippoRAG 2 跳 PPR 联想召回 + EverMemOS 伏笔/幕间归并 + KV-Cache 零碎裂三区上下文 + 无损保真 V1/V2/V3/.charx 兼容」全面取代传统 SillyTavern 1.0 时代纯文本拼接与前端套壳范式。

---

## 一、核心原则与 v2 全面重做亮点

### 1. 严格单会话存活 & 彻底干净退出（零跨会话污染）
- **绝不连带项目中的其他会话**：已彻底移除任何项目级 `world.json` 自动绑定机制！把角色卡存进 `.pi/rp/` 或全局角色库 `~/.pi/agent/rp-library/`，**永远只是静态素材库**，绝不会自动触发任何其他会话的 RP 模式。
- **只在显式开启的当前会话存活**：只有当你在某个会话内主动执行 `/rp load` 或 `/rp import -> 立即开启` 后，当前会话分支写入 `rp:tx (bind)` 才激活 RP 模式；其他普通编程会话保持 100% 休眠（0 工具 Token、0 Prompt 改动、0 HUD）。
- **退出即彻底退出**：执行 `/rp exit`、`/rp off` 或按 **`Alt+Shift+X`** 后，写入 `unbind` 事件，瞬间清空所有内存态（角色卡、共演卡、预设、OOC 标志、瞬态世界书缓存），**100% 恢复原有编程工具集并清空全部状态栏与 Widget**，不留一丝痕迹。

### 2. 极致人性化导入与全套交互式体验
- **全新交互式文件浏览器（告别手敲路径！）**：直接输入 `/rp import`（无需传参）即可：
  - **自动扫描并实时嗅探类型**：自动发现当前工作区、上次导入目录、`~/Downloads`（及 Android `/sdcard/Download`）、桌面与文档中的 `.png` / `.charx` / `.json`，提前验出并标注 `[角色卡 V3]`、`[角色卡 V2]`、`[CHARX]`、`[世界书]`、`[酒馆预设]`，过滤无关 JSON；
  - **自由浏览子目录 & 一键批量导入**：点击文件夹自由穿梭，同目录多张卡支持「一键批量导入」；也支持拖拽粘贴带引号/转义空格路径；
  - **导入后一键无缝开玩**：导入角色卡后当场给出审计报告，并可一键选择「立即开局 / 加入当前同场共演 / 仅存库」。
- **100% 官方 Pi UI 的精致编辑质感渲染**：
  - 全套细线框编辑感 TUI 卡片（`╭─ [OPENING] / [CHECK] / [ERA] / [OOC]`），支持中英文双宽折行与主题色自适应；
  - 完整 HUD 与 `/rp panel` 世界面板支持可视化进度条（`▓▓▓▓░░ 4/6`）、有界属性条、世界书单条实时开关、数值/背包/地点/Flags 实时编辑器、事实与信念账本、时钟与伏笔管理。

### 3. 14 个防终端冲突快捷键（桌面端 & 移动端通用）
> 严格避开 `Ctrl+I/M/J/H/C/Z/D/L/R/O` 等终端保留键位，且在未开启 RP 的编程会话中除 `Alt+R` 外完全不打扰。此外，在 RP 会话中直接输入 `((...))` 或 `（（...））` 即可零摩擦触发 OOC 讨论。

| 快捷键 | 功能 | 对应命令 |
| :--- | :--- | :--- |
| **`Alt+R`** | 打开 RP 主菜单 / 启动器 | `/rp` |
| **`Ctrl+Shift+R`** | 打开实时世界面板（状态/背包/CFSM/阶段时间/世界书搜索） | `/rp panel` |
| **`Alt+W`** | 重摇上一条回复（Swipe，旧版本保留在 `/tree`） | `/rp reroll` |
| **`Alt+K`** | 让角色无缝续写剧情 | `/rp continue` |
| **`Alt+A`** | 生成 3 个当下情境行动建议 | `/rp act` |
| **`Alt+N`** | 管理导演指令与常用模板 | `/rp note` |
| **`Alt+P`** | 一键循环切换叙事节奏（舒缓 → 均衡 → 紧张） | `/rp pace` |
| **`Alt+O`** | 发起场外 OOC 讨论（不推进剧情与时钟） | `/rp ooc` |
| **`Alt+G`** | 打开快捷掷骰检定器（标准/优势/劣势/百分骰/DC） | `/rp roll` |
| **`Alt+T`** | 跳过时间 / 幕间蒙太奇 | `/rp skip` |
| **`Alt+B`** | 保存当前剧情节点书签 | `/rp save` |
| **`Alt+J`** | 回溯或分叉至已保存的剧情书签 | `/rp goto` |
| **`Alt+H`** | 循环切换 HUD 模式（极简 → 完整 → 隐藏） | `/rp hud` |
| **`Alt+Shift+X`** | 确认后彻底退出当前会话 RP 模式 | `/rp exit` |

### 4. 酒馆官方规格 100% 对齐 & 2025–2026 前沿 RP 架构
- **绝对保真红线**：`mes_example` 100% 原样保留进冻结前缀（Zone 1），绝不截断或改写；`system_prompt` / `depth_prompt` / `post_history_instructions` 完整保留；仅用**平衡括号深度解析器**外科式剥离嵌套 HTML 状态栏、`<script>`、`<style>`、`<UpdateVariable>`，并在剥离**之前**从原始常驻世界书/YAML `InitVar` / `_.set()` 中抢救数值 Schema。
- **SillyTavern 官方 `world-info.js` / `macros.js` / `regex` 逐行对齐**：
  - 完整 CCV3 `@@` 装饰器 + 真正的 `@@@` 仅失败回退语义 + 独立 `@@exclude_keys`（绝不污染 `selectiveLogic`）；
  - 行内 `/regex/flags` 关键词触发 + 2 跳 HippoRAG PPR 扩散 + 修复非粘滞条目的 `cooldown` 冷却触发；
  - 完整 `{{random:a,b}}`、确定性 `{{pick}}`、`{{trim}}`、`{{outlet::name}}`、`{{persona}}`、`{{group}}`、`{{lastUserMessage}}`、`{{roll:d20}}`；
  - 严格遵守 `regex_scripts` 的 `placement`（仅对 `2=AI_OUTPUT` 渲染展示层）、`trimStrings` 与 `substituteRegex (0/1/2)`。
- **官方 Pi SDK 1.6.1+ 深度契约修复**：
  - `turn_end` 自动识别并跳过工具调用中间步（`stopReason === "toolUse"` / `toolCall`），杜绝回合数与 TTL 双倍消耗；
  - `session_before_compact` 严格返回 `{ compaction: { summary, firstKeptEntryId, tokensBefore, details } }`；
  - `/rp goto` 通过官方 `ctx.sessionManager.getLabel(id)` + `type === "label"` 双轨解析书签并支持回溯/分叉；
  - `/rp hide` 采用 `entryId` + 确定性消息指纹双匹配，在 `AgentMessage[]` 上 100% 可靠生效。

---

## 二、快速上手

```bash
# 编译与测试（零第三方运行时依赖）
npm run typecheck
npm test
```

在 Pi 中加载本扩展后：
1. 按 **`Alt+R`** 或输入 **`/rp`** 打开启动器；
2. 选择「浏览并导入角色卡 / 世界书 / 预设」，直接点选自动识别的 `.png` / `.charx` / `.json` 文件；
3. 选择「立即在本会话开启角色扮演」，开始沉浸式互动；
4. 随时按 **`Ctrl+Shift+R`** 打开实时世界面板微调数值/世界书/伏笔，或按 **`Alt+Shift+X`** 彻底退出回归纯净编程助手。

---

## 三、架构与设计文档导航

| 文档 | 内容 |
| :--- | :--- |
| [`docs/01-RESEARCH-AND-ARCHITECTURE.md`](./docs/01-RESEARCH-AND-ARCHITECTURE.md) | 2025–2026 前沿论文综述（CoSER / CFSM / DREAM / Graphiti / HippoRAG 2 / EverMemOS / FANToM / TimeChara）与 KV-Cache 零碎裂三区架构 |
| [`docs/02-CARD-SPEC-AND-PARSER.md`](./docs/02-CARD-SPEC-AND-PARSER.md) | SillyTavern V1/V2/V3 角色卡（PNG / `.charx` / JSON）+ World Info 30+ 字段 + CCV3 Decorators + 宏 + `regex_scripts` 解析与保真规范 |
| [`docs/03-PI-EXTENSION-DESIGN.md`](./docs/03-PI-EXTENSION-DESIGN.md) | 基于官方 Pi SDK 1.6.1+ 的工程设计：严格单会话生命周期、Hook 时序、6 个静态工具、编辑感 TUI 渲染器、交互式文件浏览器与 10 组快捷键 |
| [`docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md`](./docs/04-CARD-COMPATIBILITY-AND-MILESTONES.md) | 8 大角色卡类型兼容性矩阵、实际代码目录结构与全套自动化验收清单 |
