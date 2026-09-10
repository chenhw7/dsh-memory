# Agent Note: Site deploys through the Pages Actions pipeline; stats.json leaves the repository

Status: implemented

[English](2026-09-10-pages-actions-deployment.md) | 中文

## Problem

Pages 从 main 分支根目录部署（Pages API `build_type: "legacy"`），因此落地页在浏览时拉取的 `stats.json` 必须存在于仓库中：`site-stats.yml` 在每次 push 到 main 与每日定时重新生成它，并以 `github-actions[bot]` 身份提交回 main。三项经核实的代价（2026-09-10 评估快照上实测）：main 全部 246 条提交中 42 条（17%；最近 20 条占 8 条）是刷新噪声；每条 bot 提交都迫使维护者的下一次直推先 fetch+rebase（反复出现的"rejected, fetch first"）；且 `build-site-stats.cjs` 不按作者过滤，统计把 bot 自己的提交也计入——2026-09-05/06 两天人类零工作却显示 `c:1, a:1, del:1`，而每日定时（`generated` 时间戳必然变化、每次必提交）保证今后每天都有提交，活动面板的"静默日"信号被永久抹掉。提交在库的生成物还与本仓库自己的规矩相抵触（AGENTS.md：插件不向仓库写入任何生成文件），分支根部署还把仓库文件（`package.json`、`docs/`、源码）与站点一起公开发布。

## Decision

- **Pages 改走 Actions 部署管线**（Pages API `build_type: "workflow"`，经 `gh api` 切换）。`.github/workflows/site-pages.yml` 组装部署工件——四个手工维护的 HTML 页、`robots.txt`、`sitemap.xml`、`assets/`——并用同一个 `build-site-stats.cjs --selfcheck` 通道把 `stats.json` **生成进工件**。删除 `site-stats.yml` 与已提交的 `stats.json`；该路径进 .gitignore（供本地预览运行）。
- 触发保持不变（每次 push 到 main、每日 17:32 UTC、手动），活动数据在落工作后即时新鲜，静默的仓库也仍会刷新时间戳——刷新发生在部署上，不再发生在 main 上。
- 不再有任何工作流写回 main：部署 job 只持 `contents: read`。push 竞态与 bot 提交噪声到此为止，活动面板重新只统计人类提交——那个会提交的 bot 不复存在，也就不再被计入。

## Alternatives considered

- **保留分支部署、就地止血**（去掉 per-push 触发、聚合时按作者过滤 bot、只有 days 数据真变才提交）。否决：bot 提交仍会落在 main，仓库仍违反自己的"不提交生成物"规矩，push 竞态只是变稀疏而非消失。
- **把生成文件提交到专用站点分支。** 否决：站点搬离一直服务的仓库根目录，为手工维护的页面制造第二个需要同步的面。
- **在本地 pre-push 钩子里生成统计。** 否决：把损耗原样转进维护者的每次 push，生成物仍被提交。

## Consequences

- 今后 main 上不再有 bot 提交；既有的 42 条刷新提交作为历史保留。2026-09-10 起 `git log` 与 bisect 考古只剩人类提交，维护者的 push 不再与定时写入者竞速。
- 活动面板的数据重新诚实：静默日如实缺席（自指的每日提交消失），数据只统计人类工作。页面内烘焙的文案（"CI 每日刷新" / daily build）仍然准确——部署仍是每日 CI。四个页面本身未动，仍于浏览时拉取 `stats.json`，变的只是它的家（其内容契约见[站点页面事实同步](2026-09-10-site-pages-source-fact-sync.zh.md)）。
- 站点现在只发布工件文件清单，旧的分支根部署顺带公开发布仓库文件（`package.json`、`docs/`、README）的行为随之终止。今后新增根级站点文件，必须同批加入工作流的拷贝清单与 `sitemap.xml`——这是替代旧提交噪声的唯一手工步骤。
- 发布依赖该工作流跑绿（Settings 不再直接服务分支）；部署失败时上一个已发布工件继续服务。Action 版本与其余 CI 一致钉到 commit SHA。
