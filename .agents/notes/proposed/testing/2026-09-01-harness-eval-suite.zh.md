# Agent Note: 运行在真实 harness 中的测评集：为记忆存储与召回评分

Status: proposed

[English](2026-09-01-harness-eval-suite.md) | 中文

## 问题

插件现有的常备度量只有 `src/benchmark/` 的检索 golden set（35 条 × 35 组查询，经 `tests/recall-golden.spec.ts` 在 CI 守底）和一张注入成本表。它能证明 BM25 排序质量与各模式的注入成本，除此之外什么也证明不了。此后每一次机制改进——review 提取、去重、冲突标注、注入模式、janitor、索引改写——落地时都回答不了它本想回答的问题：换了新构建之后，会话的实际表现真的变好了吗？

具体缺口有三：

1. **写入路径**没有度量：埋入的事实是否沉淀进了 `memory.json`，scope/category 是否正确、措辞是否可检索。存储质量位于一切下游面之前，而没有任何东西为它打分。
2. **常驻注入路径**（开场 system prompt）没有度量：会话 N 里存下的事实，是否真的到达了会话 N+1 的开场 system prompt（`memory` 与 `project-notes` 两段）；以哪种模式、混入多少噪声、成本多少。
3. 没有 **A/B 工具**：改进靠机制论证，而不是两个构建在同一负载上的并排实测。

单测只装配组件、从不启动 harness，LLM 一律是桩。以上三件事离开真实 harness 都无法度量。

## 方案

在专用 worktree（分支 `eval/benchmark-suite`，顶层目录 `eval/`，不进发布产物）构建测评集，核心设计是：**被测插件构建是一个变量**。runner 接收任意一个已构建的插件目录——main、特性分支、某个已发布的 npm 版本——为每个构建物化一个一次性 `$DSH_HOME`，把插件作为真实 profile bundle 挂在真实 harness 上，执行同一份场景语料，输出分片指标与 A/B diff。

按风险先行的顺序分阶段交付：

- **M0 — 冒烟**：profile 模板与启动链路；一个场景走通端到端（临时 `$DSH_HOME` → `dsh --profile sdk` 多轮 → 捕获组装后的 system prompt → `memory.json` 落盘）。
- **M1 — 常驻注入套件**：seed store + mock 模型下的真实追问会话；确定性，可选进 CI。
- **M2 — 存储套件**：真实风格的埋点对话；入库条目按存储 rubric 对照埋点打分。
- **M3 — 端到端 + A/B**：真模型答案按召回 rubric 打分、无记忆对照、`eval:ab`。
- **M4 — 文档与生命周期**：`docs/` 运行手册；本 note 转 `implemented/`。

## 场景色料

对话必须来自真实场景。领域为编程（主）、日常工作、生活，占比约 55 / 30 / 15；zh 约占三分之二，其余为 en 或混排。场景是人工撰写的「合成但真实」对话（不含逐字个人数据），每个场景是一段 5–15 轮的会话，事实以真实使用中的方式浮出：显式的记住意图、过程中的纠正、以及由真实工具调用序列构成的失败连击。每个场景携带埋点事实、干扰条目（同主题不同事实）与改写问法变体；负例问题（事实从未说过）切片守护「不幻觉召回」。

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

规模：v0 目标至少 30 个场景（编程 ≥ 16、日常工作 ≥ 9、生活 ≥ 5）与 60–100 道问答题。检索 golden set 留在 `src/benchmark/` 作廉价的 L0 地板；本语料度量的是 harness 行为，不是分词器。

## 评分 rubric

评分锚定在 `eval/rubric/` 下的版本化 rubric 文件上（storage、recall 两份）。judge 的 system prompt 由 rubric 文本生成，每份报告盖印所用的 rubric 版本，改动锚点必须升版本——不同 rubric 版本的分数永不互比。这就是「固化打分标准」在本处的含义：judge 是一台记录了校准的仪器，不是每次临场发挥。

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

判定协议：temperature 0；结构化输出（逐维分数加引用证据行）；解析失败重判一次，再失败记为无效并单独计数；真模型轮次重复 N=3 取均值。A/B 采用盲评成对：两个构建的注入或答案以乱序标签呈给 judge，输出判优与平局。

## 常驻注入链路评测

主打场景类型把写入路径与常驻注入接成一条链。会话 1 在真实风格的编程或日常工作对话里埋点；runner 等待落盘稳定（review drain 或 dispose flush 完成；`memory.json` 与审计表轮询至稳定）；同一 `$DSH_HOME` 里开启会话 2，从 SDK `request/header` 事件捕获组装后的 system prompt。每个埋点事实随后按链路记分：存储 rubric 分（存得如何）、常驻命中（是否到达会话 2 的 `memory`/`project-notes` 段）、以及（真模型轮次）答案正确性。一次未命中可以被定位为提取失败或注入失败，而不是消失在聚合数里。

两种注入模式都测，因为出厂默认已是 index 模式：`full` 给渲染内容块打分；`index` 给索引行质量打分——存在行加 summary 是否足以引导一次 `memory_search`。会糊掉度量的配置项（`decayDays`、curator、`confirmBeforeWrite`、`reviewCandidateThreshold`）经场景类的 profile `cordis.patch.yml` 钉死。

## 执行设计

```text
eval/
  datasets/*.jsonl          # scenario corpus, one scenario per line
  rubric/storage-v1.md      # anchored scoring rubric (versioned)
  rubric/recall-v1.md
  harness/profile-template/ # profile package.json + cordis.patch.yml (pinned config)
  boot.ts                   # temp DSH_HOME + link build dir + spawn `dsh --profile sdk`
  runner.ts                 # scenario executor (plant / seed / ask)
  judge.ts                  # rubric-driven LLM judge (env-gated real model)
  report.ts                 # metrics + A/B paired diff, JSON + Markdown
  cli.ts                    # `npm run eval` / `npm run eval:ab`
```

- **启动**：`DSH_HOME` 指向临时目录；profile 模板声明 `dsh.profile.bundles`，插件以 `link:<dir>` 指向被测构建，镜像现网 `web` profile 的接线。驱动走 harness TS SDK 客户端（`packages/sdk/client/src/api.ts`）+ `--profile sdk`；JSON-RPC 面足够小，客户端包无法 link 时可在 `eval/` 内自写兜底 stdio 客户端。M0 在任何东西依赖它之前验证整条链路。
- **断言来源**：SDK 事件（`request/header` 组装后 prompt、`tool/call` 工具行为、`assistant/message` 回答）、带审计表的 `storages/memory.json`、`sessions/` 下的会话 transcript。
- **模型模式**：`mock` 把 `DEEPSEEK_BASE_URL` 指到 `@deepseek-ai/dsh-llm-mock-server` 跑确定性 L1；mock server 若不能按请求内容路由响应——提取场景需要这个能力——改在 `eval/` 内放一个小型路由表假服务。`real` 走 env 门控（与 `tests/judge-real-api.spec.ts` 同款门控），永不进 CI。
- **A/B**：`npm run eval:ab -- --baseline <dir> --candidate <dir>` 对同一语料跑两遍，输出逐场景配对 diff；确定性层精确 diff，判定层聚合多次结果。

## 备选方案

**只扩展现有 golden set。** golden set 度量的是固定条目—查询对上的排序；它看不见提取是否存对、常驻注入是否送达、答案是否变好。它已存在，继续作为廉价的 CI 地板。

**采用外部评测框架（promptfoo/ragas/LoCoMo 一类）。** 它们自带 agent loop 假设；本需求度量的是真实 harness 以 profile 层组装插件后的行为，没有一家提供这个回路。借用公开数据集做切片可以，回路必须是 harness 自己的。

**放大进程内组合测试（`tests/integration/host.spec.ts` 路线）。** 确定且便宜，但从不经过真实启动、profile 分层、`settings.yaml`、会话持久化、dispose 时点的 flush 时序——恰是评测要覆盖的面。它们继续当单测地板，不当评测。

**精确匹配代替 LLM 判分。** 提取本来就改述；精确匹配会系统性低估。机械项（命中、噪声、成本）保持精确，判定项交给锚定 rubric。

**无版本化 rubric 的临场判分。** 分数随运行与 judge 模型漂移，跨构建比较沦为噪声。「版本化 rubric」这条要求正是为防此事而设。

## 验收标准

- `npm run eval` 在一次性 `$DSH_HOME` 里以真实 harness 子进程挂载 profile bundle 形态的被测插件，无人工步骤产出报告。
- 语料含至少 30 个真实场景，覆盖编程、日常工作、生活，符合声明的 zh/en 配比，并含干扰事实、改写变体与负例问题。
- 报告盖印 rubric 版本，分片给出：常驻命中率、存储 rubric 分、注入质量/噪声/成本，以及（真模型轮次）相对无记忆对照的答案提升。
- `npm run eval:ab` 对两个构建目录产出逐场景配对 diff；mock 模式下确定性层重跑分数完全一致。
- 评测运行时不向本仓库写任何文件——全部状态居于临时 `$DSH_HOME`（不落仓库文件的既定规则，[Agent Note](../../implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md)）。

## 风险

- **判分方差**——锚定 rubric、temperature 0、N=3 重复与盲评配对缓解；对 judge 模型的残余敏感度接受并记录（judge 模型身份与 rubric 版本一同盖印）。
- **mock 模型能力**——提取场景需要按内容路由的脚本化响应；M0 先验证 harness mock server 的路由能力，M2 才依赖它，备选是上文 `eval/` 内假服务。
- **真模型成本与非确定性**——真跑保持 env 门控、默认 N=3、永不进 CI；语料规模让单次全量跑有界。
- **异步落盘的抖动**——dispose flush 有 5 s 上限、drain 受阈值门控；runner 对审计表轮询至稳定并设超时，场景类经 profile patch 钉死阈值，慢 flush 会响亮失败而不是悄悄压低存储分。
- **harness 版本漂移**——启动接线按[宿主契约](../../../../docs/HOST_CONTRACT.zh.md) §10 清单核对；harness 升版必须重跑 M0 验证。
