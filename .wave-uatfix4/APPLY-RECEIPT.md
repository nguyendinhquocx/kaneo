# Kaneo Wave uatfix4 Deployment Receipt — 2026-10-25

## Result: APPLIED & VERIFIED (complete)

Owner-approved production UAT follow-up commit `b0eb792f` deployed to ProDesk after the independent security reviewer flagged the unshared lane-lock protocol and the UI reviewer's mobile/accessibility findings.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e` |
| Source commit | `b0eb792f72f3055e0429a8fa382e686783e9af61` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Image build | Local laptop `docker buildx build --platform linux/amd64 -f Dockerfile.kaneo`; fork workflow dispatch remained disabled |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88` |
| Compose SHA256 | `314899585bce6cb69f3a09275b41c1f055e40989589edf8d470b5d286f3c6a33` (image pin only; no service/topology change) |
| Backup wrapper | `87bf9ab191ea063dba4c3f7db3ab54ee3ddee2bc017fe1078bed9159e6f9ae0c` (uatfix4 pair: previous=uatfix3, candidate=uatfix4) |
| Install metadata | `source_revision=b0eb792f72f3055e0429a8fa382e686783e9af61`, wrapper `87bf9ab1…` (sync-recovery-metadata rebind PASS) |
| Fresh backup | `kaneo-20261025T121146Z` — ciphertext `e96c75548b10d66d8ee7669129aba47c2305b8105e588117ae1d4d8e6f748471`, receipt `52018d6c329f13f0a38e2336cfad192be4fedd0bf2b778243babae593c1a895a`, strict-verified against the uatfix4 source identity and R2-mirrored |

## Shipped fixes

Security (lock-protocol reviewer, all three P2 resolved):

- Shared project lane-lock protocol: new `apps/api/src/task/lock-project-task-lanes.ts` locks project rows in sorted ID order before task rows; applied to guest move/update/delete, owner status/update/bulk/delete/create/import, and GitHub/Gitea import + webhook writers. Cross-project subtask reorder locks every touched project.
- Imported and webhook-created tasks now append into their lane (`columnId` + integer `position` = max+1) under the same project lock instead of landing at position 0.
- Full PUT no longer accepts `position` (strictObject + safeParse → 400); lane order is owned exclusively by the POST move endpoint. Client `useUpdateTask`/`updateShareFullTask` no longer send position.
- Barrier regressions: guest reindex serializes against owner lane-status update; cross-project subtask reorder serializes with a guest move in the child's project.

UI (ship-UI reviewer, both P2 resolved, P3 artifact regenerated):

- 44px mobile touch targets across board toolbar/filter/sort/view controls; icon-only labels below `sm` with accessible names.
- Clear-filter chips gained translated accessible names (`tasks:boardFilters.clearFilter`, 13 locales + regenerated `i18n/schema.json`).
- Public task dialog: `DialogTitle`, reserved `pe-14` close gutter and truncating metadata so the absolute close button cannot overlap at 320px.

## Gates at commit b0eb792f

API unit 264/264 · API integration 211/211 (22 files) · web 74/74 (29 files) · API + web typecheck PASS · API + web build PASS · `i18n:check` PASS (13 locales) · Impeccable detector `[]` · `git diff --check` clean.

## Deployment evidence

- Bundle `.wave-uatfix4/` (deploy script, apply script, continue script, repinned wrapper + sync/migration/snapshot/backup-verify adapters) uploaded to `prodesk-home:/home/quoc/kaneo-wave-uatfix4/`, hash-verified byte-for-byte before any mutation.
- Survey before apply: compose `c57926be…`, running image uatfix3 digest, metadata `708d1712`, all adapters at uatfix3 pins — every pin re-verified inside the apply script before mutation.
- Guarded deploy PASS: backup pre-flight guard, atomic compose flip (old pin → new pin), digest-pinned pull, rolling restart, health wait, migration verify, post-flip wrapper guard. Container healthy on `2d421f5c…`.
- `kaneo-sync-recovery-metadata` rebind PASS (metadata now pins b0eb792f + uatfix4 pair).
- Fresh encrypted snapshot created and strict-verified by the repinned snapshot adapter; R2 mirror step returned PASS in the same sudo run (exit 0).
- `kaneo-backup-verify` repinned (`3db9cd06…` via `stage-verify.sh`) and now PASSes against the uatfix4 receipt `kaneo-20261025T121146Z` — independently re-verified from the laptop over BatchMode SSH.`

## Follow-up

Owner production UAT for uatfix4 (guest drag atomic move, mobile layout, dialog close, copy feedback, documents polling) is the remaining acceptance gate for SPEC-2026-10-22. QA project `uat-mobile-visual` (bou8vvhk03rjlku3gltc8ukd) was deleted from production and removal verified (GET 404) before this wave.
