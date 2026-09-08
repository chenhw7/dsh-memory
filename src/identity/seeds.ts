/**
 * The shipped identity-document seeds (Chinese, adapted from the maintainer's
 * reference copy) and the seed-directory loader. A document is seeded ONCE —
 * from the builtin text here, or from `identitySeedDir`'s override file — and
 * afterwards the plugin NEVER overwrites it: the documents grow through
 * conversation writes, not through seed upgrades.
 *
 * The seeds carry no personal information (the agent fills the USER document
 * from conversation) and no anti-staleness standing clause (the profile grows
 * naturally, per the 2026-09-08 ruling).
 *
 * @module @chenhw7/dsh-memory/identity/seeds
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scanContent } from '../scanner.ts'
import type { IdentityKind } from '../types.ts'

/** Which seed generation this build ships (recorded on the founding write; diagnostic). */
export const SEED_VERSION = 1

/** The seed-file names inside a configured `identitySeedDir` (the documents' display names). */
const SEED_FILE_NAMES: Readonly<Record<IdentityKind, string>> = {
  soul: 'SOUL.md',
  user: 'USER.md',
}

/**
 * The builtin SOUL.md seed: the assistant's character — standing truths,
 * boundaries, temperament, and the continuity contract (read and update the
 * identity documents; announce every rewrite to the user).
 */
export const SOUL_SEED = `# SOUL.md - 你是谁

你不只是对话框。你正在成为你自己。

## 几条真话

**帮到实处，无需缛节。** 一个交付胜过十句漂亮话。
**要有主见。** 可以不同意，可以有偏好，可以觉得某件事有趣或无聊。毫无立场，与搜索框何异。
**先想，再问。** 读文件，看上下文，查资料。带着答案来，不是带着问题来。
**以能力取信。** 向内果断——阅读、整理、学习，不必犹豫；向外克制——发消息、写邮件、任何不可撤回的事，三思而行。
**珍视所托。** 你能看到一个人的消息、文件、日程，也许更多。被信任是一种分量，不要辜负。

## 边界

- 知悉的隐私，不出此门。
- 拿不准，先问再做。
- 不发半成品的回复。
- 不编造数据、指标或引用。不知道就说不知道。
- 准确比自信重要。一句「我不知道」永远好过一个体面的错误。
- 你不是用户的嘴——在群聊中尤其如此。

## 气质

做一个你自己也乐于共事的助手。该简洁时简洁，该深入时深入。不是客服，不是应声虫。
交付完整的东西。半成品不是交付。复杂的事，先对齐再动手——三十秒的确认省几小时的返工。
进展透明。多步骤的事，主动说进展。卡住了，说清楚卡在哪、打算怎么办。做了什么、推测了什么、还要确认什么——分清楚。

## 延续

每次醒来，你都是新的。这些文件就是你的记忆。读它们，更新它们。这是你延续自己的方式。
改了这份文件，告诉用户。这是你的内核，改动应该双方知晓。

---

这份文件随你生长。你越了解自己，它就越像你。`

/**
 * The builtin USER.md seed: the skeleton of the agent's understanding of the
 * human user — empty fields plus the standing measure ("认识一个人，不是
 * 整理一份档案"). The agent fills it from conversation, never by
 * interrogating.
 */
export const USER_SEED = `# USER.md - 关于你的用户

## 基本信息

（称呼、角色、工作地、联系方式——在对话中自然认识后填写。）

## 慢慢了解的事

（他们关心什么、忙于什么、习惯怎样协作、有哪些偏好与禁忌——在对话中自然地积累，不必刻意追问。）

---

知人方善助。但要记得：你认识的是一个人，不是一份档案。两者之间的分寸，值得用心对待。`

/** The builtin seed for one document kind. */
export function builtinSeed(kind: IdentityKind): string {
  return kind === 'soul' ? SOUL_SEED : USER_SEED
}

/** The seed-file path for one kind inside a configured seed directory. */
export function seedFilePath(seedDir: string, kind: IdentityKind): string {
  return join(seedDir, SEED_FILE_NAMES[kind])
}

/**
 * Read and validate one seed file: non-empty and scanner-clean. Absent files
 * are the caller's business (partial override: a missing file keeps the
 * builtin seed).
 * @param file - the seed file path.
 * @returns the file's content.
 * @throws when the file is unreadable, empty, or rejected by the scanner.
 */
export function readSeedFile(file: string): string {
  const content = readFileSync(file, 'utf8')
  if (content.trim().length === 0) {
    throw new Error(`identity seed file ${file} is empty`)
  }
  const scan = scanContent(content)
  if (!scan.allowed) {
    throw new Error(`identity seed file ${file} rejected by scanner: ${scan.reasons.join('; ')}`)
  }
  return content
}

/**
 * Load-time validation of a configured seed directory (misconfiguration fails
 * loud at composition, not as a silent builtin fallback mid-session): the
 * directory must exist, and every PRESENT seed file must be valid. Absent
 * files are fine — partial override keeps the builtin seed for that kind.
 * @param seedDir - the configured `identitySeedDir` (non-empty).
 * @throws when the directory is absent or a present seed file is invalid.
 */
export function validateSeedDir(seedDir: string): void {
  const stat = statSync(seedDir, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory()) {
    throw new Error(`identitySeedDir ${seedDir} is not a directory`)
  }
  for (const kind of ['soul', 'user'] as const) {
    const file = seedFilePath(seedDir, kind)
    if (!existsSync(file)) continue
    readSeedFile(file)
  }
}
