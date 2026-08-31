# Defensive patterns

Hard-won bug-class rules, adapted to this repository's surfaces (storage files, async review pipeline, client settings UI, remote transport): each pattern is a class of defect that actually shipped here or in the host harness, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, or teardown code. Test-tier counterparts live in [testing.md](testing.md).

## Report orthogonal outcomes independently

A result can be several things at once — a store write can time out AND have partially flushed. Surface each independent fact (`timedOut`, `flushed`, `error`) on its own; never nest one flag's report inside another's branch, or a caller reads a cut-short run as a clean success.

## Honor public contracts on BOTH sides

When an implementation receives several representations of one outcome, normalize them before returning through the public API. The review pipeline's judge may throw or return a malformed verdict; the review service exposes model failures only as typed outcomes (`rejected`, `needs-confirm`, `error`), so the accumulator never guesses whether a caught exception came from the adapter, the prompt assembly, or its own batching. Document the normalized contract where the type is defined; exercise every source form through the real consumer.

## Async state is not synchronous state

Extraction runs in the background while the user keeps chatting; a session's end does not mean the review finished. Never treat "turn settled" as "extraction done": queued scans, dedup, and confirm flows may still be in flight, and cancellation or disposal can discard unstarted items. A caller that truly owns a run must define its interval explicitly and treat results as interval-wide, not causally attributed to one message. If the awaited transition can never occur, the wait hangs — handle the "nothing to wait for" branch explicitly.

## Dispose must reach quiescence, not just request it

A teardown that issues aborts but returns before the work stops leaves orphans that write to the store after the next test or session began. Make cleanup async and await the owned completion signal (judge call settled, scanner run finished, store flush resolved), and close listener registries before aborting so late completions stay silent.

## Contain callback exceptions in the dispatcher

A user-supplied or model-driven callback that throws must not reject the pipeline it runs inside or starve the work queued after it. Wrap the dispatch loop in try/catch, record the failure as a typed outcome, and continue; one bad item never breaks the extraction pass.

## Never hand untrusted input the ambient environment or predictable paths

Scanner inputs, extracted content, and project-notes text are untrusted: they pass through the scanner corpus rules (secret patterns, prompt-injection heuristics) before storage, and injected prompt sections never gain tool authority. Spill/temp artifacts (if any) use a private dir with random names and exclusive owner-only opens — predictable world-readable paths invite symlink races and disclosure.

## Unlink link-shaped paths

The `notesDir` containment rule and any path deletion treat a path that may be a symlink or Windows junction with `lstat` first, then `unlink`: unlink deletes only the link and refuses a real directory, so it never follows the link into its target. Reserve recursive deletion for known real directories created by this plugin.

## Settings values cross a durable boundary

A value read from the settings document is external input: validate it against the schema at the point of use, treat an absent key as "follow the session default" rather than a false override, and never let a UI draft's stale shape reach the store — persist only fields the user actually changed (the draft-then-Save pattern), because writing a placeholder value creates a fake override.
