# Agent Note: janitor 在写入链槽位上决定衰减,而非遍历快照

Status: implemented

[English](2026-09-01-janitor-pin-toctou-write-chain-reread.md) | 中文

## 问题

janitor 的 pin 豁免是对实时迭代做 check-then-act:循环从快照读到 `entry.pinned === false`,然后一个 `await`(持久写/审计)把这个检查与写入隔开。落在该窗口内的 pin——用户在 janitor 通道进行中 pin 条目——会被忽略:条目被硬衰减(project 作用域,删除)或软衰减(global/user,打出退出注入面的戳),尽管用户刚 pin 了它。同一窗口也让衰减戳在并发下失去幂等:两个决策在同一快照上竞争。

## 决策

快照迭代只做候选预筛(超期、未衰减);每个写入决策移到写入链槽位,经表的原子 read-modify-write(`KvTable.update`)——召回戳已采用的同一纪律:

- **软衰减(global/user)是每条目一次原子 RMW。** transform 重读当前记录并就地决策:仍在衰减窗口内(含基于重读记录计算的 `importance` 4–5 1.5× 宽限)→ 原样;`pinned` → 原样;已衰减 → 原样;否则盖章。pin 检查与盖章不再可能交错。
- **硬衰减(project)先跑守卫。** `KvTable.update` 表达不了删除,所以守卫 update 在其槽位重读 `pinned`、pinned 则原样返回——只有守卫观察到未 pinned 时才执行删除。守卫槽位与删除槽位之间的窗口仍在;宿主原语(`put`/`update`/`delete`)没有比"守卫→删除"更窄的原语,所以代码如实记录这一残余,不声称竞态已关闭。
- 失败经既有 `janitor` 站点上报;快照与槽位之间被别人删除的记录是正常生命周期终点,静默跳过。

## 曾考虑的替代方案

- **await 之后再核一次 pinned(写后验证)。** 否决:删除已落地后再发现 pin,需要表不具备的回滚机制,而且软衰减的戳仍是丢失更新竞态。
- **跨 janitor 通道持有插件侧锁。** 否决:单进程写序是域写入链的职责;再建一套锁会重复它,而且仍然约束不到 remote 的 `pin` 路径。
- **把整个 janitor 决策集快照后无 await 地应用。** 否决:审计追加与持久写天然异步;去掉 await 会把无界的审计工作缓存在内存里。

## 后果

- 与 janitor 通道竞争的 pin,只要落在决策槽位上或之前就被尊重;唯一残余暴露是硬衰减守卫→删除的间隙,代码已记录且受宿主原语集合封顶。
- janitor 的每条目工作现在是一次写(project 是一次守卫 + 一次删除),与其他全部变更排在同一条写入链上——没有新的同步面。
- TOCTOU 契约测试经拦截桩把 pin 落在 janitor 自己的写入链槽位内,真正区分槽位重读与快照判定(经变异验证)。
