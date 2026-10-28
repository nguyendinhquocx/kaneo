# Kaneo Wave uatfix6 Deployment Receipt — 2026-10-28

## Result: APPLIED & VERIFIED (complete)

Post-UAT revision wave for SPEC-2026-10-27-kaneo-subtask-board-focus-markers deployed to ProDesk production: optimistic drag reorder, inline marker presets (task properties + subtask quick picker), inline title-row marker clusters, and assignee/priority display defaults (migration `0051_fuzzy_harry_osborn`). Owner pre-approved the rollout.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd` |
| Source commit | `dca547b03e876106f709ce7c3cd7d484e2043986` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Image build | Local laptop `docker buildx build --platform linux/amd64 -f Dockerfile.kaneo --push`; manifest digest verified via `buildx imagetools inspect` |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-c491af97-subtask-board-markers-uatfix5@sha256:809d858b1de14e054cf659da715000e7ce006e5f6703e0e4e2f5263bff33a65d` |
| Compose SHA256 | `1e637fa348ddc6d4d53f7d4ff0c0f082ffbd06002218848281ac1c6d88a2e717` (image pin only; topology unchanged) |
| Backup wrapper | `e01c070fdfea2f41e39102ee99528bba99771b2aeb45bbadddb2044f659348da` (uatfix6 pair: previous=uatfix5, candidate=uatfix6) |
| Install metadata | `source_revision=dca547b03e876106f709ce7c3cd7d484e2043986`, wrapper `e01c070f…` (sync-recovery-metadata rebind PASS) |
| Fresh backup | `kaneo-20261028T145158Z` — ciphertext `c1bb27801ab2dafc124d2a42ffea9c34aa028ffbca24669f4d5d03ffcb8fa3c8`, receipt `bb2f2e39c872a6a44b8697c54cec3ddd38ee044883cbade0c129ad146eae488d`, strict-verified and R2-mirrored |

## Shipped changes (post-UAT revision @ dca547b0)

- Optimistic reorder: Board/List drag renders the moved task immediately via optimistic TanStack Query projection (`use-reorder-project-tasks`); only changed positions persist; one reconcile; rollback on failure. Share keeps its existing flow.
- Marker UX: 4-preset ×3 picker in task properties and a subtask-row quick picker beside the rename action; re-selecting the active preset clears counts; legacy stored maps untouched until an explicit choice; the old `− / +` editor is removed.
- Inline markers: marker clusters share one row with the title on board cards, list rows, subtask rows, and previews; titles ellipsize first.
- Display defaults: migration `0051` adds `project.show_assignees_by_default` / `show_priority_by_default`, backfills existing projects to `true`, defaults new projects to `false`; per-user/per-project local overrides; `Hiển thị` gains both toggles; share payloads expose neither.

## Gates at commit dca547b0 (pre-deploy)

Web typecheck PASS · web vitest 37 files / 109 tests PASS · web build PASS · `i18n:check` 13 locales PASS · API build PASS · API integration 22 files / 222 tests PASS · real disposable-DB `0051` upgrade check PASS (run pre-revision; migration files unchanged since) · `git diff --check` clean. One type-level fix during the final re-run: `fetchers/task/update-work-markers.ts` unwraps `workMarkerCounts` from the API task response (runtime behavior unchanged). Rendered UAT evidence: `.impeccable/review/uat-revision-2026-10-28/`.

## Deployment evidence

- Bundle `.wave-uatfix6/` committed with this receipt, uploaded to `prodesk-home:/home/quoc/kaneo-wave-uatfix6/`, hash-verified byte-for-byte (13/13) before any mutation.
- Pre-apply survey: compose `24aebba0…`, running image uatfix5, metadata `c491af97…`, all five adapters at uatfix5 pins.
- First apply run blocked at step 2 (bundle integrity): the generated deploy script still carried the uatfix4 line as `CURRENT_IMAGE`. No mutation had occurred; the pin was corrected (`c82dc713…`), re-uploaded, hash-verified, and the apply rerun.
- Second apply PASS (9/9): host state re-verified, bundle integrity PASS, guarded deploy PASS (backup pre-flight, atomic compose flip, digest-pinned pull, rolling restart, health wait), migration verify PASS, wrapper guard post-flip PASS, metadata rebind PASS, backup-verify PASS (30-day gate), fresh snapshot `kaneo-20261028T145158Z` + R2 mirror PASS.
- Migration: head `0051_fuzzy_harry_osborn` id=54 count=54 hash `73246bf88aefd1634df1df1312489cf0b2aa89899efe5cd5345d75f4cd66a2f4`; required columns 27/27; GitHub constraints 2/2; backfill gaps 0; display-default gaps 0; marker counts valid.
- Public access from outside: `https://kaneo.quoc.app/` → 200, `/api/health` → `{"status":"ok"}`, `/auth/sign-in` → 200, `caddy-kaneo.service` active.

## Follow-up

Owner production UAT remains the acceptance gate for the post-UAT revision: drag responsiveness on Board/List, inline marker presets and subtask quick picker, display toggles per project age (legacy on / new off), mobile overflow. Rollback if needed: flip compose to the uatfix5 pin (`24aebba0…` compose, `809d858b…` image) and `docker compose up -d kaneo`; migration `0051` is additive (two new boolean columns with defaults) and backward-compatible.
