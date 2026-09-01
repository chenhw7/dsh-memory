# Agent Note: 项目笔记投影不向用户仓库写文件

Status: implemented

[English](2026-08-31-project-notes-writes-no-repository-files.md) | 中文

## 问题

项目笔记子系统(编码习惯列表 + 踩坑日志)最初把渲染结果导出为用户仓库内的 `docs/agent-memory/{CONVENTIONS,PITFALLS}.md`,并在 `AGENTS.md` 维护托管指针块(v0.2–v0.5),让 dsh 之外的工具能通过读仓库发现这些记忆。真实使用把这份契约变成了自身的失败模式:生成文件不断出现在用户的 `git status` 里(真实用户反馈的首要痛点),多机克隆各自从本机 store 渲染、为已提交的文件互相覆盖,而这些文件既不宜提交(每台机器各自的真相)也不该忽略(指针块存在的意义就是被提交)——剩下的只有 git 噪声,和一份 store 里早已持有内容的陈旧副本。

## 决策

0.6 起 `memory-notes` 投影为 prompt-only:`ProjectNotesService.snapshotFor(cwd)` 从 store 同步、纯内存渲染进 `project-notes` system-prompt 段;store(`$DSH_HOME/storages/memory.json`)是唯一真相源,Memory 设置 UI(查看/编辑/置顶/归档/删除)是管理面。插件绝不向用户仓库写入任何内容。

- **单向渲染,不做反向同步。** 事实只从 KV store 流向 prompt 文本。从仓库读到的任何内容绝不写回 store,克隆的恶意仓库无法通过文件注入指令。
- **防重复注入。** `notesEnabled` 开启时,snapshot 与 index 读取器排除所有命中渲染矩阵的条目(`isRenderedEntry`),同一条目不会同时出现在 `project-notes` 段与 `memory` 段/index 中;`policy-only` 模式下天然无重叠。
- **保守的一次性清理。** `session/created` 时(每项目根每进程一次,幂等,best-effort)移除 ≤0.5.x 残留:只剥离 AGENTS.md 标记之间的托管块(标记之外的内容不动;剥离后只剩空白的文件才删除),只删插件生成的 `CONVENTIONS.md` / `PITFALLS.md` / `*.bak.*`(目录含外来文件时保留目录),绝不改用户的 `.gitignore`。
- **渲染尊重 store 生命周期。** janitor 衰减自动反映进渲染(衰减作用于 `project` 作用域条目;个人/全局习惯永不自动过期),`memory_pin` 语义透过渲染生效。

## 曾考虑的替代方案

<!-- 以下两个替代方案重构自设计记录;移除本身之前没有已提交的决策文档。 -->

- **保留文件导出但加入 gitignore。** 否决:gitignore 能消掉 status 噪声,但每台机器上仍留着未经请求的文件,且依旧无法共享——指针机制只在文件被提交时才有意义,而提交每机各自的渲染正是冲突的根源。
- **两个面并存(仓库文件 + prompt 注入)。** 否决:同一批事实的两个 home 需要手工保持同步,还搭上用来巡查漂移的 drift guard,为一个只有部分工具在用的桥接付出双重维护。

## 后果

- 只读用户仓库的工具不再能看到这些记忆;这是有意接受的代价——需要该桥接的用户可在设置 UI 中自行把内容整理进自己的 AGENTS.md。
- 自定义过 `notesDir` 的部署留下的 `docs/agent-memory/` 目录无法被清理例程回收(它只认识默认位置),需手动删除。
- 零仓库写入已被测试钉住(`tests/notes.spec.ts`:`snapshotFor` 前后无新增文件),清理规则(标记剥离、pointer-only 删除、外来文件保留、幂等重跑)各有独立用例。
- 0.6 之前的 `notesDir` / `notesAgentsPointer` 设置键不复存在;遗留值被 `resolveNotesSettings` 静默忽略。
