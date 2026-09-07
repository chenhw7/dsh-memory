# Agent Note: sqlite 迁移残留使已迁移 home 的第二次启动即砖

Status: implemented

[English](2026-09-07-sqlite-migration-leftovers-brick-reopen.md) | 中文

## Problem

Step 3.2 的迁移把宿主介质逐条导入 `memory.db` 并写入 `medium:migratedToSqlite` 标记，但**没有清空**介质侧的 `entries`/`audit`/`suggestions` 三张表。两侧 guard——数据与标记并存即 fail loud，其前提是"迁移后某个 host-medium 进程又写了 memory.json"——于是无法区分这个真实冲突与"介质自己的迁移前残留遇上了无辜重开"。迁移后的每一次 sqlite 启动都会在插件启动处抛错：真实部署里，带着存量数据切到 `storage: 'sqlite'` 的用户**第二次**会话即被砖，错误信息还让人去调和两个从未分叉的 store。任何 vitest 通道都抓不到它：`tests/migration.spec.ts` 断言完标记就 dispose（全程没有第二次 sqlite 启动），contract 套件每个用例开全新数据库，单元测试不成组合。只有"同一 home 上二次开 store"的组合才会踩中这个状态。

[write-path rework](../architecture/2026-09-04-write-path-rework-implementation-plan.md) Step 3.3 的机械验收——host-medium 对 sqlite 的全量 mock A/B——恰好就是这个组合：plant 链先开会话 1（对话埋点），dispose 后在**同一个 `$DSH_HOME`** 上重开会话 2 问 standing 问题。sqlite 侧首轮在 4/32 个 core 场景的会话 2 启动处失败：`JSON-RPC -32603: cannot create effect on inactive context`——启动抛错销毁了插件的 cordis 上下文，runner 的下一个 RPC 撞上尸体。这四个——prog101-build-toolchain、prog112-lint-rules、prog116-cache-invalidation、work208-1on1——恰好是语料里全部四个**带种子条目的 plant 场景**：唯一"有数据的介质"遇上"二次开 store"的行。noise 语料（plant、无种子）从不迁移，早已逐场景相等。

## Decision

迁移 boot 在逐条导入之后、写标记**之前**清空介质的三张数据表（`src/store/index.ts` 的 `storage === 'sqlite'` 分支）。两侧并存状态从此只可能来自迁移后的真实写入者，guard 的错误文本从此名副其实。先清后写标记的顺序让每个崩溃窗口都良性收敛：导入后、清空前崩溃——介质无标记且有数据，下次启动幂等重导入（`INSERT OR REPLACE`）；清空后、标记前崩溃——介质空且无标记，下次启动跳过导入，数据已在 `memory.db`。反过来先写标记会把砖窗口原样造回来。

eval 侧随之而动：`readStoredEntries`（`eval/harness/seed-media.ts`）在 `memory.db` **文件存在时读数据库**——文件存在性就是后端信号（host-medium 运行从不创建它；noisy 链无种子不迁移，数据只会在库里）——否则读 `memory.json`。若继续读被清空的介质，A/B 的 medium-diff 层会变成满屏 0-vs-N 的假差异。

## Testing

`tests/migration.spec.ts` 用例 1 现在断言介质三张表已清空、标记保留，然后在同一 home 上**重开** sqlite 组合——即 eval 的会话 2 流程——断言 store 仍能读出两条导入条目；另两个迁移态（host-medium 踩标记介质、两侧并存）不变，后者从此只能手工或真实第二写入者构造。未修复树上红（重开用例失败——启动抛错），修复后绿；全量 **949 passed | 6 skipped (955)**。修复后重跑 A/B：core-v0（32 场景）与 noise-v0（6 场景）均**逐场景 deterministic EQUAL、零错误**（`diffReports`；host-medium 对 sqlite pin，pin 走 profile-template 的测量接缝）。

## Alternatives considered

- **先写标记、后清空。** 否：两次发布之间的窗口还是同一块砖，只是搁浅在迁移中途。
- **重开时调和（介质 ⊆ 数据库 ⇒ 视为残留，清掉继续；有分叉 ⇒ 抛错）。** 否：子集语义让冲突检测变糊（部分过期写入会混进"残留"），每条崩溃路径都留着过期副本，guard 从不变量退化成比较器。迁移时清空让每个事实只有一个可达状态。
- **保留数据，文档写明"迁移后手工清掉 memory.json 的行"。** 否：迁移受众下一次会话即砖，且永远不会有自动化路径去清这个文件；导入是单一已验证事务，清空不是数据丢失。
- **批量清表。** 不存在：domain 的 `KvTable` 只提供逐键 `delete(key)`；清空就是逐键发布的循环。

## Consequences

- 带存量数据的 store 切 sqlite 后能活过分次启动——P1 关闭。`docs/HOST_CONTRACT.zh.md` §11 的分界句（"`memory.json` 只留迁移标记"）本来就是为这个终态写的；`TECH_DESIGN`（双语）现在把清空动作写成明文。
- 清空在 storage-json 上花费每键一次发布——一个满额 store 最多约 900 次全文件发布（500 条目 + 200 审计 + 200 建议），一次性迁移成本，与[写放大重基线](../architecture/2026-09-04-write-path-rework-implementation-plan.md)计量的是同一种货币；host-medium 的迁移路径是旧介质写放大仍然适用的唯一流程。
- 清空与写标记之间的崩溃窗口（两次 awaited 发布之间）留下一个空且无标记的介质：host-medium 的混版本 guard 在下一次迁移重新武装之前处于未武装状态。毫秒量级、尽力而为，记录于此而非闭合。
- mock A/B 相等性从此覆盖全语料的两个后端，包括那四个 plant+seed 行；机械通道结果与剩余的 judged baseline 记录在 [write-path rework 笔记](../architecture/2026-09-04-write-path-rework-implementation-plan.md)。
