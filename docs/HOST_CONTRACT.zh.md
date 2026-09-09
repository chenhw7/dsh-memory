# 宿主 API 工程契约（IMPLEMENTATION 契约文档，P1-6）

> 对应 `docs/archive/memory-plugins-comparison-zh.md` §四 P1-6：借鉴 agent-memory 的「取证回写」纪律——本插件依赖的每一条宿主 API 结论都附 harness 源码 `文件:行号` 出处，harness 升级时按图索骥核对回归，而不是靠踩坑重发现。
>
> 取证基准：`~/deepseek-harness` @ 2026-08（本插件 devDeps 对应 rc.5–rc.8 线）。行号会随后续版本漂移；**符号名 + 文件路径是主锚点，行号是辅助定位**。

## 1. 存储：storage-domain KV

| 依赖 | 出处 |
|---|---|
| `defineDomain(spec)` | `packages/storage/storage-domain/src/spec.ts:79` |
| `domainTable<K,V>(zodSchema)` | `packages/storage/storage-domain/src/spec.ts:63` |
| `KvTable` 接口（get/entries/keys/size/put/delete，读同步写串行） | `packages/storage/storage-domain/src/domain.ts:42` |
| `ctx.storageDomain.open(spec)` 打开域；表为声明式快照迭代器 | 同上 domain.ts |

**契约要点**：
- 域 `version: 0` 保持不变即可零迁移新增表——storage-json 只读已声明的表，缺失表按空 map 初始化。我们据此先后无迁移地加了 `audit` 与 `suggestions` 两张表（集成测试 `tests/integration/composition.spec.ts` 的 pre-audit 重开用例在守护这条）。
- 表记录是不可变值：返回的是存储对象本体，禁止原地修改，必须 `put` 整条替换。
- zod schema 在**持久化读取边界**校验，不在 put 时复检——schema 枚举扩容要兼容旧介质上的旧枚举值。

## 2. 设置：settings 命名空间与热更

| 依赖 | 出处 |
|---|---|
| `settingsNamespace(value)`（kebab-case 品牌字符串） | `packages/settings/settings/src/index.ts:26` |
| `installSettingsSection(ctx, ns, schema, entry, hooks)` | `packages/settings/settings/src/index.ts:863` |

**契约要点**：
- `installSettingsSection` 在 `settings` 服务可用时把组合入口注册为 base 层、把解析 thunk 换成 live scope；服务不可用时静默不装——所以**每个读配置点必须有组合入口 fallback**（review 插件的 `resolved()`、tool 插件的 `fromSettings()/confirmMode()` 都是此模式）。
- 跨命名空间读取（tool 读 `memory-review.confirmBeforeWrite`、review 读 `memory.decayDays`）用 `ctx.inject(['settings'], …)` + try/catch：目标命名空间未注册时抛错，catch 后落默认值。
- `onChange` 每次提交都会触发；处理器内**每次事件重读**配置即获得"改设置即刻生效、无需重启"。

## 3. 系统提示词注入

| 依赖 | 出处 |
|---|---|
| `SystemPrompt.section({name, order, text})` 注册有序段 | `packages/core/system-prompt/src/index.ts:381` |
| `assemble(context)` 组装（变量插值、排序、waterfall） | `packages/core/system-prompt/src/index.ts:467` |
| `AssembleContext`（含可选 `agent` 字段，段渲染函数借此拿 session） | `packages/core/system-prompt/src/index.ts:42` |
| `SECTION_ORDERS` 段序全景常量表（harness 自有段的名字→序号） | `packages/core/system-prompt/src/index.ts:121` |
| `PERSONA_SECTION`（`'deployment:persona'`，部署所有的人格槽位名） | `packages/core/system-prompt/src/index.ts:172` |

**契约要点**：
- section `text` 可以是 `(context) => string` 函数，**每次组装时求值**——KV-cache 冻结靠我们自己把快照存进 per-session WeakMap，而不是宿主保证。
- 同名 section 靠 scope shadowing；重复注册同名全局段会抛错，effect disposer 必须交给 `ctx.effect()` 管理。
- 渲染期 `{{var}}` 引用未知变量直接 throw——我们的段文案不含变量引用，若将来加，需同时注册 variable。
- **段序全景（2026-09-08 核实，身份层落位依据）：**`HARNESS_IDENTITY(-1000) → DEPLOYMENT_PERSONA(0) → PLAN_POLICY(500) → PTC_ONLY(800) → FILE_REFERENCE(900) → TOOL_*（1000+，工具段） → TOOLS_SDK(5000) → STRUCTURED_OUTPUT(9900)`。我们的段序：`soul`(80) / `user-profile`(81) 落在 deployment persona 之后、policy 之前的 0–500 带；`memory`(90) / `project-notes`(91) 同带；插件自有工具指引在 100–199。
- **`deployment:persona` 是部署所有的静态人格槽位**（`PERSONA_SECTION`，order 0；`dsh-persona` preset 行只能按 agent scope 同名遮蔽，全局同名注册在注册表处撞车 fail loud）。我们的 `soul` 段与它是**共存而非替代**关系；位阶链（会话显式指令 > 部署任命 > 身份段 > 学到的记忆）写进段文案并由测试钉住。

## 4. 会话事件面

| 事件 | 出处 | 我们的使用 |
|---|---|---|
| `session/created` / `session/disposed` | `packages/session/session-persistence/src/coordinator.ts:1118,1132`（同款消费先例） | 冻结快照、janitor、curator、dispose flush |
| `'compaction/end'`: `{compactionId; error?: string}` | `packages/compaction/compaction/src/types.ts:71` | 边界重冻结 + flush 触发（`error !== undefined` 时跳过） |
| `'compaction/summary'`: `shadowedSeqs` 可从 `session.events[seq]` 回放 | `packages/compaction/compaction/src/types.ts:33`、append 点 `compaction-basic/src/region.ts:447` | flush 提取被压缩的原文片段 |
| `'agent/pre-step'` waterfall：`{agent, messages, turn, step, signal}, next` → `PreStepDecision` | `packages/core/agent/src/runtime-types.ts:231` | 周期评审 drain + auto-recall fence（返回 `{kind:'enter', messages:[...]}` 追加消息） |

**契约要点**：
- `agent/pre-step` 是 waterfall：**必须 `return next()`** 放行或返回 enter 决策；任何异常都要自己吞掉，否则阻断步骤。
- `session/event` 监听器签名是 `(session, event)` 且需要 `{global: true}` 才能收到全部会话。

## 5. 投影累积器（session-projection）

| 依赖 | 出处 |
|---|---|
| `sessionProjections.register<K,S>(definition)` | `packages/session/session-projection/src/index.ts:223` |

**契约要点**：
- state 必须是可 JSON 化的纯数据（有 `stateSchema` 校验）；`stateVersion` 变更表示持久化投影结构升级（accumulator 目前 v2）。
- 该服务是**可选组合**：headless 装配没有它，`ctx.inject(['sessionProjections'])` 不触发即整体跳过。

## 6. LLM 调用纪律

| 依赖 | 出处 |
|---|---|
| `ctx.llm.stream(options): AsyncIterable<StreamChunk>` | `packages/llm/llm/src/index.ts:174` |
| `BlockAssembler`（chunk → blocks/finish） | `packages/llm/llm/src/assembler.ts:37` |
| `createUserMessage({content, source})` | `packages/llm/llm/src/message.ts:192` |

**契约要点**：
- provider/model 从 `session.requestHeader()?.config` 解析（fail-closed：缺一即拒调），override 字段非空才覆盖——三级路由回退与 agent-memory 同款。
- finish reason `error/aborted/max-tokens` 一律映射为 throw（对齐 compaction 的处理），由调用方决定重试策略：review drain 高水位不动等重试，flush fire-and-forget 吞掉。

## 7. Typert 远程服务与 /api 信任围栏

| 依赖 | 出处 |
|---|---|
| `@Remote(exportName)` 方法装饰器 | `packages/typert/protocol/src/index.ts:177` |
| `TypertRemoteService`（构造即 `super(ctx, ns)` 注册服务） | `packages/typert/protocol/src/index.ts:147` |
| 网关按 `typertRemote` 绑定做 source-mode 发现与分发 | `packages/api/gateway/src/index.ts:129,244,502` |
| `/api` 信任围栏（loopback/LAN 字面量/trustedHosts，防 DNS rebinding 与跨站） | `packages/client/connection/src/api-request-trust.ts:1-20` |

**契约要点**：
- **没有按方法的特权注册表**——写方法的安全边界就是传输层围栏本身；非 loopback 调用者根本到不了 RPC 层。
- 客户端 `$mount` 贡献物的描述符**方法名不得撞网关保留名**（`remove`/`has`/`empty` 等），且 fiber 不能 inject 自己挂的服务——这就是自产 namespace 走 `/api` RPC 直呼、`removeEntry` 改名的原因（见 `src/remote/index.ts` 头注释）。
- 单 `request` 参数的方法在线上载荷形如 `{args: {request: {...}}}`；无参方法是空 args。

## 8. 客户端挂载点（dsh.client 声明）

| 依赖 | 出处 |
|---|---|
| bundle patch 清单字段 `dsh.bundle.patch`（cordis.patch.yml 即包本体） | `packages/bundle/base/src/index.ts:3`、`web-app/src/index.ts:3` |
| `settings.section` slot（根级 list，id/order/label/inject） | `packages/client/ui-settings/src/client/contract/slots.ts:53` |
| `settings.plugin.item` slot（Plugins 页卡片） | `packages/client/ui-settings-plugins/src/client/index.ts:79,83` |
| 卡片分发规则：插件配置页按「slot key ∈ Host 已注册 settings namespace」逐 namespace 分发 | `packages/client/ui-settings-plugins/src/client/tab-store.ts:89-91`（`served.has(entry.options.key)`，served 来自 `settings.describe` mirror）、`ConfigurablePluginsTab.tsx:37`（`entryKey: ns`，一 namespace 一次分发） |
| keyed 槽位每个 key 只渲染**第一个**匹配条目 | `packages/client/ui-renderer/src/client/scoped-slots.tsx:800-806`（`find(e => e.options.key === entryKey)`） |
| 客户端模块扫描器只发现**根导出行**的 dsh.client（子路径跳过） | 本仓库踩坑记录：root 包 no-op 行见 `src/index.ts` 尾注 |

**契约要点**：
- `settings.plugin.item` 是 keyed 槽位，契约即"卡片 key = 它编辑的 settings namespace"（`ui-settings-plugins/src/client/slot-contract.ts:3-10`）。插件要在 Host 侧注册同名 settings namespace（`settings.installSection`），浏览器侧用同一个 key 注册卡片，tab 才会把两者配对；key 不是已注册 namespace 的卡片**静默不可见**（不报错、不进列表）。
- 多张卡共享一个 namespace 无法工作：keyed 槽位只取第一个匹配条目，其余条目永不渲染。插件若要多卡，必须每卡注册自己的 namespace（本仓库四个 memory 家族 namespace 即此形态，见 [Agent Note](../.agents/notes/implemented/bug-fix/2026-09-09-plugin-cards-need-served-namespaces.zh.md)）。
- 该规则自 ui-settings-plugins 的 namespace-pairing 设计起即存在（dsh-v0.1.1-rc.2 与 dsh-v0.1.2-alpha.1/2 均已强制）；harness 升级时按 §9 清单核对卡片 key 与 namespace 注册的一致性。

## 9. 日志通道：cordis 内置 `ctx.logger`

| 依赖 | 出处 |
|---|---|
| `ctx.logger: LoggerService`（Context 内置属性，无需 inject） | `@deepseek-ai/cordis` 包 `lib/types/context.d.ts:27` |
| `LoggerService` 形状：`(name?) => Logger` 可调用 + `error/info/warn/debug` 方法 | 同包 `lib/types/logger.d.ts:77-87` |

**契约要点**：
- 本插件的失败上报接缝（`MemoryStore.reportFailure`：warn 一条 + `health().backgroundFailures` 计数）走这个通道；`src/notes/cleanup.ts` 的迁移日志也在此归并（不再用 `console.log`）。
- 消息统一 `dsh-memory: <site> failed[: error]` 格式，与 harness 各包（hooks-claude-code 等）「包名前缀 + 单条模板字符串」的既有用法一致；该服务在 cordis core 而非 harness 仓库，升级核对以 npm 包版本为准。

## 10. 升级核对清单（harness bump 时过一遍）

1. §1 KvTable 接口形状 / 域 version 语义是否变化；
2. §2 installSettingsSection hooks 形状（setSource/onChange）是否变化；
3. §3 AssembleContext.agent 是否仍透传给 section text 函数；`SECTION_ORDERS` 表是否有新增/改序条目落在我们的 0–500 带内（soul 80 / user-profile 81 / memory 90 / project-notes 91），`PERSONA_SECTION` 名称是否变化；
4. §4 compaction/end 的 `error` 字段类型与 shadowedSeqs 回放路径；
5. §4 agent/pre-step 的 payload/决策形状；
6. §6 finish reason 枚举与 BlockAssembler API；
7. §7 typertRemote 绑定发现机制、保留方法名清单、信任围栏语义；
8. §8 slots 契约键名与 scanner 根导出行为；
9. §9 `ctx.logger` 服务形状（severity 方法集、Exporter 管道）是否变化。
10. §11 宿主 engines 下限仍覆盖 `node:sqlite` 免 flag 线（≥22.13）——SQLite 后端全部前提。

## 11. 本地介质：插件自有的 `memory.db`（SQLite 后端）

| 依赖 | 出处 |
|---|---|
| `node:sqlite` 的 `DatabaseSync`（同步 API：open/prepare/exec/transaction） | Node 内置模块，自 22.13.0 起免 `--experimental-sqlite` flag |
| 宿主 engines 下限 `^22.19.0 \|\| >=24.0.0` | `~/deepseek-harness` 仓库根 `package.json:8-10`（2026-09-05 取证）——≥22.19 蕴含 ≥22.13，`node:sqlite` 对受支持的宿主恒可用 |

**契约要点**：
- **所有权与边界**：`$DSH_HOME/storages/memory.db` 是本插件命名并完全拥有的新文件（写入路径 `dshHomePath` 惯例，同 `memory.json`）；宿主 storage-json 对它零感知——它不在宿主的 descriptor 清单里，宿主备份/清理逻辑不触碰它。宿主拥有的 `memory.json` 与插件拥有的 `memory.db` 的分界：配置 `storage: 'host-medium'`（默认）时一切数据仍只在 `memory.json`；`storage: 'sqlite'` 时全量数据与整合 meta 都在 `memory.db`，`memory.json` 只留迁移标记。
- **WAL 伴生文件**：`memory.db-wal` 与 `memory.db-shm` 是 SQLite WAL 模式的固有产物，与主库同生共死；卸载语义 = 删除 `memory.db` 即完整卸载（伴生文件随连接关闭自动回收，残留空伴生文件无害）。宿主若提供 storages 目录的清理工具，须把这三个文件视为一个单元。
- **experimental 状态**：22.x–24.x 首次使用会向 stderr 打一条 `ExperimentalWarning: SQLite is an experimental feature…`——这是 Node 进程级的 warning 通道输出，不影响 stdout 的 JSON-RPC 帧协议；25.7.0 起升 release candidate 不再打。升级核对时确认宿主对 stderr 的断言（若有）容忍该行。
- **API 面最小化**：只用 `DatabaseSync` 的 open/prepare/exec（± transaction helper）；`StatementSync` 的迭代语义封在 `SqliteMemoryStore` 之后，不外泄。API 漂移由 §10 清单第 11 项核对。
- **并发语义**：WAL + `busy_timeout`；单写者语义由集成测试钉死（`tests/integration/composition.spec.ts` 的 SQLite 重开用例）。
