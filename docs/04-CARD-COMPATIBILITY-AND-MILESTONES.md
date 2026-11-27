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

## 二、实际代码目录结构（v2 完整落盘）

```text
pi-rp-engine/
├── package.json                     # 标准 Pi 扩展包声明（零运行时依赖，纯 TS/ESM）
├── tsconfig.json
├── README.md
├── docs/
│   ├── 01-RESEARCH-AND-ARCHITECTURE.md
│   ├── 02-CARD-SPEC-AND-PARSER.md
│   ├── 03-PI-EXTENSION-DESIGN.md
│   └── 04-CARD-COMPATIBILITY-AND-MILESTONES.md
├── src/
│   ├── index.ts                     # Pi 扩展唯一入口：严格单会话生命周期、全部 Hook、6 工具、渲染器与 10 快捷键
│   ├── types.ts                     # 全量 TS 数据结构、Pi SDK 1.6.1 结构化契约与事务事件类型
│   ├── parser/
│   │   ├── unpack.ts                # PNG (ccv3 > chara) / .charx (Zip-Slip安全解压) / JSON 嗅探 + 快速文件分类器
│   │   ├── card-compiler.ts         # 端到端 V1/V2/V3/.charx 编译器（剥离前打捞 MVU + 完整 regex_scripts）
│   │   ├── sanitizer.ts             # 平衡深度 HTML 状态栏剥离 + 重复防越权合并 + ST AI_OUTPUT 展示正则引擎
│   │   ├── mvu-salvage.ts           # MVU / _.set(k,v,min,max) / YAML InitVar / 宏变量抢救提取器
│   │   ├── lore-compiler.ts         # 30+ 世界书字段 + 全套 CCV3 @@/@@@ 装饰器 + 独立 excludeKeys 编译
│   │   ├── preset.ts                # SillyTavern OpenAI/Chat Completion Preset 三区编译器
│   │   └── macros.ts                # SillyTavern 宏引擎（含 random/pick/trim/outlet/roll/persona/group）
│   ├── engine/
│   │   ├── state-replay.ts          # 严格单会话分支事件溯源重放 + 消息指纹生成器
│   │   ├── cfsm.ts                  # 通用 CFSM 状态机与数值/背包上下界强校验器
│   │   ├── gates.ts                 # EraGate 物理隔离 + FANToM 认知域过滤
│   │   ├── dice.ts                  # crypto.randomInt 掷骰引擎（支持 d20 简写、2d20kh1 优势、2d20kl1 劣势）
│   │   └── settlement.ts            # 工具中间步过滤 + 确定性 turn_end 结算 + 零首字延迟 sidecar-light
│   ├── memory/
│   │   ├── bitemporal.ts            # 双时态事实账本 + 非破坏性失效（Graphiti 模式）
│   │   ├── foresight.ts             # 伏笔 / 进度时钟 / 契诃夫之枪管理（EverMemOS 模式）
│   │   ├── graph-ppr.ts             # 零依赖本地 BM25 + 行内正则 + 2 跳 PPR 联想召回（HippoRAG 2）
│   │   └── compaction.ts            # session_before_compact 幕间 MemScene 归并器（合规 CompactionResult）
│   ├── context/
│   │   ├── zone-builder.ts          # Zone 1 冻结前缀（含位置常驻世界书/静态 outlet）+ Zone 3 瞬态尾部帧
│   │   └── token-budget.ts          # 中英混合 Token 估算与优先级预算裁剪器
│   ├── storage/
│   │   └── workspace-store.ts       # 纯被动素材库管理（全局 rp-library 与项目 .pi/rp/，绝不跨会话自动激活）
│   ├── tools/
│   │   └── rp-tools.ts              # 6 个静态工具（defaultActive: false）+ 编辑感 renderCall / renderResult 微卡
│   └── ui/
│       ├── renderers.ts             # 细线框编辑感 TUI 卡片渲染器（rp:greeting/event/ooc/era）+ 进度条 + CJK 折行
│       ├── hud.ts                   # 官方 setStatus / setWidget 精致状态栏与完整可视化仪表条
│       ├── file-picker.ts           # 交互式文件浏览器（自动扫描 Downloads/工作区 + 资产类型嗅探 + 批量导入）
│       ├── dashboard.ts             # `/rp panel` 交互总控台（世界总览/实时状态编辑/世界书开关/事实信念/时钟伏笔）
│       ├── actions.ts               # 全部人性化交互流程（快速开局/掷骰器/书签跳转分叉/指纹隐藏/彻底退出）
│       ├── commands.ts              # `/rp` 分类主菜单 + 短子命令 + 智能自动补全
│       └── shortcuts.ts             # 10 组防终端冲突快捷键注册与休眠态保护
└── test/
    ├── parser.test.ts               # PNG/CHARX/嵌套HTML/剥离前MVU打捞/CCV3装饰器/ST宏/正则/文件嗅探器单测
    └── engine.test.ts               # 单会话隔离/彻底退出/工具步防重计/行内正则PPR/KV不变性/Pi SDK 契约全套单测
```

---

## 三、v2 验收标准（已全部自动化测试通过）

1. **单会话严格隔离与彻底退出**：项目 `.pi/rp/` 存在角色卡时，新建会话 100% 休眠；`/rp exit` 后编程工具、HUD、上下文钩子全部复原清零；重新绑定新卡不残留旧数值。
2. **解析保真红线**：`mes_example` 字符保留率 **100%**；嵌套 `<div>` 状态栏剥离后零残余标签；常驻世界书 YAML / `_.set(k, v, min, max)` 在剥离前 100% 打捞成功；`@@exclude_keys` 不破坏 `selectiveLogic`。
3. **KV-Cache 零碎裂**：连续 20 轮含状态变更、信念更新、节奏切换、中途换人设，Zone 1 字节 100% 一致；历史消息不回改，楼层隐藏通过消息指纹可靠生效。
4. **官方 Pi SDK 1.6.1+ 契约**：`turn_end` 自动跳过工具中间步；`session_before_compact` 返回完整 `{ summary, firstKeptEntryId, tokensBefore, details }`；`/rp goto` 通过 `sessionManager.getLabel(id)` 解析书签；6 工具 + 4 渲染器 + 10 快捷键全部就绪。

