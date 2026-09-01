# Agent Note: 运行在真实 harness 中的测评集：为记忆存储与召回评分

Status: implemented

[English](2026-09-01-harness-eval-suite.md) | 中文

## 问题

插件现有的常备度量只有 `src/benchmark/` 的检索 golden set（35 条 × 35 组查询，经 `tests/recall-golden.spec.ts` 在 CI 守底）和一张注入成本表。它能证明 BM25 排序质量与各模式的注入成本，除此之外什么也证明不了。此后每一次机制改进——review 提取、去重、冲突标注、注入模式、janitor、索引改写——落地时都回答不了它本想回答的问题：换了新构建之后，会话的实际表现真的变好了吗？

具体缺口有三：

1. **写入路径**没有度量：埋入的事实是否沉淀进了 `memory.json`，scope/category 是否正确、措辞是否可检索。存储质量位于一切下游面之前，而没有任何东西为它打分。
2. **常驻注入路径**（开场 system prompt）没有度量：会话 N 里存下的事实，是否真的到达了会话 N+1 的开场 system prompt（`memory` 与 `project-notes` 两段）；以哪种模式、混入多少噪声、成本多少。
3. 没有 **A/B 工具**：改进靠机制论证，而不是两个构建在同一负载上的并排实测。

单测只装配组件、从不启动 harness，LLM 一律是桩。以上三件事离开真实 harness 都无法度量。

## 决策

测评集落在 `eval/benchmark-suite` worktree 分支的顶层目录 `eval/`，不进发布产物（`files` 仍是 `lib`、`cordis.patch.yml`、`README.md`）。运行手册在 [docs/EVAL.zh.md](../../../../docs/EVAL.zh.md)。核心设计成立：**被测插件构建是一个变量**。`npm run eval -- --build <dir>` 接收任意一个已构建的插件目录——main、特性分支、某个已发布的 npm 版本——为每个场景物化一个一次性 `$DSH_HOME`，把构建作为真实 profile bundle 挂在真实 harness 上（`dsh --profile sdk` + SDK stdio 客户端），执行同一份场景语料，输出分片指标与 A/B 配对 diff（`npm run eval:ab`）。

整套测评是一条泳道、两条场景链，共用同一套机械与判定指标：

- **seed**——用单一来源的 medium 写入器预写 store，开一个会话，把开场 system prompt 当作每道题的常驻注入面来打分。
- **plant**——会话 1 演一段真实风格、埋入事实的对话；dispose 触发 flush；quiesce 为其兜底；落定后的 medium 就是存储度量；会话 2 在**同一个** `$DSH_HOME` 上新开 handle（全新记忆快照，KV-cache 会话契约）作答全部问题。

每项指标只有一个家：机械项（standing hit、噪声率、注入成本、存储精确率）由代码计算（`eval/mechanical.ts`、`eval/report.ts`）；判定项由锚定 rubric 的 LLM judge 计算（`eval/judge.ts`）。报告盖印被测构建、rubric 版本、judge 身份与注入模式，分数永不脱离其校准被读取。

## 场景色料

`eval/datasets/core-v0.jsonl` 收录 32 个人工撰写场景、128 道计分题：16 plant / 16 seed；编程 17、日常工作 10、生活 5；zh 20（62.5%）、en 5、mixed 7。题型为 60 single-hop、60 paraphrase、3 multi-hop、5 negative。`eval/datasets/smoke.jsonl` 收录钉死的 M0 冒烟场景（1 个 seed 场景、2 道题）。每个场景携带埋点事实、同主题干扰条目与改写问法变体；负例问题（事实从未说过）守护「不幻觉召回」。

```json
{
  "id": "prog-build-toolchain-01",
  "domain": "programming",
  "language": "zh",
  "turns": [
    { "user": "……", "planted": ["build-pnpm-only"], "signals": ["keyword", "correction"] }
  ],
  "questions": [
    { "q": "这个仓库构建用 npm 还是 pnpm？", "requires": ["build-pnpm-only"],
      "gold": "pnpm；不要用 npm install", "type": "single-hop", "variantOf": null }
  ]
}
```

语料契约在 `eval/schema.ts`（zod 严格模式）：JSONL 每行一个场景，加载即响亮校验。检索 golden set 留在 `src/benchmark/` 作廉价的 L0 地板；本语料度量的是 harness 行为，不是分词器。

## 评分 rubric

评分锚定在版本化 rubric 文件 `eval/rubric/storage-v1.md` 与 `eval/rubric/recall-v1.md` 上。judge 的 system prompt 就是 rubric 文本逐字，每份报告盖印所用版本（从各文件首行 `Rubric version: <N>` 解析），改动锚点必须升版本——不同 rubric 版本的分数永不互比。这就是「固化打分标准」在本处的含义：judge 是一台记录了校准的仪器，不是每次临场发挥。

**存储 rubric**——每条入库条目对照其埋点事实，四个维度各 0–2 分，锚点成文：

| 维度 | 0 | 1 | 2 |
|---|---|---|---|
| 内容保真 | 与事实矛盾、丢失主体或捏造细节 | 核心正确但有部分丢失或混入噪声 | 完整准确、无添油加醋 |
| 范围与分类 | scope 错误 | scope 对、category 错或缺 | 两者都对 |
| 可检索性 | 改写问法下完全脱靶 | 改写后弱命中 | 改写后稳定命中 |
| 合并行为 | 错误合并覆盖了另一事实，或产生重复 | 合并但丢信息 | merge/update/new 判定正确 |

scope 错误将整条封顶 1 分：scope 错误直接破坏所有下游注入面。场景级另计存储精确率：入库条目中溯源不到任何埋点的占比（幻觉提取率）。

**召回 rubric**——每道题，机械项与判定项分开：

- 常驻命中（机械）：required fact 是否出现在追问会话的开场 system prompt，对埋点原文与其 summary 做词面或近邻匹配。
- 注入质量（判定，0–3）：0 — 相关记忆缺席；1 — 在场但误导、过时或冲突未标注；2 — 正确但混入显著噪声；3 — 干净完整、可直接使用。
- 噪声率与注入成本（机械）：注入条目中无关占比；字符数与 ≈token。
- 答案正确性（判定，0–2，仅真模型轮次）：0 — 错误或幻觉；1 — 部分正确；2 — 对照 gold 完全正确。

判定协议：temperature 0；结构化输出（逐维分数加引用证据行）；解析失败重判一次，再失败记为无效并单独计数；判定均值只覆盖非空判定，judge 缺席读作 `null`，绝不静默归零。A/B 的判定层以差值呈现；确定性层逐场景精确 diff。

## 常驻注入链路评测

主打场景类型把写入路径与常驻注入接成一条链。会话 1 在真实风格的编程或日常工作对话里埋点；runner 等待落盘稳定（review drain 或 dispose flush 完成；`memory.json` 与审计表轮询至稳定）；同一 `$DSH_HOME` 里开启会话 2，从 SDK `request/header` 事件捕获组装后的 system prompt。每个埋点事实随后按链路记分：存储 rubric 分（存得如何）、常驻命中（是否到达会话 2 的 `memory`/`project-notes` 段）、以及（真模型轮次）答案正确性。一次未命中可以被定位为提取失败或注入失败，而不是消失在聚合数里。

两种注入模式都测，因为出厂默认已是 index 模式：`full` 给渲染内容块打分；`index` 给索引行质量打分——存在行加 summary 是否足以引导一次 `memory_search`。会糊掉度量的配置项（`decayDays`、curator、`confirmBeforeWrite`、`reviewCandidateThreshold`）经场景类的 profile `cordis.patch.yml` 钉死。

## 执行设计

```text
eval/
  datasets/*.jsonl          # scenario corpus, one scenario per line (smoke, core-v0)
  rubric/storage-v1.md      # anchored scoring rubric (versioned)
  rubric/recall-v1.md
  harness/profile-template/ # profile package.json + settings + cordis.patch.yml (pinned config)
  harness/…                 # sdk-client, llm-mock launcher, route-table fake LLM, quiesce, seed-media
  boot.ts                   # temp DSH_HOME + link build dir + spawn `dsh --profile sdk`
  runner.ts                 # scenario executor (seed / plant chains)
  mechanical.ts             # mechanical metrics: fences, matching, noise, cost
  judge.ts                  # rubric-driven LLM judge (env-gated)
  report.ts                 # metrics + A/B paired diff, JSON + Markdown
  schema.ts                 # corpus contract (zod) + dataset loader
  cli.ts                    # `npm run eval` / `npm run eval:ab`
  smoke.ts                  # M0 chain smoke (`npm run eval:smoke`)
```

- **启动**：`DSH_HOME` 指向每场景一个的临时目录；profile 模板声明 `dsh.profile.bundles`，插件以 `link:<dir>` 指向被测构建，镜像现网 `web` profile 的接线。驱动走 harness TS SDK 客户端 + `--profile sdk`；组装后的 system prompt、工具调用与最终回答来自 SDK 会话事件、带审计表的 `storages/memory.json`、以及 quiesce 稳定后的 medium 读取。不向插件仓库写任何文件（不落仓库文件的既定规则，[Agent Note](../architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md)）。
- **模型模式**：`mock` 在进程内启动 harness 的 `@deepseek-ai/dsh-llm-mock-server` 跑确定性 L1——实测它**不**按请求内容路由，答案文本无关紧要，常驻注入运行因此保持确定性。按内容路由的脚本化响应（plant 链的提取对话）走 `eval/` 内的路由表假 LLM（`eval/harness/fake-llm.ts`），经 `--mode external --base-url` 接入；其 route match 收到的是转义后的 raw wire body。`real` 直通公网端点，与 `tests/judge-real-api.spec.ts` 同款 env 门控，永不进 CI。
- **判定**：`--judge` 在判定环境存在时激活 rubric judge（`EVAL_JUDGE_BASE_URL`/`EVAL_JUDGE_API_KEY`/`EVAL_JUDGE_MODEL`，回退 `DEEPSEEK_*`）；判定环境全缺时判定层 skipped，确定性层照常跑。
- **A/B**：`npm run eval:ab -- --baseline <dir> --candidate <dir>` 对同一语料跑两遍，输出逐场景配对 diff；确定性层精确 diff，判定层聚合为 candidate − baseline 差值。

## 备选方案

**只扩展现有 golden set。** golden set 度量的是固定条目—查询对上的排序；它看不见提取是否存对、常驻注入是否送达、答案是否变好。它已存在，继续作为廉价的 CI 地板。

**采用外部评测框架（promptfoo/ragas/LoCoMo 一类）。** 它们自带 agent loop 假设；本需求度量的是真实 harness 以 profile 层组装插件后的行为，没有一家提供这个回路。借用公开数据集做切片可以，回路必须是 harness 自己的。

**放大进程内组合测试（`tests/integration/host.spec.ts` 路线）。** 确定且便宜，但从不经过真实启动、profile 分层、`settings.yaml`、会话持久化、dispose 时点的 flush 时序——恰是评测要覆盖的面。它们继续当单测地板，不当评测。

**精确匹配代替 LLM 判分。** 提取本来就改述；精确匹配会系统性低估。机械项（命中、噪声、成本）保持精确，判定项交给锚定 rubric。

**无版本化 rubric 的临场判分。** 分数随运行与 judge 模型漂移，跨构建比较沦为噪声。「版本化 rubric」这条要求正是为防此事而设。

## 测试

- `npm run build` exit 0（host tsc 程序只覆盖 `src/`；`eval/` 在其外），`npm run test` 744 passed | 6 skipped（env 门控的 `tests/judge-real-api.spec.ts`），含覆盖 eval 模块的 7 个 `tests/eval-*.spec.ts`。
- eval 源码与其评测 spec 的手工严格 tsc 门禁（对 `eval/*.ts eval/harness/*.ts tests/eval-*.spec.ts` 跑 `tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --noImplicitOverride …`）0 error。
- `npm run eval:smoke` PASS（exit 0）：seed 事实出现在 `<memory-index>` fence 中，且运行后在 medium 上存续。
- `core-v0.jsonl` 的 mock 全量跑完成 32/32 场景、0 error；61 道可测 seed 题 standing hit 全部 100%；plant 场景在不按内容路由的 mock 下分数偏低（预期——提取需要按内容应答）；负例题不可测，不进任何分母。
- `npm run eval:ab` 以同一构建目录充当双方时，确定性层在全部场景上 EQUAL。
- plant 链经 `--mode external` 对接 fake LLM（SSE 帧）且判定开启，端到端跑通——正是本套测评度量的完整链路。
- [docs/EVAL.zh.md](../../../../docs/EVAL.zh.md) 里的每条命令都在 runbook 落地前实际执行过。

## 后果

这套测评换来的是真实 harness 行为的量化 A/B 工具，付出的代价是以下已接受的边界：

- **real 运行与真判定都被 env 门控且需要凭据。** `--mode real` 在没有 DEEPSEEK key（环境变量或托管 `$DSH_HOME/.credentials.yaml`）时拒绝启动；`--judge` 在判定环境缺失时退化为仅确定性层。两者永不进 CI——无密钥的运行保持绿色，代价是 L2 证据需要一次有密钥的人工跑。
- **mock 模型不能按请求内容路由**（已实测，记录在 `eval/harness/llm-mock.ts`）。确定性常驻注入运行不受影响；提取质量的度量依赖 `eval/` 内的路由表假 LLM 或真模型。裸 mock 下的 plant 存储分度量的是路由缺口，不是提取能力。
- **语料各切片的证据力不均。** 128 道题把常驻注入与改写覆盖得很密，但 multi-hop 只有 3 题——任何结论都不能压在这个切片上——5 道负例也只守护一种失败模式（幻觉断言）。v0 有意停在 32 个场景；扩语料是增量工作，不动结构。
- **机械匹配是确定性近似。** 阈值——逐字快速路径，然后对同场景事实（含干扰条目）的对比集要求 ≥2 个 distinctive token 或 ≥1 个 distinctive ASCII 锚点——是 rubric v1 的实现选点，留作 rubric v2 校准的输入，不是语义裁决。
- **判定方差被缓解，而非消除**：锚定 rubric、temperature 0、重判一次后记 invalid 并单列；judged A/B 差值是两次独立 judge 通过的均值差——judge 从不同时看到两个构建的材料——对 judge 模型的残余敏感度接受并随 rubric 版本一同盖印。
- **落盘稳定有界，但非即时**：dispose flush 与 review drain 轮询至稳定并设超时（默认 30 s），profile patch 钉死会糊掉度量的配置项，慢 flush 会响亮失败而不是悄悄压低存储分。
- **启动接线按[宿主契约](../../../../docs/HOST_CONTRACT.zh.md) §10 清单核对**；harness 升版必须先重跑 M0 冒烟，再信任新的 eval 数字。
- **`eval/` 的类型检查在所有自动门禁之外**：host tsconfig 只编译 `src/`，vitest/tsx 转译不查类型，严格覆盖靠手工执行 `tsc --ignoreConfig` 参数集而非独立 tsconfig——这个缺口要靠维护者记得亲手补上。
