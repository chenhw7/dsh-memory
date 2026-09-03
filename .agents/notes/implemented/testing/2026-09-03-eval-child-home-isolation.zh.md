# Agent Note: Eval child home isolation

Status: implemented

[English](2026-09-03-eval-child-home-isolation.md) | 中文

## 问题

测评套件的一次性 `$DSH_HOME` 隔离了 harness 状态，但 `dsh` 子进程继承了外层进程的 `HOME`。第一次全量真模型跑动（2026-09-02，fuyao-coding、reasoning effort high、fuyao-data judge、concurrency 2）暴露了两个后果：

1. **随机器漂移的 prompt 成分。** harness 在 `$DSH_AGENTS_HOME ?? homedir()/.agents` 发现用户 skills（harness `packages/skill/skill-filesystem`），于是每次 SUT 请求都带着当前机器的全局 skills 目录清单——约 8.9K 字符（≈4.2K tokens）的 user 块，占每次调用固定输入的 ~27%。它随机器和用户 skills 的增减而变化，SUT 的 prompt——进而所有常驻注入度量——成了"跑测评的机器"的函数，违背了本套件"被测构建是唯一变量"的章程。
2. **场景虚构与真实机器相撞。** SUT 把注入的 skills 当成对真实主机的操作许可：work210 发起了真实的 Lark OAuth 流程，轮询 `job_output` 等人扫码，直到 eval 的 120 秒 turn 超时杀死场景（两次失败，可复现）；prog116 花了 ~60 次工具调用在维护者的真实家目录里找场景虚构的缓存问题，随后一次 LLM 调用静默流式到 384K `max-tokens` 上限、没有可见回答；prog104 自建假 monorepo 跑出 347 次工具调用的编码马拉松（估算 15–25M tokens，手工止损）。32 场景失败 3 个；没有一个是限流或记忆链路失败（166 次 judge 调用 0 error、0 invalid、0 次 HTTP 429）。

## 决策

`eval/boot.ts` 在 `<dshHome>/home/` 物化一个假的子进程用户 home——空目录加一份钉死的 `.gitconfig`（身份 `dsh-eval <dsh-eval@localhost>`、`init.defaultBranch = main`）——并把子进程的 `HOME` 指向它，与既有的 `DSH_HOME` 钉定并列。harness 的 skills 发现已解析为零条目，git 身份确定，`homedir()` 之下没有任何真实机器路径可达。`materializeChildHome` 幂等（plant 链在同一个 dshHome 上开两个 handle），假 home 与 dshHome 共享生命周期：成功随目录删除，失败保留取证。钉 `.gitconfig` 是因为 plant 对话会要求 SUT 提交；没有身份时 git 的报错本身就会扰动行为。

## 备选方案

**只覆盖 `DSH_AGENTS_HOME`。** 同样一行就能隔离 skills 目录，但 `~/.gitconfig` 和其他所有 `homedir()` 消费者照样继承——更窄的切口，保留的恰是本套件要排除的那类机器泄漏（git 身份、缓存）。

**往假 home 里种一份固定的 skills 快照。** 可以让 skills 维度可测且机器无关。否决：~4.2K tokens/调用的成本和确定性的 OAuth 等待挂起都还在（skill 文件是指令；认证后端仍然需要人），测量依旧脆弱，没有换来任何已测得的收益。

**经 profile patch 层钉住 skill provider 的 `config.agentsHome`。** 对 skills 效果相同，但需要向钉死的配置层做逐 run 的模板替换，并把 eval 耦合到单一 provider 的配置 schema；子进程 env 一行、与模式无关、一次覆盖所有 `homedir()` 消费者。

## 后果

- 每次 SUT 调用的固定输入下降 ~15%（实测完整请求体 58.3K → 49.3K 字符；skills 块占 ~15.5K token 固定基数中的 ~4.2K）。
- 已记录的三种失败模式失去触发源：场景虚构无法再"借"真实家目录求解，lark/skill 面不再把 SUT 拖进交互流程。
- 此变更之前盖印的报告测的是带 skills 的 SUT prompt，与之后的分数**不可逐分对比**；[runbook](../../../../docs/EVAL.zh.md) 的隔离纪律一节记录了该条件。
- SUT 刻意与维护者的交互式部署在一个维度上不同（无 skills 目录）。度量"部署中的 agent 带真实 skills 的行为"属于部署行为审计，不是这台仪器的职责。
- 遗留：单场景工作预算（马拉松仍可在假 home 里发生）与确定性的每分钟 token 上限（限流代理）；两者是独立决策。

## 测试

- `tests/eval-harness.spec.ts`：假 home 物化在 dshHome 内、带钉死 git 身份，同一 dshHome 的第二个 handle 幂等。
- 前后各抓一次完整 mock SUT 请求：8.9K 字符的 skills user 块消失；system prompt 与 34 个工具的 schema 不变。
- `npm run eval:smoke` 通过；vitest 全量通过（763 passed，6 个 env 门控跳过）；`eval/` 的手工严格 `tsc` 门禁 0 error。
