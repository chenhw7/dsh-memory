/**
 * Wire types for the MemoryRemoteService (§3.8). These are the request/result
 * interfaces exposed through `@Remote` methods. The Typert generator reads
 * type symbols from this module's export surface.
 *
 * @module @chenhw7/dsh-memory/remote/types
 */

export type {
  MemoryEntryJson,
  MemoryListRequest,
  MemoryListResult,
  MemorySearchRequest,
  MemoryGetRequest,
  MemoryGetResult,
  MemoryAddRequest,
  MemoryAddResult,
  MemoryUpdateRequest,
  MemoryUpdateResult,
  MemoryRemoveRequest,
  MemoryRemoveResult,
  MemoryPinRequest,
  MemoryPinResult,
  MemoryHealthResult,
  MemoryAuditRequest,
  MemoryAuditResult,
} from './index.ts'
