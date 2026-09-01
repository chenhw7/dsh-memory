# Agent Note: 条目携带使用信号（accessCount）与可选的模型自评重要性

Status: implemented

[English](2026-09-01-importance-signal-access-count-and-importance.md) | 中文

## 问题

条目 schema 没有任何使用或重要性信号：存活判定与排序只依赖 `lastRecalledAt ?? createdAt` 和 `pinned` 标志——单一时间信号，没有"这条记忆实际帮过多少次"的概念。运行每多一天，就多一批永远无法追溯补齐这些信号的条目，债务随运行时长增长。之后再补字段能修代码但修不了存量语料；这条成本曲线使它尽管既不紧急也无行为风险，仍必须排进第一波。

## 决策

两个信号，一次 schema 变更，同批落地：

- **`accessCount`（机械、自动）。** store 在每次召回盖章时递增（`stampRecalled`——与设置 `lastRecalledAt`、清除衰减戳相同的 fire-and-forget 路径），因此 `memory_search` 命中、`memory_get`、`memory_list` 页都计入。缺省读作 0，既有条目无需迁移。它不需要模型配合，也不会被自评操纵。
- **`importance`（模型自评、可选）。** `memory_add` 与 `memory_replace` 接受整数自评；store 写入时收窄进 1–5 而非拒绝越界输入——错误的判断不是协议错误。缺省含义是"未评估"而非"不重要"：排序把缺省读作中位，不惩罚未评估条目。
- **各信号的作用位置。** 检索排序在 BM25 分数同分时按重要性降序决胜，先于新近度。janitor 的软衰减检查给 `importance` 4–5 的条目 1.5× 宽限窗口；召回仍是更强的存活信号——`stampRecalled` 无论重要性如何都直接清除衰减戳。
- **投影。** 两个字段经工具与 remote 条目投影透出（线上 `accessCount`、`importance` 可选），模型和管理 UI 都能看到。

## 曾考虑的替代方案

- **同时落模型自评的 confidence。** 暂缓：`confidence` 适合 auto-extraction 的 judge（其判定本身就是每条提议的置信信号），但接入它必须动 review 管线；该字段暂不加入 schema，避免永久空置的列。
- **importance 直接豁免衰减（低于阈值不衰减）。** 否决：未评估条目会活得比评估中等的更久，把信号含义倒过来；乘法宽限窗口让未评估基线保持原样。
- **用 accessCount 做排序信号。** 暂不采纳：按使用次数排序偏袒旧的高流量条目而非新近相关条目；字段从第一天起就在记录，`entries-cap` 落地时淘汰序可以再给它权重。

## 后果

- 信号债停止增长：从现在起写入的每条条目自动携带 `accessCount`。
- `entries-cap` 现在可以定义 `pinned` → `accessCount` → `lastRecalledAt` 的淘汰序；该决策仍归它自己的 note。
- 1.5× 宽限系数与"缺省读作中位"的排序规则是固定约定；改动任何一条都必须同步更新本 note、TECH_DESIGN 生命周期章节和宽限窗口/排序测试。
