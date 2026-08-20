/**
 * Golden corpus for `parseExtractedMemories`: input lines and the expected
 * parsed output. Used for regression checks on the extraction parser (TODO §3.1).
 */

export interface ExtractGoldenCase {
  readonly label: string
  readonly input: string
  readonly expected: readonly { readonly scope: string; readonly content: string }[]
}

/** Cases the parser MUST handle correctly (positive + edge cases). */
export const EXTRACT_GOLDEN: readonly ExtractGoldenCase[] = [
  {
    label: 'three valid lines',
    input: 'global: network blocks npm proxy X\nproject: use pnpm here\nuser: prefers concise answers',
    expected: [
      { scope: 'global', content: 'network blocks npm proxy X' },
      { scope: 'project', content: 'use pnpm here' },
      { scope: 'user', content: 'prefers concise answers' },
    ],
  },
  {
    label: 'blank lines skipped',
    input: 'user: likes coffee\n\nglobal: note about builds',
    expected: [
      { scope: 'user', content: 'likes coffee' },
      { scope: 'global', content: 'note about builds' },
    ],
  },
  {
    label: 'unknown scope tag dropped',
    input: 'memory: should be dropped\nglobal: kept',
    expected: [
      { scope: 'global', content: 'kept' },
    ],
  },
  {
    label: 'missing colon dropped',
    input: 'no colon here\nglobal: valid',
    expected: [
      { scope: 'global', content: 'valid' },
    ],
  },
  {
    label: 'empty content after colon dropped',
    input: 'global:   \nuser: valid content',
    expected: [
      { scope: 'user', content: 'valid content' },
    ],
  },
  {
    label: 'scope case-insensitive',
    input: 'GLOBAL: upper case\nUser: mixed case',
    expected: [
      { scope: 'global', content: 'upper case' },
      { scope: 'user', content: 'mixed case' },
    ],
  },
  {
    label: 'leading/trailing whitespace trimmed',
    input: '  global:   trimmed content   \n  user:   also trimmed  ',
    expected: [
      { scope: 'global', content: 'trimmed content' },
      { scope: 'user', content: 'also trimmed' },
    ],
  },
  {
    label: 'colon in content preserved',
    input: 'global: the answer is: 42',
    expected: [
      { scope: 'global', content: 'the answer is: 42' },
    ],
  },
  {
    label: 'empty input',
    input: '',
    expected: [],
  },
  {
    label: 'only whitespace and blanks',
    input: '\n\n  \n\n',
    expected: [],
  },
]
