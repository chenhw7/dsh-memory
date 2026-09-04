# Agent Note: 写入路径重构实施计划

Status: proposed

## 问题

[sqlite-backend-and-batch-consolidation](./2026-09-04-sqlite-backend-and-batch-consolidation.md)(下称母提案)已定案为什么改、改成什么样、哪些方案被否;但「改动落在哪个文件哪个符号、按什么顺序提交、每步用什么机械验证」在执行层没有落点。写进母 note 会让决策记录随施工膨胀失焦;不写则实施者(人或 agent)要从零推导插入点。本 note 是母提案的执行层配套,读者是落地代码者:它给每个阶段排出提交切片,每片列出插入点(带行号锚点,行号以 2026-09-04 main 为准,漂移时按符号名找)、测试写在哪、文档同步什么。实施偏离计划时,与代码同一 commit 更新本 note。

## 提案

### 全程纪律

- 每阶段独立可发布、可回滚,各自成 commit 序列;阶段验收 = 母提案对应阶段验收标准 + 本计划的步骤内测试全绿。
- 测试纪律:新逻辑的 vitest 一律走 fake-LLM —— 单测用 `tests/confirm-extraction.spec.ts:36-57` 的 `fakeCtx` 手写 `llm.stream` 模式,协议路由用 `tests/eval-fakellm.spec.ts` / `eval/harness/fake-llm.ts` 的 content-routed 假服务;真模型只允许 env 门控(`--mode real`,`eval/boot.ts:305-308`)。
- 零迁移纪律:`MemoryEntry` 新字段一律可选 + zod 镜像(HOST_CONTRACT §1 只在持久读边界校验);domain 新表利用「缺席表初始化为空映射」语义(`src/store/index.ts:96-120`);每次 schema 演进配双向测试(旧文件被新代码打开;新文件被旧 schema 路径读后写回不丢表)。
- 文档纪律:用户可见行为变化随 commit 更新 TECH_DESIGN 双语对(§6.1 记录表、§6.3 持久布局、§7.1 store、§8 配置表)并重录 sidecar;HOST_CONTRACT(zh-only)只在接触宿主契约面的阶段更新;设置卡文案走 `src/client/locales.ts` 双字典。

### 阶段 1:anchors + 双层批量整合(去重与冲突主修复)

Step 1.1 条目模型与 meta 表(纯数据面,独立 commit)

- `src/types.ts:35-83` `MemoryEntry` 增 `anchors?: readonly string[]`、`status?: 'active' | 'superseded'`、`supersededBy?: MemoryId`,JSDoc 写明缺省语义(active、无锚);`AddMemoryInput`/`UpdateMemoryInput` 相应增 anchors/status 写入面。
- `src/store/index.ts:47-61` `memoryEntrySchema` 同步三个 optional 字段;`:108-120` `memoryDomainSpec` 增第四张表 `meta: domainTable<string, MemoryMetaRecord>`(`{ key: 'consolidation' | 'medium' | 'schema', ...载体字段 }`);`DomainMemoryStore` 构造接第四表,内部增 `getMeta/setMeta`。
- 测试:`tests/store-contract.spec.ts` 补新字段往返;`tests/integration/composition.spec.ts` 仿 `:562-605` 的 pre-audit 用例补两个重开用例——无新字段/无 meta 表的旧文件打开为零迁移;含新字段与未知表的新文件经当前代码路径读后写回不丢表。
- TECH_DESIGN §6.1/§6.3(第四张表 + 新字段)+ zh 镜像同改。

Step 1.2 提取 schema 与 prompt(提取面)

- `src/review/extract.ts:174-183` `ParsedMemory` 增 `anchors: string[]`、`projectName?: string`。
- 提取协议:沿用 tag 先例(`SCOPE_TAGS` :79、`SUMMARY_TAG_RE` :90)新增行尾 tag `[anchors: a, b, c]` 与 `[project: name]`;`parseExtractedMemories`(:192-220)扩解析,tag 剥离后再进 `scanContent` 门(与 summary tag 的处理顺序一致)。
- `REVIEW_SYSTEM_PROMPT`(:33-52)与 `FLUSH_SYSTEM_PROMPT`(:66-76)加规则:硬 token(数字、标识符、工具名、仓库名/路径)进 anchors;对话出现仓库名/路径时必须进 anchors 且填 project;NO-OP 门保持。
- `storeMemories`(:511-607)project 归属:parsed.projectName 优先,`inferredProjectName`(cwd,:567,599)兜底。
- 测试:`tests/extract.spec.ts` 补解析 fixture(含无 tag 旧格式兼容);`tests/fixtures/extract-golden.ts` 增补 golden。

Step 1.3 每轮整合层(写路径主改动)

- 新模块 `src/review/consolidate.ts`:
  - `selectConsolidationCandidates(parsed, existing)`:复用 `src/store/bm25.ts` 原语(`buildCorpusStats`/`weightedOverlapSimilarity`),候选 = 词面加权重叠过阈 ∨ 共享低频锚点(df ≤ 2,df 由 existing 条目的 anchors 统计);同 scope / 跨 scope 两分桶。**不改** `dedup.ts` 的 `findDuplicate` 契约(same-scope、单阈值),它留给 legacy 路径与标定测试。
  - `CONSOLIDATE_SYSTEM_PROMPT` + 组装:每轮一次调用,按桶喂候选(新条目 vs 既有条目全文,含 scope/category/anchors);prompt 写明防过合并规则(环境观察 ≠ 约定;scope 不同默认不合并,走 conflict/scope 修复)。
  - 输出协议:每候选一行 `<candidateId> <action> [targetEntryId] [content]`,action ∈ `merge | update | conflict | new`;`parseConsolidateVerdicts` 解析纪律同 `parseCuratedLines`(`extract.ts:699-714`),未解析/脏行 fail-closed 到 `new`(理由:误 duplicate 吞事实、误 new 留冗余可由周期性层打捞——与 judge 的 fail-closed-duplicate 相反,docstring 记选型)。
  - `applyConsolidation(ctx, session, parsed, existing, opts)`:`merge`/`update` → 既有 `mergeContent` 语义 + `memory.update`;`conflict` → 旧条目 `status='superseded'` + `supersededBy` + 可见弃用标注(格式随实施定在 docstring;新事实 `add`);`new` → `add`。全部失败经 `memory.reportFailure` 记账。
- `extract.ts:546-599` 改造:batch 内先跑选择器,有候选才发起一次整合调用;`src/review/index.ts:67-117` Config 增 `consolidation: z.enum(['two-tier','legacy-judge']).default('two-tier')` 作 kill-switch,`resolveConfig`(:140-160)同步;legacy-judge 保留 `judgeDuplicate` 原路径一个 release。
- 检索面过滤 `status='superseded'`:auto-recall(`src/context/index.ts:387-412`,沿用 stale 过滤写法)、standing 装配(:417-425)、`search`;工具面(memory_list/memory_get)不隐藏、渲染标注。
- 设置卡:`src/client/index.ts` 的 `REVIEW_SPEC`(:107-141)增一行 consolidation 选项 + `locales.ts` 双键。
- 测试:新 `tests/consolidate.spec.ts`(fakeCtx 模式):选择器(词面命中 / 仅 anchors 命中 / 跨 scope 分桶 / df>2 锚点不命中)、协议解析(脏行 fail-closed new)、四 action 落库、整合调用零发生时的纯新增直写;`tests/dedup.spec.ts` 零改动全绿;fake-LLM 重放 prog101(prog-101 式 fixture:已存 pnpm 约定 → 写入 npm 矛盾 → 旧条目 superseded + 标注、新条目落库)与 prog112(对话含仓库名 → anchors/projectName 落位)。

Step 1.4 周期性全库层

- 调度:复用 curator 的 per-N-sessions 门控形态(`src/review/index.ts` 自有计数器),startup 一次 + 每 N sessions 一次;选拔 = accessCount DESC、`COALESCE(lastRecalledAt, updatedAt)` DESC、decay 窗口过滤、top-N 上限;`lastRunAt`/cooldown 经 Step 1.1 的 meta 表持久。已落地(`src/review/sweep.ts`):配对是既有条目互比——每轮选择器的 parsed-vs-stored 形状不可迁移,`selectSweepPairs` 只按共享的 0.2 词面信号重新配对(anchors 在已按用量排序的集合上不增益);裁决走 `p<N>` 命名空间(`SWEEP_SYSTEM_PROMPT`),与每轮的 `c<N>` 区分;被丢弃的裁决 fail-closed 到**不动作**(不存在要落地的新事实——与每轮的 `new` 相反)。冷却 = meta 表 `consolidation:lastRun` + 两次之间至少 1 小时。默认值:`sweepEnabled` **false**(本 release opt-in)、`sweepEveryNSessions` 20、`sweepTopN` 20。提取预算刻意不约束扫描(store 维护通道,非提取排水)。
- Config:`sweepEnabled`、`sweepEveryNSessions`、`sweepTopN` 进 memory-review 命名空间 + 设置卡(无硬编码可调参数惯例)。
- 测试:fixture 证明本层能合并一对**零共享锚点**的换述重复(fake-LLM 按桶内容路由作答);cooldown 不重复触发;`sweepEnabled=false` 全静默;meta 表 lastRun 跨重开存续。已落地为 `tests/sweep.spec.ts`(25 用例);英文 rate-limit 对(实测重叠 0.24、零锚点)是零共享锚点 fixture。
- eval 验收(机械层):完整 harness 重放仍是 eval CLI 的职责(`npm run eval -- --filter prog101,prog112,work201,life303`);验收的确定性半边在 vitest 钉死为 `tests/write-path-rework-acceptance.spec.ts`(prog101 矛盾 → superseded + 标注;prog112 projectName + 锚点配对;审计出的 9/2 重复对倍数——计数器按每条多余裁决读出 11,报告「10 组重复对」的行文口径是受追踪事实集;整合后形状读 0;语料契约 lint)。`duplicatePairCount` 增补进 `eval/mechanical.ts`,在 `eval/report.ts` 切片以 `storage.duplicatePairs` 呈现(跨场景求和,非取均值)。v2 judged A/B(env-gated 真模型)留给行为门。

### 阶段 2:usage 反馈(hitCount)

Step 2.1 字段与回写

- `src/types.ts` + zod 镜像增 `hitCount?: number`、`lastHitAt?: number`(可选,零迁移);store 增 `markHits(ids)`,记账方式同 `stampRecalled`(`src/store/index.ts:600-628`,含 audit)。
- 双向兼容测试同 Step 1.1 纪律。

Step 2.2 交集计算(memory-context)

- auto-recall pre-step(`src/context/index.ts:387-412`)的本轮注入 id 集与 standing 快照(`freezeFor` :337-364)记入 session 侧账本(sessionMemory WeakMap 旁挂)。
- 新增 `ctx.on('session/event')` 监听 `assistant/message`(先例:`src/review/index.ts:296`;文本提取复用 `src/review/accumulator.ts:149-150` 的 messageText 口径):计算作答文本 token ∩ 账本条目的 token/anchors(bm25 原语,IDF 加权),过标定阈值者 `markHits`;阈值进 Config(默认随实施标定并写回本 note)。
- `accessCount`/`lastRecalledAt` 语义与全部既有消费点(`stampRecalled`、`trimEntries` :819-839、janitor :898-973)零改动。

Step 2.3 消费

- 周期性整合选拔改读 hit-aware 排序(合成规则随实施标定,写回本 note 与母提案);**不新增 `maxUnusedDays`**,`decayDays` 仍是唯一删除器。
- 测试:对立 fixture 钉死(注入但作答无重叠 → hitCount 不动;作答回声 → +1);markHits 幂等与审计;`eval/mechanical.ts` 增 hitCount 读出;同构建 A/B 确定性层 EQUAL。

### 阶段 3:SQLite 后端

Step 3.0 文档门(先于代码)

- HOST_CONTRACT(zh-only):新增本地介质小节(`memory.db` 归插件所有、WAL 伴生文件、与宿主 memory.json 的边界),§10 清单补第 11 项(node:sqlite 可用性与 warning);把宿主 engines 下限(`^22.19.0 || >=24.0.0`,node:sqlite 自 22.13 免 flag)落文——此前提是本阶段全部前提,先落文再开工。本仓库 package.json 是否加 engines 字段同期定夺(倾向:不加,宿主契约文档承载)。
- TECH_DESIGN §6.3/§10.4 预留更新项(memory.db + 伴生文件 + 卸载语义),随 3.1–3.3 落地同改。

Step 3.1 后端本体

- `src/store/index.ts` 无副作用抽取(单独 commit):把读侧 BM25 检索、排序、过滤、janitor/trim 逻辑抽成与 `DomainMemoryStore` 解耦的内核函数(现状是类内私有),行为等价由现有 spec 全绿证明。
- 新文件 `src/store/sqlite.ts`:`SqliteMemoryStore extends MemoryStore`(`src/index.ts:63` 抽象面,:221 `janitor` 为抽象);`node:sqlite` `DatabaseSync`,API 面 = open/prepare/exec(± transaction helper);WAL + busy_timeout;`$DSH_HOME/storages/memory.db`(路径解析复用 `dshHomePath` 惯例,仿 `src/store/index.ts:312-331`)。表:`entries`(全字段)、`audit`、`suggestions`、`meta`(schemaVersion、consolidation lastRun/cooldown)。读路径全量 load 进内存、读侧与 DomainMemoryStore 同语义(同步内存读),写路径单条 SQL,entries+audit 同事务。
- 测试:现有 store/review spec 参数化双后端(vitest 参数化工厂,构造入参切后端);`tests/integration/composition.spec.ts` 补 SQLite 重开用例(含 WAL 伴生文件存在性、busy_timeout 并发写者行为)。

Step 3.2 配置与迁移

- Config:`src/context/index.ts:109-154` `MemoryConfig` 增 `storage: z.enum(['host-medium','sqlite']).default('host-medium')`;设置卡 `SelectField`(REVIEW/存储相关 spec)+ locales 双键;误配 fail loud。默认下一 release 翻转为 `sqlite`,以本阶段验收为门。
- 组合处(`src/index.ts` 的插件 apply/组合层)按 config 选后端;`remote/` RPC 层走 service 抽象,零改动(用例钉死)。
- 一次性迁移:sqlite 首开且 DB 空且 medium 非空 → 全表导入 + medium meta 表写 `migratedToSqlite`(含时间戳);两边皆非空 → fail loud;host-medium 启动见 meta.migratedToSqlite → fail loud,直读介质用 `src/store/cross-process.ts:69-84` 的 `mediumOwnerReader` 同款(读 `document.tables.meta`)。CrossProcessGuard 全套仅挂 host-medium。
- 测试:迁移三态(空→导入留标记;双非空→fail loud;host-medium 见标记→fail loud);导入保真(条目/audit/suggestions/consolidation meta 逐项对等)。

Step 3.3 验收对齐

- 写放大用例去预播种,SQLite 基线重定(205 次 add 不再产生 415 次全文件 fsync);同构建「host-medium vs sqlite」eval A/B 确定性层逐场景 EQUAL;`ExperimentalWarning` 不破坏宿主 stderr/baseCaptured 断言(`tests/integration/host.spec.ts` 通道);HOST_CONTRACT §10 清单全项过一遍。

### 阶段 4(仅立项)

净索引视图:阶段 1–3 稳定 + v2 A/B 基线在库后另起 proposed note,本计划不展开。

## 曾考虑的替代方案

- **执行细节并回母提案一节** —— 否。母 note 是决策记录,应随「定了什么」保持稳定;执行细节随施工持续修订(行号漂移、标定结果回填),独立成文可以让母 note 只在决策变更时更新。两 note 交叉链接,任一读者一跳可达。
- **单 release big-bang 落地** —— 否。母提案的四阶段各自独立可发布、可回滚;实施计划按 Step 切 commit 正是为了保住这个性质——任一 Step 出险,回滚边界是 commit 而不是 release。
- **整合输出用 JSON-schema 结构化输出替代行协议** —— 否。全库 LLM 协议均为行协议(judge 单词、curator `<id>:`),且宿主 LLM 通道没有结构化输出机制,输出一律经 `collectStreamText` 文本回收(`extract.ts:317-323`);引第二套协议就是引第二套解析与失败向量,而行协议的 fail-closed 纪律已被 dedup/extract spec 覆盖。
- **每轮层直接改 `findDuplicate` 支持跨 scope/锚点** —— 否。`findDuplicate` 的契约(same-scope 近似重复探测、单阈值)被 `tests/dedup.spec.ts` 的标定对钉死;在其上扩维度等于把「预筛」与「完整性」再次耦进一个函数。选择器新造、复用 bm25 原语,dedup.ts 只在 legacy kill-switch 删除时随之退役。

## 验收标准

- 每阶段:母提案对应阶段验收标准全过 + 本计划各 Step 内列的测试全绿 + `npm run build && npm run test` 绿 + 文档镜像(TECH_DESIGN 双语对)同步重录 sidecar。
- 阶段间不留「下一步开工前必须补」的洞:每 Step 的 commit 自带测试与(需要的)文档;kill-switch(legacy-judge、`sweepEnabled`、`storage`)在各自阶段内经测试可用。
- 全部阶段落地后:母提案与本 note 随最后阶段移入 implemented/ 并按既有格式改写,双 sidecar 重录。

## 风险

- 计划与代码漂移(行号失真、标定参数未回填)→ 每阶段落地同 commit 更新本 note 的事实层;行号只作 2026-09-04 快照锚点,符号名是稳定索引。
- 行协议在长桶下被 max-tokens 截断或解析失败 → fail-closed `new` + 桶大小上限(配置化);该方向的选择已定在「不误合并」。
- fail-closed-`new` 与现状 fail-closed-duplicate 的行为差在真实语料上的分布未知 → kill-switch(legacy-judge)保留一个 release;以落库条数、重复对计数、A/B 机械层观察后再删。
- 阶段 3 的双后端参数化暴露 DomainMemoryStore 的私有耦合 → 由 Step 3.1 的独立抽取 commit 先行消化,抽取本身零行为变化、由现有 spec 守卫。
