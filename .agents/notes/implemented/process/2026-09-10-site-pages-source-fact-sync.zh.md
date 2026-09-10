# Agent Note: Site pages re-sync to the shipped facts (identity layer, digest default, current counts)

Status: implemented

[English](2026-09-10-site-pages-source-fact-sync.md) | 中文

## Problem

两对双语站点页面（`index.html` / `index.zh-CN.html`、`memory-architecture.html` / `memory-architecture.zh-CN.html`）定格在 v0.9.1，与源码漂移。v0.9.2 交付了身份层（SOUL.md / USER.md、`identity_update` 工具、`identity` / `identity_history` 两张表、三个身份治理 RPC、第五张设置卡、第八行 Cordis 编排）并把 `digest` 定为工厂默认注入档；测试套件从 967 涨到 1096 个用例。页面还带着更老的机制描述：整合预筛 ≥ 0.15（现为 0.2 外加罕见锚点 OR 信号）、巡扫写成「top 20 对条目专抓零共享 token 的同义改写」（实为按使用信号选 top 20 条目穷举配对、仍过同一词法门，外加首个会话的一次启动巡扫）、提示段序 90/91（现为 6000/6001，在宿主工具段 5000 之后）、15 个 RPC 方法（现为 18，`identityRevert` 另有第二道开关）、importance 断平写成「缺省按中位」而代码缺省按 0——同一陈旧说法还残留在 `src/store/index.ts`、`src/types.ts` 与 `memory_add` 的参数描述里。演示 2 的 CJK 判定正则丢了源码分词器保留的 Hangul 区段，「逐行一致的算法」已不再成立。

## Decision

把两对页面同步到经核实当前事实，中英一起改，每处改动都可追溯到源码位置：

- **身份层可见。** index 页新增第五张能力卡；站 02 新增独立 IDENTITY 区块与 `identity` / `identity_history` 两张表卡；八行 Cordis 编排补 `memory-identity`；站 05 写明 soul / user-profile 段序（80 / 81）；站 07 写明 `identityRevert` 的第二道开关（`identityRevertEnabled`）；页脚来源补 `src/identity/`；站 01 补 anti-echo 预过滤（与已注入身份文档的 IDF 加权重叠 > 0.6 即丢弃）。
- **注入模式。** 六档，`digest` 自 v0.9.2 起为默认；演示 3 新增 digest 视图（策略常驻 ≈434 tokens，外加首个 step 一次性 ≈126 tokens 的 `<memory-digest>` 清单，压缩后重发一次），whybox 改为论证 digest 默认。
- **数字。** 9+1 工具（九个记忆工具 + `identity_update`，身份层默认关闭）、1096 个测试（1090 通过 + 6 需密钥跳过）、6 张持久化表、18 个 RPC 方法（10 读 8 写）、烘焙状态快照更新为 v0.9.3 / 241 提交 / 2026-09-09、宿主渠道钉为 0.1.2-alpha.2、评估表补 identity-v0（3 场景 6 题）。
- **机制修正。** 预筛 ≥ 0.2 外加 df ≤ 2 的锚点 OR 信号（0.15 仅随 `consolidation: 'legacy-judge'` 保留）；巡扫重写为 top 20 条目 + 穷举配对（候选对上限 20）且词法门不变；importance 断平在页面与残留陈旧说法的源码文本里统一写为缺省按 0；演示 2 分词器补回 Hangul 区段，与 `src/store/bm25.ts` 恢复逐字节一致；工具模块头数十个工具；`memory_forget` 上限注释改为指名实时检索上限（maxSearchResults/2）；HOST_CONTRACT 取证基准从 rc.5–rc.8 线移到 0.1.2-alpha.2。

## Alternatives considered

- **留到下次改版再同步。** 否决：页面自我标榜 CI 门禁过的准确性（「数字说话」），而默认档写错、巡扫机制写错恰是技术解析页存在要教的事实。
- **为身份层开完整新站。** 暂时否决：该层默认关闭，在既有站点内放醒目区块即可承载，无需重排导航；身份层若哪天转为默认再议。
- **改代码去迁就「mid-range」文案**，而不是文案迁就代码。否决：`?? 0` 断平是已交付且被测试钉住的行为，漂移的是文案。

## Consequences

- 两页上每个量化声明重新指向事实源；演示 2 分词器与 `src/store/bm25.ts` 恢复逐字节一致（含 Hangul）。
- 同步过程揪出五处源码侧陈旧文本（工具模块头、遗忘上限注释、两处 importance 注释、`memory_add` 描述），随本次一并修正——修正方向永远是「文档跟代码」，绝不反向。
- 代价：今后改事实的工作要同步更新四个 HTML 文件；站点没有机械化门禁，上文的变更清单就是检查单。
