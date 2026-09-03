# Agent Note: Eval per-turn work budget

Status: implemented

[English](2026-09-03-eval-turn-budget.md) | 中文

## 问题

一个失控的 agent turn 能烧掉超过整套测评的 token。2026-09-02 的 core-v0 真模型跑动里，两种形态各自烧穿了边界：一次 LLM 调用静默流式 939–1151 秒直到 384K `max-tokens` 上限、没有可见文本（两个场景死在它上面）；一次工具调用马拉松——347 次调用、33+ 分钟、单场景估算 15–25M tokens，被手工止损。现有的 120s 守护是**空闲**超时：流式 chunk 每次到达都会重置它，持续生成因此无界，工具循环则根本不会空闲。eval 对这两种形态都没有边界；mock 的确定性成功路径永远触发不了它们，所以直到一次带密钥的真模型跑动为此买单之前，什么都不会失败。

## 决策

`eval/boot.ts` 在 prompt 收集循环内强制执行单 turn 工作预算：一个 turn（一次 `session/prompt` 到 idle）的墙钟超过 `wallSeconds` 或工具调用数超过 `toolCalls` 即越限。越限抛 `eval boot: turn budget exceeded (…)`，沿既有的场景错误路径走——fail loud、保留 home、已完成的问题照旧入报告——调用方的拆除链会收割仍在运行的 turn（SDK server 只暴露 `initialize`/`session/prompt`/`shutdown`，没有 interrupt，dispose 就是中止手段）。

解析逐维独立、共三层：显式 CLI 旗标（`--turn-wall-seconds`、`--turn-tool-calls`，`0` = 关该维）优先，其次是 eval 仪器配置（`eval.yaml`）的 `turnBudget:` 分节（响亮校验：两字段必填、非负整数、未知字段拒绝），最后是代码默认（180s / 32 次——锚在观测到的最坏合法 turn 的 ≥2× 和病态流的 ~⅕）。生效值盖印进每份报告（`turnBudget` 字段 + markdown 头部行）并打印在启动行——被评分的样本永远带着它的校准。纯判定住在 `turnBudgetBreach`（vitest 接缝）；`startHarness` 新增 `mockSequence` 透传，让 harness mock 的 `tool_call_success` 行为能端到端驱动无限工具轮次。

## 备选方案

**下调 initialize 握手的 `maxTokens`**（如 384K → 32K）。harness 原生、零监控代码，能封住单调用流式——但它改变被测模型的一个真实操作点（必须盖印，且网关对 reasoning token 是否计入 `max_tokens` 未验证），而且对工具马拉松无效。按维护者的决定留作可能的二期叠加。

**场景级墙钟。** 更粗：六个 5 分钟的 turn 要烧满 30 分钟才触发，而 per-turn 在 ~6× 之前就拦住了。留作可选背带，刻意不建。

**不设预算**（变更前的现状）；2026-09-02 的跑动就是反对它的、已经付过钱的证据。

## 后果

- 单个坏 turn 的最坏代价从无界（35 分钟、数千万 tokens）压到 ≤180 秒的持续活动；整个场景被隐式封顶在约 turns × 180s。
- 合法的长 turn 现在会 fail loud 而不是默默跑完：某个语料场景若真需要单 turn 超过 180 秒的 agent 工作，必须用旗标或 eval.yaml 抬高预算，且抬升在报告盖印里可见。v0 语料的对话型 turn 远低于默认值。
- 报告盖印纪律：不同预算下的 run 是不同校准下的分数；盖印让它可见，而不是静默可比。
- 仍未决：确定性的每分钟 token 上限（限流代理）——预算封的是单个 turn 的损害，不是每分钟速率；见 [eval child home isolation](2026-09-03-eval-child-home-isolation.md)，本篇解决其"left open"事项之一。

## 测试

- `tests/eval-config.spec.ts`：分节解析（在场/缺席/`0`-off/半截/未知字段/负数/浮点/标量全部响亮）、三层解析（旗标 > 文件 > 默认，`0` 逐维获胜）、越限判定（线内/墙钟/工具/关维、边界值）。
- `tests/eval-report.spec.ts`：盖印携带 `turnBudget`，markdown 头部渲染预算行与 `unbounded` 形态。
- 经真实 spawn 路径端到端（mock `tool_call_success`、预算 5 次调用）：prompt 以 `eval boot: turn budget exceeded (toolCalls 6 > 5) — turn aborted, scenario fails` 拒绝；runbook 记录了脚本。
- `npm run eval:smoke` 在默认值下通过；`eval/` 的严格 `tsc` 门禁 0 error；vitest 全量通过（772 passed，6 个 env 门控跳过）。
