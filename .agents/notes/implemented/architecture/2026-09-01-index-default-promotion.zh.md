# Agent Note: 出厂默认提升为 index 模式,回退开关随变更落地

Status: implemented

[English](2026-09-01-index-default-promotion.md) | 中文

本 note 超越 [注入模式保持 policy-only 默认档](2026-08-26-index-mode-stays-policy-only.zh.md)。被超越 note 的重引入条件——线上召回触发统计表明真实会话漏搜——被记录为无限期阻塞:它依赖的会话采集 30 天内产出 0 个可观测会话,且无人认领。记忆系统改进计划([proposed/architecture/2026-09-01](../../proposed/architecture/2026-09-01-memory-system-improvement-program.zh.md))裁定:无法满足的条件不应扣押默认值,举证责任反转——现在就提升,以回归地板值加显式回退开关作护栏,而非等待遥测。

## 问题

`policy-only` 注入的是让模型去搜记忆的指引,但搜不搜由模型决定。跨真实的多小时会话,模型的可证实表现是欠搜索:召回只在模型碰巧想起来时发生,而每次漏搜都不可见——没有错误、没有日志,只有模型本可以拥有却没有的上下文。2026-08-26 的 note 以等待线上统计为由保持 policy-only;现在那些统计被记录为永久不可获得而非待获得,于是选择变成「已知成本」对「不可观测的漏搜」。

## 决策

**`memoryMode` 缺省改为 `index`**(`src/context/index.ts` 的 `memory` 设置命名空间缺省)。实测依据,基于第三波检索升级后的 35×35 golden 夹具:

- **常驻成本:** 35 条夹具下 `index` ≈1102 tokens(≈26 tokens/条,100–140 条时触及 5000 字符预算后卷起为类别计数行)对 `policy-only` 的 ≈344 条平——夹具规模下约占 200k 上下文的 0.5%,随库存线性增长。
- **它买到什么:** 每条记忆在每个会话都以存在性行对模型可见——模型不再需要先猜测"可能存在记忆"才发起搜索。第三波加的同义切片正是常驻索引预防的失败类:措辞与存储文本不同的查询。
- **回退开关随变更落地**(而非事后补):`memoryMode` 是实时设置命名空间字段,每个部署可从设置 UI 或 `cordis.patch.yml` 修改、无需重启——回退到 `policy-only` 是一行配置变更,`off`/`custom`/`full` 仍是一等模式。

## 曾考虑的替代方案

- **保持 policy-only 直到遥测出现。** 否决:整个改进计划存续期间遥测始终不可获得(会话采集在宿主侧且损坏——`session-capture-repair` 已搁置);被无法满足的条件扣住的默认值就是现状,不是决策。
- **提升 `full`。** 否决:完整内容在 20 条折叠线上开始折叠,常驻 token 也高于 `index`;随库存增长反而丢失可见性的默认值是倒退。
- **用新 Config 字段而非复用 `memoryMode` 提升。** 否决:`memoryMode` 已有五个模式、实时设置解析与 UI 接线;平行的开关会复制这个表面。

## 后果

- 常驻注入成本从夹具规模的 ≈344 涨到 ≈1102 token 并随库存线性增长;上下文预算紧张的部署显式设 `memoryMode: 'policy-only'`(或 `off`)——成本表经 `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts` 再生。
- KV-cache 纪律不受影响:索引文本仍在 `session/created` 按会话冻结、仅在 compaction 重新冻结。
- 被超越 note 的基准证据(工具检索饱和 golden set)仍然有效且未变;变化的是决策标准——计划把举证责任从"证明模型漏搜"翻转为"证明 index 有害",因为只有前者曾经可测量。
