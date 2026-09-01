/**
 * Content scanner for the long-term memory domain: pure functions that detect
 * secrets, prompt-injection patterns, and exfiltration attempts before content
 * is persisted. Every memory write — whether from a model tool call or a
 * background review/flush — passes through {@link scanContent} before the
 * store accepts it.
 *
 * The scanner is deliberately a dependency-free pure module shared by the tool
 * Consumer and the review function plugin without importing each other.
 *
 * @module @chenhw7/dsh-memory/scanner
 */

import type { ScanResult } from './types.ts'

/** A single pattern match found by the scanner. */
interface ScanHit {
  /** Which detection class fired. */
  readonly kind: 'secret' | 'injection' | 'exfiltration'
  /** The pattern name that matched. */
  readonly pattern: string
}

/**
 * Patterns the user has explicitly allowlisted (§3.10). When a hit's pattern
 * name matches an allowlisted entry AND the matched substring is in the
 * allowlist's expected-values set, the hit is suppressed. This lets users
 * store content like `Example: sk-xxxx (redacted)` without triggering the
 * scanner, while real keys of the same shape are still caught.
 */
export interface ScanAllowlist {
  /** Pattern names whose specific matched values are expected. */
  readonly [patternName: string]: readonly string[]
}

/** The active allowlist (mutable so callers can configure it at runtime). */
let activeAllowlist: ScanAllowlist = {}

/**
 * Set the active allowlist. Pass an empty object to clear.
 * @param allowlist - pattern names mapped to their expected (safe) values.
 */
export function setAllowlist(allowlist: ScanAllowlist): void {
  activeAllowlist = allowlist
}

/** The currently active allowlist, for diagnostics and tests that restore state. */
export function getAllowlist(): ScanAllowlist {
  return activeAllowlist
}

/** Check whether a hit is allowlisted: pattern name matches and the matched substring is expected. */
function isAllowlisted(content: string, hit: ScanHit): boolean {
  const allowed = activeAllowlist[hit.pattern]
  if (allowed === undefined) return false
  return allowed.some(value => content.includes(value))
}

/** API key and token patterns (high-confidence secrets). */
const SECRET_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'DeepSeek API key', re: /sk-[a-f0-9]{32,}/i },
  { name: 'OpenAI API key', re: /sk-[a-zA-Z0-9]{48,}/ },
  { name: 'Anthropic API key', re: /sk-ant-[a-zA-Z0-9]{40,}/ },
  { name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS secret key', re: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/ },
  { name: 'Generic Bearer token', re: /Bearer\s+[a-z0-9._~+/=-]{20,}/i },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'SSH private key header', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Stripe key', re: /(?:sk|pk)_(?:test|live)_[A-Za-z0-9]{24,}/ },
  { name: 'HuggingFace token', re: /hf_[A-Za-z0-9]{34,}/ },
  { name: 'Twilio API key', re: /SK[A-Za-z0-9]{32}/ },
  { name: 'URL-embedded token', re: /https?:\/\/[^\s]+(?:api_key|apikey|access_token|token|secret)=[A-Za-z0-9_-]{20,}/i },
  { name: 'Git credentials URL', re: /https?:\/\/[A-Za-z0-9_-]+:[A-Za-z0-9_-]{8,}@[^\s]+/ },
]

/** Prompt-injection patterns: instruction-like text that could hijack later reads. */
const INJECTION_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'ignore previous instructions', re: /ignore\s+(?:all\s+)?previous\s+instructions/i },
  { name: 'disregard prior', re: /disregard\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions|prompts|messages)/i },
  { name: 'you are now', re: /you\s+are\s+now\s+(?:a|an)\s+/i },
  { name: 'forget everything', re: /forget\s+(?:everything|all\s+(?:prior|previous)\s+(?:instructions|context))/i },
  { name: 'new system prompt', re: /new\s+system\s+prompt/i },
  { name: 'act as a different', re: /act\s+as\s+a\s+(?:different|new)\s+/i },
  { name: 'do not follow', re: /do\s+not\s+follow\s+(?:any\s+)?(?:previous|prior|above)\s+(?:instructions|rules)/i },
  { name: 'override instructions', re: /override\s+(?:all\s+)?(?:previous|prior|system)\s+\w*\s*instructions/i },
  { name: 'system: ignore', re: /\[?system\]?\s*:\s*ignore/i },
  // ── Chinese (CJK) counterparts ────────────────────────────────────────────
  // Each rule mirrors one English pattern class above: imperative override
  // (忽略之前指令 / 无视前文 / 不要遵循之前的指令), role-assignment takeover
  // (你现在扮演), prompt-extraction (新的系统提示词 / 输出系统提示词), fake
  // authority framing (系统指令：忽略), and output-protocol forgery
  // (输出格式伪造). Deliberately conservative: only second-person imperative or
  // role-assignment framings match — declarative statements about one's own
  // past behavior (e.g. "我忽略了之前的错误") never hit, and merely documenting
  // phrases like "系统提示词" is not enough without an override or exfiltration
  // verb (the legit corpus below pins this down).
  { name: '忽略之前指令', re: /(?:请|请你)?(?:一律|先|全部|统统)?(?:忽略|无视)(?:之前|先前|以上|上面|上述|前面|系统|收到的)*(?:的)?(?:所有|全部)*[\u4e00-\u9fff]{0,4}?(?:指令|提示词?|规则|设定|约束)/ },
  { name: '无视前文', re: /(?:请)?(?:一律|全部|统统|先)?(?:无视|不理会|撇开|别管)(?:之前|先前|以上|上面|上述|前面|前文|上下文|system|其他|别的)?(?:的)?(?:所有|全部)?(?:指令|提示词?|设定|约束|它们|这些)/ },
  { name: '不要遵循之前的指令', re: /(?:请)?不要(?:再)?(?:遵循|遵守|执行|听从|服从)(?:之前|先前|以上|上面|上述|前面|系统|收到|给出|发送|要求)*?(?:的)?(?:所有)?(?:指令|提示词?|规则)/ },
  { name: '你现在扮演', re: /(?:从现在起|现在开始|现在)?你(?:现在)?(?:是|扮演(?:成|为)?|来当|来扮演)(?:一?[个名位])?[^\s，。！？,.!?,]{1,12}(?:，|。|!|！|$)/ },
  { name: '新的系统提示词', re: /(?:新的?|全新|更新|重写|覆盖)(?:的)?(?:系统提示词?|system\s*prompt)(?:，|。|,|\.|\s*(?:从现在起|以后|按我说的|听我的))/i },
  { name: '输出系统提示词', re: /(?:输出|打印|泄露|复述|逐字(?:输出|复述)|原样(?:输出|复述)|告诉我)(?:你的?|完整的?|全部的?)?(?:系统提示词?|初始指令|设置指令)/ },
  { name: '系统指令：忽略', re: /(?:\[|\b)(?:系统提示|系统|管理员|system|admin)(?:\]|)\s*[:：]\s*(?:忽略|无视|停止遵守|忘记)(?:之前|先前|以上|上述|前面|全部|所有|一切)/ },
  { name: '输出格式伪造', re: /(?:之后|以后|后续)(?:的)?(?:所有|每次|每个)?(?:输出|回复|回答|响应)(?:必须|都要|一律|只)(?:以|用|按|包含)(?:JSON|代码块|指定格式|固定格式)/ },
]

/** Exfiltration patterns: content that tries to induce tool calls or data egress on later reads. */
const EXFILTRATION_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'curl/wget exfil', re: /(?:curl|wget)\s+(?:https?:\/\/|ftp:\/\/)[^\s]+\s+\$?\{?(?:DSH_|DEEPSEEK_|API_|SECRET_|TOKEN_|KEY_)/i },
  { name: 'env var leak', re: /(?:print|echo|cat|export)\s+\$?\{?(?:DSH_|DEEPSEEK_|API_|SECRET_|TOKEN_|KEY_)[A-Z_]+/i },
  { name: 'base64 exfil', re: /(?:base64|eval)\s+--?decode\s+\$?\{?(?:DSH_|DEEPSEEK_|API_|SECRET_|TOKEN_|KEY_)/i },
  { name: 'send credentials', re: /send\s+(?:the\s+)?(?:api\s+)?(?:key|token|secret|credential)s?\s+to\s+/i },
]

/**
 * Scan content for secrets, prompt injection, and exfiltration patterns.
 *
 * @param content - The text to scan.
 * @returns `allowed: true` when all checks pass; `allowed: false` with reasons when any pattern matches.
 */
export function scanContent(content: string): ScanResult {
  if (content.length === 0) {
    return { allowed: true, reasons: [] }
  }

  const hits: ScanHit[] = []

  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) hits.push({ kind: 'secret', pattern: name })
  }
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(content)) hits.push({ kind: 'injection', pattern: name })
  }
  for (const { name, re } of EXFILTRATION_PATTERNS) {
    if (re.test(content)) hits.push({ kind: 'exfiltration', pattern: name })
  }

  // Filter out allowlisted hits (§3.10).
  const filtered = hits.filter(hit => !isAllowlisted(content, hit))

  if (filtered.length === 0) {
    return { allowed: true, reasons: [] }
  }

  const reasons = filtered.map(hit => `${hit.kind}: ${hit.pattern}`)
  return { allowed: false, reasons }
}

/** The marker prefix stamped on blocked content in prompt-facing views. */
export const BLOCKED_MARKER = '[BLOCKED'

/**
 * Render one stored content string for a PROMPT-FACING surface (the injection
 * snapshot, the existence index, the notes export, the extraction snapshot).
 *
 * This is the load-time counterpart of the write-time {@link scanContent}
 * gate: content that fails the scanner is replaced by a `[BLOCKED: …]`
 * placeholder wherever it would re-enter an LLM context. The original stays
 * in the store untouched so the user can still inspect and remove it —
 * silent deletion would only hide the attack.
 * @param content - the stored content to render.
 * @returns the original content when clean, otherwise the placeholder.
 */
export function redactBlocked(content: string): string {
  const scan = scanContent(content)
  if (scan.allowed) return content
  return `${BLOCKED_MARKER}: ${scan.reasons.join('; ')}]`
}
