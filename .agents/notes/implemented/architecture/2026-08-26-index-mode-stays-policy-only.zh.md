# Agent Note: 注入模式保持 policy-only 默认档

Status: implemented

[English](2026-08-26-index-mode-stays-policy-only.md) | 中文

> 2026-09-01 被超越:[出厂默认提升为 index 模式](2026-09-01-index-default-promotion.zh.md)——会话采集遥测始终不可获得后,改进计划反转了举证责任。本 note 的基准证据仍有效;它守护的默认值已不再是出厂值。

## 问题

memory 段在 `off`/`custom` 之外支持三种常驻注入模式：`policy-only`（只有引导文本，模型按需检索）、`index`（每条一条存在行）、`full`（完整内容）。在 golden-set 基准出现之前,默认档选 policy-only 仅出于保守直觉:没人知道召回质量与注入成本在库存增长时如何实际权衡。把 `index` 提为出厂默认是改进计划中的活跃选项([archive/memory-plugins-comparison-zh.md](../../../../docs/archive/memory-plugins-comparison-zh.md),P1-8),而没有证据支撑的默认档,无法在下一个"index 听起来严格更好"的提案面前自辩。

## 决策

`policy-only` 保持出厂默认;`index` 定位为推荐的进阶档——记忆库超过几十条、或模型明显漏搜时升级;`full` 适合小库存重上下文场景,注意其 20 条折叠线。裁决依据 2026-08-26 的实测基准(`src/benchmark/index.ts` + `tests/recall-golden.spec.ts`):

- **工具检索已经完备。** 在 24×24 golden 夹具上,BM25 召回达 success@5 = 100%、P@1 = 91.7%、MRR = 0.958(CI 钉住下限:≥ 85% / 60% / 0.75)。常驻索引带来的是存在性感知("提醒模型去搜"),不是检索能力("搜得到")。
- **policy-only 是唯一与库存规模解耦的档位**——恒定 ≈344 token,与库存量无关。`index` 按条线性增长(≈26 token/条,约 100–140 条时触及 5000 字符预算,随后卷起为类别计数行);`full` 在默认预算下仅 24 条时就开始折叠条目,其可见覆盖率先于字符预算触顶。
- **golden set 证明的是"能搜到",不是"会去搜"。** 默认档的切换标准是行为证据——模型在真实会话中 `memory_search` 的漏召率——这需要线上 recall 触发率统计,目前不存在。

## 曾考虑的替代方案

- **把 `index` 提为出厂默认。** 依据上述证据否决:常驻 ≈955 token 的固定成本(在夹具 24 条时比 `full` 还贵 ≈18%)换来的存在性感知,在工具检索已把 golden set 打满的前提下,并未证明是模型需要的。这也是记录在案的重引入条件:一旦线上 recall 触发率统计表明真实会话确实漏搜了库里能答的查询,即可提为默认。
- **把 `full` 设为默认**(最大上下文)。否决:它是最贵的常驻视图,且在默认 20 条上限处折叠尾部——库存越大,静默失去的可见性越多,与默认档应随库存增长的定位相反。

## 后果

- README 与设置 UI 把 `index` 描述为推荐升级,而非默认;支撑该文案的成本表可用 `DSH_MEMORY_EVAL_VERBOSE=1 npx vitest run tests/recall-golden.spec.ts` 复现。
- `tests/recall-golden.spec.ts` 钉住召回下限,任何使检索退化的分词、权重或预算改动都会让 CI 失败;归档评估([archive/INDEX_MODE_EVALUATION.zh.md](../../../../docs/archive/INDEX_MODE_EVALUATION.zh.md))中的实测表由同一次运行再生。
- 未来若要提升 `index`,需要的是上述行为证据,而不是重跑词法基准——基准观测不到模型是否选择去搜。
- 跨语言召回不在范围内:纯中文查询打纯英文条目零词法重叠,golden set 的查询已做内容锚定以避免假性脱靶;语义向量层是另一个量级的工程。
