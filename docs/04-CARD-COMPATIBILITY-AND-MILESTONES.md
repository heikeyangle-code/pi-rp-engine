# 04 · 全类型角色卡兼容性矩阵与分阶段施工路线

---

## 一、所有类型的角色卡都能用吗？（8 大真实社区卡型诚实评估）

结论：**社区 95%+ 的存量卡（以下前 7 大类）全部原生可用，且在长程记忆、状态准确性、缓存速度与省钱程度上全面超越酒馆；唯独第 8 类“把核心玩法做成浏览器 JS 互动小游戏”的特殊前端卡需要诚实划界。**

| # | 角色卡类型 | 代表特征 | 兼容度 | 通用底座如何自适应（零单卡写死） |
| :-: | :--- | :--- | :---: | :--- |
| **1** | **纯文字 1v1 角色卡 / 恋爱日常 / 治愈陪伴** | `description` + `mes_example` + `first_mes`，无复杂数值或世界书 | **100% 完美** | 自动进入极简模式：完整保真 `mes_example` + `system_prompt` + `post_history_instructions`，0 工具打扰，轻度记录事实与伏笔，HUD 可一键切极简或隐藏 |
| **2** | **大型世界观 / 跑团 TRPG / 规则怪谈卡** | 50–300 条世界书、复杂地点/派系/规则、掷骰与物品判定 | **100% 降维打击** | 本地 BM25 + HippoRAG 2 跳 PPR 精准召回 + `rp_roll_check` 真随机检定 + `rp_state_patch` 背包/状态强校验，彻底消灭长程遗忘与规则瞎编 |
| **3** | **数值养成 / SLG / MVU / 类脑重度状态栏卡** | 原版依赖 MVU、`tavern_helper`、`<UpdateVariable>`、大坨 HTML 状态栏 | **95% 升维接管** | 导入器剥离 HTML/JS 渲染壳，自动从初始化脚本/首条消息抢救数值变量 Schema（好感/HP/体力/金钱/日程/衣着等）转为 L1 确定性 FSM + 原生 `setStatus`/`setWidget` 面板，**再也不会炸状态栏或把历史塞满垃圾 HTML** |
| **4** | **多角色 / 群像 / 阵营 / 后宫模拟卡** | 单卡多 NPC 或多张卡同台，`group_only_greetings`、`talkativeness` | **100% 降维打击** | 支持世界内注册多角色档案 + `presentNpcs` 在场追踪 + 双时态事实 `witnessIds` 认知隔离，解决酒馆群聊全知穿帮与人设串味 |
| **5** | **多时代 / 长篇剧情 / 悬疑推理 / 剧本杀卡** | 隐藏真相、线索解锁、分幕推进、严禁剧透 | **100% 降维打击** | `EraGate` + `delay` / `@@activate_only_after` 自动升级为物理门禁，未解锁线索与幕后真相物理上绝不进 Prompt |
| **6** | **强文风 / 文学小说 / 重破甲 / 预设驱动卡** | 长 `mes_example`、厚重 `system_prompt` / `post_history_instructions` / `depth_prompt` | **100% 完美保真** | `mes_example` 一字不删进冻结 Zone 1；破甲与 `post_history_instructions` / `depth_prompt` 原样进 Zone 3 尾部，既保留最强遵循力又不碎 KV Cache |
| **7** | **V3 `.charx` 富媒体立绘卡** | 内嵌 `assets/`（表情立绘、场景背景图）、`@@` 装饰器 | **95% 原生支持** | 解包静态图片到本地路径供原生显示，解析全部主流 `@@` 装饰器（仅跳过 Web 专用 Live2D/VRM 骨骼模型） |
| **8** | **纯浏览器 JS 小游戏 / Canvas 交互网页卡** | 核心玩法本身是一段内嵌 HTML5 Canvas / Vue / React 交互小游戏（如网页打牌/点选大地图按钮） | **诚实划界（需降级）** | 因为严格剥离 `<script>` 与 Web 前端壳，这类依赖 DOM 点击事件与 Canvas 渲染的自定义网页游戏无法照原样跑，只能退化为文本指令 + FSM 玩法（不在纯标准 Pi 扩展承诺范围内） |

---

## 二、标准仓库与扩展目录规划（后续开工直接按此落盘）

```text
pi-rp-engine/
├── package.json                     # 标准 Pi 扩展包声明（零重型原生依赖，纯 TS/ESM）
├── tsconfig.json
├── README.md
├── docs/
│   ├── 01-RESEARCH-AND-ARCHITECTURE.md
│   ├── 02-CARD-SPEC-AND-PARSER.md
│   ├── 03-PI-EXTENSION-DESIGN.md
│   └── 04-CARD-COMPATIBILITY-AND-MILESTONES.md
├── src/
│   ├── index.ts                     # Pi 扩展唯一入口：注册钩子、5 个静态工具、/rp 命令与渲染器
│   ├── types.ts                     # 全量 TS 数据结构与事务事件类型
│   ├── parser/
│   │   ├── unpack.ts                # PNG (ccv3 > chara) / .charx (Zip-Slip安全解压) / JSON 嗅探
│   │   ├── sanitizer.ts             # 前端壳外科剥离 + 重复防越权合并（严禁删 mes_example/破甲）
│   │   ├── mvu-salvage.ts           # MVU / 宏变量 Schema 自动抢救提取器
│   │   ├── lore-compiler.ts         # 30+ 世界书字段 + V3 @@ Decorators 编译为门禁知识库
│   │   └── macros.ts                # 宏替换与安全求值
│   ├── engine/
│   │   ├── state-replay.ts          # 从 Pi 会话树 branch 确定性重放 L1 世界状态（Event Sourcing）
│   │   ├── cfsm.ts                  # 通用 CFSM / CPFSM 状态机与数值边界校验器
│   │   ├── gates.ts                 # EraGate 物理隔离 + Epistemic 认知域过滤
│   │   ├── dice.ts                  # 确定性/真随机 XdY 检定引擎
│   │   └── settlement.ts            # 回合后结算（纯代码 + 可选 sidecar-light binary_q / 事实抽取）
│   ├── memory/
│   │   ├── bitemporal.ts            # 双时态事实账本 + 非破坏性失效（Graphiti 模式）
│   │   ├── foresight.ts             # 伏笔 / 进度时钟 / 契诃夫之枪管理（EverMemOS 模式）
│   │   ├── graph-ppr.ts             # 零依赖本地 BM25 + 实体别名图 + 2 跳 PPR 联想召回（HippoRAG 2）
│   │   └── compaction.ts            # session_before_compact 幕间 MemScene 归并器
│   ├── context/
│   │   ├── zone-builder.ts          # Zone 1 冻结前缀 + Zone 3 瞬态尾部帧确定性装配器
│   │   └── token-budget.ts          # 中英混合 Token 估算与优先级预算裁剪器
│   ├── storage/
│   │   └── workspace-store.ts       # 项目级 .pi/rp/ 与共享角色库读写（双模式绑定解析）
│   ├── tools/
│   │   └── rp-tools.ts              # 5 个静态工具实现 + 官方 renderCall / renderResult 叙事卡
│   └── ui/
│       ├── hud.ts                   # 官方 setStatus / setWidget 紧凑状态与进度时钟面板
│       ├── dashboard.ts             # 官方 ctx.ui.custom 交互式总控台（状态/世界书/事实/伏笔）
│       └── commands.ts              # /rp 命令家族 + 参数自动补全 + 导入审计报告交互
└── test/
    ├── parser.test.ts               # V1/V2/V3 PNG + .charx + 独立 Lorebook + 保真红线单测
    ├── sanitizer.test.ts            # 验证 mes_example/破甲 0 丢失 + 前端 HTML/MVU 精准剥离
    ├── replay-branch.test.ts        # 会话树分叉/回溯状态 100% 一致性测试
    ├── kv-cache-invariants.test.ts  # 验证 Zone 1 字节级冻结 & Zone 2 零回改（KV Cache 守卫！）
    ├── gates-epistemic.test.ts      # 时代物理隔离与多角色认知盲区防穿帮测试
    └── graph-ppr.test.ts            # 代词/多跳联想召回 + sticky/cooldown/selectiveLogic 矩阵测试
```

---

## 三、分阶段施工路线与硬性验收标准

### Phase 0 · 骨架与契约守卫（1–2 天）
- 搭建标准 Pi 扩展工程、`node:test` 测试框架与 `src/types.ts`；
- 实现「非 RP 项目/会话 100% 静默休眠」守卫（工具 `defaultActive: false`、0 UI、0 上下文改动）；
- **验收**：挂载到真实 Pi SDK / `pi-android` 后，打开普通代码项目零感知。

### Phase 1 · 无损保真 V1/V2/V3 角色卡与世界书编译器（3–4 天）
- 完成 PNG（`ccv3 > chara`）、`.charx`（Zip-Slip 安全解包 + `embeded://` 重写）、独立 JSON 世界书解析；
- 完成 `FrontendSanitizer`（仅剥前端壳）、`DuplicateRuleMerger`（仅合并重复防越权）、`MvuSchemaSalvager`（变量 Schema 抢救）、30+ 世界书字段 & V3 `@@` Decorators 编译；
- **硬性验收**：
  - 跑真实社区复杂卡（含厚重 `mes_example`、破甲、`depth_prompt`、MVU 状态栏、100+ 词条世界书）；
  - 断言 `mes_example` 字符保留率 **100%**、破甲与非重复写作指令保留率 **100%**、前端 `<script>`/`<style>`/HTML 状态栏残留 **0%**。

### Phase 2 · L1 确定性世界引擎 + 会话树事件溯源 + 三区 KV-Cache 管线（4–5 天）
- 实现 `rp:tx` 事件溯源重放（`session_start` / `session_switch` / `session_fork` / `session_tree`）；
- 实现 `CfsmMachine`、多尺度时钟、进度时钟、双时态事实账本、Foresight 伏笔队列、`EraGate` 物理门禁；
- 实现 `before_agent_start`（Zone 1 冻结）+ `context`（Zone 3 瞬态尾部帧）+ 5 个静态工具与叙事卡片渲染；
- **硬性验收**：
  - **KV-Cache 字节不变性测试**：连续 20 轮对话中，Zone 1 哈希 100% 相同、历史消息 `messages[0..t-1]` 字节 100% 不被篡改；
  - **分支回滚测试**：第 20 轮回溯到第 8 轮分叉，HP/背包/时代锁/双时态事实/sticky 计数全部精确回到第 8 轮状态；
  - **门禁物理隔离测试**：Act I 期间，Act II 设定与未解锁秘密在组装给模型的最终 payload 中出现次数严格为 `0`。

### Phase 3 · 本地 HippoRAG PPR 联想召回 + 幕间归并 + 可选 `sidecar-light` 结算（3–4 天）
- 实现零外部依赖本地 BM25 + 实体别名邻接图 + 2 跳 PPR 召回器（单次召回 < 5ms）；
- 实现 `session_before_compact` 幕间 MemScene 归并与 `/rp montage` 跨时间推进；
- 实现回合后 3 档结算模式（`off` / `tool-assisted` / `sidecar-light` 轻量 `binary_q` 与事实抽取）。

### Phase 4 · 100% 官方 Pi UI 打磨与桌面/手机双端实机联调（2–3 天）
- 完成 `setStatus`、`setWidget`、`ctx.ui.custom` 总控台、`/rp` 命令补全与导入审计报告界面；
- 同时在 **桌面端官方 `pi` CLI/TUI** 与 **手机端 `pi-android`** 真机实测 7 类代表性角色卡（检验窄屏折行、深浅 12 主题可读性、长会话流畅度与 KV Cache 命中统计）。
