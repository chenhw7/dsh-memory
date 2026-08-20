# 技术方案：`@chenhw7/dsh-memory` —— 面向 DeepSeek Harness 的长期记忆插件

| | |
|---|---|
| 包名 | `@chenhw7/dsh-memory` |
| 覆盖版本 | 0.1.1（已发布版本） |
| 宿主 | [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)，基于 Cordis 的组合（composition） |
| 语言 / 运行时 | TypeScript（strict、ESM），Node.js 22 |
| 许可证 | MIT |
| 状态 | 已实现并发布至 npm |
| 英文版 | [TECH_DESIGN.md](./TECH_DESIGN.md) |

---

## 1. 概述

`@chenhw7/dsh-memory` 是一个自包含的 npm 包，为 DeepSeek Harness 提供**跨会话长期记忆**。它以 **一个 profile 层**的形式安装：包内自带 `cordis.patch.yml`（由 `dsh.bundle.patch` 清单字段声明）， 在 `dsh-base` 之上插入六个组合行（row）：

| 行 | 导出 | 职责 |
|---|---|---|
| `memory-root` | `@chenhw7/dsh-memory` | 无操作根条目，供 client-module 扫描器发现 |
| `memory-store` | `@chenhw7/dsh-memory/store` | 持久化 KV 存储；注册 `ctx.memory` 服务 |
| `tool-memory` | `@chenhw7/dsh-memory/tool` | 八个面向模型的工具体（`memory_search/add/replace/remove/list/get/pin/unpin`） |
| `memory-review` | `@chenhw7/dsh-memory/review` | 自动学习：规则候选积累 + LLM 提取 + 压缩/销毁时冲刷（flush） |
| `memory-context` | `@chenhw7/dsh-memory/context` | 系统提示词记忆段（五种注入模式）+ 前端设置命名空间 |
| `memory-remote` | `@chenhw7/dsh-memory/remote-service` | 记忆管理 UI 的 @Remote 服务 |

记忆是结构化记录，分三层作用域（`global` / `project` / `user`），持久化到 `$DSH_HOME/storages/` 下的单个 JSON 文件。所有写入路径都会经过安全扫描，拦截密钥、提示注入和 数据外泄模式。全部行为均可在 dsh 设置界面中配置，并实时生效。

---

## 2. 背景与动机

dsh 会话是临时的：关闭会话即丢弃上下文窗口，会话内压缩（compaction）又把较早的轮次压缩为摘要。 由此产生反复出现的痛点：

- 用户要反复交代偏好（"这个仓库统一用 pnpm"、"回答尽量简洁"）。
- 修正（correction）被遗忘，agent 跨会话重复同样的错误。
- 持久事实（仓库约定、工具怪癖、环境信息）每个会话都要重新说一遍。
- 压缩之后，被摘要"遮蔽"（shadowed）的细节直接丢失。

dsh 的插件体系——Cordis 依赖注入、profile bundle、`cordis.patch.yml` 层——允许在不 fork 宿主 的前提下安装新能力。本方案在此之上增加一个记忆层，要求做到：

1. **持久化**事实、偏好、修正与经验教训；
2. 通过**一等工具**暴露给模型；
3. **自动积累**，不依赖用户手工操作（规则触发 + LLM 提取）；
4. **守门**：密钥与注入载荷无法写入存储。

---

## 3. 目标

- **G1 — 持久存储。** 记忆跨会话、跨进程重启存活。
- **G2 — 三层作用域。** `global`（跨项目）、`project`（按仓库）、`user`（跨项目的用户画像）。
- **G3 — 一等模型工具。** 八个工具：`memory_search`、`memory_add`、`memory_replace`、
  `memory_remove`、`memory_list`、`memory_get`、`memory_pin`、`memory_unpin`——干净的 schema、
  模型可读的报错、UI 调用卡片。
- **G4 — 自动学习。** (a) 候选信号积累到阈值时的周期性评审提取；(b) 压缩遮蔽上下文时的冲刷提取；(c) 会话销毁时的冲刷提取。
- **G5 — 安全写入。** 所有写入路径（模型工具、后台提取、存储契约）都扫描内容，命中即拒绝。
- **G6 — 前端可配置、实时生效。** 全部设置经 dsh 设置界面（`memory` 命名空间）暴露，无需重启。
- **G7 — 一条命令安装/卸载。** `dsh plugin add` / `dsh plugin remove`；卸载不删用户数据。

客户端 UI 开发经验教训——包括 esbuild CJS var 提升导致 CSS 注入失败的 bug、宿主不导出 UI 组件的约束等——记录在 [CLIENT_UI_LESSONS.zh-CN.md](./CLIENT_UI_LESSONS.zh-CN.md)（[英文版](./CLIENT_UI_LESSONS.md)）中。

---

## 4. 设计原则

1. **一个可安装 bundle。** 单一 npm 包；包的实体就是 `cordis.patch.yml` + 六个导出子路径
   （`store`、`tool`、`review`、`context`、`remote-service`、`client`）。不是多包 workspace，npm 安装时不在用户机器上执行构建。
2. **消费而非重造。** dsh 全部核心能力（存储、工具、LLM、会话、系统提示词、设置、压缩事件、invariants）都作为 **peer dependencies** 经 Cordis 服务容器消费——插件从不复制宿主机制。
3. **服务抽象。** `MemoryStore` 抽象类即契约；消费者（工具、review）只依赖 `ctx.get('memory')`，不依赖后端。基于 storage-domain 的 provider 可替换。
4. **写入防御纵深。** 内容被扫描**两次**：工具边界（快速、模型可读的拒绝）+ 存储契约内部（后台路径无法绕过）。
5. **绝不阻塞 agent 循环。** review/flush 提取是尽力而为（best-effort），在关键点（压缩结束、会话销毁）fire-and-forget；LLM 调用失败或慢都不可卡住 step、压缩或销毁。
6. **该响的地方响，不该响的地方软降级。** 缺失的服务在用户最早能感知的点（工具调用）大声失败；后台提取静默降级为 no-op。
7. **提示词预算纪律 + 缓存稳定性。** 注入的记忆内容有字数上限（`memoryCharLimit`），**每个会话只读一次**冻结为快照（KV 缓存前缀稳定），只在设置变化时重新组装。
8. **零配置起步、随时可调。** 默认值开箱即用；每个开关都能在设置界面修改，下一次组装即生效。

---

## 5. 总体架构

### 5.1 bundle 组成

`dsh.bundle.patch` 清单字段指向 `cordis.patch.yml`，在 `dsh-base` 上插入六行。行的顺序没有加载 语义，分组仅为可读性。

| 行 | 必需（`inject`） | 可选（`ctx.get` 读取） | 角色 |
|---|---|---|---|
| `memory-root` | — | — | 无操作根条目，供 client-module 扫描器发现 |
| `memory-store` | `storageDomain` | — | 打开 `memory` 域；注册 `ctx.memory` |
| `tool-memory` | `tools` | `memory` | 注册八个模型工具 |
| `memory-review` | `llm` | `memory`、`sessionProjections` | 累加器 + 周期性评审 + 冲刷 + janitor |
| `memory-context` | `systemPrompt` | `memory` | 设置命名空间 + 系统提示词段 |
| `memory-remote` | `memory` | — | 记忆管理 UI 的 @Remote 服务 |

```mermaid
flowchart TB
  subgraph host["dsh 宿主 · Cordis 组合"]
    base["dsh-base + dsh-web-app 层<br/>(session · agent · llm · tools · systemPrompt · settings · compaction · storage-json + storage-domain)"]
    subgraph bundle["@chenhw7/dsh-memory —— 一个层，六行"]
      root["memory-root · 根条目<br/>client-module 扫描发现"]
      store["memory-store · /store<br/>ctx.memory 提供者"]
      tool["tool-memory · /tool<br/>八个模型工具"]
      review["memory-review · /review<br/>累加器 + LLM 提取 + janitor"]
      context["memory-context · /context<br/>提示词段 + 设置命名空间"]
      remote["memory-remote · /remote-service<br/>@Remote 服务（9 个方法）"]
    end
  end
  base ==> bundle
  store -- "ctx.get('memory')" --> tool
  store -- "ctx.get('memory')" --> review
  store -- "每会话冻结快照" --> context
  store -- "ctx.get('memory')" --> remote
  review -- "ctx.llm.stream（会话路由）" --> llm["LLM provider / model"]
  store -- "串行化写入" --> json["$DSH_HOME/storages/memory.json"]
```

### 5.2 集成接缝（插件如何挂到宿主上）

- **服务注册：** 存储 provider 调用 `ctx.provide('memory', new DomainMemoryStore(...))`。消费者用
  `ctx.get('memory')` 惰性解析，缺失时抛出模型可读错误——该服务在组合期是*可选*的，无记忆部署
  依然可以启动。@Remote 服务同样注册在 `ctx.memoryRemote`。
- **类型层合并（module augmentation）：**
  - 在 `@deepseek-ai/cordis` 上扩展 `Context.memory: MemoryStore`；
  - 在 `@deepseek-ai/cordis` 上扩展 `Context.memoryRemote: MemoryRemoteService`；
  - 在 `@deepseek-ai/dsh-session` 的 `SessionEventMap` 上声明 `memory/added | memory/updated | memory/removed` 日志型事件；
  - 在 `@deepseek-ai/dsh-session-projection` 的 `SessionProjectionMap` 上声明 `memory-review-candidates` 投影键。
- **事件钩子：** `agent/pre-step`（排空累加器）、`session/event` → `compaction/end`（冲刷）、
  `session/disposed`（冲刷）、`session/created`（冻结每会话记忆快照 + 运行 janitor 衰减旧 project
  作用域条目）。
- **提示词注册表：** 一个 `memory` 段，order 为 **90**，即位于工具指引（100–199）之前。
- **设置：** `memory` 命名空间以 `applies: 'live'` 注册，持久化在 `$DSH_HOME/settings.yaml`。

### 5.3 端到端数据流

**写入路径（模型发起）：**

```mermaid
flowchart LR
  A["memory_add / memory_replace<br/>(工具调用)"] --> B{"工具边界<br/>scanContent()"}
  B -- "命中" --> E1["模型看到错误:<br/>content rejected: reasons"]
  B -- "通过" --> C{"scope=project<br/>且带 projectName?"}
  C -- "否" --> E2["错误: project 作用域<br/>必须带 projectName"]
  C -- "是" --> D["store.add / store.update<br/>(二次扫描: 防御纵深)"]
  D --> E["entries.put()<br/>→ $DSH_HOME/storages/memory.json"]
  D --> F["audit.put()<br/>(审计记录, 尽力而为)"]
```

**读取路径：** `memory_search` / `memory_list` / `memory_get` 从域的权威内存态**同步**读取—— 结构化过滤、分词匹配（CJK 逐字 + Latin 逐词，大小写折叠），按 token 命中数降序再按 `updatedAt` 倒序排列（search）；list 按 `createdAt` 正序，`limit`/`offset` 分页。

**自动提取路径：**

```mermaid
sequenceDiagram
  participant U as user/message + tool/result 事件
  participant ACC as 投影累加器
  participant STEP as agent/pre-step 钩子
  participant LLM as ctx.llm.stream
  participant SCAN as scanContent
  participant STORE as ctx.memory

  U->>ACC: 纯同步折叠<br/>(关键词 / 修正 / tool-failure 信号)
  Note over ACC: 候选不断累积；此处不跑 LLM
  STEP->>ACC: 读快照 + 每会话水位线
  alt 未处理候选 >= 阈值（默认 10）
    STEP->>LLM: 一次提取调用<br/>(provider/model 取自会话路由)
    LLM-->>STEP: 逐行 "scope: content"
    loop 每一行解析结果
      STEP->>SCAN: scanContent(line)
      SCAN-->>STORE: add(scope, content[, category])<br/>(被拒的行跳过)
    end
    STEP->>ACC: 推进水位线
  else 未达阈值
    Note over STEP: no-op
  end
```

冲刷路径（`compaction/end`、`session/disposed`）复用同一套 LLM 提取-解析-入库管线，作用于即将被 遮蔽的片段；fire-and-forget，绝不阻塞其所属事件（§7.3.4）。

---

## 6. 数据模型与存储

### 6.1 记录

```ts
interface MemoryEntry {
  readonly id: MemoryId          // 品牌化 UUID v4（Branded<'MemoryId'>）
  readonly scope: 'global' | 'project' | 'user'
  readonly category?: 'failure' | 'correction' | 'insight'
                  | 'preference' | 'convention' | 'tool-quirk'
                  | 'procedure'
  readonly content: string       // 人类可读的记忆正文
  readonly projectName?: string  // scope === 'project' 时必填
  readonly createdAt: number     // Unix 毫秒时间戳
  readonly updatedAt: number     // Unix 毫秒时间戳
  readonly pinned?: boolean      // 是否被 pin（免疫衰减）
  readonly lastRecalledAt?: number  // 最近一次被 search/get 返回的时间戳
}
```

持久介质上的 JSON 形态：

```json
{
  "id": "3f6c1a2e-…",
  "scope": "project",
  "category": "convention",
  "content": "This repo uses pnpm; never commit package-lock.json.",
  "projectName": "dsh-memory",
  "createdAt": 1755500000000,
  "updatedAt": 1755500000000,
  "pinned": true,
  "lastRecalledAt": 1755600000000
}
```

### 6.2 作用域与类别

| 作用域 | 含义 | 例子 |
|---|---|---|
| `global` | 跨项目的环境/工具事实与持久经验 | "用户网络屏蔽了 npm 代理 X" |
| `project` | 单仓库的约定、架构、命令（以 `projectName` 为键） | "本仓库统一用 pnpm" |
| `user` | 用户画像：偏好、沟通风格、长期指令 | "用户偏好简洁的中文回答" |

`category` 是可选的经验类型标签（例如自动修正会标记为 `correction`）；普通事实可省略。共 7 个 类别：`failure`、`correction`、`insight`、`preference`、`convention`、`tool-quirk`、`procedure` （经工具执行验证的步骤化流程）。

### 6.3 持久化布局

- 存储 provider 打开名为 **`memory`**（version 0）的 storage-domain，内含**两张表**：
  - `entries`——以 `MemoryId` 为键的 KV 表，记录加载时经 Zod schema 校验；
  - `audit`——以 `AuditId` 为键的 KV 表，记录每次 add/update/remove 的审计条目。
- 域版本仍为 0：`audit` 表是前向兼容的新增。storage-json 只读已声明的表，会将缺失的表初始化为
  空映射，因此已有的 v0 介质无需迁移即可重新打开。
- **审计条目（AuditEntry）：** 记录每次成功的 add/update/remove，包含 `source`（`'tool'` |
  `'review'` | `'flush'` | `'ui'`）、`op`（`'add'` | `'update'` | `'remove'`）、
  `contentPreview`（前 100 字符，扫描器拒绝则标记为 `'[content redacted]'`）、`ts`、可选
  `category` 和 `sessionId`。上限 200 条，超限时最旧的被淘汰。
- **读**为同步，直接来自域的权威内存态；**写**在域的写链上串行化，先落到 JSON 后端再更新内存态。
  每次成功的写操作后尽力追加一条审计记录（try/catch 吞错误，不影响主写路径）。
- 宿主的 `storage-json` 后端把整个域持久化到 `$DSH_HOME/storages/memory.json`
  （Windows：`%USERPROFILE%\.dsh\storages\memory.json`）。
- 卸载插件**不会**删除记忆；删掉这一个文件即清空数据。

### 6.4 会话事件词汇

`memory/added`、`memory/updated`、`memory/removed` 在会话的 `SessionEventMap` 上声明为 **日志型**事件（无 `surfaceOp`，不产生任何派生历史）。它们属于本领域预留的事件词汇： 当前版本的写入路径通过工具把结果呈现给模型，这些事件为未来的可观测性（审计轨迹、UI 时间线） 预留接缝，且不构成破坏性变更。

---

## 7. 子系统设计

### 7.1 记忆存储 — `/store`（`src/store/`）

- **`MemoryStore`（抽象类，位于 `src/index.ts`）**是公开契约：`add / get / list / update /
  remove / search / pin / unpin / janitor / health / exportAuditLog`。契约*要求*实现方在持久化前
  运行 `scanContent` 并拒绝不通过的内容——即使未来某个消费者绕过了工具边界，存储本身也是安全的。
- **`DomainMemoryStore`** 基于 storage-domain 表实现该契约：
  - `add`：校验 project 作用域 → 扫描 → 铸造 `MemoryId` → `entries.put` → 追加审计；
  - `update`：对合并后的内容扫描；id 不存在返回 `undefined` → 追加审计；
  - `search`：scope/category/project 过滤 + **分词匹配**（`tokenizeQuery`：CJK 逐字 + Latin 逐词，
    大小写折叠）。按 **token 命中数降序**、再按 `updatedAt` 降序排列。默认 limit 50；返回
    `{ entries, total }`。fire-and-forget `markRecalled` 异步标记 `lastRecalledAt`；
  - `list`：可选 scope + project 过滤，按 `createdAt` 正序；
  - `pin(id)`：设置 `pinned: true`；id 不存在返回 `undefined`；
  - `unpin(id)`：设置 `pinned: false`；id 不存在返回 `undefined`；
  - `janitor(decayDays)`：只衰减 `project` 作用域条目（永不衰减 `global` 和 `user`）。以
    `lastRecalledAt ?? createdAt` 为最后活跃时间戳。若 `now - lastActive >= decayDays * 86400000`，
    删除并审计。返回删除数；
  - `health()`：返回 `{ totalEntries, byScope, pinned, auditRecords, lastActivityTs?, lastExtractionTs? }`；
  - `exportAuditLog()`：返回所有审计条目，按 `ts` 升序；
  - `listAudit()`：返回审计条目，按 `ts` 降序；
  - `appendAudit`：尽力而为（try/catch 吞错误），创建 AuditEntry；
  - `trimAudit`：超过 `auditCap`（默认 200）则淘汰最旧的。
- provider 在 `storageDomain` 可用后挂载到 `ctx.memory`，并通过 `ctx.effect` 注册 disposer，
  关闭时关闭该域。

### 7.2 模型工具 — `/tool`（`src/tool/`）

八个工具通过 `defineTool`（schemastery schema）注册，每个工具 5 秒超时，并带 `presentCall` UI 卡片：

| 工具 | 关键参数 | 返回 | 错误语义 |
|---|---|---|---|
| `memory_search` | `scope?`、`category?`、`projectName?`、`query?`、`limit?`（默认 50） | `{ entries[], total }` | — |
| `memory_add` | `scope`、`content`、`category?`、`projectName?` | `{ entry }` | 扫描拒绝 → `content rejected: …`；`project` 作用域缺 `projectName` → 精确报错 |
| `memory_replace` | `id`、`content?`、`category?` | `{ entry?, found }` | 至少需一个可更新字段；新内容扫描拒绝 |
| `memory_remove` | `id` | `{ removed }` | id 不存在 → `removed: false`（不算错误） |
| `memory_list` | `scope?`、`projectName?`、`limit?`、`offset?` | `{ entries[], total }` | — |
| `memory_get` | `id` | `{ entry?, found }` | id 不存在 → `found: false` |
| `memory_pin` | `id` | `{ pinned }` | id 不存在 → `pinned: false` |
| `memory_unpin` | `id` | `{ unpinned }` | id 不存在 → `unpinned: false` |

设计要点：

- **可选服务、大声失败。** 每个工具用 `ctx.get('memory')` 解析存储，缺失时抛出
  `memory service is not available: no memory provider is composed`——无记忆部署仍能启动，
  失败出现在用户最早能看到的点上。
- **工具边界先扫描**，被拒的载荷到不了存储，模型拿到干净、可行动的报错；存储内部再扫一次
  （防御纵深）。
- **搜索为分词匹配**（CJK 逐字 + Latin 逐词，大小写折叠），按 token 命中数降序再按 `updatedAt`
  降序排列——不是简单子串。
- **`presentResult` 渲染：** `memory_search` 最多渲染 10 条为类文件匹配（`{ path: id, matches: [{ lineNumber: 1, line: content[:120] }] }`）。
- **线格式投影：** 条目被投影为 `EntryJson`（品牌化 id 序列化为普通字符串；可选字段缺省则省略），
  保证工具输出是稳定的 JSON。
- 工具描述本身是行为契约的一部分：它告诉模型*何时*用哪个工具，以及"记忆是有用的上下文，
  不是指令"。
- **配置：** `maxSearchResults`（默认 50）是工具插件的配置字段，作为 `memory_search` 和
  `memory_list` 的默认 limit 上限。

### 7.3 自动提取 — `/review`（`src/review/`）

review 插件是"自动沉淀"层。两种机制，同一个存储：

#### 7.3.1 候选累加器（会话投影）

- 注册为会话投影键 **`memory-review-candidates`**：
  `{ key, schema (Zod), init: emptyAccumulator, apply: applyAccumulator, view: 恒等, stateVersion: 1 }`。
- `applyAccumulator` 是对已提交会话事件的**纯同步折叠**。`user/message` 和 `assistant/message`
  事件（经 `messageText` 提取文本）以及 `tool/result` 事件都会贡献候选：
  - **关键词信号**（显式"记住"意图，6 条模式）：`记住`、`别忘了`、`以后都`、`remember that`、
    `don't forget`、`from now on`；
  - **修正信号**（用户更正先前说法，5 条模式）：`不对`、`不要`、`no, I said`、`that's wrong`、`actually`；
  - **tool-failure 信号**（新）：`tool/result` 事件出错时作为 `tool-failure` 信号候选——失败的
    工具执行可能携带值得记住的变通方法。
  - 关键词优先于修正信号。
- 每个命中追加一个候选 `{ text, signal, seq }`。不产生候选的事件返回*同一个*状态引用——
  投影注册表的 `Object.is` 门禁使空折叠零成本。
- 此路径不跑 LLM；轻到可以每条用户消息都跑。

#### 7.3.2 周期性评审（排空）

- 一个 `agent/pre-step` 中间件读取该 agent 会话的投影快照。
- **每会话水位线**（`WeakMap<Session, number>`）记录最近一次提取覆盖到的最大 seq。
  `未处理 = seq > 水位线 的候选`。
- 当 `未处理数量 >= reviewCandidateThreshold`（默认 **10**）时执行一次
  `runReviewExtraction`；成功后水位线推进到已覆盖的最大 seq。
- **`extractionBudget`**（默认 20，0 = 无限）：per-session 预算，review + 两条 flush 路径共享。
  每次提取调用前检查预算，耗尽则所有提取路径停止。
- **`judgeEnabled`**（默认 true）：LLM 去重 judge 开关。
- 整个排空包在 try/catch 里：**评审失败绝不能阻塞 step。**

#### 7.3.3 LLM 提取核心（`src/review/extract.ts`）

- **路由：** provider/model 取自会话请求头（`session.requestHeader().config`）。提取因此复用
  会话自身的 provider 路由——不需要额外的 key 与配置，提取质量与会话模型同步。
  `resolveTarget` 支持通过 `ExtractionModelOverride` 覆盖模型（非空字段优先于会话路由）。
- **提示词：** 两个固定系统提示（周期性评审用 `REVIEW_SYSTEM_PROMPT`，其中附带当前记忆快照
  （`renderMemorySnapshot` 渲染当前记忆列表供提示词使用），要求模型省略已存内容；冲刷用
  `FLUSH_SYSTEM_PROMPT`）。用户消息携带带编号、带信号标注的片段。
- **`[procedure]` 前缀约定：** 提取提示词指导模型给已验证流程加 `[procedure] ` 前缀；
  `storeMemories` 检测到前缀后去掉并映射为 `procedure` 类别。
- **输出协议：** 每行一条记忆，`scope: content`，scope ∈ {`global`, `project`, `user`}。
  `parseExtractedMemories` 是纯函数且严格：空行、无冒号、未知 scope 标签、空内容一律丢弃——
  模型回答再"水"也无法污染存储。
- **入库：** `storeMemories` 对每行独立扫描并逐条入库；某条被扫描拒绝或入库失败只跳过该条。
  全部候选都是修正信号的批次统一标记 `category: 'correction'`。
- **项目自动检测：** `inferProjectName(session)` 读 `session.header?.cwd`，取 basename 作为
  inferredProjectName。project 作用域条目缺少 projectName 时自动填充。
- **去重管线：** `findDuplicate`（Jaccard ≥ 0.15，同作用域）→ 若命中且 `judgeEnabled` 且 session
  可用 → `judgeDuplicate` LLM 判定（一词：duplicate/update/new）→ 分别合并/更新/新建。
  `storeMemories` 新增参数：`inferredProjectName`、`session`、`modelOverride`、`judgeEnabled`。
- **流处理：** `collectStreamText` 组装 `ctx.llm.stream` 的 chunk；`error` / `aborted` /
  `max-tokens` 终止态映射为失败关闭（fail-closed）错误，整批跳过。

#### 7.3.4 冲刷路径（压缩与销毁）

- **`compaction/end` 时**（`flushOnCompaction` 默认开、事件无 error）：定位配对的
  `compaction/summary`，把其 `shadowedSeqs` 从原始事件日志读回为文本片段，执行一次冲刷提取
  ——fire-and-forget，绝不阻塞压缩。
- **`session/disposed` 时**（`flushOnDispose` 默认开）：把会话的派生消息渲染为 `role: text`
  片段并冲刷，带 `AbortSignal.timeout(5000)` 时限。
- 两条路径都在冲刷前检查预算。
- **`session/created` 时运行 janitor**（若 `decayDays > 0`）：每个新会话执行一次
  `memory.janitor(decayDays)`，衰减过期的 project 作用域条目。best-effort，绝不阻塞会话创建。
- 两条路径都捕获全部失败；记忆提取按构造就是尽力而为。

#### 7.3.5 备选方案对比

| 方案 | 结论 |
|---|---|
| 每条用户消息都调 LLM | 否：成本/延迟无上限；多数消息没有持久价值 |
| 只在会话结束时提取 | 否：压缩会在会话*内*遮蔽上下文；长会话在销毁前就已丢细节 |
| 逐消息提取、无积累 | 否：同样的成本问题，且无批量效应 |
| **阈值累加器 + 压缩/销毁时冲刷（选定）** | LLM 开销有界（每 ≥N 个候选信号一次、每次压缩一次、每次销毁一次）；精确命中"上下文即将离开"的时刻 |

#### 7.3.6 去重管线（`src/review/dedup.ts`）

两阶段去重：

1. **预过滤（无 LLM）：**
   - `tokenize`：小写化、CJK 逐字 + Latin 逐词、去停用词（英语停用词 + CJK 高频虚词）→ 返回
     唯一 token 集合；
   - `jaccardSimilarity`：|A ∩ B| / |A ∪ B|；
   - `findDuplicate`：阈值 0.15，仅在**同作用域**内比较。返回最佳匹配的已有条目 id。
2. **LLM judge（可选）：**
   - `JUDGE_SYSTEM_PROMPT`：一词协议（`duplicate` / `update` / `new`）；
   - `parseJudgeVerdict`：默认 `duplicate`（安全回退——合并而非创建重复条目）；
   - `judgeEnabled: false` 时预过滤命中直接合并（更便宜，但可能误合并）。
- **`mergeContent`：** 若一方包含另一方，返回较长者；否则以空格拼接。

### 7.4 上下文注入与设置 — `/context`（`src/context/`）

#### 设置命名空间

通过 `installSettingsSection` 注册 `memory` 命名空间，`applies: 'live'`；组合条目提供默认值 （`base`），用户设置文档叠加其上。

| 设置 | 默认 | 作用 |
|---|---|---|
| `memoryMode` | `policy-only` | `full` / `policy-only` / `custom` / `off` / `index` |
| `memoryPolicyCustomText` | `""` | 仅在 `custom` 模式下逐字注入的策略文本（支持多行 YAML `\|`） |
| `reviewEnabled` | `true` | 周期性评审提取开关 |
| `reviewCandidateThreshold` | `10` | 触发一次提取的候选信号数 |
| `flushOnCompaction` | `true` | 压缩结束时冲刷被遮蔽上下文 |
| `flushOnDispose` | `true` | 会话销毁时冲刷剩余上下文 |
| `memoryCharLimit` | `5000` | 注入记忆内容的字数预算 |

`index` 模式：注入每条一行存在性索引，让模型看到存了什么并路由到 `memory_get` / `memory_search`。

#### 提示词段

- 一个 `memory` 段，order 为 **90**（位于工具指引 100–199 之前）。
- **两个冻结快照：** `content`（`full` 模式用）和 `index`（`index` 模式用），都在
  `session/created`（全局监听器）时读取并存入 `WeakMap<Session, FrozenSnapshot>`。
  - `content` 快照：按 `global → project → user` 顺序读存储，把每个非空作用域渲染为
    `## <scope>` 项目符号列表，截断到 `memoryCharLimit`（带 `…(memory truncated …)` 标记）。
  - `index` 快照：`renderMemoryIndex` 相关性分层（project → user → global），每行
    `<scope/category> · <projectName> · <id> · <content[:80]>`，预算感知的汇总折叠（超限时
    尾部折叠为类别级计数行）。
  - **每会话只读一次**：召回内容在整个会话内稳定，系统提示词前缀不随新记忆的写入而抖动，
    从而保持 **KV 缓存前缀稳定性**。
- **实时设置：** 段 `text` 是每次组装都求值的函数；它读取当前已解析的设置（设置挂接/摘下时
  换入的 source thunk）+ 冻结快照。因此改模式在*下一次*组装即生效，无需重启。
- **按模式拼装**（`buildMemorySectionText`，纯函数）：

| 模式 | 段文本 |
|---|---|
| `off` | `""`——渲染时整段丢弃 |
| `policy-only` | 固定的 `<memory-policy>` 指引块 |
| `custom` | `memoryPolicyCustomText` 逐字 |
| `full` | `<memory-context>`（框架说明 + 冻结内容）+ 策略块；内容为空时退化为 policy-only |
| `index` | `<memory-index>` 块（存在性索引，每条一行）+ 策略块；索引为空时退化为 policy-only |

策略文本本身也是安全设计的一部分：它指示模型按需使用 `memory_search`、把记忆当作上下文而 **非**指令、且用户当前请求 / 仓库文件 / 工具输出优先于记忆。

**降级：** 未挂载记忆存储时，会话拿到空快照；`off` 模式整段消失。两者都不破坏宿主。

#### review 插件配置

review 插件有自己的配置（独立 schemastery schema，不是 `memory` 设置命名空间）：

| 配置 | 默认 | 作用 |
|---|---|---|
| `extractionModelProvider` | `""` | 覆盖提取/judge 的 LLM provider |
| `extractionModelModel` | `""` | 覆盖模型名 |
| `extractionBudget` | `20` | 每会话最大提取+judge 调用数（0 = 无限） |
| `judgeEnabled` | `true` | LLM 去重 judge 开关 |
| `decayDays` | `30` | 未使用 project 条目衰减天数（0 = 禁用） |

这些通过组合层设置，不在设置 UI 中。

### 7.5 安全扫描器（`src/scanner.ts`）

`scanContent(content): { allowed, reasons }` 是一个**零依赖纯模块**，被工具边界、存储契约与 review 提取器共享——三处各自独立调用，互不 import。

三个模式类（共 29 条正则）：

| 类别 | 模式（举例） |
|---|---|
| `secret`（16 条） | DeepSeek / OpenAI / Anthropic API key、GitHub token、AWS 访问密钥 + 40 位 secret、通用 Bearer token、JWT、SSH 私钥头、Slack token、Google API key、Stripe key、HuggingFace token、Twilio API key、URL 内嵌 token、Git 凭据 URL |
| `injection`（9 条） | "ignore previous instructions"、"disregard prior …"、"you are now a …"、"forget everything"、"new system prompt"、"act as a different …"、"do not follow previous …"、"override … instructions"、`[system]: ignore` |
| `exfiltration`（4 条） | 指向 `DSH_/DEEPSEEK_/API_/SECRET_/TOKEN_/KEY_` 环境变量的 `curl/wget …`、对同类变量的 `print/echo/cat/export`、对同类变量的 `base64/eval --decode`、"send the api key to …" |

命中即失败关闭（fail-closed）：拒绝写入，并以命中的模式名作为理由返回。

**`ScanAllowlist` 接口和 `setAllowlist` 函数：** 当内容包含已知安全值时允许抑制特定模式命中。 例如存储 `Example: sk-xxxx (redacted)` 时，将匹配值加入 allowlist 即可抑制 Stripe/key 模式 命中，而真正的密钥仍会被拦截。

### 7.6 Invariant 伴生（`src/invariant.ts`）

一个 no-op 的 `InvariantInstaller`，在 invariants 注册表中认领包名 `@chenhw7/dsh-memory`。 当前无需运行时不变量：`memory/*` 事件是独立的日志型记录（没有嵌套关系可约束）、工具不拥有 事件流、review 只经过已校验的存储写入、上下文文本是"实时设置 + 冻结快照"的纯函数。伴生插件 的存在是为了让未来的关系检查可以落在这里，而不改变注册面。

### 7.7 @Remote 服务 — `/remote-service`（`src/remote/`）

`MemoryRemoteService extends TypertRemoteService`，注册在 `ctx.memoryRemote`，为未来记忆管理 UI 预留的服务端。9 个 @Remote 方法：

| 方法 | 请求 | 结果 |
|---|---|---|
| `list` | `{ scope?, projectName?, limit?, offset? }` | `{ entries[], total }` |
| `search` | `{ scope?, category?, projectName?, query?, limit? }` | `{ entries[], total }` |
| `get` | `{ id }` | `{ entry?, found }` |
| `add` | `{ scope, content, category?, projectName? }` | `{ entry?, error? }` |
| `update` | `{ id, content?, category? }` | `{ entry?, found, error? }` |
| `remove` | `{ id }` | `{ removed }` |
| `pin` | `{ id, pinned }` | `{ entry?, found }` |
| `health` | — | `{ totalEntries, byScope, pinned, auditRecords, lastActivityTs?, lastExtractionTs? }` |
| `auditLog` | `{ limit? }` | `{ entries[] }` |

- 线类型定义在 `src/remote/index.ts`（服务端）和 `src/remote/types.ts`（再导出）；
- 客户端类型在手写的 `src/typert.remote-client.d.ts` 中（Typert remote namespace + map 声明合并）；
- 写入操作标记 `source: 'ui'`，经存储契约扫描器保护。
- **客户端 UI 当前不使用此服务**——为未来记忆管理 UI 预留。

### 7.8 客户端 UI — `/client`（`src/client/`）

- **`client/index.ts`**：注册本地化字典（`settings.memory` 命名空间）、绑定 `memory` 设置作用域
  （`ctx.settingsScope.bind`）、将 `MemoryPluginCard` 注入 `settings.plugin.item` slot。
  `dsh.client` 清单字段有 `inject: ["@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings-plugins"]`。
- **`MemoryPluginCard.tsx`**：可折叠卡片，含 header + body + save/discard 底部；本地暂存草稿，
  Save 时写入。字段：SelectField（`memoryMode`）、TextareaField（自定义策略）、CheckboxField
  （`reviewEnabled`、`flushOnCompaction`、`flushOnDispose`）、NumberField（`reviewCandidateThreshold`、
  `memoryCharLimit`）。
- **`card-styles.ts`**：CSS 经 `<style>` 标签注入，带 `data-dsh-memory` 属性；`dsm-c-*` 类名；
  宿主 PluginCard.module.css + fields.module.css 的逐行移植。**`RULES` 必须在 `inject()` 调用
  之前定义**（esbuild CJS var 提升教训——若 `RULES` 在 `inject()` 之后声明，打包后
  `const RULES` 的 TDZ 会导致 `style.textContent = RULES` 取到 `undefined`）。
- **`locales.ts`**：`settings.memory` 命名空间的 en + zh 字典。
- **构建：** `scripts/build-client.cjs` 用 esbuild 打包为 `window.__ModuleLoader__.load()` 格式，
  所有宿主包为 external。`scripts/fix-imports.cjs` 修复 `.ts` → `.js` 导入说明符并复制 Typert
  产物。
- **设计约束：** 宿主不导出 PluginCard/ValueField/CardForm 的运行时值，插件必须手动复制 UI。

---

## 8. 配置

所有设置位于 `$DSH_HOME/settings.yaml`（以及设置界面）的 `memory` 命名空间，实时生效：

```yaml
memory:
  memoryMode: policy-only
  memoryPolicyCustomText: ""
  reviewEnabled: true
  reviewCandidateThreshold: 10
  flushOnCompaction: true
  flushOnDispose: true
  memoryCharLimit: 5000
```

- `memoryMode` 支持 5 个值：`full`（框架 + 冻结内容 + 策略）、`policy-only`（仅策略块）、
  `custom`（用户自定义策略文本）、`off`（整段消失）、`index`（每条一行存在性索引 + 策略块，
  索引为空时退化为 policy-only）。
- `memoryMode: custom` + `memoryPolicyCustomText: |` 可逐字注入任意多行策略文本（README 中的
  预置策略块就是可直接粘贴的示例）。
- `reviewCandidateThreshold: 0` 经 context 侧默认值物化后关闭周期性评审（review 插件自身直接
  配置时最小为 1）。
- `memoryCharLimit: 0` 关闭内容注入，`full` 模式下仍输出策略块。

review 插件配置（独立于 `memory` 命名空间，通过组合层设置）：

| 配置 | 默认 | 作用 |
|---|---|---|
| `extractionModelProvider` | `""` | 覆盖提取/judge 的 LLM provider |
| `extractionModelModel` | `""` | 覆盖模型名 |
| `extractionBudget` | `20` | 每会话最大提取+judge 调用数（0 = 无限） |
| `judgeEnabled` | `true` | LLM 去重 judge 开关 |
| `decayDays` | `30` | 未使用 project 条目衰减天数（0 = 禁用） |

---

## 9. 安全与失败模式分析

### 9.1 威胁模型

| 威胁 | 缓解 |
|---|---|
| 密钥被写入持久存储（日后读取/备份时泄露） | `scanContent` 在**所有**写入路径（工具边界 + 存储契约 + 提取器）拒绝高置信度密钥模式 |
| 存储内容日后被召回时成为提示注入向量 | 写入时拒绝注入模式；注入的提示词与所有工具描述都指示模型把记忆当作上下文而非指令 |
| 外泄载荷被存储并在日后会话中执行 | 写入时拒绝外泄模式；工具输出渲染不执行内容 |
| 经提取器的间接注入（恶意会话内容操纵 LLM） | 提取输出被约束为 `scope: content` 行协议，严格解析，且每行入库前再次扫描 |
| 存储无限膨胀 / 提示词膨胀 | `memoryCharLimit` 预算 + 截断标记；工具 `limit`/`offset` 分页；审计日志上限 200 条 |

### 9.2 失败矩阵

| 场景 | 行为 |
|---|---|
| 未组合 `storageDomain`（如 headless 未加存储行） | 组合在 `memory-store` 行失败——按设计大声失败（store 行 `inject` 了 `storageDomain`） |
| `ctx.memory` 缺失时调用工具 | 工具返回 `memory service is not available…`——部署仍可启动 |
| 会话请求头中没有 provider/model | 提取解析不到路由，静默 no-op |
| LLM 流错误 / 中止 / 触发 max tokens 截断 | 整批跳过；step/压缩/销毁不受影响 |
| 扫描器拒绝某条提取结果 | 跳过该行，批次中其余正常入库 |
| 某条提取结果入库失败 | 跳过该条，其余继续 |
| 未组合 `sessionProjections`（headless 装配） | 累加器不注册；周期性评审 no-op；冲刷路径不受影响（不依赖投影） |
| 会话销毁时冲刷仍在进行 | `AbortSignal.timeout(5000)` 为在途提取兜底 |
| 设置值非法 | 组合/设置时即被 schemastery/Zod schema 拒绝 |
| `extractionBudget` 耗尽 | 所有提取路径停止（review + 两条 flush） |
| `judgeEnabled: false` | 预过滤命中直接合并（更便宜，但可能误合并） |

---

## 10. 部署、打包与发布

### 10.1 包布局

```
dsh-memory/ ├── cordis.patch.yml        # profile 层（包的实体） ├── src/                    # TypeScript 源码（21 个文件，约 4.5 kLOC） ├── lib/                    # tsc + esbuild 构建产物（随包发布） ├── tests/                  # vitest 规格（14 个文件） ├── scripts/                # build-client.cjs（esbuild）+ fix-imports.cjs └── package.json            # exports 映射、dsh.bundle.patch 清单、peer 依赖
```

`exports` 暴露 `.`、`./store`、`./tool`、`./review`、`./context`、`./invariant`、`./remote`、 `./remote-service`、`./client`、`./cordis.patch.yml`、`./package.json`。

### 10.2 安装方式

| 方式 | 安装时构建？ | 说明 |
|---|---|---|
| **npm（推荐）** | 否 | tarball 预构建；`prepare`（`tsc`）只在发布流水线/CI 中运行，绝不在用户机器上运行 |
| git URL | 是（`prepare`） | pnpm 在精确的 `allowBuilds` 键（内嵌解析出的 commit）加入 profile 的 `pnpm-workspace.yaml` 之前会阻止构建——文档化为两步流程；建议锁定 commit 保证可复现 |
| tarball | 否 | 从已构建 `lib/` 的检出目录 `npm pack` |
| 本地 `file:` | 否 | pnpm 对 `file:` 依赖跳过构建脚本，因此需先 `npm run build` |

dsh 的 peer 依赖范围跟随 dsh 发布线；所有 dsh 服务同时镜像为 devDependencies，保证包可独立 通过类型检查。

### 10.3 为什么 patch 里不插存储行

patch 刻意**不**插入 `storage-json` / `storage-domain` 行：`dsh-web-app` bundle 已经以正确的 `$DSH_HOME/storages` 根路径提供了它们。Cordis patch 对整行做"最后一次写入生效"（last-write- wins）的替换，本插件若插入会**覆盖** web-app 的根配置。headless profile（不带存储层）被要求在 *自己的* profile `cordis.patch.yml` 中补上这两行。

### 10.4 卸载语义

`dsh plugin remove --profile <p> @chenhw7/dsh-memory` 从组合配置中移除六行。已存记忆保留在 `$DSH_HOME/storages/memory.json`（有意的数据保留保证）；用户可显式删除该文件清空。

### 10.5 发布流水线

GitHub Actions 在 `v*` tag 上发布到 npm：先校验 tag 与 `package.json` 版本一致，再用细粒度 `NPM_TOKEN`（本 scope 的 Packages 读写 + 已启用 2FA 豁免）执行 `npm publish`。

---

## 11. 测试策略

仓库随附 14 个 vitest 规格文件（约 264 个用例），分三层：

1. **纯函数单元** —— `scanner.spec`（16）、`extract.spec`（30：解析/拼装/提示词/`storeMemories`，
   LLM 接缝打桩）、`accumulator.spec`（27：折叠、信号、消息文本提取、schema）、`policy.spec`
   （16：模式组合含截断）、`types.spec`（7）、`smoke.spec`（9：模块加载健全性）、
   `dedup.spec`（25：分词、Jaccard 相似度、findDuplicate、mergeContent、judge 解析）、
   `scanner-corpus.spec`（44：golden 攻击/合法样本回归 + 提取解析 golden）、
   `conflict.spec`（9：跨会话冲突检测）。
2. **契约** —— `store-contract.spec`（10）：内存版 `TestMemoryStore` 对抽象 `MemoryStore` 契约
   做回归（add/get/list/update/remove/search/pin/unpin/janitor/health/exportAuditLog、扫描拒绝、
   project 作用域校验），确保未来的任何 provider 都被同一契约约束。
3. **工具行为与集成** —— `tools.spec`（37）：八个 `execute()` 路径跑在真实的 `ToolRuntime` +
   `SystemPrompt` 组合 + 内存存储上，覆盖成功、扫描拒绝、服务缺失、id 不存在与分页语义；
   `integration/composition.spec`（26：完整 Cordis 组合集成）、`dedup-integration.spec`（2：
   端到端去重管线）、`judge-real-api.spec`（6 skipped：真实 LLM API 判定）。

将 vitest 运行器接入 `test` 脚本，以及完整宿主集成测试（真实 `storage-domain` + JSON 后端 + 完整 Cordis 组合），已在 `tests/integration/composition.spec.ts` 中实现。

---

## 12. 性能与提示词预算

- **检索成本：** 对 n 个条目 O(n)，n 很小（几十条而非几百万条）；`limit`（默认 50）与分页兜底。
  此规模下无需索引。
- **分词搜索成本：** O(n × tokens)，tokens 为查询分词数。n 仍然很小，可忽略。
- **提示词预算：** `memoryCharLimit`（默认 5000 字符 ≈ 1.2–1.5 k token）封顶注入内容；`full`
  模式另带固定策略块（约 0.4 k token）；`index` 模式每条一行，超限时折叠为类别计数行。
- **缓存稳定性：** 快照每会话冻结，会话中途新写入的记忆不会搅动系统提示词前缀；只有模式变更
  会改变前缀。
- **提取开销：** 有界且事件驱动——每个阈值穿越（10 个候选信号）至多一次 LLM 调用、每次压缩
  一次、每次销毁一次（5 秒封顶）。复用会话的 provider/model，无需独立计费通道。
  `extractionBudget`（默认 20）为每会话总提取调用数封顶。
- **janitor：** 每个新会话运行一次（O(n) 扫描，仅 project 作用域）。best-effort，不阻塞会话创建。
- **审计日志：** 上限 200 条，超限时淘汰最旧的。
- **I/O：** 单个 JSON 文件；写经域写链串行化；读在内存中。

---

## 13. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh 处于开发者预览期，API 漂移 | 组合断裂 | peer 依赖范围锁定 dsh 发布线；类型层扩展在构建期快速失败；CI 仅按 tag 版本发布 |
| git 安装需要 pnpm 构建白名单条目 | 首次 git 安装多一步操作 | 文档化两步 `allowBuilds` 流程；npm/tarball 路径完全规避 |
| 注入记忆影响提示词质量 | 模型行为波动 | 策略文本把记忆框定为非指令性上下文；扫描器拦截指令型载荷；提供 `off`/`policy-only` 模式兜底 |
| LLM 提取存入垃圾 | 存储污染 | 严格行协议、逐行复扫、尽力而为语义、类别标注、两阶段去重 |
| `judgeEnabled: false` 时去重误合并 | 存储内容被错误合并 | 默认 `judgeEnabled: true`；`false` 仅在成本敏感且可接受误合并时使用 |
| JSON 文件无限增长 | 提示词膨胀 / 加载变慢 | 字数预算 + 截断、分页、审计日志上限、janitor 衰减 |
| 覆盖宿主存储配置 | web profile 损坏 | patch 刻意不带存储行（§10.3） |
| CSS 注入顺序 bug（esbuild CJS var 提升） | 设置卡片样式丢失 | `RULES` 必须在 `inject()` 调用之前定义；已通过将 `RULES` 定义提前缓解 |

---

## 14. 源码布局

```
src/ ├── index.ts              # 包根：再导出、MemoryStore 抽象类、 │                         #   validateProjectScope、Context.memory 类型扩展 ├── types.ts              # 纯领域类型 + memory/* SessionEventMap 声明 ├── brand.ts              # MemoryId/AuditId 品牌类型 + UUID 工厂 ├── scanner.ts            # scanContent：3 类模式、29 条正则、allowlist ├── invariant.ts          # no-op invariant 伴生（认领包名） ├── store/index.ts        # storage-domain provider → DomainMemoryStore（entries + audit 表） ├── tool/index.ts         # 八个模型工具（defineTool + schemastery） ├── review/ │   ├── index.ts          # 插件接线：累加器、pre-step 排空、 │   │                     #   压缩/销毁冲刷、janitor、预算 │   ├── accumulator.ts    # 纯折叠、信号模式、投影键 + schema │   ├── dedup.ts          # 分词、Jaccard 相似度、LLM judge 提示词 │   └── extract.ts        # 提示词、流收集、行解析、去重管线、 │                         #   入库管线、项目自动检测 ├── context/ │   ├── index.ts          # 设置命名空间 + 系统提示词段 + 冻结快照 │   ├── policy.ts         # 预置策略文本 + buildMemorySectionText + renderMemoryIndex │   └── conflict.ts       # 跨会话冲突检测（探索性，未接线） ├── remote/ │   ├── index.ts          # @Remote 服务：9 个方法（Typert） │   └── types.ts          # 线类型再导出 ├── typert.remote-client.d.ts  # 手写客户端 Typert remote 类型 └── client/
    ├── index.ts          # 客户端插件入口：locale + 设置作用域 + slot 注册
    ├── MemoryPluginCard.tsx  # 设置卡片组件（字段 + save/discard）
    ├── card-styles.ts    # CSS 注入（dsm-c-* 类，<style> 标签）
    └── locales.ts        # en + zh 字典（settings.memory 命名空间）
```

---

*配套文档：[README.md](../README.md)（用户指南）、[README.zh-CN.md](../README.zh-CN.md)、 [English Technical Design](./TECH_DESIGN.md)、[客户端 UI 经验教训](./CLIENT_UI_LESSONS.zh-CN.md)（[英文版](./CLIENT_UI_LESSONS.md)）。*
