# AGENTS.md — Implemented Agent Notes

These Agent Notes describe shipped decisions. Follow the [Agent Note format](../README.md#the-file-format) and the upstream [documentation standard](../../../deepseek-harness/docs/AGENTS.md); `verify-agent-note-format` gates the lifecycle-specific structure in the harness repository — here the structure is convention.

## Keep an implemented Agent Note current with what actually shipped

Keep paths, symbols, defaults, and mechanisms current in the same change that alters them. Rewrite stale facts in place; do not append change history.

When a shipped note is unlikely to guide future work, archive its complete triplet through the harness's [`dsh-archive-agent-notes`](../../../deepseek-harness/.agents/skills/dsh-archive-agent-notes/SKILL.md) workflow (applied by hand here) instead of continuing to maintain it.

### This is not a license to rewrite the *decision*

Update factual realization in place. A reversal of the decision or its rationale requires a new Agent Note and cross-link; a fully superseded old note may be deleted only through the consolidation rule in the [Agent Note rules](../README.md).
