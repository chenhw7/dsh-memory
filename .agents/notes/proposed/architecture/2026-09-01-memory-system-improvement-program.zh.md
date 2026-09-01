# Agent Note: 记忆系统改进方案

Status: proposed

**执行进度（2026-09-01 更新）：** 第一波已在本仓库范围内全部结题——`structured-logging`（84f9550）、`substring-wording-drift`（1a60756）、`summary-scan`（16b5d83）、`ci-trigger-single-home`（490fad7）、`deployment-dataflow-doc`（08e0a45）、`fence-escaping`（4bd4d32）、`tool-read-redact`（8286d86）、`importance-signal`（0086503），各自携带验收信号、双语文档同步与 implemented Agent Note 三件套；`session-capture-repair` 因依赖宿主侧会话采集恢复（见「风险」节）搁置于 deepseek-harness 仓库。第二波进行中：`client-typecheck-gate` 已结题（存量 409→12，全修，门禁接线并经注入验证；paths 已改为解析到 node_modules 内的 devDependency 类型，无同级 checkout 依赖），`recall-stamp-batching` 已结题（盖章通道改经宿主 `KvTable.update` 原子 RMW，两条验收信号均有测试钉住），`janitor-pin-toctou` 已结题（快照仅预筛，pinned 重读移入写入链槽位；project 硬衰减残留守卫→删除窄窗口已如实记录），`contract-suite-real-store` 已结题（契约体双实现对跑，search 断言按 BM25 token 语义收紧），`dedup-idf-weighting` 与 `df-scope` 已结题（dedup/conflict/建议队列共用 bm25 分词与 IDF 加权重叠度、删 CJK_STOP_CHARS，search 的 df 改全库统计；golden 下限无退化）。`index-default` 的超越性 note 前置已满足；`importance-signal` 落地后 `entries-cap` 的淘汰序已可定义为 pinned → `accessCount` → `lastRecalledAt`。

本 note 合并两份独立评审的改进意见：better-harness 的项目评审（2026-08-31 快照，locale zh-CN，report contract v26）与归档评估报告 [MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md](../../../../docs/archive/MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md)。harness 报告是插件本地产物（`.qoder/better-harness/`），按 [committed-artifact-citations](../../implemented/process/2026-08-31-committed-artifact-citations.zh.md) 不作为可引用的提交物，因此它的每一条结论在本 note 中都重述为独立成立的代码事实并附 `文件:行号`。

## 问题

两份来源各自内部自洽，合并后却在四个层面互相牵制：优先级顺序互斥、前置依赖缺失、修复范围被低估、以及其中一条建议早已被一篇 implemented 状态的 Agent Note 否决。任何一侧单独执行都会造成可预期的返工。

harness 评审覆盖 Rules / Skills / Workflows 三个面，产出两条保留发现（`src/client` 无类型门禁、根 AGENTS.md 与实际 CI 矛盾），五个维度评分 62–70，唯独经验沉淀 35 分——因为 30 天窗口内 0 个可回看会话（采集告警 `disabled-source-root` / `missing-optional-root`），所有行为类结论都落在未观测状态。评估报告方向相反：它是三路并行只读代码审查，证据密度高，但快照冻结在 2026-08-31，且按 [dsh-prose-standard](../../../skills/dsh-prose-standard/SKILL.md) 与 [dsh-doc](../../../skills/dsh-doc/SKILL.md) 的约定，`docs/archive/` 是冻结历史，不得就地修订。

两者的互补性在一处交汇成关键结论：评估报告列为第一风险的「召回兑现」，其解锁条件恰好是 harness 报告标记为 0 证据的那项观测能力。没有会话侧召回触发统计，第一优先级建议无法被批准，也无法被否决。

## 提案

按依赖顺序而非按严重度排序，分六条轨道推进；每条改进条目携带独立的代码证据、一个可观测的验收信号和明确的前置项。观测能力（轨道 A）先行，因为轨道 F 的三条依赖它，且它是唯一能让「模型是否真的在用记忆」变得可观测的工作。

排序原则有五条：无行为风险的一致性修复先落地，避免后续改动叠加在互相矛盾的文档上；任何放大既有缺陷的改动必须排在该缺陷的修复之后；改变既有门禁或既有默认值的条目必须同时更新拥有该决策的 Agent Note；成本随运行天数增长的条目优先于成本恒定的条目；token 成本只能在收益已被测量时作为决胜依据，不能用来否决未测量的收益。

后两条把 `importance-signal` 从第三波提前到第一波，并反转了 `index-default` 的举证责任，理由见「非标策略的判据」与 `token-cost-asymmetry`、`schema-debt-first` 两条裁定。

### 证据等级约定

合并后每条结论标注证据等级，防止未观测维度混入代码事实。

| 等级 | 含义 | 可支撑的动作 |
|---|---|---|
| 代码核实 | 本次评审在当前 checkout 上逐条复核，附 `文件:行号` | 可直接排期实施 |
| 机制推演 | 由代码路径推演得出，未经运行时复现 | 实施前需构造复现用例 |
| 未观测 | 来源自述，本仓库内无可核验证据 | 只能排期「先取得证据」 |

### 来源核对与事实校正

两份来源的代码类结论在当前 checkout 上逐条复核。评估报告的结论绝大多数成立，三处计数需要校正；harness 指出的 CI 描述矛盾成立，且范围比它点名的更大。归档文档保持冻结，校正后的事实由本 note 承担归属。

| 源文档说法 | 复核结果 | 当前事实 |
|---|---|---|
| 仓库文档称 CI 是 tag 触发的 publish.yml（harness 指出） | 不成立 | [ci.yml](../../../../.github/workflows/ci.yml) 第 3–6 行在每次 push main 与 PR 运行 `npm ci` → `build` → `test`；publish.yml 第 10–13 行才是 `v*` tag 触发 |
| `annotateConflicts` 命中中英 14 个矛盾信号词 | 计数偏低 | `src/context/conflict.ts:49-53` 为 17 条（英文 10 + 中文 7） |
| dedup 停用词表 英文 35 + CJK 50 | 计数偏低 | `src/review/dedup.ts:22-27` 为 38 个英文词，`:37-52` 约 50 个 CJK 字符 |
| BM25 实现 125 行 | 计数偏高 | `src/store/bm25.ts` 共 124 行 |
| SEC-01 泄漏 key 已吊销 | 成立 | 已于 2026-08-31 在网关侧完成，不再作为改进项 |
| notesDir 路径逃逸面已消失 | 成立 | 随 [project-notes 不写仓库文件](../../implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md) 的架构决策整体消失 |

harness 报告中「近 89 次提交，`src/client/index.ts` 14 次提交、`MemorySection.tsx` 净变更约 2039 行」属于 git 历史统计，本次评审未复核，标注为未观测；其结论（`src/client` 是改动最热路径）不作为排期依据，排期依据是门禁缺口本身这一代码事实。

### 非标策略的判据

本项目多处偏离同类方案的通行做法。判据不是「标不标准」，而是**该选择在不在一个可替换的边界后面**：算法在函数边界后面，将来可整体替换；schema 与写语义一旦落盘就绑定了已有数据。

| 选择 | 是否非标 | 长期成本 | 依据 |
|---|---|---|---|
| CJK 字 + 相邻 bigram 分词 | 否，是通行做法 | 低 | Lucene 的 CJKAnalyzer 同样用 bigram；`src/store/bm25.ts:44-47` 是分词器内部细节 |
| 手写 124 行 BM25 | 是 | 低 | 封装在 `search()` 之后，换 FTS5 或换打分器时调用方不变 |
| 每次检索重建索引 | 是 | 低 | 不影响任何持久化格式，改动只在 `src/store/index.ts:297` |
| 检索侧无停用词 | 否，是通行做法 | 无 | IDF 已自适应承担同一职责，见 `stopwords-vs-idf` 裁定 |
| dedup 用手写 CJK 停用字表 | 是 | 中 | 它是 IDF 的手工替代品，且会误伤实词，见 `stopwords-vs-idf` 裁定 |
| schema 无 importance / confidence / tags | 是 | **高，且随时间增长** | 字段好加，已写入的条目补不回来（`src/types.ts:35-68`） |
| 单 JSON 文件 + `put` 整条替换 | 是 | **高** | 语义已漏到写放大、丢失更新、单写者三处；迁移无代码接缝 |

结论：需要担心的不是算法层的非标，是 schema 与写语义。算法债成本恒定，schema 债成本随运行天数单调增长——这是 `importance-signal` 必须提前的唯一理由。

## 冲突裁定

逐条比对两份来源的每一项修改意见后，以下 20 处需要裁定。裁定结果直接决定了轨道划分与执行顺序。

**`index-default`：评估报告第一优先级已被否决，但那条解锁条件本身无人排期。** 评估报告 §五 建议「重新评估 autoRecall / index 模式的默认值」，而 [注入模式保持 policy-only 默认档](../../implemented/architecture/2026-08-26-index-mode-stays-policy-only.zh.md) 已把「把 index 提为出厂默认」记为否决的替代方案，重引入条件是线上 recall 触发率统计表明真实会话漏搜了库里能答的查询。按 [notes/README](../../README.md) 的规则，implemented note 只能被新证据超越，不能被改写——这一点不变。但该条件要求的遥测在本仓库既不存在也无人排期，harness 评审又证实 30 天窗口 0 会话事件，因此它事实上是无限期阻塞而非可满足的条件。裁定：解锁路径改为翻转举证责任——提出一篇超越性 note，把默认档改为 `index`，以 golden 下限加一条明示的回退开关作为回归护栏，而不是继续等待一份没有主人的遥测；前置仍是 `recall-stamp-batching`。

**`token-cost-asymmetry`：用 token 成本否决未测量的收益是系统性偏差，不是中立权衡。** 上述否决的依据是常驻成本 ≈955 token 对 policy-only 的 ≈344 token，而同一篇 note 自己承认 golden set 只能证明「能搜到」、不能证明「会去搜」。这是拿精确测量的成本对未测量的收益比较，结构上必然是成本方胜出。量级上 955 token 在 200k 上下文里约 0.5%，而模型一次该召回却未召回的代价远高于每会话 600 token，且该失败在当前架构下不可观测。裁定：token 成本只在收益已被测量时作为决胜依据；本方案区分必要与不必要的消耗——常驻注入的 token 买的是可靠性，属必要；召回戳每次检索最多 50 次整文件重写、每次检索重建索引不换取任何能力，属不必要。只砍后者。

**`autorecall-before-batching`：开启自动召回会把写放大缺陷乘以每步一次。** 评估报告自身 §2.5 记录 `search` 默认对全部命中逐条盖召回戳，而 single 布局下每次 `put` 是整文件原子重写；`src/store/index.ts:319` 的 `void this.stampRecalled(all)` 与 `:328-337` 的逐条 `await put` 证实无批量合并。裁定：召回戳合并写（`recall-stamp-batching`）是任何默认值翻转的硬前置，不得并行。

**`ci-drift-scope`：harness 只点名根 AGENTS.md，实际有七处传播同一条过时事实。** 除 [AGENTS.md](../../../../AGENTS.md) 第 31 行外，[quality-gates](../../implemented/process/2026-08-31-quality-gates.zh.md) 配对两侧的第 18 行、[docs/testing.md](../../../../docs/testing.md) 与其中文配对版第 12 行、[dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md) 第 8 行、[dsh-ci-test-reliability](../../../skills/dsh-ci-test-reliability/SKILL.md) 第 24 行都把 publish.yml 描述为唯一 CI。只修根 AGENTS.md 会留下六处自相矛盾，恰好违反该修复自身引用的「一处事实一个家」规约。裁定：按 [docs/AGENTS.md](../../../../docs/AGENTS.md) 的分层归属做全仓修正，CI 触发边界这条事实归 [TECH_DESIGN.zh.md](../../../../docs/TECH_DESIGN.zh.md)（第 766 行已正确描述两个 workflow），其余六处改为链接。quality-gates 与 docs/testing 都是配对文档，改动需同步两侧并重录 sidecar。

**`agents-md-two-edits`：harness 两条修复意见落在同一个文件的相邻区域。** `client-typecheck-gap` 要求改写 AGENTS.md 第 41 行「客户端不经宿主构建类型检查」，`agents-md-ci-drift` 要求改写第 31 行。裁定：合为一次 AGENTS.md 修订；但第 41 行只在类型门禁真正落地后才改写，否则文档会承诺一个不存在的门禁——门禁若暂缓，该行保持原样。

**`client-gate-vs-quality-gates-note`：加门禁等于修改一条已记录的门禁决策。** [quality-gates](../../implemented/process/2026-08-31-quality-gates.zh.md) 把 `build` + `test` 记为刻意精简的完整门禁集，并把 `src/client` 的类型豁免记为既定架构决策。按 [docs/AGENTS.md](../../../../docs/AGENTS.md) 第 37 行，改动必须在同一次提交中更新拥有该决策的 note（正本、`.zh.md` 配对版、sidecar 三件）。另有实施风险：`src/client` 从未经过 `tsc`，门禁可能一次性暴露存量类型错误并阻塞其余全部轨道。裁定：先以只报告模式跑一次 `tsc --noEmit`，用实测错误数决定是「立即接线」还是「先清存量、后接线」；不得在未知存量的前提下直接接入 `npm run build`。

**`summary-index-before-scan`：把 summary 送进索引会扩大一条未扫描的注入通道。** `src/store/index.ts:297` 只对 `entry.content` 分词，而 `add`/`update` 只扫描 content（`:208-211`、`:248-251`），summary 在 `:220`、`:261-264` 未扫描直接落盘。裁定：`summary-scan` 必须先于或同时于 `summary-indexing` 落地，顺序颠倒会让未扫描字段成为检索命中原因并经未脱敏的工具读路径外泄。

**`golden-floors-not-acceptance`：检索侧改动的唯一护栏看不见它要修的问题。** [tests/recall-golden.spec.ts](../../../../tests/recall-golden.spec.ts) 钉住 success@5 ≥ 85% / P@1 ≥ 60% / MRR ≥ 0.75，而评估报告 §2.4 与归档的 [INDEX_MODE_EVALUATION.zh.md](../../../../docs/archive/INDEX_MODE_EVALUATION.zh.md) 都承认该夹具是主题互异的小库加关键词式查询，对同义与长尾无代表性。词干化还会同时改变词面命中与误命中，两个方向都看不出来。裁定：golden 下限是回归护栏，不是验收标准；`retrieval-stemming` 与 `summary-indexing` 的验收需要先扩充夹具，加入同义改写与词形变化用例，且改动前后都要跑 `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts` 留存对照数据。

**`stopwords-vs-idf`：给检索加停用词表与 IDF 职责重复，评估报告把停用词与词干化混为一谈了。** 停用词的唯一职责是压低「到处都出现所以不携带区分信息」的词的权重，而 `src/store/bm25.ts:111` 的非负 IDF 已自适应地做完这件事：候选集 20 条时，每条都出现的词得到 idf ≈ 0.024，只在 1 条出现的词得到 idf ≈ 2.64，相差约 110 倍。Lucene 的 StandardAnalyzer 与 Elasticsearch 的 standard analyzer 默认都不做停用词过滤，理由同此，另加停用词会破坏短语查询。评估报告把「停用词 / 词干化」并作一行，举的症状却是「testing 与 test 互不命中」——那是词干化（提召回）问题，不是停用词（提精确）问题。裁定：撤销「检索侧引入停用词」这条建议；症状对应的条目改为 `retrieval-stemming`，并单独评估。

**`dedup-stopwords-harm`：`dedup.ts` 的手写停用字表是 IDF 的替代品，且正在误伤实词。** `src/review/dedup.ts:82` 用的是 Jaccard，每个 token 权重相等、无 IDF，所以必须靠手写表压高频词——这是那张表存在的真实原因。代价是 `:51` 删掉了 `一/上/中/下`、`:49` 删掉了 `用/有/会/能/要/可/以`、`:43` 删掉了 `为`，而汉语虚词同时是实词的构词成分：「上海」对「海南」的 Jaccard 从 0.33 升到 0.50，「中国」对「美国」同样从 0.33 升到 0.50，两个无关词被推得更近，正好与该表的目的相反。收益也小：用它自己注释里的例子（`:33`），加表只把相似度从 0.75 降到 0.60。病根是 `:64` 的 CJK 正则无 `+`，是单字切分，而 `src/store/bm25.ts:35` 是字加 bigram——同一仓库两套 CJK 分词，弱的那套靠手写表补救。裁定：`dedup-idf-weighting` 让 dedup 与 conflict 复用 bm25 的 IDF 加权重叠度并删除 `CJK_STOP_CHARS`，净减少一个需长期维护的非标机制。

**`schema-debt-first`：schema 债与算法债的成本曲线不同，排序必须区分。** `src/types.ts:35-68` 无 importance / confidence / accessCount 字段，存活判定只有 `lastRecalledAt ?? createdAt` 与 pinned。加字段本身很便宜，但**已经写入的条目无法追溯补齐这些信号**——每多运行一天就多一批不可恢复的条目。相比之下手写 BM25、每次重建索引、检索无停用词都封装在函数边界之后，任何一天替换的成本都相同。裁定：`importance-signal` 从第三波提前到第一波，与轨道 A 并行；`entries-cap` 依赖它这一点不变。

**`zero-hit-fallback-scope`：零命中降级不能进注入面。** `src/store/index.ts:302` 只收 `score > 0` 的条目，零词法重叠即空结果。若降级路径返回「最近条目」，而 autoRecall 又开启，每个 agent step 都会把无关条目注入 prompt，同时抵消成本有界性与 `<memory-policy>` 那句「不要假设记忆已加载」的诚实语义。裁定：降级只作用于 `memory_search` 工具返回值，永不进入任何常驻注入面，且返回值必须显式标注为降级结果。

**`embedding-vs-zero-network`：语义层与「插件零凭据、生产代码零出站网络」互斥。** 评估报告 §4.1 把零凭据与零出站网络列为已验证的独特优势，LLM 一律走宿主 `ctx.llm`。embedding 平面要么引入出站调用，要么需要新的宿主能力接缝，并且会把每条记忆内容送往嵌入服务——比 §4.2 已点名的 `extractionModel` 数据流向问题严重一档。裁定：`semantic-plane` 只能走宿主接缝，且以 `deployment-dataflow-doc` 落地为前置；在此之前不进入排期。

**`scanner-allowlist-vs-cjk-rules`：两条安全建议在同一文件里方向相反。** `src/scanner.ts:75-85` 的 9 条 injection 规则全为英文，评估报告建议补 CJK 规则（扩大黑名单）；同时建议把休眠的 allowlist 生产接线或删除。`setAllowlist` 定义在 `:43`，仅被 [tests/scanner-corpus.spec.ts](../../../../tests/scanner-corpus.spec.ts) 引用。删除它就删掉了唯一的误报逃生门与对应测试覆盖。裁定：`cjk-injection-rules` 落地则 allowlist 必须生产接线，不得删除；先用中文误报语料测出误报率，再决定规则的严格度。

**`read-path-redact-vs-repair`：给读路径脱敏会让人审 UI 失去修复能力。** `src/tool/index.ts:77-89` 的 `toEntryJson`、`:180` 的 `formatEntryLine`、以及 `src/remote/index.ts:79` 的同名函数都未接 `redactBlocked`；后者正是可视化管理 UI 的数据源。全量脱敏后，被污染条目在 UI 里只剩 `[BLOCKED: …]`，`memory_replace` 类修复失去可读的原文。同时这条修复也是唯一的追溯清洗手段——评估报告 §4.2 指出黑名单只进不出，规则更新前入库的载荷无清洗路径。裁定：`tool-read-redact` 脱敏展示层，同时保留一条明确的原文读取路径供人审与修复使用，两者在同一次改动中一起落地。

**`entries-cap-needs-eviction-order`：容量上限缺少可用的淘汰序。** `src/store/index.ts:112`、`:118` 只对 audit 与 suggestions 各封顶 200，entries 无上限；`src/context/index.ts:75` 的 20 条是渲染折叠而非存储上限。今天唯一的存活信号是 `lastRecalledAt ?? createdAt` 与 pinned，正是评估报告批评的单一时间信号。裁定：`entries-cap` 不早于 `importance-signal`，或退而明确采用「仅 pinned 免淘汰、淘汰按最久未召回」并把该取舍写入本 note 的后继决策。

**`lost-update-is-put-semantics`：合并写本身不消解丢失更新竞态。** 三条问题同源：`KvTable.put` 是整条替换，无 read-modify-write、无 compare-and-swap。召回戳持有 search 时刻的旧引用（`src/store/index.ts:328-337`），janitor 的 pin 豁免是在 `:559-560` 的实时迭代上做 check-then-act，两者都不是靠减少写次数能修的。裁定：`recall-stamp-batching` 的验收信号必须包含「写入前重读当前记录」，而不仅是写次数下降；进程间单写者假设是宿主 storage-json 自述的限制，插件侧只能做检测，`cross-process-detect` 按检测项排期，不按修复项排期。

**`conflict-resolution-via-review`：自动消解与人审姿态冲突。** `src/context/conflict.ts:128-143` 只返回 id→status 映射，不合并、不改写；评估报告同时把 confirmBeforeWrite 加审计加人审 UI 列为五方案中最完整的维度。自动消解会绕过这条最强防线。裁定：`conflict-resolution` 走建议队列产出待审提案，不做自动合并；换述幅度大（Jaccard < 0.15）的纠错既不触发合并也不触发标注，这一残余缺口一并由该条目承担。

**`session-freshness-not-independent`：会话内新鲜度不是独立条目。** 快照在 `src/context/index.ts:359` 的 `session/created` 冻结，仅在干净的 `compaction/end`（`:366-372`）重冻结；中途刷新会破坏 KV-cache 纪律这条项目最强属性。opt-in 的 autoRecall 走 user 消息通道正是对该缺口的既定补位。裁定：并入 `index-default` 的超越性提案，不单独排期。

**`archive-stays-frozen`：源报告不得就地修订。** 上表三处计数与 CI 描述的校正只在本 note 生效；归档评估报告与 [MEMORY_SYSTEM_ANALYSIS.zh.md](../../../../docs/archive/MEMORY_SYSTEM_ANALYSIS.zh.md) 保持原貌并作为历史被链接。引用两份归档文档中的对比结论（OpenClaw / Hermes / NullClaw / OpenFang 细节）时按「前作文档记载」对待，本仓库内无法交叉验证。

## 改进条目

### 轨道 A：观测能力

其余轨道的公共前置。两条都不改变记忆的读写语义，但决定了哪些条目能被证据支撑。

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `session-capture-repair` | 30 天窗口 0 个可回看会话，采集告警 `disabled-source-root` / `missing-optional-root`（未观测） | 用评审插件的 session-analysis sources 诊断采集链路，恢复到能产出会话事件 | 再跑一次评审，eligibleSessions > 0 | — |
| `structured-logging` | 全 `src/` 无任何 logger；空 catch 分布在 `src/store/index.ts:651`、`src/context/index.ts:370`、`:401`、`src/review/index.ts:246`、`src/review/extract.ts:427`、`:779`、`src/tool/index.ts:222`、`:229`、`src/notes/index.ts:134`、`:150`（代码核实） | 后台路径接结构化日志与健康计数：flush 失败批次、janitor/curator 失败、审计写入失败、单条入库失败 | 注入一次可控失败，日志与计数都能观测到；`src/notes/cleanup.ts:70,74,93` 的 `console.log` 一并归并 | — |

### 轨道 B：文档与文案一致性

零行为风险，先落地以免后续改动叠加在互相矛盾的文档上。

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `substring-wording-drift` | `src/types.ts:113` 与 `src/tool/index.ts:243` 都写 `Substring search over entry content (case-insensitive)`，实现是 BM25 token 匹配（代码核实） | 两处改为如实描述 BM25 token 语义 | 工具描述与 `src/store/index.ts:297-311` 的实际语义一致；模型可见文案改动同步更新其行为测试 | — |
| `ci-trigger-single-home` | 七处文档把 publish.yml 描述为唯一 CI，见 `ci-drift-scope` 裁定（代码核实） | CI 触发边界归 TECH_DESIGN 配对文档，其余六处改为链接 | 七处描述与两个 workflow 一致；quality-gates 与 docs/testing 两对配对文档同步且 sidecar 重录 | — |
| `deployment-dataflow-doc` | `extractionModel` override 可把对话片段引向任意 provider；`trustedHosts` 过宽时同网段可读写记忆库，而记忆内容必进后续 system prompt（代码核实，见 `src/remote/index.ts:14-20`） | 在部署文档写明两项配置的数据流向含义与收紧建议 | 配置面风险在部署文档可检索到 | — |

### 轨道 C：验证覆盖

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `client-typecheck-gate` | [tsconfig.json](../../../../tsconfig.json) 第 34 行 `exclude: ["src/client"]`，仓库内无其他 tsconfig；[package.json](../../../../package.json) 无 `typecheck` 脚本，`build` = `tsc -p tsconfig.json && node scripts/fix-imports.cjs && node scripts/build-client.cjs`；`scripts/build-client.cjs` 只做 esbuild 打包（代码核实） | 先只报告模式测存量，再新增 `tsconfig.client.json`（继承现有配置，include 限定 `src/client`，JSX 运行时对齐 build-client.cjs 与 vitest.config.ts，`noEmit`）并接入 build | 在 `src/client` 注入类型错误后 `npm run build` 失败；移除后 build 与 test 全绿，`lib/client/index.js` 产物格式不变 | 存量错误数已知；同批更新 quality-gates note 三件与 AGENTS.md 第 41 行 |
| `contract-suite-real-store` | `runStoreContractSuite` 定义在 `tests/store-contract.spec.ts:137`，唯一调用在 `:255` 且只跑内存版 TestMemoryStore；测试实现的 search 恰是子串语义（代码核实） | 契约套件改为按 BM25 token 语义断言，并指向真实 DomainMemoryStore | 同一套契约同时通过两个实现 | `substring-wording-drift` |

### 轨道 D：安全对称

评估报告把安全短板概括为「prompt 面完整、工具面缺失」，六条按性价比排序。

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `tool-read-redact` | `redactBlocked` 只在 `src/context/index.ts:165,282,284`、`src/context/policy.ts:225-226`、`src/review/extract.ts:240,676` 生效；`src/tool/index.ts:77-89`、`:180` 与 `src/remote/index.ts:79` 原样回传 content（代码核实） | 展示层接入 `redactBlocked`，同时保留供人审修复的原文读取路径 | 被污染条目在工具与 UI 展示为占位符，人审仍能取到原文并完成替换 | — |
| `cjk-injection-rules` | `src/scanner.ts:75-85` 的 9 条 injection 规则全为英文 ASCII，无任何 CJK 模式，而 BM25 专门做了 CJK 分词（代码核实） | 补中文注入短语规则，配套中文误报语料 | 中文注入语料被拦；误报率在语料上可量化 | allowlist 保持生产可用 |
| `summary-scan` | `add` 扫 `input.content`（`src/store/index.ts:208-211`）、`update` 扫 `newContent`（`:248-251`），summary 在 `:220`、`:261-264` 未扫描；suggestions 与 adopt 同样（`:368-371`、`:449-452`） | `add`/`update`/建议采纳三处补扫 summary | 含敏感载荷的 summary 写入被拒 | — |
| `fence-escaping` | 存储内容含 `</memory-context>` 可越出定界围栏，渲染层无转义（机制推演） | 渲染前转义或拒绝闭合标签 | 构造含闭合标签的条目，注入面定界不被破坏 | — |
| `allowlist-decision` | `setAllowlist` 定义在 `src/scanner.ts:43`，仅测试引用（代码核实） | 生产接线，成为误报逃生门 | 生产路径可配置 allowlist 且有测试覆盖 | 与 `cjk-injection-rules` 同批 |
| `rpc-method-auth` | `src/remote/index.ts:14-20` 明示无 per-method 授权注册表，信任围栏在传输层；`add`/`update`/`removeEntry`/`pin`/`archive`（`:324,343,368,376,435`）均无方法级守卫（代码核实） | 与归档 [SECURITY_AUDIT.zh.md](../../../../docs/archive/SECURITY_AUDIT.zh.md) 的 SEC-04 合并处理，收紧 trustedHosts 默认并评估方法级守卫 | 宽 trustedHosts 配置下写方法不再无条件放行 | `deployment-dataflow-doc` |

### 轨道 E：词法匹配质量

轨道名从「检索质量」改为「词法匹配质量」，因为 dedup 与 conflict 走的是同一套词法机制，问题与修法与检索侧同源。

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `summary-indexing` | `src/store/index.ts:297` 只对 content 分词，summary 是人工浓缩的高信号短文本却不进索引（代码核实） | summary 进索引，考虑 BM25F 字段加权 | 扩充后的夹具上同义与短查询召回提升，golden 下限不退化 | `summary-scan`、夹具扩充 |
| `dedup-idf-weighting` | `src/review/dedup.ts:82` 用无 IDF 的 Jaccard，靠 `:37-52` 的手写 `CJK_STOP_CHARS` 补救；`:64` 的 CJK 是单字切分，与 `src/store/bm25.ts:35` 的字加 bigram 不是同一套（代码核实） | dedup 与 conflict 复用 bm25 的分词与 IDF 加权重叠度，删除 `CJK_STOP_CHARS` | 「上海」对「海南」、「中国」对「美国」的相似度低于改动前；既有 dedup 判定用例不回归 | — |
| `retrieval-stemming` | `src/store/bm25.ts` 无词干化，`testing` 与 `test` 互不命中（代码核实） | 仅对 Latin token 做保守词干化，CJK 路径不变 | 扩充夹具上词形变化用例命中，golden 下限不退化 | 夹具扩充 |
| `zero-hit-fallback` | `src/store/index.ts:302` 只收 `score > 0`，零重叠直接空结果（代码核实） | 仅在 `memory_search` 返回值上提供降级，结果显式标注 | 零词法重叠查询返回带降级标注的结果，注入面不受影响 | — |
| `df-scope` | `src/store/bm25.ts:94-101` 的 df 只在当次过滤后的候选集上统计；候选集小到 3 条时，纯虚词也能拿到 idf ≈ 0.98（代码核实） | df 改为按全库统计或设下限，消除小候选集的 IDF 噪声 | 小候选集下虚词不再影响排序 | — |
| `semantic-plane` | 纯词法 BM25，同义、跨语言、零词面重叠结构性漏召（代码核实）；跨语言被 TECH_DESIGN 明确排除在词法检索范围外 | RRF 融合词法与向量分数，失败降级词法，且只走宿主接缝 | 同义与跨语言用例召回；宿主接缝不可用时退回词法且无出站调用 | `deployment-dataflow-doc`、`embedding-vs-zero-network` 裁定 |

### 轨道 F：写路径与生命周期治理

| 条目 | 证据 | 动作 | 验收信号 | 前置 |
|---|---|---|---|---|
| `recall-stamp-batching` | `src/store/index.ts:319` fire-and-forget，`:328-337` 逐条 `await put`，跳过条件仅为 `lastRecalledAt === now && staleSince === undefined`（`:333`）；single 布局下每次 put 是整文件原子重写（代码核实；50 次重写为机制推演） | 合并为一次批量写，且写入前重读当前记录 | 一次 50 条命中的搜索只触发一次文件重写；并发 `memory_replace` 与召回戳交错时新内容不被回滚 | `structured-logging` 便于观测 |
| `janitor-pin-toctou` | pin 豁免在 `src/store/index.ts:559-560` 的实时迭代上做 check-then-act，循环内含 `await`（机制推演） | 遍历与删除之间重读 pinned 状态 | 构造遍历期间 pin 的用例，条目不被删除 | — |
| `importance-signal` | schema 无 confidence / importance / accessCount 字段（`src/types.ts:35-68`）；存活判定只有 `lastRecalledAt ?? createdAt`（`:562`）与 pinned（代码核实） | 引入重要性或置信度信号，并接入排序与淘汰。**成本随运行天数增长：已写入的条目无法追溯补齐，见 `schema-debt-first` 裁定** | 新条目携带该信号；排序与淘汰不再只依赖单一时间信号 | 无，排在第一波 |
| `entries-cap` | audit 与 suggestions 各封顶 200（`src/store/index.ts:112`、`:118`），entries 无上限；curator 只压长不压量且计数器是进程内变量 | 设 entries 上限并定义淘汰序 | 超限时按既定淘汰序收敛，pinned 不被淘汰 | `importance-signal` 或明确记录退化取舍 |
| `topic-forget` | forget 语义只有按 id 硬删、unpin、UI 手动 archive（代码核实） | 支持按主题批量遗忘 | 按主题一次性移除相关条目并留审计 | — |
| `conflict-resolution` | `src/context/conflict.ts:128-143` 只标注不消解；conflicting 需信号词且 Jaccard ≥ 0.2（`:85`），stale ≥ 0.15（`:79`、`:90`）；换述幅度大的纠错两侧都不触发（代码核实） | 消解提案走建议队列待人审；补齐低相似度纠错的检出 | 大幅换述的纠错能产出待审提案，旧条目不再原样注入 | — |
| `cross-process-detect` | 宿主 storage-json 自述单写者假设，双 DSH 进程共享 `$DSH_HOME` 时互相整文件覆盖且无检测（代码核实，宿主侧限制） | 插件侧做检测与告警，不做锁 | 并发进程场景下能观测到告警 | `structured-logging` |
| `scale-trigger-selfcheck` | 迁移触发条件（条目千级、文件 MB 级、多进程、向量平面）只是文档约定，无代码接缝（代码核实） | 触发条件实现为启动自检告警 | 越过阈值时启动期产生一次告警 | `structured-logging`；与 `entries-cap` 二选一或明确分工 |

### 待超越、暂缓与未观测

| 条目 | 状态 | 条件或路径 |
|---|---|---|
| `index-default` | 待超越提案 | 不再等待遥测。提出一篇超越 [注入模式保持 policy-only 默认档](../../implemented/architecture/2026-08-26-index-mode-stays-policy-only.zh.md) 的 note，把默认档改为 `index`，用 golden 下限加一条明示回退开关守回归；前置是 `recall-stamp-batching` 已落地 |
| `semantic-plane` | 暂缓 | `deployment-dataflow-doc` 落地，且确认嵌入调用可完全走宿主接缝 |
| `rollback-path` | 未观测 | harness 评审未检视回滚与恢复路径；先取得一次可核验的交付事件证据 |

## 执行顺序

四波推进，每波内部可并行，跨波有硬依赖。

第一波：`session-capture-repair`、`structured-logging`、`importance-signal`、`substring-wording-drift`、`ci-trigger-single-home`、`deployment-dataflow-doc`、`summary-scan`、`fence-escaping`、`tool-read-redact`。除 `importance-signal` 外均无行为风险或风险自足；`importance-signal` 在此是因为它的成本随运行天数增长，不是因为它紧急。

第二波：`client-typecheck-gate`（先测存量）、`contract-suite-real-store`、`recall-stamp-batching`、`janitor-pin-toctou`、`dedup-idf-weighting`、`df-scope`、`cjk-injection-rules` 与 `allowlist-decision` 同批、`zero-hit-fallback`、`rpc-method-auth`。

第三波：夹具扩充、`retrieval-stemming`、`summary-indexing`、`entries-cap`、`cross-process-detect`。

第四波：`topic-forget`、`conflict-resolution`、`scale-trigger-selfcheck`；`index-default` 在 `recall-stamp-batching` 落地后即可提出超越性 note，`semantic-plane` 在 `deployment-dataflow-doc` 落地后重新评估。

## 曾考虑的替代方案

**沿用评估报告 §五 的四步优先级顺序。** 否决：它把召回兑现排在第一位却没有把召回戳合并写记为前置——按该顺序执行会先放大写放大缺陷；而且它把重要性评分排在末位，恰好是唯一成本随时间增长的条目。

**采纳评估报告「检索侧引入停用词」这条建议。** 否决：与 `src/store/bm25.ts:111` 的 IDF 职责重复，实测权重差约 110 倍已足够压制高频词；Lucene 与 Elasticsearch 的默认分析器同样不做停用词过滤。该建议的举证症状（`testing` 与 `test` 互不命中）属于词干化范畴，已改由 `retrieval-stemming` 承担。完整推理见 `stopwords-vs-idf` 裁定。

**保留 `dedup.ts` 的手写 `CJK_STOP_CHARS` 表，只做增补。** 否决：它是给缺 IDF 的 Jaccard 打的补丁，而汉语虚词同时是实词构词成分，删字会把「上海」与「海南」这类无关词推近；继续增补只会扩大误伤面。改为复用已有的 IDF 机制，净减少一个非标组件。

**两份来源各自落成两篇 note。** 否决：20 处裁定分四类——跨来源的依赖（评估报告的第一优先级与 harness 标记为 0 证据的观测能力互相牵制）、来源内部的顺序倒置（索引 summary 早于扫描 summary）、来源与既有仓库决策的冲突（类型门禁与 quality-gates、index 默认值与 policy-only 决策）、以及来源建议本身不成立（检索侧停用词）。分成两篇会让两侧的排序各自成立而互不校验，前两类冲突无法被任一篇单独发现。

**就地修订归档评估报告，把校正写回原文。** 否决：`docs/archive/` 是冻结历史，[dsh-prose-standard](../../../skills/dsh-prose-standard/SKILL.md) 与 [dsh-doc](../../../skills/dsh-doc/SKILL.md) 都把它排除在评审与编辑之外；校正后的事实需要一个活跃归属，这正是 note 的职责。

**直接执行 harness 的两条 aiFixPrompt。** 否决：CI 漂移的修复范围被低估六处，且 `client-typecheck-gap` 的 prompt 会在不更新 quality-gates note 的情况下改变一条已记录的门禁决策，也未处理 `src/client` 存量类型错误的未知量。

**把改进方案作为常设文档放进 `docs/`。** 否决：[docs/AGENTS.md](../../../../docs/AGENTS.md) 的分层表把提案与取舍归 Agent Notes，把历史规划归 `docs/archive/`，`docs/` 树中没有「改进路线图」这一类归属。

## 验收标准

每条改进条目要么带着表中那个可观测信号落地，要么移入待超越/暂缓/未观测三类之一并记录条件——不允许以「已评估」结题。

改变既有默认值、既有门禁或既有架构决策的条目，在同一次提交中更新拥有该决策的 Agent Note；`client-typecheck-gate` 对应 [quality-gates](../../implemented/process/2026-08-31-quality-gates.zh.md) 的三件套，`index-default` 以一篇超越性 note 落地，而非改写 [注入模式保持 policy-only 默认档](../../implemented/architecture/2026-08-26-index-mode-stays-policy-only.zh.md)，且该 note 必须记录新的成本数据与回退开关。

CI 触发边界这条事实在全仓收敛到一个归属，七处描述互不矛盾。检索侧改动在扩充后的夹具上留存改动前后对照数据，golden 下限不退化。

本 note 全部条目结题后移入 `implemented/`，或按 [notes/README](../../README.md) 的规则拆分为各自的决策记录。

## 风险

`client-typecheck-gate` 可能一次性暴露 `src/client` 的存量类型错误。该目录从未经过 `tsc`，错误数未知，最坏情况是它阻塞其余全部轨道——这是先跑只报告模式的唯一理由。

`tool-read-redact` 若只做脱敏不保留原文读取路径，会让人审 UI 对被污染条目失去修复能力，把一条安全加固变成一条可用性回退。

`retrieval-stemming` 与 `summary-indexing` 只有一个已知不具代表性的夹具做护栏。扩充夹具本身依赖人工构造同义与长尾用例，其代表性同样无法自证，改动的真实收益存在被高估的可能。

轨道 A 依赖宿主侧会话采集恢复，插件侧无法自证。若采集无法恢复，「模型是否真的在用记忆」这一问题将长期不可观测——这正是 `index-default` 不再以该遥测为前置的原因，但也意味着翻转默认档后只能靠 golden 下限与用户反馈发现回归，无法量化收益。

把默认档翻到 `index` 会让常驻成本从约 344 token 涨到约 955 token，并随库存线性增长，约 100–140 条时触及字符预算后卷起为类别计数行。若上下文预算紧张的宿主场景确实存在，该改动会在那里表现为回退——回退开关必须与改动同批落地，不能事后补。

`dedup-idf-weighting` 会改变既有 dedup 与 conflict 的判定结果，进而改变建议队列里哪些条目被判为重复。改动前需要先固定一批当前判定的用例作为对照，否则无法区分「修好了」与「换了一种错」。

丢失更新竞态、janitor TOCTOU、50 次整文件重写、围栏标签伪造四项均为机制推演，未经运行时复现。为它们排期的改动应先构造复现用例，否则无法证明修复有效。

本 note 只有中文版，偏离了 [notes/README](../../README.md) 的 `.zh.md` 配对约定。英文正本待补，补齐时按双语契约建立配对并记录 sidecar。
