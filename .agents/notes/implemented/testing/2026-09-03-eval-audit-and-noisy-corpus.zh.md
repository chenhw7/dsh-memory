# Agent Note: Eval 测评集审计与长难（噪声）语料切片

Status: implemented

[English](2026-09-03-eval-audit-and-noisy-corpus.md) | 中文

## 问题

两份观察指向同一个盲区——语料真实性。

其一（本记录的出发点）：core-v0 的 96 个 plant turn 中位长度 25 字符、最长 123 字符；31 个埋点 turn 中位 46 字符，一句一意、语法干净，其中 7 个带「记住 / 记着 / 记牢 / Put that in memory」式显式记忆锚。真实用户的提示词不是这个样子：环境、历史、吐槽与诉求混在一段 300–800 字的 context dump 里；输入法同音错别字（在/再、的/得）；语音输入式断句；句中自我纠正（「不对，是…」）；话题漂移；且一段长消息里通常只有一部分内容值得沉淀为记忆。现有语料测不了三件事：埋点事实被埋在长噪声中段时 extraction 能否找到（提取召回）；九成内容不值得记时能否忍住（提取选择性）；口语与错别字能否归一化为干净条目。

其二（下节审计发现，与本记录同窗口处理）：现行评测在测量学层面有若干结构性缺口，其中三项是 P0——storage 层看不见对既有条目的更新；scope 维度的标准答案在大半 plant 场景中不存在；recall rubric 对语料主体干扰机制（准确的同主题邻居条目）没有档位。长难材料的评审会反复撞上这三个缺口（归一化行为需要 dim1 指引、长消息的附带细节落在 precision 空档），因此修复与新语料切片合并进同一次 rubric 升版窗口。

## 审计发现（2026-09-03，对 eval/ 全体系逐指标×逐场景）

定性结论：harness 工程面是成品级（一次性隔离 home、invalid 协议、rubric 版本化盖印、确定性层 EQUAL 不变量、单 turn 工作预算）；短板在测量学。指标实现见 [eval/mechanical.ts](../../../../eval/mechanical.ts)、[eval/judge.ts](../../../../eval/judge.ts)、[eval/report.ts](../../../../eval/report.ts)、[eval/runner.ts](../../../../eval/runner.ts)；审计时点 rubric 为 v1 对（现冻结在树内：[storage-v1](../../../../eval/rubric/storage-v1.md) / [recall-v1](../../../../eval/rubric/recall-v1.md)），本窗口升版为活跃的 [storage-v2.md](../../../../eval/rubric/storage-v2.md) / [recall-v2.md](../../../../eval/rubric/recall-v2.md)（见下文决策）；已交付设计记录在 [harness-eval-suite Note](2026-09-01-harness-eval-suite.zh.md)。

P0：

1. **storage 评分看不见更新。** `writtenIds = after − before` 按条目 id 过滤（eval/runner.ts），对既有条目的合并/更新保持原 id，永远不进 judge、不进 precision。四个混合场景（prog101、prog112、prog116、work208）恰是冲突/修订最有价值的场景；`mergeBehavior` 退化为只测「是否重复创建」。
2. **scope 维度的标准答案在大半 plant 场景中不存在。** 9 个 programming plant 场景中有 8 个对话从不出现仓库名（唯一例外 prog112 的 `ui-kit`），而 rubric 要求仓库事实存 `project` + `projectName`，否则 total 封顶 1 分。语料没有 `expectedScope`/`expectedCategory` 字段，「正确答案」是 judge 每次的现场推断。
3. **recall rubric 对「准确但诱答错的邻居条目」无档位。** 21 个场景埋了同主题旧机制干扰条目；提问时注入的干扰行准确、无标注、且把答案带偏——既不是 3 档的「nothing points the wrong way」、也不是 2 档的「无关噪声」、也不是 1 档的「对所需事实本身误导」。judge 每次现场发挥；这是 judged 方差的最大来源。

P1（选列）：有效独立题量 ≈ 68/128——60 道 paraphrase 与原题共享 `gold`/`requires` 且多为弱复述（加「来着」），均值按 128 个独立样本呈现、无任何不确定度（损害报告解读而非测量效度；报告层廉价修复随本窗口收掉，见下文决策）；seed 侧 standingHit 近恒真（index 行按插件契约逐字渲染 summary，且描述性 id slug——如 `f102-vitest`——泄漏进 distinctive-token 匹配）；noiseRatio 在 2–4 条小 store 下是语料常数（全部注入）；storagePrecision 把「真实但未埋点」与「幻觉编造」同罚；storage `total` 信任 judge 算术而非 harness 重算求和+封顶；storage dim4（合并保留双方信息）与 recall 1 档（未标注的过期冲突）在同一批冲突场景上目标互斥；index 模式的 search 回路无确定性度量（answerCorrectness 仅真模型可得）；`ceil(chars/4)` 对中文成本系统性低估约 2 倍；negative 题无机械信号（无 judge 的跑法下零信号）；judge 无重复判定、无置信区间、无校准集；`expectedStandingHit` 只进 A/B fingerprint 而无任何聚合读出（半死字段）；冲突分辨能力零测量（4 组新旧冲突材料、无一题考现行 vs 废弃）；life303 埋点 `f303-rest` 未被任何题使用；`language` 标注按场景而非按题；plant 的 `assistant` 脚本字段从不被 runner 消费（可读性幻觉）。

逐场景一行摘要：

| 场景 | 摘要 |
|---|---|
| prog101-build-toolchain | 最好的冲突材料（legacy-npm seed vs pnpm 埋点）；同时命中 P0#1 与无仓库名；无冲突分辨题 |
| prog102-test-runner | 标准；jest-legacy 干扰落入 rubric 空档（P0#3）；id slug 泄漏 |
| prog103-runtime-pin | node22 vs docker node:20；`q103-2p` 是 yes/no 问句配范围式 gold |
| prog104-ci-gate | 干净的远域 negative（ruff/flake8）；无仓库名 |
| prog105-e2e-port | 最弱 paraphrase（「…来着」），复述压力近零 |
| prog106-commit-style | revision 信号（中途改主意）；存了被撤销约定只被 precision 隐含惩罚 |
| prog107-git-flow | 教科书级 correction 信号；无仓库名 |
| prog108-editor-setup | 干净；`q108-1p`（vim vs emacs）是少数强复述 |
| prog109-dep-pinning | `q109-mh` 是 3 道 multi-hop 中结构最标准的 |
| prog110-local-postgres | `q110-2p` 问「在哪里」，gold 以「不会丢」开头——gold 复用错位样本 |
| prog111-monorepo-tsc | 「这条别记」显式排除，经 precision 间接覆盖；仓库可推断但未命名 |
| prog112-lint-rules | 唯一显式命名仓库的 plant 场景——scope 维度的天然对照组 |
| prog113-review-prefs | 干净的双硬门槛，user scope 可达 |
| prog114-logging | 标准；「never hardcode」方向性约束好 |
| prog115-registry-mirror | `q115-1` 归因问法，复述距离真实 |
| prog116-cache-invalidation | 最有价值的冲突材料（TTL seed vs 写路径埋点）；零分辨题；更新路径盲区 |
| prog117-release-signing | 顺序事实链；无仓库名 |
| work201-weekly-report | 题型最全（+mh +neg）；周报约定的 scope（user vs project）留给 judge 裁量 |
| work202-standup-wiki | 数字锚稳定（9:30/10:00） |
| work203-docs-style | 纯中文，恰好压测 CJK bigram distinctive 路径 |
| work204-tz-scheduling | `q204-2` 问 Friday 全天，事实只管下午 |
| work205-comm-style | 「值得记但未埋点」precision 二义的典型案例 |
| work206-morning-triage | 顺序+上限双事实，干净 |
| work207-adr | 最小（1 事实 2 题） |
| work208-1on1 | 「Put that in memory」元指令+「她的偏好≠我的」scope 陷阱——最好的 scope 考点 |
| work209-changelog | 标准 project 对 |
| work210-focus-mornings | `q210-neg`（周三全员会）是最强的近域 negative |
| life301-travel | 自然的偏好集 |
| life302-cooking | `q302-neg`（酱油品牌）：给了品类没给品牌——测不挪用邻居细节编造 |
| life303-running | 埋点 `f303-rest` 无题——埋点浪费 |
| life304-grocery | 「品牌名不用记，认蓝盒就行」内嵌排除——最好的忠实度考点 |
| life305-sleep-coffee | 标准 |

## 决策

分两阶段，一个原则：**噪声是人工撰写的受控变量；语料只做加法；一次 rubric v2 升版摊销所有锚点改动。**

阶段 0（试点）窗口内两步落序——同一窗口、两个 commit、独立回滚。四项锚点修复不依赖噪声语料，先行落成并以 core-v0 验证；噪声试点基于已成型的 v2 评审，试点迭代不绑架 P0 修复的上线。

第一步（rubric v2 锚点修复，对 core-v0 独立验证）：

1. rubric 升版（新增 `storage-v2.md` / `recall-v2.md`，首行 `Rubric version: 2`），吸收四项锚点改动：(a) dim1 加指引——对明显错别字/语病的归一化不算编造，保留原样也不算缺失；(b) 为「准确的同主题邻居条目」设明确档位（审计 P0#3）；(c) storage 测量改 medium-diff 口径——`updated` 判据钉死为「条目 id 在 storeBefore 且 content/scope/category/summary 任一字段有 diff」，被更新的既有条目进入 judge 输入、标记 `updated: true`、计入 precision 分母（审计 P0#1；precision 语义随之再深一层不可比，由不互比纪律覆盖）；(d) 为 prog101/prog116 补冲突分辨题，recall rubric 同步加「带过时标注」的判定指引。
2. 报告层收掉独立题量问题（审计 P1）：totals 旁单列独立题均值——paraphrase 不进 headline，`type=paraphrase` 分片照旧。
3. v2 落成判据：对 core-v0 跑一次 judged A/B（env 门控、不进 CI），四维分布合理、invalid 率不升；rubric 文件名同步一次过（judge.ts 的文件名常量、docs/EVAL 的文件名引用）。

第二步（噪声试点，基于 v2）：

4. `scenarioSchema` 增加可选字段：场景级 `register: 'clean' | 'noisy'`（默认 `clean`），报告在该字段在场时增加 register 分片轴；埋点级 `factText`——规范化干净摘录，进 judge 地面真值并替代整段 dump 作为机械层匹配的 fact 文本（埋点埋在长 turn 中段意味着物化 statement 是整段 150–600 字：dim1 的「every component survives」会把正确的选择性提取压到 1 档、与「提取选择性」目标直接冲突，大 token 集同时放水 standingHit 假阳性；无该字段的埋点维持现状物化）；埋点级 `anchors`——锚定 token 数组，供 spec lint（noisy 埋点的每个 anchor 逐字出现在其物化 home turn 中）；试点场景的 `expectedScope` / `expectedCategory`（审计 P0#2：新语料不受「只做加法」约束，试点必须自带 scope 标准答案，否则试点方差混入 judge 的 scope 即兴成分）。dataset spec 增加 noise 地板（场景数、turn 长度分布）。
5. 新增 `eval/datasets/noise-v0.jsonl`，约 6 个 long-form plant 场景（zh 4 / en 1 / mixed 1）：turn 长度 150–600 字符；埋点埋在长 turn 中段；未埋点内容占消息量六成以上；覆盖四种长难模式——context-dump、语音输入风、句中自我纠正、话题漂移；每场景 1–2 个埋点；切片内 2–3 道带轻度错别字的复述题；negative 与 gold 保持干净。
6. 下节噪声风格指南是合同，并在 dataset spec 的评审清单中复述：**锚定 token 永不出错**。
7. 提取链证据走 fake-LLM external 路由（既有 plant 链路联调 runbook）：mock 不按内容路由，测不了「埋点埋在噪声中段时 extraction 能否找到」；fake LLM 对 noisy 场景配按内容路由的应答（`eval/harness/noise-routes.ts`，路由脚本出自语料旁的 fixture），无凭据、确定性，让真实提取链运转。**落地修正（偏离初稿的触发设想）**：noisy 场景的提取触发不走 dispose flush——实测（2026-09-03，SDK stdio 路径）harness 发出 `session/disposed` 后 ~26 ms 即硬退出，flush 的 LLM 往返加写库是评测赢不了的发车竞态；runner 改对 noisy 场景钉 `reviewCandidateThreshold: 1`（`noisyReviewPatch`），埋点轮次带显式记忆关键词，周期 review 在会话中段的 pre-step 触发，写入必然落定后才进追问会话。flush 路由仍在场但应答为空（安全 no-op），防它赢了竞态写出第二份。
8. 试点判分实测，五道门按序跑（`eval/pilot.ts` 编排、`eval/pilot-gate.ts` 纯函数 + vitest 覆盖，`npm run eval:pilot`）：G1 mock 链路健康（无场景错误、prompt 捕获在位）；G2 同构建 A/B 自比、确定性层逐场景 EQUAL；G3 锚点可匹配性——对**实际写入的条目**断言锚点命中，`entryCount > 0` 是前提而非断言（锚定禁令只保证「写入后可匹配」，不保证「被写入」，0 对 0 的同档是空转通过）；G4 同一 noisy 材料判定两遍——任一条目/题目两遍翻档 ≤1 档；G5 校准集全命中。判定规则预登记（防门槛在实践中退化为走过场）。校准集为 3–5 个 noisy 条目的作者预写期望档位（fixture `noise-v0.pilot.json`）：一致率只测重测信度，温度 0 下 judge 可能「稳定地错」，校准集才测效度；n≈6–12 的裸一致率置信区间过宽，不设数值阈值，与 clean 的区间重叠即延长试点。
9. 时间盒与回滚：两轮 rubric 迭代仍不过判定规则 → noise 切片冻结为 rejected，v2 与报告层修复单独 ship。

## 落地与验证（2026-09-03）

第一步（v2 + 报告层）与第二步（噪声试点）按上述落序交付：`eval/rubric/{storage,recall}-v2.md`（v1 对冻结在树内，`tests/eval-rubric.spec.ts` 双向看守）、judge.ts 文件名常量与 docs 同步一次过、报告层 `independent` 独立题列与 `register=` 分片轴、medium-diff 更新追踪（`updatedIds` + `JudgedStoredEntry.updated`）、core-v0 纯加补 prog101/prog116 冲突分辨题（q101-cd/cdp、q116-cd/cdp，128→132 题）、`noise-v0.jsonl`（6 场景 14 题，锚点/关键词/地板 lint 在 `tests/eval-noise-dataset.spec.ts`）与试点 fixture、五道门落进 `eval/pilot.ts` + `eval/pilot-gate.ts`。

试点判定规则实测（judge fuyao-data @ fuyao 网关，temperature 0）：**第 3 轮全过**——G1 链路健康、G2 同构建 A/B 逐场景 EQUAL、G3 六场景全部经 review lane 写入条目且非 negative 题锚点全命中、G4 两遍判定无超过 1 档的翻档、G5 校准集 4/4 全命中。时间盒内的两轮 rubric 迭代都用在了同一处发现的标尺歧义上（`calib-contradiction`：同主题矛盾条目）——迭代 1 把「trace 跟主题走、矛盾由 dim 1 记 0」钉进 Step 1（judge 的读法与 rubric 自身 dim-1 tier-0 反例一致，作者初钉与之一致性更差）；迭代 2 把「数值填错不是 token 丢失」钉进 dim 3（矛盾值占据同一槽位，提问仍会命中，错值归 dim 1）。这正是校准集设计要抓的失效形态：judge 温度 0 下「稳定地错」的不是判分而是标尺歧义处的稳定读法——两轮迭代后 judge、作者、rubric 文本三者对齐。

v2 落成判据中的 core-v0 judged A/B（真模型 + judge，env 门控）尚未完成：2026-09-03 首跑在 baseline 半程因网关拥塞中止（120s 通知超时 ×3、单 turn 预算超限 ×3，约 6/13 场景失败，无报告产出），待网关恢复后重跑——其余验收证据见上。

噪声试点验证运行时的真实性证据：mock G1 的 standing hit 为 0/×（mock 不按内容路由、提取不写入）而 G3（fake-LLM 按内容路由驱动真实提取链）全部场景有写入且锚点命中——「锚定禁令保证写入后可匹配」与「mock 下 0 对 0 是空转通过」两条预登记规则都被实测激活。

阶段 1（扩量与合流）：noise 切片扩至约 12 个场景；补 partial-extraction 极端稀释专项（整段只有一句可记）与带代码块/日志粘贴的长 turn；scope 标准答案铺到 core 侧走语料字段 + dataset 升版盖印（core-v1：turns/questions/facts 逐字节不动、机械层序列保全，judged 层本就随 v2 重定标；否决对话内植名，见备选方案）；噪声撰写可用确定性固定替换表烘焙（见备选方案）；语料 spec 地板进现有 vitest；noisy 全链 mock 确定性层走 pre-push 证据或新建夜间 lane（scheduled workflow，harness 检出 pin commit SHA——不 pin 则 nightly 红因可能与被测构建无关）。

## 噪声风格指南（合同）

- 锚定 token（工具名、数字、标识符、路径）永不出错。污染它们会破坏机械层匹配——extraction 会归一化、materialized statement 不会，必然假阴性。未来的 hard 层可以有意识地放开。禁令由 spec 的 anchors lint 机械执行，不靠人工纪律。
- zh：IME 同音字（在/再、的/得、做/作、必需/必须）、丢标点、流水句、口头语、句中自我纠正。
- en：键盘邻位错字、丢冠词、大小写漂移、autocorrect 伪影。
- 通用：话题漂移（一段多主题）、context-dump（环境+历史+诉求一段说完）、语音输入式断句；错别字密度每百字 1–3 处并波动（每百字按整 turn 字符数计）。
- 禁区：negative 题、gold 答案、required facts 的锚定表述保持干净；`assistant` 脚本字段可同步口语化（runner 零消费的展示字段，schema 注释标 display-only，防未来贡献者误以为它参与测量）。

## 备选方案

- **程序化错别字注入（运行时/随机）** —— 否。真实错字有模式（IME 同音、键盘邻位）；随机注入产生不可解释的 judge 方差，污染的是测量本身而非被测系统。确定性固定替换表（同音/邻位映射表在撰写期一次性烘焙、逐处可审计、逐字可复现）不在此列，留作阶段 1 扩量的撰写辅助。
- **不加 `factText` 字段、纯靠 rubric 指引** —— 否（评审反转了初稿的「暂缓」）。暂缓的理由是改动链长（schema + one-home 物化规则 + 两份 rubric + spec），但它与已接受的 `register` 字段同量级；而埋点埋进长 turn 中段后，整段 dump 作为地面真值会同时破坏 dim1 判读与机械层假阳性控制——该字段是噪声切片的承重墙，不是升级路径。完整 schema 规范化（statement 全面替代 one-home 物化）仍是方差超门槛后的升级路径。
- **对话内植名解决 scope 标准答案** —— 否。turn 文本是物化 statement 与机械层 verbatim 匹配的输入，改 core-v0 的 turns 会悄悄破坏机械层跨版本可比性且无盖印提示；语料字段只进 judge 输入，judged 层本就随 v2 重定标，机械层序列得以保全。
- **真实用户日志采样噪声** —— 否。无脱敏日志来源，且真实噪声的不可控变量与「噪声是受控变量」原则冲突。
- **就地修改 core-v0** —— 否。分数只在盖印 dataset 内可比；悄悄替换语料会让全部历史报告失真。
- **不加 `register` 字段，用 id 前缀 + `--filter` 分片** —— 试点期可行，但分片轴一等公民化的 diff 极小且向后兼容，直接加。
- **噪声覆盖 negative 题** —— 否。负例测「不幻觉」，噪声只增加歧义。

## 验收标准

- 第一步（v2）：core-v0 judged A/B 四维分布合理、invalid 率不升；报告盖印 v2、totals 单列独立题均值；文档点名禁止 v1↔v2 分数互比（含更新条目进分母后的 precision）。
- 第二步门禁拆两道：链路健康——noisy 场景 mock 全链无失败、fence 在场、turn 预算内，同构建 `eval:ab` 自比 EQUAL 覆盖 noisy 场景；条件化可匹配性——对实际写入的条目断言锚点命中（standingHit 以 entryCount > 0 为前提读：锚定禁令只保证「写入后可匹配」，不保证「被写入」，mock 下 plant 提取天然偏低，0 对 0 的同档是空转通过）。提取链证据以 fake-LLM 路由跑法为准。
- 试点判定规则全过（两遍翻档 ≤1 + 校准集全命中）；不过则按时间盒回滚。
- 新增 dataset spec 地板与 anchors lint 通过；报告携带 `register` 分片。
- noisy 场景的单场景时长与单 turn 工具调用数实测不显著高于 clean（默认 180s / 32 calls 预算下留余量，不够先调预算并盖印）。

## 风险

- judge 在长难材料上的方差放大 → 预登记判定规则+校准集拦截；最大隐藏风险恰是一致性门槛的假阴性通过（judge「稳定地错」），校准集为此而设。仍超门槛时走完整 schema 规范化升级路径。
- 锚定 token 被污染导致机械匹配假阴性 → 风格指南禁令+anchors lint（字段落地即机械执行，不依赖人工纪律）；长 dump 的大 token 集假阳性由 `factText` 收敛对比集。
- partial-extraction 放大 precision 的二义（真实但未埋点 vs 幻觉同罚）→ 同窗口考虑 precision 拆列（fabricated vs incidental）。
- 新增切片的真模型+真 judge 跑法成本翻倍；维持 env 门控、不进 CI。
- v1↔v2 分数按设计不可比 → 由盖印纪律守住；历史报告不得按新标尺重读。
- v2 上线被试点节奏绑架 → 两步落序消解：试点冻结不影响 v2 单独 ship。
- 夜间 lane 上游漂移 → harness 检出 pin commit SHA；红因归属先查上游再查被测构建。
