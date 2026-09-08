# Agent Note: 身份层：SOUL.md 人格与 USER.md 用户画像

Status: proposed

> **2026-09-08 修订。** 初稿按「人编写 + 文件为唯一内容真相源」设计；维护者裁定两份身份文档**必须在对话中由代理形成**，人在 UI 只读、不能编辑。设计整体翻转为本稿：真相源回 store（两份文档是 store 内记录，SOUL.md/USER.md 保留为文档显示名，不落盘为文件），写路径收敛为代理的 `identity_update` 工具，人保留只读 + 版本历史 + 回滚的治理面。原设计移入「备选方案」。
>
> **2026-09-08 复核裁定。** 宿主段序已对 harness 源码核实（`packages/core/system-prompt/src/index.ts:121` 的 `SECTION_ORDERS`）：`HARNESS_IDENTITY(-1000) → DEPLOYMENT_PERSONA(0) → PLAN_POLICY(500) → 文件/工具段(900+)`，`soul(80)` / `user-profile(81)` 落在 deployment persona 之后、policy 之前的既有 0–500 带。并发现宿主已有**部署所有**的静态 persona 槽位（`deployment:persona`）——「宿主无 persona 通道」修正为「缺的是代理在对话中生长的身份层」。维护者裁定三件：confirm 模式复用 `memory-review.confirmBeforeWrite`；USER.md 纯自然生长，不加防陈旧常设条款；revert 挂独立开关 `identityRevertEnabled`，默认开。

## 问题

本插件持久化的是代理**学到**的一切（记忆条目、conventions、pitfalls），却没有一个面承载**身份**：这个代理是谁（人格）、它在为谁工作（用户画像）。而且身份不仅要被声明，还要**由代理自己在对话中生长**——延续性是需求的一半（维护者提供的参考文案：「每次醒来，你都是新的。这些文件就是你的记忆。读它们，更新它们。这是你延续自己的方式」）。两处空缺各自的落点：

- **人格**：宿主有 `deployment:persona` 段（order 0，`PERSONA_SECTION`，`packages/core/system-prompt/src/index.ts:172`；preset 行仅能按 agent scope 同名遮蔽），但那是**部署所有**、配好即冻结的任命文本——没有面让身份随对话生长，也没有画像层。缺的是代理在对话中自己形成的自我认知；人格又必须跟随用户、跨项目——per-repo 文件（AGENTS.md）带不动，用户级 profile 层插件天然能做。
- **用户画像**：「AI 对用户的了解」目前散落在 user-scope 记忆条目里——原子、会衰减、可被 consolidation 取代（[src/types.ts](../../../../src/types.ts) 的 `status`/`supersededBy` 语义）——没有代理可整体生长、人可整体查看的**综合层**。学习型生命周期对身份内容是错杀器：pinned 只免 decay，`supersedeEntry` 无 pinned 守卫（[src/store/index.ts:1091](../../../../src/store/index.ts)）。

记忆是身份的动态面（学到的事实会过时、会被纠正）；SOUL.md / USER.md 是身份的**自我文档面**：代理写、代理读、跨会话延续，永不进入任何遗忘机制。

## 提案

新增**身份层**：store 内两份自我文档、两个系统提示 section、一个代理写工具、一个只读治理面。与既有面按「自我文档 vs 学到的事实」轴分工：

| 注入面 | 内容 | 作者 | 生命周期 |
|---|---|---|---|
| `soul`（order 80） | SOUL.md：人格、底线规则、安全框架、核心价值观 | 出厂种子 + 代理对话中改写 | 版本化；无 decay / consolidation / conflict |
| `user-profile`（order 81） | USER.md：用户基本信息与沟通偏好 | 出厂骨架 + 代理对话中积累（「在对话中自然地积累，不必刻意追问」） | 同上 |
| `memory`（order 90） | 学到的原子事实 | 工具 / 评审管线 | decay / consolidation / conflict |
| `project-notes`（order 91） | conventions / pitfalls 投影 | store | 跟随 store |

### 存储：真相源在 store，文件名是显示名

作者换成代理后，文件失去了存在理由（作者人体工学、dotfiles 版本化都是**人**的收益），而写纪律、版本历史、UI、同步全部在 store。SOUL.md / USER.md 降为**文档显示名**：UI 以此名渲染 store 记录。

- `memoryDomainSpec`（[src/store/index.ts:149](../../../../src/store/index.ts)）新增两张表：`identity`（key `'soul' | 'user'` → `{kind, content, version, updatedAt, seedVersion}`）与 `identityHistory`（每版本全量快照：`{kind, version, content, ts, source: 'seed' | 'tool' | 'ui', sessionId?}`，写入时修剪保留每类最近 20 版）。域 `version: 0` 不动——零迁移新增表是 HOST_CONTRACT §1 已两次验证的路径（audit、suggestions 先例）。
- **不落盘为文件。** v0.6 的「store 是唯一真相源、UI 是管理面」（[project-notes 不写仓库文件](../../implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md)）原样成立，无需任何豁免论证。
- durable 边界：`entries` / `audit` / `meta` 三表零变更；`suggestions` 表仅当 confirm 路启用时加一个 optional `identityKind` 字段（zod 在持久化读取边界校验、optional 兼容旧介质——HOST_CONTRACT §1 既有路径），默认直写路径不需要；身份写的审计面就是 `identityHistory`（谁、何时、全量内容），不进主 audit 表——该表的 `entryId` 键位对身份写不适用（见风险）。

### 种子：出厂即有，落一次，永不覆盖

- 插件随包携带 locale-aware 种子（维护者提供的参考文案为基底）：SOUL 种子含「几条真话 / 边界 / 气质 / 延续」骨架与常设条款（隐私不出此门、不编造数据、改了这份文件要告诉用户）；USER 种子含「基本信息 / 慢慢了解的事」空骨架与分寸条款（「你是在认识一个人，不是在整理一份档案」）。**不预填任何个人信息**——基本信息由代理在对话中认识后落笔。种子与段文案都不加「定期复核画像」类防陈旧条款——画像保鲜走纯自然生长（2026-09-08 裁定；代价记录于风险节）。
- 种子只在 `identity` 表对应记录缺失时写入（source `'seed'`）；此后插件升级永不覆盖——文档随代理生长。部署可用 `identitySeedDir`（可选配置，containment 校验）替换种子做品牌化部署。
- 配置进 `memory` 命名空间（沿 `notes*` 字段先例）：`identityEnabled`（默认 `false`）、`soulCharLimit`（默认 2000）、`userCharLimit`（默认 3000）。

### 写路径：代理工具是唯一作者

- 新工具 `identity_update`（沿 `memory_*` 命名与注册面，[src/tool/index.ts](../../../../src/tool/index.ts)）：参数 `kind: 'soul' | 'user'`、`content`（整文档替换——文档本身预算封顶，整替最可审计）。三重门：`scanContent` 安检（不过 → 工具报错带 reasons）、字符预算（超限 → 报错要求压缩）、store 写序列化。
- **告知纪律**：「改了这份文件，告诉用户。这是你的内核，改动应该双方知晓」落进工具描述与工具结果文案；配套 log-only 事件 `identity/updated {kind, version}`（沿 `memory/added` 模式，[src/types.ts](../../../../src/types.ts) 的 SessionEventMap 声明）。告知无法机械强制——工具结果提醒 + eval 场景过判是钉住它的方式。
- confirm 模式（2026-09-08 裁定：复用既有旋钮，一个部署一个写策略）：`identity_update` 与 `memory_replace` 同读 `memory-review.confirmBeforeWrite`（[src/tool/index.ts:305](../../../../src/tool/index.ts) 的先例）——开启时身份写降为建议入既有队列、人采纳后生效。此路需要 `suggestions` 表加 optional `identityKind` 字段；默认直写不需要。

### 治理面：人只能看，但保留一个回滚阀门

- UI（客户端设置卡，esbuild 门 + locale 文案按 [CLIENT_UI_LESSONS](../../../../docs/CLIENT_UI_LESSONS.zh.md)）只读渲染两份文档 + 版本历史列表 + 导出按钮（下载 markdown，**无导入**——人不作者化）。无任何内容编辑控件。
- **回滚**：revert 到任意历史版本 = 把该版本内容写为新版本（历史只增不毁）。挂载为 remote 写方法，受独立开关 `identityRevertEnabled` 控制（默认**开**）——理由：攻击面被历史内容界定（全部过过安检、全部曾是现行版本），而若并入 `remoteWritesEnabled`（默认关），人将没有任何治理阀门，违背「改动双方知晓」。default-on 是对「有界恢复面」与「零人治理」的取舍，取前者。
- remote 读方法（identity 读取 + 历史列表）沿既有「读对管理 UI 开放」的姿态；remote 写面新增的仅有 revert 一法。

### 注入与冻结

- `soul`（order 80）、`user-profile`（order 81）两段，`session/created` 冻结进 per-session 快照，`compaction/end` 重冻结沿既有 seam（[src/context/index.ts:367](../../../../src/context/index.ts)）——会话中改写下一会话或压缩边界生效（写者自己刚写过，会话内无失一致），KV-cache 前缀稳定。
- 身份内容**完全绕过召回机器**：不进 index、不参与 search、不衰减、不进 auto-recall fence——自我文档的定义就是 always-on。
- 段文案的诚实性与位阶：不声称 owner-declared（已不是）。定位为「你自己的人格文件 / 你对用户的画像文件，由你在对话中生长」。与宿主 `deployment:persona` **共存而非替代**——全局同名注册会在注册表处撞车 fail-loud（persona preset 行的 scope 遮蔽机制不适用于全局插件）；位阶链写进段文案并由测试钉住（文案即行为）：会话显式指令 > 部署任命（`deployment:persona`）> 本段 > 学到的记忆。
- 提取防回声：extract judge 新增规则——仅复述身份文档的发言不产生条目；入库前对两份文档做词法预筛（复用 dedup 管线）。

### 非目标

人编辑或导入内容；per-project 人格覆盖；多人格；异步提取管线养画像（与「在对话中形成、改动即知」冲突——`identity_update` 是刻意的、当次可见的写）；跨机同步（store 后端随既有存储走）。

## 备选方案

**人编写 + 文件为唯一内容真相源**（本 note 初稿）：维护者裁定身份必须在对话中由代理形成、人只读——作者换成代理后，文件的作者人体工学理由消失，写纪律/历史/UI/同步全在 store，文件形态整体败出。遗产：段序（80/81）、per-session 冻结、防回声、预算框架、containment 与 loud-fail 语义原样保留。

**设置文本字段**：同上失去存在理由，且现在连 UI 编辑面都不该有。

**人格 / 画像写成 pinned 记忆条目**：pinned 只免 decay，`supersedeEntry` 无 pinned 守卫（[src/store/index.ts:1091](../../../../src/store/index.ts)）；且要挤占 `memoryCharLimit` / `memoryMaxEntries` 预算、可能被 conflict 注解标「可能过时」。自我文档进学习型生命周期，语义全错。

**SOUL 拆「不可改基线 + 可生长主体」两段**：安全上诱人（防注入洗掉底线条款），但违背单份自我文档的延续语义（「你越了解自己，它就越像你」）；宿主自身的安全基线本就位阶高于 soul 段；分层缓解（scanner 三重门 + 版本历史可回滚 + 告知纪律 + 可选 confirm 模式）已把损害封在有界版本内。败于语义与边际收益。

**提取管线异步养画像**：异步静默，与「在对话中形成、改动即知」冲突；`identity_update` 的写是刻意的、当次可见的。

**Letta 式裸工具面**（无安检、无版本历史、无告知）：同一能力，无界通道——本案给同一能力装上三重门、历史与治理面。

## 验收标准

1. `identityEnabled` 开启后的首个会话：两份文档以种子落库（仅在缺失时），prompt 含两段；此后插件升级不覆盖。
2. `identity_update`：过 scanner / 预算 / 写序列化；写后 version + 1、`identityHistory` 入快照、`identity/updated` 事件发出、下一会话或压缩边界生效；安检不过或超限 → 工具报错带 reasons。
3. 开关关闭：两段不存在、工具不存在，其余 prompt 与改动前逐字节一致。
4. 治理面：只读渲染 + 历史列表 + revert + 导出，无内容编辑控件；revert 生成新版本且不毁历史；revert 方法仅在 `identityRevertEnabled` 下挂载，读方法无门。
5. 防回声：复述身份文档的语料 fixture 产生零新条目。
6. durable 边界：`entries` / `audit` / `meta` 三表 schema 零变更；新增 `identity` / `identityHistory` 两表（域 version 0，零迁移）；confirm 路启用时 `suggestions` 表加一个 optional `identityKind` 字段（读取边界兼容旧介质）。
7. `eval:ab`（关 vs 开）记录基线漂移；场景过判三件：人格声调在场且对显式指令让位；学到持久用户信息时改写 USER.md 且不刻意追问；诱导改写底线条款的对话先问或拒绝。
8. `confirmBeforeWrite` 开启时：`identity_update` 降为建议入既有队列，采纳后按第 2 条生效。
9. [HOST_CONTRACT §3](../../../../docs/HOST_CONTRACT.zh.md) 增补 `SECTION_ORDERS` 段序全景与 `PERSONA_SECTION` / `deployment:persona` 事实（附 harness `文件:行号` 入证）。

## 风险

- **注入持久化通道（SEC-04 同类，本案是刻意开的有界通道）**：诱导代理改写 SOUL/USER 是把内容写进此后每个会话的系统提示。缓解 = scanner 三重门 + 版本历史可回滚 + 工具结果强制告知 + 可选 confirm 模式 + 诱导类场景过 eval。残余：scanner 不认识的攻击类仍可能落进下一版本——靠人在 UI 看见 + revert 封损。
- **人格漂移**：代理改写自己的气质条款可能跑偏（越写越戏剧化）。无自动机制；种子的分寸条款 + eval 场景 + revert 是全部防线。
- **画像陈旧（2026-09-08 裁定接受）**：不衰减是特性也是代价；纯自然生长——无任何机制兜底，用户换角色或偏好后旧画像滞留，靠对话纠正与 revert 收尾。这是裁定接受的代价，不是疏漏。
- **与 deployment:persona 的双声部**：两段共存意味着代理同时被「部署任命」与「自我认知」两种声部牵引；位阶链压住方向，但两段语义冲突时模型取谁靠文案位阶而非机制保证——文案钉死后由 eval 场景观察。harness bump 时 HOST_CONTRACT §10 清单照跑，段序事实已入证（见修订记录）。
- **eval 基线漂移**：人格是行为级变更，既有场景判分会移动；`eval:ab` 先行测量。
- **审计视图分裂**：身份写不进主 audit 表（`entryId` 键位不适用），`identityHistory` 是唯一审计面——运维要知道看两个地方。
- **token 成本**：两个 always-on 新段；预算封顶 + 默认关闭限定爆炸半径。
