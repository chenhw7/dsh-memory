import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyAccumulator,
  accumulatorSchema,
  detectSignal,
  emptyAccumulator,
  messageText,
  toolSignature,
  PITFALL_RESOLVED_SIGNAL,
} from '../src/review/accumulator.ts'

/** Build a minimal `tool/call` session event. */
function toolCallEvent(seq: number, callId: string, name: string, args: unknown): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq,
    time: 0,
    data: { turn: 1, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  } as unknown as SessionEvent<'tool/call'>
}

/** Build a minimal `tool/result` session event, optionally carrying an error. */
function toolResultEvent(seq: number, callId: string, error?: { name: string; code: string }, texts: string[] = []): SessionEvent<'tool/result'> {
  return {
    type: 'tool/result',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'r' as never,
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: texts.map(text => ({ type: 'text', text })) }],
        source: { kind: 'tool' },
      },
      ...error !== undefined ? { error } : {},
    },
    surfaceOp: 'append',
  } as unknown as SessionEvent<'tool/result'>
}

/** Build a minimal `user/message` session event. */
function userEvent(seq: number, text: string): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq,
    time: 0,
    data: {
      id: 'm' as never,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  } as unknown as SessionEvent<'user/message'>
}

/** Build a minimal `assistant/message` session event. */
function assistantEvent(seq: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'a' as never,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
    surfaceOp: 'append',
  } as unknown as SessionEvent<'assistant/message'>
}

/** Build a minimal `turn/start` event (a non-message event). */
function turnStartEvent(seq: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq, time: 0, data: { turn: 1 } } as SessionEvent<'turn/start'>
}

describe('applyAccumulator', () => {
  describe('returns the same state reference for irrelevant events', () => {
    it('ignores non-message events', () => {
      const state = emptyAccumulator
      const next = applyAccumulator(state, turnStartEvent(0))
      expect(next).toBe(state)
    })

    it('ignores assistant messages (context only, no signal collected)', () => {
      const state = emptyAccumulator
      const next = applyAccumulator(state, assistantEvent(1, 'sure'))
      expect(next).toBe(state)
    })

    it('ignores user messages with no signal', () => {
      const state = emptyAccumulator
      const next = applyAccumulator(state, userEvent(1, 'hello there'))
      expect(next).toBe(state)
    })

    it('ignores user messages with empty text', () => {
      const state = emptyAccumulator
      const next = applyAccumulator(state, userEvent(1, '   '))
      expect(next).toBe(state)
    })
  })

  describe('collects keyword-hit candidates', () => {
    const cases: Array<[string, string]> = [
      ['记住这个偏好', '记住'],
      ['别忘了每天备份', '别忘了'],
      ['以后都用中文回复', '以后都'],
      ['Remember that I prefer concise answers', 'remember that'],
      ["Don't forget the deploy steps", "don't forget"],
      ['From now on use pnpm', 'from now on'],
    ]
    for (const [text, label] of cases) {
      it(`collects "${label}"`, () => {
        const next = applyAccumulator(emptyAccumulator, userEvent(1, text))
        expect(next).not.toBe(emptyAccumulator)
        expect(next.count).toBe(1)
        expect(next.candidates[0]!.signal).toBe('keyword')
        expect(next.candidates[0]!.text).toBe(text)
        expect(next.candidates[0]!.seq).toBe(1)
      })
    }
  })

  describe('collects correction-signal candidates', () => {
    const cases: Array<[string, string]> = [
      ['不对，应该是这样', '不对'],
      ['不要那样做', '不要'],
      ['No, I said use pnpm', 'no, I said'],
      ["That's wrong, try again", "that's wrong"],
      ['Actually use the other branch', 'actually'],
    ]
    for (const [text, label] of cases) {
      it(`collects "${label}"`, () => {
        const next = applyAccumulator(emptyAccumulator, userEvent(2, text))
        expect(next).not.toBe(emptyAccumulator)
        expect(next.candidates[0]!.signal).toBe('correction')
      })
    }
  })

  it('keyword takes priority over correction when both match', () => {
    // "remember that ... actually" — keyword should win.
    const next = applyAccumulator(emptyAccumulator, userEvent(1, 'remember that, actually no'))
    expect(next.candidates[0]!.signal).toBe('keyword')
  })

  it('accumulates multiple candidates across events', () => {
    let state: typeof emptyAccumulator = emptyAccumulator
    state = applyAccumulator(state, userEvent(1, '记住 A'))
    state = applyAccumulator(state, userEvent(2, 'hello'))
    state = applyAccumulator(state, userEvent(3, '不对 B'))
    expect(state.count).toBe(2)
    expect(state.candidates.map(c => c.seq)).toEqual([1, 3])
  })
})

describe('detectSignal', () => {
  it('returns undefined for plain text', () => {
    expect(detectSignal('just chatting')).toBeUndefined()
  })
  it('detects keyword signals case-insensitively', () => {
    expect(detectSignal('REMEMBER THAT')).toBe('keyword')
  })
  it('detects correction signals', () => {
    expect(detectSignal("that's wrong")).toBe('correction')
  })
})

describe('messageText', () => {
  it('extracts text from user/message', () => {
    expect(messageText(userEvent(1, 'hi'))).toBe('hi')
  })
  it('extracts text from assistant/message', () => {
    expect(messageText(assistantEvent(1, 'sure'))).toBe('sure')
  })
  it('returns undefined for non-message events', () => {
    expect(messageText(turnStartEvent(1))).toBeUndefined()
  })
  it('concatenates multiple text blocks', () => {
    const event = {
      type: 'user/message', seq: 1, time: 0,
      data: {
        id: 'm', role: 'user',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    } as unknown as SessionEvent
    expect(messageText(event)).toBe('a\nb')
  })
})

describe('failure-streak detection', () => {
  it('emits one pitfall-resolved candidate after fail×2 + success', () => {
    let state = emptyAccumulator
    state = applyAccumulator(state, toolCallEvent(1, 'c1', 'bash', { command: 'vitest run' }))
    state = applyAccumulator(state, toolResultEvent(2, 'c1', { name: 'Error', code: 'FAIL' }, ['exit code 1']))
    state = applyAccumulator(state, toolCallEvent(3, 'c2', 'bash', { command: 'vitest run' }))
    state = applyAccumulator(state, toolResultEvent(4, 'c2', { name: 'Error', code: 'FAIL' }, ['exit code 1']))
    state = applyAccumulator(state, toolCallEvent(5, 'c3', 'bash', { command: 'vitest run' }))
    state = applyAccumulator(state, toolResultEvent(6, 'c3'))
    expect(state.count).toBe(1)
    const candidate = state.candidates[0]!
    expect(candidate.signal).toBe(PITFALL_RESOLVED_SIGNAL)
    expect(candidate.seq).toBe(6)
    expect(candidate.text).toContain('tool "bash"')
    expect(candidate.text).toContain('signature: bash:vitest run')
    expect(candidate.text).toContain('failed 2 time(s)')
    expect(candidate.text).toContain('exit code 1')
    // The streak and all calls are cleared.
    expect(Object.keys(state.openStreaks)).toHaveLength(0)
    expect(Object.keys(state.openCalls)).toHaveLength(0)
    // A later success with no open streak is a pure no-op for candidates.
    state = applyAccumulator(state, toolCallEvent(7, 'c4', 'bash', { command: 'vitest run' }))
    state = applyAccumulator(state, toolResultEvent(8, 'c4'))
    expect(state.count).toBe(1)
  })

  it('emits nothing for fail×1 + success, and the streak resets', () => {
    let state = emptyAccumulator
    for (const i of [0, 1]) {
      state = applyAccumulator(state, toolCallEvent(i * 2 + 1, `c${i * 2 + 1}`, 'bash', { command: 'tsc --noEmit' }))
      state = applyAccumulator(state, toolResultEvent(i * 2 + 2, `c${i * 2 + 1}`, { name: 'Error', code: 'TS1' }))
      state = applyAccumulator(state, toolCallEvent(i * 2 + 3, `c${i * 2 + 3}`, 'bash', { command: 'tsc --noEmit' }))
      state = applyAccumulator(state, toolResultEvent(i * 2 + 4, `c${i * 2 + 3}`))
    }
    expect(state.count).toBe(0)
    expect(Object.keys(state.openStreaks)).toHaveLength(0)
  })

  it('resets an interrupted streak rather than carrying it over', () => {
    let state = emptyAccumulator
    state = applyAccumulator(state, toolCallEvent(1, 'c1', 'bash', { command: 'npm test' }))
    state = applyAccumulator(state, toolResultEvent(2, 'c1', { name: 'E', code: 'X' }))
    // One success interrupts the streak...
    state = applyAccumulator(state, toolCallEvent(3, 'c2', 'bash', { command: 'npm test' }))
    state = applyAccumulator(state, toolResultEvent(4, 'c2'))
    // ...so a following single failure must not pair with the old one.
    state = applyAccumulator(state, toolCallEvent(5, 'c3', 'bash', { command: 'npm test' }))
    state = applyAccumulator(state, toolResultEvent(6, 'c3', { name: 'E', code: 'X' }))
    expect(state.count).toBe(0)
    expect(Object.keys(state.openStreaks)).toEqual(['bash:npm test'])
  })

  it('never pairs different signatures', () => {
    let state = emptyAccumulator
    state = applyAccumulator(state, toolCallEvent(1, 'c1', 'bash', { command: 'npm test' }))
    state = applyAccumulator(state, toolResultEvent(2, 'c1', { name: 'E', code: 'X' }))
    state = applyAccumulator(state, toolCallEvent(3, 'c2', 'bash', { command: 'git status' }))
    state = applyAccumulator(state, toolResultEvent(4, 'c2', { name: 'E', code: 'X' }))
    // One failure per signature — resolving one must produce nothing.
    state = applyAccumulator(state, toolCallEvent(5, 'c3', 'bash', { command: 'npm test' }))
    state = applyAccumulator(state, toolResultEvent(6, 'c3'))
    expect(state.count).toBe(0)
    expect(Object.keys(state.openStreaks)).toEqual(['bash:git status'])
  })

  it('honors a custom pitfall threshold', () => {
    let state = emptyAccumulator
    for (const i of [0, 1, 2]) {
      state = applyAccumulator(state, toolCallEvent(i * 2 + 1, `c${i * 2 + 1}`, 'bash', { command: 'make build' }))
      state = applyAccumulator(state, toolResultEvent(i * 2 + 2, `c${i * 2 + 1}`, { name: 'E', code: 'X' }))
    }
    state = applyAccumulator(state, toolCallEvent(7, 'c7', 'bash', { command: 'make build' }))
    // threshold 4: three failures are not enough.
    let next = applyAccumulator(state, toolResultEvent(8, 'c7'), 4)
    expect(next.count).toBe(0)
    // threshold 2: the same three failures pair and report the full count.
    next = applyAccumulator(state, toolResultEvent(8, 'c7'), 2)
    expect(next.count).toBe(1)
    expect(next.candidates[0]!.text).toContain('failed 3 time(s)')
  })

  it('ignores a result whose call was never seen', () => {
    const next = applyAccumulator(emptyAccumulator, toolResultEvent(1, 'unknown', { name: 'E', code: 'X' }))
    expect(next).toBe(emptyAccumulator)
  })

  it('evicts open calls and streaks beyond their caps', () => {
    let state = emptyAccumulator
    for (let i = 0; i < 70; i++) {
      state = applyAccumulator(state, toolCallEvent(i + 1, `c${i}`, 'bash', { command: `cmd${i}` }))
    }
    expect(Object.keys(state.openCalls).length).toBeLessThanOrEqual(64)
    // 1 failure each across 12 distinct signatures → capped at 8 streaks.
    for (let i = 0; i < 12; i++) {
      state = applyAccumulator(state, toolCallEvent(100 + i * 2, `x${i}`, 'bash', { command: `sig${i}` }))
      state = applyAccumulator(state, toolResultEvent(101 + i * 2, `x${i}`, { name: 'E', code: 'X' }))
    }
    expect(Object.keys(state.openStreaks).length).toBeLessThanOrEqual(8)
  })
})

describe('toolSignature', () => {
  it('collapses command arguments to the first two tokens', () => {
    expect(toolSignature('bash', JSON.stringify({ command: 'vitest run --reporter=verbose' }))).toBe('bash:vitest run')
  })
  it('uses path-like arguments verbatim', () => {
    expect(toolSignature('edit', JSON.stringify({ path: 'src/a.ts', old: 'x' }))).toBe('edit:src/a.ts')
    expect(toolSignature('read', JSON.stringify({ file_path: 'src/b.ts' }))).toBe('read:src/b.ts')
  })
  it('falls back to the bare tool name', () => {
    expect(toolSignature('bash', 'not json')).toBe('bash')
    expect(toolSignature('bash', JSON.stringify({ verbose: true }))).toBe('bash')
  })
})

describe('accumulatorSchema', () => {
  it('validates a well-formed state', () => {
    const state = { candidates: [{ text: 't', signal: 'keyword', seq: 1 }], count: 1, openCalls: {}, openStreaks: {} }
    expect(() => accumulatorSchema.parse(state)).not.toThrow()
  })
  it('parses to the expected shape', () => {
    const state = { candidates: [{ text: 't', signal: 'correction', seq: 5 }], count: 1, openCalls: { c1: { name: 'bash', signature: 'bash:ls', seq: 2 } }, openStreaks: {} }
    const parsed = accumulatorSchema.parse(state)
    expect(parsed.candidates[0]!.seq).toBe(5)
    expect(parsed.openCalls.c1!.signature).toBe('bash:ls')
  })
  it('rejects a state missing count', () => {
    expect(() => accumulatorSchema.parse({ candidates: [], openCalls: {}, openStreaks: {} })).toThrow()
  })
})
