# Agent Note: 记忆工具输出 schema 漏声明投影携带的 summary 字段

Status: implemented

[English](2026-09-07-summary-undeclared-in-memory-tool-output-schemas.md) | 中文

## Problem

harness 的 ToolRuntime 对每次工具返回按声明的 `output.schema` 做校验（`additionalProperties: false`），任何未声明属性都让整次调用失败（`INVALID_TOOL_OUTPUT`）。输出携带条目投影的五个工具里有四个——`memory_search`、`memory_list`、`memory_get`、`memory_replace`——没有声明 `summary`，而投影（`toEntryJson`）在条目带 summary 时必然输出它；`memory_add` 声明了。于是这四个工具任何一次返回带 summary 条目的调用都整体报错：`"value.entries[0].summary" is not a declared property (additionalProperties: false)`。

失败形态让它躲过了此前所有车道。mock 评测模型从不调用工具（只测确定性层）；单测/集成测试挂载的是同一个 ToolRuntime——校验器本会触发——但其种入的条目都不带 summary；常驻注入走 context injector 而非工具层，会话 prompt 一直健康。写工具存 summary 毫无问题，之后第一次读取即失败。它只在 2026-09-07 的真模型 judged 运行中显形：seed 场景的作答报告 `memory_get`/`memory_search`/`memory_list` 全部失败（「因 schema 问题」），一个中止场景的保留 home transcript 里留存了原文报错——出现在模型自加 summary 使 store 非空之后的那个 turn，其后的反复换姿势重试直接喂大了该 turn 的失控循环。

## Decision

在全部四个条目投影输出 schema 中声明 `summary: { type: 'string' }`——`memory_search` 与 `memory_list` 的 `entries` 条目对象、`memory_get` 与 `memory_replace` 的 `entry` 对象——与既有的 `memory_add` 声明在名称、类型、位置上一致。投影不变：summary 仍在场即输出，声明的 schema 现在覆盖投影可输出的全部字段（`id`、`scope`、`content`、`summary`、`createdAt`、`updatedAt`、`category`、`projectName`、`stale`、`superseded`、`importance`、`accessCount`）。

## Testing

`tests/tools.spec.ts` 新增 `output schema covers the entry projection`：用一个携带全部投影可选字段的种入条目，把四个工具逐一驱动过真实 ToolRuntime，断言调用成功且返回值携带 `summary`。该套件在未修复树上为红（每个用例 `isError: true`——与评测会话中失败的是同一个运行时校验），修复后为绿；全量 lane **949 passed | 6 skipped（955）**。seed 场景（prog109，`/tmp/eval-real-prog109-postfix.json`）的真模式重跑完成：standing hit 5/5、全部答案判 2/2、作答中不再出现工具失败字样。

## 曾考虑的替代方案

- **改为从投影中删掉 summary。** 否决：summary 是 index 模式 fence 指示模型经 `memory_get` 展开的摘要；为了迁就声明 bug 收窄读取面会降级所有读取表面。
- **放宽条目 schema 的 `additionalProperties`。** 否决：严格的结果校验正是抓住未声明 wire 字段的契约——本 bug 就是它的证明；放宽声明的 schema 会恰好噤声这一失败形态。
- **schema 与投影的结构等价测试。** 否决：`ctx.tools.schemas()` 只暴露 `name`/`description`/`parameters`，输出 schema 在那里拿不到；让工具跑过运行时自身的输出校验既更强也更简单。

## Consequences

- 真模型会话重新能读非空 store。修复前：seed 场景（预写 summary）第一次工具调用即失败；任何存过 summary 的会话从此读不了自己的记忆——只能靠常驻注入作答。
- 「一比四」的声明不对称（add 声明了 summary、四个读取工具没有）就此闭合。未来投影新增字段必须在每个能携带它的输出 schema 中声明，而全字段回归测试现在为投影字段集强制这一点。
- 修复前取得的 judged 基线读数带着降级的工具访问条件；[write-path rework 笔记](../architecture/2026-09-04-write-path-rework-implementation-plan.zh.md)中 2026-09-07 切片的每处引用都注明了该条件。
