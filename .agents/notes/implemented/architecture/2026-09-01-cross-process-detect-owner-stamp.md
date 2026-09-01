# Agent Note: Cross-process single-writer violations are detected, not locked

Status: implemented

English | [中文](2026-09-01-cross-process-detect-owner-stamp.zh.md)

## Problem

The host storage-json backend is last-writer-wins across processes and its double-open guard is a per-process map: two DSH processes sharing one `$DSH_HOME` each hold their own authoritative in-memory state and republish the whole unit file on every write, silently clobbering each other. Nothing in the host detects the overlap, and the plugin cannot add locks (the host unit contract has no CAS primitive and the file is shared state). The improvement program ruled: detect and alert at the plugin layer, don't lock.

## Decision

The store plugin claims the memory domain's **global slot** with a boot owner stamp (`pid`, `startedAt`, `bootId`) at open and re-reads it from the **medium file** on a lightweight interval (`crossProcessProbeMs`, default 60 s, `0` disables; one `readFile` per tick — the write path gains no IO). The judgment:

- valid foreign stamp + no `closedAt` + **pid still alive** → a live concurrent publisher; reported once per boot through `reportFailure('cross-process')` onto the structured-logging channel (logger warn + `backgroundFailures`).
- `closedAt` set → the predecessor exited cleanly; dead pid → it crashed. Both are restart cases and stay silent — the same rule also forgives this boot's own crashed predecessor, so a same-machine restart produces no false alert.
- Once per boot; a restart resets the flag. Detection never locks, never blocks a write, and the probe is off by default in unit tests (`dshHomePath` absent → both medium seams are `undefined` and only the in-memory startup judgment runs).

A clean dispose stamps `closedAt` **directly on the medium file** through a dedicated writer derived from the same `dshHomePath('storages','memory.json')` expression the base bundle uses for the storage row's root. The goodbye deliberately avoids the domain's global write: the storage facility's unmount closes the domain concurrently with our disposer (sibling fibers, no ordering guarantee), so the domain write rejects with `closed` on most dispose runs — the medium file is the only teardown-valid seam. The boot identity is minted once per mount and shared by the claim and the goodbye; a second `currentBootOwner()` would mint a fresh id the writer would (correctly) refuse to stamp.

The global slot rides a **zero version bump** on the domain spec: old media reopen without migration (a missing global is the spec's "never written" path, and the empty-medium materialization timing moves earlier — the claim makes `memory.json` exist at mount, reflected in one host-integration assertion).

## Alternatives considered

- **A file lock (flock/lockfile).** Rejected by the program's ruling: the host layer owns medium semantics; a plugin-side lock invites stale-lock deadlocks after crashes and still cannot bind the host's own writers.
- **Alerting on any foreign stamp.** Rejected: it would fire on every restart of our own process (a new boot reading our crashed predecessor's stamp) — the pid-liveness check is what separates "another writer" from "my past".
- **Probe through the domain's global read.** Useless: domain reads come from in-memory state, which never observes another process's publish; the medium file is the only cross-process witness.

## Consequences

- Two live concurrent writers surface as one warning per boot with the foreign pid in the message; the second writer still wins the file (detection, not prevention) — the recorded escalation path is the operator separating `$DSH_HOME`s or migrating the medium.
- A crashed predecessor whose pid the OS later reuses can produce one false alert; once-per-boot bounds it to a single line.
- The claim materializes `memory.json` at mount time (previously lazy to the first write); tooling asserting on file existence sees the file earlier.
- The goodbye's whole-file rewrite mirrors the backend's content but not its atomic protocol: a crash mid-goodbye tears the stamp at worst, and the pid-dead rule already forgives that.
