# Agent Note: eval 的提示词捕获跟随 harness 的 system/message surface 事件

Status: implemented

[English](2026-09-09-eval-prompt-capture-follows-system-message.md) | 中文

## Problem

harness 把系统提示词改为 surface 第 0 号节点的重做（harness `.agents/notes/implemented/architecture/2026-09-02-system-prompt-as-surface-node.md`，2026-09-06 合入）把 `system` 从 `request/header` 事件里移除：`EpochHeader` 变为 `{config, adapterDefaults?, tools?}`，渲染后的提示词改由新的 `system/message` surface 事件承载。harness 自己的笔记承诺「期待该字段的读取方会在编译期失败」——对 harness 侧的类型化消费者成立，但 eval 套件读的是无类型 JSON-RPC 线上的会话事件流（`SessionEventPayload` 只有 `{type: string, data: Record<string, unknown>}`）：`collectSessionEvent` 的 `request/header` 分支从一个 cast 里读 `.system`，每一轮都静默拿到 `undefined`。

M0 链路冒烟以「no system prompt captured from turn 1 (request/header event missing)」失败——这条文案按旧契约写成，把诊断带偏了：事件本身到得好好的，只是载荷不再携带提示词。该失败已被证明是基线既有（在 `origin/main` 的独立 worktree 上逐字相同），插件本体全程健康——会话日志里 6400 字符的 `system/message` 事件中 `<memory-index>` 围栏完好无损。

## Decision

`collectSessionEvent`（`eval/harness/sdk-client.ts`）改为折入 `system/message`：turn collector 的 `systemPrompt` 取 `messageText(event.data.message)`——与 assistant 路径相同的提取。空 content 节点（harness 的「没有系统提示词」）读作空串而非缺失，boot 的 standing 回退才不会把一条已清空的提示词继续带下去。提示词不变时不发新事件（harness 仅在首次渲染时 append、变化时 replace 节点 0），因此 `eval/boot.ts` 既有的 `lastSystemPrompt` 回退——当初为「header 未变」而写——无需改代码即可跨未变轮次承接常驻提示词。

`HOST_CONTRACT.zh.md` 新增 §12——带出处的 SDK 会话事件缝——以及 §10 清单第 11 项：这条缝没有类型护栏，清单行（「跑 `npm run eval:smoke`」）是下一次事件面漂移的唯一防线。同一改动里，§11 的清单回指改回其对应项（第 10 项）；`AGENTS.md` 里漂移到 §9 的清单指针改指 §10。

## Testing

`npm run eval:smoke`：修复前红（在基线树上同样红），修复后绿——两轮都报告 6400 字符提示词（轮 1 来自事件，轮 2 来自 standing 回退），`<memory-index>` 围栏携带两条种子事实，dispose 后介质保留两条条目。vitest 套件不受影响（改动全部落在 `eval/`，没有任何 vitest 通道编译它）。

## Alternatives considered

- **同时读 `request/header.system` 与 `system/message` 以兼容旧版 harness。** 否：eval 驱动的是唯一一个已安装的 harness 构建仓——不存在需要支持的版本矩阵，而双读正是本次要移除的静默漂移形态。
- **按 harness 导出的事件 union 给会话事件载荷定型**，让契约变更在编译期炸出。否：冒烟跑的是本机构建的 harness checkout，而安装的 npm peer 可能滞后于它；用 `node_modules` 的编译期类型断言的版本未必是运行时匹配的版本。线界按设计保持无类型；§10 清单项是记录在案的缓解。
- **从请求上下文而非事件流捕获提示词。** 不可得：会话事件通知流是 eval 观察子进程的唯一窗口；请求内部构造不在 SDK 面上。

## Consequences

- M0 冒烟与所有读 `TurnResult.systemPrompt` 的 eval 机械指标（围栏解析、standing 命中记账、index 覆盖率）由这一个捕获点整体恢复。
- 失败文案现在指向现行契约（「system/message event missing」），下一次漂移会在断言处直接失败，而不是先误导一轮排查。
- harness 对任一事件形状的变更仍会在运行时静默抵达这条缝；记录在案的防线是 HOST_CONTRACT §10 第 11 项——每次 harness bump 都跑冒烟。
