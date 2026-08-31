# 文档标准

[English](AGENTS.md) | 中文

本文件定义 Cairn Markdown 语料的文档结构、分层与写作规则。落位与校验工作流用 [dsh-doc](../.agents/skills/dsh-doc/SKILL.md),必需覆盖面与编辑判断用 [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md),配对契约见[双语文档](i18n/README.zh.md)。

## 文档结构

这些规则适用于面向人的文档;[Agent Notes](../.agents/notes/README.zh.md) 不在其范围内。文档的主题与树中位置决定其范围:以恰当的详略描述自身主题,对子层级只讲目的、职责与高层行为;更低层的细节链接到其归属文档。reference 只对自己的主题穷尽。

范围内的每篇文档都归类为 tutorial 或 reference。Tutorial 沿有序路径到达一个结果,每步只引入该步所需的概念。Reference 定义一个查证范围与当前行为,不含教学序列。实质的 tutorial 与 reference 内容分开;哪部分占比小就在该节标注。

写作顺序:先在树中定位文档;设定其允许的详略;选定 tutorial 或 reference;tutorial 按前置与难度排序概念;把子层级该拥有的细节移走;用指向归属者的链接替代低层解释。

## 分层分类:每个事实只有一个家

每个事实都有一个家:职责所在的层级;在其他地方,链接过去。

| 层级 | 职责 | 不属于这里的内容 |
|---|---|---|
| 根 `AGENTS.md` | 常备指令:agent 每次会话都需要在上下文里的规则,每条一至三行,附指向其归属的链接 | 故事、完整示例、情境化流程、从链接的归属处复述的任何内容 |
| 根 `README.md` / `README.zh.md` | 面向用户的包契约:安装、更新、卸载、验证、配置、已知限制 | 生成目录、JSDoc 复述、其他包的关注点 |
| [docs/README.md](README.zh.md) | 文档索引:按用途映射每篇常备文档;持有语言约定 | 每篇文档超过一行的复述摘要 |
| [TECH_DESIGN.md](TECH_DESIGN.zh.md) | 完整技术参考:架构、数据模型、子系统、配置、安全、测试 | 决策理由(→ Agent Notes)、事件经过(→ archive) |
| [SEQUENCE_DIAGRAMS.md](SEQUENCE_DIAGRAMS.zh.md) | 流程与调用关系图 | TECH_DESIGN 拥有的散文内容 |
| [Agent Notes](../.agents/notes/README.zh.md) | 现行决策记录:为什么、放弃了什么、必需的验证 | 决策落地后的迁移计划与验收清单 |
| [archive/](archive/) | 为"为什么"保留的冻结规划与分析记录 | 当前行为;每篇归档文档的结果都活在代码与基线文档里 |
| 包 README(`README.md`) | 同一根包契约,在包根目录供 npm 使用 | 除链接外对 docs/ 内容的重复 |
| Skills(`.agents/skills/`) | 可复用工作流与专项决策标准 | 产品与运行时契约(→ docs 或源码) |
| `docs/i18n/` | 配对契约、翻译规则与术语表 | 逐篇文档的翻译备注 |

落位:理由 → Agent Notes;历史规划 → `archive/`;操作流程 → 所属基线文档;包契约 → README;常备指令 → 根 `AGENTS.md` 并附理由链接。

## 写作规则

- **记录当前状态,而非变更历史。** 常备散文避免"以前/现在/不再"、PR、commit 与 stack 位置;写活的机制。变更故事放进 commit、Agent Notes 或归档文档;后两者可引用已合并的 PR 与 issue 作为证据。
- **每个非平凡变更都在同一次 commit 中包含至少一篇 Agent Note。** 更新已有归属笔记或新增;仅机械/局部编辑豁免([范围](../.agents/notes/README.zh.md#when-to-write-one))。
- **一段一行**:用编辑器软换行。代码块、表格与列表结构保持原格式;代码注释遵守 linter 列宽。
- **配对同步更新**:配对文档的编辑在同一次术语引导的修改中更新对侧并重录 sidecar([契约](i18n/README.zh.md));`dsh-translate-docs` 保持仅限用户显式调用。
- **注释与 JSDoc 陈述完整契约,而非推理过程。** 保留行为、失败、时序、所有权、模态、异常、后果与非显然的定位;删除过程叙述、测试走读、评审分析与代码复述。细则见 [dsh-prose-standard](../.agents/skills/dsh-prose-standard/SKILL.md)。
- 直接书写:点名主语与事实。`seam` 仅用于定义过的能力缝;写确切的检查、类型、API、操作或行为,而不是隐喻式的 "gate"、"vocabulary"、"surface"。
- **中文单语文档保持中文**,遵循[语言约定](README.zh.md#conventions);当某篇中文单语文档日后需要英文对侧时,按[双语文档契约](i18n/README.zh.md)补成配对,而不是在一篇文件里混写两种语言。

## 预算

上限是护栏,不是缩减目标;这里的工作门禁是评审纪律与下列检查,不是预算跑批器。保持入口路径简短、每个事实一个家;当检索成本过高时按领域归属拆分文档。常备文档长到难以评审时,先把属于其他层级的内容移走,再压缩;拆分需要有领域归属者,不能只凭大小阈值。

## 反模式清单

在任何文档里猎取这些问题;[dsh-doc](../.agents/skills/dsh-doc/SKILL.md) 以审计方式执行此清单:

- 同一规则在多个家中出现。用特征短语 grep;保留一个家,其余改为链接。
- 讲历史或战功故事:"previously"、"now"、"no longer"、"used to"、"renamed"、"was moved"、PR 或 commit。陈述当前事实;需要时链接 Agent Note 或归档文档。
- 散文里的实现状态标注("已实现!"、"future: …")。状态会腐烂;代码与[文档索引](README.zh.md)持有状态。
- 手抄目录、JSDoc 或测试/文件清单,而源码才是权威。
- 推理过程:逐步实现叙述、显然分支的证明、被否决的本地备选。保留由此得出的契约或持久理由;删除推导路径。
- 段落墙:一段承载多条规则和括号插入语。拆开,或把细节降级到它的家。
- 强调膨胀:满篇加粗、大写或 "critically" 意味着没有任何东西突出。把强调留给改变行为的那个从句。
- `implemented/` Agent Notes 里的规格腔:"should"、迁移计划、验收清单。已实现的 Agent Note 描述"是什么",见 [implemented/AGENTS.md](../.agents/notes/implemented/AGENTS.md)。

## 用机器可查的链接做交叉引用,绝不用自由散文

用相对 Markdown 路径链接仓库引用,绝不用裸文件名或笔记编号。本仓库没有链接校验跑批器;评审与 [dsh-doc](../.agents/skills/dsh-doc/SKILL.md) 审计承担该校验:每个相对链接必须能从链接文件所在目录解析,进入 harness 仓库的交叉引用遵循 [notes 树引用约定](../.agents/notes/README.zh.md#layout-and-naming)。
