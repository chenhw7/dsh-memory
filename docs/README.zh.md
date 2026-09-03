# Cairn · 文档索引

`@chenhw7/dsh-memory` 的文档索引。English: [README.md](./README.md).

文档按生命周期分两层：本层的**当前基线**（活文档），以及 [`archive/`](./archive/) 中的**历史决策记录**。

## 当前基线

描述当前系统如何工作、以及持续维护所需的活文档。每次发布时与代码保持同步。

| 文档 | 说明 |
|---|---|
| [TECH_DESIGN](./TECH_DESIGN.zh.md) · [EN](./TECH_DESIGN.md) | 完整技术方案与实现参考（v0.6.0）：架构、数据模型、各子系统、配置、安全、测试。 |
| [SEQUENCE_DIAGRAMS](./SEQUENCE_DIAGRAMS.zh.md) · [EN](./SEQUENCE_DIAGRAMS.md) | 所有主要路径的时序图 + 模块依赖与服务调用图。 |
| [CLIENT_UI_LESSONS](./CLIENT_UI_LESSONS.zh.md) | 开发 dsh 插件客户端 UI 的踩坑教训——对任何贡献设置卡或浏览器 UI 的插件都有用。 |
| [HOST_CONTRACT](./HOST_CONTRACT.zh.md) | 宿主（harness）API 工程契约，每条结论附源码出处；§9 是 harness 升级时的核对清单。（仅中文版） |
| [RELEASING](./RELEASING.zh.md) | npm 发布 runbook：三条命令流程、OIDC trusted-publishing 前提、故障排查与信任边界（推 tag 即发布）。 |
| [EVAL](./EVAL.zh.md) | 真实 harness 测评集 runbook：L0/L1/L2 三层设计、`npm run eval` / `eval:ab` / `eval:smoke` / `eval:pilot` 命令面、指标语义（rubric v2、独立题 headline、register 轴）、噪声切片与试点门禁、rubric 版本化与 judge 环境门控、临时 `$DSH_HOME` 隔离纪律。 |

## 历史决策记录（`archive/`）

已完成任务对应的规划/分析文档，保留"为什么"：决策依据、实证结论与实施偏差。其实施结果体现在代码与上述基线文档中。

| 文档 | 曾是什么 |
|---|---|
| [archive/MEMORY_SYSTEM_ANALYSIS.zh.md](./archive/MEMORY_SYSTEM_ANALYSIS.zh.md) | v0.2.x 系统分析（对五个参照方案）+ P0/P1/P2 路线图。P0/P1 已随 v0.3.0 落地，P2 有意推迟。文中条目级引述已脱敏。 |
| [archive/MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md](./archive/MEMORY_SYSTEM_EVALUATION_v0.7.0.zh.md) | v0.7.0 继任深度评估（前作系统分析的接续）：核验前作 8 项指控已在当前代码修复，评估检索语义、召回兑现、并发与安全不对称等现状，附修复路线建议。 |
| [archive/IMPLEMENTATION_NOTES_v0.3.0.zh.md](./archive/IMPLEMENTATION_NOTES_v0.3.0.zh.md) | v0.3.0 实施说明（P0×7 + P1×6）。 |
| [archive/memory-plugins-comparison-zh.md](./archive/memory-plugins-comparison-zh.md) | 与三个参考 dsh 记忆插件的横向对比 + P0/P1 治理改进清单，全部已随 v0.5.0 落地。 |
| [archive/MEMORY_MANAGER_PLAN.zh.md](./archive/MEMORY_MANAGER_PLAN.zh.md) | 记忆管理中心 UI 实施规划；一期已随 v0.4.0 发布，§12 记录实施偏差（如弃 `$mount` 改 `/api` RPC 直呼）。 |
| [archive/PROJECT_NOTES.zh.md](./archive/PROJECT_NOTES.zh.md) | 项目笔记子系统的设计与 ADR（v0.2–v0.6）。prompt-only 投影已随 v0.6.0 落地；决策由 [Agent Note](../.agents/notes/implemented/architecture/2026-08-31-project-notes-writes-no-repository-files.zh.md) 承载。 |
| [archive/INDEX_MODE_EVALUATION.zh.md](./archive/INDEX_MODE_EVALUATION.zh.md) | 三档注入模式（policy-only / index / full）的实测对照；可用 `tests/recall-golden.spec.ts` 复现。裁决由 [Agent Note](../.agents/notes/implemented/architecture/2026-08-26-index-mode-stays-policy-only.zh.md) 承载。 |
| [archive/SECURITY_AUDIT.zh.md](./archive/SECURITY_AUDIT.zh.md) | 安全审计（2026-08-28，v0.5.0）：九大类人工审计 + Mimosa 密封深扫，发现 SEC-01…09——全部已处置（SEC-01 的 key 已于 2026-08-31 吊销）。 |

## 约定

- **语言**：仅本索引（`docs/README`）、仓库根 `README`、`TECH_DESIGN`、`SEQUENCE_DIAGRAMS` 四组维持中英双语（面向外部用户与插件生态）；其余文档只维护中文版，避免双语同步开销。
- **新写的规划/分析文档**放在 `docs/` 顶层；对应任务完成、内容被代码与基线文档吸收后，移入 `docs/archive/`，并在文首加一行"已归档"状态。
- 本插件自 0.6 起**不向仓库写入任何文件**（≤0.5.x 曾生成 `docs/agent-memory/` 与 `AGENTS.md` 指针块，已移除并会自动清理）。手工文档请放在 `docs/` 的其他位置。
