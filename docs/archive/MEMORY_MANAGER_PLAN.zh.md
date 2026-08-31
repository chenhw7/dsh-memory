# 记忆管理中心（Memory Manager）实施规划

> **已归档（2026-08-27）**：一期已随 v0.4.0 发布，实施偏差记录在 §12。本文保留作决策依据；当前行为与接口以 [../TECH_DESIGN.zh.md](../TECH_DESIGN.zh.md) 为准。
>
> 状态：**一期已实施并通过端到端验收**（2026-08-24，验收记录见 §12）。二期（CRUD + 审计）、三期（增强）待启动。
>
> **2026-08-25 更新（一期 UI 迭代，已验收通过）**：应用户反馈，页面信息架构在 §3.2 基础上调整——单 section 内部拆为「概览 / 管理」两个 tab（健康仪表盘独占概览页，工具栏+列表归管理页）；③ 的远程分页取消，改为**懒加载**（纯浏览时按 50 条/批远端追加，搜索/筛选时一次拉全量匹配集后本地逐步揭示）；列表默认**最新在前**（remote `list` 按 createdAt 倒序）。同时修复一个语义 bug：`MemorySearchQuery` 新增 `recordRecall` 开关，`memoryRemote.search` 固定传 `false`——此前在管理页浏览/搜索会把整批命中条目标记为"已召回"并洗掉休眠标记。下文架构图保留原规划供对照。
>
> 本文档是交互式记忆内容管理页面的实施蓝图。目标读者：实施者（人或 agent）。所有集成点均已对照宿主源码核实；一期实测对 §5.1 的两处修正记录在 §12。

## 1. 背景与现状

dsh-memory 已具备完整的记忆**能力面**：三层作用域（`global` / `project` / `user`）、八个模型工具、自动提取、项目笔记、审计日志、安全扫描。但它没有记忆**内容**的管理界面——现有浏览器 UI 只有 Settings → Plugins → Plugin configuration 里的四张**配置**卡片（注入模式、预算、提取开关等），管配置不管内容。

关键事实：**管理 UI 的宿主接缝是预留好的半成品**。

| 已有资产 | 位置 | 状态 |
|---|---|---|
| 三层作用域数据模型 | `src/types.ts` | ✅ project 条目带 `projectName`（= 会话 cwd basename，见 `src/context/index.ts` `projectNameOf`） |
| @Remote CRUD 服务 | `src/remote/index.ts` | ✅ 9 个方法：`list`（分页 + scope/projectName 过滤）、`search`（BM25）、`get`、`add`、`update`、`remove`、`pin`、`health`、`auditLog`。文件头注释明确"面向记忆管理 UI（§3.8）" |
| Typert 客户端贡献物 | `src/typert.remote-client.{d.ts,js}`（`./remote` 导出） | ✅ `TypertRemoteContribution` 已就绪，待浏览器侧挂载 |
| 审计与扫描 | store 层 | ✅ 每次写带 `source`（remote 写入记 `'ui'`）；UI 写入同样过 scanner，拒绝返回 `{ error }` |
| 整页设置区宿主模式 | 宿主 `packages/client/ui-agent-preset` | ✅ `settings.section` slot + Controller/HostObservable 房规可直接参照 |
| 健康统计 | `store.health()` → `MemoryHealth` | ✅ 已含总数/分 scope/置顶/审计数/stale 数（wire 类型缺 stale，见 §4.1） |

**边界声明**：记忆 store 是 **profile 级**的。本页面管理的是 web profile 的整份 store（所有 scope × 所有 project）——即此语境下"整个 DSH 的记忆"。CLI 等其他 profile 的 store 是独立文件，不在范围内。

## 2. 目标与非目标

### 2.1 目标

- **G1**：一个位置浏览**整个 profile 的全部记忆**（三 scope、全项目），带统计、筛选、BM25 搜索、分页。
- **G2**：按**工作区（projectName）**筛选并管理该工作区的记忆。
- **G3**：完整 CRUD：新建、编辑、删除（二次确认）、置顶/取消置顶；写入失败（scanner 拒绝）原因可见。
- **G4**：审计日志视图，回答"这条记忆是哪儿来的"（`tool` / `review` / `flush` / `ui` / `janitor`）。

### 2.2 非目标（本期明确不做）

- 不改动现有四张配置卡片与 Plugins 页签的结构（配置 ≠ 内容，两者并存）。
- 不改 store 数据模型与扫描/审计语义（remote 仅透传）。
- 不管理其他 profile 的 store；不做多用户/权限模型。
- 一期不做实时推送刷新；不做导出/导入、批量操作（三期候选）。

## 3. 产品设计

### 3.1 位置（已确认）

**Settings 新增独立 section「Memory」**（`settings.section` slot，id `memory`）。

现有 `src/client/index.ts` 注释中"有意不建独立 Memory section"的决定针对的是**配置**——配置继续留在 Plugins 页签内不变；**内容管理是新维度**，独立 section 不构成冲突。页面内提供"前往配置"的说明性链接（文案锚定 Plugins 页签）以消除割裂感。

参考宿主现有 order 值：`general = 0`、`plugins = 15`、`agent-presets = 20`。Memory 建议 **order: 25**（实现时按导航观感微调）。

### 3.2 页面信息架构

```
Settings → Memory（新 section）
├── ① 健康仪表盘条
│     总条数 / global·user·project 分布 / 置顶数 / 休眠(stale)数 /
│     审计条数 / 最近活动时间 / 最近提取时间
├── ② 工具栏
│     scope 切换      [全部] [Global] [User] [Project]
│     project 选择器  （scope=Project 或"全部"时可用；数据源 = 新 projects() 方法）
│     搜索框          （BM25，300ms 防抖，区分大小写不敏感）
│     类别筛选        （failure / correction / insight / preference / convention /
│                      tool-quirk / procedure 多选 chips）
├── ③ 条目列表（远程分页，默认每页 100）
│     每行：内容（截断可展开）、scope 徽标、category 徽标、projectName、
│           📌 置顶 / 😴 stale 标记、createdAt / updatedAt / lastRecalledAt
│     行内操作（二期起启用）：置顶切换 / 编辑 / 删除
├── ④ 编辑器抽屉（二期）：scope / projectName / category / content 四字段
└── ⑤ 审计日志抽屉（二期）：最近 100 条（op、source、ts、sessionId、contentPreview）
```

### 3.3 关键交互细则

- **删除必须二次确认**：确认框复述条目前 ~50 字，防误删。
- **写失败必须可见**：`add`/`update` 返回 `{ error }`（含 scanner `[BLOCKED: …]` 原因）时内联展示，不静默吞掉。
- **stale（软衰减）条目**：视觉上灰显 + 😴 标记 + hint"已从注入面隐藏，被召回后自动复活"；数据不删、可正常搜索与编辑。
- **空态**：每 scope 空时给引导文案（如"尚无 project 记忆——在会话里教会我，或点右上角手动添加"）。
- **刷新语义**：section 打开时加载；本页发起的每次变更后重取当前页 + 仪表盘；`connection/reset` 后自动重载。一期不做推送。
- **"当前工作区"预选**：一期显式手选；三期评估从工作区/会话上下文联动预选（见 §6 三期）。

## 4. 技术方案 — Host 侧（`src/remote/`）

写路径**完全复用**现有 store 契约——扫描门控、写串行化、审计追加自动继承，零新增风险面。仅做透传层扩展：

| # | 变更 | 内容 | 理由 |
|---|---|---|---|
| H1 | 新增 `@Remote('projects')` | 返回 `{ projects: string[] }`。remote 层从 `store.list('project')` 聚合 distinct `projectName`——**不改 store** | 项目选择器数据源 |
| H2 | `MemoryEntryJson` 补 `staleSince?: number` | `toEntryJson` 透传 | 列表渲染 😴 标记 |
| H3 | `MemoryHealthResult` 补 `stale?: number` | `store.health()` 已有该字段，wire 类型漏透传 | 仪表盘休眠计数 |
| H4 | 同步 `src/typert.remote-client.{d.ts,js}` | 镜像 H1–H3（该产物为手写/生成镜像，需同步维护） | 客户端类型与分发 |
| H5 | 单测 | `tests/` 新增 remote 方法用例（vitest，沿用现有测试风格） | 回归保障 |
| H6 | 部署安全核对 | 核实宿主 `dsh-api-remotes` 的 loopback / `PRIVILEGED_METHODS` 机制，写方法按需 pin 回环（`src/remote/index.ts` 头部 TODO 已有备忘） | 非本机部署下防远端改写 |

错误约定维持现状：业务失败返回 `{ error }` / `{ found: false }`，不抛出；传输层错误由客户端 try/catch 兜底。

## 5. 技术方案 — Client 侧（`src/client/`）

### 5.1 挂载 Typert 贡献物（新步骤）

当前 client `apply` 只注册设置卡，从未挂载 `./remote` 贡献物（宿主 `dsh-api-remotes/client` 只挂载内置清单，不会替我们挂）。

- `src/client/index.ts`：`inject` 增加 `'connection'`、`'remote'`；`apply` 改为 async（宿主 `dsh-api-remotes/client` 的 async apply 是现成先例），启动时 `await ctx.remote.$mount(TYPERT_REMOTE)`——`TYPERT_REMOTE` 从 `../typert.remote-client.js` 导入，esbuild 会把它打进 `lib/client/index.js`（本地源码，不违反 host external / bundle purity 约束）。
- 挂载后访问路径（已核实宿主 `ui-agent-preset/src/client/section-store.ts` 的用法）：
  ```ts
  const response = await api.memoryRemote.list({ scope, projectName, limit, offset })
  if (!response.result.ok) { /* response.result.error.message → 页面错误态 */ }
  const { entries, total } = response.result.value
  ```
  传输异常走 try/catch 兜底。
- `package.json` 的 `dsh.client.inject` 需补 remote/api 相关依赖声明（实施时对照 agent-preset 包的写法核实确切键值）。

### 5.2 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/client/index.ts` | 改 | async apply + `$mount` + 注册 `settings.section`（`{ name:'settings.section', id:'memory', order:25, label, locale, inject }, MemorySection`）；现有四张配置卡**原样保留** |
| `src/client/MemorySection.tsx` | 新 | 页面组件：仪表盘 / 工具栏 / 列表 / 抽屉；只经 inject 面消费数据，不直接持连接 |
| `src/client/memory-section-store.ts` | 新 | Controller + HostObservable 状态机（镜像 `ui-agent-preset/src/client/section-store.ts`）：`status: idle → loading → ready/error`；state 含 health、entries、total、filters（scope/projectName/query/categories）、page、draft（二期）、audit（二期）；方法 load / setScope / setProject / setQuery / setPage / refresh 等 |
| `src/client/locales.ts` | 扩 | 复用现有 `settings.memory` 命名空间增补词条（en + zh），含 section nav label |
| `src/client/card-styles.ts` 或新 `section-styles.ts` | 扩 | 沿用 `dsm-c-*` 类名 + `<style data-dsh-memory>` 注入约定 |
| `tests/` | 新 | jsdom 端测（见 §7） |

### 5.3 数据流（端到端）

```
MemorySection.tsx ──操作──▶ MemorySectionController（memory-section-store.ts）
                                │ api.memoryRemote.*（Typert over WS，$mount 挂载）
                                ▼
                    MemoryRemoteService（@Remote）──▶ ctx.memory（MemoryStore）
                                │                      │ scanner 门控 / 审计追加
                                ▼                      ▼
                     { entries | error } ◀──── 状态刷新 → HostObservable → React
```

### 5.4 施工注意（承接既有踩坑记录）

- 异步加载 effect 的守卫状态**不得**进依赖数组（`useRef` 一次性守卫 + 超时兜底），见 `docs/CLIENT_UI_LESSONS.zh.md`。
- 可能为 undefined 的草稿值，布尔守卫提取一次复用，**严禁**同函数内二次裸访问（`draft.xxx.length` 式崩溃已有先例）。
- client 源码不进 tsc program；宿主包一律 type-only import；`RULES`/样式定义必须先于 `inject()` 调用。
- 构建零改动：`scripts/build-client.cjs` 直接吃新文件。

## 6. 分阶段实施

### 一期：只读浏览 + 健康统计（本次实施范围）

- Host：H1–H5。
- Client：挂载 + section 骨架 + 仪表盘 + 工具栏（scope/project/搜索/类别）+ 只读列表（含 stale 标记）。
- **验收标准**：
  1. Settings 导航出现 Memory 区，order 位置合理，双语 label 正常。
  2. 仪表盘数字与 `health()` 一致（可用 `POST /api/...` 直查比对）。
  3. 四 scope 切换正确；project 下拉列出全部已知项目（= `projects()`）；选中后只见该项目条目 —— 覆盖"整个 DSH 的记忆 + 按工作区看"两个核心诉求。
  4. 搜索走 BM25，防抖生效，总数与分页正确；stale 条目灰显带标记。
  5. 连接断开/重置后页面错误态可恢复，`connection/reset` 后自动重载。

### 二期：完整 CRUD + 审计

- 编辑器抽屉（新建/编辑）、删除二次确认、置顶切换、scanner 拒绝原因内联展示、审计日志抽屉；变更后列表 + 仪表盘联动刷新。
- **验收标准**：四类写入全流程可用；审计记录 `source:'ui'` 落账；jsdom 覆盖"切换 scope → 选项目 → 搜索 → 编辑保存"主链路。

### 三期：增强（候选，另行评估）

- 当前会话/工作区联动：conversation-scope 入口或 project 预选。
- JSON 导出/导入（备份迁移）、批量操作。
- 实时刷新（audit seq 轮询或事件转发）。

## 7. 测试策略

- **Host**：`tests/` 新增 remote 单测——`projects` 聚合、`staleSince`/`stale` 透传、分页边界、scanner 拒绝路径（vitest，沿用 `tests/store-contract.spec.ts` 风格）。
- **Client**：jsdom 方案（`tests/model-catalog.spec.ts` 的既有设施）：esbuild 打 `src/client` 真源码 + `createRoot` 驱动。注意三点既有教训：bundle 输出须放在能 resolve react 的目录；`@deepseek-ai/dsh-client-ui-primitives` 需 stub；jsdom 从 harness `node_modules/.pnpm` 直连。一期覆盖：初始加载渲染、scope 切换、项目筛选、搜索、错误态。
- **端到端**：web profile 已是 `link:` 真 symlink——`pnpm build` 后刷新 `http://127.0.0.1:10026` 即生效，逐条走验收标准。

## 8. 文档更新

- `README.md` / `README.zh.md`：功能特性补"记忆管理中心"；架构段补 section 说明。
- `docs/TECH_DESIGN.zh.md` / `.md` §7.7 / §7.8：把"设置 UI **暂未**消费该服务"更新为已实现，补 H1–H3 的 wire 变更与客户端挂载模式。
- 本文档的英文镜像 `MEMORY_MANAGER_PLAN.md`（发布前补）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| UI 写入注入脏数据 | 写路径强制过现有 scanner（store 层，不绕行） |
| 误删 | 二次确认 + 审计可溯源 + 来源标 `'ui'` |
| 大 store 下列表卡慢 | 远程分页（limit/offset）+ BM25 后端检索，不整表拉取 |
| 与配置卡职责割裂 | 配置留 Plugins 页签不动；Memory 页给"前往配置"链接 |
| remote namespace 挂载冲突 | `$mount` 自带重复挂载校验（`api-gateway` `validateContribution`）；启动失败即 fiber 报错，可诊断 |
| async apply 兼容性 | 宿主 `dsh-api-remotes/client` 的 async apply 为先例；实施第一步先在 web profile 实测 |

## 10. 已确认决策记录

1. ✅ 位置：Settings 独立「Memory」section（非会话内面板、非 Plugins 卡片）——2026-08-24 确认。
2. ✅ 范围：分期实施，一期只读浏览（含分 scope、分项目筛选与搜索）——2026-08-24 确认。
3. ✅ 现有四张配置卡片保持原位不动。
4. ✅ profile 边界：本页面只管理 web profile 的 store。

## 11. 实施清单（开工时逐项勾选）

- [x] H1 `projects()` @Remote 方法 + 单测（`tests/remote-service.spec.ts`）
- [x] H2 `staleSince` 透传 + 单测
- [x] H3 `stale` 计数透传 + 单测
- [x] H4 同步 `typert.remote-client.*` 镜像
- [x] H6 loopback / PRIVILEGED_METHODS 核实（结论：宿主无按方法注册表，信任门在传输层 `api-request-trust`；已写入 `src/remote/index.ts` 头注释）
- [x] client：inject 扩展 + 挂载数据面（web profile 实测启动 ✓；**实测修正：放弃 `$mount`，改走 `/api` RPC 直呼，见 §12**）
- [x] client：`memory-section-store.ts` Controller + 状态机
- [x] client：`MemorySection.tsx`（仪表盘 / 工具栏 / 列表）
- [x] client：locales（en + zh）+ 样式（`section-styles.ts`）
- [x] `package.json` `dsh.client.inject` 核对（补 api-remotes / client-locale / client-runtime）
- [x] jsdom 测试（`tests/memory-section.client.spec.tsx`，10 用例）
- [x] `pnpm build` → `http://127.0.0.1:10026` 端到端验收（§6 一期 5 条全过，含双语 label 与断连重载实测）
- [x] README + TECH_DESIGN 文档更新（中英双语四份）
- [x] 记忆沉淀：实施完成后把关键决策与坑写回 memory/notes

## 12. 一期实施记录（2026-08-24）

### 12.1 交付

- **Host：** H1–H6 全部落地；新增 `tests/remote-service.spec.ts`（10 用例）。服务方法共十个：原九个 + `projects`。
- **Client：** `src/client/` 新增 `MemorySection.tsx` / `memory-section-store.ts` / `section-styles.ts`，`locales.ts` 增补 en+zh 词条；四张配置卡原样保留。新增 jsdom 套件 `tests/memory-section.client.spec.tsx`（10 用例），vitest 别名把浏览器 loader 形态的 `@deepseek-ai/dsh-client-runtime/client` 指到同契约 stub（`tests/stubs/client-runtime.ts`）。
- **全量测试：** vitest 389 passed。

### 12.2 与规划的偏差（均为浏览器实测驱动）

1. **数据面不走 `$mount`，改走 `/api` RPC 直呼。** §5.1 的挂载方案在真机连续失败：
   - gateway 客户端对贡献物方法名做命名空间服务成员的保留字校验，`memoryRemote/remove` 即撞名（报 *conflicts with its namespace service*）——服务方法已改名 **`removeEntry`**（§4 写路径语义不变，二期 UI 使用新名）；
   - cordis 禁止 fiber 在 inject 里声明自己 apply 内才创建的服务，读 `remote.memoryRemote` accessor 报 *without inject*，「自产自销」式挂载不可行。
   最终形态：`connection.rpc.call('/api', 'memoryRemote/<method>', { args: { request } })`——宿主 `TypertGatewayService` 对 `/api` 上所有 `<ns>/<method>` endpoint 做 source-mode discovery（反射带 `typertRemote` 绑定的服务按形参名分发 args 字段；无参方法发 `{ args: {} }`），host 端注册即自动可达。注意 `connection.api.*` 是另一套 apiproxy HTTP 面，与此无关。
2. **apply 保持同步函数。** 不再需要 await 挂载，async 语义一并撤销。
3. **H6 结论修正了规划假设：** 不存在按方法的 `PRIVILEGED_METHODS` 注册表，无需 pin 回环；传输层信任栅栏统一覆盖所有 `/api` 请求。

细节见 `docs/TECH_DESIGN.*` §7.7–7.8。
