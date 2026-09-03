# Agent Note: Audit-cap test seeds the medium

Status: implemented

[English](2026-09-03-audit-cap-test-seeds-medium.md) | 中文

## 问题

§3.2 的 audit 上限集成测试用最贵的方式制造溢出：205 次串行的真实 `store.add`。每次 add 都会让 storage-json 以原子写（临时文件 + fsync + rename + 目录 fsync）重新发布整个单文件 medium，于是这个测试为本质上是一次裁剪行为的断言付出了约 415 次持久化整文件发布。在 CI lane 上，这笔开销顶在 vitest 继承的 5 秒预算上（用例没有显式超时）：2026-09-02 的 run 里 1706 ms，2026-09-03 的 run 里循环中途被 5016 ms 掐断——这是该用例自落地（2026-08-20）以来观测到的第一次 ci.yml 失败，且其余 823 个测试全绿。触发因素是负载而非代码：同一次 push 新增了四个并发 eval spec 文件（+56 个测试；全 suite 测试时间 10.5 s → 19.1 s），把最吃 fsync 的用例在争用 runner 上推过了预算线。此后每次 push 都背着同样的 ~3× 起伏贴线运行。

## 决策

`tests/integration/composition.spec.ts` 在 medium 上预置溢出，而不是现场制造。用例先 dispose 已启动的 composition，向私有临时根写入一份 version-0 的 `memory.json`（携带 204 条 schema 合法的 audit 记录：`fact 0`–`fact 203`，seq 1–204），在同一目录上启动一套全新的真实 composition，然后落地一次真实 add（`fact 204`）。断言与旧形态逐字一致：audit 表恰好 200 条、刚写入的记录在头部、最老的幸存者是 `fact 5`。预置还顺带驱动了 `nextAuditSeq` 从 medium 的惰性初始化——真实 add 必须从 seq 205 续号——这是 205-add 形态从未覆盖的路径。持久化发布从约 415 次降到 7 次（一次 entry put、一次 audit put、五次 audit delete）。

## 备选方案

**抬高该用例的超时**（约 20 s，注释写明等待的工作）。按测试可靠性 skill 的标准这是合法的——指明等待的工作、恢复预算不算 flake 掩盖——且保留了附带的小型持续写入压测。但它让每次 push 继续为约 415 次 fsync 发布买单，还在 suite 里放了一个主观的预算字面量。输给预置：预置移除成本，而不是为成本做预算。

**把循环缩到 201 次。** 仍有约 400 次发布，省约 2%，没有意义。

**抬全局 `testTimeout`。** 全 lane 只有一个用例被持久化 I/O 绑住，却把预算让所有用例共享；被 I/O 绑住的用例应该在用例处说明。

**给 JSON 发布加批量或防抖。** 为了服务一个测试去改变已发布的 durability 契约——每次变更返回即崩溃持久。直接否决。

## 后果

- 全 suite 最重的用例从本地隔离 1240 ms / CI 被 5016 ms 掐断降到隔离 52 ms；整个 composition 文件从 3.0 s（2026-09-02 CI）/ 7.9 s（2026-09-03 失败 run）降到约 1.0–1.5 s。
- 放弃的东西：vitest lane 里不再存在 205 次变更的持续写入小型压测。逐变更的 audit 追加行为仍由小 N 的同组用例钉住（add/update/remove/readRaw 各恰好一条记录）；压力证据归属 eval 与 pre-push lane，不归单元层用例。
- 预置数据是 durable 格式 fixture：必须始终满足 `auditEntrySchema`，未来 audit 记录结构变更时须在同一次变更里更新它，与其他落盘 fixture 同规。

## 测试

- `tests/integration/composition.spec.ts` 全绿（41 个用例，含重写后的该用例）；完整 vitest lane 通过（41 个文件 + 1 个 env 门控跳过）。
- 裁剪路径被真实驱动：add 之后 medium 持有 205 条 audit 记录，若 `trimAudit` 停止裁剪，长度 200 的断言即失败（已通过临时负向对照观测），头/尾断言钉住被淘汰的正是最老五条。
