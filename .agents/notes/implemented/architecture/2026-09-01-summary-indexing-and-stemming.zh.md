# Agent Note: summary 进索引,Latin 词形保守词干化,golden set 扩到 35

Status: implemented

[English](2026-09-01-summary-indexing-and-stemming.md) | 中文

## 问题

检索索引只对 `entry.content` 分词。查询词只出现在条目 `summary` 里——那段为检索专门写的人工浓缩高信号文本——时,条目找不到。分词器也没有词干化,`testing` 与 `test` 是两个 token。两个盲区同一根源:golden 夹具(24 条 × 24 组关键词式查询)按构造主题互异,看不见这两个缺口。计划的裁定要求先扩夹具再改检索,让改动有量尺,且地板值必须活下来。

## 决策

三个联动变更:

- **summary 进索引。** 检索索引对 content + summary 构建合并 token bag(隐式 BM25F:summary 与 content 重复的 token 提升 tf);语料统计与索引共用同一 bag。summary 已被扫描器门禁(`summary-scan` 已落地),不打开任何未扫描通道。
- **Latin 保守词干化,带长度守卫。** 只折叠长屈折——`testing→test`、`configuring→configur`、`computers→computer`——且必须留下 ≥5 字符词干;更短的带后缀词保持原样(news、lens、bring、aged、speed、纯数字串)。CJK 一元/bigram 路径不受影响。第一版会削到 2 字符(`bring→br`、`news→new`)并把数字误当词;守卫和下面的边界测试都来自那轮评审。
- **golden set 24 → 35**,加同义改写切片(查询词只在 summary 里,含双语镜像条目)与词形变化切片。四个地板值全部原样成立(success@5 ≥ 0.85、MRR ≥ 0.75、P@1 ≥ 0.6、zh ≥ 0.8);实测基线移至 success@5 100% / P@1 82.9% / MRR 0.902——P@1 的稀释是同主题的 summary 条目一起进入候选集,spec 里记录了改前数字(24 条:P@1 91.7% / MRR 0.958)。

## 曾考虑的替代方案

- **显式 BM25F 字段加权。** 暂缓:合并 bag 拿到大部分收益(summary token 提升 tf),且不用调新打分参数;字段加权打分器是需要单独测量的更大变更。
- **激进(Porter 式)词干化。** 否决:第一版对真实词表的破坏(`bring→br`、`news→new`、`movies→movy`)说明无守卫的后缀削减危害多大;长度守卫用短词间的一点召回换零词形损坏。
- **独立的 summary 索引 + 两阶段排序。** 否决:双索引让每次检索成本翻倍,对合并 bag 没有可测收益。

## 后果

- dedup/conflict/建议相似度共用分词器,屈折形式在那里也近似相同(`running ≈ runs`)——接受"同一记忆"方向的漂移,已验证不触碰任何既有阈值测试。
- 长度守卫意味着短词的单复数对保持不同 token(`tests`/`test`);这类对的召回来自同义切片与 summary 文本,而非词干。
- golden set 现在是 35 组的常驻回归地板;检索行为变更需要重测基线带,不能孤立改地板值。
