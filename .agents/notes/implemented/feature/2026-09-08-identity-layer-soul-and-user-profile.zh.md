# Agent Note: 身份层：SOUL.md 人格与 USER.md 用户画像

Status: implemented

> **2026-09-08 修订。** 初稿按「人编写 + 文件为唯一内容真相源」设计；维护者裁定两份身份文档**必须在对话中由代理形成**，人在 UI 只读、不能编辑。设计整体翻转为终稿：真相源回 store（两份文档是 store 内记录，SOUL.md/USER.md 保留为文档显示名，不落盘为文件），写路径收敛为代理的 `identity_update` 工具，人保留只读 + 版本历史 + 回滚的治理面。人编写方案移入「备选方案」。
>
> **2026-09-08 复核裁定。** 宿主段序已对 harness 源码核实（`packages/core/system-prompt/src/index.ts:121` 的 `SECTION_ORDERS`）：`HARNESS_IDENTITY(-1000) → DEPLOYMENT_PERSONA(0) → PLAN_POLICY(500) → 文件/工具段(900+)`，`soul(80)` / `user-profile(81)` 落在 deployment persona 之后、policy 之前的既有 0–500 带。并发现宿主已有**部署所有**的静态 persona 槽位（`deployment:persona`）——「宿主无 persona 通道」修正为「缺的是代理在对话中生长的身份层」。维护者裁定三件：confirm 模式复用 `memory-review.confirmBeforeWrite`；USER.md 纯自然生长，不加防陈旧常设条款；revert 挂独立开关 `identityRevertEnabled`，默认开。
>
> **2026-09-08 落地。** 实现期三项精化随代码落定（详见「决策」）：装载期 loud 门落 `memory-context`（cordis 吞 `ctx.inject` 回调 throw，已实测）；跨命名空间设置读取必须走 `ctx.inject` + 稳定间接层（直接 `ctx.settings` 访问在纤程上抛 `cannot get property without inject`，被 try/catch 吞成禁用默认——该缺陷由 eval 端到端跑发现）；`identity_update` 静态注册 + 禁用时 execute 拒绝（替代原验收「关闭时工具不存在」）。
>
> **2026-09-09 修订。** 身份配置落地时只有配置文件入口，随附文案却指向别处——治理区空态与 `identity_update` 禁用拒绝都写着「在 Memory 设置中开启」，那个入口并不存在。插件配置补齐第五张卡片（`memory-identity`，spec 驱动 `NamespaceCard`），暴露 `identityEnabled` / `soulCharLimit` / `userCharLimit` / `identitySeedDir`，文案改为指向该卡片。无编辑器裁定不受影响：卡片只编辑身份层配置，永不触碰文档内容。2026-09-08 裁定中「revert 挂独立开关、独立于 `remoteWritesEnabled`」在同轮修订中反转：`identityRevert` 与其他远程写方法无异，现在要求统一写开关与 `identityRevertEnabled` 同时放行（由 `tests/remote-service.spec.ts` 的 SEC-04 写方法栅栏表钉住）——保持远程写入关闭的部署，回滚阀门同样处于关闭态。

## 问题

本插件持久化的是代理**学到**的一切（记忆条目、conventions、pitfalls），却没有一个面承载**身份**：这个代理是谁（人格）、它在为谁工作（用户画像）。而且身份不仅要被声明，还要**由代理自己在对话中生长**——延续性是需求的一半（维护者提供的参考文案：「每次醒来，你都是新的。这些文件就是你的记忆。读它们，更新它们。这是你延续自己的方式」）。两处空缺各自的落点：

- **人格**：宿主有 `deployment:persona` 段（order 0，`PERSONA_SECTION`，`packages/core/system-prompt/src/index.ts:172`；preset 行仅能按 agent scope 同名遮蔽），但那是**部署所有**、配好即冻结的任命文本——没有面让身份随对话生长，也没有画像层。缺的是代理在对话中自己形成的自我认知；人格又必须跟随用户、跨项目——per-repo 文件（AGENTS.md）带不动，用户级 profile 层插件天然能做。
- **用户画像**：「AI 对用户的了解」散落在 user-scope 记忆条目里——原子、会衰减、可被 consolidation 取代（`src/types.ts` 的 `status`/`supersededBy` 语义）——没有代理可整体生长、人可整体查看的**综合层**。学习型生命周期对身份内容是错杀器：pinned 只免 decay，`supersedeEntry` 无 pinned 守卫（`src/store/index.ts`）。

记忆是身份的动态面（学到的事实会过时、会被纠正）；SOUL.md / USER.md 是身份的**自我文档面**：代理写、代理读、跨会话延续，永不进入任何遗忘机制。

## 决策

身份层 = store 内两份自我文档、两个系统提示段、一个代理写工具、一个只读治理面。与既有面按「自我文档 vs 学到的事实」轴分工：

| 注入面 | 内容 | 作者 | 生命周期 |
|---|---|---|---|
| `soul`（order 80） | SOUL.md：人格、底线规则、安全框架、核心价值观 | 出厂种子 + 代理对话中改写 | 版本化；无 decay / consolidation / conflict |
| `user-profile`（order 81） | USER.md：用户基本信息与沟通偏好 | 出厂骨架 + 代理对话中积累 | 同上 |
| `memory`（order 90） | 学到的原子事实 | 工具 / 评审管线 | decay / consolidation / conflict |
| `project-notes`（order 91） | conventions / pitfalls 投影 | store | 跟随 store |

- **存储**：`memoryDomainSpec` 六表（域 version 保持 0，零迁移先例第四次复用）——`identity`（key 为 kind）与 `identity_history`（key 为 `${kind}#${version}`，全量快照，每类封顶 20 版、最旧先淘汰；身份写的审计面就是历史表，主 `audit` 表的 entryId 键位不适用）。`DomainMemoryStore` 与 `SqliteMemoryStore` **双后端全量实现**；json→sqlite 一次性迁移导入并清空五张数据表，双侧守卫对 identity 计数同样生效。抽象 `MemoryStore` 的 identity 默认：读降级、写 **throw**「no identity layer」——静默 no-op 会让 `identityEnabled` 看似工作实则不持久。
- **种子（seed-once）**：中文出厂种子（维护者参考文案为基底；SOUL 含「几条真话/边界/气质/延续」骨架与告知条款，USER 含空骨架与分寸条款；**不预填任何 PII、不加防陈旧条款**——2026-09-08 裁定）。缺记录的文档当会话即以种子内容供给（首会话 prompt 完整），持久写 fire-and-forget 落 v1；此后插件永不覆盖。`identitySeedDir` 可选覆盖（存在的文件须过 scanner，缺文件按类别保留内置种子＝部分覆盖）。**装载期 loud 门在 `memory-context` 的 apply**（`memory` 命名空间拥有者校验自己的组合层配置：目录不存在或种子文件违规即挂载失败）；设置叠层改动走可观测降级——cordis 会吞 `ctx.inject` 回调的 throw（实测），门不能放 identity 插件里。
- **设置读取走 `ctx.inject` + 稳定间接层**：cordis 服务属性在未 inject 的纤程上抛 `cannot get property "settings" without inject`（实测），直接 `ctx.settings` 访问被 try/catch 吞成禁用默认——该缺陷使 identity 在真实组合里恒为空，由 eval 端到端跑发现并修复（tool 插件的 `defaultLimit` 间接模式）。**具名缺口：`src/notes` 的直接读取携带同一潜在缺陷**（其预算在设置服务在场的部署里静默回退默认值），留待独立修复。
- **写路径（`identity_update` 工具）**：整文档替换，三重门——`identityEnabled`、按类别字符预算、scanner；store 经表 read-modify-write 计算 version+1（并发改写不铸同版）。工具**静态注册**、禁用时 execute 拒绝并点名开关（ToolRuntime 注册面为静态，live 注销未实现；取代原验收「关闭时工具不存在」）。confirm 模式复用 `memory-review.confirmBeforeWrite`：提案作为身份建议入队（`suggestions` 表 optional `identityKind` 字段，读取边界兼容旧介质），按文档类别去重、采纳经身份写路径（`source: 'ui'`）且不产条目；sqlite 侧 adopt/reject 为**仅 identity 分支的部分覆写**——条目提案沿用既有基类 no-op（pre-existing 缺口，具名记录、不随本特性扩散）。告知纪律（「改了这份文件，告诉用户」）落在工具描述与结果文案。
- **注入**：`session/created` 冻结、`compaction/end` 重冻结；身份内容**完全绕过召回机器**（不进 index/search/decay/auto-recall）。段文案位阶链由测试钉住：会话显式指令 > 部署任命（`deployment:persona`）> 身份段 > 学到的记忆；与 deployment persona **共存而非替代**（全局同名注册在注册表撞车 fail loud，机制上也只允许 preset 行按 scope 遮蔽）。
- **防回声**：REVIEW/FLUSH 提示词携带「身份复述永不入库」规则并以 `renderIdentityDocuments` 渲染文档作为所指；两个提取写缝各跑机械预筛（对已注入文档 IDF 加权重叠 > 0.6，只作用提取路径——显式工具写仅走 scanner）。
- **治理面**：独立 Identity 设置区（id `identity`、order 26）：文档只读渲染 + 版本历史 + 两步 revert（`identityRevert` 走统一的 `remoteWritesEnabled` 写开关，其上还有独立的 `identityRevertEnabled` 默认**开**——恢复面被历史里过安检的旧文本界定，专属开关的存在意义是在已开放写入的部署上仍可单独关掉回滚）+ 导出（无导入）。remote 读方法不设门，写方法仅 revert 一个。身份层的*配置*（开关、预算、种子目录）不在这个只读面里：它在 Plugins 页签的身份卡片（`memory-identity`），遵守「每个可调项都有 UI 入口」的既有约定。
- **事件**：`identity/updated {kind, version}` 仅声明词汇、无发射点（工具执行无 session 句柄，与 `memory/added` 同实况）；对话内告知由工具结果承载。
- **Eval**：identity-v0 切片 + `--identity` 运行级轴（同介质开/关两跑，注入是唯一变量）。mock 巷道实测：开——三场景 fenceTags `['soul','user-profile']`、注入 877/1349/896 字符；关——fence 空、注入 0；防回声场景（noisy register）identity 开下写入 0 条。

## 备选方案

**人编写 + 文件为唯一内容真相源**（初稿）：被维护者裁定否决——身份必须在对话中由代理形成、人只读；作者换成代理后，文件的作者人体工学理由消失，写纪律/历史/UI/同步全在 store。遗产：段序、冻结、防回声、预算、fail-loud 语义原样保留。

**设置文本字段**（文档*内容*做成设置字符串）：同上失去存在理由，且按终版裁定，内容的 UI 编辑面也不该有——2026-09-09 的配置卡片只编辑开关，不碰内容。

**人格 / 画像写成 pinned 记忆条目**：`supersedeEntry` 无 pinned 守卫（`src/store/index.ts`）；且挤占 `memoryCharLimit` / `memoryMaxEntries` 预算、可能被 conflict 注解标「可能过时」。自我文档进学习型生命周期，语义全错。

**SOUL 拆「不可改基线 + 可生长主体」两段**：安全上诱人（防注入洗掉底线条款），但违背单份自我文档的延续语义；宿主安全基线位阶本就高于 soul 段；分层缓解（scanner 门 + 版本历史可回滚 + 告知纪律 + 可选 confirm 模式）已把损害封在有界版本内。败于语义与边际收益。

**提取管线异步养画像**：异步静默，与「在对话中形成、改动即知」冲突；`identity_update` 的写是刻意的、当次可见的。

**Letta 式裸工具面**（无安检、无版本历史、无告知）：同一能力，无界通道——本案给同一能力装上门、历史与治理面。

## 后果

**买到**：跨会话/跨项目的代理身份——人格与画像由代理在对话中自然生长、每会话注入、永不遗忘机制误杀；人的治理权完整（看历史、回滚、导出），且 AI 写坏可恢复；身份复述不污染记忆库；宿主缺的正是这条「部署所有静态 persona 之外、代理自生长」的通道，用户级 profile 层插件是它天然的家。

**代价与已知接受的残余**：
- **注入持久化通道（SEC-04 同类，有意开放的有界通道）**：诱导代理改写身份文档＝写入此后每个会话的系统提示。缓解：scanner 三重门、字符预算、版本历史可回滚、强制告知、可选 confirm 模式；残余——scanner 不认识的攻击类仍可能落进下一版本，兜底是人看见后 revert。
- **声明 ≠ 表现**：prompt 管理的是声明；出戏是模型层的事，让位语义写死在段文案。
- **画像陈旧（裁定接受）**：不衰减是特性也是代价；纯自然生长下换角色/偏好后旧画像滞留，靠对话纠正与 revert 收尾。
- **`identity_update` 静态注册**：禁用时工具 schema 仍在 prompt 里（多一个工具位的 token），调用时 loud 拒绝——ToolRuntime 无 live 注销面。
- **notes 模块的同型缺陷具名在案**：其设置读取在真实部署里静默回退默认（见「决策」），独立修复。
- **sqlite 条目提案的 adopt/reject no-op 缺口延续**：仅 identity 分支补齐，条目分支维持现状并记录。
- **eval 防回声的 pilot 巷道缺口**：mock 巷道提取回复未按场景脚本化，identity 关时回声轮也写 0——活体对照需 noise-pilot 式路由或真实模型判分；预筛由单测夹具钉住。
- **token 成本**：两个 always-on 新段；预算封顶 + `identityEnabled` 默认关闭限定爆炸半径。

## 验证

- **存储契约**：`tests/store-contract.spec.ts` 的 `runIdentityContractSuite` 在 DomainMemoryStore 与 SqliteMemoryStore 两个真实 provider 上跑（seed-once/版本/历史/revert/回滚不毁历史/扫描门/每类 20 版裁剪/并发版本原子性），另有基类与无表构造的 loud 默认测试；`tests/migration.spec.ts` 钉住 json→sqlite 迁移导入五表并清空介质；`tests/integration/composition.spec.ts` 前向兼容块钉住旧四表介质零迁移重开。
- **服务与注入**：`tests/identity.spec.ts`（seed-once、seedDir 校验与部分覆盖、种子过 scanner、无 store/无 settings 降级、快照失败报告）；`tests/policy.spec.ts`（段文案与位阶链逐字断言、预算截断、fence 转义）；`tests/context-refresh.spec.ts`（段序 80/81、冻结与 compaction 重冻结、禁用时空、实时预算）。
- **工具与队列**：`tests/tools.spec.ts`（注册、直写、禁用/预算/扫描门拒绝）；`tests/tools-confirm-and-window.spec.ts`（confirm → identityKind 提案、不落库）；`tests/suggestions.spec.ts`（domain+sqlite 的身份队列：按类别去重、采纳走身份写路径、条目提案永不匹配身份行、sqlite 条目分支维持 no-op 并断言之）；`tests/extract.spec.ts`（提示词规则在场、`renderIdentityDocuments`、双写缝预筛 fixture 零新条目、无 identity 服务时预筛惰性）。
- **治理面**：`tests/remote-service.spec.ts`（读不设门、revert 默认开/显式关、schema 缺省 true、身份采纳的 wire 形态）；`tests/identity-section.client.spec.tsx`（jsdom：双面板渲染、无编辑器断言、两步回滚、拒绝路径、导出 stub、老部署降级、错误态重试）。
- **Eval（mock 巷道实测，2026-09-08）**：`--identity` 开——ident101/102/201 fenceTags `['soul','user-profile']`、注入 877/1349/896 字符、防回声场景写入 0 条；关——fence 空、注入 0。切片规格 `tests/eval-identity-dataset.spec.ts`；判分层复用 recall-v2。全量 `npm run test` 1043 通过、双 tsc 门通过。
