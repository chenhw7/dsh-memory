# Agent Note: 条目表封顶可配置的 500,按使用信号淘汰

Status: implemented

[English](2026-09-01-entries-cap-use-signal-eviction.md) | 中文

## 问题

条目表是唯一无上界的表——audit 与 suggestions 各封顶 200,entries 随每条被接受的写入增长。失控的提取循环或健谈的项目会让单一 JSON 介质无界膨胀:50 命中搜索的召回戳重写一个只增不小的文件,持久格式的迁移压力随任何一台机器积累过的最大库增长。改进计划把本条目排在 `importance-signal` 之后,因为淘汰序需要使用信号;前置已落地,淘汰序可定义而非只有"按新近"。

## 决策

- **`entriesCap`** 挂在 store 插件的组合 Config 上(schemastery,默认 **500**),每次成功 `add` 后收敛到上限——建议采纳经同一咽喉点修剪;`update` 与 `markRecalled` 永不淘汰(它们改行,不增行)。500 远高于 golden 夹具与集成测试体量,只在 JSON 介质真正的压力区之下;更大库的部署覆盖 row config。
- **淘汰序:pinned 永不 → `accessCount` 升序(缺省 = 0)→ `lastRecalledAt ?? createdAt` 升序。** pinned 行排在最后且 pinned 墙会终止淘汰——上限是软目标:全部 pinned 的表允许超限,而不是删除受保护行。
- **审计归属:`remove`/`janitor`。** `AuditSource` 是持久记录形状上的固定枚举;janitor source 本就命名系统发起的生命周期写入,store 自己的淘汰属于同类。淘汰失败向 `add` 调用方传播(内联 await,与 `trimSuggestions` 同形),即使新增行已落库——已写入方法的契约注释。

## 曾考虑的替代方案

- **沿用 audit/suggestion 的 200。** 否决:200 条对一个工作中的记忆库是正常活跃区间;上限要拦的是失控增长,不是正常积累。
- **没有别的可淘汰时硬删 pinned。** 否决:pin 是用户显式的"永不遗忘"——静默删除破坏该标志的契约。让超限状态浮出比隐藏它好。
- **为淘汰新增 `AuditSource` 值。** 否决:source 是持久记录 schema 的固定枚举;扩它会为消费者从不需要的内部区分改变存储形状。

## 后果

- 无界增长风险在插件层闭合;剩余压力(每次写的单文件重写成本)是介质的既定取舍,只能靠 `per-record`/SQLite 后端选择迁移。
- pin 超过 `entriesCap` 的用户会看到写入淘汰最新的未 pin 新增——remove 审计轨迹可见,调大 row config 可避免。
- 淘汰复用召回元数据,使用信号第一次端到端贯通:`accessCount` 在读时累积、在写时决定生死。
