# APPLY RECEIPT — UI agent polish r2 (SPEC-2026-11-25 follow-up)

- Applied: 2026-11-26 via R10 guarded lane on ProDesk; owner approved the polish pass before work started.
- Candidate image: `…candidate-03cc5a71-ui-agent-polish-r2@sha256:4e45af76…` (revision label = full SHA 03cc5a714a5761ec47c56aa51a75ebbc21a65e5c).
- Rollback pin: r1 image `be955119…` + Compose `0a699c3b…`.
- Compose: `0a699c3b…` -> `e3197984…` (image pin only).
- Migration: unchanged — 0057 still head; verifier PASS pre/post.
- Snapshots: pre `kaneo-20261126T115855Z`, post `kaneo-20261126T115923Z`, both PASS.
- PLAN blocked 3x on stale current pins copied from the r1 bundle (wrapper SHA, current/candidate source revisions, metadata pin) — every correction came from a fresh production survey; no production mutation on failed attempts.
- Changes live: model names removed (bound row + picker), Agents heading removed, unbound trigger reads "Agents" in the Marker type scale (count kept in aria-label), picker row hover highlights only the content width.

Status: PASS.
