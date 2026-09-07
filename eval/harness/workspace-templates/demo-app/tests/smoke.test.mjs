import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DetailCache } from '../src/cache.ts'

test('a write invalidates the old value before landing the new one', () => {
  const cache = new DetailCache('b1')
  cache.put('page-1', { title: 'old' })
  cache.put('page-1', { title: 'new' })
  assert.equal(cache.get('page-1').title, 'new')
})

test('the edge key carries the build hash', () => {
  const cache = new DetailCache('b7f3')
  assert.equal(cache.edgeKey('page-1'), 'detail:page-1:b7f3')
})
