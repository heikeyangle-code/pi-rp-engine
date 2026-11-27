# 02 · V1/V2/V3 角色卡与世界书全量字段解析与保真清洗规范

本规范定义了 `pi-rp-engine` 导入存量 SillyTavern / RisuAI / Chub 角色卡与世界书时的**精确解析规则、剥离红线、去重策略与结构化映射**。

---

## 一、绝对保真宪法（导入器三条铁律）

1. **绝不精简灵魂字段**：`mes_example`（对话实例）**100% 完整保留，一字不删、不做摘要**；`description`、`personality`、`scenario`、`first_mes`、`alternate_greetings`、`group_only_greetings` 及有效世界书正文 **绝不做任何擅自精简**。
2. **绝不阉割破甲与作者指令**：`system_prompt`、`post_history_instructions`、`extensions.depth_prompt` 里的破甲提示、写作风格、人称视角、叙事约束、节奏要求 **全部原样保留**，严禁做任何内容审查或删改。
3. **只做“外科级剥离 + 重复合并”，且提供「无损直通开关」**：
   - **仅剥离新时代完全无用的 1.0 前端套壳**：`<script>`、`<style>`、`<iframe>`、纯 HTML/CSS 状态栏排版模板、`tavern_helper` / JS-Slash-Runner 前端 DOM 脚本、只管前端美化的 `regex_scripts`、Web 专属 `live2d`/`vrm` 资产；
   - **仅合并跨字段完全重复的防越权/防抢话套话**（如系统提示、世界书、尾注里逐字重复写了 3 遍“严禁替用户说话”时合并为 1 处；**不重复的规则绝不删除**）；
   - 导入完成后向用户输出**透明审计报告**（保留项、剥离项、合并项、抢救出的状态变量），并支持对单卡开启 `rawPassthrough: true` 一键跳过所有去重与前端清洗。

---

## 二、容器封装解析规范（Container Unpacker）

| 输入格式 | 解析步骤 | 安全与边界处理 |
| :--- | :--- | :--- |
| **PNG 角色卡（`.png`）** | 逐块扫描 PNG chunks（校验 8 字节 PNG 文件头），提取 `tEXt` 与 `iTXt`（含压缩 `zTXt` 解压）中 keyword 为 `ccv3` 与 `chara` 的 Base64 UTF-8 JSON | **严格 `ccv3` 优先于 `chara`**（V3 卡会同时写降级 V2 到 `chara`）。将原始 PNG 另存为 `assets/avatar.png` |
| **`.charx`（CCV3 ZIP 包）** | 解压读取根目录 `card.json` 及 `assets/**` | **强制 Zip-Slip 校验**（规范路径必须在目标目录内）、条目数上限与总解压大小上限；将 `embeded://`（注意 V3 规范历史拼写单 `d`）与 `embedded://` 统一重写为工作区相对路径 |
| **纯 `.json`** | 自动嗅探 schema：<br>1) `spec === "chara_card_v3"` → V3<br>2) `spec === "chara_card_v2"` → V2<br>3) 根含 `name` + `description` + `first_mes` → V1<br>4) 根含 `entries`（数组或对象字典）→ 独立 Lorebook | 独立世界书的 `entries` 常见两种结构（数组 `Entry[]` 与 `{ "0": Entry, "1": Entry }`），解析器必须双兼容 |

---

## 三、角色卡核心字段（V1 / V2 / V3）逐项映射表

| 字段名 | 版本 | 决策 | 目标层级与处理细节 |
| :--- | :---: | :--- | :--- |
| `name` | V1+ | **原样保留** | 角色规范名（Canonical Name）与 UI 显示名 |
| `nickname` | V3 | **原样保留** | 非空时按 CCV3 规范优先用于 `{{char}}` 替换；同时与 `name` 一起加入实体别名表 |
| `description` | V1+ | **原样保留（仅剥前端壳）** | 进入 **Zone 1 冻结前缀**；只剥 `<script>`/`<style>`/`<iframe>`/HTML 状态栏面板标签，不删设定文字 |
| `personality` | V1+ | **原样保留** | 进入 **Zone 1 冻结前缀**；仅当与 `description` 逐字完全一致时合并去重 |
| `scenario` | V1+ | **原样保留 + 辅助初态** | 全文进入 **Zone 1 冻结前缀**；可选提取其中明确的初始地点/时间初始化 L1 第 0 帧 |
| **`mes_example`** | V1+ | **100% 完整原样保留** | **严禁截断或摘要！** 保留 `<START>` 分段结构与所有样例对话，仅替换 `{{char}}`/`{{user}}` 并剥离嵌套前端标签，整块进入 **Zone 1 冻结前缀**（前缀冻结命中 KV Cache，长期几乎无重复开销） |
| **`system_prompt`** | V2+ | **原样保留（破甲/文风全留）** | 进入 **Zone 1 冻结前缀**；仅剥离明确指示输出 HTML/CSS 状态栏或酒馆前端脚本的片段；跨字段完全重复的防越权句做去重合并 |
| **`post_history_instructions`** | V2+ | **原样保留 → Zone 3 尾部** | 保持与酒馆一致的**历史末尾最高注意力位置**（由 `context` 钩子临时挂在最新请求尾，绝不落盘进历史，**既完整保住破甲与强约束，又零破坏 KV Cache**） |
| `first_mes` | V1+ | **原样保留（仅剥前端壳）** | 剥掉结尾 HTML 状态面板 div 或 `<script>` 后作为开局第一幕；若末尾带初始变量块则提取进 L1 初态 |
| `alternate_greetings` | V2+ | **原样保留** | 开局时通过 `ctx.ui.select()` 弹原生菜单供玩家选择路线 |
| `group_only_greetings` | V3 | **原样保留** | 多角色模式纳入开场白候选，单人局隐藏 |
| `assets[]` (`type`, `uri`, `name`, `ext`) | V3 | **静态保留 / Web 资产剥离** | 保留 `icon` / `emotion` / `background` / `user_icon` 供本地图片路径引用；**剥离** `live2d` / `vrm` / `x-risu-*` 等 Web 引擎专用二进制并在报告中列出 |
| `creator_notes` / `creator_notes_multilingual` | V2/V3 | **仅 UI 展示（0 Token）** | 在 `/rp info` 面板按语言偏好展示作者说明，不进模型上下文 |
| `tags` / `creator` / `character_version` / `source` / `creation_date` / `modification_date` | V2/V3 | **仅元数据索引（0 Token）** | 卡库搜索、过滤、版本去重与溯源展示 |

---

## 四、世界书（`character_book` / Standalone World Info）全量 30+ 字段解析规范

### 1. Book 级字段
| 字段 | 决策 | 处理 |
| :--- | :--- | :--- |
| `name` / `description` | 保留 | 世界书元信息与 UI 展示 |
| `token_budget` | 保留为默认值 | 映射到 L2 每轮世界书召回默认预算（如未设则默认 1800 tokens，可随时 `/rp config` 调） |
| `scan_depth` | 保留参考 | 映射到关键词触发的近期消息窗口（默认取 3–5 轮，并由实体图谱补充远期联想） |
| `recursive_scanning` | 升维替代 | 由有界 1–2 跳实体图谱 PPR 接管，天然无递归死循环风险 |

### 2. Entry 级全量字段
| 字段 | 原酒馆语义 | 决策 | 2.0 精确映射 |
| :--- | :--- | :--- | :--- |
| `id` / `uid` | 条目 ID | **保留** | 稳定节点 ID（兼容 `id` 与 `uid`） |
| `comment` / `name` | 条目备注标题 | **保留** | 知识节点标题、图谱标签、UI 列表名 |
| `content` | 设定正文 | **完整保留（仅剥前端壳）** | 剥离 `<script>`/`<style>`/HTML 壳/MVU 脚本后原样保留全部设定文字 |
| `enabled` / `disable` | 开关（注意独立书常用反向 `disable: true`） | **保留** | 统一归一化为 `enabled: boolean` |
| `keys` / `key` | 主触发关键词 | **保留 + 升维** | 保留精确关键词触发，同时注册进本地 BM25 与实体别名图谱 |
| `secondary_keys` / `keysecondary` + `selective` + `selectiveLogic` | 二级过滤：`0=AND_ANY`, `1=NOT_ALL`, `2=NOT_ANY`, `3=AND_ALL` | **100% 精确兼容** | 代码引擎完整实现 4 种逻辑（尤其 `NOT_ANY/NOT_ALL` 常用于互斥/阶段切换） |
| `use_regex` / `case_sensitive` / `match_whole_words` | 正则/大小写/整词 | **保留（加安全护栏）** | 正则做长度上限 + 安全编译（防 ReDoS）；非法正则自动降级为字面匹配并记入警告 |
| `constant` | 蓝灯常驻 | **分流至 Zone 1** | 纯设定蓝灯条目归入 **Zone 1 冻结前缀**；若条目内容纯属 MVU/酒馆变量初始化脚本，剥离脚本壳并提取变量 Schema 到 L1 FSM |
| `order` / `insertion_order` / `priority` | 排序与优先级 | **保留为权重** | 决定 Zone 3 同批召回条目的排序与预算紧张时的保留优先级 |
| `ignore_budget` | 无视 Token 预算强插 | **保留** | 标为 `pinned: true`，预算裁剪阶段优先保底 |
| `delay` | 前 N 轮不触发 | **升维为 L1 门禁** | 自动映射为 `gate.minTurn = delay`（前 N 轮物理隔离） |
| `sticky` | 触发后持续 N 轮 | **确定性保留** | 写入 L1 会话树事务状态，随分叉/回滚同步复原 |
| `cooldown` | 失效后冷却 N 轮 | **确定性保留** | 同上，防高频设定反复刷屏 |
| `probability` / `useProbability` | 触发概率（0–100） | **确定性保留** | 当 `useProbability && probability < 100` 时由确定性 PRNG 判定 |
| `group` / `group_override` / `group_weight` / `use_group_scoring` | 互斥分组抽签 | **保留** | 同 `group` 内按 `group_override` / 命中分 / `group_weight` 择一激活 |
| `position` (`0`~`7`) & `depth` & `role` & `outlet` | `0`:角色前 `1`:角色后 `2/3`:作者注上下 `4`:历史深度 `@D` `5/6`:对话实例上下 `7`:Outlet | **保语义、护缓存（禁止动态插前中段！）** | • `constant: true` 且 `position ∈ {0,1,5,6}` → 按 `position` + `order` 静态写入 **Zone 1 冻结前缀**；<br>• 所有动态条目（含 `position=4/@D`）→ 统一归口 **Zone 3 瞬态尾部帧**，内部按 `depth` 降序排列（`depth=0` 最贴近当前输出，保强近因效应且 **0 破坏 KV Cache**）；<br>• `position=7`（`outlet`）若为常驻且被宏引用则静态展开，否则归入 Zone 3 |
| `prevent_recursion` / `exclude_recursion` / `delay_until_recursion` | 递归防循环与二跳限定 | **升维为图谱跳数规则** | `prevent_recursion` / `exclude_recursion` → 禁止该节点内容向外扩散二跳；`delay_until_recursion` → 仅允许由 1 跳关联实体触发 |
| `match_character_description` / `match_character_personality` / `match_scenario` / `match_persona_description` / `match_character_depth_prompt` / `match_creator_notes` | 扩展扫描源开关 | **导入期一次性静态求值** | 导入/切换 Persona 时静态扫描一次即决定是否预绑定，避免每轮重复扫描静态文本 |
| `triggers` / `vectorized` / `automation_id` / `display_index` | ST 内部事件/向量标志/QuickReply 自动化/UI 排序 | **彻底剥离** | 仅 `display_index` 可留作 UI 列表顺序，其余全丢 |

---

## 五、V3 Decorators（`@@` / `@@@`）解析规范

遍历 `content` 行首的 `@@` 与 fallback `@@@` 装饰器：
1. **解析并保留语义**：
   - `@@dont_activate` → `manualRecallOnly: true`（仅由 `rp_recall` 工具主动拉取）
   - `@@activate_only_after N` → `gate.minTurn = N`
   - `@@activate_only_every N` → `gate.everyNTurns = N`
   - `@@keep_activate_after_match` → `stickyMode = "permanent"`（一旦解锁永久驻留）
   - `@@dont_activate_after_match` → `oneShot = true`（一次性触发后锁定）
   - `@@additional_keys k1,k2` → 并入 `keys`
   - `@@exclude_keys k1,k2` → 并入 `NOT_ANY` 排除键
   - `@@ignore_on_max_context` → `lowBudgetPriority = true`
2. **强制剥离原始语法行**：所有 `@@...` 与 `@@@...` 行解析完后**必须从 `content` 正文移除**，绝不漏给大模型。

---

## 六、SillyTavern `extensions` 私有字段与宏（Macros）处理规范

### 1. `data.extensions`
| 字段 | 策略 | 细则 |
| :--- | :--- | :--- |
| **`depth_prompt`** (`prompt`, `depth`, `role`) | **原样保留 → Zone 3 尾部** | 绝不删除作者角色笔记；剥前端壳后挂入 Zone 3 尾部（按 `depth` 排在 `post_history_instructions` 前） |
| **`regex_scripts`** | **精准分流（只剥前端）** | • 命中 HTML/CSS/`<div`/`<style`/`<script`/状态栏卡片/隐藏前端 DOM 的脚本 → **100% 彻底剥离**；<br>• 纯文本清理规则（`placement` 作用于 AI 输出且替换串无 HTML/JS）→ 可选转为 Pi `registerMarkdownTransformer`（默认仅影响展示，不改发送给模型的历史） |
| **`tavern_helper` / `TavernHelper_scripts` / `MVU` / `era`** | **100% 剥离前端代码 + 变量 Schema 抢救** | 剥离全部 JS/HTML/CSS/iframe；运行 `MvuSchemaSalvager` 扫描初始化 JSON / 变量定义（好感、HP、MP、金钱、衣着、日程、地点等），自动生成 `InitialFsmProposal` 供用户一键确认导入 L1 状态机 |
| **`talkativeness`** | **保留** | 多角色群聊时的 NPC 发言积极度权重（0.0–1.0） |
| **`fav` / `world` / `chub` / `risuai` / `pygmalion` / `agnai` / `v2CharExtra`** | **彻底剥离** | 旧宿主/站点私有字段 |

### 2. 前端壳外科剥离器（`FrontendSanitizer`）白名单式安全边界
为防止误伤文学正文（如包含 `<thought>`、尖括号强调或科幻 UI 剧情文本），剥离器严格按**确定性特征规则**执行：
- **必剥块**：`<script[\s\S]*?</script>`、`<style[\s\S]*?</style>`、`<iframe[\s\S]*?</iframe>`、含 `style=` / `class=` / `onclick=` / `display:flex` / `grid-template` 的多层 HTML 状态栏块、MVU 专属 `<UpdateVariable>...</UpdateVariable>` / `_.set(...)` / `_.assign(...)` 前端补丁代码块、SillyTavern `/setvar` `/echo` `/trigger` 前端斜杠命令块；
- **严禁误剥**：普通 Markdown 格式、纯对话里的 `<...>` 心理/动作描写、破甲与写作要求、非 HTML 的设定文本。

### 3. 重复防越权合并器（`DuplicateRuleMerger`）
- 仅当同一语义规则（如“不要代替 `{{user}}` 行动/说话”）在 `system_prompt`、`post_history_instructions`、蓝灯世界书、引擎内置协议中**重复出现 ≥ 2 次**（经文本归一化/高相似度检测 `>= 0.85`）时，仅保留最高优先级处的一份，其余标为 `deduplicated` 记入导入报告；
- **非重复的任何规则（破甲、文风、视角、禁词、叙事结构）100% 保留不碰**。

### 4. 宏（Macros）求值表
| 宏 | 处理 |
| :--- | :--- |
| `{{char}}` / `<BOT>` | 静态替换为 `nickname || name` |
| `{{user}}` / `<USER>` | 动态替换为当前 Persona 名（变更 Persona 时自动同步） |
| `{{// ...}}` | 直接剥离注释 |
| `{{random::a::b}}` / `{{pick::...}}` / `{{roll:XdY}}` | 开场白内由代码求值一次；局内检定交 `rp_roll_check` |
| `{{getvar::x}}` / `{{setvar::x::v}}` / `{{addvar::x::n}}` / `{{if ...}}` | 绝不透传原始宏语法；提取变量名入 L1 FSM，模板内变量占位在渲染 Zone 3 时由 L1 真值替换 |
| `{{time}}` / `{{date}}` / `{{idle_duration}}` | 替换为 L1 世界时钟（现代同步题材可选回退系统时间） |
