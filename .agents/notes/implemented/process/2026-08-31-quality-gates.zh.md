# Agent Note: 以机械质量门禁取代行文约定

Status: implemented

[English](2026-08-31-quality-gates.md) | 中文

本记录把上游 harness 的质量门禁笔记([harness 2026-06-11](../../../../../deepseek-harness/.agents/notes/implemented/process/2026-06-11-quality-gates.md))适配为本仓库实际生效的门禁。

## 问题

本代码库主要由 coding agent 开发。相比行文约定,agent 遵守强制门禁的可靠性远高得多。本仓库没有 lint 跑批器,也没有文档门禁跑批器,因此"哪些检查真正强制了什么"需要一份记录:一个假想这里有 harness 级门禁(100% 覆盖率、lint、doc-sync)的 agent,要么会去等待永远不会运行的检查,要么会声称不存在的证据。

## 决策

强制集合有意保持很小,且每一项都可机械检查:

- `npm run build`:对 `src/` 跑 `tsc` 加 esbuild client 打包——它同时是 typecheck 车道、编译门禁与 client 打包门禁。`src/client` 由同一脚本中的第二个专用步骤 `tsc -p tsconfig.client.json` 做类型检查(见[client 类型门禁 note](2026-09-01-client-typecheck-gate.zh.md));没有独立的 `typecheck`、`lint` 或 `coverage` 脚本。
- `npm run test`:vitest 跑 `tests/`;唯一的行为门禁。GitHub Actions 会跑它两遍:`ci.yml` 在每次 push 到 `main` 与每个 pull request 上跑,`publish.yml` 则经 `prepublishOnly` = `build && test` 在 `npm publish` 前跑,此前先做 tag/版本一致性检查。
- 评审:一切不可机械检查的内容——行文纪律、测试强度、落位、配对质量——由评审按 [dsh-code-review](../../../skills/dsh-code-review/SKILL.md) 与[文档标准](../../../../docs/AGENTS.md)负责。
- 本仓库不运行 Git 钩子;推送前证据纪律由 [dsh-pre-push-checks](../../../skills/dsh-pre-push-checks/SKILL.md) 承载。

本仓库有意不携带的上游门禁:按文件 100% 覆盖率、Oxlint/jscpd、publint 与 workspace 约束,以及 doc-sync 套件。单人维护、单包的形态使 build+test 这对组合成为仍能拦住已记录失败类别(未过类型检查的测试、编不过的 client 打包)的最小集合。

## 曾考虑的替代方案

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

- 只有门禁强制到的约定才能在 agent 更替中存活;其余一切依赖评审遵循各项技能。
- 门禁本身也是需要维护的代码;`package.json` 脚本变更与其他变更一样需要评审。
- 门禁集合是 agent 的契约:只报告上述命令产生的证据,把"跑一下 linter"当作不可用,而不是"待运行"。
