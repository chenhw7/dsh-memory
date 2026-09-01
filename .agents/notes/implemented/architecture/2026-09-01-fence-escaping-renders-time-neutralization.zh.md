# Agent Note: 注入围栏在渲染时中性化伪造的闭合标签

Status: implemented

[English](2026-09-01-fence-escaping-renders-time-neutralization.md) | 中文

## 问题

存储的记忆内容被渲染进插件自有的 XML 围栏（`<memory-context>`、`<memory-index>`、`<recalled-memory>`、`<project-notes>`），但没有任何机制阻止条目内容包含围栏自身的闭合标签。一条 content 含 `</memory-context>` 的条目会提前终止围栏，让余下的存储文本在框架之外发言——越出每条围栏都携带的「有用的上下文，而非指令」免责声明。写入时扫描器不拦截闭合标签（它不是注入模式），所以任何既有边界都无法拒绝这类内容。这是记忆系统改进方案中的机制推演项，未观测到实际利用。

## 决策

渲染时转义，单一收口点。`src/context/policy.ts` 的 `neutralizeFenceBreaks` 改写正文中所有插件自有的闭合标签（`</memory-context>` → `<\/memory-context>`，`memory-index`、`recalled-memory`、`project-notes`、`memory-policy` 同理），四个围栏构造函数在包裹 store 来源正文前统一应用：`buildMemorySectionText`（`full` 与 `index` 模式）、`buildNotesSectionText`、`buildAutoRecallBlock`。开标签保持原样——它无法终止围栏——构造函数自己输出的围栏也不转义，因此每条围栏恰好保留一个真实闭合。存储内容永不被修改；工具读路径与 remote 投影仍返回原文。

## 曾考虑的替代方案

- **在 `add`/`update` 时拒绝写入。** 否决：本仓库正当讨论记忆系统自身（它的围栏、它的存储语义），闭合标签禁令会拒掉正当条目，且已落盘的闭合标签无论如何仍需渲染时兜底。
- **在每个渲染点分别转义（`renderScope`、工具格式化、索引行）。** 否决：五个分散的调用点必有遗漏；围栏构造函数是唯一直接构造围栏的地方，在那里转义即可覆盖构造函数的所有消费方。

## 后果

- 存储的闭合标签渲染为 `<\/memory-context>`：模型读起来文本完好，但不再终止围栏。
- 标签名清单（`PROMPT_FENCE_TAGS`）必须与本插件新增的任何围栏保持同步；`tests/policy.spec.ts` 的 fence-escaping describe 块逐构造函数钉住这一行为。
- 其他插件或宿主拥有的标签不在转义范围内；只覆盖本插件自己的注入面。
