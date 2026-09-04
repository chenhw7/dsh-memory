# Agent Note: Memory write-path rework — SQLite local backend and two-tier batch consolidation

Status: implemented

[English](2026-09-04-sqlite-backend-and-batch-consolidation.md) | 中文

> 2026-09-05 随阶段 1–3 落地（提交 4d8796a → 53831d4）。执行层细节在姊妹 note [write-path-rework-implementation-plan](2026-09-04-write-path-rework-implementation-plan.zh.md)；该 note 记录的标定值（阈值、默认值、实测带宽）即上线值。

## Problem

2026-09-02 的 core-v0 judged 报告（`/tmp/eval-full-c2-20260902.json`，真模型 + judge，rubric v1，32 场景 114 题）与评测审计（[eval-audit-and-noisy-corpus](../testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md)）暴露写入路径的三处结构性缺陷：

1. **同一事实重复写入。** 52 条落库条目中 10 条埋点事实被写 2–3 遍。四维均分里最低的是 contentFidelity（0.892）；mergeBehavior（1.382）居次，但它是**测量上最不可信**的维度——`writtenIds = after − before` 的口径使 merge/update 从不进 judge，该维度只测「是否重复创建」（审计 zh.md:21）。
2. **矛盾写入无冲突标注。** prog101 在已存 pnpm 约定条目后写入语义相反的「依赖用 npm」条目，两版并存、无任何弃用标注（[conflict-resolution 残余](2026-09-01-forget-selfcheck-conflict-residual.zh.md) 记录的「换述纠错词法检出」缺口在真实语料上兑现）。代码层面的现状更进一步：写路径**结构上不存在 conflict 通道**——judge 判定集只有 duplicate/update/new，「合并」是词面拼接（`src/review/dedup.ts` 的 `mergeContent`），且跨 scope 条目从不互比（`findDuplicate` 的 same-scope 契约），prog101 类矛盾在任何词面阈值下都不可达。
3. **scope 归属丢失。** prog112 对话显式说出 ui-kit 仓库名，条目仍缺 project 归属，追问时记忆以错误仓库语境浮出——`ParsedMemory` 没有 projectName 字段，project 归属只能靠 cwd 推断。

三者同源于一个设计错误：写入路径把一个**语义**判断（是否同一事实？是否矛盾？）gate 在 `findDuplicate` 的 IDF 加权词面重叠之后，而词面测不出语义——换述的真重复与干扰对同档，LLM judge 根本不触发。

存储介质层放大了这个问题。宿主 storage-json 每次写都全量 republish + fsync：集成测试曾以 205 次 add ≈ 415 次 fsync 发布撞 5s CI 预算，该症状已以预播种 medium 修复（[audit-cap-test-seeds-medium](../testing/2026-09-03-audit-cap-test-seeds-medium.zh.md)，~415 → ~7），所以它不再是事故，而是真实使用中写放大的可测代理；跨进程安全靠手写检测兜宿主 last-writer-wins 的底（[cross-process-detect](2026-09-01-cross-process-detect-owner-stamp.zh.md)）。整合所需的持久状态（进度位、cooldown、弃用标注）在单文件介质上只能再开表将就。`DomainMemoryStore` 的 scale-selfcheck 注释已预留「SQLite backing」的迁移决策位。

对标参考：OpenAI Codex CLI 记忆实现（`~/codex/codex-rs/memories`，2026-09-04 深读）对同一题的答案是**写入时零语义去重**（thread_id 主键 upsert）+ **合并/冲突全部委托周期性全库 LLM 整合**（cooldown 门控、usage-top-N 选拔），状态落在独立 SQLite DB，usage 计数驱动选拔与遗忘。真正承重的经验是这个配对：写入敢**笨**，是因为有个**周期性全上下文扫描**兜住了写入漏掉的一切。

## Decision

三个阶段按「先修缺陷、后做管道」的顺序全部落地；每阶段独立成 commit 序列、可独立回滚。阶段 4（净索引视图）保持仅立项，等阶段 1–3 稳定 + v2 A/B 基线在库后再展开。

### 阶段 1（已落地）：anchors + 双层批量整合

- **提取 schema**（`src/review/extract.ts`）：`ParsedMemory` 携带 `anchors: string[]` 与可选 `projectName`；行协议新增行尾 `[anchors:…]`/`[project:…]` tag，在 category/summary 之后自右向左解析、先于 scanContent 准入门。提取 prompt 硬性要求硬 token（数字、标识符、工具名、仓库名/路径）进 anchors、对话出现仓库/项目路径时必填 `[project: …]`；NO-OP 门不动。`storeMemories`/`suggestMemories` 的 project 归属以解析 tag 优先、cwd 推断兜底。
- **条目模型**（`src/types.ts`、`src/store/index.ts`）：`MemoryEntry` 增可选 `anchors`、`status: 'active' | 'superseded'`（缺省读作 active；supersession 终态）与 `supersededBy`；zod 镜像全 optional（零迁移）。domain 增第四张 `meta` 表（`MemoryMetaRecord`，按子系统前缀键控的宽容载体记录），经 `getMeta`/`setMeta` 暴露。
- **每轮整合层**（`src/review/consolidate.ts`）：词面/锚点选择器（`selectConsolidationCandidates`，基于 bm25 原语；加权重叠 > 0.2 ∨ 共享 df ≤ 2 的锚点）提出新条目 vs 既有条目的候选对，按同/跨 scope 分桶，每次调用至多 20 对。有候选时恰好一次整合 LLM 调用按行协议 `<candidateId> <action> [targetEntryId] [content]`（action ∈ merge/update/conflict/new）在防过合并规则下裁决（环境观察 ≠ 约定；跨 scope 默认 new/conflict）。脏行或无法解析的行 fail-closed 到 `new`——与 judge 的 fail-closed-duplicate 方向相反；理由在模块 docstring。`conflict` 经 `supersedeEntry` seam 翻转旧条目（status + `supersededBy` + 钉死的 `[superseded → <id>]` 内容注解，含审计）并存新事实；`merge`/`update` 走 `mergeContent`/`update` 写形状；全部失败记 `consolidate-*`。无候选时批量直写、零整合调用。
- **周期性全库层**（`src/review/sweep.ts`）：apply 后首次会话创建 + 每逢第 `sweepEveryNSessions` 次创建，`rankForSweep` 按 `hitCount` 降序 → `accessCount` 降序 → last-use 降序选出至多 `sweepTopN` 条活跃条目，`selectSweepPairs` 只按共享词面信号提出既有条目互比对（anchors 在已按用量排序的集合上不增益），至多一次调用按 `p<N>` 协议裁决。被丢弃的裁决 fail-closed 到不动作——不存在要落地的新事实。进度经 meta 表持久（`consolidation:lastRun`，两次之间 ≥1 小时）；`sweepEnabled` 默认 `false`（本 release opt-in）。
- **superseded 可见性**：standing 快照、existence index、auto-recall 与 `search` 均过滤 `status === 'superseded'`；`memory_list`/`memory_get`/`memory_search` 保持可见，带内容注解与结构化 `superseded: <id>` 字段。
- **kill switch**：review Config 的 `consolidation: 'two-tier' | 'legacy-judge'`（默认 two-tier）为旧逐对 `judgeDuplicate` 流程保留一个 release；`dedup.ts` 本体不动，其标定测试继续钉住 legacy 路径。

### 阶段 2（已落地）：usage 反馈（hitCount）

- **命中信号度量「作答是否用了它」**：`MemoryEntry` 增可选 `hitCount`/`lastHitAt`（零迁移）。memory-context 把本轮注入条目记入每会话 ledger（standing 快照集合；auto-recall 触发时由围栏命中替换）；在该轮 `assistant/message` 上，`computeHits` 计算作答对每条条目 token（content + summary + anchors）的 IDF 加权覆盖率——复述占比达到 `hitSignalThreshold`（默认 **0.25**；实测标定带：真实复述 0.5–0.7、顺带一提 0.05–0.12、无关 ≈0）的条目经 store 的 `markHits`（原子读改写、含审计、`updatedAt` 不动、每批每条目一次）记一次命中。一次作答消费整个 ledger。`hitSignalEnabled` 默认 `false`。
- **`accessCount`/`lastRecalledAt` 语义不变**——召回/浮出计数继续喂 `trimEntries` 淘汰与 decay 判断；`hitCount` 只重排周期 sweep 的选拔。**未新增 `maxUnusedDays`**——`decayDays`（默认 30，`0` = 关）仍是唯一遗忘旋钮，`entriesCap` 照旧兜底。

### 阶段 3（已落地）：SQLite 本地存储后端

- **`SqliteMemoryStore`**（`src/store/sqlite.ts`）基于 `node:sqlite` 的 `DatabaseSync`，持有 `$DSH_HOME/storages/memory.db`（WAL 模式、`busy_timeout` 5 秒；`-wal`/`-shm` 伴生文件与主库同属一个单元）。API 面钉定在 open/prepare/exec；布尔绑 0/1、对象/数组绑 JSON 字符串、NULL = 缺省（零迁移读侧）。表：`entries`（`id` PRIMARY KEY，MemoryEntry 列）、`audit`、`suggestions`、`meta`。读取按行同步读出、语义相同；写入每记录一条语句、entries + audit 同事务——没有全文件重发布。search 复用全语料 BM25 df 纪律；`supersedeEntry`/`markHits`/janitor/trim 镜像 domain store 语义；`close()` 释放连接。
- **宿主 engines 下限** `^22.19.0 || >=24.0.0`（对 harness 检出的 package.json 取证）承载 `node:sqlite` 可用性（自 22.13 免 flag；22.x–24.x 首次使用向 stderr 打一条 `ExperimentalWarning`）；与本地介质所有权、WAL 伴生文件语义、§10 清单项一并记入 HOST_CONTRACT §11。本 package 设计上不带 `engines` 字段。
- **后端选择**：`memory-store` 行的 `StoreConfig` 增 `storage: 'host-medium' | 'sqlite'`（本 release 默认 `host-medium`；翻转为 `sqlite` 的下一 release 以 eval A/B 重定基线为门）。组合层按其切换；`remote/` RPC 层走 service 抽象零改动。
- **一次性迁移**：sqlite 启动遇到非空且无标记的介质时，单事务逐条导入 entries + audit + suggestions，并向介质 meta 表写入 `medium:migratedToSqlite`；任一后端启动时介质同时有数据与标记即 fail loud——两个活真源会分叉。CrossProcessGuard 仅挂 host-medium。

### 阶段 4（仅立项）：净索引视图

standing 注入改读整合产出的去重索引视图，store 原文作 payload（codex 脏/净两层）。前置：阶段 1–3 稳定 + v2 A/B 基线在库。

## 曾考虑的替代方案

- **全盘照抄 codex（子 agent 整合 + git 仓库化记忆目录 + 引用协议）** —— 否。整合子 agent 与每轮节奏不匹配 → 降配为单次结构化调用；变更跟踪用整合 watermark 替代 git diff；引用协议要动宿主 → 「token ∩ 作答」先行。codex 的*周期性全库扫描*被采纳（阶段 1）；其*文件化记忆 + agent-grep 召回*不采纳——那会丢掉我们结构化的 scope/category/BM25 检索，而这正是 codex 没有的真实优势。
- **anchors 作为整合的唯一触发（初稿）** —— 否。anchors 仍是词面信号：一对无共享硬 token 的换述重复永不触发，重犯 Problem 点名的「语义判断 gate 在非语义指标后」错误。周期性全库扫描才是完整性保证；anchors 仅作每轮预筛留存。
- **三元组/实体图谱/canonical 字段** —— 无确定性消费方；分组与冲突候选由 anchors + 全库扫描覆盖，合并决策由整合 judge 读全文定。规范化本身不稳定，LLM 抽取方差会成为去重新噪声源。
- **继续调词面指标（阈值/权重/Jaccard）** —— 否。词面相似度对「同事实换说法」有结构性天花板，调阈值只是移动错误分布（换述纠错 ≈0.02、干扰对 ≈0.06，见 conflict-resolution 残余 note 的标定）。
- **better-sqlite3** —— 否。宿主 engines 下限（记于 HOST_CONTRACT §11）保证每个受支持宿主上 `node:sqlite` 可用；装进宿主进程的原生模块有 ABI/安装硬故障风险，会拖死整个插件。`node:sqlite` 的 experimental API 漂移风险由 `SqliteMemoryStore` 后的最小 API 面封住。这是插件分发决策，不是零依赖教条。
- **SQLite FTS5（替换或并行 BM25）** —— 否，所列行为已在 `node:sqlite` 实测复现：默认 `unicode61` 分词器把连续 CJK 当成一个 token；`trigram` 要求查询 ≥3 字符，打不中最高频的 2 字中文词；node:sqlite 不暴露 FTS5 自定义分词器钩子（那是 C API，只能靠 `loadExtension` 编译扩展塞入——比 better-sqlite3 更重的原生依赖）。在 ≤500 条短文本规模上内存 BM25 全表扫是微秒级，FTS5 的磁盘倒排索引无性能收益，并行只会多一份影子索引 + 两套待调和的排名。既有 unigram+bigram 分词已解决 CJK。
- **entries 直接搬进宿主 medium 换格式** —— 否。storage-json 是宿主 peer 契约，插件单方面换格式破坏兼容。SQLite 作为插件自有本地后端挂在 `MemoryStore` 抽象后。（`remote/` 是挂同一 memory service 的 RPC 适配层而非备选存储源；它走 service 抽象，后端切换对其透明。）
- **SQLite 先行（初稿的阶段顺序）** —— 否。原顺序把一整个不修任何已点名缺陷的管道工程排在修复之前，两条支撑均不成立：CI fsync 症状已被预播种消解；「避免两次迁移」不成立——JSON 侧是可选字段/缺席表零迁移，整合状态落 meta 表后随单次导入进 SQLite，迁移次数恒定为一。整合先行以最小风险修掉 9/2 报告的缺陷；SQLite 在其后作为独立 release 价值完整。
- **沿宿主 storage hub 注册 SQLite StorageBackend** —— 否。宿主存储层确实 backend 中立，但 memory 的 composition 行归 dsh-web-app 编排，不在本 bundle（TECH_DESIGN §10.3）——沿该缝接入要协调宿主工程；`MemoryStore` 抽象缝插件自有、宿主零改动。宿主日后若官方提供 SQLite backend，`SqliteMemoryStore` 可被替换为桥接。
- **重定义 `accessCount` 语义为「作答重叠才计」** —— 否。该字段已被 `trimEntries` 淘汰排序与 decay 判断消费，语义静默切换会让存量数据与排序变义；新增 `hitCount`/`lastHitAt` 零迁移且语义独立；hit 优先的 sweep 排序即上线合成规则。

## Consequences

- **已落地的验证**（`tests/consolidate.spec.ts`、`tests/sweep.spec.ts`、`tests/hit-signal.spec.ts`、`tests/store-contract.spec.ts`、`tests/migration.spec.ts`、`tests/write-path-rework-acceptance.spec.ts`；全部 fake-LLM，无测试触碰真模型）：整合选择器的四个信号、fail-closed 裁决协议、四种动作的落库、零共享锚点 sweep fixture（实测重叠 0.24）、命中信号的对立 fixture、`markHits` 记账、三后端契约套件（73 用例）、真实组合上的迁移三态。`npm run build` + `npm run test` 绿，945 passed | 6 skipped（env 门控的真模型 judge 套件）。
- **9/2 基线现在机械可数**：`eval/mechanical.ts` 的 `duplicatePairCount`（以 `storage.duplicatePairs` 进报告切片）能读出报告里审计出的重复对倍数；语料重放验收断言（prog101 矛盾标注、prog112 projectName、整合后形状读 0 对）在 vitest 钉死。完整 harness 重放与 v2 judged A/B 仍是 eval 通道的门。
- **成本姿态**：每轮层每提取批次至多一次 LLM 调用（无候选为零）；周期 sweep 每次启动 + 每 N 会话至多一次调用、受 meta 表冷却约束；命中信号完全不调 LLM。提取预算刻意不约束 sweep。
- **接受的有界偏差**：模型用了事实却没在作答里回声 token 的条目会被欠计——欠计只影响整合选拔排序；decay/janitor 不读 `hitCount`，`decayDays` 仍是唯一遗忘旋钮。
- **遗留风险**：`node:sqlite` 处于 experimental——API 漂移由 `SqliteMemoryStore` 后的最小面与 HOST_CONTRACT §10 清单项封住；不可用时的具名 fallback 是同一 `MemoryStore` 缝后的 better-sqlite3，或回退 `host-medium`。三个 kill switch（`consolidation: 'legacy-judge'`、`sweepEnabled: false`、`storage: 'host-medium'`）各自独立回退一层。
- **顺延（阶段 4）**：净索引视图与 eval A/B 重定基线（SQLite 下写放大重定基线、host-medium vs sqlite 逐场景 EQUAL）等阶段 1–3 稳定 + v2 A/B 基线在库。
