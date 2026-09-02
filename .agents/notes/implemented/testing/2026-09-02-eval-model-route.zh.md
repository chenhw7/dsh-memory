# Agent Note: 测评模型路由——默认 agent-default-model，--model 可指定

Status: implemented

[English](2026-09-02-eval-model-route.md) | 中文

## 问题

测评套件的模型面有一个洞：`--mode real` 只能指向 DeepSeek 官方、握手模型硬编码为 `deepseek-v4-flash`（[harness 运行测评集](2026-09-01-harness-eval-suite.zh.md)），任何 OpenAI 兼容网关都无法作为被测模型接入——而维护者真实部署的是公司内 `fuyao` 网关（`fuyao-work`/`fuyao-coding`），套件没有无密钥路径接纳它，第一次带密钥的 L2 跑因此没有确定的模型故事。

## 决策

1. **被测模型 id 是 CLI 变量，不是硬编码常量。** `--model <id>`（`eval` 与 `eval:ab` 均可）为 `real`/`external` 运行点名被测模型；`mock` 拒绝该参数——mock 路由是确定性的，什么都不读。
2. **缺省 = 部署自己的默认。** 无 `--model` 时，id 从外层部署 home（`$DSH_HOME`，缺省 `~/.dsh`）的 `settings.yaml` → `agent-default-model.model` 解析——与会话实际拿到的模型一致。部署未声明时回退出厂 `deepseek-v4-flash`。每次解析都打印来源行；settings 文档存在但不可读、不可解析或 `agent-default-model` 畸形时报错退出（`eval/model-route.ts`）。
3. **provider 轴**——本篇将其钉死在 `deepseek-official`：SDK server 的 initialize 兜底只挂该适配器，因此 harness 触达任意 OpenAI 兼容网关的方式是把适配器端点指过去（`external` 用 `--base-url`，`real` 用 `DEEPSEEK_BASE_URL`），模型 id 走初始化握手；deepseek 适配器对目录外模型 id 安全放行（text-only、默认上下文窗）。**同日稍后废止**：[测评 provider 路由](2026-09-02-eval-provider-route.zh.md)——部署 settings 的 `llm-pi-ai:` 分节在一次性 home 激活 pi-ai 路由（与 web Models 页同一激活方式），`real` 从 `agent-default-model` 解析 provider/model。deepseek 适配器端点路由保留为 `external` 形态与 DeepSeek 回退。
4. **报告盖印模型身份。** `EvalReport.model` 记录 `{ mode, id }`（mock 路由 `id: null`），与被测构建、rubric 版本、judge 身份并列——分数永不脱离其校准被读取。

## 备选方案

**在 eval profile 里挂 `dsh-llm-pi-ai`，把部署 provider 直通。** 镜像部署更忠实（compat 旗标、per-provider 模型目录），但 SDK server 对未挂载的 provider 名直接抛错，需要改一次性 home 的 profile bundle 再补 provider settings 块——同一根 wire，零件多一倍。deepseek 适配器路由本来就讲 OpenAI 兼容 chat completions，fuyao 网关服务的正是它。只有当目标网关需要 pi-ai 特有协议行为时才值得重议。

**解析期对照模型目录校验 id。** 适配器刻意把目录外端点视为 text-only；解析期目录会拒掉的恰是本次改动要启用的外部网关场景。

**`agent-default-model` 缺席时静默回退。** 拒绝——随机器悄悄变化的解析与过期报告无法区分；打印来源行让它保持可观察。

## 后果

- 第一次带密钥的 L2 跑不需要本改动之外的任何代码：`--mode external --base-url <网关> --api-key <key>` 配上指向同网关的判定环境即可端到端跑 `fuyao-work`（或任意 `--model`）；模型 id 落进报告盖印。（provider 轴由[测评 provider 路由](2026-09-02-eval-provider-route.zh.md)废止：零配置带密钥路由现为 `--mode real`，走部署自己的 `agent-default-model` + `llm-pi-ai` 镜像。）
- `yaml` 包进入 devDependencies（仅 eval 用；`files` 仍排除 `eval/`）。
- 部署 home 的 `settings.yaml` 只在 CLI 启动时读取一次；运行中改动不影响进行中的运行。
- `EvalReport` 增加必填字段——A/B JSON 载荷与报告形状的下游消费方必须携带 `model`。
