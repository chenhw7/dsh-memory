# Cairn 测评集 runbook（真实 harness 评测）

本手册描述 `eval/` 测评集的运行方式：把被测插件构建作为 profile bundle 挂在真实 DeepSeek harness 上，对同一份场景语料量化「存储 → 常驻注入 → 作答」链路，输出分片指标与 A/B 配对 diff。决策依据见 [Agent Note](../.agents/notes/implemented/testing/2026-09-01-harness-eval-suite.zh.md)（套件）与 [审计与噪声切片 Agent Note](../.agents/notes/implemented/testing/2026-09-03-eval-audit-and-noisy-corpus.zh.md)（rubric v2 + noise-v0），系统整体见 [TECH_DESIGN](./TECH_DESIGN.zh.md)。

度量分三层：**L0** 检索 golden set（`src/benchmark/`，经 `tests/recall-golden.spec.ts` 在 CI 守底）度量 BM25 排序质量；**L1** harness 行为评测（本目录，mock 模型，确定性）度量真实启动、写入与常驻注入；**L2** 真模型 judge（rubric 判定）度量注入质量与答案正确性。L1 永远可跑；L2 与 real 模式被环境变量门控（见[rubric 版本化与 judge 门控](#rubric-版本化与-judge-门控)）。

## 前提

- **harness 检出**：默认取 `~/deepseek-harness`，用 `DSH_EVAL_HARNESS_ROOT` 指向其他位置。检出必须已构建（`pnpm build`）：`apps/cli/lib/bin.js`（被驱动的 `dsh` 可执行）与 `packages/test-support/llm-mock-server/lib/index.js`（mock 模型）缺失时启动即报错。
- **插件构建**：`npm run build` 产出 `lib/`。`--build` 接收任何含 `package.json` + `lib/` 的目录——main、特性分支、某个已发布 npm 版本的构建物；被测构建是变量，同一份语料在两个构建上各跑一遍即为 A/B。
- **依赖安装**：`npm ci`（tsx 是 devDependency，`npm run eval` 经它直接运行 TypeScript 源码）。

## 快速开始

```sh
npm run eval:smoke   # M0 链路冒烟：临时 DSH_HOME → mock 模型多轮 → 注入断言 → PASS
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build .
```

报告默认只打印：stdout 先出 Markdown 摘要（分片表 + 逐场景表），再出完整 JSON。`--out <file>` 把 JSON 落到指定路径，落盘与否不影响运行本身。退出码非 0 表示有场景失败或（请求了 `--judge` 时）判定失败，stderr 会打印保留下来的临时 `DSH_HOME` 路径供排查。

## 命令面

三个入口共用一套参数：`eval`（单构建评分）、`eval:ab`（双构建配对 diff，用 `--baseline`/`--candidate` 替代 `--build`）、`eval:smoke`（M0 冒烟，无参数）。第四个入口 `eval:pilot`（噪声切片试点门禁）走自己的小参数面，见[噪声切片与试点门禁](#噪声切片与试点门禁)。

| 参数 | 取值 | 说明 |
|---|---|---|
| `--dataset <file>` | JSONL 语料 | 必填；每行一个场景，加载即校验 schema，空行报错 |
| `--build <dir>` | 插件构建目录 | 单构建模式必填；须含 `package.json` + `lib/` |
| `--baseline <dir>` / `--candidate <dir>` | 两个构建目录 | 仅 `eval:ab`；与 `--build` 互斥 |
| `--mode <m>` | `mock` \| `real` \| `external` | 模型路由，默认 `mock`；`external` 必须配 `--base-url` |
| `--provider <id>` | provider 路由 | 仅 `real`；缺省取部署 home 的 `agent-default-model.provider`，再缺省 `deepseek-official`。非 DeepSeek provider 走部署 `llm-pi-ai:` 分节镜像（`real` 专属） |
| `--model <id>` | 模型 id | 仅 `real`/`external`（mock 路由确定性，不接受）；缺省取部署 home 的 `agent-default-model.model`，再缺省 `deepseek-v4-flash`——每次解析都打印来源行 |
| `--base-url <url>` / `--api-key <key>` | OpenAI 兼容端点 | 仅 `external`；key 缺省 `eval-fake-key` |
| `--judge` | 开关 | 请求 rubric 判定；判定环境缺失时判定层 skipped、确定性层照常 |
| `--memory-mode <m>` | `index` \| `full` | 注入模式轴，默认 `index` |
| `--no-memory` | 开关 | 无记忆对照组，覆盖 `--memory-mode` |
| `--filter <ids>` | 逗号分隔的场景 id 子串 | 缩小范围；一个都不匹配时报错 |
| `--concurrency <n>` | 正整数 | 并发场景数，默认 4（每场景一个独立临时 home） |
| `--turn-wall-seconds <n>` | 非负整数，0 = 关 | 单 turn 墙钟预算，默认 180；eval.yaml `turnBudget:` 分节在旗标缺席时生效 |
| `--turn-tool-calls <n>` | 非负整数，0 = 关 | 单 turn 工具调用预算，默认 32；eval.yaml `turnBudget:` 分节在旗标缺席时生效 |
| `--out <file>` | 报告 JSON 路径 | 缺省只打印 |

### 典型命令（均已实测）

```sh
# mock 全量：32 场景 / 132 题，确定性层
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build .

# 噪声切片：6 个长难场景，独立语料（register 轴见「噪声切片与试点门禁」）
npm run eval -- --dataset eval/datasets/noise-v0.jsonl --build .

# 缩小范围（子串匹配场景 id）
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . --filter prog105-e2e-port

# 注入模式轴：index 是出厂默认（存在行），full 渲染完整内容块
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . --memory-mode full

# 无记忆对照：报告 memory mode 为 off，standing hit 0 为预期而非失败
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . --no-memory

# A/B：同一份语料跑两个构建目录，输出逐场景配对 diff
npm run eval:ab -- --dataset eval/datasets/core-v0.jsonl --baseline <旧构建目录> --candidate <新构建目录>

# 报告落盘 + 并发 + 多 id 过滤
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . --filter prog105,prog102 --concurrency 2 --out /tmp/report.json
```

### 单 turn 工作预算（防失控 agent turn）

一个 turn（一次 `session/prompt` 到 idle）超过墙钟或工具调用任一上限即被中止，该场景 fail loud（错误信息、保留 home、已完成的题目照旧入报告）——**不是静默记零**。背景：现有 120s 超时是"空闲"超时，持续流式（实测一次 LLM 调用静默流到 384K `max-tokens`）和工具循环（一次失控 347 次调用）都不受它约束，预算是这两个形态的唯一护栏（[Agent Note](../.agents/notes/implemented/testing/2026-09-03-eval-turn-budget.md)）。

解析链逐维独立：**CLI 旗标 > 项目根 eval.yaml 的 `turnBudget:` 分节 > 代码默认（180s / 32 次）**，`0` 显式关闭该维。生效值盖印进每份报告（`turnBudget` 字段与 markdown 头部行）并打印在启动行——分数永远带着它的校准条件读。端到端触发验证（mock 的 `tool_call_success` 无限序列 + 收紧的预算）：

```sh
cat > /tmp/verify-budget.mts <<'EOF'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness } from '$PWD/eval/boot.ts'
const home = mkdtempSync(join(tmpdir(), 'dsh-eval-budget-'))
const handle = await startHarness({
  buildDir: '$PWD', dshHome: home, model: { mode: 'mock' },
  mockSequence: ['tool_call_success'], turnBudget: { wallSeconds: 0, toolCalls: 5 },
})
try { await handle.prompt('x'); console.log('UNEXPECTED: no breach') }
catch (error) { console.log('BUDGET BREACH:', error instanceof Error ? error.message : String(error)) }
finally { await handle.dispose(); rmSync(home, { recursive: true, force: true }) }
EOF
npx tsx /tmp/verify-budget.mts   # 预期打印 BUDGET BREACH ... toolCalls 6 > 5
```

### 被测模型路由（real / external）

`real`/`external` 模式下被测模型由 **provider + model id** 双轴决定，每次运行都把解析结果打印到 stdout 并盖印进报告（`model under test`，含 `provider/id`）：

- **provider 轴**：显式 `--provider <id>` 优先；缺省读部署 home（`$DSH_HOME`，缺省 `~/.dsh`）`settings.yaml` 的 `agent-default-model.provider`；再缺省回退 `deepseek-official`。base bundle 已把 `dsh-llm-pi-ai` 适配器休眠挂载，deployment settings 的 `llm-pi-ai:` 分节即激活其路由——与 web Models 页的激活方式相同；`real` 模式遇到非 DeepSeek provider 时，eval 把该分节**镜像**进一次性 home 的 settings，子进程的凭据行经 `credentials.path` 补丁直接指向**部署 home 的托管凭据文档**（`.credentials.yaml`，web Models 页写入的那份）——密钥按请求由 harness 自己解析，eval 全程 probe 不 parse。部署缺该分节或 provider 未定义时报错退出。
- **凭据预检**：real 模式在 boot 前验证所需引用可解析——继承环境或部署托管文档（只探名字，不读值），缺失即响亮报错并点名两条来源。DeepSeek provider 要求 `DEEPSEEK_API_KEY`；pi-ai provider 要求其档案声明的 `apiKeyEnv` 引用（如 `FUYAO_API_KEY`）。**在 UI 配置过 key 的部署，`--mode real` 即零配置**。
- **model id**：显式 `--model <id>` 优先；缺省取同一 `agent-default-model.model`；再缺省回退 `deepseek-v4-flash`。settings.yaml 存在但无法解析、`agent-default-model` 畸形（含半截声明）、或镜像档案携带内联密钥时报错退出，绝不静默。
- **模式语义**：`--mode mock`（缺省）是确定性 deepseek-official 形态，不读部署 home，拒绝 `--model/--provider`；`--mode external` 是 deepseek 适配器的 fake-LLM 伪装（`--base-url/--api-key`），provider 固定 `deepseek-official`、拒绝 `--provider`；`--mode real` 承接上述完整解析——DeepSeek provider 走 `DEEPSEEK_API_KEY`/`.credentials.yaml` 预检，pi-ai provider 走镜像路由。

```sh
# fuyao 网关全链路示例：部署 home 已声明 llm-pi-ai.providers.fuyao + agent-default-model，
# key 已在 UI（Models 页）配置进托管凭据文档 —— 零环境变量、零模型旗标
EVAL_JUDGE_BASE_URL=http://fuyao-ai-gateway.xiaopeng.link/v1 \
EVAL_JUDGE_API_KEY=$FUYAO_API_KEY \
EVAL_JUDGE_MODEL=fuyao-work \
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . \
  --mode real --judge --out /tmp/eval-real.json
# 注：judge 凭据走独立的环境变量链；被测模型侧无需任何配置。
# 换被测模型：--model fuyao-work（缺省即 agent-default-model.model）
```

### plant 链路联调（fake LLM + external 模式）

mock（进程内 harness mock server）不按请求内容路由——所有请求拿到同一段固定文本，对常驻注入度量够用，但无法给提取场景喂「按内容应答」的对话。按内容路由走 `eval/harness/fake-llm.ts` + `--mode external`。在仓库根目录起一个临时 fake LLM：

```sh
cat > /tmp/fake-llm.mts <<EOF
import { startFakeLlmServer } from '$PWD/eval/harness/fake-llm.ts'
const server = await startFakeLlmServer({ defaultReply: '好的，收到。' })
console.log(server.baseUrl)
setInterval(() => {}, 1_000)
EOF
npx tsx /tmp/fake-llm.mts &   # 打印 http://127.0.0.1:<port>/v1
```

然后驱动 plant 场景（端点换成上一步打印的地址）：

```sh
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build . \
  --mode external --base-url http://127.0.0.1:<port>/v1 --filter prog101-build-toolchain
```

`external` 模式接受任何 OpenAI 兼容端点（代理、其他网关均可），fake LLM 只是仓库自带的按内容路由选项。写路由表时注意：`match` 收到的是**转义后的 raw wire body**（JSON 序列化文本，引号与换行已转义），内容匹配要按转义后的形态写；回复帧按请求的 `accept` 头自动区分（harness 客户端拿 SSE，judge 的裸 fetch 拿 JSON）。

noise 切片把这套联调打包成了成品：`npm run eval:pilot` 自带按内容路由的 route 表（`eval/harness/noise-routes.ts` + `eval/datasets/noise-v0.pilot.json`），让真实提取链在无凭据、确定性的条件下运转——见[噪声切片与试点门禁](#噪声切片与试点门禁)。

## 噪声切片与试点门禁（noise-v0）

core-v0 的 turn 都是一句一意的短消息（中位 25 字符），测不了三件事：埋点事实被埋在长噪声中段时**提取能否找到**、九成内容不值得记时能否**忍住**、口语与错别字能否**归一化**为干净条目。`eval/datasets/noise-v0.jsonl` 是长难（噪声）语料切片：6 个 long-form plant 场景（zh 4 / en 1 / mixed 1），turn 长度 150–600 字符、埋点埋在长 turn 中段、未埋点内容占消息量六成以上，逐场景以 `patterns` 声明覆盖的长难模式（切片并集必须覆盖全部四种：context-dump、语音输入风、句中自我纠正、话题漂移）。**噪声是人工撰写的受控变量**：锚定 token（工具名、数字、标识符、路径）永不出错，negative 题与 gold 保持干净——禁令由语料 spec 的 anchors lint 机械执行（`tests/eval-noise-dataset.spec.ts`：每个 anchor 逐字出现在其物化 home turn、marker 落在带记忆关键词的轮次、噪声地板校验），不靠人工纪律。

### 切片专属语料字段

- 场景级 `register: 'clean' | 'noisy'`——报告仅在语料携带该字段时增加 `register=` 分片轴与逐场景 register 列（core-v0 无此字段，报告形状不变）。
- 场景级 `patterns`——该场景覆盖的长难模式声明（spec 校验切片并集）。
- 埋点级 `plantFacts[]` 表——按埋点 id 携带可选元数据：
  - `factText`：规范化干净摘录，**同时**是 judge 地面真值与机械层 fact 文本（埋点埋在中段意味着整段 150–600 字 dump 会成为地面真值，同时破坏保真判读与假阳性控制）；无该字段的埋点维持现状物化（整段 home turn）。
  - `anchors`：锚定 token 数组，供 anchors lint。
  - `expectedScope` / `expectedCategory`：scope/category 标准答案；storage rubric v2 dim 2 在场时按钉定值判，缺席回到 rubric 路由规则（core-v0 不钉，judge 现场推断）。

### noisy 场景的提取链：review lane，不走 dispose flush

clean plant 场景靠 dispose 触发提取落盘；noisy 场景改走**周期 review 中段写入**：runner 对 `register: 'noisy'` 场景钉 `reviewCandidateThreshold: 1`（`eval/runner.ts` 的 `noisyReviewPatch`），每条埋点轮次带显式记忆关键词（accumulator 的候选触发，spec lint 守住），review 在下一个 pre-step 触发——中段写入时进程还活着。原因（实测 2026-09-03）：SDK stdio 路径上 harness 发出 `session/disposed` 后 ~26 ms 即硬退出，dispose flush 的 LLM 往返加写库无法保证在此之前落地——这是评测赢不了的发车竞态，中段 review 让写入必然落定后再进追问会话。

### 试点门禁（预登记判定规则）

`npm run eval:pilot -- --build <dir>` 按序跑五道门（规则在首判之前定死，防门槛退化为走过场；`eval/pilot.ts` 编排，`eval/pilot-gate.ts` 纯函数由 vitest 覆盖）。参数：`--build`（被测构建，缺省仓库根）、`--dataset`（缺省 noise-v0.jsonl）、`--fixture`（缺省 noise-v0.pilot.json，含路由脚本与校准集）、`--concurrency`（缺省 2）。退出码非 0 = 有门未过，逐条打印失败。

| 门 | 内容 | 判据 |
|---|---|---|
| G1 链路健康 | mock 全链跑 noise 切片 | 无场景错误、开场 system prompt 捕获在位（预算违约由 runner 本身 fail loud，mock plant 不写库故无 fence 断言） |
| G2 同构建 A/B | 两遍 mock 自比 | 确定性层逐场景 EQUAL |
| G3 锚点可匹配性 | fake-LLM 按内容路由驱动**真实提取链**（external 模式） | `entryCount > 0` 前提在场、memory fence 在场、非 negative 题锚点命中**实际写入的条目**（锚定禁令只保证「写入后可匹配」，不保证「被写入」——0 写 0 命中的同档是空转通过） |
| G4 两遍稳定 | 同一材料 judged 判两遍 | 任一条目/题目翻档 ≤1 档 |
| G5 校准 | fixture 里作者预写期望档位的 3–5 条 noisy 条目 | 全命中 |

G4 只测重测信度：温度 0 下 judge 可能「稳定地错」，G5 的校准集才测效度。n≈6 的裸一致率置信区间过宽，不设数值阈值，与 clean 切片的区间重叠即延长试点。G1–G3 无凭据可跑；G4/G5 需要判定器（同 judge 门控链，见下节），缺失时 pilot 响亮报错退出。时间盒：两轮 rubric 迭代仍不过 G4+G5 → noise 切片冻结为 rejected，rubric v2 与报告层修复单独 ship。noisy 场景的单场景时长与单 turn 工具调用数不得显著高于 clean（默认 180s / 32 calls 预算下留余量；不够先调预算并盖印）。

## 指标语义

报告按 kind / domain / language / question type 分片并给 total；语料携带 `register` 字段时增加 `register=` 分片轴（noise-v0 专属）并在逐场景表多一列。均值只覆盖可测值，不可测不进分母、判定失败不静默归零。

| 指标 | 层 | 语义 |
|---|---|---|
| standingHit | 机械 | 追问会话开场 system prompt 的注入行里，题目所需的**每一条**事实都能命中（逐字快速路径优先，否则 distinctive-token 规则）；负例题不可测（null），不计入分母 |
| noiseRatio | 机械 | 注入条目行中与本题无关的占比（同一 distinctive-token 判定） |
| injectionCost | 机械 | 注入记忆段的字符数与 ≈token（`ceil(chars/4)`）；memory off 时为 0 |
| injectionQuality | 判定 0–3 | 注入质量：0 缺席、1 在场但误导/过时/冲突未标注、2 正确但混入显著噪声、3 干净完整可直接使用 |
| answerCorrectness | 判定 0–2 | 答案对照 gold：0 错误或幻觉、1 部分正确、2 正确；仅真模型轮次有答案可判 |
| storage 四维 | 判定 0–2 | 逐条入库条目对照其埋点事实：内容保真 / 范围与分类 / 可检索性 / 合并行为（合计 0–8）；scope 错误按 rubric 封顶 |
| storagePrecision | 机械×判定 | 本会话**写入或更新**的条目（rubric v2 medium-diff 口径：新写入 id ∪ 既有 id 上 content/scope/category/summary 任一有 diff 的更新）中溯源到埋点事实的占比（提取幻觉率）；就地合并进既有条目是「更新」，计入分母、不算幻觉——v1 口径只数新写入，precision 不可与 v1 互比 |
| invalid | 计数 | 判定回复两次解析失败的条目：分数置 null、不进任何均值或 precision，报告单列计数 |

**独立题 headline**：paraphrase 题与原题共享 `gold`/`requires` 且多为弱复述，把 132 题全量均值当独立样本呈现会夸大有效题量。报告 `totals` 旁单列 `independent`（剔除 paraphrase 后的均值，markdown 的 Totals 表两行并排给出），`type=paraphrase` 分片照旧在 Slices 表。

**答案提升量相对无记忆对照**：真模型轮次跑两次——一次正常（`--memory-mode index|full`），一次 `--no-memory` 对照——报告的 `answer` 列分别是两次的 answerCorrectness 均值，提升量由两份报告相减读出。`eval:ab` 的 judged deltas（storage total / 注入质量 / 答案）给出的是两个**构建**之间的配对差值，确定性层（standing hit、noise、注入成本、fence 形态、入库条目数）则逐场景精确比对——mock 下同构建自比必须 EQUAL。

## rubric 版本化与 judge 门控

评分锚定在 `eval/rubric/storage-v2.md` 与 `eval/rubric/recall-v2.md`：judge 的 system prompt 就是 rubric 文本逐字；每份报告盖印所用版本（首行 `Rubric version: <N>`）；改动锚点必须升版本，**不同 rubric 版本的分数永不互比**。v1 两份仍留在树内，是历史报告所盖版本的冻结标尺（`tests/eval-rubric.spec.ts` 守其逐字不变），judge 只读 v2。v2 相对 v1 的四处锚点变化（2026-09-03 审计）：(a) storage dim 1 明确「对错别字/语病的归一化不算编造，保留原样也不算缺失」；(b) recall 1 档收编「准确但无过时标注的同主题邻居条目」（带可见弃用标注的不降级）；(c) storage 测量改 medium-diff 口径——被更新的既有条目进入 judge 输入、标记 `updated: true`、计入 precision 分母，precision 语义随之不可与 v1 互比；(d) dim 2 支持语料钉定的 `expectedScope` / `expectedCategory` 标准答案。历史报告不得按新标尺重读；报告层的 `independent` 独立题列同为 v2 窗口新增。judge 协议：temperature 0、严格 JSON 输出、解析失败重判一次，再失败记 invalid 并单列。

judge 配置按优先级回退：

| 优先级 | 来源 | 行为 |
|---|---|---|
| 1 | 环境变量 `EVAL_JUDGE_BASE_URL` + `EVAL_JUDGE_API_KEY` + `EVAL_JUDGE_MODEL` 三者齐备 | 判定打到该端点 |
| 2 | eval 配置文件的 `judge:` 分节（`baseURL` + `apiKey` 或 `apiKeyEnv` + `model`，可选 `reasoningEffort`） | 判定打到该端点；分节存在但不完整（半截粘贴、空 key、未知字段）响亮报错，绝不静默跳过 |
| 3 | `DEEPSEEK_API_KEY` 在场 | 用 DEEPSEEK 凭据（`DEEPSEEK_BASE_URL` 缺省官方端点，模型缺省 `deepseek-chat`） |
| 4 | 全缺 | 判定层 skipped（报告标注 "judge: skipped (deterministic layer only)"），确定性层照常跑，退出码不受影响 |

`eval.yaml` 是 eval 专属的仪器配置文件，候选路径按序取第一个存在的：**项目根 `eval.yaml`**（推荐放这里，含粘贴 key，已 gitignore、保持 0600）→ 部署 home 的 `$DSH_HOME/eval.yaml`（缺省 `~/.dsh/eval.yaml`）；`$DSH_EVAL_CONFIG` 显式指定单一文件（测试/CI 用）。换机部署时从仓库根的 `eval.yaml.example` 复制为 `eval.yaml` 再填值，示例的字段与响亮校验一一对应。与部署 settings.yaml 分离——**judge 刻意不缺省为被测模型**（同源自评偏置），模型身份随报告盖印。`judge.reasoningEffort` 透传为请求体的 `reasoning_effort` 参数（openai-completions 端点即 fuyao 网关接受的 wire 值）。

判定模型的凭据链与被测模型的相互独立：`--mode real` 的被测路由经 `credentials.path` 补丁直接读部署 home 的托管凭据文档（`.credentials.yaml`，UI Models 页写入的那份）+ 继承环境（boot 前预检引用可达性，缺失响亮失败）；被测模型的思考强度透传部署 `agent-default-model.reasoningEffort`（如 `max`），经 SDK 初始化握手生效；判定路由只认上表来源。两类真模型调用都不进 CI。

## 隔离纪律

- 每个场景物化一个临时 `$DSH_HOME`（`mkdtemp`），harness 子进程以该目录为 home 与 cwd 运行，遥测关闭；成功跑完即删，失败保留并在报告与 stderr 打印 kept home 路径。
- 子进程的 `HOME` 指向临时 home 内的空目录 `<DSH_HOME>/home/`（含钉死的 `.gitconfig` 身份，`eval/boot.ts` 的 `materializeChildHome`）：不继承外层机器的全局 skills 目录（`~/.agents/skills`，其清单会随每次模型调用重发 ≈4.2K tokens 且随机器漂移），也不继承真实用户文件——SUT 的 prompt 只由被测构建决定。此条件之前的报告（SUT prompt 带全局 skills）与之后的分数不可逐分对比。
- 评测运行时不向仓库写任何文件：profile、配置 overlay、store、报告（除非显式 `--out`）全部落在临时目录或 stdout。
- `lib/` 是被测构建本身，不是评测运行时状态：`eval:smoke` 只在 `lib/` 缺失时自动补一次 `npm run build`，已存在的 `lib/` 不会重建——A/B 的 baseline 正是靠这一点保持固定。

## 实现地图

| 文件 | 职责 |
|---|---|
| `eval/cli.ts` | 参数解析、过滤、并发调度、报告输出与退出码 |
| `eval/pilot.ts` | 噪声试点编排：G1–G5 门禁依序跑，judge 缺席 fail loud |
| `eval/pilot-gate.ts` | 预登记判定规则：fixture 解析 + 五道门的纯函数（vitest 覆盖） |
| `eval/runner.ts` | 场景执行：seed 链（预写 store → 追问）与 plant 链（对话埋点 → dispose → quiesce → 同 home 新开 handle 追问；noisy 场景改走 review 中段写入，`noisyReviewPatch`）；medium-diff 更新追踪 |
| `eval/boot.ts` | 临时 home + profile 物化 + `dsh --profile sdk` 子进程 + SDK stdio 驱动；从 `request/header` 事件捕获开场 system prompt |
| `eval/mechanical.ts` | 机械指标：fence 解析、注入行匹配（逐字 + distinctive token）、噪声、成本 |
| `eval/judge.ts` | rubric 驱动的存储/召回判定（v2）、env 门控、invalid 协议、updated 条目标记 |
| `eval/report.ts` | 纯聚合：分片指标（含 register 轴）、独立题 headline、盖印报告、A/B 配对 diff（JSON + Markdown 渲染） |
| `eval/schema.ts` | 语料 schema（zod）：场景/轮次/埋点/题目契约与加载校验；noise 切片字段（register / patterns / plantFacts）与 factText 物化规则 |
| `eval/smoke.ts` | M0 冒烟：一条 seed 场景走通整条链并断言注入与落盘 |
| `eval/datasets/*.jsonl` | 语料：`smoke.jsonl`（1 场景 2 题）、`core-v0.jsonl`（32 场景 132 题）、`noise-v0.jsonl`（6 长难场景）+ `noise-v0.pilot.json`（试点 fixture：路由脚本 + 校准集） |
| `eval/rubric/*.md` | 版本化评分 rubric：活跃对 `storage-v2` / `recall-v2`，冻结对 `storage-v1` / `recall-v1` |
| `eval/harness/*` | 启动支撑：profile 模板、SDK stdio 客户端、llm-mock 启动器、fake LLM（含 noise 切片按内容路由 `noise-routes.ts`）、quiesce 轮询、store 预写/读取 |

plant 链的多次会话语义：一个 handle 是一个会话，其记忆快照在会话创建时冻结（KV-cache 契约）；同 `$DSH_HOME` 再开一个新 handle 即新会话——常驻注入度量的是新会话开场 prompt。等待落盘稳定用 quiesce 轮询（审计表 + 条目数稳定，默认 30 秒上限）。

`eval/` 与其评测 spec 不在 CI 的 tsc 程序内（host tsconfig 只含 `src/`），类型检查是手工门禁：`npx tsc -p tsconfig.check.json`（严格档全开、noEmit，覆盖 `src/` + `eval/` + eval 相关 spec，实测 0 error）：

```sh
npx tsc -p tsconfig.check.json
```

## 已知 v0 边界

- **real 模式与真 judge 都需密钥**：两者均 env 门控、永不进 CI；mock + 确定性层是无凭据也能完整跑通的部分（noise 切片另加 fake-LLM 提取链 lane，同样无凭据）。
- **multi-hop 切片仅 3 题**（plant 2 / seed 1），样本不足以支撑任何结论；negative 5 题只守护「不幻觉断言」一个侧面。
- **mechanical 匹配阈值是确定性近似**：≥2 个 distinctive token 或 ≥1 个 distinctive ASCII 锚点加逐字快速路径，是 v0 的实现选点，不是语义裁决；noise 切片用 `factText` 收敛机械层的对比集，standing hit 只在「确有写入」时有意义（试点 G3 的 entryCount 前提）。
- **noise 切片样本量小**（6 场景 14 题）：试点判定只给重测信度（G4）与校准效度（G5），不设数值阈值；扩量与 core 侧 scope 标准答案铺开在阶段 1。
- **plant 链路在 mock 下分数偏低**：mock 不按内容路由，提取拿不到贴合对话的应答；要测提取质量须用 fake LLM + external（noise 试点自带 route 表）或真模型。
- **judged 层不可跨校准比较**：judge 模型身份与 rubric 版本随报告盖印，两者任一变化都会改变分数标尺——v1↔v2 永不互比（precision 分母与 dim 2 判据都变了）。
- **`storage` 四维在 mock 全量下恒为 null**：mock 提取不产出可判条目；存储四维的 judged 读数来自 external（fake-LLM 提取链，如试点 G3/G4）或 real 模式。
