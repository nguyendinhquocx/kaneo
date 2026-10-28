# Kaneo Wave uatfix5 Deployment Receipt — 2026-10-28

## Result: APPLIED & VERIFIED (complete)

Owner-approved production UAT wave for SPEC-2026-10-27-kaneo-subtask-board-focus-markers (subtask board focus markers + work markers) deployed to ProDesk. The owner also approved changing the backup freshness contract from 24h to 30 days; the new gate ships inside this wave bundle (`backup-verify.uatfix5.sh`), and the deprecated generic ServerOps contract (`alpha-host.toml`) was left untouched.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d` |
| Source commit | `c491af9763e91a8b246de092e44cbe32e9737428` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Image build | Local laptop `docker buildx build --platform linux/amd64 -f Dockerfile.kaneo --push` (fork GH Actions dispatch remains disabled); manifest digest verified via `buildx imagetools inspect` |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-b0eb792f-uatfix4@sha256:2d421f5c08accfd93fee04e1e2ea100dcccc51855348d3a15dbea0570864631e` |
| Compose SHA256 | `24aebba06211970e6d4c4115c0c5ffc301672d879cae05215cc07af0e2424a8b` (image pin only; topology unchanged) |
| Backup wrapper | `8151bfa1d950f8b33d71741358791f6ef2c7a793045b5762536a19d3bf1cde9c` (uatfix5 pair: previous=uatfix4, candidate=uatfix5) |
| Install metadata | `source_revision=c491af9763e91a8b246de092e44cbe32e9737428`, wrapper `8151bfa1…` (sync-recovery-metadata rebind PASS) |
| Fresh backup | `kaneo-20261028T112927Z` — ciphertext `fe46e55222d2e775b3917c4ce211a08440d498395d19141faedcbc8a7af2cfe4`, receipt `03b547b307f400b3fe51d8fd2a951de41302c4998d517fa05ac76c1c922374c0`, strict-verified against the uatfix5 source identity and R2-mirrored |

## Shipped features (SPEC-2026-10-27)

- Migration `0050_cultured_sleeper`: `task.work_marker_counts` (jsonb, 4 fixed keys, 0–99) + `project.show_subtask_cards_by_default` (legacy rows backfilled `true`, new rows default `false`).
- Server-side projection: `workMarkerCounts`, `isSubtask`, `nextSubtaskPreview`, `showSubtaskCardsByDefault` on task DTOs (batched, no N+1); strict `PUT /api/task/work-markers/:id`; guest/share DTOs expose no marker writes.
- Web: per-`userId:projectId` display preferences (local-only), "Hiển thị" menu (child cards + next-subtask preview toggles), marker cluster by the task title, marker editor in task properties (authenticated only), subtask arrows removed (44px touch grip kept), keyboard-only DnD with announcements, 13 translated locales.
- New owner-approved guard: `kaneo-backup-verify` now fails closed when the latest encrypted receipt is older than 30 days (or in the future).

## Gates at commit c491af97 (pre-deploy)

API integration 50/50 relevant files (task-subtask-order, full-share, openapi) · web 94 tests + typecheck + build · API build · disposable-DB upgrade check `db:check-0050` (real 0000→0049→0050 path with legacy backfill assertions) · `i18n:check` (13 locales) · Impeccable detector `[]` · `git diff --check` clean. Five review rounds (UI, API, follow-up, delta) all PASS.

## Deployment evidence

- Bundle `.wave-uatfix5/` committed `5f690b83` (fix `62d23d62`), uploaded to `prodesk-home:/home/quoc/kaneo-wave-uatfix5/`, hash-verified byte-for-byte (12/12) before any mutation.
- Pre-apply survey re-verified inside the apply script: compose `31489958…`, running image uatfix4, metadata `b0eb792f…`, all five adapters at uatfix4 pins.
- Guarded deploy PASS: backup wrapper pre-flight (uatfix4 pair), atomic compose flip, digest-pinned pull, rolling restart, health wait, migration verify, post-flip wrapper guard. Container healthy on `809d858b…`.
- First apply run exited 2 after the flip: the generator had double-wrapped the migration-verify `VALUES` rows so the required-columns probe failed closed (`sql_identifier = record`). No incorrect mutation occurred; the deployed state was verified healthy, and the adapter was repaired (`62d23d62`) and re-staged.
- `kaneo-wave-continue5.sh` PASS (7/7): flipped-state verification, adapter staging, metadata rebind PASS, host status healthy, migration/schema PASS (`head=0050 id=53 hash=ec7ca98b… migrations=53 required_columns=25/25 github_constraints=2/2 backfill_gaps=0 project_default_gaps=0 marker_counts_valid=0`), backup-verify PASS with the 30-day freshness gate, fresh snapshot `kaneo-20261028T112927Z` strict-verified, R2 mirror PASS.
- Public UAT access verified from outside: `https://kaneo.quoc.app/` → 200, `/api/health` → `{"status":"ok"}`, `caddy-kaneo.service` active.

## Follow-up

Owner production UAT is the remaining acceptance gate for SPEC-2026-10-27: hidden subtask cards on new projects, next-subtask preview updates after reorders (keyboard + pointer), marker cluster rendering/overflow, marker editor round-trip, guest share surface showing zero markers. Rollback if needed: flip compose to the uatfix4 pin and `docker compose up -d kaneo` (migration 0050 is additive and backward-compatible).
