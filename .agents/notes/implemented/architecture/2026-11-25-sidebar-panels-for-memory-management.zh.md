# Agent Note: 记忆管理迁入左侧栏面板列表

Status: implemented

[English](2026-11-25-sidebar-panels-for-memory-management.md) | 中文

## 问题

两个管理面此前都注册成 Settings 区：`settings.section` 的 `memory`（order 25）与 `identity`（order 26），由 `src/client/index.ts` 注册。DSH 0.2 适配把它们留在原处，是因为那一次是在移植宿主契约、不是在选外壳；而旧契约里唯一能承载整页的座位只有设置导航。

两个问题随之累积：

- **Settings 是宿主的偏好外壳，不是插件的页面。** 生态里的管理面迁到了左侧栏的全局列表——`sidebar.panellist` 图标配 `main` 页。外部 bundle `dsh-context` 只注册 `main` + `sidebar.panellist` + `plugins.bundle.config`，从不碰 `settings.section`；随宿主发行的 plugins/schedules/ssh 面板用的是同一对槽位。放在 Settings 里的管理面既没有栏位入口，设置列也不是为整页、懒加载的列表准备的。
- **规划中的功能波次会建在即将迁走的外壳上。** 指标、审计日志、新建表单与提议操作徽标当时都按 Settings 区排期；先在那里建完再迁移，等于为同一套 UI 付两次工。

## 决策

**每个管理页都是一个侧栏面板：`main` 上 key 为 `memory` / `identity` 的占位者，配一个同 id 的 `sidebar.panellist` 条目。** 配置仍留在 bundle 页（`plugins.bundle.config`，即 [DSH 0.2 宿主契约 note](2026-11-25-dsh-0.2-per-entry-settings-and-client-page.md) 记录的传输），Settings 里不再有本 bundle 的任何痕迹。

- **key 与 id 成对。** `sidebar.panellist` 的 list `id` 同时是 `main` 的 key——侧栏按钮按该 id 选中面板（`layout.selectPanel(id)` 对没有 `main` 占位者的 id 直接抛错），所以先注册 `main`、再注册图标。
- **图标只画 glyph。** panellist 组件只从 `{ size, active }` 渲染 currentColor glyph（`panel-icons.tsx`）；行标题是 `label` 函数，locale 变化时重读而不必重新注册。
- **无条件注册。** 本包的 client 半只在 bundle 被组合时加载，而该 bundle 的 patch 总会插入这些页读取的行；拿配置传输做门控会把导航耦合到一个无关传输上。第一次真机安装就证明了这点：带 `whileServed` 门控时，两个页面完全不出现。
- **页面框属于面板。** `.dsm-s-panel` 自己持有滚动容器与版心，顶边按 `--dsh-frame-top-clearance` 留白、左侧按 `--dsh-frame-leading-clearance`（窗口控件条带挂载时才有值的变量）让开；`load()` 保持幂等，因为 layout 会保留 `main` 的挂载。

清单元数据随本次迁移一并补上：`dsh.manifestVersion: 1` 与包根的 `icon`（宿主把它解析成插件管理器的展示元数据），一次安装读起来是一等插件，而不是一个裸包名。

**可编辑配置改成 live/volatile，否则 Settings 里什么都看不到。** 宿主的设置线协议只投影 schema 里带 `volatile` 字段的命名空间（`SettingsForms.describe()` 用 `volatileForm` 过滤）；这些字段以 live ref 交给 `apply`，提交后由 loader 就地更新（`loader/volatile-update`，不重启 fiber）。本包页面编辑的每个旋钮现在都标 `.volatile()`，并经 `liveValue`（`src/live-config.ts`）读取——同时接受宿主 ref 与单元测试传的普通值；`storage`、`entriesCap`、`crossProcessProbeMs`、`identitySeedDir` 保持挂载期普通字段，改动会重启该条目。会话冻结快照保留原有边界语义：实时旋钮（模式、预算读取处）下一步生效，冻结内容在下一次冻结（compaction 或新会话）时跟上。

**每个组合行都有自己的包身份，因为客户端模块扫描器拒绝有歧义的包。** 扫描器把每个活动 Loader 行解析到**最近的** `package.json`，并拒绝同一 package 被多个行解析到（`multiple active Loader sources`）；八个行都解析到包根时，整个 client 半被静默跳过。`scripts/fix-imports.cjs` 现在为七个子路径行生成 `lib/<row>/package.json`（只含 name + `type: module`，不带 `dsh.client`），让根行独占 `dsh.client`——与 `dsh-ops/lib/components/*/package.json` 同形。

两个组件保留既有结构：`MemorySection` 与 `IdentitySection` 各加一层薄薄的面板框，运行时 props 面从 `PropsRuntime<'settings.section'>` 换成 `PropsRuntime<'main'>`；页体（tab、控制器、RPC 面、样式）不变。

## 考虑过的替代方案

**继续用 `settings.section`。** 否决：没有栏位入口，设置列放不下下一波需要的整页，也不是宿主自家插件放管理面的地方。

**一个面板加 Identity tab。** 否决：要在 `MemorySection` 里渲染 `IdentitySection`，就得手工复刻槽位渲染器的 inject face 变换（`hooks` → `useX` props），或在 `main` 下声明子槽位；两者都只为省一个栏位图标而引入机械。两个面板则原样复用两个组件。

**双家方案（像 skills-manager 那样保留 Settings 区再加面板）。** 否决：两套外壳要同步维护、注册测试要写两遍，而这两个面本来就不承载配置。skills-manager 能承担，是因为它的设置区是真配置；这两个从来不是。

**把配置也搬进面板。** 否决：`plugins.bundle.config` 是宿主的配置契约，`dsh-context` 也把配置留在那里；面板只用一句 intro 文案指向 Plugins 页签。

**把面板挂在配置传输上**（`ctx.configForms.whileServed`），最初的做法。被真机安装否决：该传输只服务 volatile 命名空间，而这些条目一个都没有，于是面板与配置页一起毫无报错地消失。导航不应依赖配置传输。

**让所有字段保持普通、靠 fiber 重启刷新编辑器。** 否决：宿主的设置表单只编辑 volatile 字段，编辑器永远不会出现。给字段标 volatile 才是页面可见的前提。

**多行 bundle 不写每行包身份。** 被真机安装否决：扫描器拒绝有歧义的包并静默跳过 client 半——这是页面一直不出现的第二个原因。

## 后果

- Settings → Memory / Identity 两个入口消失；左侧栏多出两个图标（order 30/31：在 context 面板的 20 之后、ssh 的 40 之前）。身份面板仍是只读治理，行为不变。
- bundle 的配置页现在能组合并实时编辑；挂载期旋钮（后端、容量、种子目录）仍通过重启条目生效，因此 `identitySeedDir` 不再出现在设置页上。
- `dsh.client.inject` 不变：两个槽位宿主包（`@deepseek-ai/dsh-client-ui-layout`、`@deepseek-ai/dsh-client-ui-sidebar`）是 devDependency 与仅做 SlotMap 合并的 type-only import，不产生运行时 require——按 manifest 契约，inject 清单只是信息性声明。
- 安装后宿主立即组合新行，并向已连接的页面推送客户端图；全新页面加载只是兜底，不需要重启。
- 客户端注册契约现在有自己的测试（用记录型 slot 注册表钉住 key/id 配对，并断言不再有 `settings.section` 注册），`tests/live-config.spec.ts` 钉住 volatile 标记、live-ref resolver 与 store 的实时设置读取；jsdom 套件仍直接挂载组件，从未证明槽位接线。
- 换来的是：管理面落在其他插件用的同一套导航里，下一波 UI 直接落进面板而不必迁移，设置终于可编辑，并且少维护一套外壳。

## 测试

`npm run build`（宿主 `tsc` + 客户端类型门禁 + esbuild 打包）与 `npm run test`（1102 例，含 `tests/client-registration.spec.ts`、`tests/live-config.spec.ts` 与 review 运行态测试），随后用一个携带本 bundle 的隔离 `dsh web` profile 实测：启动图列出 `@chenhw7/dsh-memory/client.js`，无头 Chrome 跑出两个栏位图标、Memory 页三个 tab、Identity 页，以及五个带实时值的配置 section；同一安装再应用到运行中的 desktop 宿主，插槽与配置页无需重启即各就其位。
