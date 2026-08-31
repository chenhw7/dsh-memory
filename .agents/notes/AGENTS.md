# AGENTS.md — Agent Notes

Agent Notes are effectively RFCs written by agents: durable proposals and decision records that preserve rationale, alternatives, consequences, and required verification. Follow the upstream [documentation standard](../../../deepseek-harness/docs/AGENTS.md) and the [Agent Note rules](README.md).

**Every new Agent Note triggers a supersession check.** Search the active tree for older notes covering the same decision or mechanism, classify any full or partial supersession with the harness's [`dsh-archive-agent-notes`](../../../deepseek-harness/.agents/skills/dsh-archive-agent-notes/SKILL.md) workflow, and archive every qualifying implemented triplet in the same commit. Keep partial supersessions active and cross-linked.

Files under [`archived/`](archived/AGENTS.md) are frozen historical snapshots: never edit them or treat them as current authority.

## Repository adaptation

This tree replicates the [DeepSeek Harness Agent Notes](../../../deepseek-harness/.agents/notes/README.md) convention. The harness-side gates — the classification gate (`scripts/agent-note-tree.ts`), `verify-agent-note-format`, translation pairing, and `verify-archived-agent-notes` — do not run in this repository: their canonical definitions live in the harness repository, are referenced read-only, and their discipline is applied by hand here.
