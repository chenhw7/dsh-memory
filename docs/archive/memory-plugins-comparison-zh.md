# DSH 记忆插件横向对比分析报告

> **已归档（2026-08-27）**：P0 七项与 P1 八项已全部落地（v0.5.0）。本文保留作决策依据与借鉴来源记录；当前实现状态见 [../TECH_DESIGN.zh-CN.md](../TECH_DESIGN.zh-CN.md)。
>
> 分析对象：`~/dsh-memory-reference-project` 下的 `dsh-agent-memory`、`dsh-memory`（@max-null 版）、`dsh-memory-evolve`，对比当前项目 `/home/chenhw7/dsh-memory`（@chenhw7/dsh-memory v0.4.0）。
> 态度声明：三个参考项目实现路线差异极大，各有取舍；本文只提炼**可验证、附出处**的借鉴点，同时如实指出它们的问题，不盲目移植。
>
> 修订记录（2026-08-25 复审）：本次复审做了两件事——① 以成熟 agent 记忆系统（ZCode 等）的通行设计标准为坐标系，给各维度判断补上"为什么算好/坏"的判据；② 逐条复核文中承重断言（行数、注释原文、默认值），修正了若干自评数字，并纠正一处被总览表掩盖的事实：**当前项目默认注入档位不注入任何条目内容**。落地清单的优先级随之调整。

---

## 一、四项目总览

| | 当前项目 @chenhw7/dsh-memory | dsh-agent-memory | dsh-memory (@max-null) | dsh-memory-evolve |
|---|---|---|---|---|
| 规模（宿主端） | ~8100 行 TS | ~2540 行 TS | ~1090 行 TS | ~18000 行宿主 JS + ~15000 行客户端 TS |
| 存储介质 | dsh-storage-domain KV（memory.json，zod 校验） | dsh-storage-domain KV（domain `agent_memory`） | dsh-storage-domain KV（global + 每 cwd 一个 project backend） | **纯文本 .md 文件**，`\n§\n` 分隔，零依赖（node:fs） |
| 分层模型 | global / project / user 三 scope + category 标签 | global + 每 workspace；fact/knowledge/episodic/summary 四层 + **时间桶懒压缩** | global / project + **status(审核)×injected(注入) 正交双轴** | **五轨**：user 档案 / memory 全局事实 / key 项目关键记忆 / project 项目日志 / daily 今日日志（+归档第三级） |
| 检索 | 零依赖 BM25（CJK 单字+双字） | 标签过滤 + 关键词打分（tag3/title2/body1）+ 新鲜度 + `memory_browse` 时间桶浏览 | 零依赖 BM25（CJK 逐字） | 子串匹配（filter/since/until/recent/limit），无相关性排序 |
| 注入策略 | section@90 四档：**默认 policy-only 只注使用政策文本、零条目内容**（条目走工具检索）；full/自定义/index 档才注条目（同会话内冻结快照，KV-cache 稳定）+ 可选 step 级 auto recall（尾部 fence，不动系统提示词，默认关）。预算全为字符口径（快照 5000 字符 / fence 1200 字符·≤5 条），无条数上限、无 token 口径 | pre-step 首步插消息：常驻层+概要层+近期明细，双预算（20 条/3000B） | section（稳定指引）+ context（memory:self 自述 + global approved+injected 全量，**无预算**） | systemPrompt.context 尾部快照，**只注低频轨**（user/memory/key），project/daily 用固定提示行代替 |
| 自动提取 | projection 累积器（记住意图/纠正/失败连胜）→ LLM 抽取 + 两段式去重 + janitor + curator，全程宿主事件驱动（**不依赖模型自觉**） | compaction 事件 firehose → checkpoint 原文存 episodic；懒压缩链；通道 B 未实现 | 无自动提取（砍掉 Learner），"整理记忆"=固定 prompt 开新会话（人在环上） | **提示词驱动**：每回合收尾写 project/daily、按重要性建议 key；回合计数到期 → 模型在自己回合内审查（不派子代理，信息零损耗） |
| 写入治理 | session 级预算 + 安全扫描（写入+加载双闸门）+ 两级衰减（project 硬删 / global·user 打 staleSince 隐藏出注入面、保留可搜索）；**但提取准入规则无"repo 可推导内容"排除** | L1 key 覆盖 / L2 title 指纹合并 / max_entries 守卫只拦新建 | **模型永不自我提升**：写一律 suggested；update 后 status 重置回 suggested 需重新人工审核 | **AI 只提议、人确认**：suggest 队列（重复建议累计 hits 排序）+ 归档（第三级，可转正回主轨）+ read-before-write 技能保护 |
| 多人/跨设备共享 | 无 | 无 | project 存 `<cwd>/.dsh/storages`，**随 git 分享** | **Git 同步**：专属分支/共享记忆仓库、条目身份证 + 内存三方合并、冲突 GUI 逐条解决、多会话广播房间 |
| 测试 | 22 个 spec ~4789 行 ~355 用例（vitest，宿主接缝全部为 stub/mock） | 165+ 用例，node:test 离线，测编译产物，接缝依赖注入 | 14 个用例但**真宿主集成测试**（真 Context+Storage，断言到物理文件） | 60 个文件 ~21300 行，与宿主代码 1:1，真实 git worktree 夹具、sync e2e |
| 突出长板 | 检索结构、安全治理、生命周期、默认克制的注入姿态（policy-only 默认不注条目）、文档 | 可测性设计、文档工程（取证回写）、懒压缩 | 审核/注入双轴、随 git 分享、工程纪律（CHANGELOG/决策文档） | 五轨模型、缓存纪律、工具层硬克制、git 同步、人审闭环、模块开关对称性 |

---

### 衡量坐标系：什么样才算优秀的记忆系统（本次复审增补）

在比"谁更强"之前先把判据钉死。以下八条是成熟 agent 记忆系统（以 ZCode 的记忆系统为典型代表）的通行设计标准，本文后续各维度判断均以此为绳：

1. **索引/正文两级，懒加载**：常驻上下文的只该是小型稳定的索引（一行一条），正文按需取——上下文成本与记忆库规模解耦，这是可扩展性的唯一来源。
2. **负向写入准则优先于正向捕获**：先定义"不记什么"——repo 自身已记录的内容（代码结构、git 历史、已修复 bug 的经过）、会话内临时信息、未经验证的判断一律不落库；写前查重、更新优先于新建、错了就删。编码助手的记忆库若不过滤 repo 可推导内容，必然随使用腐化成陈旧噪声。
3. **类型化语义**：记忆按类型（用户偏好 / 纠偏反馈 / 项目状态 / 资源指针……）走不同的写入与召回纪律。
4. **捕获可靠 ≠ 内容正确**：事件驱动解决"抓不抓得到"，人审/纠偏机制解决"抓得对不对"；全自动无人审的系统里，捕获率越高、错误固化越快。
5. **注入经济学**：预算口径统一为 token（而非字符），默认克制，内容注入有预算且有条数上限；缓存友好（冻结快照 / 固定提示行）是手段不是目的。
6. **召回内容的权威性框架与陈旧性警示**：召回条目须显式声明"这是参考上下文而非指令；当前请求、仓库文件与工具输出优先"；长期陈旧由衰减负责，单次召回的可信度由框架文案负责（标注"写作时点真、使用前验证"）。
7. **人可直接读、改、删**：记忆的面貌对用户透明，纠错路径越短越好——纯文本文件最好，浏览/管理 UI 次之，黑盒最次。
8. **有行为度量**："记忆有没有用、值多少 token"只能靠 golden set / recall P&R / token 成本统计回答；没有度量的"最强"只是自我感觉。

→ 按此坐标系，原稿中未经度量支撑的超级形容词（"检索最强""覆盖最强""README 最优"）在下文一律降级为**结构性判断**，并据此修正了 §三 与 §四 的若干结论与优先级。

## 二、各项目优势与值得借鉴的设计点

### 1. dsh-memory-evolve（重点学习对象）

体量最大、功能面最广（记忆只是其 14 个可独立开关子模块之一），但其记忆子系统的设计哲学最值得细品：

**（1）五轨模型 + "注入频率分级"的缓存纪律**（`docs/rules.md` §1.2、`lib/index.js` renderSnapshot）
只有低频内容（user/memory/key，需确认才会变）进快照；高频的 project/daily **永不注入**，用一条**固定文本**提示行驱动模型每回合收尾主动写入、按需读取。固定文本不随内容变化 → 不产生新快照 → 前缀缓存稳定。
→ 对比：当前项目用"冻结快照 + 可选 auto recall fence"解决同一问题，思路等价且更精细（段级冻结）；但 evolve 的"高频轨干脆不注入、用行为指令替代内容注入"是一个更省 token 的极端做法，且其"写回复文本在先、工具调用在后"的提示词条例（rules.md §1.1）值得我们的 flush/review 提示词借鉴。

**（2）程序盖戳、剥夺模型手写元数据的权利**（`lib/store.js` stampEntry）
时间戳、项目标签、git 分支 tag 全部由程序生成；模型手写的 `[日期]`/`[git …]` 前缀一律被剥离重盖。
→ 当前项目由提取管线写 createdAt/updatedAt，方向一致；但 evolve 把"模型幻觉日期"作为显式设计风险处理（含 key 注入时附带当前分支名），这比"信任 LLM 输出的时间"更稳。

**（3）drift guard（往返校验拒绝重写）**（`lib/store.js` isCanonical）
当文件内容无法被解析器无损往返（手改、shell 追加、兄弟进程写入）时，replace/remove 拒绝整体重写，先把漂移文件备份为 `.bak.<ts>` 再报错；add 则跳过校验（追加永远安全）。配合跨进程锁 + stale 锁 pid 存活探测。
→ 当前项目 KV 后端由宿主管理，天然无此问题；这个模式对"任何可被外部编辑的文本产物"（如我们的 notes 文件 `docs/agent-memory/*.md`）有借鉴意义——当前 notes 是整体重写的，若用户手改了文件会被静默覆盖，可以考虑类似的往返校验/托管块（AGENTS.md 指针块已有此模式，可推广）。

**（4）条目身份证 + 内存三方合并的 Git 记忆同步**（`docs/记忆同步.md`、`lib/sync/*`）
- 项目身份 = git remote URL 归一化（双设备"自动认亲"）；
- 每项目一条专属分支 `dsh-shared/<projectId>` 或共享记忆仓库命名空间分支，四轨独立开关（全局记忆/用户档案/每日日志/待办）；
- 合并不跑 `git merge`：按条目 `[id:xxxx]`（老条目按内容哈希**确定性补发**，双设备同内容同 ID）做联合索引三方合并，只有"双侧都改同一条"才进人工 GUI（ours/theirs/both）；冲突符号永不落盘；
- 推送永远显式触发、网络操作在独立子进程、`.gitattributes * -text` 防 CRLF 破坏分隔符。
→ 这是回答"多人共享记忆"最完整的参考实现。**当前项目完全无跨设备/多人能力**，notes 文件虽然进 git 但合并冲突会原样出现且无条目级对齐锚点。若做共享，evolve 的"正文本机正本 + git 只对账 + 条目 ID 对齐"是最稳的路线。

**（5）"AI 只提议、人确认"的全链路闭环**（`docs/rules.md` §4、`lib/review.js`）
suggest 队列（`SUGGESTIONS.jsonl`，同内容重复建议只累计 hits 并置顶——**频率即信号**）、采纳前可编辑、归档第三级（不够格但舍不得删 → archive.md，可转正、被再次建议时自动唤醒）、`auto` 直写模式默认关。
→ 当前项目的提取管线是全自动落库 + 扫描器/去重把门，缺"人审"这一层。可以借鉴"建议队列 + hits 累计"，把 review 产出先落队列、由设置 UI 的 Memory section 呈现待确认列表——UI 侧我们有现成的 settings section 通道，改起来比 evolve 从零造 Tab 容易得多。

**（6）工具层硬克制代替提示词软约束**（`lib/todo.js`、`lib/index.js` memory list）
`dtodo list` 默认只返回"逾期+今日+本项目+Q1Q2 未完成 ≤8 条"，全量要显式 `all=true`；`memory list` 大日志轨默认"最近 50 条 + total/earliest/latest 元数据"并在查不到时**提醒模型去掉过滤读全文核对**（旧格式条目不参与日期过滤但原样返回）。
→ 我们的 `memory_list` 有 limit 但没有这种"默认智能视图 + 元数据引导追问"的设计，值得加入。

**（7）key 渐进式披露**：条目多时只注入 `[id] 摘要`，模型 `memory expand id=…` 按需取全文。
→ 等价于我们 `memoryMode: 'index'` 的 index 渲染，但我们缺少配套的 `[summary:…]` 显式摘要 tag（evolve 是 add 时可选写入、注入时优先用），可以低成本补充。

**（8）模块开关 = 注册/注销对称**：每个子模块独立 `xxxCtrl.sync()`，关闭时工具从清单整体消失、数据保留可逆（源自"广播曾跟随 coiEnabled 拆不开"的真实事故）。
→ 我们已是 7 行独立插件（粒度更细），但"配置开关运行时切换注册"的对称性（如 auto recall 开关只是行为开关而非注册开关）可以到 evolve 这一层再审视。

**（9）外部执行器 `[dsh-only]` 过滤**：注入外部 CLI 的记忆自动剔除 DSH 专属条目（"外部执行器不是 DSH，不必遵循 DSH 纪律"）。
→ 当前项目没有外发记忆的场景，暂无对应物；若未来做 subagent/workflow 的记忆下发，这个 scope∩audience 的正交过滤是好先例。

**evolve 的问题（不学）**：
- **核心可靠性押注提示词遵循**——每回合写日志、到期审查全靠模型"照做"，README 自认"救不了从不查"；当前项目用宿主事件驱动（accumulator/compaction/dispose）做提取，可靠性架构上**优于** evolve，这是我们的长板。
- append-only 快照堆积：每次确认写入追加一条尾部消息，旧快照永久占位；我们的冻结快照 + 段级重建没有这个问题。
- `lib/index.js` 2211 行上帝模块，15+ 模块手工编排；i18n 1288 行巨型字典；单条大正则 ENTRY_HEAD_RE 解析全部元数据（新增 tag 要同步改 6+ 处）。工程结构上我们更优（7 个独立导出子包、单一职责）。
- 宿主端纯 JS + JSDoc（非 TS），纯字符串条目格式可编程性差（不能结构化查询/索引）。
- advisor（~4000 行）与 update（~879 行）相对默认关闭/简单需求而言过度设计。

### 2. dsh-agent-memory

小而精（2540 行），**工程方法论最值得学**：

- **可测性是第一公民**：`KvLike`/`SummarizeFn`/`SessionCwdCarrier` 鸭子类型接缝、纯函数与 IO 彻底分离、mock 全是十几行内存实现；165+ 离线用例测编译产物；鸭子类型读宿主字段（`agent?.session?.header?.cwd`）免疫宿主类型漂移。
- **时间桶懒压缩分层**：episodic 按 day/week/month/year 桶，访问时（而非 cron）扫描"有原料且无概要"的桶触发压缩，幂等可重放，久未活跃项目首访一次性补齐——比"每 N 会话跑一次 curator"（我们现在的做法）更贴合使用频率。
- **fact/knowledge 去重写入语义**：L1 按 `(scope,key)` 精确覆盖；L2/L3 按 title FNV-1a 指纹自动合并（标签并集+正文追加），三态返回 created/updated/merged；max_entries 守卫只拦新建不拦更新。
- **双入口检索**：`memory_recall`（知道找什么）+ `memory_browse`（时间桶分组分页浏览，承担语义导航）。
- **文档工程纪律**：DESIGN.md（意图）/IMPLEMENTATION.md（唯一契约，每条宿主 API 结论附官方源码 文件:行号 "取证回写"）/README（用法）三层分离；测试注释带日期化决策记录。
- 配置走 `.dsh/memory.yml` per-project 文件 + **fail loud + 未知键拒绝**——拼错配置不会被默认值掩盖。
- LLM 调用纪律：三级路由回退（配置→会话 requestHeader→fail loud），fail closed 终结映射，拒绝图像输出。

**问题（不学）**：通道 B 信号沉淀和 bootstrap 完全未实现（`memory_check` 是空壳、auto_sink 是死配置——文档与实现漂移）；O(N) 全表扫描；无中文分词；调试残渣入库（HMR probe console.log、硬编码版本字符串）。

### 3. dsh-memory（@max-null 参考版）

最小（1090 行）但有**两个当前项目没有的治理维度**：

- **审核轴 × 注入轴正交**（`suggested/approved` × `injected: bool`）：审核≠注入，"approved 但未注入"是常态（按需检索才用）。配合铁律：**模型写入永远落 suggested**（模型不能自我提升）；**update 后 status 重置回 suggested** 但 injected 保留——防模型静默改写已生效记忆，重审通过后原位恢复。
- **project 记忆存 `<cwd>/.dsh/storages/`**：随 git 进仓库、团队共享；多工作区按调用方会话 cwd 懒打开（djb2 hash backend 名防注册表冲突）。
- **读时迁移而非文件重写**：schema 保留旧枚举、读取时一次性 normalize，旧文件不动。
- **缓存纪律写成契约**：稳定内容走 section、会变的走 context（append-only），源自真实事故并记入设计文档。
- **注入预览面板**（字符/≈token 估算 + 实际注入条目清单）与 **memory:self 自述段**（让模型看得见机制本身）。
- **测试是真宿主集成测试**：真 Context+Storage+SystemPrompt，断言到物理文件、cwd 路由隔离（A 工作区搜不到 B）、外部编辑回归——用例少但每条都打要害。
- HTTP 面板自带信任围栏（loopback/trustedHosts/origin 校验/1MB 上限）。

**问题（不学）**：无时间衰减/新鲜度因子；recall 注入无预算（global approved+injected 全量每轮进 prompt）；工作区记忆永不常驻注入的妥协;JSON 文件全量读写无 watch；client.js 构建产物入库双源维护；文档与代码漂移（CHANGELOG 落后三个版本）。

---

## 三、与当前项目的逐维度对比结论

| 维度 | 谁更强 | 结论 |
|---|---|---|
| 检索质量 | **当前项目（结构性判断，未经度量——四家均无召回评测）** | 我们的 CJK 单字+双字 BM25 + pin 优先 + maxSearchResults 预算在结构上最完整。但做些反面提醒：CJK 单字切分在小语料上的精度未必优于 agent-memory 带中文停用词去噪（其 search.ts:76）的轻量方案，没有 golden set 无从裁决；evolve 无相关性排序是"低频轨条目少、靠过滤人工浏览"的取舍而非纯短板。可再补 browse（时间维度导航）；把"最强"变成数字的方法见 §四 P1-4。 |
| 自动提取可靠性 | **当前项目（仅就"捕获率"而言）** | 宿主事件驱动（accumulator + compaction/dispose flush + janitor），不赌模型遵循；evolve 的提示词驱动是其自认短板（rules.md:198"救不了从不查"）。但**捕获可靠 ≠ 内容正确**（坐标系标准 4）：高捕获率 + 全自动落库 + 无人审 = 错误抽取以高置信度固化成持久记忆，这一头必须靠治理层补齐（§四 P1-1）。evolve 的"审查由主 LLM 在自己回合内执行、信息零损耗"对我们有启发——可考虑把 review 从后台 drain 改为可选的回合内审查。 |
| 写入治理 | 参考项目更强；且我们有一个比人审更靠前的缺口 | 现状是扫描器+去重+预算"机器把门"，参考项目的"人把门"（suggest 队列/approval/injected 双轴）与之互补。但复核发现更基础的缺口：提取准入规则只挡 transient/未验证内容，**完全没有"repo 可推导内容"排除**（坐标系标准 2）——负向准则缺失，人审装得再严也拦不住源头噪声。两道门都要装：负向准则在前（§四 P0-1，一行规则），可选审核模式在后（§四 P1-1，产出落待确认队列、Memory section UI 呈现，采纳才注入）。 |
| 元数据可信度 | evolve 更强 | 程序盖戳 + 剥离模型手写即可引入（我们提示词里要求 LLM 不输出时间，但没在解析层剥离兜底）。 |
| 共享/同步 | evolve 完胜（当前项目空白） | 分两层吸收：① 低成本——project scope 条目导出到 repo 内文件（我们 notes 已是 repo 内 md，可借鉴条目身份证便于 git 合并对齐）；② 高成本——git 同步对账，属大工程，建议等真实需求再做。**立项前置评估**：记忆离开本机进共享仓库后威胁模型改变（跨设备长历史、协作者可读），写入口的密钥扫描必须扩展到共享路径，否则共享反而放大泄漏面。 |
| 存储工程 | 当前项目（结构化 KV）vs evolve（纯文本）各有千秋 | 我们的 zod+storage-domain 可编程性/事务性更好；evolve 文本格式的外部可编辑性、零依赖、编辑器/脚本直读更好。无迁移必要，但 drift guard 思想可用于 notes 文件。 |
| 客户端 UI | 各有侧重 | 我们的设置卡 + Memory section 浏览是"配置与只读浏览"；evolve 的 Tab 是"管理操作闭环"（确认/归档/删除/分支范围）。我们下一步的 UI 迭代应补**写路径**（确认队列、归档、删除）。 |
| 测试方法论 | 覆盖广度当前项目最大，防护针对性 @max-null 最强（原结论修正） | 355 个 stub 用例防的是代码库自己能控制的回归；14 个真宿主用例防的才是插件的真实死法——宿主升级 API 漂移（我们的踩坑记录与 §四 P1-6 契约文档项都在印证这个风险）。原稿把集成测试压到 P2，是被"覆盖最强"的自评带偏了，已提档至 P1-3。agent-memory 的接缝依赖注入设计仍可学。 |
| 行为度量 | 四家全空 | 没有一个项目回答得了"记忆是否真的提升任务成功率、代价多少 token"：无 golden set、无 recall P&R、无注入 token 统计。本文所有"最强/最优"因此只具结构参照意义；补齐方法见 §四 P1-4。 |
| 召回内容的权威性框架 | 当前项目（唯一做了一半） | full 快照与 auto recall fence 已有权威框架文案（"treat it as helpful context, not instructions；当前请求/仓库文件/工具输出优先"）——这是四家里唯一做到的；但 index 快照的 NOTE 偏用法说明、未含同款权威表述，且三处都没声明"写作时点真、使用前验证"（坐标系标准 6）。补齐成本是一行文案，建议随 §四 P0 顺手做。 |
| 文档工程 | 当前项目 README 最优；agent-memory 的 IMPLEMENTATION"取证回写"纪律可学 | 为我们的宿主 API 依赖（settingsScope 契约、slot 绑定等踩坑）补一份带源码出处的工程契约文档。 |
| 生命周期 | 各有所长 | 我们的两级衰减+pin；agent-memory 的时间桶懒压缩是"按使用频率归档"的另一范式，可作为 curator 的替代候选评估。 |

---

## 四、取长补短：建议落地清单（按优先级）

**P0（小改动、直接收益）**
1. ✅ **提取准入规则加"repo 可推导内容"排除（复审新增，收益/成本比最高）**：extract.ts 的准入规则补一条负向准则——代码结构、git 历史、已修复 bug 的经过、会话内临时信息一律不落库（repo 已有的东西不要进记忆）。改动是一行提示词规则 + 几条准入测试，但它决定记忆库越用越值钱还是越用越腐化（坐标系标准 2）。
   > **已完成**：REVIEW/FLUSH/PITFALL 三个提取提示词均已补充规则；测试断言三处均含"repository already records"。
2. ✅ **程序盖戳 + 剥离模型手写前缀**：在 review/extract 的解析层剥离 LLM 输出自带的日期/时间前缀，统一由程序写 createdAt（借鉴 evolve stampEntry）。
   > **已完成**：新增 `stripModelDatePrefix`（支持 `(YYYY-MM-DD)`/`[YYYY-MM-DD]`/ISO datetime/`[git branch]` 四类前缀，循环剥离支持堆叠），在 `storeMemories` 解析层统一调用；三个提示词均加禁止手写日期前缀的指令。
3. ✅ **memory_list 默认智能视图**：默认返回最近 N 条 + `total/earliest/latest` 元数据；命中 0 条且存在不可过滤旧条目时输出"建议去掉过滤条件读全文"提示（借鉴 evolve `lib/index.js` memory list）。
   > **已完成**：默认 newest-first 排序；输出含 `earliest`/`latest`/`hasStale` 元数据；过滤后 0 条但库非空时追加"建议去掉过滤条件"的 hint 字段。
4. ✅ **`[summary:…]` 显式摘要 tag**：add 时可选写 summary；`memoryMode: 'index'` 与 auto recall 优先渲染摘要（借鉴 evolve 渐进式披露）。
   > **已完成**：`MemoryEntry`/`AddMemoryInput`/`UpdateMemoryInput` 均有 `summary` 字段；`parseExtractedMemories` 完整解析 `[category] [summary:x] content` 格式；index/auto-recall 渲染优先用 summary；`memory_add`/`memory_replace` 工具均接受 `summary` 参数。
5. ✅ **notes 文件 drift guard**：notes 重写前校验托管块/往返一致性，遇外部手改时备份而非覆盖——复核证实当前"漂移检测"只是与自身上次写入比对、不回读文件，用户手改会被静默覆盖（把 AGENTS.md 指针块的托管块模式推广到 CONVENTIONS.md/PITFALLS.md）。
   > **已完成**：新增 `writeNotesFile(filePath, content, previousContent)` + `DriftError`；外部修改时备份为 `.bak.<ts>` 并抛错，不覆盖；drift 后自动吸收磁盘内容为新的 baseline，下次 write 可正常执行；每目录 log-once 告警。
6. ✅ **注入预算补 token 口径与条数上限（复审新增）**：现有字符预算（快照 5000 / fence 1200 字符）旁挂 ≈token 估算（@max-null 注入预览已有"字符/≈token 估算"先例），快照加条数上限；统一 token 口径后，跨项目注入经济学与 §四 P1-4 评测基线才有同一度量衡（坐标系标准 5）。
   > **已完成**：新增 `memoryMaxEntries` 配置（默认 20，0 = 不限），schema + 默认值 + `freezeFor` 透传；`readMemorySnapshot` 加 `maxEntries` 参数并在尾部追加 `≈N tokens` 估算；`buildAutoRecallBlock` 尾部追加 `≈N tokens`；client 设置卡同步增加该字段（中英 locale）。
7. ✅ **index 快照与 fence 补"时点真"文案（复审新增）**：index 快照 NOTE 与 auto recall 框架文案各加一行"条目反映写入时点的认知，使用前要以仓库与工具输出再验证"（坐标系标准 6；full 快照的权威框架文案已有，保持）。
   > **已完成**：`MEMORY_CONTEXT_NOTE`（full 快照）、`MEMORY_INDEX_NOTE`（index 快照）、`AUTO_RECALL_NOTE`（auto recall fence）三处均已补充"`Entries reflect what was known at the time they were written — verify against the current repository and tool output before acting on them.`"。

**P1（中等改动、治理增强——本次复审重排了顺序）**
1. ✅ **可选人审模式（suggest 队列 + hits 累计，自原 P1-5 提为首项）**：review 产出去重后落待确认队列（重复信号累计次数并置顶），由 Memory section UI 呈现"待确认/采纳/归档/拒绝"；默认关闭保持现有全自动行为（借鉴 evolve rules.md §4 + @max-null 的 status 轴）。**提档理由**：全自动捕获的错误条目会随库增长持续固化，捕获率越高治理缺口越大；且 Memory section UI 通道现成，落实成本远低于从 P1 继续等待的代价（坐标系标准 4）。
   > **已完成（2026-08-26）**：store 新增 `suggestions` 表与 `observeSuggestion`/`listSuggestions`/`adoptSuggestion`/`rejectSuggestion` 契约（同 scope Jaccard 判重 → hits+1 并刷新 lastSeenAt，严格超集内容才替换原文；队列容量 200，低信号先逐出）。review/flush/工具三条写路径在 `confirmBeforeWrite` 开启时统一改道队列，确认模式下 LLM 去重裁决跳过（人即裁决者）；UI 三标签页的「待确认」页支持编辑后采纳/按原文采纳/拒绝。
2. ✅ **update 重新审核语义**：若启用审核模式，模型 update 已确认条目后应重新进入待确认（借鉴 @max-null engine.ts update 重置 status——其 :373-376 注释"内容被模型改动后必须重新人工审核"与铁律"模型永不自我提升"逐字可引）。
   > **已完成（2026-08-26）**：确认模式下，提取去重命中既有条目时不再合并/改写，而是落一条带 `targetEntryId` 的更新提议（curator 改写同理），条目原文在人工采纳前分毫不动；采纳时以 source `'ui'` 走完整 store 契约（扫描 + 审计）。
3. ✅ **真宿主集成测试补层（自原 P2-10 提档）**：在现有 stub 单测之外，加 10 条左右真 Context+真 JSON storage 的集成用例，断言到物理文件与组装后的 system prompt（借鉴 @max-null 测试策略）。**提档理由**：宿主升级 API 漂移是本插件的真实死法，355 个 stub 用例拦不住它；与 P1-6 契约文档成对落地。
   > **已完成（2026-08-26）**：新增 `tests/integration/host.spec.ts` 13 条用例——真实 cordis 组合（Storage hub + storage-json + storage-domain + 真实 SystemPrompt 注册表 + ToolRuntime + Typert remote service）跑通 full/policy-only/index 三档组装断言、memory_add/search/update/remove/janitor/archive 到 memory.json 物理文件的落盘断言、remote 服务 add→list→update→removeEntry 往返落盘、建议队列 observe→adopt/reject 全链路落盘。全套测试现为 ~490 用例 / 27 文件。
4. ✅ **召回评测基线（复审新增）**：构造固定 fixture 记忆库 + "查询→预期命中表"的 golden set，度量 recall precision/recall 与注入 token 成本，作为一切检索改进（分词、权重、预算）先后对照的地基；同时把"检索质量谁更强"从口水变成数字（坐标系标准 8）。
   > **已完成（2026-08-26）**：新增 `src/benchmark`（24 条目 fixture × 24 条 en/zh golden 查询）与 `tests/recall-golden.spec.ts`。真实 BM25 首轮基线：success@5 = **100%**（zh/en 切片均 100%）、P@1 = 91.7%、MRR = 0.958；回归护栏写入 spec（success@5 ≥85%、MRR ≥0.75、P@1 ≥60%、zh ≥80%）。已知局限如实记录：零词法重叠的跨语言查询不承诺命中（需语义向量层，另立项）。
5. ✅ **browse/时间维度检索入口**：`memory_list` 增加按时间分桶浏览或 since/until 过滤（借鉴 agent-memory memory_browse + evolve since/until）。
   > **已完成（2026-08-26）**：`memory_list` 新增 `since`/`until` 参数（createdAt 毫秒边界、含端点），窗口内 newest-first 分页，`earliest/latest` 元数据随窗口收窄，空窗且库非空时提示放宽过滤；与 scope/projectName 过滤可组合。
6. ✅ **IMPLEMENTATION 契约文档**：记录本插件依赖的宿主 API 契约，每条附 harness 源码 文件:行号 出处（借鉴 agent-memory 取证回写纪律），降低 harness 升级时的回归成本。
   > **已完成（2026-08-26）**：`docs/HOST_CONTRACT.zh-CN.md`——存储域、settings 热更、system-prompt 注入、会话事件面（compaction/end 数据形状、agent/pre-step waterfall）、session-projection、LLM 调用纪律、Typert 远程服务与 /api 信任围栏、客户端 slot 八个板块逐条附出处，末尾附 harness bump 时的八项核对清单。
7. ✅ **记忆的可编辑性闭环（复审新增，坐标系标准 7）**：Memory section 二期把"只读浏览"补成"写路径闭环"——条目编辑/删除/归档操作（采纳前可编辑，借鉴 evolve 审阅面板的"编辑后采纳"）；编辑直接落 KV、notes 由渲染层重建，保持 store 单一真源。与 P1-1 待确认队列共用同一 UI 分区，是同一轮 UI 迭代的自然范围。
   > **已完成（2026-08-26）**：Manage 页每行新增 编辑（行内表单：content/category/summary）/置顶/归档（手动盖 staleSince 戳，与软衰减同一表示，注入隐藏但可搜索可复活）/两段式删除；remote 服务相应新增 `archive` 方法并给 `update` 补 summary 字段；全部操作失败行内报错且不清空列表；client jsdom 测试扩至 24 条覆盖各交互。
8. ✅ **index 模式转正评估（复审新增，坐标系标准 1）**：P0-4 summary tag 与 P0-6 条数上限/token 口径就位后，用 P1-4 评测基线对 policy-only / index / full 三档做召回准确率 × 注入 token 成本的对照实验，裁决 index 是否提为推荐默认档——让"两级结构"从配置面里的一项变成可辩护的默认行为，而不是拍脑袋换默认值。
   > **已完成（2026-08-26）**：`docs/INDEX_MODE_EVALUATION.zh-CN.md`。实测（24 条库存）：policy-only ≈344 token 恒定零条目；index ≈955 token 全覆盖 24/24 存在行；full ≈809 token 但已触发 20 条上限折叠至 20/24。**裁决：不改出厂默认**——golden set 只证明"能搜到"（success@5=100%），不能证明"会去搜"；policy-only 保持默认克制姿态，index 定位为文档中的推荐进阶档（库存大或观察到漏搜时升级），并附实测成本数字。

**P2（大工程、按真实需求立项）**
1. **project 记忆的 git 同步/团队共享**：条目身份证（内容确定性 ID）+ 三方合并 + 专属分支。先做"项目级导出导入 + ID 对齐"这一步可以拿到 80% 价值；完整 sync 对账请参考 evolve `lib/sync/`（repo/merge/entryid/identity 四件套共 ~2100 行，复杂度集中在身份与冲突 GUI）。**立项前置评估**：记忆离开本机进共享仓库后威胁模型改变（跨设备长历史、协作者可读），现有写入口密钥扫描必须扩展到共享路径，否则共享等于放大泄漏面。
2. ~~真宿主集成测试补层~~（已提档至 P1-3，✅ 已于 2026-08-26 落地）。

**明确不建议引入的**：advisor 旁挂评审员（投入产出差）；CoI 外部 CLI 调度（超出一个记忆插件的职责）；纯文本五轨存储全量替换现有 KV（收益不抵迁移成本）；提示词驱动的每回合强写（可靠性回归）。

### 坐标系 → 落地清单对照（防漏自检，复审新增）

| 衡量坐标系标准 | 当前项目现状 | 对应行动项 |
|---|---|---|
| 1. 索引/正文两级，懒加载 | 骨架已备（policy-only 默认零注入；index 档存在且 summary 链已补齐；无转正裁决） | ~~P0-4~~ ✅ ~~P0-6~~ ✅ ~~P1-8~~ ✅（裁决：默认不改，index 定位推荐进阶档） |
| 2. 负向写入准则 | ✅ 已补齐（三提示词均有 repo 可推导排除 + 负向准则） | ~~**P0-1**~~ ✅（去重管线已有，可承接） |
| 3. 类型化语义 | 已具备（scope×category 枚举） | —（达标，无需新项） |
| 4. 捕获 ≠ 正确 / 人审纠偏 | ✅ 已补齐（confirmBeforeWrite 待确认队列 + hits 累计 + 更新提议重审，UI「待确认」页闭环） | ~~P1-1、P1-2~~ ✅（UI 通道现成已兑现） |
| 5. 注入经济学 | 冻结快照/固定缓存纪律已具备；预算已补 ≈token 估算与条数上限 | ~~P0-6~~ ✅；冻结机制保持 |
| 6. 权威性与陈旧性框架 | ✅ full 快照/fence/index 三处均有权威+时点真文案 | ~~P0-7~~ ✅ |
| 7. 人可读改删 | ✅ 已补齐（Manage 页编辑/置顶/归档/删除写路径 + 待确认队列同区闭环） | ~~P1-7~~ ✅ |
| 8. 行为度量 | ✅ 基线落地（golden set：success@5=100%、MRR=0.958 入 CI 护栏；注入 token 成本三档实测）；线上"是否去搜"观测仍空缺 | ~~P1-4~~ ✅（漏搜触发率统计留待真实使用数据） |

→ 结论：八条标准里 **2/4/6/7 已补齐、8 的离线基线已落地**（线上触发率观测是唯一遗留，需真实使用数据），**1/5 达成且有实验背书**，全部行动项关闭。（P0-1…7 已于 2026-08-25 落地，commit `ff8df27`；P1-1…8 已于 2026-08-26 落地，commit `bf8ffdd`。）

---

## 五、一句话总结

当前项目的事实底座没有问题——事件驱动提取、检索结构、安全治理是真实长板，而默认 policy-only（零条目注入、条目全靠工具检索）恰好是四者中最接近成熟系统"索引常驻、内容按需"的克制姿态；但以衡量坐标系对照，距离优秀记忆系统的缺口不在更多结构，而在四道治理：**负向写入准则**（别把 repo 已有的东西记进记忆）、**人审纠偏闭环**（捕获可靠 ≠ 内容正确）、**召回内容的权威性与陈旧性框架**、以及**一套能回答"有没有用、值多少 token"的行为度量**。前三道在参考项目里有现成范式可直接借鉴，第四道四家是空白、谁先补上谁先拿到裁决权。按本次修订后的 P0→P2 清单执行即可——原结论的壳仍成立：无需架构级改动；但"当前项目已经领先"这句话，在度量落地之前只能当假设，不能当结论。

> **执行状态（2026-08-26 更新）**：P0 七项与 P1 八项已全部落地。四道治理中的三道（负向准则、人审闭环、权威性框架）已从"缺口"变为代码；第四道（行为度量）的离线基线也已建立——golden set 上 success@5 = 100%、MRR = 0.958，注入成本三档实测入册。"已经领先"如今有了第一批数字背书，但"会去搜"（线上 recall 触发率）仍待真实使用观测；下一站是 P2 共享同步，按需立项。
