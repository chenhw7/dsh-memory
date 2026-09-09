# Agent Note: Memory injection goes digest-first — one-time inventory at the step tail, data sections ordered by volatility

Status: implemented

[English](2026-09-09-memory-digest-first-fence-and-volatility-ordering.md) | 中文

本笔记**改写而非推翻**[index 默认档晋升](2026-09-01-index-default-promotion.zh.md)。那次晋升保护的价值——模型无需先"猜记忆可能存在"就知道库里*有*东西——由一次性清单的类目计数与 anchors 主题词继承。被削掉的是每条 80 字符的存在明细行与它们在冻结前缀里的常驻：存在性感知的成本从随 store 增长的常驻段落，变为每会话一次、约 126–250 token 的消息。

## Problem

index 默认档把整个 store 的存在行驻留在冻结的 system-prompt 前缀里——数据语域的内容停在离提问最远的位置，每次 compaction 重冻结都作废前缀尾部，且无论当轮是否相关都要按轮付费。对 OpenClaw 源码的调查（`~/openclaw`，已记录的取证基础）确立三条 index 形默认所违背的原则：

1. **指令语域驻留稳定前缀，数据语域不驻留。** OpenClaw 的 system prompt 只把记忆行为规则作为工具契约指令携带（"Mandatory recall step: semantically search … before answering questions about prior work, …"——`extensions/memory-core/src/memory-tool-contract.ts:93`）；全库内容靠检索触达。常驻的 MEMORY.md 是按召回信号晋升的精选集，不是目录。
2. **易变内容按易变度降序排到提示词尾部。** `src/agents/system-prompt.ts:87` 的 `CONTEXT_FILE_ORDER` 把自己最常改写的 MEMORY.md 排在最后、贴着 cache boundary——变更只花费缓存前缀的尾部。
3. **截断降级为检索指引。** 截断警告明说 "Treat Project Context as partial and read the relevant files directly if details seem missing"（`src/agents/bootstrap-budget.ts:219`）——丢失变成一条指令，而不是一句脚注。

两项实测缺陷进一步坐实问题：三个段落构建器先拼完整围栏再整段切片，超预算时吞掉自己的闭合标签（被截断的 `<project-notes>` 把其后的宿主工具指引一并吞进围栏作用域）；单一 notes 预算让约定半区在真实 store 中把踩坑日志饿死到零。

## Decision

**`memoryMode` 默认 `digest`**（回滚 = 一个 live 设置字段：`memoryMode: 'index'`）。注入面按语域拆分：

- **冻结段落只承载指令。** digest 档的 `memory` 段 = policy 块 + digest 追加指引；共享的 `MEMORY_POLICY_TEXT` 保持模式中立，`policy-only` 档绝不声称未发生的注入。`full`/`index` 语义不变，降为显式选择。
- **数据走消息尾部。** 会话首个 pre-step 追加一条 `<memory-digest>` 消息——分项目/分作用域类目计数、anchors 主题词 `Topics:` 行、`[N entries; M stale hidden]` 尾注，预算 `memoryDigestCharLimit`（默认 800，0 = 关闭）。每会话标记仅在非空发射后置位（实时调大预算下一步即生效）；干净的 `compaction/end` 清除标记，重建后的前缀重新获知 store 现貌一次。清单是清单不是召回：不调 `markRecalled`、不触 hit ledger。notes 已渲染条目经快照同款 `isRenderedEntry` 谓词排除——零重复注入。
- **`autoRecallEnabled` 默认开**，作为清单的互补：清单回答*库里有什么*（一次），`<recalled-memory>` 围栏回答*具体说了什么*（每步、贴尾部）。围栏的搜索传 `recordRecall: false`，命中经 `markRecalled(ids, 'fence')` 盖**轻量档**戳：只刷新 `lastRecalledAt`、绝不递增 `accessCount`——`accessCount` 驱动 entriesCap 逐出，BM25 查询词的运气不得污染它。工具面保持全量盖章。
- **段落按易变度降序排位。** `memory` 90 → **6000**、`project-notes` 91 → **6001**——位于宿主工具指引（`SECTION_ORDERS`：TOOL_* 1000–2900、TOOLS_SDK 5000）之后、`DELIVERABLE_FILE_REFERENCES`（9000）之前；`soul`/`user-profile` 保持 80/81。compaction 重冻结改变 memory/notes 文本时只花费前缀尾部（HOST_CONTRACT §3 记录实测段序）。
- **截断闭合自己的围栏。** `soul` / `user-profile` / `project-notes` 三个构建器共享一个 `fenceWithin` 助手：预算是整段上限，助手预留围栏开销与截断脚注，先截正文，闭合标签留在围栏内。notes 脚注按检索提示降级（"notes are partial; use memory_search for the rest"）；soul/user 保持中性脚注（没有可指的读工具，不虚构）。
- **notes 预算按半区拆分**——`notesConventionsCharLimit`（1600）/ `notesPitfallsCharLimit`（800）——踩坑日志不再被饿死。预算应用挪进 `snapshotFor` 让 notes 模块的设置读取变成承重路径，暴露其潜在纤程缺陷（未注入纤程上的 `ctx.settings` 直访会抛错，服务此前静默按内置默认渲染）；该服务现经 settings-injected 纤程读取，即 identity 插件的模式。选择在冻结时刻逐条目进行，排序为置顶 → importance → `lastRecalledAt ?? updatedAt`；被挤出的条目折成分节计数行，绝不静默丢弃。已发布的 `notesCharLimit` 按弃用处理而非硬删：当它是唯一预算键时，经 `resolveNotesSettings` 按 60/40 派生两半区（schemastery 非严格对象对已移除键透传，存量文档仍可读到）。
- **anchors 成为 prompt 表面并得到双层防线。** 两个 store 后端的写路径对每个 anchor 过 `scanContent`，违规或空 anchor 静默丢弃——它们是派生 token，条目本体无损；清单构建器内逐 anchor 的 `redactBlocked` 是读取时第二层。顺带闭合 SQLite 后端 update 路径完全忽略 `input.anchors` 的缺口（现在与 domain 后端同持"缺省即保留 + 过滤"语义）。

## Alternatives considered

- **保持 `index` 默认。** 否决：它是前缀驻留的最坏情形——每条存在行整会话驻留，store 的增长按轮付费。它买到的存在性感知，恰是清单以一次性成本继承的东西。
- **`systemPrompt.context()` 动态通道（v1 方案）。** 随通道一并否决：它依赖无法对已安装 peer 取证的宿主投影语义（`RuntimeContextProjection`），且逐轮重冻结会给 KV-cache 新增失效路径。步尾消息不需要 `agent/pre-step` 之外任何宿主契约，而后者已有取证。
- **常驻索引逐轮重冻结。** 否决：与通道同等的失效成本，换来的是围栏本就按步交付的数据。
- **清单做成常驻段落。** 否决：那只是把驻留问题下移一层——计数与主题词随 store 一起变。
- **给清单记 hit ledger。** 否决：清单不是召回；把它的行记为候选命中，会让每个会话的作答把主题词回声进 `hitCount`。

## Consequences

- **常驻前缀：** digest 档段落在 golden 夹具上实测 434 ≈tokens（policy + 追加指引）、双预算 notes 段 466 ≈tokens——对照 index 档 1102 token 的常驻段——且两者整会话逐字节稳定（`tests/context-refresh.spec.ts` 直接断言）。一次性清单消息在 35 条夹具上约 126 ≈tokens（anchors 密集的库约 250）；表格可经 `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts` 重出。
- **召回信号三条后果，记录在案：**（1）hit ledger 的 standing 轮改为反映召回集——围栏发射时，其命中替换该轮的 standing ledger，作答只能回声它真实看到的内容；`hitSignalEnabled` 保持默认关，sweep 行为不变。（2）janitor 的衰减计时被词法围栏命中刷新（`lastRecalledAt`），仅碰巧匹配查询词的休眠条目可因此活得更久——按"近期被呈现过"为真而接受。（3）notes 排序的 `lastRecalledAt` 信号由这些围栏戳供给，碰巧匹配查询的约定会在 notes 预算中上浮——importance 与置顶仍排在它前面。
- **notes 预算冻结时应用：** 预算的实时修改于下一次 `session/created` / 干净 `compaction/end` 落地，而非逐次组装——组装侧 `fenceWithin` 上限是最终防线。卡片提示与 TECH_DESIGN §7.4 已声明。
- **`notesCharLimit` 弃用：** 该键随 v0.9.1 发布，故降级而非删除——旧键为唯一预算键时 resolver 按 60/40 派生；每设置一个新键即接管对应半区。面向用户的迁移说明在 README 设置迁移小节。
- **anchors 覆盖偏差：** 无 anchors 的条目只贡献计数、不贡献主题词，anchor 稀疏的库会得到较稀疏的 `Topics:` 行（高 IDF content token 兜底记为将来选项）。防线从"anchors 永不进 prompt"反转为"写时扫描 + 读时脱敏"，与 content/summary 先例一致。
- **跨进程边界，未变：** 清单与所有注入面一样读进程内 store 视图——第二个写入方的条目在其下一次冻结/步进才可见，不会更早。
- **回滚是一个 live 字段**（`memoryMode: 'index'`），围栏默认可独立回退（`autoRecallEnabled: false`）而不动清单。
