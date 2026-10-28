# Kaneo Wave uatfix7 Deployment Receipt — 2026-10-29

## Result: APPLIED & VERIFIED — owner UAT pending

Post-UAT visual refinement for SPEC-2026-10-27-kaneo-subtask-board-focus-markers deployed to ProDesk production under the previously approved Kaneo rollout scope. This wave has no API or schema changes.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf` |
| Source commit | `d56f1bbae914269fdd3b322fae4cbea19528603c` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-dca547b0-subtask-board-markers-uatfix6@sha256:7b684bb83a49a7b4c28f5f9fefd875e049203ca24caee0abf02feef895659dfd` |
| Compose SHA256 | `5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f` (only image pin changed) |
| Backup wrapper SHA256 | `ea1640d65d05b5882b4190318e9dd4371b663bf5b8f7ce6e225a4ae81e98e820` (previous=u6, candidate=u7) |
| Install metadata | `source_revision=d56f1bbae914269fdd3b322fae4cbea19528603c`, wrapper `ea1640d6…` |
| Fresh encrypted backup | `kaneo-20261028T180412Z` — ciphertext `9f12d811a9b2f8c601b9b821ae7efa3f54c06e866261c60e2a492ea2a18e7b02`, receipt `094fe755a81b0d53ee072c9f7b9955937e12f2febcfdbcfe30874de10676137b`; strict-verified and mirrored to private R2 |

## Shipped UI refinements

- Board cards and List rows no longer grow the title flex item to fill the row; parent and child-preview markers now sit immediately after their visible title. Long titles retain ellipsis before the marker cluster.
- Selected marker triggers display glyphs only; empty state retains `Marker`. The trigger remains named `Marker` for assistive technology and is left-aligned; the stacked desktop properties trigger uses the property column width.
- Marker choices now use a labeled `fieldset` for the option group; no marker values, picker behavior, or API/data model changed.

## Verification

- Web: 37 test files / 111 tests PASS; typecheck PASS; build PASS; `pnpm i18n:check` 13 locales PASS; `git diff --check` PASS; final Impeccable detector `[]`.
- Focused marker/sidebar regression tests: 9/9 PASS. The new selected-state test failed before the fix because the visible `Marker` text remained; it passed after the conditional label change.
- Build warnings: the existing bundle still includes chunks >500 kB; unrelated to this CSS/trigger change.
- Local after-patch screenshot was not captured: the managed browser session had lost its authenticated local session and redirected to sign-in. No credentials were passed to browser tooling. The production UAT below remains the visual acceptance gate.

## Deployment evidence

- Bundle `.wave-uatfix7/` staged at `prodesk-home:/home/quoc/kaneo-wave-uatfix7/`; local/remote hashes verified 13/13 before mutation. The first comparison only differed because local `sha256sum` prefixes binary filenames with `*`; after normalizing the filename prefix, every file hash matched.
- Read-only pre-apply survey matched uatfix6: compose `1e637fa3…`, running image uatfix6, metadata `dca547b0…`, and all five adapter hashes at uatfix6 pins. The apply script re-checks these values before mutation.
- `kaneo-wave-apply.sh` PASS 9/9: host/bundle guards, adapter staging, backup guard, digest-pinned pull, restart and health, migration verifier, metadata rebind, backup verify (30-day freshness retained), encrypted snapshot, and R2 mirror.
- Migration head remains `0051_fuzzy_harry_osborn` id=54/count=54/hash `73246bf88aefd1634df1df1312489cf0b2aa89899efe5cd5345d75f4cd66a2f4`; required columns 27/27, GitHub constraints 2/2, backfill gaps 0, display-default gaps 0, marker counts valid.
- Runtime: Kaneo healthy, PostgreSQL healthy, `caddy-kaneo.service` active. External checks: `https://kaneo.quoc.app/` → 200, `/api/health` → `{"status":"ok"}`, `/auth/sign-in` → 200.
- Deprecated generic ServerOps contract `alpha-host.toml` was not touched; no legacy `kaneo-activate-release` lane used.

## Owner UAT — pending

Verify on production:

1. On a Board card, parent markers appear directly after the parent title; child-preview markers appear directly after the preview text, not at the far edge. Long titles ellipsize before markers.
2. In task details, an empty marker control says `Marker`; with a selected preset it shows only the glyph cluster, aligned left.
3. Check the same selected/empty state in the compact detail sheet and on a narrow screen (320/375px).

The working spec remains unarchived until the owner confirms this UAT.
