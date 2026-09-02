# Agent Note: 测评 provider 路由——镜像部署 home 的 llm-pi-ai settings 分节

Status: implemented

[English](2026-09-02-eval-provider-route.md) | 中文

## 问题

同日早上的[测评模型路由](2026-09-02-eval-model-route.zh.md)把 provider 轴钉死在 `deepseek-official`，让非 DeepSeek 网关改走适配器端点。这作为 harness 论断是错的：SDK profile 的 base bundle 把 `dsh-llm-pi-ai` **休眠挂载**（零路由），部署 settings 文档的 `llm-pi-ai:` 分节——恰是 web Models 页写入的那个分节——即可激活其路由。维护者的 `~/.dsh/settings.yaml` 恰好带 `llm-pi-ai.providers.fuyao` 与 `agent-default-model: fuyao/fuyao-work`，这正是 web 会话与记忆整理管线能选 fuyao 而测评不能的原因：eval 的一次性 home 物化的是空 settings 文档，适配器休眠，`initialize` 遇到非 DeepSeek provider 落进只认 `deepseek-official` 的兜底路径并抛错。钉死的说法描述的是 eval 自己的配置状态，不是 harness 限制。

## 决策

1. **部署 home 的 `settings.yaml` 是唯一配置源。** eval 经 `$DSH_HOME`（harness 自己解析的同一变量，缺省 `~/.dsh`）读取——不新增 eval 专属 yaml、不硬编码路径，套件的跨环境可移植性由构造保证。
2. **`agent-default-model` 是缺省路由（双轴）。** 一旦声明，`provider` 与 `model` 必须同时存在（半截声明会把部署 provider 与 eval 回退模型悄悄混合——响亮报错）。显式 `--provider`/`--model` 旗标逐轴覆盖；全缺省时回退出厂 `deepseek-official`/`deepseek-v4-flash` 组合。
3. **`real` 模式把部署的 `llm-pi-ai:` 分节镜像进一次性 home**（解析在 `eval/model-route.ts`，物化在 `profile-template.ts`，该分节即一次性 settings 文档）。分节由适配器自身的 schema 在加载时校验；provider 档案必须把凭据留在 `apiKeyEnv` 引用之后——携带内联凭据字段的档案在镜像前响亮报错（一次性 home 与保留的故障 home 都不是凭据去向）。密钥按请求经 harness 凭据 seam 从继承环境解析（eval 进程环境里的 `FUYAO_API_KEY` 直达子进程）。
4. **模式语义按路由形态各归其位。** `mock` 是确定性 deepseek-official 形态：不读任何东西、拒绝 `--model`/`--provider`。`external` 伪装 deepseek 适配器 wire：provider 固定 `deepseek-official`、拒绝 `--provider`。`real` 承接完整解析——DeepSeek provider 保留 DEEPSEEK 密钥预检；pi-ai provider 路由天然 live、必须有镜像分节（`eval/boot.ts` 双守）。报告把路由盖印为 `model: { mode, provider, id }`。

## 备选方案

**专门的 eval 模型 yaml（如 settings.yaml 旁的 `eval.yaml`）。** 会复制部署已拥有的 provider 字典，还要为自己的跨环境可移植性再设计一套路径解析；harness 原生的 settings seam 已承载 live 真值且支持热重载。拒绝——一个配置源，零漂移。

**把 `dsh-llm-pi-ai` 挂成 eval profile bundle，provider 配置写进 cordis.patch.yml。** 组合行 base bundle 里已经有了；profile 级挂载会把部署的 provider 集合硬编码进 eval 模板——恰是 settings 镜像要避开的按环境耦合。

**维持 provider 轴钉死，网关一律走 deepseek 适配器端点。** 对 OpenAI 兼容 wire 可行（早上那篇已落地），但绕开了部署的 provider 档案——端点、模型目录、compat 事实都要重新表述成 eval 旗标，且被测模型不再是「真实会话拿到的那个模型」。

## 后果

- 零配置带密钥运行即 `npm run eval -- --mode real --build . --judge`：本部署下解析为 `fuyao/fuyao-work`，镜像 `llm-pi-ai:` 分节，端到端跑的正是 web 会话使用的同一条路由——包括骑在会话路由上的记忆整理管线。
- `--provider` 进入 CLI（含 `eval:ab`）；`EvalReport.model` 增加 `provider`；一次性 home 的 settings 文档在 real 运行下不再恒为静态 `{}` 模板。
- `agent-default-model` 点名的 provider 若无已存登录/`apiKeyEnv` 凭据，会在第一个 turn 以适配器的 `MISSING_CREDENTIAL` 失败（响亮，点名环境变量与两条补救路径），而非 eval 解析期——eval 不预读凭据面。
- 以 idle 结束却没有 assistant 消息的 turn 现在在 boot 边界响亮失败（`eval/boot.ts`）：agent loop 在每个完成或被中断的 step 上都会追加 assistant 消息，因此「idle 无回答」即模型路由失败——此处静默会让 real 运行以 `ok` 记分却没有任何答案，与健康的无判定运行无法区分。底层 LLM 失败（如 `MISSING_CREDENTIAL`）被 harness driver 收容、存于运行时自身诊断；eval 的错误信息指明补救方向。
- 早间 Note 的 provider 钉死决策由本篇废止；两篇保持交叉链接。
