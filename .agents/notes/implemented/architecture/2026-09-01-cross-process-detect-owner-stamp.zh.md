# Agent Note: 跨进程单写者违规只检测,不加锁

Status: implemented

[English](2026-09-01-cross-process-detect-owner-stamp.md) | 中文

## 问题

宿主 storage-json 后端跨进程是 last-writer-wins,双开守卫又是进程内 Map:两个 DSH 进程共享一个 `$DSH_HOME` 时,各自持有权威内存态、每次写都整文件重发布,静默互相覆盖。宿主没有任何检测,插件也加不了锁(宿主 unit 契约没有 CAS 原语,文件是共享状态)。改进计划裁定:在插件层检测与告警,不做锁。

## 决策

store 插件在打开时用 boot owner stamp(`pid`、`startedAt`、`bootId`)**认领记忆域的 global 槽**,并按轻量间隔(`crossProcessProbeMs`,默认 60 s,`0` 关闭;每 tick 一次 `readFile`——写路径零新增 IO)从**介质文件**重读。判定:

- 有效外来 stamp + 无 `closedAt` + **pid 仍存活** → 活着的并发写者;经 `reportFailure('cross-process')` 走 structured-logging 通道(logger warn + `backgroundFailures`)每次 boot 告警一次。
- 有 `closedAt` → 前驱干净退出;pid 已死 → 前驱崩溃。两者都是重启场景,保持静默——同一规则也原谅本进程自己崩溃过的前驱,同机重启不产生误报。
- 每个 boot 至多一次;重启复位。检测永不加锁、永不阻塞写;单元测试默认无探测(`dshHomePath` 缺席 → 两个介质接缝都是 `undefined`,只有内存内的启动判定运行)。

干净 dispose 时,`closedAt` 经专用写入器**直接写到介质文件**——派生自基础 bundle 给 storage 行 root 用的同一个 `dshHomePath('storages','memory.json')` 表达式。goodbye 刻意不走域的 global 写:storage 设施的卸载与我们的 disposer 并发关闭域(兄弟 fiber,无顺序保证),域写入在多数 dispose 运行中会以 `closed` 被拒——介质文件是唯一在拆卸期仍有效的接缝。boot 身份每次 mount 只铸造一次,由 claim 与 goodbye 共享;第二次 `currentBootOwner()` 会铸造新 id,写入器会(正确地)拒绝盖章。

global 槽随域 spec 以**零版本提升**加入:旧介质直接重开(缺失 global 是 spec 的"从未写过"路径),空介质物化时机提前——claim 使 `memory.json` 在 mount 时即存在,host 集成断言同步了一处。

## 曾考虑的替代方案

- **文件锁(flock/lockfile)。** 被计划裁定否决:介质语义归宿主层;插件侧锁会在崩溃后留下陈锁死锁,而且仍约束不到宿主自己的写入者。
- **任何外来 stamp 都告警。** 否决:本进程每次重启都会触发(新 boot 读到自己崩溃前驱的戳)——pid 活性检查正是区分"另一个写者"与"我的过去"的依据。
- **经域的 global 读探测。** 无用:域读来自内存权威态,永远看不到另一进程的发布;介质文件是唯一的跨进程证人。

## 后果

- 两个活并发写者表现为每 boot 一条带外来 pid 的告警;第二个写者仍然赢得文件(检测而非阻止)——记录在案的升级路径是运维分离 `$DSH_HOME` 或迁移介质。
- 崩溃前驱的 pid 被操作系统复用可产生一次误报;每 boot 一次把它封顶为单条。
- claim 使 `memory.json` 在 mount 时物化(此前惰性到首写);断言文件存在性的工具会更早看到文件。
- goodbye 的整文件重写镜像了后端的内容而非其原子协议:goodbye 中途崩溃最坏撕坏一个戳,pid 死亡规则已原谅这种损失。
