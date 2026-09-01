import type {
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'

// Wire types (mirrors src/remote/types.ts but client-safe)
export interface MemoryEntryJson {
  id: string
  scope: 'global' | 'project' | 'user'
  category?: string
  content: string
  summary?: string
  projectName?: string
  createdAt: number
  updatedAt: number
  pinned?: boolean
  lastRecalledAt?: number
  staleSince?: number
}
export type AuditSourceJson = 'tool' | 'review' | 'flush' | 'ui' | 'janitor'
export interface MemorySuggestionJson {
  id: string
  scope: 'global' | 'project' | 'user'
  category?: string
  content: string
  summary?: string
  projectName?: string
  hits: number
  firstSeenAt: number
  lastSeenAt: number
  targetEntryId?: string
  source: AuditSourceJson
  sessionId?: string
}
export interface MemoryListResult { entries: readonly MemoryEntryJson[]; total: number }
export interface MemorySearchResult { entries: readonly MemoryEntryJson[]; total: number }
export interface MemoryGetResult { entry?: MemoryEntryJson; found: boolean }
export interface MemoryAddResult { entry?: MemoryEntryJson; error?: string }
export interface MemoryUpdateResult { entry?: MemoryEntryJson; found: boolean; error?: string }
export interface MemoryRemoveResult { removed: boolean }
export interface MemoryPinResult { entry?: MemoryEntryJson; found: boolean }
export interface MemorySuggestListResult { suggestions: readonly MemorySuggestionJson[] }
export interface MemorySuggestAdoptRequest { id: string; content?: string; category?: string; summary?: string }
export interface MemorySuggestAdoptResult { entry?: MemoryEntryJson; found: boolean; error?: string }
export interface MemorySuggestRejectResult { rejected: boolean }
export interface MemoryHealthResult {
  totalEntries: number
  byScope: { global: number; project: number; user: number }
  pinned: number
  auditRecords: number
  stale?: number
  lastActivityTs?: number
  lastExtractionTs?: number
  backgroundFailures?: Record<string, number>
}
export interface MemoryProjectsResult { projects: readonly string[] }
export interface AuditEntryJson {
  id: string
  op: 'add' | 'update' | 'remove'
  entryId: string
  scope: 'global' | 'project' | 'user'
  category?: string
  source: AuditSourceJson
  sessionId?: string
  ts: number
  contentPreview: string
}
export interface MemoryAuditResult { entries: readonly AuditEntryJson[] }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d656d6f727952656d6f7465 {
    list: (request: { scope?: string; projectName?: string; limit?: number; offset?: number }) => Promise<RemoteResult<MemoryListResult>>
    search: (request: { scope?: string; category?: string; projectName?: string; query?: string; limit?: number }) => Promise<RemoteResult<MemorySearchResult>>
    get: (request: { id: string }) => Promise<RemoteResult<MemoryGetResult>>
    add: (request: { scope: string; content: string; category?: string; projectName?: string }) => Promise<RemoteResult<MemoryAddResult>>
    update: (request: { id: string; content?: string; category?: string; summary?: string }) => Promise<RemoteResult<MemoryUpdateResult>>
    removeEntry: (request: { id: string }) => Promise<RemoteResult<MemoryRemoveResult>>
    pin: (request: { id: string; pinned: boolean }) => Promise<RemoteResult<MemoryPinResult>>
    archive: (request: { id: string; archived: boolean }) => Promise<RemoteResult<MemoryPinResult>>
    suggestList: () => Promise<RemoteResult<MemorySuggestListResult>>
    suggestAdopt: (request: MemorySuggestAdoptRequest) => Promise<RemoteResult<MemorySuggestAdoptResult>>
    suggestReject: (request: { id: string }) => Promise<RemoteResult<MemorySuggestRejectResult>>
    health: () => Promise<RemoteResult<MemoryHealthResult>>
    projects: () => Promise<RemoteResult<MemoryProjectsResult>>
    auditLog: (request: { limit?: number }) => Promise<RemoteResult<MemoryAuditResult>>
  }
  interface TypertRemoteMap {
    'memoryRemote/list': (request: { scope?: string; projectName?: string; limit?: number; offset?: number }) => Promise<RemoteResult<MemoryListResult>>
    'memoryRemote/search': (request: { scope?: string; category?: string; projectName?: string; query?: string; limit?: number }) => Promise<RemoteResult<MemorySearchResult>>
    'memoryRemote/get': (request: { id: string }) => Promise<RemoteResult<MemoryGetResult>>
    'memoryRemote/add': (request: { scope: string; content: string; category?: string; projectName?: string }) => Promise<RemoteResult<MemoryAddResult>>
    'memoryRemote/update': (request: { id: string; content?: string; category?: string; summary?: string }) => Promise<RemoteResult<MemoryUpdateResult>>
    'memoryRemote/removeEntry': (request: { id: string }) => Promise<RemoteResult<MemoryRemoveResult>>
    'memoryRemote/pin': (request: { id: string; pinned: boolean }) => Promise<RemoteResult<MemoryPinResult>>
    'memoryRemote/archive': (request: { id: string; archived: boolean }) => Promise<RemoteResult<MemoryPinResult>>
    'memoryRemote/suggestList': () => Promise<RemoteResult<MemorySuggestListResult>>
    'memoryRemote/suggestAdopt': (request: MemorySuggestAdoptRequest) => Promise<RemoteResult<MemorySuggestAdoptResult>>
    'memoryRemote/suggestReject': (request: { id: string }) => Promise<RemoteResult<MemorySuggestRejectResult>>
    'memoryRemote/health': () => Promise<RemoteResult<MemoryHealthResult>>
    'memoryRemote/projects': () => Promise<RemoteResult<MemoryProjectsResult>>
    'memoryRemote/auditLog': (request: { limit?: number }) => Promise<RemoteResult<MemoryAuditResult>>
  }
  interface TypertRemoteNamespaceMap {
    'memoryRemote': TypertRemoteNamespace$6d656d6f727952656d6f7465
  }
}

declare const TYPERT_REMOTE: TypertRemoteContribution
export default TYPERT_REMOTE
