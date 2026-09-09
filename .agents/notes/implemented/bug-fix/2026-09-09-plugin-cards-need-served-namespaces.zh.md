# Agent Note: Plugin cards need a served settings namespace each

Status: implemented

## Problem

本 bundle 的客户端向 `settings.plugin.item` 注册了五张卡片，但实机控制台的插件配置页只有两张渲染过：*Memory* 与 *Automatic Extraction*。*Project Notes*、*Auto Recall*、*Identity* 三张卡（身份卡正是本分支的新表面）静默缺失——插件配置页毫无痕迹、没有报错、控制台日志干净。README 与客户端头注释声称的"五张卡"在已安装的 harness 线上从未成立：根因早于身份层。

机制：宿主的插件配置页按「**一 namespace 一卡**」分发 `settings.plugin.item`——卡片只有在其 slot key 指向 Host 已注册的 settings namespace 时才渲染（对 `settings.describe` mirror 做 `served.has(entry.options.key)`，`ui-settings-plugins/src/client/tab-store.ts:89-91`；每 namespace 一次 `renderSlot` 分发，`ConfigurablePluginsTab.tsx:37`；keyed 槽位只渲染第一个匹配 key 的条目，`ui-renderer/src/client/scoped-slots.tsx:800-806`）。本 bundle 宿主侧只注册了两个 settings namespace（`memory`、`memory-review`），却把三张子卡 keyed 为 `memory-notes` / `memory-autorecall` / `memory-identity`——全部绑定 namespace `memory`。不是已注册 namespace 的 key 被静默丢弃：无报错、无卡片、日志无痕。

## Decision

每张卡一个 settings namespace。`memory-context` 在宿主侧注册完整的 memory 家族——四次 `installSection`（`memory`、`memory-notes`、`memory-autorecall`、`memory-identity`）——且每张客户端卡的 slot key 就是它的 namespace：

- **Schema 片段，每个默认值一个家。** 组合 `Config` schema 由四个共享字段片段组成（`src/context/index.ts` 的 `INJECTION_FIELDS`/`NOTES_FIELDS`/`AUTORECALL_FIELDS`/`IDENTITY_FIELDS`），各 namespace 的 schema 复用同一批片段——组合层与四个 namespace 不会漂移。
- **组合配置保持一份完整形状。** `MemoryConfig`（现为四个切片接口的交集类型）仍是 cordis 组合配置与插件内部的设置视图；每个 namespace 的 `base` 层是它的投影（`injectionEntry`/`notesEntry`/`autoRecallEntry`/`identityEntry`），`current()` 把四路 live scope 源合并回所有消费方已经在读的那个 `MemoryConfig` 形状。组合键的家不变（`memory-context` 行的 `config:`），既有的 `cordis.yml`/patch 配置与 eval 覆盖原样可用。
- **跨 namespace 读取方跟随自己的键搬家。** identity 插件读 `memory-identity`（经 `resolveIdentitySettings`），notes 插件读 `memory-notes`（经 `resolveNotesSettings`），`tool-memory` 的身份门/预算读 `memory-identity`——同一套防御性 `ctx.settings.get` 模式，只换 namespace。`decayDays` 留在 `memory`（review janitor 的读取不动）。
- **客户端：卡片 key 本就匹配。** 客户端 `CARDS` 条目现在直接 `ctx.settingsScope.bind({ namespace: card.key })`（`namespace` 覆盖项整个删除——每张卡的 key 与 namespace 是同一个字符串），策展 `MemoryPluginCard` 的 wire 类型/默认草稿删掉它从未渲染过的已搬字段。
- **迁移不是事件。** 旧部署的用户文档可能在 `memory:` section 下仍带着已搬走的键；schemastery 对象对未知键直接透传（已对装机 schemastery 核实），它们惰性存在、启动不会失败。无迁移代码。

## Alternatives considered

- **把三张子卡并进策展 Memory 卡。** 丢掉文档承诺的每卡表面（README 的五卡承诺），且让本分支的交付物 Identity 卡不可达。否决。
- **放宽宿主的分发规则**（渲染全部已注册条目，或去掉 served-namespace 配对）。配对是宿主有意的校验——本部署未组合的插件不应在插件配置页留下痕迹——且 harness 仓库不由本仓库改动。否决。
- **identity 插件自持 `memory-identity`。** 会撞上两条已交付的约束：装载期种子目录 loud 门必须住在 `memory-context` 的 apply（cordis 会吞掉 `ctx.inject` 回调的 throw——运行时核实过），且 identity 插件没有自己的组合配置（身份键搭在 `memory-context` 行上），base 层无从取值。`memory-context` 持有全部四个 namespace，把设置所有权留在消费方所在处。

## Consequences

- 五张卡在已安装 harness（dsh-v0.1.2-alpha.2）上全部渲染；回归由 `tests/settings-live.spec.ts` 钉住：四 namespace 配对测试（`settings.describe()` 必须列出每个卡片 key；策展 `memory` schema 不得再携带已搬键）、对 `memory-autorecall` 的实写驱动 pre-step 围栏、对 `memory-identity` 的实写接通身份快照。消费方的 namespace 切换由 identity/notes/tool 规格里 namespace-aware 的 settings fakes 钉住。
- 用户文档的布局改变形状：`$DSH_HOME/settings.yaml` 现在每 namespace 一个 section（`memory-notes:` 等）。遗留的 `memory.notes*`/`memory.identity*`/`memory.autoRecall*` 用户键惰性 resolve（默认值生效）——手工设置过这些键的部署需在新 section 里重新固定。
- 测试里的 settings-fakes 约定自此 namespace-aware：对任何 namespace 都返回同一对象的 fake 恰恰会掩盖这一类 bug，因此 fakes 按自己应答的 namespace 取键。
- 分发规则已记入 [HOST_CONTRACT §8](../../../docs/HOST_CONTRACT.zh.md)，下一张卡不会再踩这个错配。

## Testing

`tests/settings-live.spec.ts`（"plugin-card namespaces — one served namespace per card" 下三个新用例）、`tests/identity.spec.ts`、`tests/notes.spec.ts`、`tests/tools.spec.ts`、`tests/tools-confirm-and-window.spec.ts` 中 namespace-aware 的 fakes，以及完整 vitest 套件（1047 例）与两个 tsc 程序、client 打包门禁（`npm run build`）。
