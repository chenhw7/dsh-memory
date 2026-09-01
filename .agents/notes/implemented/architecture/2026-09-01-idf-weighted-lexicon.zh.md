# Agent Note: 一套分词,IDF 加权重叠度,全库 df

Status: implemented

[English](2026-09-01-idf-weighted-lexicon.md) | 中文

## 问题

词法层用三套互不相干的机制做同一件事。`dedup.ts` 用等权 Jaccard 加自研 CJK 单字分词给候选对打分,再靠一张手工维护的停用字表压制高频虚词噪声——而这张表同时误伤实词(删掉 的/用/为 类字后,「上海/海南」「中国/美国」的相似度被推高到 0.5)。`conflict.ts` 复用同一 Jaccard 加固定阈值。BM25 打分器的 df 又只在过滤后的候选集上统计——候选集只有 3 条时,纯虚词能拿 idf ≈ 0.98 并扭曲排序。同一份词表,三套分词,其中一套还靠停用表打补丁。

## 决策

一套分词,一个加权度量,全库 df:

- **`weightedOverlapSimilarity(stats, a, b)`**(在 `src/store/bm25.ts`):`Σidf(交集) / Σidf(并集)`,idf 来自对参与文本的 `buildCorpusStats`,分词用共享的 `tokenizeForSearch`(Latin 词 + CJK 字/bigram)。dedup、conflict、建议队列的重复观察匹配全部调用这一个函数。
- **删除 `CJK_STOP_CHARS`、`STOP_WORDS`、`tokenize`、`jaccardSimilarity`。** 手调表是在补偿缺失的 IDF;有 IDF 后「上海/海南」「中国/美国」测得 ≈0.03(原 0.5),真重写 0.14–0.20——停用表想买的区分度买到了,且无误伤。
- **df 范围 = 全库。** `DomainMemoryStore.search` 用全部 entries 构建 `CorpusStats` 注入 `Bm25Index`,候选集只贡献 tf/长度。虚词权重在任何候选集规模下都趋零。
- **阈值按实测重校,保持命名常量:** `DEDUP_SIMILARITY_THRESHOLD` 0.15(数值不变、语义重校——真重写 0.14–0.20 对干扰对 ≈0.06);`CONFLICT_STALE_THRESHOLD`/`CONFLICT_CONTRADICTION_THRESHOLD` 均为 0.1(IDF 加权反转了旧次序——替换值型 correction 测得 0.11–0.13,低于裸话题换述的 0.21–0.44——所以 conflicting/stale 的区分改由信号词承担,那是更强的判别器);`SUGGESTION_DUP_THRESHOLD` 0.3。

## 曾考虑的替代方案

- **保留 Jaccard,继续扩充停用字表。** 否决:每加一个字都是拿实词召回换指标稳定;IDF 权重做同一件事且零维护。
- **只给 df 设下限(压住 idf 下限)。** 否决:下限仍让虚词在小候选集上保有可感权重;全库 df 从根上把它们的贡献压到零。
- **跨 search 缓存语料统计。** 否决:条目写入会使缓存变陈旧;每次 search 的分词遍历与既有的每次重建索引同阶。

## 后果

- 换帧型纠错(改写后几乎无共享内容词——docker-compose→k8s)测得低于 conflict 线,不再标 stale;措辞矛盾时信号词路径仍会标 conflicting。这是换指标的已记录代价;计划钉住的两对验收词(上海/海南、中国/美国)下降约 16 倍,golden 下限无退化(100%/91.7%/0.958)。
- 任何新的相似度消费方必须用 `weightedOverlapSimilarity` 并显式选择语料,不得自造 Jaccard——一套分词,一个度量。
- 四个阈值是绑定在注释所记录实测带上的校准常量;重调必须重新测带,不能孤立改数。
