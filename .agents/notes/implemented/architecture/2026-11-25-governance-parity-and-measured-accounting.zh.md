# Agent Note: 治理对等、可测量的记账与面板诊断

Status: implemented

[English](2026-11-25-governance-parity-and-measured-accounting.md) | 中文

## 问题

三个缺陷同一个形状：看着已经完成，实际做的事比它声称的少。

1. **助手对「记住」点头，却不写。** 注入的 `<memory-policy>` 教会了检索与作用域路由，却从没说过要*写*；而自动提取只在累积到十个候选时才跑。于是新会话里一句「记住我叫X」只产生一个永远不越线的候选：什么都没存下，也没有任何地方报告这件事。我自己的复现确认写入路径本身是健康的（`memory_add` 落库、清单围栏随即出现）——洞在指引与门控两处。
2. **`confirmBeforeWrite` 只管写入。** 新增与编辑会排队成提议，而 `memory_remove`、`memory_forget`、`memory_pin`、`memory_unpin` 当场就改了存储。这个设置的承诺是「没有人点头就没有变更」，实际只覆盖了无害的一半，模型可以删掉人类本想保留的条目。
3. **在真正需要可观测的地方，插件是不可观测的。** 读取路径（检索、注入、提取调用、使用命中）不写审计行，于是每轮都在被检索的存储，在仪表盘上看起来闲置；而审计表的 200 行上限被 `markHits` 占满——读操作以内容未变的 `update` 记录写入——把真实的变更挤出表外。

## 决策

**由 policy 明确要求写入，且一次明确请求就足以提取。** `MEMORY_POLICY_TEXT` 现在写明「写入是工作的一部分」：遇到明确的记住请求或陈述的长期偏好/更正，在**同一轮**调用 `memory_add`/`memory_replace`，一条事实一个条目，先检索再替换而不是堆叠重复。累加器把明确的记住请求标为 `strong`，drain 在 `unprocessed.length >= 阈值` **或有任一候选为 strong** 时触发；偏好与更正仍受阈值约束。信号库补上了缺失的中间层：`preference` 类（我喜欢 / 我习惯 / 一律用 / I prefer / always use / our convention）——偏好最常见的入口；以及那些针对具体陈述的更正措辞（`不是…而是`、`改成`、`instead of`）。

**更正带着它更正的对象。** 投影状态保留最近一条助手消息正文（≤300 字符），作为 `context` 挂到更正候选上；review prompt 以 `revises assistant: …` 引用它，系统提示要求提取被更正后的事实、绝不提取被取代的那个。「不对，用 pnpm」离开那一轮是无法解读的——否则模型只看到一个否定，得靠猜。

**每条提议携带 `action`，采纳时按它分派。** `SuggestionAction` 为 `add | update | remove | pin | unpin`；缺失即旧的推断规则（有目标为 `update`，否则 `add`）。`DomainMemoryStore` 与 `SqliteMemoryStore` 均持久化 `action`（SQLite 在打开旧表时补齐该列），并按 `(targetEntryId, effectiveAction)` 对指向同条目的提议去重，避免删除与编辑互相吞并。`adoptSuggestion` 施加 action 指名的 store 操作，于是生命周期动词与写入共用同一队列、同一条 `source: 'ui'` 审计路径（`remove` 接受可选 `source`）、同一道人类门禁；`suggestAdopt` 确认队列行被消费后对生命周期提议返回 `found: true`。工具面在 `confirmBeforeWrite` 打开时把 `memory_remove`、`memory_forget`、`memory_pin`、`memory_unpin` 走 `observeSuggestion`（对目标正文先做 `redactBlocked`，使命中扫描器的存量条目仍可提议删除）并回报 `pending: true`；按主题批量删除会变成每个命中条目一条删除提议，仍受批量上限约束。

**预算按实际发生的调用记账。** `hasBudget` 是纯预检；`chargeBudget(session, calls)` 在运行报告自己的 `ExtractionRunStats.llmCalls` 之后执行，计数点在每处缝隙（两次 review 提示、flush 提示、整合 pass、legacy 逐对裁决）。瞬态失败不再扣费，需要裁决的运行按真实成本扣费，取代旧的「每触发一次算一个单位」估算。

**读活动被计数，而非被审计。** `reportMetric(site, amount)` 与 `reportFailure` 并列（同样的 no-op 默认、同样的 fire-and-forget 纪律），喂给 `health().metrics`：`tool.search`、`tool.searchFallback`、`autoRecall.steps`/`hits`、`digest.emitted`、`extract.calls`、`usage.hits`、`flush.compaction`/`dispose`、`curator.passes`。`markHits` 不再追加审计行——命中既不改正文也不改状态，审计表的上限属于真实变更；既然命中不再占用，上限从 200 提到 500。

**衰减与淘汰共用一个活动时钟。** `lastActiveTimestamp`（`store/decay.ts`）取 `createdAt`、`updatedAt`、`lastRecalledAt`、`lastHitAt` 的最新值。旧实现只读 `lastRecalledAt ?? createdAt`，用户刚编辑过的条目会被判过期，也会比更安静的条目先被淘汰。

**面板补上缺失的诊断与写入口。** 概览新增操作计数与被吞掉的后台失败——「什么都没发生」与「有东西悄悄坏了」的区别。第四个 tab 展示变更轨迹，可按 `op` 与 `source` 筛选，首次打开才加载。管理新增新建表单，走宿主 `add` 同一条路径（扫描门禁、`source: 'ui'`、可选类别与摘要）。待确认行标注采纳会做什么，删除提议不会被误读成新增。

**两个存储上限移到 `store/limits.ts`。** SQLite 后端曾自带字面量 `200`，而 JSON 后端用常量；现在同一个模块持有两个数字，不会再漂移。

## 考虑过的替代方案

**只靠工具描述、不改注入 policy。** 被复现否决：工具全程注册可用，模型仍旧只回了一句散文。要求「必须写」的指引属于始终注入的 policy，而不是模型可能根本不读的描述。

**每个信号都触发提取。** 否决：每条消息一次 LLM 调用正是阈值要约束的成本。强弱分档让普通闲聊维持低成本的漏斗，同时让明确请求立即生效。

**在 confirm 模式下直接拒绝破坏性动词。** 否决：拒绝只告诉模型「不行」，不告诉人类「有人请求过」，而这份请求正是审核者需要看到的。删除提议携带该条目正文，采纳因此是知情决定。

**用模块级计数器统计 LLM 调用。** 否决：两个会话并发 drain 会互相错认调用。计数器随运行一起传递，按构造即为每次运行独立。

**把命中留在审计表里、只提高上限。** 否决：那是放大噪音而不是消除它。命中是读取信号，审计表的职责是带前后正文的变更。

**给新建表单加确认弹窗。** 否决：表单是人对自己界面的操作，扫描器与队列已经把风险拦在前面。多一次点击只会教人一路点过。

## 后果

- 让助手记住某事，现在会在那一轮就写下来；一次明确请求本身就触发提取，更正入库的是被更正后的事实。
- `confirmBeforeWrite` 终于在整个工具面上兑现承诺。两点要预期：模型发起的删除现在需要人点头；队列可以承载非内容类提议（行内渲染目标条目正文）。
- 仪表盘能区分「活动」与「变更」，静默的后台失败会自报名字。
- `markHits` 不再增长审计表；已有安装保留旧的命中记录，直到上限把它们裁掉（无迁移）。
- 衰减与淘汰对「最近」的理解一致，被编辑或被回应的条目能活过自己的窗口。
- 成本：policy 块多了约 5 行注入文本（≈60 tokens），每条提议多一个可选字段，客户端多了两个 RPC（`add`、`auditLog`）与两个新请求字段。

## 测试

`npm run build` 绿；`npm run test` **1136 通过 / 6 跳过**（`judge-real-api` 无 `DEEPSEEK_API_KEY` 时自跳过）。新增覆盖：`tests/decay-clock.spec.ts`（活动时钟、衰减与淘汰顺序）、`tests/tools-confirm-and-window.spec.ts` 的治理对等块（remove/forget/pin/unpin 在两种设置下的排队、含违规内容条目的脱敏删除提议与直接变更）、`tests/suggestions.spec.ts`（`(targetEntryId, action)` 去重隔离、`'ui'` 删除审计与 SQLite 列迁移）、`tests/remote-service.spec.ts`（`suggestAdopt` 生命周期往返与 UI 删除审计）、`tests/review-hot-reload.spec.ts` 的 drain/预算块（一个 strong 候选在阈值下触发、弱候选等待、两次调用扣两单位、失败调用不扣）、`tests/accumulator.spec.ts` 的信号类块（强度、偏好类、更正上下文），以及 `tests/memory-section.client.spec.tsx` 的 jsdom 追加（计数与失败面板、审计 tab 加载/筛选/变更刷新与竞态保护、生命周期提议禁编辑、新建表单写入与服务端拒绝透传）。真机：一个携带本 bundle 的隔离 `dsh web` profile 在无头 Chrome 里渲染出第四个 tab、计数、审计筛选，并经表单真实写入一条条目。
