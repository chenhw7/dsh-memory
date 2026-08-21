# 时序图 (Sequence Diagrams)

本文档基于 `@chenhw7/dsh-memory` 源码绘制，覆盖所有核心工作流，用于：

- **向用户介绍**：快速理解插件的运行机制
- **代码分析改进**：定位调用链、发现耦合点、评估优化方向

---

## 1. 模块初始化与服务组装

插件通过 `cordis.patch.yml` 声明 6 个 bundle row，按依赖顺序加载。`storageDomain` 是所有模块的注入源。

```mermaid
sequenceDiagram
    participant Host as dsh Host
    participant Store as memory-store
    participant SD as storageDomain
    participant Tool as tool-memory
    participant Review as memory-review
    participant Context as memory-context
    participant Remote as memory-remote

    Host->>Host: dsh plugin add @chenhw7/dsh-memory
    Note over Host: 解析 cordis.patch.yml<br/>按 inject 依赖排序加载

    Host->>Store: apply(ctx) [inject: storageDomain]
    Store->>SD: ctx.get('storageDomain')
    SD-->>Store: Domain 实例
    Store->>Store: domainTable('entries') + domainTable('audit')
    Store->>Host: ctx.memory = DomainMemoryStore

    Host->>Tool: apply(ctx) [inject: tools, ctx.get: memory]
    Tool->>Store: ctx.get('memory')
    Store-->>Tool: MemoryStore 实例
    Tool->>Host: 注册 8 个 memory_* 工具

    Host->>Review: apply(ctx) [inject: llm, ctx.get: memory, sessionProjections]
    Review->>Store: ctx.get('memory')
    Review->>Host: 注册 accumulator + 事件监听器

    Host->>Context: apply(ctx) [inject: systemPrompt, ctx.get: memory]
    Context->>Store: ctx.get('memory')
    Context->>Host: 注册 memory settings + systemPrompt.section

    Host->>Remote: apply(ctx) [inject: memory]
    Remote->>Store: ctx.get('memory')
    Remote->>Host: 注册 @Remote 服务
```

---

## 2. 模型主动写入 — `memory_add` 工具调用

模型通过工具调用写入记忆。工具层与存储层都执行 `scanContent`，形成纵深防御。

```mermaid
sequenceDiagram
    participant Model as AI 模型
    participant Tool as tool/index.ts
    participant Scanner as scanner.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    Model->>Tool: memory_add({ content, scope, category, projectName })
    Tool->>Tool: requireMemory(ctx)
    Tool->>Tool: validateProjectScope(input)

    Tool->>Scanner: scanContent(content)
    Note over Scanner: 29 条正则: secret / injection / exfiltration
    alt 命中敏感模式
        Scanner-->>Tool: ScanResult { hit: true, pattern }
        Tool-->>Model: 抛出 "content rejected: ..."
    else 通过扫描
        Scanner-->>Tool: ScanResult { hit: false }
        Tool->>Store: store.add(input)

        Note over Store: 纵深防御: 再次校验
        Store->>Store: validateProjectScope(input)
        Store->>Scanner: scanContent(input.content)
        Scanner-->>Store: 通过

        Store->>Store: MemoryId() → 生成 UUID
        Store->>SD: entries.put(id, entry)
        SD-->>Store: 写入成功

        Store->>Store: appendAudit('add', id, entry, 'tool', sessionId)
        Store->>SD: audit.put(auditId, auditEntry)
        Store->>Store: trimAudit (上限 200 条)

        Store-->>Tool: { entry }
        Tool-->>Model: { entry: toEntryJson(entry) }
    end
```

---

## 3. 模型主动搜索 — `memory_search` 工具调用

模型搜索已有记忆，支持关键词分词匹配（含 CJK 逐字分词）。

```mermaid
sequenceDiagram
    participant Model as AI 模型
    participant Tool as tool/index.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    Model->>Tool: memory_search({ query, scope, category, limit })
    Tool->>Tool: requireMemory(ctx)
    Tool->>Store: store.search(query)

    Store->>Store: tokenizeQuery(query)
    Note over Store: 按词边界 + CJK 逐字分词<br/>大小写折叠

    Store->>SD: entries.getAll()
    SD-->>Store: 全部 entries

    loop 遍历每条 entry
        Store->>Store: 过滤 scope / category / projectName
        Store->>Store: tokenHitCount(entry, tokens)
    end

    Store->>Store: 按 hit 数降序 → updatedAt 降序排序
    Store->>Store: slice(limit ?? 50)
    Store->>Store: void markRecalled(entries) [fire-and-forget]
    Store->>SD: entries.put(id, { ...entry, lastRecalledAt: now })

    Store-->>Tool: { entries, total }
    Tool-->>Model: { entries: toEntryJson[], total }
```

---

## 4. 自动学习 — 周期性审查提取 (Periodic Review)

核心工作流：会话事件累加 → 达到阈值触发 LLM 提取 → 解析 → 扫描 → 去重 → 存储。

```mermaid
sequenceDiagram
    participant SE as Session 事件
    participant Acc as accumulator.ts
    participant Pre as agent/pre-step 钩子
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Scanner as scanner.ts
    participant Dedup as dedup.ts
    participant Store as store/index.ts

    Note over SE,Acc: 阶段 1: 累加候选信号

    SE->>Acc: user/message 事件
    Acc->>Acc: messageText(event)
    Acc->>Acc: detectSignal(text)
    Note over Acc: 关键词模式: "记住" "remember"<br/>纠错模式: "不对" "actually"
    Acc->>Acc: 追加 { text, signal, seq } 到 candidates

    SE->>Acc: tool/result (error)
    Acc->>Acc: toolFailureText(event)
    Acc->>Acc: 追加 { text, signal: 'tool-failure', seq }

    Note over Pre,Ext: 阶段 2: 阈值检查与触发

    Pre->>Pre: sessionProjections.snapshot(session)
    Pre->>Pre: 未处理 = candidates.filter(seq > highWaterMark)
    alt 未处理数 < threshold (默认 3)
        Pre-->>Pre: no-op, return next()
    else 达到阈值
        Pre->>Pre: checkBudget(session)
        Pre->>Ext: runReviewExtraction(ctx, agent, candidates, ...)

        Note over Ext,LLM: 阶段 3: LLM 提取

        Ext->>Store: memory.list() → 当前记忆快照
        Store-->>Ext: existing entries
        Ext->>Ext: renderMemorySnapshot(memory)
        Ext->>Ext: buildReviewMessages(snapshot, candidates)
        Ext->>LLM: ctx.llm.stream({ system, messages, signal })
        LLM-->>Ext: 流式文本 (逐 chunk)
        Ext->>Ext: collectStreamText(chunks)

        Note over Ext,Dedup: 阶段 4: 解析 + 扫描 + 去重 + 存储

        Ext->>Ext: parseExtractedMemories(text)
        Note over Ext: 行格式: "scope: content"

        loop 每条 ParsedMemory
            Ext->>Ext: 推断 category (procedure 前缀剥离)
            Ext->>Scanner: scanContent(content)
            alt 被扫描拒绝
                Scanner-->>Ext: rejected → 跳过此条
            else 通过
                Ext->>Dedup: findDuplicate(content, scope, existing)
                Note over Dedup: Jaccard ≥ 0.15 + 同 scope

                alt 找到候选重复
                    Ext->>Dedup: buildJudgePrompt(old, new)
                    Ext->>LLM: ctx.llm.stream(judgePrompt)
                    LLM-->>Ext: verdict 文本
                    Ext->>Dedup: parseJudgeVerdict(text)

                    alt verdict = "duplicate"
                        Ext->>Dedup: mergeContent(old, new)
                        Ext->>Store: store.update(dupId, merged)
                    else verdict = "update"
                        Ext->>Store: store.update(dupId, newContent)
                    else verdict = "new"
                        Ext->>Store: store.add(input)
                    end
                else 无重复
                    Ext->>Store: store.add(input)
                end
            end
        end

        Ext-->>Pre: parsed.length
        Pre->>Pre: 推进 highWaterMark
    end

    Pre-->>Pre: return next() [无论提取结果如何都继续]
```

---

## 5. 上下文压缩刷出 (Compaction Flush)

当上下文被压缩时，从即将丢失的片段中提取记忆。Fire-and-forget，不阻塞压缩。

```mermaid
sequenceDiagram
    participant Comp as compaction/end 事件
    participant Review as review/index.ts
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Dedup as dedup.ts
    participant Store as store/index.ts

    Comp->>Review: compaction/end { compactionId, error: undefined }
    Review->>Review: checkBudget(session)
    Review->>Ext: flushOnCompaction(ctx, session, compactionId, ...)

    Note over Ext: 阶段 1: 收集即将丢失的片段

    Ext->>Ext: findCompactionSummary(session, compactionId)
    Note over Ext: 搜索 compaction/summary 事件

    Ext->>Ext: collectShadowedFragments(session, shadowedSeqs)
    loop 每个 shadowed seq
        Ext->>Ext: messageText(session.events[seq])
    end
    Note over Ext: fragments = [被压缩的对话片段]

    Note over Ext: 阶段 2: LLM 刷出提取

    Ext->>Ext: buildFlushMessages(fragments)
    Note over Ext: 系统提示: "Conversation being compressed..."
    Ext->>LLM: ctx.llm.stream({ system: FLUSH_PROMPT, messages })
    LLM-->>Ext: 流式文本
    Ext->>Ext: parseExtractedMemories(text)

    Note over Ext: 阶段 3: 存储 (同 Review 流程)

    loop 每条 ParsedMemory
        Ext->>Ext: scanContent(content)
        Ext->>Dedup: findDuplicate → judgeDuplicate (可选)
        Ext->>Store: store.add / store.update
    end

    Note over Review: void ...catch(() => {})<br/>fire-and-forget, 永不阻塞压缩
```

---

## 6. 会话销毁刷出 (Session Dispose Flush)

会话被销毁时，从完整对话中提取记忆。5 秒超时限制。

```mermaid
sequenceDiagram
    participant SE as session/disposed 事件
    participant Review as review/index.ts
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Store as store/index.ts

    SE->>Review: session/disposed(session)
    Review->>Review: checkBudget(session)
    Review->>Ext: flushOnDispose(ctx, session, ...)

    Note over Ext: 阶段 1: 渲染完整对话

    Ext->>Ext: session.deriveMessages()
    Note over Ext: 将整个会话渲染为消息列表

    loop 每条 message
        Ext->>Ext: messageFragment(message) → "role: text"
    end

    Note over Ext: 阶段 2: 限时提取 (5s 超时)

    Ext->>Ext: AbortSignal.timeout(5000)
    Ext->>Ext: buildFlushMessages(fragments)
    Ext->>LLM: ctx.llm.stream({ system: FLUSH_PROMPT, messages, signal })
    LLM-->>Ext: 流式文本 (可能因超时截断)
    Ext->>Ext: parseExtractedMemories(text)

    Note over Ext: 阶段 3: 存储

    loop 每条 ParsedMemory
        Ext->>Store: scanContent → dedup → store.add/update
    end

    Note over Review: void ...catch(() => {})<br/>best-effort, 不阻塞销毁
```

---

## 7. 清理者衰减 (Janitor Decay)

新会话创建时触发，清理长期未被召回的 project 级记忆。全局和用户级记忆永不被衰减。

```mermaid
sequenceDiagram
    participant SC as session/created 事件
    participant Review as review/index.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    SC->>Review: session/created (global listener)
    Review->>Store: ctx.get('memory')
    alt memory 不可用
        Review-->>Review: return (no-op)
    else memory 可用
        Review->>Store: memory.janitor(decayDays)

        Store->>SD: entries.getAll()
        SD-->>Store: 全部 entries

        loop 每条 entry
            alt scope === 'global' 或 'user'
                Note over Store: 跳过, 永不衰减
            else scope === 'project'
                alt entry.pinned === true
                    Note over Store: 跳过, pin 保护
                else 未 pin
                    Store->>Store: lastActive = lastRecalledAt ?? createdAt
                    alt now - lastActive >= decayDays × 86400000
                        Store->>SD: entries.delete(entry.id)
                        Store->>Store: appendAudit('remove', id, entry, 'janitor')
                        Store->>SD: audit.put(auditId, auditEntry)
                        Store->>Store: trimAudit()
                    else 未超期
                        Note over Store: 保留
                    end
                end
            end
        end

        Store-->>Review: { decayed: count }
        Note over Review: void ...catch(() => {})<br/>best-effort
    end
```

---

## 8. 系统提示注入 (System-Prompt Context Injection)

在会话创建时冻结记忆快照，每步组装系统提示时读取实时设置 + 冻结快照，拼接为 prompt section。

```mermaid
sequenceDiagram
    participant SC as session/created
    participant Context as context/index.ts
    participant Store as store/index.ts
    participant SP as systemPrompt 组装
    participant Policy as policy.ts

    Note over SC,Context: 阶段 1: 会话创建时冻结快照

    SC->>Context: session/created (global listener)
    Context->>Store: ctx.get('memory')
    alt memory 不可用
        Context->>Context: 冻结空快照
    else memory 可用
        Context->>Store: memory.list('global' | 'project' | 'user')
        Store-->>Context: 各 scope entries
        Context->>Context: readMemorySnapshot(memory, charLimit)
        Note over Context: 按 scope 分组渲染 → 截断至 charLimit
        Context->>Store: memory.list() (全部)
        Store-->>Context: all entries
        Context->>Context: readMemoryIndex(memory, charLimit)
        Note over Context: 映射为 IndexEntry[]<br/>按 tier 排序: project → user → global
        Context->>Context: sessionMemory.set(session, { content, index })
        Note over Context: WeakMap<Session, FrozenSnapshot><br/>会话生命周期内不变
    end

    Note over SP,Policy: 阶段 2: 每步组装系统提示

    SP->>Context: systemPrompt.section('memory', order: 90)
    Context->>Context: current() → 读取实时设置 (mode, customText, charLimit)
    Note over Context: 设置可被用户实时修改<br/>但快照已冻结
    Context->>Context: sessionMemory.get(session) → FrozenSnapshot

    Context->>Policy: buildMemorySectionText(mode, customText, snapshot.content, snapshot.index)

    alt mode = 'off'
        Policy-->>Context: "" (不注入)
    else mode = 'policy-only'
        Policy-->>Context: MEMORY_POLICY_TEXT
    else mode = 'custom'
        Policy-->>Context: customText
    else mode = 'full'
        Policy-->>Context: <memory-context>content</memory-context> + MEMORY_POLICY_TEXT
    else mode = 'index'
        Policy-->>Context: <memory-index>index</memory-index> + MEMORY_POLICY_TEXT
    end

    Context-->>SP: section text (空字符串则丢弃此 section)
```

---

## 9. 前端 UI 远程交互 (Remote UI Interaction)

浏览器端通过 Typert 协议调用 `@Remote` 服务，操作记忆数据。

```mermaid
sequenceDiagram
    participant UI as 浏览器 UI
    participant Remote as remote/index.ts
    participant Store as store/index.ts
    participant Scanner as scanner.ts
    participant SD as storageDomain

    Note over UI,Remote: 以 memory.add 为例

    UI->>Remote: ctx.remote.memory.add({ content, scope, category, projectName, source: 'ui' })

    Remote->>Store: ctx.get('memory')
    Remote->>Store: store.add(input)

    Note over Store: 同 tool 路径的纵深防御
    Store->>Store: validateProjectScope(input)
    Store->>Scanner: scanContent(input.content)
    alt 被扫描拒绝
        Scanner-->>Store: rejected
        Store-->>Remote: 抛出 Error
        Remote-->>UI: { error: message }
    else 通过
        Scanner-->>Store: 通过
        Store->>Store: MemoryId()
        Store->>SD: entries.put(id, entry)
        Store->>Store: appendAudit('add', id, entry, 'ui', sessionId)
        Store->>SD: audit.put(auditId, auditEntry)
        Store-->>Remote: { entry }
        Remote-->>UI: { entry: toEntryJson(entry) }
    end

    Note over UI,Remote: 其他远程方法 (list/search/get/update/remove/pin/health/auditLog)<br/>均委托到 Store 对应方法, 错误以 { error } 返回而非抛出
```

---

## 10. 前端设置 UI (Client Settings)

浏览器端注册设置卡片，用户实时修改配置，下次系统提示组装时生效。

```mermaid
sequenceDiagram
    participant Browser as 浏览器
    participant Client as client/index.ts
    participant Card as MemoryPluginCard.tsx
    participant Scope as settingsScope
    participant Context as context/index.ts

    Note over Browser,Client: 阶段 1: 插件加载注册

    Browser->>Client: apply(ctx)
    Client->>Client: ctx.locale.register('settings.memory', { zh, en })
    Client->>Client: ctx.settingsScope.bind({ namespace: 'memory' })
    Note over Client: 创建 SettingsScope<MemoryConfig>
    Client->>Browser: slots.inject('settings.plugin.item', MemoryPluginCard)

    Note over Browser,Card: 阶段 2: 用户编辑设置

    Browser->>Card: 渲染设置卡片
    Note over Card: 字段: memoryMode, customText,<br/>reviewEnabled, judgeEnabled,<br/>extractionThreshold, decayDays,<br/>maxSearchResults, extractionModelProvider/Model

    Card->>Scope: scope.get(field) → 读取当前值
    Scope-->>Card: 当前配置

    Browser->>Card: 用户修改字段 → 点击 Save
    Card->>Scope: scope.set(field, value)
    Scope->>Scope: 写入 settings.yaml
    Note over Scope: 配置实时生效

    Note over Context: 阶段 3: 下次系统提示组装时生效

    Context->>Context: current() → 读取最新设置
    Note over Context: memoryMode / customText / charLimit<br/>影响 buildMemorySectionText 的输出
```

---

## 附录: 模块依赖与服务调用关系

```mermaid
graph TB
    subgraph "存储层"
        Store["store/index.ts<br/>DomainMemoryStore"]
        SD["storageDomain<br/>entries + audit 表"]
        Scanner["scanner.ts<br/>scanContent"]
        Brand["brand.ts<br/>MemoryId / AuditId"]
    end

    subgraph "工具层"
        Tool["tool/index.ts<br/>8 个 memory_* 工具"]
    end

    subgraph "自动学习层"
        Acc["accumulator.ts<br/>纯函数累加器"]
        Ext["extract.ts<br/>LLM 提取 + 存储"]
        Dedup["dedup.ts<br/>Jaccard 预过滤 + LLM 判定"]
        LLM["dsh-llm<br/>ctx.llm.stream"]
    end

    subgraph "上下文层"
        Context["context/index.ts<br/>快照 + section"]
        Policy["policy.ts<br/>模式渲染"]
    end

    subgraph "远程层"
        Remote["remote/index.ts<br/>@Remote 服务"]
    end

    subgraph "前端层"
        Client["client/index.ts<br/>设置 UI"]
        Settings["dsh-settings<br/>settings.yaml"]
    end

    Tool -->|"scanContent"| Scanner
    Tool -->|"store.*"| Store

    Ext -->|"scanContent"| Scanner
    Ext -->|"findDuplicate / judge"| Dedup
    Ext -->|"memory.add / update / list"| Store
    Ext -->|"ctx.llm.stream"| LLM

    Context -->|"memory.list"| Store
    Context -->|"buildMemorySectionText"| Policy

    Remote -->|"store.*"| Store

    Store -->|"entries / audit"| SD
    Store -->|"scanContent 纵深防御"| Scanner
    Store -->|"MemoryId / AuditId"| Brand

    Client -.->|"scope.set"| Settings
    Context -.->|"current() 读取"| Settings
```

---

## 关键设计观察 (用于代码分析改进)

| 观察点 | 说明 | 潜在改进方向 |
|--------|------|-------------|
| **双层扫描** | `scanContent` 在 tool 层和 store 层各执行一次 | 性能：可加缓存或标记已扫描条目避免重复 |
| **Fire-and-forget** | Review/Flush/Janitor 均用 `void ...catch(() => {})` | 可观测性：静默失败难以排查，可增加日志上报 |
| **快照冻结时机** | `session/created` 时冻结，设置修改后本会话不更新 | 一致性：用户修改设置需新会话才生效，可考虑版本号机制 |
| **Dedup Jaccard 阈值** | 硬编码 0.15，同 scope 才比较 | 可配置化：阈值可作为设置项暴露 |
| **提取预算** | `extractionCalls` per-session WeakMap，无全局限制 | 防护：多会话并发时可能超出预期 LLM 调用量 |
| **Janitor 仅 project 级** | global / user 永不衰减，仅 `session/created` 触发 | 频率：新会话创建即触发，高频会话场景可能频繁扫描 |
| **审计日志上限** | `trimAudit` 硬编码 200 条 | 可配置化：可暴露为设置项 |
| **冲突检测未接入** | `context/conflict.ts` 已实现但未在任何工作流中使用 | 可接入：在 review 提取后运行冲突检测，向用户提示矛盾记忆 |
