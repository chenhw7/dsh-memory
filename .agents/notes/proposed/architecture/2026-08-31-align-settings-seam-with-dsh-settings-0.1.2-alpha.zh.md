# Agent Note: 对齐 @deepseek-ai/dsh-settings 0.1.2-alpha 的 settings 缝隙

Status: proposed

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

## 方案

让插件对齐 0.1.2-alpha 的 settings API，并要求 alpha 渠道。四个 coordinated 变更：

### 1. 调用点迁移：自由函数 → provider 方法

在 `src/context/index.ts` 与 `src/review/index.ts` 中，把

```ts
installSettingsSection(ctx, NS, Config, config, hooks)
```

替换为上游仓库内的标准消费者写法（参照 `~/deepseek-harness/packages/web/web-search-deepseek/src/index.ts`）：

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, NS, Config, config, hooks)
})
```

首参变为 `owner`（消费者 context，调用点现在传的就是它）。`SettingsSectionHooks` 形状——`setSource`、`onChange`、可选 `validate`——在 rc.8 与 0.1.2-alpha.2 之间逐字段比对完全一致，hooks 对象原样保留。`inject(['settings'], …)` 守卫替代了自由函数内部的"可选服务"查找：没有挂载 settings provider 时回调不会执行，消费者照旧回退到组合条目配置，语义与之前完全一致。

### 2. 命名空间常量：品牌 helper → 纯字符串字面量

`src/tool/index.ts`、`src/notes/index.ts`、`src/context/index.ts`、`src/review/index.ts` 中的 `settingsNamespace('memory')` / `settingsNamespace('memory-review')` 改为纯字符串字面量 `'memory'` / `'memory-review'`。`ctx.settings.get(ns)` 在 0.1.2-alpha.2 中仍然存在，且现在接受普通字符串，tool、notes、review 的读取路径保持可用。语法校验转移到类型层（`SettingsNamespaceInput`）加上 `register`/`installSection` 内部的运行期 `parseSettingsNamespace`。

### 3. 依赖范围：要求 alpha 渠道

`installSection` 只存在于 0.1.2-alpha 的 provider 上（rc.8 只有自由函数），对齐后的代码无法在 rc 线上运行。删除 rc peer 范围，要求 alpha 渠道：

- `peerDependencies`/`devDependencies`：`@deepseek-ai/dsh-settings`（以及同族 `@deepseek-ai/dsh-*` peer）→ `^0.1.2-alpha.2`，替换 `^0.1.0-rc.5 || ^0.1.1-rc.1`。
- 在 README 中（现有的 storage/headless 说明旁）写明渠道要求。

### 4. 次要对齐（同一变更内，单独验证）

- `@deepseek-ai/dsh-client-runtime` devDependency 仍是 `^0.1.0-rc.8`；升到 alpha 线，并对照 alpha 客户端包重新验证客户端注入列表（`dsh.client.inject`：`ui-settings-plugins`、`ui-settings` 等）与 `src/client/NamespaceCard.tsx`。
- 重新核对其余导入面。截至 0.1.2-alpha.2，本仓库导入的其他符号全部健在：`defineTool`、`BlockAssembler`、`createUserMessage`、`Message`、`GenerateOptions`、`Remote`、`TypertRemoteService`、`Session`、`SessionEvent`、`InvariantInstaller`、`InvariantFailure`、`Branded`、`Agent`、`AssembleContext`。settings 缝隙是唯一的加载期断点；今后每次 alpha 升级，按提案 §4 的方式对 peer 包 `src/index.ts` 导出与该清单做 diff 确认。

## 曾考虑的替代方案

**留在 rc/next 渠道，沿用旧 API。** 否决。npm 的 `next` dist-tag 指向 `0.1.1-rc.2`，harness 的后续工作已经离开该线；插件将只能运行在一个不再发布新版本的渠道上，而既定目标就是对齐 0.1.2-alpha。

**双路径代码同时支持 rc 与 alpha**（`typeof ctx.settings?.installSection === 'function' ? … : installSettingsSection(…)`）。否决。这会在同一代码库里为一个缝隙种下两套词汇——正是上游 no-alias 政策要防止的状态——并且为"已发布消费者为零"的受众翻倍测试面。

**在本地基于 `register` 重新实现被移除的 helper**，保留自由函数调用形态。否决。它复制了 harness 现在由 provider 服务自己拥有的 helper，本地副本会偏离上游语义（provider 丢失时的回退、经由 owner fiber 状态的卸载抑制），且没有测试把它与真实实现绑定。

**等 0.1.2 stable 发布后再动代码。** 否决。插件在用户正在采用的 alpha 渠道上已经是坏的，迁移小而机械，目标 API 已在树内发布并有文档——等待只会延长坏窗口。

## 验收标准

- 七个 bundle 单元（`memory-root`、`memory-store`、`tool-memory`、`memory-review`、`memory-notes`、`memory-context`、`memory-remote`）在 `0.1.2-alpha.2` 的 harness 树上全部加载、挂载无错。
- vitest 全绿，包含 settings 接线覆盖：挂载 provider 时附加（以组合条目为 `base` 注册命名空间）、无 provider 时行为（消费者沿用条目配置）、settings 提交变更后重新判定派生状态。
- 与 alpha 渠道 harness 一同安装 bundle 时，`@deepseek-ai/dsh-settings` 无 peer 范围告警。
- README 写明所需的 harness 渠道（`alpha`，`0.1.2-alpha.x`）。

## 风险

- **alpha 渠道是移动靶。** `0.1.2-alpha.x` 在 0.1.2 stable 之前可能继续改名。提案 §4 的逐次导出 diff 是 containment；本笔记的符号清单即核对清单。
- **删除 rc peer 范围会切断 `next` 渠道用户。** harness 侧不会再发布 rc 线版本；跟随 alpha 线的预发布插件没有失去任何会被维护的东西。
- **settings 接线时机改变形态。** `installSection` 现在在 settings 服务出现时执行（经 `inject`），而不是消费者自身 attach 时带内部缺失检查。可观察契约相同——以条目为 `base` 注册、provider 丢失时回退、`onChange` 重新判定——但 attach 顺序假设需要验收标准中点名的测试来钉住。
- **客户端侧漂移未在此完全覆盖。** client bundle（client-runtime、UI 注入列表、`NamespaceCard`）在同一变更内验证，但属于另一表面；在那里发现的任何改名按本笔记的模式处理，而不是扩张本笔记。
