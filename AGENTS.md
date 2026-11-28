# AGENTS.md — tavern-next 接手开发规范

本仓库是运行在 Pi（主战场为移动端 `pi-android`）上的通用 AI 角色扮演引擎扩展。底层引擎（`src/engine/`、`src/memory/`、`src/context/`、`src/parser/`、`src/tools/`）与交互层（`src/ui/`）完全解耦。修改或新增功能时请遵守以下规则：

## 1. 移动端（`pi-android`）真实交互模式与 UI 原则
- **真实操作形态**：
  - 玩家在手机端**不手打斜杠命令、也没有物理键盘 Alt 组合键**。
  - `pi.registerShortcut(...)` 在 `pi-android` 的「扩展中心」里会自动渲染为**流式多行可点击的快捷胶囊按钮**；
  - `ctx.ui.select(...)` 会渲染为**原生 Material 底部弹窗（Bottom Sheet）**，每项自带单选圆点与右箭头，且**底部右下角自带原生「取消」按钮**；
  - `ctx.ui.setStatus("rp", ...)` 会渲染在「扩展中心 → 实时状态」卡片里，宽度约 **36–44 显示列**（允许自然换行）。
- **以手机端真实好用为最高准则（不再死守旧数量硬上限）**：
  - 扩展中心胶囊数量、世界面板分区数量、主菜单行数**不必僵硬受限于旧的 9 枚 / 5 分区 / 6–7 行限制**，只要层次清晰、高频功能顺手可达（如检索透视 X-Ray、卡体知识库与实体图谱等），可按需灵活增设入口。
- **不要新增 `ctx.ui.custom()` 自定义 TUI 终端浮窗 / 键盘画布**（手机端体验极差）。现有 `tui-overlay.ts` 仅作桌面兼容保留（`/rp panel tui`）。
- **一律使用 Pi 原生结构化交互 API**：`ctx.ui.select`、`ctx.ui.input`、`ctx.ui.confirm`、`ctx.ui.notify`、`ctx.ui.setStatus`、`ctx.ui.setWidget`。
- **零斜杠命令门槛**：所有面向玩家的功能必须能从面板或扩展中心点到，不能只靠手打 `/rp xxx` 触发。
- **纯中文自然文案与取消安全**：
  - 面向玩家的选项、状态栏与通知中避免暴露英文枚举值、原始内部 ID 或底层实现术语。
  - **取消安全（ESC / 点外部 / 点原生取消）**：所有 `ctx.ui.input` / `ctx.ui.select` 返回 `undefined` 时必须直接早退，严禁把 `undefined` 当空串覆盖或删除已有数据。

## 2. 功能挂载建议（清晰直观、不造无效套娃）
新增或调整功能时，逻辑写在 `src/engine/`、`src/memory/`、`src/tools/` 或 `src/ui/actions.ts`，界面入口按使用频率自然挂载到：
1. **扩展中心高频胶囊（`src/ui/shortcuts.ts`）**：放置高频一键动作（主菜单、世界面板、快捷回复、重摇/改写/续写/代写、场外提问、导演指令、检索透视 X-Ray 等；避开常见 Readline/浏览器冲突键位）。
2. **世界面板总控台（`src/ui/dashboard.ts`）**：涵盖本局动态、场景与世界、人物与关系、记忆/世界书/卡体知识库与实体图谱、导演与设置等模块；二级子菜单底部写「← 返回上一级」；触发预填输入框或发送消息后立刻 `return` 关闭面板。
3. **主菜单（`src/ui/commands.ts` → `openRpMenu`）**：保留常用回合内快捷入口。
4. **底栏与 HUD（`src/ui/hud.ts`）**：精炼展示核心剧情状态（卡名、地点、时间、回合、标记与伏笔数）。

## 3. 底层硬性约束与现代大模型预算规范
- **双轨纯文字卡知识编译（`src/parser/card-knowledge.ts`）**：
  - 常规与中大型卡（≤ 24,000 tokens）保持 100% 原文直进 Zone 1；超大型纯文字卡（> 24,000 tokens，如 50K–400K 世界观大卡）自动启用双轨模式：Zone 1 保留冻结核心骨架（≤ 12,000 tokens）+ 全卡目录与实体索引，原文无损切分为带章节路径前缀的层级父子块并持久化至 `knowledge.index.json`，支持每轮自动按需原文回溯与 `rp_recall` 检索（同时保留单卡“强制全文常驻”开关）。
- **统一实体注册与别名检索（`src/memory/entity-registry.ts` + `src/memory/graph-ppr.ts`）**：
  - 全链路统一使用 `bm25.ts` 去噪词法检索 + Aho-Corasick 别名自动机 + Salience 指代栈 + HippoRAG 2 风格 Passage+Entity 混合二分图 PPR + 加权 RRF；严格区分 `preventRecursion`（不向外扩散）与 `excludeRecursion`（不被递归激活）；别名归一化贯穿检索、门控与 FANToM 盲区保护。
- **现代化充裕上下文预算**：
  - 默认世界书预算 `4000` tokens（用户可上调至 `24000` 且不被原卡小预算锁死），Zone 3 总上限 `4800–9600` tokens，L1 深度分析支持最高 60,000 字正文（超长卡自动头/中/尾三段采样 + 全卡目录）与 32,000 字世界书预览，压缩归档支持 24,000 字对话窗口。
- **纯文学优先（Prose-First）双轨架构**：单模型默认 `tool-assisted`（0 额外后台调用 + 精简只读/掷骰工具 + 后置 `[[RP_DELTA]]` 增量同步，支持 `fact_off` 与冲突旧事实自动失效）；配置专用小模型后自动切为 `sidecar-light`。
- **严格通用 & KV-Cache 稳定 & OOC 零污染 & 时间守卫**：严禁写死单卡逻辑；Zone 1 跨回合保持字节级一致；`((...))` 场外对话不推进回合且自动隐藏；大跨度时间推进走 `src/engine/temporal.ts`。
- **构建与验证**：`package.json` 入口为 `./src/index.ts`。每次提交前必须确保 `npm test` 与 `npx tsc --noEmit` 全部通过且 0 报错。
