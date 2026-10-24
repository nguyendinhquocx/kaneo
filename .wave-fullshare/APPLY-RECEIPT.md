# Kaneo Wave fullshare Deployment Receipt — 2026-10-24

## Result: APPLIED & VERIFIED

Candidate `09a9fe89` (full-project share link feature + final security/UI review fixes) deployed to production on ProDesk through the source-owned direct guarded rollout. All gates PASS.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e` |
| Source commit | `09a9fe89298f0a1faad3389b5a733b046b49319e` (branch `kaneo/prodesk-production`, pushed to `github-main`) |
| Image build | Local laptop `docker buildx build --platform linux/amd64 -f Dockerfile.kaneo` (GH Actions workflow dispatch was disabled on the fork and the API enable call returned 422; digest pinned after push) |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-a8cb40f3-share-originfix@sha256:70b01bab43c1db1e8fbf6c8d09ded0e8bc44e9751b53a835826a5d6bea53849a` |
| New compose sha256 | `12a5857a1504e4daa43ae0b1d9ee641834052fa1d7f4b0231399e88f467f7195` |
| Previous compose sha256 | `79cd209d157af98f86f89515eb30788f9844859e2e21063ab67cafd28d8425d4` |
| Fresh backup | `kaneo-20261024T155420Z` — ciphertext `b35934972d4e4ac3c5f6768882d1516ccecf699f20d060f11adb1e3a02cb1b74`, receipt `1e91070a444f470bcac452f471ff4d12146130f727f6667a31a0cde4e3234623`, strict-verified, R2 mirrored |

## Execution sequence (root mutations via sudo, visible runner, user-entered password)

1. **Pre-deploy survey (read-only)**: production compose/wrapper/sync/migration-verify/backup-verify/snapshot-adapter/metadata pulled byte-exact; production was on wave `a8cb40f3-share-originfix` (two waves ahead of the stale r4fix2 receipt in the old worktree), receipt `kaneo-20261022T042214Z` fresh and PASS.
2. **Wave bundle prepared**: compose.next (single image-line change), wrapper/sync/migration-verify/backup-verify repinned (no DB migration this wave — Drizzle head stays `0049_wise_loners` id 52), deploy script + 9-step fail-closed apply script, all hashes pinned.
3. **Independent review**: subagent `fullshare-wave-review` APPROVED — recomputed every hash, simulated the deploy-step sed, verified pair interlocks, secrets scan clean.
4. **Apply run 1**: steps 1–5 PASS (state re-verify, bundle integrity, 4 adapters staged, guarded deploy with backup guard + compose flip + digest pull + health + image-id match, metadata rebind). Exited 2 in step 6 without output capture; post-flip state verified intact out-of-band.
5. **Continuation 1**: re-verified post-flip state (compose/image/health/adapters/metadata), migration/schema PASS, pre-snapshot backup-verify PASS (receipt `kaneo-20261022T042214Z` accepted), status healthy. BLOCKED at snapshot: the no-args snapshot adapter wrapper-allowlist did not contain the fullshare wrapper hash — fail-closed as designed.
6. **Continuation 2**: staged snapshot-adapter allowlist entry (`FULLSHARE_CANDIDATE_*`, host file + 4 lines, `865efebc…`), fresh snapshot `kaneo-20261024T155420Z` created + strict-verified by the adapter, R2 mirror PASS, final receipt PASS.

## Post-deploy verification evidence

- Container: `kaneo` Up (healthy), running image id matches pinned digest (`3108cd3f6b48…`).
- Caddy: `caddy-kaneo.service` active.
- Migration/schema: PASS — head `0049_wise_loners`, id 52, migrations 52, hash `97f40d59…`, required columns 23/23, github constraints 2/2, backfill gaps 0 (unchanged: no migration this wave).
- Backup chain: wrapper/sync/migration-verify/backup-verify/snapshot-adapter all on fullshare pins; install metadata `source_revision=09a9fe89298f…`, `snapshot_sha256=bd4f3e4f…`.
- Fresh backup: `kaneo-20261024T155420Z`, strict-verified (pre-decrypt, plaintext_egress=false), R2 mirror PASS (bucket `kaneo-backups-prod`).
- Public smoke: `https://kaneo.quoc.app/api/health` → 200 `{"status":"ok"}`; invalid share token API → 404 (fail-closed generic); share page route → 200.

## Feature shipped

Full-project share link (SPEC-2026-10-22): guest board/task surface via capability transport, owner/admin-only full-link management with one-time URL, TOCTOU in-transaction rechecks on every guest write (task/comment/label/relation/upload), upload MIME signature + quota under lock, double-finalize cleanup race fix, 10s visible-only guest activity polling, 12-locale invalid/rate-limited strings. Tests at ship: API unit 264/264, API integration 207/207, web 72/72.

## Open items

- Owner UAT on production for the full-share feature (guest board/task flows, link create/revoke/recovery) — feature accept gate, not a deploy gate.
- Spec archive after UAT gates.
- Standing debts: Docker Scout re-scan (this image built locally, not via Actions), off-host `SHARE_TOKEN_ENCRYPTION_KEY` backup, credential rotation, receipt-index host head alignment via `kaneo-stage-verified-pair` on next restore prep.
