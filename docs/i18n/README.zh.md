# 双语文档

[English](README.md) | 中文

Cairn 的文档同时面向外部插件用户与维护者,纳入范围的文档以英文与简体中文双语维护、两种语言具有同等权威。本页定义本仓库的配对契约、sidecar 记录与适用范围;[translation-rules.md](translation-rules.md) 定义如何翻译;[terminology.md](terminology.md) 是术语的唯一权威来源。扩展的 [.agents/skills/dsh-translate-docs](../../.agents/skills/dsh-translate-docs/SKILL.md) 工作流仅在用户显式调用时运行。

## 配对契约

- **两种语言具有同等权威。** 文档可以先以任一语言撰写并评审,再据此更新对侧。两份文件互不隶属;约束它们的是"说的是同一件事"。
- **一对文档是同目录的三个兄弟文件。** 英文 `foo.md`、中文 `foo.zh.md`,以及一致性记录 `foo.i18n.yaml`。不设 locale 目录、不写中英交错的文件。一次变更绝不允许只提交一种语言而丢下另外两个文件。
- **一致性记录。** `foo.i18n.yaml` 保存两侧最后一次确认"说的是同一件事"时的完整 git blob hash:

  ```yaml
  foo.md: 3f786850e387550fdab836ed7e6dc881de23001b
  foo.zh.md: 89e6c98d92887913cadf06b2adb97f26cde4849b
  ```

  用 blob hash 而非 commit hash,这样同一次变更中编辑的文件也能用 `git hash-object foo.md` 现算。上游 harness 的门禁与合并驱动不在本仓库运行;本仓库按 [notes 树适配说明](../../.agents/notes/README.zh.md#adaptations-in-this-repository)记录的方式手工执行同样的纪律。把一对文档改回一致后,用 `git hash-object` 重录两侧 hash 并提交 sidecar diff——这份 diff 就是"我确认两侧一致"的可评审动作。失步的配对按编辑侧的 diff 对对侧做最小修补来更新——绝不整篇重译。
- **语言切换器。** 中文文件在 H1 标题之后紧跟 `[English](foo.md) | 中文`;英文文件对应地写 `English | [中文](foo.zh.md)`。
- **结构互为镜像。** 标题层级与顺序、列表种类、有序列表起始号、列表项数、表格行列数、逐字节代码块在两侧一一对齐。相对文档链接指向现行双语语料时,英文侧用 `.md` 路径、中文侧用 `.zh.md` 路径;语料内缺失对侧文件按配对完整性错误处理,而不是回退;语料外的目标保留原路径。

## 适用范围

现行双语配对恰为:

| 配对 | 读者 |
|---|---|
| 根 `README.md` / `README.zh.md` | 插件用户与 npm 页面 |
| `docs/README.md` / `docs/README.zh.md` | 文档索引 |
| `docs/TECH_DESIGN.md` / `docs/TECH_DESIGN.zh.md` | 外部集成者与维护者 |
| `docs/SEQUENCE_DIAGRAMS.md` / `docs/SEQUENCE_DIAGRAMS.zh.md` | 追踪流程的外部集成者 |

`docs/` 下其余文档按[文档索引约定](../README.zh.md#conventions)为中文单语——这是单人维护仓库的有意成本取舍,不是待修复的疏漏。外部读者会阅读的新文档应加入上表;不要悄悄为一篇文档配对。`docs/archive/**` 是冻结记录:仅当配对约定本身变更时才重命名其 sidecar,永不重译。任何配对文件的重命名都在同一次变更中更新切换器链接、全部入站引用与 sidecar。

## 手工执行契约

1. 编辑一侧。
2. 对对侧做最小修补:命题相同、套用[术语表](terminology.md)、代码块逐字节一致。
3. 重录 sidecar:`git hash-object foo.md foo.zh.md`,把两个 hash 写进 `foo.i18n.yaml`。
4. 目视校验结构——标题列表、代码围栏、表格形状——并对照[术语表](terminology.md)校验术语。

完整流程见 [translation-rules.md](translation-rules.md)。
