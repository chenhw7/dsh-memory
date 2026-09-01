# Agent Note: 展示层脱敏被拦截载荷，原文读取显式化并记审计

Status: implemented

[English](2026-09-01-tool-read-redaction-with-raw-paths.md) | 中文

## 问题

写入时扫描器拦截新载荷，但规则更新前已入库的内容只在 prompt 注入面上遇到 `redactBlocked`。模型可见的工具投影（`src/tool/index.ts` 的 `toEntryJson`、`formatEntryLine`）与管理 UI 的 remote 投影（`src/remote/index.ts` 的 `toEntryJson`）原样返回存量内容——被拦截载荷经 `memory_search`/`memory_list`/`memory_get` 重新进入模型上下文，UI 也原样显示。只给两个读面加脱敏而不留取原通道，会让被拦截条目永久不可读，把一次安全加固变成修复死路：人审和模型都看不到 `memory_replace` 需要覆盖的原文。

## 决策

展示层脱敏与两条显式且记审计的原文路径同批落地：

- **两个展示面全部脱敏。** 工具投影与 remote 条目投影对 `content` 和 `summary` 运行 `redactBlocked`；工具行格式化器对渲染输入脱敏。被拦截载荷在任何消费方读取条目时都显示为 `[BLOCKED: …]`。
- **模型侧原文路径。** `memory_get` 新增 `raw: true`——同一投影但去掉脱敏，仅用于在用 `memory_replace` 修复条目前取回原文。store 每次调用追加一条 `readRaw` 审计记录（`source: 'ui'`）。
- **UI 原文路径。** 新增 `getRaw` `@Remote` 方法包装 store 的 `getRaw`；设置 UI 的内联编辑器在打开时取未脱敏内容，被拦截条目可以读出并修复，而不是编辑占位符。同样的 `readRaw` 审计记录适用。
- **Store 契约。** `MemoryStore.getRaw(id)` 默认 no-op 返回 `undefined`（与 `markRecalled` 同一先例），无原文支持的 provider 依然符合契约。`AuditOp` 新增 `readRaw` 种类；持久化审计 schema 接受它。

## 曾考虑的替代方案

- **只脱敏、不留原文路径。** 否决：被拦截条目变成一行不透明的 `[BLOCKED: …]`，人只能删不能修，`memory_replace` 也失去可读目标。
- **用新记忆工具供原文。** 否决：为低频操作新增模型可见工具会扩大工具面；`memory_get` 上的参数保持工具数不变，调用点的意图也更明确。
- **UI 保持不脱敏（信任人）。** 否决：设置 UI 渲染进浏览器会话；被拦截载荷在那里同样应留在占位符后面，原文离一次显式点击的距离。

## 后果

- 每次原文读取都与写操作并列出现在审计日志里——一条 `readRaw` 记录证明有人取回过被拦截载荷。
- `getRaw` 向模型返回条目不绕过任何扫描：脱敏只作用于展示，修复后的写入仍经过同一套扫描门。
- `readRaw` op 必须在审计 schema、`AuditOp`、客户端镜像 `AuditOpJson` 三处保持同步；store、remote、tool 三层的原文读取测试各自钉住一处。
