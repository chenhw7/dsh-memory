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

## Eval 通道结果（2026-09-05）

- **Mock A/B（重构前构建 123542b vs 重构后，4 个验收场景）：确定性层 4/4 全 EQUAL**——重构对确定性链无行为回归（`/tmp/wpr-ab-mock.json`）。
- **真实 judged A/B（fuyao 网关，真模型 + judge；`/tmp/wpr-ab-real4.json`，work201+life303 一对——唯一一次网关撑过 storage judge 调用的尝试）：**
  - work201-weekly-report：基线 5 条、`f201-channel` 被判了两次（同一事实写 2 条）→ 候选 1 条——每轮层把 channel 重复**合并**了；standing hits 5/5 与基线持平；负例问题完好；逐题 judged 注入质量与作答正确性 EQUAL。
  - life303-running：`f303-pace` 两侧都重复——零共享锚点的换述对，正是 sweep 层的目标（opt-in 且这些运行中关闭）。
  - 合计：重复对 基线 3 → 候选 1；judged 均分 5.22 → 5.60。每轮层在真实语料上的效果已测得；sweep 层的效果尚未测（opt-in）。
- **由这几次运行产出的基建修复**：`callJudgeModel` 对传输失败（5xx/超时）重试至多 4 次、线性退避（提交 350348c）——此前连续三次尝试的 storage judged 指标全部被网关间歇 503 打掉。
- **eval 通道剩余缺口**：prog101/prog112 在真模型下超 turn budget 中止（基线侧同样中止——该场景的重工具对话对两个构建都超 40 次调用，是既有的语料/预算张力，非重构回归）；host-medium vs sqlite A/B；写放大重定基线。完整 32 场景 judged 基线（v2 rubric）仍是常设行为门。

## Eval 通道结果（2026-09-07）

- **常设 v2 judged 基线的 7/32 高难度场景切片**（构建 f73e634，被测模型 fuyao/fuyao-coding effort high，judge fuyao-data，memory-mode index，并发 3；`/tmp/eval-real-difficult-20260907.json`，盖印 1200s/64）。选场景的依据是语料里稀缺的难轴：全部 3 道 multi-hop 题（prog101、prog109、work201）、冲突分辨题（q101-cd/cdp 已跑，q116-cdp 未跑到）、两个有档案记录的预算中止案、每轮整合验收目标、sweep 层见证场景。
- **完成 5 个场景 / 25 题**：standing hit 91.3%（独立题 92.3%）、噪声 0.60、注入质量 2.92/3、答案 1.60/2、storage 总分 4.92/8、precision 76.7%（16 条入判、1 条 invalid）、重复对 4。逐场景：prog112 干净（standing 4/4、答案全 2、precision 100%）；work201 答案全 2（含 multi-hop 与负例），`f201-channel` 单条、但 `f201-style` 重复 + 2 条无埋点来源条目（precision 60%）；life303 答案全 2，`f303-pace` 本次单条（contentFidelity 1），另有 2 条无埋点条目（一条入判总分 4；一条 invalid 剔除——judge 的 evidence 超长违约，非协议故障）；prog109（seed）standing 5/5、答案 2.00。
- **prog101，最难的一个：冲突题端到端失守。** factHits `[pnpm=true, legacy=false]`——预写的 legacy-npm 条目不在 q101-cd/cdp 的常驻注入里（standing MISS）；storage 裁决显示纠正事实写了 2 条、种子条目被更新却未取代：3 条条目都溯源到 `f101-pnpm-only`、每条判 `[1,0,2,0]`（scope 错、合并行为错），另有 1 条无埋点条目（precision 80%）。这是[冲突残余](2026-09-01-forget-selfcheck-conflict-residual.md)的真模型实证：重换述的纠正在词法平面上既不整合也不取代。storage 裁决成立；答案读数带下述语料效度保留。
- **两条发现比分数更重要。** 其一，真模型下[所有对非空 store 的记忆读取全部失败](../bug-fix/2026-09-07-summary-undeclared-in-memory-tool-output-schemas.zh.md)——四个读取工具的输出 schema 漏了投影携带的 `summary`——首轮全部答案读数都是只靠常驻注入产出的；bug 当日修复，prog109 修复后重跑（`/tmp/eval-real-prog109-postfix.json`）是该 seed 场景的有效读数（standing 5/5、答案 2.00、注入质量 2.40）。其二，**eval 的 harness 子进程没有文件系统沙箱**：prog101 追问会话的作答逐字引用了本仓库的真实文件（AGENTS.md 的 `npm ci` 行、package-lock.json、ci.yml）——模型把「这个仓库」解析成了磁盘上的真实仓库，并按注入 fence「先对照当前仓库验证」的指示让文件证据压倒了语料的反事实前提；prog104 的埋点对话逃进宿主机上真实的 harness 检出后不再收敛。结论：prog101 的答案 0 是语料效度失败（前提可被宿主磁盘证伪），不是记忆链失败；prog104/prog116 在任何预算下都精确撞在预算+1（65>64、97>96——不收敛循环，把档案记录的「超 40 次调用」张力收窄为「不会终止」），语料不再把模型引向工作区里不存在的仓库之前，这两个场景对真模型不可跑。
- **本切片之后的剩余**：常设 v2 judged 基线还有 25/32 场景从未在真模型下判定（prog104/prog116 被语料修复阻塞）；语料侧决策（反事实前提、工作区物化或沙箱）归[eval 审计笔记](../testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md)所有。两项机械验收当日收口——见下一节。

## Eval 通道结果（2026-09-07，机械验收）

Step 3.3 的 eval 半场，同日跑在构建 75ce048 + 迁移修复之上（免凭据、mock 通道、逐场景比较用 `diffReports`；sqlite 侧经 profile-template 的 `memory-store` 行 pin 进测量接缝——`RunOptions` 不透传 config patch，且 overlay 行会整份替换被 pin 的配置）。

- **存储 A/B 在通过之前先揪出一个 P1。** sqlite 侧首轮在 4/32 个 core 场景的会话 2 启动处失败（`-32603: cannot create effect on inactive context`）——恰好是四个 plant+seed 行，唯一「有数据的介质」遇上 plant 链双会话重开的语料形态：[迁移把介质数据表留在原地，迁移后的每一次 sqlite 启动都踩上自己残留触发的两侧 guard](../bug-fix/2026-09-07-sqlite-migration-leftovers-brick-reopen.zh.md)——真实部署带存量切 sqlite，第二次会话即砖。当日修复（迁移 boot 在写标记前清空三张数据表；`tests/migration.spec.ts` 补重开用例，未修复树上红）；eval 的介质读取改为后端感知（`readStoredEntries` 在 `memory.db` 存在时读库，否则读 `memory.json`）。
- **修复后 A/B：逐场景 deterministic EQUAL。** core-v0（32 场景、132 题）与 noise-v0（6 场景）在全部确定性字段上相等——注入成本、standing 命中、噪声比、medium-diff 计数、条目数、审计序号——两侧零场景错误（`/tmp/ab2-host-{core,noise}.json` 对 `/tmp/ab2-sqlite-{core,noise}.json`；唯一的文本差异是逐次运行的 `durationMs`）。stderr 警告检查以 mock 通道为界：全程零条被吞的 sqlite 失败（任何被吞失败都会以确定性差异或场景错误浮出），`node:sqlite` 的 `ExperimentalWarning` 是已记录的预期子进程 stderr 噪声（HOST_CONTRACT §11）；真模型侧的 stderr 检查随待跑的 judged 基线走。
- **写放大重定基线（driver）**：同一逻辑序列——205 次 add + 20 次 update + `markHits(50)`——对真实 storage-json 组合（host-medium）与 sqlite 后端各跑一遍，`fs.watch` 在同一块 ext4/NVMe 盘上计持久介质写事件。
  - host-medium：**205 次 add 产生 415 次全文件发布事件**——与档案记录的 CI 标尺数字完全一致——20 次 update 60 次、50 次命中 150 次：226 个逻辑操作共 628 次事件（**每操作 2.78 次**），每次事件整文件重发（对一个终态 149 KB 的 store，累计全文件字节约 62 MB）；序列耗时 2.2 秒。
  - sqlite：构造上**每逻辑写恰一个事务**（entries + audit 原子落定；`markHits` 每条 id 一个事务），零全文件重发——watch 只看到文件创建与关闭/检查点边界事件（共 8 次）——持久介质终态 139 KB，WAL 关闭时合并；序列耗时 0.79 秒。
  - 读法：可迁移的数字是放大比而非绝对时长（NVMe 的 fsync 美化了 host 侧；机械盘只会拉大差距）。档案记录的「~205 adds ≈ 415 次发布」代理被确认为每 add 约 2 次发布，且 sqlite 后端把全文件货币整个移除——逐记录语句 + 每逻辑操作一个事务，即写放大目标的落地形态。
- **剩余 eval 缺口**：完整 32 场景 v2 judged 基线（真模型 + judge）——阶段 4 最后一道未过的门——加上两个被语料阻塞场景的处置，归[eval 审计笔记](../testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md)所有。

## Consequences

- **对照计划「随实施标定并写回」各项**：每一条都在本 note 落定——整合阈值（0.2 / df≤2，模块常量）、sweep 默认值（`sweepEnabled` false、`sweepEveryNSessions` 20、`sweepTopN` 20、1 小时冷却）、命中阈值（0.25 及其实测带宽）、重复对计数器对 9/2 基线的读数（11 条多余裁决；报告行文「10 组」计的是受追踪事实集）。
- **顺延至 eval 通道**：SQLite 下写放大重定基线与 host-medium vs sqlite A/B 逐场景 EQUAL 已于 2026-09-07 收口（结果见上，途中发现并修复一个 P1）；完整 32 场景 v2 judged 基线仍是母提案保留的行为验收门——阶段 4 的唯一未过阻塞。阶段 4（净索引视图）在其后保持仅立项。Mock A/B 与首批真实 judged 证据（上）已在库。
- **上线 kill switch**：`consolidation: 'legacy-judge'`（每轮层）、`sweepEnabled: false`（sweep 层）、`hitSignalEnabled: false`（命中信号）、`storage: 'host-medium'`（SQLite 后端）——各自独立回退一层；legacy judge 保留一个 release，其删除随变更更新母 note。
- **交叉链接**：决策记录在 [sqlite-backend-and-batch-consolidation](2026-09-04-sqlite-backend-and-batch-consolidation.zh.md)；HOST_CONTRACT §11 持有本地介质契约；TECH_DESIGN §6.1/§6.3/§7.1/§7.3/§8 持有现状散文。
