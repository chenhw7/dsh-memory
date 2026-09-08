# Agent Note: The site logo becomes a four-step stairway-cairn mark

Status: implemented

[English](2026-09-08-site-logo-refresh.md) | 中文

## Problem

站点的每个页面都挂着一块与产品无关的栅格 logo:`assets/logo.png`(1254×1254)和 `assets/logo-512.webp` 是一张 DeepSeek 动漫吉祥物插画,`assets/favicon.png` 是同一张图的裁切。除了品牌错位,固定配色的位图也无法适配[中文站改版笔记](2026-09-08-site-zh-redesign.zh.md)交付的明暗双主题设计系统——固定色吉祥物必将在两种主题之一里看不清,而墨色透明底位图在暗色主题下会直接消失。品牌名本身——*cairn*,叠石路标——完全没被用上。

## Decision

站点标志换为**四级圆角石阶、自左向右拾级而上**的「石阶 / Stairway」(12 个候选中的 09 号):每一级是一段被存下的会话记忆,上升是上下文的增长,顶石——当前会话——用 DeepSeek 蓝 `#4D6BFE`。`0 0 100 100` 视窗内石块厚度 10.5–14 单位,保证 16px 下形体完整。

- **四个页面全部内联 SVG**(导航 brand 26px,落地页 hero clamp(84–128px)):三块墨色石块 `fill="currentColor"`,顶石 `fill="var(--accent)"`。标志通过页面自身的 CSS 变量跟随主题切换,零额外请求、无位图回退;`assets/site.css` 的选择器从 `.brand img` 改为 `.brand>svg`。
- **`assets/favicon.png` 以 64×64 重新生成**:浅色瓷底(`#F0F5FF`,发丝描边 `#D8E2F5`)承载一个 favicon 专调的三阶变体(间隙加大)——16px 下四阶的间隙会被抗锯齿吞掉,瓷底则保证暗色标签页上依然可见。一个文件同时服务两种配色;`sizes="64x64"` 的引用不变。
- **`assets/logo.png`(512×512,透明底)与 `assets/logo-512.webp` 同步重制**为新标志的分发用位图,供无法内联 SVG 的场合使用。站点页面已不再引用它们。
- **README 采用:** 两份 README 以 `<picture>` 块开篇承载标志(浅色 `assets/logo-512.webp`,深色 `assets/logo-512-dark.webp`);技术深潜的 hero 截图(`assets/memory-architecture-hero.png` / `assets/memory-architecture-hero-zh-CN.png`,亦即页面的 `og:image`)已按新设计浅色主题重拍(2880px 宽)。
- 设计探索过程(12 个 SVG 变体、两个 showcase 页、渲染/验收脚本)曾保留在未跟踪目录 `.logo-design/`,随本次变更一并删除;权威几何即四个 HTML 页面里的内联 SVG。

## Alternatives considered

- **11 回路石标(Loop Cairn):** 粗「C」环断口里坐一座两块石头的蓝色迷你石标——品牌名亲手补全记忆回路,是最巧的决赛选手。落选:环加内石在 24px 以下拥挤,且「C = Cairn」的读法依赖名字在旁边。
- **12 穿环轨迹(Through-Loop):** 蓝色会话轨迹从记忆环缺口穿出、终点是蓝色顶点——两个入围方向(环 + 里程)最正宗的融合。落选:环、线、点三个元素在 24px 以下糊在一起,轨迹起点在小尺寸下显得来历不明。
- **07 记忆核(Core Ring):** 粗 C 环加居中蓝色记忆核——最简的决赛选手,16px 最稳。落选:败给石阶与石冢母题更贴(叠级而上,而非抽象核心);若四阶石标日后需要简化,它是预留的退路。
- **保留位图 + CSS 按主题换图**(`:root[data-theme="dark"]` 下 `content: url(...)`)。落选:Safari 不支持对 `<img>` 的 `content` 替换,暗色模式的 Safari 用户会得到一块看不见的墨色;内联 SVG 到处自适应且零成本。

## Consequences

- 标志零 JavaScript 即可随主题切换:浅色渲染墨色 `#0B1526` + `#4D6BFE`,深色渲染 `#E8EDFF` + `#6C87FF`,完全走既有 token 体系。
- `assets/logo.png` 已无页面或 README 引用;作为可分发品牌位图保留,若始终无人采用可删除。`assets/logo-512.webp` 被两份 README 引用。
- favicon 刻意与站点标志双形并存(瓷底三阶 vs 裸四阶),换取 16px 可读性与暗色标签页可见性——已知且接受。
- 设计过程草稿 `.logo-design/` 已随本次变更删除;落选变体的几何仅存于上方 Alternatives 一节,没有任何已交付产物依赖该目录。
