# AGENTS.md — Archived Agent Notes

Archived Agent Note triplets under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate a complete English/Chinese/sidecar triplet, insert the identical `Archived: YYYY-MM-DD` line below both `Status: implemented` lines, re-record the sidecar, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

The [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow owns the archival steps. Upstream, `pnpm run verify-archived-agent-notes --write` appends artifact hashes to a frozen-content manifest that its verifier then enforces; this repository runs no verifier and keeps no manifest file, so the same steps — relocate the triplet, add the archive-date line, re-record the sidecar, repair inbound links — are applied by hand.
