# Kaneo Wave uatfix3 Deployment Receipt — 2026-10-25

## Result: APPLIED & VERIFIED

Production UAT follow-up commit `708d1712` deployed to ProDesk after owner reported drag 400s, read-rate-limit lockout, and mobile header overlap.

## Identity

| Item | Value |
| --- | --- |
| Deployed image | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-708d1712-uatfix3@sha256:4e952ebe74c32bdea01c6d306643b811162454ab6f74f8dde63f214b19a7eb88` |
| Source commit | `708d17125ad9594917f58f64eed96a9c3fa0ed8c` (`kaneo/prodesk-production`, pushed to `github-main`) |
| Image build | Local laptop `docker buildx build --platform linux/amd64 -f Dockerfile.kaneo`; fork workflow dispatch remained disabled |
| Rollback pin | `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-09a9fe89-fullshare@sha256:3108cd3f6b485dabe860b9aaaad6b56d70d3ac7c8e624e50e9023f3a1c3be37e` |
| Compose SHA256 | `c57926be993152afb037c69fc594a52584b384b2d140d1c34a1d9bad93843ddb` |
| Fresh backup | `kaneo-20261025T043327Z` — ciphertext `a4712d7465ae2a664ad8e0d639ba821345ef6d87abe495e44475041611700050`, receipt `eeba167e1b806205e229c0d3e681bccb70358e14ec270cb68af89640037c927f`, strict-verified and R2-mirrored |

## Shipped fixes

- Full-share project payload now sends `column.id = column.slug`; reproduced the prior server `400 Invalid status "<column nanoid>"` and verified slug status update returns 200.
- Share read budget raised from 60 to 240 requests/minute per token; capability polls stop after error and do not retry into an active 429 window.
- Public board copy/view controls collapse to accessible icon-only buttons below `sm`; full-share header nav is icon-only on mobile and the holder badge no longer wraps.
- Dialog label is `Full`; removed the long full-permission warning paragraph.
- Public task detail modal gained an explicit empty-description state.

## Deployment evidence

- Guarded apply `kaneo-wave-apply.sh`: steps 1–5 PASS; candidate pulled by digest and container healthy. Interactive runner detached before subsequent steps, so the explicit continuation `kaneo-wave-continue.sh` reverified state and completed metadata + migration + backup verification. The snapshot adapter then correctly blocked because it lacked the fullshare wrapper allowlist; `kaneo-wave-continue2.sh` staged that adapter pin and completed the fresh snapshot + R2 mirror.
- Migration/schema PASS: Drizzle head `0049_wise_loners`, id 52/hash `97f40d59…`; no schema migration in this wave.
- Production health `200`; share endpoint returned project payload with each `column.id === column.slug`; authenticated API test reproduced task status 400 for nanoid and 200 for slug.
- Gates at commit 708d1712: API unit 264/264, API integration 208/208, web 72/72, both typechecks, build and i18n:check pass.

## Follow-up

The owner supplied another UAT pass after this deploy. Drag still emitted one PUT per card and could hit the write limiter; current worktree contains a dedicated atomic integer-index move endpoint, pending-state rollback and the task-modal duplicate-close fix. These changes are **not included** in `708d1712` and have not yet been deployed or owner-UATed. Do not treat `708d1712` as final acceptance.
