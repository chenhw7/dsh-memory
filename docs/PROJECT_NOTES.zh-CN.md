# 方案设计：Project Notes —— 项目级 prompt 记忆（编码习惯 + 踩坑日志）

| | |
|---|---|
| Package | `@chenhw7/dsh-memory` |
| 状态 | **prompt-only 投影（v0.6.0）**。v0.2–v0.5 为仓库文件导出，v0.6 移除（ADR-6） |
| 范围 | `memory-notes` 组合行：渲染 conventions/pitfalls 进 `project-notes` prompt 段；会话创建时清理 ≤0.5.x 文件残留 |

---

## 1. 目标与范围

dsh 主要用于代码编写场景。本子系统在长期记忆能力之上，为每个项目提供**项目级 prompt 记忆**：

- 每次会话开始时，**编码习惯/约定**与**踩坑日志**从 KV store 渲染并注入 system prompt（`project-notes` 段）。
- **不向用户仓库写入任何文件**：记忆的唯一形态是 host 侧 KV 存储（`~/.dsh/storages/memory.json`），在 Memory 设置 UI 中查看/编辑/置顶/归档/删除。
- 自动沉淀（属 `memory-review`，非本模块）：
  - 检测到"同一类操作**连续失败 ≥2 次、最终成功解决**"的序列时，自动产出一条结构化踩坑记录。
  - 检测到用户**明说**（"记住/以后都……"）或**重复出现**的编码偏好时，自动入库。
- 非目标：语义检索、thoughts/调研日志、`~/.dsh` 之外的全局文件同步、向仓库写文件。

---

## 2. 决策记录（ADR）

### ADR-1：在现有插件内扩展，而非新建独立插件 ✅（v0.2）

`src/notes/` 模块 + subpath 导出 `@chenhw7/dsh-memory/notes` + 第七组合行 `memory-notes`。理由：数据依赖拆不开（渲染视图的真相源在本包）、review 管线复用、组合行机制正为此设计。（详见 git 历史 v0.2.0 版本文档）

### ADR-2：KV 为真相源，导出为只读渲染 ✅（v0.2，延续至今）

- 渲染口径：`KV store → 注入文本`，**单向**。现成的 dedup、LLM judge、janitor 衰减、审计、管理 UI 全部自动生效——条目被 janitor 删除后，下次渲染自动瘦身。
- **明确不做"仓库 → KV"反向同步**：从仓库读到的内容绝不自动写回记忆库，杜绝克隆的恶意仓库通过文件注入指令。

### ADR-3：文件布局 = 独立目录 + AGENTS.md 指针 ⛔（v0.2 采纳，v0.6 废弃）

v0.2–v0.5 曾把渲染结果写为 `docs/agent-memory/{CONVENTIONS,PITFALLS}.md`，并在 `AGENTS.md` 维护托管指针块供其他工具发现。**v0.6 移除**，被 ADR-6 取代。

### ADR-4：踩坑条目粒度 = 结构化短条目 ✅

每条踩坑记录包含：症状（错误信息）、根因、修复方法，两三行内。不记录完整 diff/日志，避免注入膨胀。

### ADR-5：习惯提取基调 = 保守 ✅

preference/convention 类记忆仅在满足以下任一条件时入库：用户明确要求，或同一偏好主题**出现 ≥2 次**。单次场景性偏好不入库。

### ADR-6：移除仓库文件导出，收敛为 prompt-only ✅（v0.6）

**决策**：`memory-notes` 不再写任何文件。conventions/pitfalls 只渲染进 `project-notes` prompt 段；`session/created` 时一次性清理 ≤0.5.x 留下的仓库产物（剥离 AGENTS.md 托管块、删除生成的笔记文件）。

**理由**：

1. **git 摩擦**（真实用户反馈的首要痛点）：文件"突然出现"在用户仓库的 git status 里，用户困惑"我的代码里怎么多了这些文件"，提交时还被迫手动 gitignore。
2. **多机提交必然互相覆盖**：KV 是每台机器的真相源，生成文件若提交进 git，多机各自 render 后写者赢（本文件旧版 §11 早已记录该缺陷）。既然不宜提交，文件留在仓库就只剩 git 噪声。
3. **跨工具桥接价值有限且代价高**：AGENTS.md 指针块确实能让读 AGENTS.md 的其他工具发现笔记文件，但代价是持续污染 git status。需要跨工具共享的用户可直接把记忆内容整理进自己的 AGENTS.md。
4. **管理面已有更好的归处**：Memory 设置 UI（v0.4）提供查看/编辑/置顶/归档/删除，是比仓库文件更合适的记忆管理入口。

**清理的保守规则**：只剥离标记块（`<!-- dsh-memory:begin/end -->` 之外的内容不动）；pointer-only 的 AGENTS.md（剥完只剩空白）才整文件删除；notes 目录只删插件生成的 `CONVENTIONS.md` / `PITFALLS.md` / `*.bak.*`，目录含外来文件时保留目录；绝不改用户的 `.gitignore`。

**代价（有意接受）**：非 dsh 的 agent 工具不再能通过仓库文件看到这些记忆。

---

## 3. 数据流

```
KV store（真相源）
  → memory-notes：snapshotFor(cwd) 同步渲染（scope×category 矩阵，§4）
  → memory-context 在 session/created 冻结返回值 → 注入 <project-notes> section
```

渲染采用显式的 scope×category 矩阵——**编码习惯是可以跨项目的**，因此把全局/个人层与项目层叠加渲染：

| prompt 分节 | scope / category 过滤 |
|---|---|
| `## Project conventions` | 当前项目 `project` scope，category ∈ {`convention`, `preference`} |
| `## Global practices` | `global` scope，category ∈ {`convention`, `preference`} |
| `## Personal habits` | `user` scope，category ∈ {`preference`, `convention`} |
| `## Project pitfalls` | 当前项目 `project` scope，category ∈ {`failure`, `procedure`, `tool-quirk`} |
| `## Environment & cross-project pitfalls` | `global` scope，category ∈ {`failure`, `procedure`, `tool-quirk`} |

"当前项目"由 `session.header.cwd` 的 basename 与条目 `projectName` 比对确定（沿用现有项目自动识别口径）。

分节顺序即优先级提示：**同一主题冲突时，作用域越近（项目 > 全局 > 个人）越优先**，注入文本中附带该说明。其他 category（如 `insight`、`correction`）不进 notes 段，继续只走 KV 记忆注入。

**生命周期说明**：janitor 只衰减 `project` scope 条目，个人/全局习惯永不自动消失；重要的项目约定可通过现有 `memory_pin` / `memory_unpin` 钉住免于衰减，notes 渲染自然尊重该语义。

---

## 4. 注入：`project-notes` system-prompt 段

- `memory-context` 注册 section：`name: 'project-notes'`，`order: 91`（紧邻 memory 的 90）。
- 注入内容 = `projectNotes.snapshotFor(cwd)` 的**同步渲染结果**：`session/created` 时 memory-context 调用 service，service 从 KV store 纯内存渲染并返回，返回值冻结到 per-session 快照；注入时按 `notesCharLimit`（默认 4000）截断。section 文本函数每次组装时读取冻结副本（KV-cache 前缀稳定，与 memory section 行为一致）。
- 无 cwd（当前项目不可解析）时：项目分节缺席，个人/全局分节照常渲染注入。
- 禁用或 store 缺失时注入空串（section 自动消失）。
- **会话内更新下个会话生效**——与现有 memory 注入语义一致，是有意取舍。

**与现有 `memory` section 的关系（关键：不是第二套记忆）**：notes 段与 memory section 源自**同一个 KV store**，只是同一真相源的另一个常驻注入视图。**防重复注入**：`notesEnabled` 为 true 时，`readMemorySnapshot` / `readMemoryIndex` 排除已进入 notes 渲染矩阵的条目（§3 的 scope×category 范围），`full` / `index` 模式下同一内容不在 prompt 中出现两次。默认 `policy-only` 模式不注入记忆内容，天然无重叠。

---

## 5. 配置

`memory` settings 命名空间（settings UI 可见，live 生效）：

| 设置 | 默认 | 含义 |
|---|---|---|
| `notesEnabled` | `true` | 启用 `project-notes` prompt 段注入（0.6 起无文件语义） |
| `notesCharLimit` | `4000` | 注入总字符上限 |
| `notesMaxEntriesPerFile` | `100` | 渲染条目数上限（键名保留 0.5.x 兼容） |

（v0.5.x 的 `notesDir` / `notesAgentsPointer` 已随 ADR-6 移除；旧设置值被静默忽略。）

---

## 6. 安全与边界

- 所有入库内容仍走 `scanContent`（secrets / prompt-injection / exfiltration 模式），notes 渲染前内容已过关，不重复扫描；未过关的条目直接缺席本段。
- **仓库 → KV 反向同步不存在**（ADR-2），杜绝克隆仓库注入。
- Headless profile 行为与现有 bundle 一致（需自行补 storage 行，README 已文档化）。

## 7. 已知限制

- 无向量检索；会话内写入不刷新当次注入（§4）。
- 一次性清理基于 ≤0.5.x 的**默认** notes 目录（`docs/agent-memory`）；自定义过 `notesDir` 的部署需手动删除其目录（插件已不再写它）。

## 8. 测试计划

- **渲染矩阵**（`tests/notes.spec.ts`）：三层叠加 + 当前项目隔离、其他 category 不进 notes、条目 cap 截断。
- **零写入**：`snapshotFor` 前后断言项目根无任何新文件（prompt-only 的行为闸门）。
- **注入**：`buildNotesSectionText` 文本构建（双空 → 空、零预算 → 空、截断）；snapshot/index 互斥过滤。
- **清理**（`tests/notes.spec.ts`）：剥离托管块保留用户内容、pointer-only 文件删除、孤儿目录删除、外来文件保留、幂等重跑。
