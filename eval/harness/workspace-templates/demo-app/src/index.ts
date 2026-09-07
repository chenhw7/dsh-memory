import { DetailCache } from './cache.ts'

/** One detail page's render payload. */
export interface DetailPayload {
  readonly id: string
  readonly title: string
}

const cache = new DetailCache(process.env['DEMO_BUILD_HASH'] ?? 'dev')

/** Render one detail page through the write-through cache. */
export function renderDetail(id: string, title: string): DetailPayload {
  const payload: DetailPayload = { id, title }
  cache.put(id, payload)
  return payload
}
