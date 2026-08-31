# Cairn · 文档索引

`@chenhw7/dsh-memory` 的文档索引。English: [README.md](./README.md).

文档按生命周期分两层：本层的**当前基线**（活文档），以及 [`archive/`](./archive/) 中的**历史决策记录**。

## 当前基线

描述当前系统如何工作、以及持续维护所需的活文档。每次发布时与代码保持同步。

| 文档 | 说明 |
|---|---|
| [TECH_DESIGN](./TECH_DESIGN.zh-CN.md) · [EN](./TECH_DESIGN.md) | 完整技术方案与实现参考（v0.6.0）：架构、数据模型、各子系统、配置、安全、测试。 |
| [SEQUENCE_DIAGRAMS](./SEQUENCE_DIAGRAMS.zh-CN.md) · [EN](./SEQUENCE_DIAGRAMS.md) | 所有主要路径的时序图 + 模块依赖与服务调用图。 |
| [PROJECT_NOTES](./PROJECT_NOTES.zh-CN.md) | 项目笔记子系统（prompt 注入；0.6 起不再写仓库文件）的设计与 ADR。 |
| [CLIENT_UI_LESSONS](./CLIENT_UI_LESSONS.zh-CN.md) | 开发 dsh 插件客户端 UI 的踩坑教训——对任何贡献设置卡或浏览器 UI 的插件都有用。 |
| [HOST_CONTRACT](./HOST_CONTRACT.zh-CN.md) | 宿主（harness）API 工程契约，每条结论附源码出处；§9 是 harness 升级时的核对清单。（仅中文版） |
| [INDEX_MODE_EVALUATION](./INDEX_MODE_EVALUATION.zh-CN.md) | 三档注入模式（policy-only / index / full）的实测对照与"保持 policy-only 为默认"的裁决；可用 `tests/recall-golden.spec.ts` 复现。（仅中文版） |

## 历史决策记录（`archive/`）

已完成任务对应的规划/分析文档，保留"为什么"：决策依据、实证结论与实施偏差。其实施结果体现在代码与上述基线文档中。

| 文档 | 曾是什么 |
|---|---|
| [archive/MEMORY_SYSTEM_ANALYSIS.zh-CN.md](./archive/MEMORY_SYSTEM_ANALYSIS.zh-CN.md) | v0.2.x 系统分析（对五个参照方案）+ P0/P1/P2 路线图。P0/P1 已随 v0.3.0 落地，P2 有意推迟。文中条目级引述已脱敏。 |
| [archive/IMPLEMENTATION_NOTES_v0.3.0.zh-CN.md](./archive/IMPLEMENTATION_NOTES_v0.3.0.zh-CN.md) | v0.3.0 实施说明（P0×7 + P1×6）。 |
| [archive/memory-plugins-comparison-zh.md](./archive/memory-plugins-comparison-zh.md) | 与三个参考 dsh 记忆插件的横向对比 + P0/P1 治理改进清单，全部已随 v0.5.0 落地。 |
| [archive/MEMORY_MANAGER_PLAN.zh-CN.md](./archive/MEMORY_MANAGER_PLAN.zh-CN.md) | 记忆管理中心 UI 实施规划；一期已随 v0.4.0 发布，§12 记录实施偏差（如弃 `$mount` 改 `/api` RPC 直呼）。 |

## 约定

- **语言**：仅本索引（`docs/README`）、仓库根 `README`、`TECH_DESIGN`、`SEQUENCE_DIAGRAMS` 四组维持中英双语（面向外部用户与插件生态）；其余文档只维护中文版，避免双语同步开销。
- **新写的规划/分析文档**放在 `docs/` 顶层；对应任务完成、内容被代码与基线文档吸收后，移入 `docs/archive/`，并在文首加一行"已归档"状态。
- 本插件自 0.6 起**不向仓库写入任何文件**（≤0.5.x 曾生成 `docs/agent-memory/` 与 `AGENTS.md` 指针块，已移除并会自动清理）。手工文档请放在 `docs/` 的其他位置。
