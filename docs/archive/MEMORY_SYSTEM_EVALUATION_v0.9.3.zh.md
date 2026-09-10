# dsh-memory（Cairn）深度评估报告

**评估对象**：`@chenhw7/dsh-memory` v0.9.3（2026-09-10 工作区快照）
**性质**：只读代码评估，评估过程未修改任何代码。本文是冻结的分析快照，归档后不随代码演进更新；当前事实以 [TECH_DESIGN](../TECH_DESIGN.zh.md) 与源码为准。本文是 [MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md](MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md)（基于 v0.7.0 撰写）的继任评估。
**方法**：单线程顺序只读代码审查：通读 `src/` 全部核心模块（identity / review / store / context / tool / scanner / notes / remote / client 的实现源码），核对 `tests/` 契约与 recall golden 基线、eval 语料结构、`.agents/notes/` 决策记录（含[改进方案笔记](../../.agents/notes/proposed/architecture/2026-09-01-memory-system-improvement-program.zh.md)的全部裁定）与 TECH_DESIGN；v0.7.0 评估与改进方案的每一条结论在当前代码上逐项交叉核验。
**标注约定**：未标注者为代码事实（附文件与行号）；推测处显式标注（推断）。

## 一、总体评价与核心结论

**总体评价**：Cairn v0.9.3 是一个"工程纪律持续高于检索能力、且工程纪律本身在快速收敛检索短板"的记忆系统。v0.7.0 评估指出的第一风险（默认零内容召回）与第三风险（工具面安全不对称）已被 digest-first 默认档与读路径脱敏根除；写路径竞态、写放大、静默吞错三大缺陷已按改进方案笔记四波全部结题。当前剩余的结构性短板集中在**捕获面**（信号库窄、中期 review 只喂命中片段）与**治理面的覆盖完整性**（删除操作绕过人审队列）。一句话定位：一个把"别把上下文搞坏"做到同类最优、开始把"该记的记下来"补齐、但"该想起来的想起来"仍押注词法平面边界与模型自觉的系统。

**核心结论**（按重要性排序）：

1. **confirm 模式的治理覆盖有缺口：删除与钉住不进人审队列。** `memory_remove` / `memory_forget` / `memory_pin` / `memory_unpin` 的 execute 路径没有 `confirmMode()` 分支（[src/tool/index.ts L727-731](../../src/tool/index.ts#L727-L731)、[L776-829](../../src/tool/index.ts#L776-L829)、[L1087-1146](../../src/tool/index.ts#L1087-L1146)），而 TECH_DESIGN 的 G11 目标声明是"把每次自动提取*以及*模型发起的写入都路由进待确认提议队列……模型永远无法自我提升"（[TECH_DESIGN L65](../TECH_DESIGN.zh.md#L65)）——实际被门住的只有 `memory_add` / `memory_replace` / `identity_update`（TECH_DESIGN L399 只描述了前两者的接线）。`forget` 的 `confirm: true` 双确认、pinned 豁免与批量上限是对**模型自律**的防护，不是对**人审治理**的执行；打开 `confirmBeforeWrite` 的用户合理期望"模型做的一切都要我点头"，现状与期望不符。结构性根因是 suggestion schema 只能表达内容提案，无法表达删除/钉住提案。
2. **衰减钟不感知内容更新**：janitor 的存活判定是 `lastRecalledAt ?? createdAt`（[src/store/index.ts L1383](../../src/store/index.ts#L1383)），`updatedAt` 不参与。一个 40 天前创建、从未召回、但昨天刚被整合 merge 进重要新信息的 project 条目，今天会被 janitor 硬删——内容变新、寿命不变。排序平级决胜用了 `updatedAt`（L819）而衰减钟没用，两个语义不一致；容量淘汰序（[L1176-1179](../../src/store/index.ts#L1176-L1179)）同样忽略 `updatedAt`，同一性质的问题存在两处。
3. **候选信号捕获是整条链最窄的瓶颈**：中期 review 只喂信号命中的片段（`buildReviewMessages` 只含 candidates，[src/review/extract.ts L382-392](../../src/review/extract.ts#L382-L392)），未命中信号库的偏好陈述要等到压缩/销毁 flush 才被提取——延迟一整个会话；crash 终止（非 dispose）的会话无 flush，全部丢失。信号库仅 12 条 keyword + 11 条 correction（[src/review/accumulator.ts L91-126](../../src/review/accumulator.ts#L91-L126)），累加器无 assistant 侧信号分支。阈值 10 配上窄信号库，实际提取主力是 flush 路径，drain 更像兜底。
4. **flush 失败单次尝试即丢批次**：fire-and-forget、无重试（[src/review/index.ts L329-350](../../src/review/index.ts#L329-L350)），被遮蔽片段永久损失（仅 `reportFailure` 进 `health().backgroundFailures`）；且失败也预扣预算（`checkBudget` 先扣后跑，[L290-297](../../src/review/index.ts#L290-L297)），20 次失败耗尽预算后本会话彻底放弃。对照之下 drain 失败保留批次（高水位只在成功后推进，[L436-461](../../src/review/index.ts#L436-L461)）——两者失败语义不一致。
5. **hit 信号与写审计共用 200 条滚动窗**：`markHits` 每次命中写一条 `update` 审计（[src/store/index.ts L917](../../src/store/index.ts#L917)），`hitSignalEnabled` 开启后 usage 信号会快速把真正的写审计滚出窗口。"每次写入都可审计"在实现上是"最近 200 次可审计"；hit 是读信号，与写共用滚动窗在语义上放错了位置（`hitSignalEnabled` 默认 false 是现行的缓解）。
6. **KV-cache 纪律与安全防线达到同类标杆水准**（§2.4、§2.7 详述），golden 基线 success@5=100% / P@1=82.9% / MRR=0.902（zh 100%），词法平面已接近其能力上限；语义平面按裁定暂缓（零凭据、生产零出站网络），是记录在案的取舍而非疏忽。

### 核验勘误（对 TECH_DESIGN 当前文本的两处漂移）

| TECH_DESIGN 现文 | 代码实际 | 证据 |
|---|---|---|
| G11："把每次自动提取*以及*模型发起的写入都路由进待确认提议队列"（L65） | 只有 `memory_add` / `memory_replace` / `identity_update` 走队列；remove / forget / pin / unpin 直接执行 | 结论 1 的证据链 |
| §6："同作用域 Jaccard > 0.15 的提议计为一次重复"（L338） | 建议队列去重是 IDF 加权重叠 > **0.3**（`SUGGESTION_DUP_THRESHOLD`），且是 weighted overlap 而非 Jaccard——`dedup-idf-weighting` 裁定落地时 §6 未同步 | [src/store/index.ts L268-273](../../src/store/index.ts#L268-L273)、[L978-980](../../src/store/index.ts#L978-L980) |

## 二、八维度深度分析

### 2.1 身份层（SOUL.md / USER.md）触发机制

**设计**：身份层是"自由生长"哲学——seed-once（插件播种一次后永不覆盖，文档只经对话写生长，[src/identity/seeds.ts L1-14](../../src/identity/seeds.ts#L1-L14)）、整文档替换、版本历史 cap 20 + revert（revert 落新版本，不毁历史，[src/store/index.ts L1293-1300](../../src/store/index.ts#L1293-L1300)）。`identity_update` 是**模型主动调用的工具，没有自动触发器**；驱动力完全来自注入的契约文本：SOUL 种子的"延续"段（[L61-64](../../src/identity/seeds.ts#L61-L64)，"这些文件就是你的记忆。读它们，更新它们"）、SOUL_NOTE 的优先级链与 announce 纪律（[src/context/policy.ts L80-83](../../src/context/policy.ts#L80-L83)），以及工具描述里的"重写后必须告知用户"（[src/tool/index.ts L284-292](../../src/tool/index.ts#L284-L292)）。

**频率控制**：无冷却、无每会话上限。真正的节制机制有三道且都设计得当——① KV-cache 纪律：快照在 `session/created` 冻结，`identity_update` 的结果本会话不注入（工具结果明示"下一会话生效"），compaction/end 重冻结时才浮出（前缀反正要重建）；② `confirmBeforeWrite`：提案按 kind 去重进队列（[src/store/index.ts L1022-1058](../../src/store/index.ts#L1022-L1058)），重复提案 hits++，人类采纳才落盘；③ 预算硬门：soul 2000 / user 3000 字符，超限整体拒绝（[src/tool/index.ts L1195-1196](../../src/tool/index.ts#L1195-L1196)），强制模型压缩。

**Token 经济**：两文档合计约 5000 字符常驻（中文 1–2 char/token，实际约 2500–5000 token），opt-in 默认关闭（[src/identity/settings.ts L12](../../src/identity/settings.ts#L12)）。关键防重复机制是 anti-echo 预过滤（[src/review/extract.ts L344-373](../../src/review/extract.ts#L344-L373)，IDF 加权重叠 >0.6 判为身份复述并丢弃），防止提取管线把已注入的身份文档再存成记忆条目——身份层与记忆层交互面上最易被忽视的坑，此处有 fixture 钉住。

**判断**：设计自洽，token 纪律优秀。结构性弱点：**增长完全依赖宿主模型的主动性**。USER.md 没有任何自动升格路径——用户偏好持续沉淀为 user-scope entries（碎片化），而不是蒸馏进画像文档；弱模型可能整条链路基本不触发。缺少一个低频的 identity review pass 把高信号条目提议进 USER.md（经 confirm 队列），见改进计划 P1-8。

### 2.2 记忆自动存储的触发率与覆盖率

**信号库**：12 条 keyword（中 6 英 6）+ 11 条 correction（中 6 英 5）（[src/review/accumulator.ts L91-126](../../src/review/accumulator.ts#L91-L126)）+ pitfall 失败序列配对（同签名连续失败 ≥2 → 成功，emit `pitfall-resolved`；单发失败故意不捕获；streak cap 8、错误文本 500 字符截断，[L265-317](../../src/review/accumulator.ts#L265-L317)）。累加器是纯同步投影折叠，无 LLM——架构干净。

**四条触发路径**：① `agent/pre-step` 未处理候选 ≥10 → review drain（踩坑批走专用结构化 prompt，其余走通用 prompt；预算 20/会话）；② `compaction/end` flush 被遮蔽片段全量；③ `session/disposed` flush（5 秒超时）；④ curator / sweep 低频维护写。

**漏捕面（确认，主要短板）**：三类具体漏捕——陈述式偏好（"我喜欢简洁回复"）不命中任何模式；assistant 侧的复盘经验无信号路径（累加器只折叠 `user/message` 与 tool 事件）；候选上下文贫困（correction 候选只带命中的那条 user 消息全文，"不对，用 pnpm"若前文不在同一条消息里，提取时缺指代对象）。另外 correction 库里的"不要"是汉语常用否定词，误命中会加速 drain 消耗预算——funnel 哲学接受误命中（提取 prompt 做保守准入），但预算按 drain 计费时误命中有真实成本。

**冗余写入面（反向问题不大）**：三层去重（entry 0.15 / consolidation 0.2 IDF 阈值 + 锚点 df≤2 OR 信号）+ 每批至多一次整合 LLM 调用（[src/review/consolidate.ts L53-75](../../src/review/consolidate.ts#L53-L75)），merge 有 600 字符上限防无限增长（[src/review/dedup.ts L93](../../src/review/dedup.ts#L93)），裁决解析 fail-closed 到 `new`（宁可冗余不可错删）——失败方向选得对。

**评审失败语义**：结论 4 详述——drain 保留批次、flush 丢弃批次，两种语义并存。附带发现：预算按"drain"计数而非 LLM 调用（一个 drain 可含踩坑 + 通用 + 整合最多 3 次调用；代码注释声明该计费单位是故意的，[src/review/extract.ts L868-870](../../src/review/extract.ts#L868-L870)），但 Config 字段描述写的是"Max extraction calls per session"（[src/review/index.ts L81](../../src/review/index.ts#L81)）——措辞与实际单位漂移，实际上限比名字暗示的宽 3 倍。

**判断**：管道架构清晰，但信号捕获是唯一没有量化观测的环节（无信号命中率遥测），改进计划第一优先级。

### 2.3 记忆召回时机与准确性

**打分策略**：Okapi BM25（K1=1.2 / B=0.75）+ 非负 RSJ IDF + CJK 一元 + 相邻 bigram（Lucene CJKAnalyzer 同款做法，"记忆"不再匹配所有含"记"的条目）+ Latin 保守词干化（identity-preserving 规则集，[src/store/bm25.ts L39-63](../../src/store/bm25.ts#L39-L63)）+ summary 并入 token bag（隐式 BM25F：人工浓缩的高信号文本与正文同 tf，[src/store/index.ts L537-542](../../src/store/index.ts#L537-L542)）+ **全库 df 表**（小候选集 IDF 噪声已修，`df-scope` 裁定结题）。

**量化验证**：golden set 35 条目 / 35 查询（en+zh），实测 **success@5=100% / P@1=82.9% / MRR=0.902 / zh success@5=100%**，地板 0.85 / 0.75 / 0.60 / zh 0.80（[tests/recall-golden.spec.ts L78-98](../../tests/recall-golden.spec.ts#L78-L98)）。夹具自认不具代表性（主题互异小库、关键词式查询）——是回归护栏不是验收标准，同义/长尾不在其代表性内。

**注入纪律与时效性**：digest 默认模式下常驻段只有指令语域文本，数据走一次性 `<memory-digest>` 清单（800 字符预算，类别计数 + 锚点主题词）+ 每步 `<recalled-memory>` 围栏（1200 字符，BM25 命中 keyed on user text，minChars 12）。压缩边界失效重读（Hermes 式）：`compaction/end` 重冻结 + 清单重布防，mid-session 学到的记忆不 staleness 到会话结束。

**"频率即信号"评估**：有效，且信号分层是本项目最精致的部分——**tool 读全戳**（`accessCount`++，淘汰/排序信号）、**fence 命中轻量戳**（只 `lastRecalledAt`，明确防止"查询运气"污染淘汰信号，[src/types.ts L30-38](../../src/types.ts#L30-L38) 把设计意图写透）、**hitCount**（答案回声，IDF 覆盖率 ≥0.25 判定，opt-in，只喂 sweep 排序、永不驱动删除）。三层信号职责不交叉。

**残余**：语义漏召（同义/跨语言/零词面重叠）是词法平面的结构性盲区，`semantic-plane` 被裁定暂缓（零出站网络约束）——记录在案的取舍。zero-hit fallback 只在工具层且显式标注，注入面保持严格词法。

**判断**：词法平面上召回已接近上限，时效性靠围栏补位。唯一实质缺口是**不可观测性**——fence 命中率、search 使用率无遥测，宿主侧 session capture 修复搁置后，"模型是否真的在用记忆"仍不可见。

### 2.4 KV-cache 利用率与缓存纪律

**层级结构**（按易变度排序，[src/context/index.ts L137-157](../../src/context/index.ts#L137-L157)）：部署 persona(0) → soul(80) / user-profile(81) → 宿主工具指引(1000–5000) → memory(6000) / project-notes(6001) → 文件引用(9000)。数据段后置，重冻结只牵连前缀尾部，永不牵连工具指引中段——这是把 OpenClaw 的 CONTEXT_FILE_ORDER 教训（易变数据放最后、贴缓存边界）**吸收得更彻底**的答案：digest 模式干脆让数据不驻留（"指令驻留，数据不驻留"）。

**冻结纪律**：快照 `session/created` 冻结、会话内复用同一份（[L626-676](../../src/context/index.ts#L626-L676)）；compaction 是唯一被认可的重新冻结时机（[L699-711](../../src/context/index.ts#L699-L711)），同一时机为一次性清单消息重新布防；设置实时变但内容冻结。每个注入面有独立预算（memoryCharLimit + memoryMaxEntries 双上限、notes 分半区、digest 800、fence 1200），且 ≈token 成本直接印在表面上（自报告）。

**stale 行为**：衰减条目从注入面隐藏（折叠成一行计数注记，仍提示可 search 召回），但完全可搜索、工具面带 `stale: true` 可见、tool 召回复活——衰减不破坏前缀（stale 只在冻结时读出），也不销毁信息。superseded 条目从注入与检索面退出，工具面可导航。

**权衡判断**：步尾围栏虽每步追加新消息（进历史、compaction 会遮蔽），但单步成本有界（1200 字符 ≈300 token）且前缀零扰动。这套设计在同类系统里是最优解之一：OpenClaw 用文件顺序缓解，Hermes 用边界失效缓解，Cairn 用"数据根本不进前缀"根除。**这是项目最强的属性。**

### 2.5 索引构建与检索经济性

**纯函数实现**：`bm25.ts` 274 行零依赖，每次搜索调用时重建（全库 tokenize 建 df 表 + 候选集建 Bm25Index，[src/store/index.ts L780-803](../../src/store/index.ts#L780-L803)）。结构化过滤前置（superseded 在打分前排除）。排序四级链：**分数降序 → pinned → importance（缺省读 0）→ updatedAt 降序**（[L813-819](../../src/store/index.ts#L813-L819)）——pinned 优先合理（"用户要记住的"），importance 缺省读 0 让未评估条目排在同相关性已评估条目之后，是无害的弱信号用法。

**规模定位核算**：目标规模（几十到几百条短文本）下每次搜索重建 ≈ 亚毫秒到低毫秒级；fence 每步触发一次也可承受（50KB 级 tokenize/步）。两个规模保险已在位：启动 selfcheck ≥80% entriesCap 告警（[src/store/index.ts L617-625](../../src/store/index.ts#L617-L625)）；SQLite 后端已备好规模接缝（WAL、同 in-memory 读语义、同全库 df 纪律，[src/store/sqlite.ts L320-338](../../src/store/sqlite.ts#L320-L338)）。重建索引、手写 BM25 都封装在 `search()` 函数边界后——按改进方案笔记"非标策略判据"，这是**成本恒定的算法债**，随时可换 FTS5 而不动调用方。

**判断**：经济性在其定位规模下成立。前瞻性提醒：fence 每步全库 tokenize 使检索成本与"步数 × 库大小"相乘，万级条目时会变显著——增量索引（写入时脏标）是接缝内的低风险演进，不急于现在做。

### 2.6 生命周期管理与衰减策略

**两层生命周期**：project 硬衰减删除（审计 `remove`/`janitor`）、global/user 软衰减打 stale 戳；pinned 全面豁免（janitor、forget、eviction 三处一致——"pin 意味着永不遗忘"的契约贯通）；importance 4–5 享 1.5× 宽限窗；软上限 500 淘汰序 pinned → accessCount 升序 → lastRecalledAt 升序；supersedeEntry 终态覆写（唯一能翻 status 的接缝，`update` 刻意不可写 status）。

**并发正确性**：janitor 快照只是预筛，删除/stamp 都在写链槽位上原子 RMW 重判（[src/store/index.ts L1374-1449](../../src/store/index.ts#L1374-L1449)），pin 的 TOCTOU 窗口被压到"守卫→删除"之间并如实记录；召回戳/hit 同样走原子 RMW，并发 replace 不被回滚。

**信息丢失向量**：结论 2 详述衰减钟缺口。另有一处待议边界：curator 的 `selected.length < 2` 即不跑（[src/review/index.ts L384](../../src/review/index.ts#L384)）——单个超长条目永远不会被提质，疑似无意的边界。

**supersede 链**：终态 + ` [superseded → <id>]` 可见注解 + 工具面可导航，设计闭环。轻微张力：覆写链无法"翻案回滚"（旧事实再变正确时只能继续向前 supersede，注解会叠加），但身份历史 20 版的先例说明项目倾向"历史只进不退"，一致性可以接受。

**判断**：机制协调性整体好——衰减钟、召回戳、宽限、软上限、sweep 排序共享同一套信号词汇。除 updatedAt 缺口外，其余取舍均有记录。

### 2.7 安全防线与审计能力

**写入路径**：37 条规则（16 secret + 17 injection[英 9 中 8] + 4 exfiltration，[src/scanner.ts L60-116](../../src/scanner.ts#L60-L116)）。中文注入规则刻意保守（只匹配命令式/角色赋予框架，声明式陈述如"我忽略了之前的错误"不命中），双语语料把误报率钉在 0；allowlist 生产接线（模式名 + 期望子串双匹配才豁免，真 key 仍被拦）。扫描覆盖所有写入口：tool 边界（模型可读的精确拒绝）→ store 契约（后台路径无法绕过）→ 逐提取行 → summary → anchors（提示面 token）→ identity / suggestion / adopt 全走 `scanContent`。

**读取路径**：`redactBlocked` 覆盖全部 prompt 面（注入快照、存在性索引、notes、digest、提取快照）+ 工具显示层 + remote 投影；围栏闭合转义（`neutralizeFenceBreaks`，含 `</memory-context>` 的条目无法越出围栏发言）；`getRaw` 是唯一破窗路径且每次读落 `readRaw` 审计。

**审计承诺的边界**：结论 5 详述——200 条滚动窗对活跃 store 是"最近 200 次可审计"，且 hit 信号会挤占写审计。审计记录本身质量高（100 字符扫描干净的预览、单调 `seq` 破同毫秒并列、完整导出接口）。

**判断**：防线质量高（纵深、双语、破窗有审计、误报有逃生门）。审计面是短期板——cap 太小且 hit 信号与写审计共用滚动窗。

### 2.8 人审队列与治理机制

**队列设计**：confirm 模式下所有**内容写**——tool add/replace、extraction、curator 重写、identity_update——全部进提议队列；同 target 或同 scope 相似度 >0.3（IDF 加权）去重为 hits++（"frequency is signal"，重复提案本身就是信号）；严格超集内容自动升级；采纳支持 edit-before-adopt；采纳走完整 store 契约（含扫描）+ 审计 source `'ui'`；队列 200 上限按低信号先逐。远程面治理完整：suggestAdopt/Reject、identityHistory/identityRevert、archive、health、auditLog 等共 18 个 `@Remote` 方法（[src/remote/index.ts L459-749](../../src/remote/index.ts#L459-L749)），写方法默认拒绝、经 `remoteWritesEnabled` 放行。

**"模型永远无法自我提升"的核实结果**：在**内容维度成立**——confirm 模式下没有任何模型发起的内容写能绕过人类采纳，curator 重写已确认条目也走 P1-2 提案。但结论 1 详述**治理不对称**：删除/钉住不进队列，且 TECH_DESIGN G11 的声明覆盖了实际未覆盖的面。

**UX 平衡**：hits 优先排序 + 200 上限低信号先逐 + `firstSeenAt/lastSeenAt` 记录，兼顾了治理负担；队列条目永不注入、永不衰减、永不检索，语义干净（"建议不是记忆"）。

**判断**：治理闭环设计完整、体验考虑周到；删除面缺口是真实改进项（P0-4），G11 的措辞需要么补齐实现、要么收窄声明。

## 三、优势与不足汇总

### 优势（逐项经当前代码核实）

1. **KV-cache 纪律是同类最优**：digest-first（数据不驻留前缀）+ 易变度排序 + 会话冻结 + compaction 唯一重冻结点 + 压缩边界清单重布防——比 OpenClaw 的文件顺序、Hermes 的边界失效更彻底。
2. **双后端存储已备好规模接缝**：host-medium/SQLite 一次性迁移、双向 fail-loud 标记守卫、崩溃窗口全良性（clear-first 顺序）、跨进程 owner stamp 探测。
3. **一个词法平面服务五个消费者**：检索、entry 去重、冲突检测、建议队列去重、命中信号共用同一分词器与 IDF 加权——`dedup-idf-weighting` 裁定删掉手写停用字表后，一处优化五处受益。
4. **双重安全防线完整**：写时 37 规则三边界扫描，读时全 prompt 面 redactBlocked + 围栏转义 + 破窗审计；中文攻击面有专门规则与语料验证。
5. **信号学分层严谨**：tool/fence/hit 三层召回信号职责不交叉（fence 命中明确不污染淘汰信号），hits/hitCount/accessCount 各自喂队列排序/sweep 排序/淘汰序。
6. **工程与决策文化**：原子 RMW、TOCTOU 显式处理、best-effort 全部可观测（reportFailure → health.backgroundFailures）、47 个测试文件 13778 行、golden 数字钉死且自认局限、每个重大取舍有裁定记录（含"已知残余"都写明——如换述纠错的 ≈0.02 vs 0.1 残余、fence 戳刷新衰减钟的接受漂移）。

### 不足

1. **候选信号召回率低**（§2.2）：窄信号库 + 中期 review 只喂命中片段 + crash 丢会话 + assistant 侧无信号——捕获面与提取能力不匹配。
2. **flush 失败静默吞批次**（§2.2）：单次尝试，仅 reportFailure；且失败预扣预算。
3. **confirm 模式治理不对称**（§2.8）：删除/钉住绕过人审队列，G11 声明与实现脱节。
4. **衰减钟不感知 updatedAt**（§2.6）：整合更新过的条目仍按创建钟衰减/删除。
5. **审计窗 200 太小且被 hit 信号挤占**（§2.7）。
6. **身份层无自动维护**（§2.1）：USER.md 画像碎片化到 entries，增长全靠模型主动性。
7. **部分设置未接 UI**：memory / memory-notes / memory-autorecall / memory-identity / memory-review 五张卡已在 client（[src/client/index.ts L202-206](../../src/client/index.ts#L202-L206)），剩余缺口是 `memory-store` 行（storage 后端切换、entriesCap、crossProcessProbeMs——组合层 yml 专属）与 tool 的 `scannerAllowlist`（误报逃生门只能改配置文件）；health 的 backgroundFailures 也没有可视化面板。
8. **遥测缺失**：宿主侧 session capture 搁置后，"频率即信号"与 fence/search 实际使用率在插件侧也不可见。
9. **文档漂移两处**（见 §一核验勘误）：G11 措辞、§6 建议去重参数。

## 四、改进计划

每项标注收益/成本与实施路径；全部与既有裁定对齐（对齐说明见本节末）。

### P0 — 修缺口（短期，低风险高收益，多数是一线改动量）

| # | 改进 | 收益/成本 | 实施路径 |
|---|---|---|---|
| 1 | **扩充信号库 + 候选上下文**：补陈述式偏好模式（"我喜欢/我习惯/我 prefer"）与"经验教训"模式；correction 候选附带前一轮 assistant 回复摘要（或前后 N 轮窗口，截断预算化） | 直接修最窄瓶颈；成本 = 正则几条 + 一处消息组装，drain 提取质量随之提升 | `accumulator.ts` 加 pattern + 候选带 context 字段（投影 stateVersion +1）；提取 prompt 说明上下文片段 |
| 2 | **flush 失败保留批次**：flush 失败时把片段降级为候选回填累加器，或持久化 pending-flush 到 meta 表下次事件重试 | 把"静默吞批次"变可重试；成本 = 一个 meta 行 + 重试接线 | `review/index.ts` flush 的 catch 里回填；dedup 幂等已保证重试安全 |
| 3 | **衰减钟纳入 updatedAt**：`lastRecalledAt ?? updatedAt ?? createdAt`；容量淘汰序同步 | 修一个信息丢失向量；成本 = 一行 + 契约测试，但需先裁定"merge 算不算活动"（建议：算——内容变新即应续命） | `store/index.ts` L1383（及 janitor RMW 内 L1429）、淘汰序 L1176-1179 两处；更新 janitor 测试 |
| 4 | **confirm 模式补删除围栏**：remove/forget/pin 提案化，或最低限度收窄 G11 措辞 + 工具描述同步 | 兑现"一切模型动作皆可治理"的承诺；成本 = 扩展 suggestion schema（schema-debt 原则：现在加比以后加便宜） | 建议 schema 加 `kind: 'remove' \| 'pin'` 判别字段；adopt 分派到 remove/pin；同步 TECH_DESIGN G11 |
| 5 | **审计面分层**：hit 信号不再写 update 审计（独立计数进 health），auditCap 考虑提到 500 或按类别分窗 | 保住"写可审计"承诺的窗口价值；成本极低 | `store/index.ts` L917 删 appendAudit；hit 计数入独立面 |
| 6 | **插件侧轻量遥测**：fence 命中率/步、memory_search 调用/会话、drain 成功率进 `health()` | 让"频率即信号"与捕获率首次可观测，为后续默认值决策供证；成本 = 几个计数器 | context/review 各自计数，health() 汇总；remote health 面透出 |
| 7 | **预算计量修正**：extractionBudget 按 LLM 调用计（drain 内部调用各自扣减），失败不扣或半扣；或至少修正 Config 措辞 | 消除命名与实现的偏差，防止 20 次失败耗尽预算；成本小 | `maybeRunReview` 返回实际调用数回填 |

### P1 — 补能力（中期，1–2 个迭代量级）

8. **identity review pass**（对应不足 6）：每 N 会话把 user-scope 高 hitCount/accessCount 条目打包，一次 LLM 蒸馏成 USER.md 增量提案，进 confirm 队列按 kind 去重。收益：画像从碎片条目收敛为声明式文档，身份层不再全靠模型主动性；成本：一个低频 pass + prompt，复用 curator 的 N 会话门型。
9. **remote UI 补齐管理面**（对应不足 7）：memory-store 卡（storage/entriesCap/crossProcessProbeMs 需组合层重启生效——卡片至少只读展示 + 跳转指引）、health/backgroundFailures 面板、scannerAllowlist 编辑。收益：零凭据部署的全部旋钮可视可调；成本：一张卡 + locales。
10. **curator 升级**：选条不只按长度——纳入 hitCount=0 且高 accessCount（"常被翻牌却从未被用"）与被 sweep 反复跳过的条目做提质与 importance 重估；顺手修 `selected.length < 2` 边界。
11. **pitfall 结构化字段**：`symptom/rootCause/fix` 落 schema（optional，文本协议 `[pitfall] 症状：…` 保持向后兼容，解析层映射）。收益：notes 投影与检索获得结构化维度（按根因搜索）；遵循 schema-debt-first 裁定——字段早加，存量条目补不回来。成本：schema 演进 + 迁移容忍读。

### P2 — 架构演进（中长期，按裁定条件触发）

12. **可选 embedding 平面**：`semantic-plane` 的暂缓条件（`deployment-dataflow-doc` 落地）已满足，剩余约束是"必须走宿主接缝 + opt-in + 失败降级词法 + RRF 融合"。建议重新评估排期：先在 eval 里加同义/跨语言场景集，证明词法地板确实被突破再做。收益/成本比取决于宿主是否提供 embedding seam——没有 seam 就继续按裁定持有，不盲从"记忆系统都该有向量"的民意。
13. **增量索引**：写入时脏标 + 失效重建，摊薄 fence 每步全库 tokenize。仅在 store 超千条或遥测显示检索成本占比异常时启动；接缝在 `search()` 边界后，随时可做。
14. **删除提案治理模型**（P0-4 的完全体）：统一"一切模型写动作皆提案"，包括 forget 的批量预览。

### 与既有裁定的对齐说明

本计划逐条对照[改进方案笔记](../../.agents/notes/proposed/architecture/2026-09-01-memory-system-improvement-program.zh.md)的裁定：`semantic-plane` 维持"宿主接缝 + 暂缓"（P2-12 只推进其触发条件）；`conflict-resolution` 的换述残余维持记录在案、不降阈值；`session-capture-repair` 维持宿主侧归属，P0-6 用插件侧计数器补观测面；`golden-floors-not-acceptance` 维持——任何检索侧改动先扩充夹具再留存对照；`token-cost-asymmetry` 维持——token 成本只作决胜依据。P0-3（updatedAt）与 P0-4（删除围栏）是本评估新发现、裁定未覆盖的缺口；P0-1/P0-2 是"信号捕获无裁定覆盖"的空白区。

## 五、与开源记忆系统理念的对照（独立判断）

该吸收的已吸收：OpenClaw 的 CONTEXT_FILE_ORDER（且被"数据不驻留"超越）、Hermes 的压缩边界失效重读、nanobot 式 curator、evolve 式渐进披露（summary/索引行/按需读取）。建议再吸收的只有"阶段性身份蒸馏"（P1-8）——OpenClaw/Hermes 类系统的 persona 定期蒸馏理念，且与本项目 confirm 治理天然兼容。

不该盲从的也已用裁定挡住：embedding 平面（零出站网络约束优先）、检索停用词（与 IDF 职责重复）、自动冲突消解（与人审姿态冲突）。"博采众长但每条都有裁定"的方式本身就是项目最值钱的资产——改进计划里每一项落地时，延续这个纪律即可。
