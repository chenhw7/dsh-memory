# 宿主 API 工程契约（IMPLEMENTATION 契约文档，P1-6）

> 对应 `docs/memory-plugins-comparison-zh.md` §四 P1-6：借鉴 agent-memory 的「取证回写」纪律——本插件依赖的每一条宿主 API 结论都附 harness 源码 `文件:行号` 出处，harness 升级时按图索骥核对回归，而不是靠踩坑重发现。
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

**契约要点**：
- section `text` 可以是 `(context) => string` 函数，**每次组装时求值**——KV-cache 冻结靠我们自己把快照存进 per-session WeakMap，而不是宿主保证。
- 同名 section 靠 scope shadowing；重复注册同名全局段会抛错，effect disposer 必须交给 `ctx.effect()` 管理。
- 渲染期 `{{var}}` 引用未知变量直接 throw——我们的段文案不含变量引用，若将来加，需同时注册 variable。

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
| 客户端模块扫描器只发现**根导出行**的 dsh.client（子路径跳过） | 本仓库踩坑记录：root 包 no-op 行见 `src/index.ts` 尾注 |

## 9. 升级核对清单（harness bump 时过一遍）

1. §1 KvTable 接口形状 / 域 version 语义是否变化；
2. §2 installSettingsSection hooks 形状（setSource/onChange）是否变化；
3. §3 AssembleContext.agent 是否仍透传给 section text 函数；
4. §4 compaction/end 的 `error` 字段类型与 shadowedSeqs 回放路径；
5. §4 agent/pre-step 的 payload/决策形状；
6. §6 finish reason 枚举与 BlockAssembler API；
7. §7 typertRemote 绑定发现机制、保留方法名清单、信任围栏语义；
8. §8 slots 契约键名与 scanner 根导出行为。
