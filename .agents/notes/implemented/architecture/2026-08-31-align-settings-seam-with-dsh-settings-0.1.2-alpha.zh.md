# Agent Note: 对齐 @deepseek-ai/dsh-settings 0.1.2-alpha 的 settings 缝隙

Status: implemented

[English](2026-08-31-align-settings-seam-with-dsh-settings-0.1.2-alpha.md) | 中文

## 问题

`@chenhw7/dsh-memory` 0.6.0 按 rc 时代的 `@deepseek-ai/dsh-settings` API 构建（lockfile 中为 0.1.0-rc.8；peer 范围 `^0.1.0-rc.5 || ^0.1.1-rc.1`）。在 harness 的 `0.1.2-alpha` 渠道上，插件无法加载。

上游移除已在版本边界处核实：

| Tag | `installSettingsSection` / `settingsNamespace` 是否为顶层导出 |
|---|---|
| `dsh-v0.1.1-rc.2` | 存在 |
| `dsh-v0.1.2-alpha.1` | 存在 |
| `dsh-v0.1.2-alpha.2`（npm `alpha` dist-tag，2026-08-30） | **已移除** |

移除发生在上游 runtime-dependency-decoupling 变更中（merge `a69941bf51`，PR #3319；commit `f4e49ccf8f` "refactor(services): move shared values behind service APIs"）：自由函数被移到服务 API 之后，成为实例方法 `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`（`~/deepseek-harness/packages/settings/settings/src/index.ts`）；`settingsNamespace()` 品牌 helper 则彻底删除——命名空间改为普通字符串，由 `SettingsNamespaceInput` 模板字面量类型在编译期校验、由 `parseSettingsNamespace` 在运行期校验。

七个 bundle 挂载单元中有四个静态导入了被移除的名字：

- `tool-memory` — `src/tool/index.ts` 导入 `settingsNamespace`
- `memory-notes` — `src/notes/index.ts` 导入 `settingsNamespace`
- `memory-context` — `src/context/index.ts` 导入 `installSettingsSection` + `settingsNamespace`
- `memory-review` — `src/review/index.ts` 导入 `installSettingsSection` + `settingsNamespace`

ESM 在链接期解析命名导出，缺失即失败，因此每个单元在插件加载时直接抛 `SyntaxError: … does not provide an export named …`。`memory-root`、`memory-store`、`memory-remote` 能存活，但记忆功能整体（工具、上下文注入、自动提取、笔记）不可用。

此外，声明的 peer 范围 `^0.1.0-rc.5 || ^0.1.1-rc.1` 匹配不上 `0.1.2-alpha.2`（也匹配不上 `0.1.1-rc.2`）：按 semver 规则，预发布版本只有在比较器集合中存在同 `[major, minor, patch]` 元组且自身带预发布段的比较器时才可能满足范围。

上游仓库没有在任何地方点名这一第三方影响——旧名字已从其文档中全部清除，两处相关 commit 仅有标题，其 Agent Notes 政策是 fail-loud 且不设兼容别名（`~/deepseek-harness/.agents/notes/implemented/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md`）。新 API 只被正面记载于 settings 包 README 与 `docs/subsystems/settings.md`。本笔记记录诊断结论，并为本仓库的迁移决策负责。

## 决策

本仓库现在端到端对齐 0.1.2-alpha 线：四个宿主侧 settings 调用点改用 provider 方法，依赖范围在整个 dsh 家族上要求 `^0.1.2-alpha.2`，client bundle 脱离被移除的 `dsh-client-runtime`。迁移过程中还暴露了三处方案未预见的 alpha 改名（`ToolCallId`、session-projection 的 state/wire 拆分、client 模块图的包迁移），并在同一变更内完成对齐。

### settings 调用点：自由函数 → provider 方法

`src/context/index.ts` 与 `src/review/index.ts` 按上游仓库内的标准消费者写法调用 settings 接线（参照 `~/deepseek-harness/packages/web/web-search-deepseek/src/index.ts`）：

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
})
```

`SettingsSectionHooks` 形状与 rc.8 逐字段一致（`setSource`、`onChange`、可选 `validate`），hooks 对象原样保留。`inject(['settings'], …)` 守卫替代了自由函数内部的"可选服务"查找：没有挂载 settings provider 时回调不会执行，消费者沿用组合条目配置。四个模块各自以 type-only 方式导入 `@deepseek-ai/dsh-settings`，在值导入消失之后让 `Context.settings` 的声明合并仍留在编译程序里。

### 命名空间常量：品牌 helper → 纯字符串字面量

`src/tool/index.ts`、`src/notes/index.ts`、`src/context/index.ts`、`src/review/index.ts` 中的 `settingsNamespace('memory')` / `settingsNamespace('memory-review')` 改为纯字符串字面量 `'memory'` / `'memory-review'`。`ctx.settings.get(ns)` / `sctx.settings.get(ns)` 读取不变；字面量类型满足 `SettingsNamespaceInput` 语法校验。

### 依赖范围：alpha 渠道

全部 `@deepseek-ai/dsh-*` peer 与 dependency 从 `^0.1.0-rc.5 || ^0.1.1-rc.1` 切到 `^0.1.2-alpha.2`；`@deepseek-ai/cordis`（`^4.0.1`）与 `@deepseek-ai/schemastery`（`^3.18.1`）保持 vendored 版本线。`@deepseek-ai/dsh-client-runtime` 从 devDependencies 中移除——它在 alpha 渠道未发布且已被上游删除（commit `be531688f3` "refactor(client): migrate consumers and remove Runtime"，2026-08-22）——由 `@deepseek-ai/dsh-client-store` 取代。README（英文与中文）在安装前置要求与已知限制中写明渠道要求。

### 方案未预见的两处改名

- **`CallId` → `ToolCallId`**（`@deepseek-ai/dsh-llm`）：测试文件通过 `import { ToolCallId as CallId }` 以旧名导入品牌函数，调用点保持不变。
- **session-projection 的 state/wire 拆分**：`ProjectionDefinition.schema` 变为 `stateSchema`（校验持久化状态），`view` 移入可选的 `wire: { viewSchema, view }`——`SessionProjectionMap`（客户端可见键）与 `SessionProjectionStateMap`（宿主状态）从此是两个集合。`memory-review-candidates` 单元是 host-only：accumulator.ts 声明 `SessionProjectionStateMap`（不是 wire map），注册省略 `wire`，review 抽干改读 `projections.stateOf(session, key)` 而非 `snapshot()`——alpha.2 的 `snapshot()` 只遍历 wire 可见单元，host-only 单元对它不可见。

### client bundle：脱离被移除的 `dsh-client-runtime`

提案中延后验证的一步发现 client-runtime 已被上游移除。迁移把每个导入映射到它的 alpha.2 归宿：

| rc.8 导入 | 0.1.2-alpha.2 归宿 |
|---|---|
| `createSnapshotStore`、`SnapshotStore` | `@deepseek-ai/dsh-client-store`（主入口；Node 可导入，默认同步 flush） |
| `SettingsScope`、`SettingsScopeSnapshot` | `@deepseek-ai/dsh-client-ui-settings/client`（契约不变：`getSnapshot`/`subscribe`/`set`/`unset`） |
| `ClientContext` | `@deepseek-ai/cordis` 的 `Context`（client 面；经 type-only 导入获得合并） |

bundle 格式本身无需改动：`window.__ModuleLoader__.load({ id, factory })` 与 `factory(require)` 形状在 alpha.2 未变（`~/deepseek-harness/packages/client/modules/src/client/manifest.ts` 的 `ClientBundleRegistration`）。`scripts/build-client.cjs` 的 externals 与 `dsh.client.inject` manifest 字段把 `dsh-client-runtime` 换成 `dsh-client-store`。vitest 的 `dsh-client-runtime/client` stub 已删除：真实的 `@deepseek-ai/dsh-client-store` 是 Node 可导入的普通 ESM，jsdom 套件直接驱动已发布的实现。

## 曾考虑的替代方案

**留在 rc/next 渠道，沿用旧 API。** 否决。npm 的 `next` dist-tag 指向 `0.1.1-rc.2`，harness 的后续工作已经离开该线；插件将只能运行在一个不再发布新版本的渠道上，而既定目标就是对齐 0.1.2-alpha。

**双路径代码同时支持 rc 与 alpha**（`typeof ctx.settings?.installSection === 'function' ? … : installSettingsSection(…)`）。否决。这会在同一代码库里为一个缝隙种下两套词汇——正是上游 no-alias 政策要防止的状态——并且为"已发布消费者为零"的受众翻倍测试面。

**在本地基于 `register` 重新实现被移除的 helper**，保留自由函数调用形态。否决。它复制了 harness 现在由 provider 服务自己拥有的 helper，本地副本会偏离上游语义（provider 丢失时的回退、经由 owner fiber 状态的卸载抑制），且没有测试把它与真实实现绑定。

**等 0.1.2 stable 发布后再动代码。** 否决。插件在用户正在采用的 alpha 渠道上已经是坏的，迁移小而机械，目标 API 已在树内发布并有文档——等待只会延长坏窗口。

## 测试

- 完整 vitest 套件对已发布的 0.1.2-alpha.2 产物全绿（488 个测试、26 个文件；跳过的一个套件是需要真实 API 的 judge）。
- `tests/settings-live.spec.ts` 新增 provider 卸载回退测试：挂载 provider 时用户覆盖实时生效；provider fiber dispose 后所有消费者重新读回组合条目配置——钉住 `installSection` 的 detach 接线与 tool 插件的命名空间读取回退。
- `npm run build`（对 `src/` 以 alpha.2 声明做 tsc，随后 esbuild client bundle）通过；client 套件驱动真实的已发布 `dsh-client-store`。

## 后果

买到的：

- bundle 在 harness `alpha` 渠道下可加载：先前失败的四个单元（`tool-memory`、`memory-review`、`memory-notes`、`memory-context`）只导入 `0.1.2-alpha.2` 中存在的名字，settings 接线保持其可观察契约——以组合条目为 `base` 注册、无 provider 或 provider 卸载时回退、按事件/调用实时重读。
- client bundle 对 alpha 客户端包可编译，加载器契约不变；settings 卡片的 `SettingsScope` 面完全兼容。

付出的：

- **rc/next 渠道被切断。** `installSection` 只存在于 0.1.2-alpha 的 provider 上，peer 范围无法服务 rc 用户；未来若有 rc 线消费者，需要新的笔记。
- **alpha 线是移动靶。** 后续 `0.1.2-alpha.x` 升级需要把 peer 包导出与问题章节的符号清单加 `ToolCallId` 与投影 state/wire map 重新 diff。
- **client bundle 是构建级验证，不是运行级验证。** 套件在 jsdom 中覆盖 store 与组件，但没有测试驱动 bundle 穿过真实的 alpha.2 web 宿主模块系统；与 alpha 宿主的第一次交互式会话是剩余的证明。
- **仍欠一次版本号提升。** 本次变更对 rc 用户是破坏性的，下一次发布必须带版本提升与渠道说明；版本号由发布流程决定。
