# Agent Note: 测评仪器配置——部署 home 的 eval.yaml 与思考强度透传

Status: implemented

[English](2026-09-02-eval-judge-config.md) | 中文

## 问题

rubric judge 只有环境变量（`EVAL_JUDGE_*`）一条路，用起来是摩擦：操作者的凭据本来就在部署 home 里，每次 L2 跑贴三个变量容易复制粘贴出错。另外两侧模型都没有思考强度：被测模型无视部署声明的 `agent-default-model.reasoningEffort`（被打分的行为与真实会话不一致），judge 请求也无法按选定强度开启思考。

## 决策

1. **`eval.yaml` 是 eval 的仪器配置**（`eval/eval-config.ts`），候选路径按序取第一个存在的：项目根 `eval.yaml`（推荐——粘贴 key 的那份，已 gitignore、保持 0600）→ 部署 home 的 `$DSH_HOME/eval.yaml`（缺省 `~/.dsh/eval.yaml`）；`$DSH_EVAL_CONFIG` 显式指定单一文件（测试/CI 用）——只管 judge，刻意为之：judge 绝不能缺省为被测模型（同源自评偏置），部署 settings.yaml 保持被测模型唯一来源，本文件不覆盖它。`judge:` 携带 `baseURL` + `apiKey`（直接粘贴）或 `apiKeyEnv`（从 eval 进程环境解析）+ `model`，可选 `reasoningEffort`。分节存在但不完整（贴了一半的 key、未知字段、两种凭据形式并存）响亮报错——半截配置的仪器不能静默退化为跳过判定。
2. **优先级：`EVAL_JUDGE_*` 环境三元组 → eval.yaml `judge:` → `DEEPSEEK_*` 回退 → skipped。** yaml 压过泛化的 DEEPSEEK 回退（它是更具体的仪器声明）；环境三元组压过 yaml（逐次运行的显式覆盖本就该最高）。
3. **思考强度端到端透传。** 被测模型：`agent-default-model.reasoningEffort` 随路由解析进 SDK 初始化握手（`boot.ts`），由 harness 侧按 provider 档案声明的档位校验（否则 `UNSUPPORTED_REASONING_EFFORT`）——被打分的运行以真实会话的强度思考。judge：`judge.reasoningEffort` 原样作为请求体的 `reasoning_effort` 参数（`openai-completions` 端点接受的参数；pi-ai 从档案映射派发同一 wire 值）。
4. **报告盖印携带强度。** `EvalReport.model` 增加 `reasoningEffort`（mock/未声明为 `null`）——答案随强度变化，分数永不脱离它。

## 备选方案

**judge 缺省自动取部署的 agent-default-model。** 零配置，但让 judge == 被测模型成为静默缺省——恰恰是独立仪器要避免的偏置。拒绝。

**让 eval.yaml 也覆盖被测模型。** 会复制 `agent-default-model`、重新引入刚被 settings 镜像消除的漂移；逐次覆盖已有 `--model`。拒绝。

**judge 的 key 从托管凭据文档解析。** judge 是 eval 进程的直接 fetch，取值必须在进程内解析——打破凭据面刚确立的 probe-never-parse 原则。`apiKeyEnv` 引用（环境提供）是诚实的中间态：操作者报引用名，eval 读环境、不读凭据文档。

## 后果

- judge 的粘贴路径现在是部署自有配置旁边的文件：`apiKey` 贴一次（0600），此后每次 L2 跑就是 `npm run eval -- --mode real --judge`，零环境变量。CI 式场景保留 `apiKeyEnv`。
- `EvalReport.model` 增加必填 `reasoningEffort` 字段；报告形状的下游消费方必须携带它。
- 被测模型的思考强度现在与部署声明一致——`agent-default-model.reasoningEffort` 改动会静默改变 eval 行为，这正是镜像部署的本意，也因此盖印让它始终可见。
