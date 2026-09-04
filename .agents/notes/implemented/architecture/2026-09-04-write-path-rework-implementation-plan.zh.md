# Agent Note: Memory write-path rework implementation plan

Status: implemented

[English](2026-09-04-write-path-rework-implementation-plan.md) | 中文

> 决策记录 [sqlite-backend-and-batch-consolidation](2026-09-04-sqlite-backend-and-batch-consolidation.zh.md) 的执行层姊妹篇。各阶段 2026-09-05 落地（提交 4d8796a → 53831d4）；本 note 记录实际建了什么、落在哪、如何验证——计划的 Step 结构保留，临时值替换为上线标定。

## Problem

母提案定案了改什么与否掉什么，但没有落点：改动落在哪个文件哪个符号、按什么顺序提交、每步用什么机械验证。写进母 note 会让决策记录随施工膨胀失焦（行号漂移、标定值回填）；不写则实施者要从零推导插入点。本 note 是母提案的执行层配套：每阶段排提交切片，每片列出插入点、测试写在哪、文档同步什么。行号以 2026-09-04 main 为快照锚点，漂移时按符号名找。

## Decision

阶段 1–3 以六个提交落地（另有 note 提交）；下方每个 Step 记录已上线的事实。

### 阶段 1：anchors + 双层批量整合

**Step 1.1 — 条目模型 + meta 表**（提交 4d8796a，后续 e6513d4）：
- `src/types.ts`：`MemoryEntry` 增 `anchors?: readonly string[]`、`status?: 'active' | 'superseded'`、`supersededBy?: MemoryId`（JSDoc 写明缺省语义：active、无锚、supersession 终态）；`AddMemoryInput`/`UpdateMemoryInput` 增 anchors 写入面。`status`/`supersededBy` 刻意不进 `UpdateMemoryInput`——只有整合 seam（Step 1.3 的 `supersedeEntry`）翻状态，矛盾条目的 status 与 `supersededBy` 因此恒原子成对。
- `src/store/index.ts`：zod 条目 schema 镜像三个 optional 字段；`memoryDomainSpec` 增第四张 `meta` 表（`MemoryMetaRecord` = `{ key: 'consolidation' | 'medium' | 'schema', value?, updatedAt? }`，`zod.looseObject`，表键携带子系统后缀约定如 `consolidation:lastRun`）；`DomainMemoryStore` 构造接第四表（无默认值位置参数——全部调用点编译期强制更新），暴露 `getMeta`/`setMeta`（失败记 `meta-write`）。
- 测试：`tests/store-contract.spec.ts`（字段往返 + meta 表 describe）、`tests/integration/composition.spec.ts`（旧 medium 零迁移打开；新字段 + 未知 meta key 读后写回不丢表）。TECH_DESIGN（双语）§6.1/§6.3 同改；README/SEQUENCE_DIAGRAMS 的表枚举修正为四表；sidecar 重录。

**Step 1.2 — 提取 schema + prompt**（提交 8121a2b）：
- `ParsedMemory` 增必填 `anchors: string[]`（空 = 无 tag）与可选 `projectName`；行尾 `[anchors: a, b, c]`/`[project: name]` tag 在 category/summary 之后自右向左解析（两 tag 相邻堆叠时 anchors 不是行尾，解析顺序钉死）；tag 剥离先于 scanContent 准入门；无 tag 旧格式解析结果一致。两个提取 prompt 增硬 token/仓库名规则；NO-OP 门不动。`storeMemories`/`suggestMemories` project 优先级：tag 优先、cwd 兜底、非 project scope 丢弃；空 anchors 数组等价缺省（绝不存 `[]`）。
- 测试：`tests/extract.spec.ts`（13 个新解析/优先级用例）、`tests/fixtures/extract-golden.ts`（+6 golden case，结构化断言新可选字段）。人审队列刻意不携带 anchors（`AddSuggestionInput` 不动）。

**Step 1.3 — 每轮整合层**（提交 54f422f）：
- 新 `src/review/consolidate.ts`：`selectConsolidationCandidates` 基于 bm25 原语（`CONSOLIDATION_SIMILARITY_THRESHOLD = 0.2` ∨ 共享 `ANCHOR_DF_CAP = 2` 锚点——模块常量，docstring 记录为何不进 Config；`MAX_CANDIDATES_PER_CALL = 20` 截断防护）；`CONSOLIDATE_SYSTEM_PROMPT` 带防过合并规则；`parseConsolidateVerdicts` 按 `<cN> <action> [targetEntryId] [content]` 行协议、offer-list fail-closed 到 `new`；`applyConsolidation` 应用四种动作（merge/update 走 `mergeContent` + `update`；conflict 先落新事实再弃用目标——不存在「旧条目已隐藏、新事实丢失」的窗口——并在批内 live view 记录翻转，同批后续 verdict 撞同一目标 fail-closed 到普通 add）。
- 弃用 seam：`MemoryStore.supersedeEntry(id, supersededBy)`（抽象 no-op），`DomainMemoryStore` 实现原子写 status + `supersededBy` + 调用方注解、幂等、以 source `'janitor'` 审计（`AuditSource` 枚举无 consolidation 成员）。
- 编排：`storeMemories` 拆共享归一化门，喂 two-tier 路径与 legacy dedup+judge 循环，由 review Config `consolidation`（默认 `'two-tier'`）选择；无候选批次零整合调用；三个提取触发点透传模式。
- 各面：standing 快照、existence index、auto-recall、`search` 过滤 superseded；工具面保持可见，带 `[superseded → <id>]` 注解与结构化字段。设置卡：consolidation 下拉 + en/zh locales。
- 测试：`tests/consolidate.spec.ts`（29 用例）；judge-path 与语料用例以断言零改动钉住 `'legacy-judge'` 开关；`tests/dedup.spec.ts` 零改动全绿。

**Step 1.4 — 周期性全库层**（提交 6b83cd5）：
- 新 `src/review/sweep.ts`：`rankForSweep`（hitCount 降序 → accessCount 降序 → last-use 降序；superseded/软衰减排除；top-N 上限）、`selectSweepPairs`（既有条目互比，只按共享 0.2 词面信号——每轮选择器的 parsed-vs-stored 形状不可迁移，且 anchors 在已按用量排序的集合上不增益）、`SWEEP_SYSTEM_PROMPT` + `buildSweepMessages`（`p<N>` 协议）、`parseSweepVerdicts`（target 限本对；被丢弃裁决 fail-closed 到不动作——不存在要落地的新事实，与每轮的 `new` 相反）、`applySweep`（merge 折入存活方；conflict 经同一 seam 弃用目标方、注解指向存活方）、`runSweepPass`（空候选集零 LLM 调用）、冷却对（`sweepCooldownOpen`/`stampSweepLastRun` 走 meta 键 `consolidation:lastRun`，两次之间 ≥1 小时）。
- 接线：review 插件的 `session/created` 监听跑启动趟（首次创建）与每 N 节奏（`sweepEveryNSessions` 默认 20），受 `sweepEnabled`（默认 **false**）与冷却门控；提取预算刻意不约束 sweep。Config `sweepTopN` 默认 20。设置卡 + en/zh locales。
- eval 机械层：`eval/mechanical.ts` 的 `duplicatePairCount`（每埋点事实第一条裁决之外的多余裁决数；judge 跳过为 null），以 `storage.duplicatePairs` 进 `eval/report.ts` 切片（求和非均值）。
- 测试：`tests/sweep.spec.ts`（25 用例，含零共享锚点 fixture——英文 rate-limit 对，实测重叠 0.24）；`tests/write-path-rework-acceptance.spec.ts`（5 用例：prog101 矛盾 → superseded + 标注、prog112 projectName + 锚点配对、审计出的 9/2 重复对基线——计数器读 11，报告「10 组重复对」的行文口径是受追踪事实集、计数器按每条多余裁决计——与语料契约 lint）。TECH_DESIGN/plan note 事实层随上线标定更新。

### 阶段 2：usage 反馈（hitCount）— 提交 fca0861

- `src/types.ts` + zod 镜像：`hitCount?`/`lastHitAt?`；`DomainMemoryStore.markHits` 经与召回盖章同一原子读改写递增，每批每条目至多一次（`ids` 内重复折叠——集合无重数）、含审计、`updatedAt` 不动；`MemoryStore` 抽象默认 no-op。
- memory-context：每会话 ledger（`sessionMemory` 旁的 WeakMap）在冻结时记录 standing 快照注入条目；auto-recall 围栏在其轮次替换之；`assistant/message` 监听跑 `computeHits`（作答对本条目 token 袋的 IDF 加权覆盖率——对条目袋取覆盖而非对称重叠），达 `hitSignalThreshold`（默认 **0.25**；实测带宽：真实复述 0.5–0.7、顺带一提 0.05–0.12、无关 ≈0）即 `markHits`。一次作答消费 ledger。`hitSignalEnabled` 默认 false；失败记 `mark-hits`/`hit-compute`。
- `rankForSweep` 以 `hitCount` 降序优先；**不新增 `maxUnusedDays`**——`decayDays` 仍是唯一删除器。
- 测试：`tests/hit-signal.spec.ts`（12 用例：对立 fixture、store 记账、hit 优先排序、活体监听含 ledger 一次性消费与信号关闭）；`tests/store-contract.spec.ts` 增 markHits describe（3）。
- eval 通道部分（机械层的 hitCount 读出、同构建 A/B EQUAL）按母提案的划分留给 eval 门。

### 阶段 3：SQLite 后端 — 提交 53831d4

- **Step 3.0 文档门（先于代码落地）**：HOST_CONTRACT（zh）§11——`memory.db` 所有权（宿主 storages 目录内插件命名文件，storage-json 不可见）、WAL 伴生文件语义、与宿主介质边界、`ExperimentalWarning` 行为、钉定的 node:sqlite API 面；宿主 engines 下限 `^22.19.0 || >=24.0.0` 对 harness 检出的 package.json 取证并作为本阶段前提落文；§10 增核对项。本 package 的 package.json 设计上不带 `engines`。
- **Step 3.1 后端本体**：`src/store/sqlite.ts`——`SqliteMemoryStore extends MemoryStore`，`DatabaseSync` 落在 `$DSH_HOME/storages/memory.db`（WAL、`busy_timeout` 5 秒）；表 `entries`（`id` PRIMARY KEY，MemoryEntry 列）、`audit`、`suggestions`、`meta`；布尔绑 0/1、对象/数组绑 JSON、NULL = 缺省；每记录一条语句、entries + audit 同事务；search 复用全语料 BM25 df 纪律；`supersedeEntry`/`markHits`/janitor/trim 镜像 domain store；`getMeta`/`setMeta`/`close()` 补全面。计划的「无副作用内核抽取」一步就地修订：不必要——domain store 的读逻辑本就是实例私有，bm25 模块即后端中立内核；契约套件跨后端全绿即等价性证明。
- **Step 3.2 配置 + 迁移**：`memory-store` 行的 `StoreConfig` 增 `storage: 'host-medium' | 'sqlite'`（默认 `host-medium`；在组合行而非设置命名空间——provider 切换是组合关注点）。apply 路径在非空且无标记介质上逐条一次性导入（entries + audit + suggestions 单事务）后挂载 sqlite store，并向介质 meta 表写 `medium:migratedToSqlite`；任一后端看到数据与标记并存即 fail loud（标记经 domain 的 meta 表句柄读——介质侧的表，不是 sqlite 数据库自己的）。CrossProcessGuard 仅挂 host-medium。
- **Step 3.3 验收对齐**：vitest 可见的半边已钉死（三后端契约等价、标记持久、重开流程）；eval A/B 重定基线（SQLite 写放大重定基线、host-medium vs sqlite 逐场景 EQUAL、stderr warning 对宿主通道的检查）留在 eval 通道——它需要 harness 子进程通道，不在 vitet 内运行。
- 测试：`tests/migration.spec.ts`（真实组合上的迁移三态 + 导入保真）；`runStoreContractSuite('SqliteMemoryStore', …)` 在每用例独立 mkdtemp 数据库上跑完整 24 用例契约体（三后端共 73 个契约测试全绿）。

## 曾考虑的替代方案

- **执行细节并回母提案一节** —— 否。母 note 是决策记录，应随「定了什么」保持稳定；执行细节随施工持续修订（行号漂移、标定值回填）。独立成文让母 note 只在决策变更时更新。两 note 交叉链接，任一读者一跳可达。
- **单 release big-bang 落地** —— 否。各阶段独立可发布、可回滚；本计划按 Step 切 commit 正是为保住这个性质——任一 Step 出险，回滚边界是 commit 而不是 release。六个提交按计划落地。
- **整合输出用 JSON-schema 结构化输出** —— 否。全库 LLM 协议均为行协议（judge 单词、curator `<id>:`、整合的 `<candidateId>`），且宿主 LLM 通道没有结构化输出机制——输出一律经 `collectStreamText` 文本回收。第二套协议即第二套解析与失败向量；行协议的 fail-closed 纪律已被 dedup/extract spec 覆盖。
- **扩 `findDuplicate` 支持跨 scope/锚点** —— 否。其契约（same-scope 近似重复、单阈值）被 `tests/dedup.spec.ts` 标定对钉死；在其上扩维度等于把预筛与完整性再次耦进一个函数。选择器基于 bm25 原语新造；`dedup.ts` 留给 legacy kill switch。
- **计划 Step 1.1 的 `UpdateMemoryInput` status 写入面** —— Step 1.1 实施时修订：status/supersededBy 刻意不进 update 输入（只有整合 seam 翻条目状态，注解与翻转因此恒原子）；上线写入面仅 anchors。
- **计划 Step 3.1 的内核抽取 commit** —— Step 3.1 实施时修订：不必要（读逻辑本就是实例私有、无共享状态耦合；bm25 模块即后端中立内核），跳过它省掉一整个 commit 的搬运，而等价性证明（契约套件双后端全绿）原样保留。
- **计划 Step 3.2 的设置卡 `storage` 下拉** —— Step 3.2 实施时修订：后端属于 `memory-store` 组合行（`StoreConfig`），不属设置命名空间——provider 切换是组合关切，cordis.patch.yml 即文档化开关。
- **迁移标记从 sqlite 数据库自己的 meta 表读** —— 迁移 spec 的 both-sides 用例抓到的实现 bug：标记在**介质**的 meta 表（迁移启动趟写入）；读 sqlite 侧的表使 both-sides 守卫永不触发。上线版本经 domain 句柄读介质 meta。

## Testing

最终提交上的验证命令与实测结果：`npm run build`（tsc host + client 门 + bundle）与 `npm run test` —— **945 passed | 6 skipped（951）**，46 个 spec 文件，skip 为 env 门控的真模型 judge 套件。分阶段套件：`consolidate.spec`（29）、`sweep.spec`（25）、`hit-signal.spec`（12）、`write-path-rework-acceptance.spec`（5）、`store-contract.spec`（73，三后端）、`migration.spec`（3，真实组合）。全部新逻辑测试走 fake-LLM（手写流或内容路由假服务）；无测试触碰真模型。

## Consequences

- **对照计划「随实施标定并写回」各项**：每一条都在本 note 落定——整合阈值（0.2 / df≤2，模块常量）、sweep 默认值（`sweepEnabled` false、`sweepEveryNSessions` 20、`sweepTopN` 20、1 小时冷却）、命中阈值（0.25 及其实测带宽）、重复对计数器对 9/2 基线的读数（11 条多余裁决；报告行文「10 组」计的是受追踪事实集）。
- **顺延至 eval 通道**：完整 harness 语料重放（`npm run eval -- --filter prog101,prog112,work201,life303`）、SQLite 下写放大重定基线、host-medium vs sqlite A/B 逐场景 EQUAL、v2 judged A/B（env 门控真模型）——母提案保留的行为验收门。阶段 4（净索引视图）在这些基线之后保持仅立项。
- **上线 kill switch**：`consolidation: 'legacy-judge'`（每轮层）、`sweepEnabled: false`（sweep 层）、`hitSignalEnabled: false`（命中信号）、`storage: 'host-medium'`（SQLite 后端）——各自独立回退一层；legacy judge 保留一个 release，其删除随变更更新母 note。
- **交叉链接**：决策记录在 [sqlite-backend-and-batch-consolidation](2026-09-04-sqlite-backend-and-batch-consolidation.zh.md)；HOST_CONTRACT §11 持有本地介质契约；TECH_DESIGN §6.1/§6.3/§7.1/§7.3/§8 持有现状散文。
