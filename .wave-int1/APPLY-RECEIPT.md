# Kaneo Wave int1 Deployment Receipt — 2026-11-05

## Result: APPLIED & VERIFIED — deploy gates PASS; owner UAT pending

SPEC-2026-10-31 calendar/mindmap embedded integrations (commit `d7c14249`, migration `0052_secret_maelstrom`) deployed to ProDesk production through the guarded wave lane. Owner must still run T7 UAT (settings toggles, per-project mind-map binding, embedded calendar/mind-map views and their empty/unavailable states) before the spec is DONE.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d7c14249-calendar-mindmap-int1@sha256:0e7191d50eb763b94ec6af86d2ec36a45526d2e8aea73b09cb63b1c600c81fbc` |
| Source commit | `d7c142498abadc303e802c4e61338b0b42ed71e3` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf` |
| Compose SHA256 | `70459206ff5117c81ddc74c01f0a73cfed75fad10b357af3ff2b1da01c8a3c25` |
| Backup wrapper SHA256 | `8ce2b6b3d21dd59aa3325a59cc9eab038ed12d5e31d7cf13eb26d2e08cb1b2aa` (previous=uatfix7 `ea1640d6…`, candidate=int1) |
| Install metadata | `source_revision=d7c142498abadc303e802c4e61338b0b42ed71e3`, wrapper `8ce2b6b3…` |
| Pre-migration encrypted backup | `kaneo-20261105T114430Z` — ciphertext `4d9e2e4be5830359b7be4f32b4aca3b14728c0e7d835de0ea1d0bc5e0a364151`, receipt `203934e7219ee2f5ee5cce77444d0e2e6f4dabde204ab253e427a9e3799b5b21` (uatfix7 identity), mirrored to private R2 |
| Post-deploy encrypted backup | `kaneo-20261105T114508Z` — ciphertext `96f1fc3525c8ae61e9d82363db6c5c13c123d4075e0e1a03f342d4547d0f9c81`, receipt `68b7b3d396a3022c9e3ff252ca1a499ff6362b800181d02ba4fc450ca476963a` (int1 identity), mirrored to private R2 |

## Pre-deploy gates

- Bundle tests on laptop: Web 44 files / 136 tests PASS; Web typecheck PASS; API 42 files / 264 tests PASS; `pnpm i18n:check` 13 locales PASS.
- New real upgrade-path check `db:check-0052` (commit `d7c14249`) PASS on a disposable Postgres 16: additive table only, PK uniqueness, cascade FK enforcement, defaults `mitra_enabled=true`/`wisemapping_enabled=true`, no backfill rows.
- Image built locally on the laptop (linux/amd64, Docker 27.4.0) from clean-tracked `d7c14249`; digest pinned after push. Docker Scout not re-scanned this wave (build host has no Docker Hub login); provenance in `.wave-int1/CANDIDATE-PROVENANCE.json` (delta manifest vs deployed `d56f1bba`).
- Read-only production survey (fixed laptop lane): status healthy on uatfix7, runtime preflight PASS, migration head `0051_fuzzy_harry_osborn` id=54 hash `73246bf8…`, backup `kaneo-20261028T180412Z` within the 30-day freshness gate.
- Bundle staged at `prodesk-home:/home/quoc/kaneo-wave-int1/`; local/remote sha256 verified 11/11.

## Incident found and repaired during apply (iss_20261105114047_8dbb816ec5)

- First apply attempt failed closed at the survey step: `/srv/kaneo/recovery/backup-kaneo.sh` had been overwritten on **2026-11-04 15:41 UTC** with an old uat-r4→uat-r4fix generation copy (`0453a148…`), meaning no snapshot could succeed since then and no backup newer than `2026-10-28T180412Z` existed.
- Root cause not fully attributed (not in any on-host wave bundle, not in the EP's `home-server-ops-bundle-e549e17.tar.gz`, no plain-text trace in `~/.bash_history`); the EP session active on the host on 2026-11-04 is the presumed origin. Tracked as `iss_20261105114047_8dbb816ec5` (candidate).
- Repair: hash-pinned restore script installed the reviewed uatfix7 wrapper (`ea1640d6…`) over the drifted copy, verified by `--plan`, then the wave continued. The wave survey guard did exactly its job — no other production component had drifted (compose, image, metadata, and the four recovery adapters were all still at uatfix7 pins).

## Deploy execution (kaneo-wave-int1-continue.sh, all steps PASS)

1. Verified exact post-failed-apply host state (compose/wrapper/adapters/metadata/image pins).
2. Restored the uatfix7 wrapper recorded in install metadata (hash-pinned).
3. Fresh encrypted pre-migration snapshot `kaneo-20261105T114430Z` (uatfix7 identity).
4. R2 mirror of the pre-migration pair PASS.
5. Restaged the int1 backup wrapper (`8ce2b6b3…`).
6. Guarded deploy: pre-flip backup guard PASS, compose flip `5b1a7491→70459206` validated, digest-pinned pull, container recreate, health wait PASS, image-id match verified.
7. Migration verifier PASS: `head=0052_secret_maelstrom id=55 migrations=55 hash=f8f8a5bd7a6f547285b27f57b960dde03576dc936293303d931a823002277f9d required_columns=32/32 github_constraints=2/2 integration_fk=1 backfill_gaps=0 project_default_gaps=0 marker_counts_valid=0` — matches the offline-derived expectation recorded in the bundle README (drizzle head hash = sha256 of the committed migration SQL, verified retroactively against 0051).
8. Post-flip backup guard PASS against the int1 pair.
9. Metadata rebind PASS: `source_revision=d7c14249…`, wrapper `8ce2b6b3…`.
10. Post-deploy read-only checks: kaneo healthy on the int1 image, postgres healthy, caddy-kaneo active; `backup-verify` PASS with 30-day freshness enforced.
11. Post-deploy encrypted snapshot `kaneo-20261105T114508Z` (int1 identity) + R2 mirror PASS.

## External checks (post-deploy)

- `https://kaneo.quoc.app/` → 200; `/api/health` → `{"status":"ok","executionMetrics":{}}`; `/auth/sign-in` → 200.

## Rollback path

Rollback = redeploy the uatfix7 rollback pin via the same wave lane (compose flip back to `5b1a7491…`, image `08a7f013…`). Migration 0052 is additive-only (`CREATE TABLE workspace_integration_settings` + FK); the uatfix7 image ships migrations only up to 0051, so its migrator treats 0052 as unknown and performs no writes; the extra table is inert for the old code. For data rollback, the pre-migration pair `kaneo-20261105T114430Z` is in the private R2 bucket.

## Scope note

This wave only changes Kaneo. Mitra and WiseMapping production provisioning remains blocked by the separate service-admission gates (owner recipient approval, H7 install, private DNS/TLS, owner-only Tailscale ACL); until then the new calendar/mind-map surfaces show their empty/unavailable states, which is part of the owner UAT checklist.
