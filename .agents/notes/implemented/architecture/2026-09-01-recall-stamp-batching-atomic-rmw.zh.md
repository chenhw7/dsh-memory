# Agent Note: 召回戳改经表的原子 read-modify-write 落写

Status: implemented

[English](2026-09-01-recall-stamp-batching-atomic-rmw.md) | 中文

## 问题

`stampRecalled` 对每个盖章命中用 `KvTable.put` 写入,而它持有的是 search 时刻捕获的 `MemoryEntry` 引用。这一个选择同时带来两个缺陷:存储后端的 `single` 布局下每次 `put` 都重发布整个 unit 文件,一次 50 条命中的搜索扇出为 50 次整文件重写(写放大随命中数增长);落在 search 与戳之间的 `memory_replace` 被静默回滚——戳用它持有的过期快照覆盖了刚编辑完的记录。跳过条件(`lastRecalledAt === now`)对两者都无能为力:它比较的是时间戳,不是内容。

## 决策

盖章通道改经表的原子 read-modify-write(`KvTable.update`)而非 `put`。宿主保证 `update` 的 transform 在其写入链槽位上运行并读取彼时的当前记录,因此:

- **丢失更新消失。** 在戳的链槽位之前落地的 `memory_replace` 会被 transform 读到并保留在盖章后的记录里——两个交错方向(先改后戳、先戳后改)都有契约测试钉住。
- **每次盖章通道对每个有变化的条目恰好一次持久写。** 已携带本通道时间戳且无衰减戳的条目在 transform 里原样返回,并在快照预检处跳过、不进写入链;超出"每条目一写"的扇出消失。
- **失败保持可观测。** 盖章途中 id 消失(正常生命周期终点,不上报)或介质拒绝(经 `reportFailure` 记为 `recall-stamp` 站点)都不会破坏 fire-and-forget 契约。

这是对写机制的保持行为的修改,不改写语义:同样的字段在同样的条件下变化,新的是写原语与"写前重读"的纪律。它清除了 `index-default` 超越性提案的前置。

## 曾考虑的替代方案

- **给存储后端加批量/多记录原语。** 否决:那是宿主侧 API 面(`KvUnit.putRecord` 是唯一的记录原语);插件加不了,而原子 RMW 已把每条目的损害封顶。
- **在插件侧用定时器延迟/合并盖章。** 否决:它会推迟 janitor 与排序读取的持久性,新增需要 dispose 的定时器,而且仍然是整条记录写入——RMW 不需要新机制就拿到了正确性。
- **只对 top-k 命中盖章。** 否决:那改变的是召回元数据语义(哪些条目算被召回)而不只是写路径——超出本条目范围。

## 后果

- 盖章的写次数现在是每次通道每条变化条目恰好一次;剩余的放大(50 条命中在 `single` 布局下写 50 次)由后端而非插件封顶——大库的既定迁移杠杆是 `per-record`/SQLite 后端选择(`scale-trigger-selfcheck` 的辖区)。
- `KvTable.update` 在 key 缺失时拒绝;盖章把这种情况当作正常生命周期终点,其余失败经 `recall-stamp` 上报。
- 仓库内六个 `memTable` 测试桩都实现了 `update`;新的 provider 测试桩也必须实现,否则召回盖章会一路失败上报而不是盖成章。
