# Agent Note: 记忆写入路径重构:SQLite 本地后端与双层批量整合

Status: proposed

## 问题

2026-09-02 的 core-v0 judged 报告(`/tmp/eval-full-c2-20260902.json`,真模型 + judge,rubric v1,32 场景 114 题)与评测审计([eval-audit-and-noisy-corpus](../../implemented/testing/2026-09-03-eval-audit-and-noisy-corpus.md))暴露写入路径的三处结构性缺陷:

1. **同一事实重复写入。** 52 条落库条目中 10 条埋点事实被写 2–3 遍。四维均分里最低的是 contentFidelity(0.892);mergeBehavior(1.382)居次,但它是**测量上最不可信**的维度——`writtenIds = after − before` 的口径使 merge/update 从不进 judge,该维度只测「是否重复创建」(审计 zh.md:21)。
2. **矛盾写入无冲突标注。** prog101 在已存 pnpm 约定条目后写入语义相反的「依赖用 npm」条目,两版并存、无任何弃用标注([conflict-resolution 残余](../../implemented/architecture/2026-09-01-forget-selfcheck-conflict-residual.md) 记录的「换述纠错词法检出」缺口在真实语料上兑现)。代码层面的现状更进一步:写路径**结构上不存在 conflict 通道**——judge 判定集只有 duplicate/update/new,「合并」是词面拼接(`src/review/dedup.ts:107-115`),且跨 scope 条目从不互比(`dedup.ts:77`),prog101 类矛盾在任何词面阈值下都不可达。
3. **scope 归属丢失。** prog112 对话显式说出 ui-kit 仓库名,条目仍缺 project 归属,追问时记忆以错误仓库语境浮出——`ParsedMemory`(`src/review/extract.ts:174-183`)没有 projectName 字段,project 归属只能靠 cwd 推断(`extract.ts:567,599`)。

三者同源于一个设计错误:写入路径把一个**语义**判断(是否同一事实?是否矛盾?)gate 在 `findDuplicate` 的 IDF 加权词面重叠之后,而词面测不出语义——换述的真重复与「上海/海南」类干扰对同档,LLM judge 根本不触发。

存储介质层放大了这个问题。宿主 storage-json 每次写都全量 republish + fsync:集成测试曾以 205 次 add ≈ 415 次 fsync 发布撞 5s CI 预算,该症状已以预播种 medium 修复([audit-cap-test-seeds-medium](../../implemented/testing/2026-09-03-audit-cap-test-seeds-medium.md),~415 → ~7),所以它不再是事故,而是真实使用中写放大的可测代理;跨进程安全靠手写检测兜宿主 last-writer-wins 的底([cross-process-detect](../../implemented/architecture/2026-09-01-cross-process-detect-owner-stamp.md));整合所需的持久状态(进度位、cooldown、弃用标注)在单文件介质上只能再开表将就;路线图功能(usage 遗忘、整合基线、锚点索引)全是关系查询形状——在 ≤500 条规模下内存筛选本身廉价,真正缺失的是写入原子粒度与状态落点。`DomainMemoryStore` 的 scale-selfcheck 注释已预留「SQLite backing」的迁移决策位(`src/store/index.ts:393-418`)。

对标参考:OpenAI Codex CLI 记忆实现(`~/codex/codex-rs/memories`,2026-09-04 深读)对同一题的答案是**写入时零语义去重**(thread_id 主键 upsert)+ **合并/冲突全部委托周期性全库 LLM 整合**(cooldown 门控、usage-top-N 选拔),状态落在独立 SQLite DB,usage 计数驱动选拔与遗忘。真正承重的经验是这个配对:写入敢**笨**,是因为有个**周期性全上下文扫描**兜住了写入漏掉的一切。

## 提案

四阶段推进,执行顺序按「先修缺陷、后做管道」排列:阶段 1–2 落在现有 host-medium 后端上(零迁移的字段/表演进),阶段 3 的 SQLite 是独立管道工程,阶段 4 仅立项。每阶段独立可发布、可回滚,各自落 commit + Agent Note;机械验收复用 eval 基建。以下决策为当前定案;实施逼出矛盾时以更新本 note 的方式修订并标注。执行级步骤(文件、符号、提交切片)见姊妹 note [write-path-rework-implementation-plan](./2026-09-04-write-path-rework-implementation-plan.md)。

### 阶段 1:anchors + 双层批量整合(去重与冲突主修复,落现有后端)

- 提取 schema 增量(同一次 LLM 调用,零新增往返):`ParsedMemory` 增 `anchors: string[]` 与 `projectName?: string`,行协议沿用 `[summary:…]` tag 先例新增 `[anchors:…]`/`[project:…]`。提取 prompt 硬性要求:对话出现仓库名/路径时必须进 anchors 且填 `projectName`;NO-OP 门保留(低信号轮次可返回空)。`storeMemories` 的 project 归属改为 parsed.projectName 优先、cwd 推断兜底——修 prog112。
- 条目模型与状态表(全部零迁移,HOST_CONTRACT §1 的可选字段/缺席表语义):`MemoryEntry` 增可选 `anchors`、`status: 'active' | 'superseded'`(缺省视为 active)、`supersededBy`,zod 镜像同步;domain 增第四张表 `meta`(缺席表初始化为空映射)存整合进度 lastRun/cooldown。
- **双层整合——anchors 是预筛,永远不是完整性保证:**
  - **每轮层(廉价):** 整合候选 = 词面加权重叠 ∨ 共享低频锚点(df ≤ 2),同/跨 scope 分桶。跨 scope 对不再被 `dedup.ts:77` 的 same-scope 契约结构性排除,而走 conflict/scope 修复路由(环境观察 ≠ 约定;scope 不同默认不合并);候选选择器复用 bm25 原语新造,不改 `findDuplicate` 契约。一次结构化 LLM 调用(沿用全库行协议纪律:judge 的单词、curator 的 `<id>:`)返回每候选 `{action: merge | update | conflict | new, targetEntryId?, content?}`,受防过合并规则约束。
  - **周期性全库层(让笨写入变安全的兜底):** startup 一次 + 复用 curator 的 per-N-sessions 门控,对全库 usage-top-N 重跑整合(codex `get_phase2_input_selection` 语义:accessCount DESC、COALESCE(lastRecalledAt, updatedAt) DESC、按 decay 窗口过滤)。这一层看得到共享硬 token 为零的换述重复对与 anchors 之前的历史重复——正是每轮词面/锚点预筛结构上够不到的对。**单靠词面或锚点预筛会重犯 Problem 点名的设计错误;这个全库扫描才是真正测语义的通道。**
- `conflict` → 旧条目 `status='superseded'` + `supersededBy` + 可见弃用标注(rubric v2 认该档位),新事实入新条目;`merge`/`update` 走既有 `mergeContent` 语义。整合输出解析失败 fail-closed 到 `new`(不误合并:误判 duplicate 会吞事实,误判 new 的冗余由周期性层打捞——与 judge 的 fail-closed-duplicate 方向相反,选型理由随代码落 docstring)。检索面(standing 装配、auto-recall、search)过滤 superseded,沿用 staleSince 过滤先例;工具面(memory_list/memory_get)可见并带标注。
- 逐对 `judgeDuplicate` 由新 Config `consolidation: 'two-tier' | 'legacy-judge'` 保留**一个 release** 作 kill-switch(默认 two-tier),之后删除;删除时通过更新本 note 记录。

### 阶段 2:usage 反馈与遗忘

- **hit 信号 = 「token ∩ 作答」加权**:新增可选 `hitCount`/`lastHitAt`(零迁移),条目仅在作答轮文本与其 token/anchor 重叠(IDF 加权过标定阈值)时才累积,被注入但被无视的条目不得分。接入点:auto-recall 的 pre-step 记录本轮注入 id(`src/context/index.ts:387-412`)、standing 段快照(`:337-364`),`assistant/message` 会话事件(`src/review/index.ts:296` 的先例;文本提取复用 accumulator 的 messageText 逻辑)触发交集计算并回写。「进注入段即 +1」被否——它让 usage 变成索引大小的代理,而非有用度。
- **既有 `accessCount`/`lastRecalledAt` 语义不动**:recall/surface 计数继续喂 `trimEntries` 驱逐排序(`src/store/index.ts:819-839`)与 decay 判断;把它们重定义为「作答重叠才计」被否(见替代方案)。周期性整合的 top-N 选拔改读 hit-aware 排序(合成规则随实施标定,记录在本 note)。
- **遗忘保持单一旋钮。** 不新增 `maxUnusedDays`;既有 `decayDays` janitor(默认 30,`0`=off)仍是唯一遗忘控制,`entriesCap` 照旧兜底。codex 的 `max_unused_days` **仅**复用为周期性 top-N 输入的选拔过滤条件,绝不做第二个删除器。已知有界偏差:模型用了事实却没在作答里回声 token 的条目会被欠计——欠计只影响整合选拔排序,从不驱动删除(decay 以 recall 时间为准),见风险节。

### 阶段 3:SQLite 本地存储后端(独立管道工程,可整体回滚)

- **动机更正(相对初稿):本阶段不修 Problem 点名的任何缺陷**——它们由阶段 1 修掉。它买四样架构卫生:写入原子粒度(单条记录写 vs 全量 republish + fsync,真实使用中每轮整合写都被放大成全文件写)、整合状态与弃用标注随记录同事务落定、把记忆数据搬出宿主 last-writer-wins 的单文件介质、为 roadmap 的关系查询留位。初稿的两条旧动机被评审驳回:CI 撞 5s 预算的症状已被预播种消解(见 Problem 节),「关系查询形状」在 ≤500 条规模下内存筛选是微秒级——它们只是旁证,不是正当性。
- 新增 `SqliteMemoryStore extends MemoryStore`(`src/index.ts:63`),基于 `node:sqlite` 的 `DatabaseSync`,只 pin 最小 API 面(open + prepare + exec)。DB 文件 `$DSH_HOME/storages/memory.db`,WAL 模式 + busy_timeout(多进程并发写语义在验收中钉死)。**先例更正:** notesDir 先例不成立(notesDir 自 0.6 起被忽略并正在拆除,`src/notes/settings.ts:32`)——`memory.db` 是宿主 storages 目录内一个插件命名的新文件,连同 WAL 伴生文件(`-wal`/`-shm`)与卸载语义一并写入 HOST_CONTRACT 与 TECH_DESIGN(§6.3/§10.4)。
- 表结构:`entries`(MemoryEntry 全字段 + 阶段 1/2 增列)、`audit`、`suggestions`(保持领域表形状迁入)、`meta`(schemaVersion、整合 lastRun/cooldown——整合状态随迁移带入)。
- Config 增 `storage: 'host-medium' | 'sqlite'`,经 cordis.patch.yml + 设置卡;误配 fail loud。**本 release 以 `host-medium` 为默认、`sqlite` 为 opt-in;默认在下一 release 翻转为 `sqlite`,以本阶段验收通过为门。**
- 一次性迁移:SQLite 后端首次打开且库空、host medium 非空 → 导入并在 medium 的 **meta 表**(非 owner-stamp 全局槽——全局槽 schema 归 CrossProcessGuard 所有)写 `migratedToSqlite`;两边都非空 → fail loud。
- 跨进程:host-medium 后端保留 CrossProcessGuard 全套。**混版标记落地:** 以 host-medium 启动的进程若在 medium meta 表发现 `migratedToSqlite` 则 fail loud(介质直读先例:`src/store/cross-process.ts:69-117`),旧进程永远不会在新进程已 owning `memory.db` 时静默写 `memory.json`。SQLite 侧依赖 WAL + busy_timeout 的单写者语义,并有并发写者测试钉死。
- BM25 内核与 CJK tokenizer 不动(记录在案的零依赖例外);检索面零变化。entries+audit 同事务原子落定。宿主存储层本身是 backend 中立的(descriptor 把 unit name 注释为「file-name / SQL-identifier segment」,已为 SQL 后端留位)——不沿该缝接入的理由见替代方案。
- **前提(验收门):** `node:sqlite` 自 Node 22.13.0 起免 `--experimental-sqlite` flag(22.22.2 实测 open/prepare/exec/FTS5 可用),22.x–24.x 首次使用会向 stderr 打一条 `ExperimentalWarning`(25.7.0 起升 release candidate 不再打)。「宿主 engines 下限 `^22.19.0 || >=24.0.0`」的前提在本仓库无据可查(本 package.json 无 engines 字段)——开工前先将其落进 HOST_CONTRACT,据此复核 better-sqlite3 否决的成立性;验收含「warning 不破坏宿主 stderr 断言」。

### 阶段 4(仅立项):净索引视图

standing 注入改读整合产出的去重索引视图,store 原文作 payload(codex 脏/净两层)。前置:阶段 1–3 稳定 + v2 A/B 基线在库。

## 曾考虑的替代方案

- **全盘照抄 codex(子 agent 整合 + git 仓库化记忆目录 + 引用协议)** —— 否。整合子 agent(medium reasoning + 文件工具)与每轮节奏不匹配 → 降配为单次结构化调用;变更跟踪用整合 watermark 替代 git diff;引用协议要动宿主 → 先用「token ∩ 作答」。codex 的*周期性全库扫描*被采纳(阶段 1);其*文件化记忆 + agent-grep 召回*不采纳——那会丢掉我们结构化的 scope/category/BM25 检索,而这正是 codex 没有的真实优势。
- **anchors 作为整合的唯一触发(本方案初稿)** —— 否。anchors 仍是词面信号:一对无共享硬 token 的换述重复永不触发,重犯 Problem 点名的「语义判断 gate 在非语义指标后」错误。周期性全库扫描才是完整性保证;anchors 仅作每轮预筛留存。
- **三元组/实体图谱/canonical 字段** —— 无确定性消费方;分组与冲突候选由 anchors + 全库扫描覆盖,合并决策由整合 judge 读全文定。规范化本身不稳定,LLM 抽取方差会成为去重新噪声源。
- **继续调词面指标(阈值/权重/Jaccard)** —— 否。词面相似度对「同事实换说法」有结构性天花板,调阈值只是移动错误分布(换述纠错 ≈0.02、干扰对 ≈0.06,见 conflict-resolution 残余 note 的标定)。
- **better-sqlite3** —— 否(前提待记录)。「宿主 `engines` 下限保证 `node:sqlite` 可用」的论证依赖宿主编排钉版 ≥22.13,此前提本仓库无据、须先落进 HOST_CONTRACT;成立后,装进宿主进程的原生模块有 ABI/安装硬故障风险,会拖死整个插件。`node:sqlite` 的 experimental API 漂移风险由 `SqliteMemoryStore` 后的最小 API 面封住。这是插件分发决策,不是零依赖教条。(22.22.2 实测免 flag 可用。)
- **SQLite FTS5(替换或并行 BM25)** —— 否,所列行为已在 `node:sqlite` 实测复现:默认 `unicode61` 分词器把连续 CJK 当成一个 token(存「上海」查「上」0 命中);`trigram` 要求查询 ≥3 字符,打不中最高频的 2 字中文词(「记忆」→ 0 命中);node:sqlite 不暴露 FTS5 自定义分词器钩子(那是 C API,只能靠 `loadExtension` 编译扩展塞入——比 better-sqlite3 更重的原生依赖)。在 ≤500 条短文本规模上内存 BM25 全表扫是微秒级,FTS5 的磁盘倒排索引无性能收益,并行只会多一份影子索引 + 两套待调和的排名。既有 unigram+bigram 分词已解决 CJK。
- **entries 直接搬进宿主 medium 换格式** —— 否。storage-json 是宿主 peer 契约,插件单方面换格式破坏兼容。SQLite 作为插件自有本地后端挂在 `MemoryStore` 抽象后。(更正一处描述:remote/ 不是备选存储源,而是挂同一 memory service 的 RPC 适配层;它走 service 抽象,后端切换对其透明,「互不影响」结论不变。)
- **SQLite 先行(本提案初稿的阶段顺序)** —— 否。原顺序把一整个不修任何已点名缺陷的管道工程排在修复之前,两条支撑均不成立:CI fsync 症状已被预播种消解;「避免两次迁移」不成立——JSON 侧是可选字段/缺席表零迁移,整合状态落 meta 表后随单次导入进 SQLite,迁移次数恒定为一。整合先行以最小风险修掉 9/2 报告的缺陷;SQLite 在其后作为独立 release 价值完整。
- **沿宿主 storage hub 注册 SQLite StorageBackend** —— 否。宿主存储层确实 backend 中立(见阶段 3),但 memory 的 composition 行归 dsh-web-app 编排,不在本 bundle(TECH_DESIGN §10.3)——沿该缝接入要协调宿主工程;`MemoryStore` 抽象缝插件自有、宿主零改动。宿主日后若官方提供 SQLite backend,`SqliteMemoryStore` 可被替换为桥接。
- **重定义 `accessCount` 语义为「作答重叠才计」** —— 否。该字段已被 `trimEntries` 驱逐排序与 decay 判断消费,语义静默切换会让存量数据与排序变义;新增 `hitCount`/`lastHitAt` 零迁移且语义独立,合成排序在阶段 2 标定。

## 验收标准

- **阶段 1:** 9/2 报告的 10 组重复对 → 整合触发 10/10;一条 fixture 证明**周期性全库层**能合并一对**无**共享锚点的换述重复;`tests/dedup.spec.ts` 标定对零回退;重放 prog101/112/201/303:落库 52 → ≈40,重复事实对 10 → 0,矛盾未标注 → 0,prog112 projectName 落位;`status='superseded'` 的注入面过滤与工具面可见标注各有测试;双向兼容测试钉死(无新字段/无 meta 表的旧 medium 打开即零迁移;含新字段与未知表的新 medium 经旧代码路径读后写回不丢表);kill-switch(legacy-judge)行为有测试;批量整合 vitest 走 fake-LLM 路由(`tests/eval-fakellm.spec.ts` 的先例),真模型跑法沿用 env 门控纪律。
- **阶段 2:** hitCount 在 eval 场景可读出、且仅在作答重叠时累积(「注入被无视不得分」与「作答回声 +1」两个对立 fixture 钉死);`decayDays` 仍是唯一遗忘旋钮(无 `maxUnusedDays`);遗忘队列不吞 negative 题所需条目;同构建 A/B 确定性层 EQUAL。
- **阶段 3:** 宿主 engines 下限先行落进 HOST_CONTRACT;现有 store/review spec 参数化跑双后端全绿;composition 重开用例盖 SQLite;同构建「host-medium vs sqlite」eval A/B 确定性层逐场景 EQUAL;CI 写放大用例在 SQLite 后端下去预播种重定基线;混版 fail-loud 标记与 meta 表存续有测试覆盖;WAL busy_timeout 多写者行为有测试;`ExperimentalWarning` 确认对宿主 stderr 无害;HOST_CONTRACT 补本地介质所有权 + §10 checklist 项;TECH_DESIGN §6.3/§10.4 补 memory.db、WAL 伴生文件与卸载语义。
- **全程:** rubric v1↔v2 分数不互比,验收用机械可数指标 + v2 新基线;v2 judged A/B 重跑(网关恢复后)作为行为级验收门。

## 风险

- 整合 judge 的过合并 → prompt 防过合并规则 + fixture(环境观察 vs 约定);conflict 动作保守(标注优于删除);解析失败 fail-closed `new`——宁留冗余,不吞事实。
- 整合的 LLM 成本/延迟 → 每轮输入受锚点裁剪;周期性全库扫描受 per-N-sessions/cooldown 门 + top-N 上限 + 用量排序选拔约束;配置 kill-switch 可整体回退到仅每轮或 legacy-judge。
- 周期性整合与既有 curator 叠加触发 → 复用同一 per-N-sessions 门控与账本;频率由同一组 Config 暴露;异常一律 `reportFailure` 记账。
- usage 欠计(模型用了但没回声 token)→ 有界:欠计只喂整合选拔,decay/janitor 不读 hitCount;eval 机械层读出 hitCount 后若见选拔偏差,按权重配置回调。
- `node:sqlite` experimental,宿主升 Node 有 API 漂移风险 → 最小 API 面封在 `SqliteMemoryStore` 后、spec 全盖、HOST_CONTRACT §10 checklist 加测。不可用时的具名 fallback:同一 `MemoryStore` 缝后换 better-sqlite3,或回退 `host-medium`。
- 双真源(启用 sqlite 后 medium 残留旧数据)→ 单向迁移 + 阶段 3 的 fail-loud 混版标记;歧义 fail loud。
- 阶段 4 改注入面 → 只在阶段 1–3 稳定后立项;eval 的 standingHit/noiseRatio 机械层可直接测量回归。
