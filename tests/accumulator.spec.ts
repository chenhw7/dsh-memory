import { describe, it, expect } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyAccumulator,
  accumulatorSchema,
  detectSignal,
  emptyAccumulator,
  messageText,
} from '../src/review/accumulator.ts'

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

describe('accumulatorSchema', () => {
  it('validates a well-formed state', () => {
    const state = { candidates: [{ text: 't', signal: 'keyword', seq: 1 }], count: 1 }
    expect(() => accumulatorSchema.parse(state)).not.toThrow()
  })
  it('parses to the expected shape', () => {
    const state = { candidates: [{ text: 't', signal: 'correction', seq: 5 }], count: 1 }
    const parsed = accumulatorSchema.parse(state)
    expect(parsed.candidates[0]!.seq).toBe(5)
  })
  it('rejects a state missing count', () => {
    expect(() => accumulatorSchema.parse({ candidates: [] })).toThrow()
  })
})
