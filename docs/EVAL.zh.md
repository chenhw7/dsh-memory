# Cairn 测评集 runbook（真实 harness 评测）

本手册描述 `eval/` 测评集的运行方式：把被测插件构建作为 profile bundle 挂在真实 DeepSeek harness 上，对同一份场景语料量化「存储 → 常驻注入 → 作答」链路，输出分片指标与 A/B 配对 diff。决策依据见 [Agent Note](../.agents/notes/implemented/testing/2026-09-01-harness-eval-suite.zh.md)，系统整体见 [TECH_DESIGN](./TECH_DESIGN.zh.md)。

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

三个入口共用一套参数：`eval`（单构建评分）、`eval:ab`（双构建配对 diff，用 `--baseline`/`--candidate` 替代 `--build`）、`eval:smoke`（M0 冒烟，无参数）。

| 参数 | 取值 | 说明 |
|---|---|---|
| `--dataset <file>` | JSONL 语料 | 必填；每行一个场景，加载即校验 schema，空行报错 |
| `--build <dir>` | 插件构建目录 | 单构建模式必填；须含 `package.json` + `lib/` |
| `--baseline <dir>` / `--candidate <dir>` | 两个构建目录 | 仅 `eval:ab`；与 `--build` 互斥 |
| `--mode <m>` | `mock` \| `real` \| `external` | 模型路由，默认 `mock`；`external` 必须配 `--base-url` |
| `--base-url <url>` / `--api-key <key>` | OpenAI 兼容端点 | 仅 `external`；key 缺省 `eval-fake-key` |
| `--judge` | 开关 | 请求 rubric 判定；判定环境缺失时判定层 skipped、确定性层照常 |
| `--memory-mode <m>` | `index` \| `full` | 注入模式轴，默认 `index` |
| `--no-memory` | 开关 | 无记忆对照组，覆盖 `--memory-mode` |
| `--filter <ids>` | 逗号分隔的场景 id 子串 | 缩小范围；一个都不匹配时报错 |
| `--concurrency <n>` | 正整数 | 并发场景数，默认 4（每场景一个独立临时 home） |
| `--out <file>` | 报告 JSON 路径 | 缺省只打印 |

### 典型命令（均已实测）

```sh
# mock 全量：32 场景 / 128 题，确定性层
npm run eval -- --dataset eval/datasets/core-v0.jsonl --build .

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

## 指标语义

报告按 kind / domain / language / question type 分片并给 total；均值只覆盖可测值，不可测不进分母、判定失败不静默归零。

| 指标 | 层 | 语义 |
|---|---|---|
| standingHit | 机械 | 追问会话开场 system prompt 的注入行里，题目所需的**每一条**事实都能命中（逐字快速路径优先，否则 distinctive-token 规则）；负例题不可测（null），不计入分母 |
| noiseRatio | 机械 | 注入条目行中与本题无关的占比（同一 distinctive-token 判定） |
| injectionCost | 机械 | 注入记忆段的字符数与 ≈token（`ceil(chars/4)`）；memory off 时为 0 |
| injectionQuality | 判定 0–3 | 注入质量：0 缺席、1 在场但误导/过时/冲突未标注、2 正确但混入显著噪声、3 干净完整可直接使用 |
| answerCorrectness | 判定 0–2 | 答案对照 gold：0 错误或幻觉、1 部分正确、2 正确；仅真模型轮次有答案可判 |
| storage 四维 | 判定 0–2 | 逐条入库条目对照其埋点事实：内容保真 / 范围与分类 / 可检索性 / 合并行为（合计 0–8）；scope 错误按 rubric 封顶 |
| storagePrecision | 机械×判定 | 本会话写入条目中溯源到埋点事实的占比（提取幻觉率） |
| invalid | 计数 | 判定回复两次解析失败的条目：分数置 null、不进任何均值或 precision，报告单列计数 |

**答案提升量相对无记忆对照**：真模型轮次跑两次——一次正常（`--memory-mode index|full`），一次 `--no-memory` 对照——报告的 `answer` 列分别是两次的 answerCorrectness 均值，提升量由两份报告相减读出。`eval:ab` 的 judged deltas（storage total / 注入质量 / 答案）给出的是两个**构建**之间的配对差值，确定性层（standing hit、noise、注入成本、fence 形态、入库条目数）则逐场景精确比对——mock 下同构建自比必须 EQUAL。

## rubric 版本化与 judge 门控

评分锚定在 `eval/rubric/storage-v1.md` 与 `eval/rubric/recall-v1.md`：judge 的 system prompt 就是 rubric 文本逐字；每份报告盖印所用版本（首行 `Rubric version: <N>`）；改动锚点必须升版本，不同 rubric 版本的分数永不互比。judge 协议：temperature 0、严格 JSON 输出、解析失败重判一次，再失败记 invalid 并单列。

judge 凭据按环境变量门控，三层回退：

| 优先级 | 环境变量 | 行为 |
|---|---|---|
| 1 | `EVAL_JUDGE_BASE_URL` + `EVAL_JUDGE_API_KEY` + `EVAL_JUDGE_MODEL` 三者齐备 | 判定打到该端点 |
| 2 | `DEEPSEEK_API_KEY` 在场 | 用 DEEPSEEK 凭据（`DEEPSEEK_BASE_URL` 缺省官方端点，模型缺省 `deepseek-chat`） |
| 3 | 全缺 | 判定层 skipped（报告标注 "judge: skipped (deterministic layer only)"），确定性层照常跑，退出码不受影响 |

判定模型的凭据链与被测模型的相互独立：`--mode real` 的被测路由要 `DEEPSEEK_API_KEY` 环境变量或 `$DSH_HOME/.credentials.yaml` 里的 key（boot 前预检，缺密钥响亮失败），而判定路由只认上表两组变量。两类真模型调用都不进 CI。

## 隔离纪律

- 每个场景物化一个临时 `$DSH_HOME`（`mkdtemp`），harness 子进程以该目录为 home 与 cwd 运行，遥测关闭；成功跑完即删，失败保留并在报告与 stderr 打印 kept home 路径。
- 评测运行时不向仓库写任何文件：profile、配置 overlay、store、报告（除非显式 `--out`）全部落在临时目录或 stdout。
- `lib/` 是被测构建本身，不是评测运行时状态：`eval:smoke` 只在 `lib/` 缺失时自动补一次 `npm run build`，已存在的 `lib/` 不会重建——A/B 的 baseline 正是靠这一点保持固定。

## 实现地图

| 文件 | 职责 |
|---|---|
| `eval/cli.ts` | 参数解析、过滤、并发调度、报告输出与退出码 |
| `eval/runner.ts` | 场景执行：seed 链（预写 store → 追问）与 plant 链（对话埋点 → dispose → quiesce → 同 home 新开 handle 追问） |
| `eval/boot.ts` | 临时 home + profile 物化 + `dsh --profile sdk` 子进程 + SDK stdio 驱动；从 `request/header` 事件捕获开场 system prompt |
| `eval/mechanical.ts` | 机械指标：fence 解析、注入行匹配（逐字 + distinctive token）、噪声、成本 |
| `eval/judge.ts` | rubric 驱动的存储/召回判定、env 门控、invalid 协议 |
| `eval/report.ts` | 纯聚合：分片指标、盖印报告、A/B 配对 diff（JSON + Markdown 渲染） |
| `eval/schema.ts` | 语料 schema（zod）：场景/轮次/埋点/题目契约与加载校验 |
| `eval/smoke.ts` | M0 冒烟：一条 seed 场景走通整条链并断言注入与落盘 |
| `eval/datasets/*.jsonl` | 语料：`smoke.jsonl`（1 场景 2 题）与 `core-v0.jsonl`（32 场景 128 题） |
| `eval/rubric/*.md` | 版本化评分 rubric（storage / recall） |
| `eval/harness/*` | 启动支撑：profile 模板、SDK stdio 客户端、llm-mock 启动器、fake LLM、quiesce 轮询、store 预写/读取 |

plant 链的多次会话语义：一个 handle 是一个会话，其记忆快照在会话创建时冻结（KV-cache 契约）；同 `$DSH_HOME` 再开一个新 handle 即新会话——常驻注入度量的是新会话开场 prompt。等待落盘稳定用 quiesce 轮询（审计表 + 条目数稳定，默认 30 秒上限）。

`eval/` 与其评测 spec 不在 CI 的 tsc 程序内（host tsconfig 只含 `src/`），类型检查是手工门禁，命令如下（严格档全开，实测 0 error）：

```sh
npx tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess \
  --noImplicitOverride --target es2023 --module preserve --moduleResolution bundler \
  --allowImportingTsExtensions --rewriteRelativeImportExtensions --skipLibCheck --types node \
  eval/*.ts eval/harness/*.ts tests/eval-*.spec.ts
```

## 已知 v0 边界

- **real 模式与真 judge 都需密钥**：两者均 env 门控、永不进 CI；mock + 确定性层是无凭据也能完整跑通的部分。
- **multi-hop 切片仅 3 题**（plant 2 / seed 1），样本不足以支撑任何结论；negative 5 题只守护「不幻觉断言」一个侧面。
- **mechanical 匹配阈值是确定性近似**：≥2 个 distinctive token 或 ≥1 个 distinctive ASCII 锚点加逐字快速路径，是 v0 的实现选点，留作 rubric v2 校准的输入，不是语义裁决。
- **plant 链路在 mock 下分数偏低**：mock 不按内容路由，提取拿不到贴合对话的应答；要测提取质量须用 fake LLM + external（或真模型）。
- **judged 层不可跨校准比较**：judge 模型身份与 rubric 版本随报告盖印，两者任一变化都会改变分数标尺。
