# APPLY RECEIPT — UI agent binding r1 (SPEC-2026-11-25-kaneo-ui-agent-binding)

- Applied: 2026-11-26T04:32 UTC on ProDesk via R10 guarded lane (`run-all.sh --apply --yes`, visible sudo ceremony).
- Candidate image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d9975628-ui-agent-binding-r1@sha256:be955119313ba9e7a86c3890bec964061254051c1e316af8448a97978f370ddf` (revision label = full source SHA d997562815fc1940a0682c4f3555765bafa75ef3, verified by pull-inspect before apply).
- Rollback pin: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-59d0905b-child-activity-context-r1@sha256:089e604ea365212a6525043ea3e59c5284a2c94698110bf3a7a404e74eca3258` + Compose `d06808c5…`.
- Compose: `d06808c5…` -> `0a699c3b…` (only the kaneo image pin moved).
- Migration: 0057_agent_session_presence applied; verifier upgraded to head id=60 hash `e03ce7c2…`, columns 70/70, indexes 6/6, constraints 7/7 — PASS (read-only) pre- and post-apply.
- Encrypted snapshots: pre `kaneo-20261126T043217Z`, post `kaneo-20261126T043245Z`; both receipt identity/freshness PASS (local outbox only; R2 mirror remains a separate owner gate).
- Health: container healthy post-recreate; `https://kaneo.quoc.app/api/health` -> `{"status":"ok"}`.
- PLAN attempts: 2 BLOCKED (metadata pin stale in bundle, then short-SHA image label) — both fixed by pin corrections/full-SHA rebuild before any mutation; no production state touched by failed attempts.
- Live smoke PASS: roster 200; API-key bind -> gen 1 -> session adopt `online:true`; card delete -> documented `409 stale_binding`; extension tombstone self-clear; pre-existing binding #169 (li.quoc.app) untouched.
- Extension sync: laptop + ProDesk runtimes on 3be74819 (+README 766feac7) with `.pre-uat-*` backups; announce suite 14/14 on ProDesk.
- Backlog candidate (non-blocking): deleted task does not auto-revoke its active binding row server-side; orphan rows rely on the extension tombstone and roster join. Logged for a later hygiene pass.
- Steps 1-8 all PASS in `deploy-run.log` (root-owned, on ProDesk staging bundle).

Status: PASS — UI agent binding r1 is live on production.
