# AGENTS.md — Implemented Agent Notes

These Agent Notes describe shipped decisions. Follow the [Agent Note format](../README.md#the-file-format) and the [documentation standard](../../../docs/AGENTS.md) and the format rules; the upstream `verify-agent-note-format` gate does not run here — the structure is convention ([the format note](../../../../deepseek-harness/.agents/notes/implemented/process/2026-07-05-uniform-agent-note-format.md) owns the rationale, read-only).

## Keep an implemented Agent Note current with what actually shipped

Keep paths, symbols, defaults, and mechanisms current in the same change that alters them. Rewrite stale facts in place; do not append change history.

When a shipped note is unlikely to guide future work, archive its complete triplet through the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow instead of continuing to maintain it.

### This is not a license to rewrite the *decision*

Update factual realization in place. A reversal of the decision or its rationale requires a new Agent Note and cross-link; a fully superseded old note may be deleted only through the consolidation rule in the [Agent Note rules](../README.md).
