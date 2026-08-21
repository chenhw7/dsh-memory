# Sequence Diagrams

This document is derived from the `@chenhw7/dsh-memory` source code and covers all core workflows. It serves two purposes:

- **User introduction**: quickly understand how the plugin operates
- **Code analysis & improvement**: locate call chains, identify coupling points, evaluate optimization opportunities

---

## 1. Module Initialization & Service Composition

The plugin declares 6 bundle rows in `cordis.patch.yml`, loaded in dependency order. `storageDomain` is the injection source for all modules.

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
    Note over Host: Parse cordis.patch.yml<br/>Load in dependency order

    Host->>Store: apply(ctx) [inject: storageDomain]
    Store->>SD: ctx.get('storageDomain')
    SD-->>Store: Domain instance
    Store->>Store: domainTable('entries') + domainTable('audit')
    Store->>Host: ctx.memory = DomainMemoryStore

    Host->>Tool: apply(ctx) [inject: tools, ctx.get: memory]
    Tool->>Store: ctx.get('memory')
    Store-->>Tool: MemoryStore instance
    Tool->>Host: Register 8 memory_* tools

    Host->>Review: apply(ctx) [inject: llm, ctx.get: memory, sessionProjections]
    Review->>Store: ctx.get('memory')
    Review->>Host: Register accumulator + event listeners

    Host->>Context: apply(ctx) [inject: systemPrompt, ctx.get: memory]
    Context->>Store: ctx.get('memory')
    Context->>Host: Register memory settings + systemPrompt.section

    Host->>Remote: apply(ctx) [inject: memory]
    Remote->>Store: ctx.get('memory')
    Remote->>Host: Register @Remote service
```

---

## 2. Model-Initiated Write — `memory_add` Tool Call

The model writes memories via tool calls. Both the tool layer and the store layer execute `scanContent`, forming defense in depth.

```mermaid
sequenceDiagram
    participant Model as AI Model
    participant Tool as tool/index.ts
    participant Scanner as scanner.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    Model->>Tool: memory_add({ content, scope, category, projectName })
    Tool->>Tool: requireMemory(ctx)
    Tool->>Tool: validateProjectScope(input)

    Tool->>Scanner: scanContent(content)
    Note over Scanner: 29 regex patterns: secret / injection / exfiltration
    alt Sensitive pattern matched
        Scanner-->>Tool: ScanResult { hit: true, pattern }
        Tool-->>Model: throw "content rejected: ..."
    else Scan passed
        Scanner-->>Tool: ScanResult { hit: false }
        Tool->>Store: store.add(input)

        Note over Store: Defense in depth: re-validate
        Store->>Store: validateProjectScope(input)
        Store->>Scanner: scanContent(input.content)
        Scanner-->>Store: passed

        Store->>Store: MemoryId() → mint UUID
        Store->>SD: entries.put(id, entry)
        SD-->>Store: write success

        Store->>Store: appendAudit('add', id, entry, 'tool', sessionId)
        Store->>SD: audit.put(auditId, auditEntry)
        Store->>Store: trimAudit (cap 200)

        Store-->>Tool: { entry }
        Tool-->>Model: { entry: toEntryJson(entry) }
    end
```

---

## 3. Model-Initiated Search — `memory_search` Tool Call

The model searches existing memories, with keyword tokenization matching (including CJK per-character tokenization).

```mermaid
sequenceDiagram
    participant Model as AI Model
    participant Tool as tool/index.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    Model->>Tool: memory_search({ query, scope, category, limit })
    Tool->>Tool: requireMemory(ctx)
    Tool->>Store: store.search(query)

    Store->>Store: tokenizeQuery(query)
    Note over Store: Word boundary + CJK per-char split<br/>Case-folded

    Store->>SD: entries.getAll()
    SD-->>Store: all entries

    loop For each entry
        Store->>Store: filter by scope / category / projectName
        Store->>Store: tokenHitCount(entry, tokens)
    end

    Store->>Store: Sort by hits desc → updatedAt desc
    Store->>Store: slice(limit ?? 50)
    Store->>Store: void markRecalled(entries) [fire-and-forget]
    Store->>SD: entries.put(id, { ...entry, lastRecalledAt: now })

    Store-->>Tool: { entries, total }
    Tool-->>Model: { entries: toEntryJson[], total }
```

---

## 4. Automatic Learning — Periodic Review Extraction

Core workflow: accumulate session events → reach threshold → trigger LLM extraction → parse → scan → dedup → store.

```mermaid
sequenceDiagram
    participant SE as Session Events
    participant Acc as accumulator.ts
    participant Pre as agent/pre-step hook
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Scanner as scanner.ts
    participant Dedup as dedup.ts
    participant Store as store/index.ts

    Note over SE,Acc: Phase 1: Accumulate candidate signals

    SE->>Acc: user/message event
    Acc->>Acc: messageText(event)
    Acc->>Acc: detectSignal(text)
    Note over Acc: Keyword patterns: "记住" "remember"<br/>Correction patterns: "不对" "actually"
    Acc->>Acc: Append { text, signal, seq } to candidates

    SE->>Acc: tool/result (error)
    Acc->>Acc: toolFailureText(event)
    Acc->>Acc: Append { text, signal: 'tool-failure', seq }

    Note over Pre,Ext: Phase 2: Threshold check & trigger

    Pre->>Pre: sessionProjections.snapshot(session)
    Pre->>Pre: unprocessed = candidates.filter(seq > highWaterMark)
    alt unprocessed count < threshold (default 3)
        Pre-->>Pre: no-op, return next()
    else Threshold reached
        Pre->>Pre: checkBudget(session)
        Pre->>Ext: runReviewExtraction(ctx, agent, candidates, ...)

        Note over Ext,LLM: Phase 3: LLM extraction

        Ext->>Store: memory.list() → current memory snapshot
        Store-->>Ext: existing entries
        Ext->>Ext: renderMemorySnapshot(memory)
        Ext->>Ext: buildReviewMessages(snapshot, candidates)
        Ext->>LLM: ctx.llm.stream({ system, messages, signal })
        LLM-->>Ext: streamed text (chunk by chunk)
        Ext->>Ext: collectStreamText(chunks)

        Note over Ext,Dedup: Phase 4: Parse + scan + dedup + store

        Ext->>Ext: parseExtractedMemories(text)
        Note over Ext: Line format: "scope: content"

        loop For each ParsedMemory
            Ext->>Ext: Infer category (strip "procedure" prefix)
            Ext->>Scanner: scanContent(content)
            alt Rejected by scanner
                Scanner-->>Ext: rejected → skip this item
            else Passed
                Ext->>Dedup: findDuplicate(content, scope, existing)
                Note over Dedup: Jaccard ≥ 0.15, same scope only

                alt Candidate duplicate found
                    Ext->>Dedup: buildJudgePrompt(old, new)
                    Ext->>LLM: ctx.llm.stream(judgePrompt)
                    LLM-->>Ext: verdict text
                    Ext->>Dedup: parseJudgeVerdict(text)

                    alt verdict = "duplicate"
                        Ext->>Dedup: mergeContent(old, new)
                        Ext->>Store: store.update(dupId, merged)
                    else verdict = "update"
                        Ext->>Store: store.update(dupId, newContent)
                    else verdict = "new"
                        Ext->>Store: store.add(input)
                    end
                else No duplicate
                    Ext->>Store: store.add(input)
                end
            end
        end

        Ext-->>Pre: parsed.length
        Pre->>Pre: Advance highWaterMark
    end

    Pre-->>Pre: return next() [step proceeds regardless of review outcome]
```

---

## 5. Compaction Flush

When context is compacted, memories are extracted from fragments about to be lost. Fire-and-forget — never blocks compaction.

```mermaid
sequenceDiagram
    participant Comp as compaction/end event
    participant Review as review/index.ts
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Dedup as dedup.ts
    participant Store as store/index.ts

    Comp->>Review: compaction/end { compactionId, error: undefined }
    Review->>Review: checkBudget(session)
    Review->>Ext: flushOnCompaction(ctx, session, compactionId, ...)

    Note over Ext: Phase 1: Collect shadowed fragments

    Ext->>Ext: findCompactionSummary(session, compactionId)
    Note over Ext: Search compaction/summary events

    Ext->>Ext: collectShadowedFragments(session, shadowedSeqs)
    loop For each shadowed seq
        Ext->>Ext: messageText(session.events[seq])
    end
    Note over Ext: fragments = [compacted conversation fragments]

    Note over Ext: Phase 2: LLM flush extraction

    Ext->>Ext: buildFlushMessages(fragments)
    Note over Ext: System prompt: "Conversation being compressed..."
    Ext->>LLM: ctx.llm.stream({ system: FLUSH_PROMPT, messages })
    LLM-->>Ext: streamed text
    Ext->>Ext: parseExtractedMemories(text)

    Note over Ext: Phase 3: Store (same as Review flow)

    loop For each ParsedMemory
        Ext->>Ext: scanContent(content)
        Ext->>Dedup: findDuplicate → judgeDuplicate (optional)
        Ext->>Store: store.add / store.update
    end

    Note over Review: void ...catch(() => {})<br/>fire-and-forget, never blocks compaction
```

---

## 6. Session Dispose Flush

When a session is disposed, memories are extracted from the full conversation. 5-second timeout limit.

```mermaid
sequenceDiagram
    participant SE as session/disposed event
    participant Review as review/index.ts
    participant Ext as extract.ts
    participant LLM as ctx.llm
    participant Store as store/index.ts

    SE->>Review: session/disposed(session)
    Review->>Review: checkBudget(session)
    Review->>Ext: flushOnDispose(ctx, session, ...)

    Note over Ext: Phase 1: Render full conversation

    Ext->>Ext: session.deriveMessages()
    Note over Ext: Render entire session as message list

    loop For each message
        Ext->>Ext: messageFragment(message) → "role: text"
    end

    Note over Ext: Phase 2: Time-limited extraction (5s timeout)

    Ext->>Ext: AbortSignal.timeout(5000)
    Ext->>Ext: buildFlushMessages(fragments)
    Ext->>LLM: ctx.llm.stream({ system: FLUSH_PROMPT, messages, signal })
    LLM-->>Ext: streamed text (may be truncated by timeout)
    Ext->>Ext: parseExtractedMemories(text)

    Note over Ext: Phase 3: Store

    loop For each ParsedMemory
        Ext->>Store: scanContent → dedup → store.add/update
    end

    Note over Review: void ...catch(() => {})<br/>best-effort, does not block dispose
```

---

## 7. Janitor Decay

Triggered on new session creation, decays stale project-scoped memories that haven't been recalled. Global and user-scoped memories are never decayed.

```mermaid
sequenceDiagram
    participant SC as session/created event
    participant Review as review/index.ts
    participant Store as store/index.ts
    participant SD as storageDomain

    SC->>Review: session/created (global listener)
    Review->>Store: ctx.get('memory')
    alt memory unavailable
        Review-->>Review: return (no-op)
    else memory available
        Review->>Store: memory.janitor(decayDays)

        Store->>SD: entries.getAll()
        SD-->>Store: all entries

        loop For each entry
            alt scope === 'global' or 'user'
                Note over Store: Skip, never decay
            else scope === 'project'
                alt entry.pinned === true
                    Note over Store: Skip, pin-protected
                else Not pinned
                    Store->>Store: lastActive = lastRecalledAt ?? createdAt
                    alt now - lastActive >= decayDays × 86400000
                        Store->>SD: entries.delete(entry.id)
                        Store->>Store: appendAudit('remove', id, entry, 'janitor')
                        Store->>SD: audit.put(auditId, auditEntry)
                        Store->>Store: trimAudit()
                    else Not expired
                        Note over Store: Retain
                    end
                end
            end
        end

        Store-->>Review: { decayed: count }
        Note over Review: void ...catch(() => {})<br/>best-effort
    end
```

---

## 8. System-Prompt Context Injection

A memory snapshot is frozen at session creation; each step's prompt assembly reads live settings + the frozen snapshot to compose the prompt section.

```mermaid
sequenceDiagram
    participant SC as session/created
    participant Context as context/index.ts
    participant Store as store/index.ts
    participant SP as systemPrompt assembly
    participant Policy as policy.ts

    Note over SC,Context: Phase 1: Freeze snapshot at session creation

    SC->>Context: session/created (global listener)
    Context->>Store: ctx.get('memory')
    alt memory unavailable
        Context->>Context: Freeze empty snapshot
    else memory available
        Context->>Store: memory.list('global' | 'project' | 'user')
        Store-->>Context: per-scope entries
        Context->>Context: readMemorySnapshot(memory, charLimit)
        Note over Context: Group by scope → truncate to charLimit
        Context->>Store: memory.list() (all)
        Store-->>Context: all entries
        Context->>Context: readMemoryIndex(memory, charLimit)
        Note over Context: Map to IndexEntry[]<br/>Sort by tier: project → user → global
        Context->>Context: sessionMemory.set(session, { content, index })
        Note over Context: WeakMap<Session, FrozenSnapshot><br/>Immutable for session lifetime
    end

    Note over SP,Policy: Phase 2: Assemble system prompt each step

    SP->>Context: systemPrompt.section('memory', order: 90)
    Context->>Context: current() → read live settings (mode, customText, charLimit)
    Note over Context: Settings can be modified live by user<br/>but snapshot is frozen
    Context->>Context: sessionMemory.get(session) → FrozenSnapshot

    Context->>Policy: buildMemorySectionText(mode, customText, snapshot.content, snapshot.index)

    alt mode = 'off'
        Policy-->>Context: "" (not injected)
    else mode = 'policy-only'
        Policy-->>Context: MEMORY_POLICY_TEXT
    else mode = 'custom'
        Policy-->>Context: customText
    else mode = 'full'
        Policy-->>Context: <memory-context>content</memory-context> + MEMORY_POLICY_TEXT
    else mode = 'index'
        Policy-->>Context: <memory-index>index</memory-index> + MEMORY_POLICY_TEXT
    end

    Context-->>SP: section text (empty string drops the section)
```

---

## 9. Frontend UI Remote Interaction

The browser calls `@Remote` services via the Typert protocol to manage memory data.

```mermaid
sequenceDiagram
    participant UI as Browser UI
    participant Remote as remote/index.ts
    participant Store as store/index.ts
    participant Scanner as scanner.ts
    participant SD as storageDomain

    Note over UI,Remote: Example: memory.add

    UI->>Remote: ctx.remote.memory.add({ content, scope, category, projectName, source: 'ui' })

    Remote->>Store: ctx.get('memory')
    Remote->>Store: store.add(input)

    Note over Store: Same defense-in-depth as tool path
    Store->>Store: validateProjectScope(input)
    Store->>Scanner: scanContent(input.content)
    alt Rejected by scanner
        Scanner-->>Store: rejected
        Store-->>Remote: throw Error
        Remote-->>UI: { error: message }
    else Passed
        Scanner-->>Store: passed
        Store->>Store: MemoryId()
        Store->>SD: entries.put(id, entry)
        Store->>Store: appendAudit('add', id, entry, 'ui', sessionId)
        Store->>SD: audit.put(auditId, auditEntry)
        Store-->>Remote: { entry }
        Remote-->>UI: { entry: toEntryJson(entry) }
    end

    Note over UI,Remote: Other remote methods (list/search/get/update/remove/pin/health/auditLog)<br/>all delegate to Store methods, errors returned as { error } not thrown
```

---

## 10. Client Settings UI

The browser registers a settings card; users modify configuration live, taking effect on the next system-prompt assembly.

```mermaid
sequenceDiagram
    participant Browser as Browser
    participant Client as client/index.ts
    participant Card as MemoryPluginCard.tsx
    participant Scope as settingsScope
    participant Context as context/index.ts

    Note over Browser,Client: Phase 1: Plugin load & registration

    Browser->>Client: apply(ctx)
    Client->>Client: ctx.locale.register('settings.memory', { zh, en })
    Client->>Client: ctx.settingsScope.bind({ namespace: 'memory' })
    Note over Client: Create SettingsScope<MemoryConfig>
    Client->>Browser: slots.inject('settings.plugin.item', MemoryPluginCard)

    Note over Browser,Card: Phase 2: User edits settings

    Browser->>Card: Render settings card
    Note over Card: Fields: memoryMode, customText,<br/>reviewEnabled, judgeEnabled,<br/>extractionThreshold, decayDays,<br/>maxSearchResults, extractionModelProvider/Model

    Card->>Scope: scope.get(field) → read current value
    Scope-->>Card: current config

    Browser->>Card: User edits fields → clicks Save
    Card->>Scope: scope.set(field, value)
    Scope->>Scope: Write to settings.yaml
    Note over Scope: Config takes effect immediately

    Note over Context: Phase 3: Takes effect on next prompt assembly

    Context->>Context: current() → read latest settings
    Note over Context: memoryMode / customText / charLimit<br/>affect buildMemorySectionText output
```

---

## Appendix: Module Dependencies & Service Call Graph

```mermaid
graph TB
    subgraph "Storage Layer"
        Store["store/index.ts<br/>DomainMemoryStore"]
        SD["storageDomain<br/>entries + audit tables"]
        Scanner["scanner.ts<br/>scanContent"]
        Brand["brand.ts<br/>MemoryId / AuditId"]
    end

    subgraph "Tool Layer"
        Tool["tool/index.ts<br/>8 memory_* tools"]
    end

    subgraph "Auto-Learning Layer"
        Acc["accumulator.ts<br/>pure fold function"]
        Ext["extract.ts<br/>LLM extraction + store"]
        Dedup["dedup.ts<br/>Jaccard prefilter + LLM judge"]
        LLM["dsh-llm<br/>ctx.llm.stream"]
    end

    subgraph "Context Layer"
        Context["context/index.ts<br/>snapshot + section"]
        Policy["policy.ts<br/>mode rendering"]
    end

    subgraph "Remote Layer"
        Remote["remote/index.ts<br/>@Remote service"]
    end

    subgraph "Frontend Layer"
        Client["client/index.ts<br/>settings UI"]
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
    Store -->|"scanContent defense-in-depth"| Scanner
    Store -->|"MemoryId / AuditId"| Brand

    Client -.->|"scope.set"| Settings
    Context -.->|"current() reads"| Settings
```

---

## Key Design Observations (for Code Analysis & Improvement)

| Observation | Description | Potential Improvement |
|-------------|-------------|----------------------|
| **Double scan** | `scanContent` runs at both tool layer and store layer | Performance: could cache or mark already-scanned items to avoid redundant work |
| **Fire-and-forget** | Review/Flush/Janitor all use `void ...catch(() => {})` | Observability: silent failures are hard to debug; could add logging/reporting |
| **Snapshot freeze timing** | Frozen at `session/created`; setting changes don't update current session | Consistency: user must start a new session for changes to take effect; consider a version-tag mechanism |
| **Dedup Jaccard threshold** | Hardcoded at 0.15, same scope only | Configurability: threshold could be exposed as a setting |
| **Extraction budget** | `extractionCalls` per-session WeakMap, no global limit | Protection: concurrent sessions may exceed expected LLM call volume |
| **Janitor project-only** | global / user never decay; only triggered on `session/created` | Frequency: fires on every new session, may scan too often in high-churn scenarios |
| **Audit log cap** | `trimAudit` hardcoded at 200 entries | Configurability: could be exposed as a setting |
| **Conflict detection not wired** | `context/conflict.ts` is implemented but not used in any workflow | Integration: could run conflict detection after review extraction to alert users of contradictory memories |
