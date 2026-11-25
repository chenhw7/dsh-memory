# 宿主 API 工程契约（IMPLEMENTATION 契约文档，P1-6）

> 对应 `docs/archive/memory-plugins-comparison-zh.md` §四 P1-6：借鉴 agent-memory 的「取证回写」纪律——本插件依赖的每一条宿主 API 结论都附 harness 源码 `文件:行号` 出处，harness 升级时按图索骥核对回归，而不是靠踩坑重发现。
>
> 取证基准：DSH **0.2.2** 线（本插件 devDeps 钉 `0.2.2-rc.5`，peer 声明 `^0.2.2-rc.1`，`engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`）。取证方式是读已安装运行时的 `.d.ts` 与打包产物（`/Applications/DeepSeek Harness.app` 与 npm `@deepseek-ai/*@0.2.2-rc.5`）。行号会随后续版本漂移；**符号名 + 文件路径是主锚点，行号是辅助定位**。
>
> 0.1.x → 0.2.x 的破坏面（本次迁移的完整清单）：settings 由「命名空间注册 + 运行时 `get`」改为「每个 profile 条目自带 `Config`」；`dsh-invariants` 整包移除；`MessageSourceMap` 取消万能 `plugin` 类型、改由生产者各自声明；tool 结果不再是内容块而是独立的 tool 角色消息；`session.events` 同步读被废弃；`sessionProjections.register` 返回句柄；客户端设置传输 `settingsScope` 改为 `configForms`，插件配置页从「按命名空间分发的卡片」改为 Plugins 页的 `plugins.bundle.config` / `plugins.row.config` 槽位；工具执行必须在装配里挂一个 executor。

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

## 2. 设置：每个 profile 条目自带 `Config`

| 依赖 | 出处 |
|---|---|
| `export const Config = z.object({…})`（schemastery，插件模块导出） | 例：`dsh-storage-domain/lib/types/index.d.ts`（`export declare const Config: z<Config>`） |
| `apply(ctx, config)` 由 Loader 用 schema 默认值 → 组合 base → 用户层解析后调用 | `@deepseek-ai/cordis` 的 `Plugin.apply(ctx, config)` 签名（`lib/types/registry.d.ts`） |
| 普通字段的配置热更 = 该条目的 fiber 重启（`internal/update` waterfall 默认走 `fiber.restart()`），即**重新执行 `apply`**；`volatile` 字段不重启：loader 调 `updateVolatile` 就地更新 ref，并发出 `loader/volatile-update` | `@deepseek-ai/cordis` `lib/index.js`（`update()` / `_commitVolatile()`） |
| **设置线协议只投影含 `volatile` 字段的命名空间**：`SettingsForms.describe()` 用 `volatileForm(schema)` 过滤，没有 volatile 字段的条目整个缺席（写入也会以 `no volatile fields` 拒绝） | `dsh-settings/lib/index.js`（`describe()` / `volatileForm()` / `write()`） |
| volatile 字段在 `apply` 收到的 `config` 里是 live ref（`{ get(): T }`），必须 `.get()` 读取；普通字段仍是普通值 | `dsh-settings` 的 `plainConfig()` 处理 `isVolatile(value)`；`dsh-agent-default-model/lib/index.js`（`this.config.provider.get()`） |
| `SettingsForms`（`ctx.settings`）：只剩表单/线协议面（`describe`/`update`/`replace`/`mutate`/`configure`），**没有 `get`、没有 `installSection`** | `dsh-settings/lib/types/index.d.ts` |
| settings 命名空间 = profile 插件条目 id（`SettingsNamespace` 是条目 id 的品牌类型） | `dsh-settings/lib/types/types.d.ts` |

**契约要点**：
- **没有跨命名空间运行时读取**。插件只拿得到自己的 `Config`；兄弟插件共享的旋钮必须由拥有该条目的插件通过**服务**发布（本插件：store 发布 `ctx.memory.settings()`，notes 发布 `ctx.projectNotes.settings()`，identity 发布 `ctx.identity.settings()`，review 发布 `ctx.memoryReview.settings()`）。
- 条目 id 即设置命名空间，改名等于换命名空间：用户层里旧 id 下的覆盖会失效。`cordis.patch.yml` 的行 id 因此是稳定契约（`memory` / `memory-review` / `memory-identity` / `memory-notes` / `memory-autorecall`）。
- 热更分两档：普通字段触发 fiber 重启，`apply` 必须是可重入的（disposer 交给 `ctx.effect`）；`volatile` 字段就地更新 ref、不重启，因此插件必须**每事件读取**（本包的 resolver 经 `liveValue` 读取，同时接受宿主 ref 与测试普通值）。本包把设置页可编辑的字段全部声明为 volatile，`storage`/`entriesCap`/`crossProcessProbeMs`/`identitySeedDir` 等挂载期字段保持普通——改它们才重启条目。
- volatile 字段是设置页能被看到的**前提**：不声明 volatile 的条目不会出现在 `describe()` 里，`ctx.configForms` 也拿不到表单（本包 0.10.x 的全部设置 UI 曾因此不可见，0.11 起修正）。
- 0.1.x 的 `settingsNamespace()` / `installSettingsSection()` / `ctx.settings.get()` 全部已移除；`ctx.inject(['settings'], …)` 这条读配置路径不复存在。

## 3. 系统提示词注入

| 依赖 | 出处 |
|---|---|
| `SystemPrompt.section({name, order, text})` 注册有序段 | `packages/core/system-prompt/src/index.ts:381` |
| `assemble(context)` 组装（变量插值、排序、waterfall） | `packages/core/system-prompt/src/index.ts:467` |
| `AssembleContext`（含可选 `agent` 字段，段渲染函数借此拿 session） | `packages/core/system-prompt/src/index.ts:42` |
| `SECTION_ORDERS` 段序全景常量表（harness 自有段的名字→序号） | `dsh-system-prompt/lib/types/index.d.ts:123` |
| `DEPLOYMENT_PERSONA_PREFIX`(0) / `DEPLOYMENT_PERSONA_SUFFIX`(10200)（部署人格槽位带；0.1.x 的 `PERSONA_SECTION` 常量已改名） | 同上 |

**契约要点**：
- section `text` 可以是 `(context) => string` 函数，**每次组装时求值**——KV-cache 冻结靠我们自己把快照存进 per-session WeakMap，而不是宿主保证。
- 同名 section 靠 scope shadowing；重复注册同名全局段会抛错，effect disposer 必须交给 `ctx.effect()` 管理。
- 渲染期 `{{var}}` 引用未知变量直接 throw——我们的段文案不含变量引用，若将来加，需同时注册 variable。
- **段序全景（0.2.2 复核）：**`HARNESS_IDENTITY(-1000) → DEPLOYMENT_PERSONA_PREFIX(0) → PLAN_POLICY(500) → TEAM_POLICY(600) → PTC_ONLY(800) → FILE_REFERENCE(900) → TOOL_BASH(1000)…TOOL_COMPUTER_USE(3000)（工具段） → MCP_SERVERS(3100) → TOOLS_SDK(5000) → DELIVERABLE_FILE_REFERENCES(9000) → STRUCTURED_OUTPUT(9900) → HARNESS_SOURCE(10000) → WEB_SURFACE(10100) → DEPLOYMENT_PERSONA_SUFFIX(10200)`。我们的段序：`soul`(80) / `user-profile`(81) 落在 deployment persona 之后、policy 之前的 0–500 带；`memory`(6000) / `project-notes`(6001) 落在 TOOLS_SDK(5000) 之后、DELIVERABLE_FILE_REFERENCES(9000) 之前——compaction 重冻结只牵连前缀尾部，不牵连工具指引中段（易变度降序落位，OpenClaw `CONTEXT_FILE_ORDER` 同理）。
- **部署人格占 0 与 10200 两个端点**（`DEPLOYMENT_PERSONA_PREFIX` / `DEPLOYMENT_PERSONA_SUFFIX`；`dsh-persona` preset 行只能按 agent scope 同名遮蔽，全局同名注册在注册表处撞车 fail loud）。我们的 `soul` 段与它是**共存而非替代**关系；位阶链（会话显式指令 > 部署任命 > 身份段 > 学到的记忆）写进段文案并由测试钉住。

## 4. 会话事件面

| 事件 | 出处 | 我们的使用 |
|---|---|---|
| `session/created` / `session/disposed` | `packages/session/session-persistence/src/coordinator.ts:1118,1132`（同款消费先例） | 冻结快照、janitor、curator、dispose flush |
| `'compaction/end'`: `{compactionId; error?: string}` | `packages/compaction/compaction/src/types.ts:71` | 边界重冻结 + flush 触发（`error !== undefined` 时跳过） |
| `'compaction/summary'`: `{compactionId, summary, shadowedRange, shadowedSeqs, …}` | `dsh-compaction/lib/types/types.d.ts:35` | flush 提取被压缩的原文片段（`shadowedSeqs` 的原文由我们自己的 `session/event` 增量日志承接，见下） |
| `'agent/pre-step'` waterfall：`{agent, messages, turn, step, signal}, next` → `PreStepDecision` | `packages/core/agent/src/runtime-types.ts:231` | 周期评审 drain + 消息尾部注入（一次性清单 + 自动召回围栏，返回 `{kind:'enter', messages:[...]}` 追加至多一条消息） |

**契约要点**：
- `agent/pre-step` 是 waterfall：**必须 `return next()`** 放行或返回 enter 决策；任何异常都要自己吞掉，否则阻断步骤。payload 为 `{agent, messages, turn, step, signal, modelSelection}`（0.2 新增 `modelSelection`），`PreStepDecision` 为 `{kind:'reject'} | {kind:'enter', messages: UserMessage[], startsRequestSeries?}`。
- `session/event` 监听器签名是 `(session, event)` 且需要 `{global: true}` 才能收到全部会话。
- **`session.events` 已不存在**：`eventAt` / `snapshotEvents` / `ownEvents` 标注 `@deprecated`（"new calls are prohibited"）。需要被压缩区间原文的消费者要自己增量承接 `session/event`——本插件在 review 里维持一个有界 per-session 日志（seq→文本，上限 500；以及 compactionId→shadowedSeqs），`compaction/end` 时据此取片段。
- tool 结果不是内容块：`tool/result` 事件的 `data.message` 是 role `tool` 的独立消息，`content` 直接是文本块，调用 id 在 `data.message.toolCallId`。

## 5. 投影累积器（session-projection）

| 依赖 | 出处 |
|---|---|
| `sessionProjections.register<K,S>(definition): Promise<ProjectionHandle<S>>` | `dsh-session-projection/lib/types/index.d.ts:204` |
| `ProjectionHandle.stateOf(session): S`（登记返回的句柄是受支持的读路径） | 同上 `:31` |

**契约要点**：
- state 必须是可 JSON 化的纯数据（有 `stateSchema` 校验）；`stateVersion` 变更表示持久化投影结构升级（accumulator 目前 v2）。
- `register` 返回 **Promise\<handle\>**，且注册可能异步完成——调用方要保留句柄再发布消费者。注册表级的 `stateOf(session, key)` 已 `@deprecated`，本插件改走句柄。
- 该服务是**可选组合**：headless 装配没有它，`ctx.inject(['sessionProjections'])` 不触发即整体跳过。

## 6. LLM 调用纪律

| 依赖 | 出处 |
|---|---|
| `ctx.llm.stream(options): AsyncIterable<StreamChunk>` | `dsh-llm/lib/types/index.d.ts:174` |
| `BlockAssembler`（chunk → blocks/finish） | `dsh-llm/lib/types/assembler.d.ts:37` |
| `createUserMessage({content, source})` | `dsh-llm/lib/types/message.d.ts:192` |
| `MessageSourceMap`（merge-extensible，**没有万能 `plugin` 类型**） | `dsh-llm/lib/types/message.d.ts:101` |
| `ContentBlockMap`（`text/reasoning/image/file/tool-call/tool-addition/tool-removal`，tool 结果不在其中） | `dsh-llm/lib/types/types.d.ts:117` |

**契约要点**：
- **消息来源必须由生产者自己声明**：`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { '<kind>': { kind: '<kind>' } & ContextFormed } }`（本包集中在 `src/sources.ts`，声明 `memory-context` 与 `memory-review`）。0.1.x 的 `{kind:'plugin', plugin:'…'}` 已不存在。
- `ContextFormed` 的 `form` 是语义标签（`instructions`/`catalog`/`snapshot`/`notice`/`relay`/`recall`，可省略）：本包注入的 step 尾部消息用 `form:'snapshot'` 并给出 `sections`（`memory-digest` / `recalled-memory`），表示后一轮围栏取代前一轮。
- provider/model 从 `session.requestHeader()?.config` 解析（fail-closed：缺一即拒调），override 字段非空才覆盖——三级路由回退与 agent-memory 同款。
- finish reason `error/aborted/max-tokens` 一律映射为 throw（对齐 compaction 的处理），由调用方决定重试策略：review drain 高水位不动等重试，flush fire-and-forget 吞掉。

## 7. Typert 远程服务与 /api 信任围栏

| 依赖 | 出处 |
|---|---|
| `@Remote(exportName)` 方法装饰器 | `dsh-typert-protocol/lib/types/index.d.ts:177` |
| `TypertRemoteService`（构造即 `super(ctx, ns)` 注册服务） | `dsh-typert-protocol/lib/types/index.d.ts:147` |
| 网关按 `typertRemote` 绑定做 source-mode 发现与分发 | `dsh-api-gateway`（`typertRemote` 绑定发现） |
| `/api` 信任围栏（loopback/LAN 字面量/trustedHosts，防 DNS rebinding 与跨站） | `dsh-client-connection`（`api-request-trust`） |

**契约要点**：
- **没有按方法的特权注册表**——写方法的安全边界就是传输层围栏本身；非 loopback 调用者根本到不了 RPC 层。
- 客户端 `$mount` 贡献物的描述符**方法名不得撞网关保留名**（`remove`/`has`/`empty` 等），且 fiber 不能 inject 自己挂的服务——这就是自产 namespace 走 `/api` RPC 直呼、`removeEntry` 改名的原因（见 `src/remote/index.ts` 头注释）。
- 单 `request` 参数的方法在线上载荷形如 `{args: {request: {...}}}`；无参方法是空 args。

## 8. 客户端挂载点（dsh.client 声明）

| 依赖 | 出处 |
|---|---|
| bundle patch 清单字段 `dsh.bundle.patch`（cordis.patch.yml 即包本体） | `dsh-package-manifest/lib/types/types.d.ts`（`DshBundleManifest.patch`） |
| `dsh.client`：`platform` / `inject` / `immediately` / `external` | 同上（`DshClientManifest`） |
| `dsh.engines`：`dsh` / `node` / `npm` 版本要求（插件管理器据此拦截不兼容安装） | 同上（`DshEnginesManifest`） |
| `main` slot（根级 keyed，key = 侧栏面板 id；`layout.selectPanel` 对未注册 key 抛错） | `dsh-client-ui-layout/lib/types/client/index.ts`（`SlotMap['main']`） |
| `sidebar.panellist` slot（根级 list，id/order/label；owner props `{ size, active }`；图标经 `sidebar.panel.icon` 工厂按 `only: id` 渲染） | `dsh-client-ui-sidebar/lib/types/client/contract/slots.ts` |
| `settings.section` slot（根级 list，id/order/label/inject；本包不再使用——管理面在 `main` + `sidebar.panellist`） | `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` |
| `plugins.bundle.config` slot（keyed，bundle 页的配置区） | `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts` |
| `plugins.row.config` slot（keyed `<包名>#<行 id>`，单行配置页） | 同上 |
| `plugins.item` slot（官方插件卡，`view: 'summary' \| 'page'`） | 同上 |
| 配置视图 owner props：`{ view: 'summary' \| 'page', form?: { state: ConfigFormSnapshot, mutate } }` | 同上（`PluginConfigViewProps` / `ConfigPageForm`） |
| 客户端设置传输：`ctx.configForms.get<T>(entryId)` → `ConfigForm<T>`（`getSnapshot/subscribe/set/unset/mutate`），`ctx.configForms.whileServed([...], register)` | `dsh-client-ui-settings/lib/types/client/config-form.d.ts` |
| 客户端模块扫描器只发现**根导出行**的 dsh.client（子路径跳过） | 本仓库踩坑记录：root 包 no-op 行见 `src/index.ts` 尾注 |
| 扫描器把每个已装配行解析到**最近的 package.json**，并拒绝同一 package 由多个活动行解析到的组合（`multiple active Loader sources`）；多行 bundle 必须为每行目录写自己的 `package.json`（仅 name + `type: module`，不带 `dsh.client`） | `dsh-client-modules/lib/index.js`（`reconcilePackage()` / `locatePkgJson()`）；`dsh-ops/lib/components/*/package.json` 是先例 |
| 运行时外部模块只能解析「平台 seed 词」或「已装配且自带 client 半的包行」 | `dsh-client-modules/lib/client.js`（`makeRequire`：miss 即抛 "missed the module table"） |

**契约要点**：
- **0.1.x 的 `settings.plugin.item` 卡片 + `ctx.settingsScope.bind({namespace})` 组合已不存在**。0.2 的 Plugins 页把插件配置拆成三个槽位：`plugins.item`（官方插件卡，占位者专属）、`plugins.bundle.config`（**bundle 页的配置区**，按包名 keyed）、`plugins.row.config`（**单行配置页**，按 `<包名>#<行 id>` keyed）。bundle 自己的配置按文档归前两者，不得挤进 `plugins.item`。
- 本插件走 `plugins.bundle.config`：一张页面五个 section，每个 section 绑到对应条目的 `ConfigForm`（`ctx.configForms.get('memory')` 等）。页面只在 Host 至少服务其中一个条目时出现（`whileServed`），装配里没有这些条目就毫无痕迹。
- 写路径是一次 `mutate(ops, revision)`：整段草稿一次提交，revision 来自快照（Host 侧 CAS，过期即拒绝并回读）。
- 行标题/描述来自 `readPluginMeta(specifier)`：`<specifier>/locale/<lang>.json` 的 `meta.title` / `meta.description` 与可选的 `<specifier>/icon` 资源；子路径行没有自己的 locale 资源时回退到模块名。这就是本插件不逐行注册配置页（改走 bundle 页）的原因。
- 管理面（本包的 Memory / Identity 面板）走**左侧栏面板对**：`sidebar.panellist` 的 list `id` 就是 `main` 的 key，侧栏的按钮按 id 选中主面板页；面板行标题是 `label` 函数、图标只收 `{ size, active }`。`main` 的挂载会被 layout 保留（`retainMainPanels`），面板的 `load()` 必须幂等；`main` 面板要自己提供滚动容器，顶边按 `--dsh-frame-top-clearance`（48px 常量）留白、左侧按 `--dsh-frame-leading-clearance`（窗口控件条带挂载时才有值）让开。
- 多行 bundle 的 client 半只有**一次**发现机会：根行携带 `dsh.client`，其余子路径行的目录各自带一个独立 `package.json` 身份（本包由构建脚本 `scripts/fix-imports.cjs` 生成到 `lib/<row>/package.json`），扫描器才不会把它们都算成同一个 package。漏掉这一步时整个 bundle 的 client 半会被静默跳过（无错误弹窗，只是导航与配置页都不出现）。
- 客户端 bundle 的 `require` 只能命中平台 seed 词或已装配的包行；`dsh.client.inject` 里的包名必须真的存在于 Host 运行时，否则加载即抛错。

## 9. 日志通道：cordis 内置 `ctx.logger`

| 依赖 | 出处 |
|---|---|
| `ctx.logger: LoggerService`（Context 内置属性，无需 inject） | `@deepseek-ai/cordis` 包 `lib/types/context.d.ts:27` |
| `LoggerService` 形状：`(name?) => Logger` 可调用 + `error/info/warn/debug` 方法 | 同包 `lib/types/logger.d.ts:77-87` |

**契约要点**：
- 本插件的失败上报接缝（`MemoryStore.reportFailure`：warn 一条 + `health().backgroundFailures` 计数）走这个通道；`src/notes/cleanup.ts` 的迁移日志也在此归并（不再用 `console.log`）。
- 消息统一 `dsh-memory: <site> failed[: error]` 格式，与 harness 各包（hooks-claude-code 等）「包名前缀 + 单条模板字符串」的既有用法一致；该服务在 cordis core 而非 harness 仓库，升级核对以 npm 包版本为准。

## 10. 升级核对清单（harness bump 时过一遍）

1. §1 KvTable 接口形状 / 域 version 语义是否变化；`domainTable<K,V>(schema)` 的泛型推导是否仍由 spec 反推（本插件按 `Domain<typeof memoryDomainSpec>` 取表类型）；
2. §2 每个条目 `Config` 的解析语义（schema 默认值 → 组合 base → 用户层）、`volatile` 字段的就地热更路径（`updateVolatile` / `loader/volatile-update`）与设置线协议的 volatile 过滤（`volatileForm`）；本包 `resolveInjectionSettings` / `resolveNotesSettings` / `resolveIdentitySettings` / `resolveAutoRecallSettings` 的 fallback 是否仍必要；
3. §3 `AssembleContext.agent` 是否仍透传给 section text 函数；`SECTION_ORDERS` 是否新增/改序落在我们的两个落位带内（soul 80 / user-profile 81 的 0–500 带；memory 6000 / project-notes 6001 的 TOOLS_SDK 与 DELIVERABLE_FILE_REFERENCES 之间）；人格槽位常量名是否再次变化（0.1 的 `PERSONA_SECTION` → 0.2 的 `DEPLOYMENT_PERSONA_PREFIX`/`SUFFIX`）；
4. §4 compaction/end 的 `error` 字段与 `compaction/summary.shadowedSeqs` 是否仍在 summary 事件上、且 summary 先于 end；`session.events` 同步读是否已被彻底移除（本包已改用自建增量日志）；
5. §4 `agent/pre-step` 的 payload/决策形状（0.2 加了 `modelSelection`）；
6. §6 `MessageSourceMap` 的声明方式与 `ContextFormed` 的 `form` 取值；`ContentBlockMap` 是否再次变动（tool 结果是否仍为独立 tool 消息）；finish reason 枚举与 `BlockAssembler` API；
7. §7 typertRemote 绑定发现机制、保留方法名清单、信任围栏语义；
8. §8 slots 契约键名（`plugins.bundle.config` / `plugins.row.config` / `plugins.item` 的 key 规则，`main` 的 key ↔ `sidebar.panellist` 的 id 配对，`sidebar.panel.icon` 工厂的 owner props）、`ConfigPageForm` 形状、`ctx.configForms` 的方法集与 `whileServed` 语义、scanner 根导出行为与多行 bundle 的每行 package 身份规则、客户端可解析的外部模块表；
9. §9 `ctx.logger` 服务形状（severity 方法集、Exporter 管道）是否变化；
10. §11 宿主 `engines.node` 下限仍覆盖 `node:sqlite` 免 flag 线（≥22.13），`DatabaseSync` 的 open/prepare/exec（± transaction）形状未变——SQLite 后端全部前提；
11. §12 eval SDK 会话事件面——`request/header` 载荷与 `system/message` 提示词事件形状是否变化；必跑 `npm run eval:smoke`（该缝无类型护栏，漂移是静默 undefined）；
12. 工具执行：`ctx.tools.execute` 是否仍要求装配里挂 executor（`dsh-tool-executor-native` / `dsh-tool-executor-ptc`）——测试装配必须跟着挂，否则 76 条工具用例会以 `ToolExecutorUnavailableError` 集体失败。

## 11. 本地介质：插件自有的 `memory.db`（SQLite 后端）

| 依赖 | 出处 |
|---|---|
| `node:sqlite` 的 `DatabaseSync`（同步 API：open/prepare/exec/transaction） | Node 内置模块，自 22.13.0 起免 `--experimental-sqlite` flag |
| 宿主 engines 下限 `^22.19.0 \|\| >=24.0.0`（0.2.2 的 `@deepseek-ai/dsh` 包声明 `node: >=24.9.0`，二者取严） | `@deepseek-ai/dsh@0.2.2-rc.5` 的 `package.json.engines`——≥22.19 蕴含 ≥22.13，`node:sqlite` 对受支持的宿主恒可用 |

**契约要点**：
- **所有权与边界**：`$DSH_HOME/storages/memory.db` 是本插件命名并完全拥有的新文件（写入路径 `dshHomePath` 惯例，同 `memory.json`）；宿主 storage-json 对它零感知——它不在宿主的 descriptor 清单里，宿主备份/清理逻辑不触碰它。宿主拥有的 `memory.json` 与插件拥有的 `memory.db` 的分界：配置 `storage: 'host-medium'`（默认）时一切数据仍只在 `memory.json`；`storage: 'sqlite'` 时全量数据与整合 meta 都在 `memory.db`，`memory.json` 只留迁移标记。
- **WAL 伴生文件**：`memory.db-wal` 与 `memory.db-shm` 是 SQLite WAL 模式的固有产物，与主库同生共死；卸载语义 = 删除 `memory.db` 即完整卸载（伴生文件随连接关闭自动回收，残留空伴生文件无害）。宿主若提供 storages 目录的清理工具，须把这三个文件视为一个单元。
- **experimental 状态**：22.x–24.x 首次使用会向 stderr 打一条 `ExperimentalWarning: SQLite is an experimental feature…`——这是 Node 进程级的 warning 通道输出，不影响 stdout 的 JSON-RPC 帧协议；25.7.0 起升 release candidate 不再打。升级核对时确认宿主对 stderr 的断言（若有）容忍该行。
- **API 面最小化**：只用 `DatabaseSync` 的 open/prepare/exec（± transaction helper）；`StatementSync` 的迭代语义封在 `SqliteMemoryStore` 之后，不外泄。API 漂移由 §10 清单第 10 项核对。
- **并发语义**：WAL + `busy_timeout`；单写者语义由集成测试钉死（`tests/integration/composition.spec.ts` 的 SQLite 重开用例）。

## 12. eval 套件的 SDK 会话事件面

| 依赖 | 出处 |
|---|---|
| SDK 服务器把全部 `session/event` 原样转发为 `session.event` 通知（无过滤、无投影） | harness 仓库 `packages/sdk/server/src/server.ts:95-97`（2026-09-09 取证） |
| 系统提示词 = surface 第 0 号节点：`system/message` 事件，载荷 `{turn, step, message}`，`message` 为 role `system`、单 text block 承载渲染后的提示词正文；空 `content` ＝「没有系统提示词」；提示词不变不发新事件，变化时 replace 节点 0 | harness 仓库 `packages/core/agent-loop/src/agent.ts`（turn() 的提交点，紧随 `step/start`）、`.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md`（2026-09-06 合入） |
| `request/header` 事件只载 `{config, adapterDefaults?, tools?}`，**不含 `system`** | harness 仓库 `packages/core/session/src/request-header.ts`（`canonicalHeader`）、`packages/core/agent-loop/src/agent.ts:571`（append 点） |

**契约要点**：
- eval 的提示词捕获点在 `eval/harness/sdk-client.ts` 的 `collectSessionEvent`：折入 `system/message`（`messageText` 提取正文；空 content 节点读作空串而非缺失，`eval/boot.ts` 的 standing 回退才不会把一条已清空的提示词继续带下去）；提示词不变的轮次没有新事件，由 `lastSystemPrompt` 回退承接。
- 这条缝**没有类型护栏**——SDK 线界是无类型 JSON-RPC 帧（`SessionEventPayload` 只有 `type: string` + `data`），harness 事件面漂移在这里表现为静默 undefined（2026-09-09 实录：harness 移除 `header.system` 后，事件流完好而冒烟归因被「event missing」文案带偏）。§10 清单第 11 项是唯一防线，harness bump 时必跑 `npm run eval:smoke`。
