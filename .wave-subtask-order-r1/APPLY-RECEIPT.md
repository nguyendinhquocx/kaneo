# APPLY-RECEIPT — subtask-order-r1

Status: APPLIED — R10 guarded rollout PASS, 2026-11-19.

## Candidate

- Source: `kaneo/prodesk-production` commit `4a4996a3ed680480fedf3c4b17b7850112840d96`; candidate bundle commit `9f32fdeac9431f747ece0233fe4fcb16de26995b`.
- Python home-server pin source commit: `a51cfba52df3e7e2bc188b3f2d52d8ed9984541a` (pushed to `origin/main` from isolated worktree; unrelated dirty Python checkout untouched).
- Image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-4a4996a3-subtask-order-r1@sha256:fd6569575a92f76101c5838034a90ad0f9d70d5240575733501c7729837bc282`.
- Source archive SHA-256: `ddae118265a09ffc9a80a5b9c1d973e85a4ce9e766b62539b0a74e7e71b7bffb`; image label revision matches commit `4a4996a3`.
- Candidate Compose SHA-256: `85fe2ccc5f8a31d5a9c83b268ec22992987a4910663e819d95917da1d3e37ecf`.
- Backup wrapper SHA-256 after repin: `7b0b9247bdfb8de744b6feda9ca7fb8d78fe6761bca91c3f14ae0e1e77f27134`.
- Rollback image: `ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-7a8dc20e-glanceable-progress@sha256:8818eb60d14fdd15dedf8af57622b58f3c96fd7584e11cf3e912ff0ae1356b61`.

## Apply evidence

- Fresh H7 preflight: `ready`; pre-apply live image `8818eb60` healthy; Compose SHA `0835ee222befc5a5f1a30a4020096ca20dcf382dc93abb1d4dab09aeb1c4f99f`; current backup wrapper `--plan` PASS.
- Pre-snapshot: `kaneo-20261119T100216Z`; ciphertext SHA-256 `112b1aef8756818a93e10c6c766260367e3dbc7d1d923f6e6264a016ba7cf255`; receipt SHA-256 `67913b41ebfcc5f3297d92078db500cf9e6e36299be34982fca7b2f1f975256b`. Pinned low-level backup verifier and source/image/compose/freshness checks PASS.
- Candidate pull/up: container `kaneo` running and healthy with exact pinned digest `fd656957...`; image ID matches registry manifest.
- Migration/schema: PASS; head remains `0056_agent_session_delivery_generation` id 59/count 59/hash `a4b63b1aadb626ca8c99e033964add7a06094b0d8cc07fb2bccf9d39cf1dca5f`; columns 62/62, constraints 7/7, indexes 5/5, backfill gaps 0.
- Post-snapshot: `kaneo-20261119T100244Z`; ciphertext SHA-256 `4ee9073bc6beb2bcae7ad7890782f9d2c7498b5f8b4707cb6d3b909854c2fa6a`; receipt SHA-256 `0ccfc0af33b46f0ffa10854bb7e5247c99bf5685755fb6552453fb4b5deac2e7`. Pinned low-level backup verifier and source/image/compose/freshness checks PASS.
- Post-apply backup wrapper `--plan` PASS; HTTPS `https://kaneo.quoc.app/api/health` returned `{"status":"ok","executionMetrics":{}}`.
- Full bounded log: `.wave-subtask-order-r1/deploy-run.log`. Original ProDesk log SHA-256 `e11f25a400a00b7b7c789e9139afc2600ef4ac35a5e6b6cc588bd3851c17cac6`; committed copy SHA-256 `463caa5307a64aeede29be8f47add842f6bea8e5f35312337a3381a9da63410d` removes only 9 trailing blanks from Docker progress lines to satisfy commit policy.
- The SSH-TTY runner reported exit=2 after the script logged PASS; a separate read-only check confirmed the exact candidate pin, healthy container, Compose hash, source revision, and HTTPS health. No apply retry was run.

## Live drag UAT (agent, throwaway card)

PASS — 2026-11-19 ~11:13 UTC, on the live production bundle (Brave, logged-in session):

- Throwaway task TOD-222 `sr01gc6k5ms1qoy0u1yp4xg7` created in project `maiii` (`meexbothwau0tcpfrcms2lvk`) with two subtasks added through the real UI input (TOD-225 sub A, TOD-226 sub B).
- Keyboard drag (dnd-kit default sensors): focus handle of sub A → Space pick-up → ArrowDown → Space drop. dnd-kit live region announced “Đã thả UAT sub A (zz-delete) ở vị trí 2 trên 2.” and the UI order flipped to B → A.
- Server-side persistence verified via relations API: position 0 = sub B, position 1 = sub A; parent contentRevision advanced 1 → 4 (two relation adds + the reorder) with no 409 anywhere; browser network capture for the drag window recorded 6 entries / 0 failures.
- Real card #217 was not touched: revision stayed 7 and subtask order #218/#219/#220/#221 unchanged throughout.
- All UAT tasks (TOD-222/223/224/225/226) were deleted through the UI after verify; API readback confirms they no longer resolve.

## Gates and remaining checks

- R2 mirror was not run; it remains a separate owner gate.
- Owner is encouraged to do a casual drag on real card #217, but live behavior is now proven end-to-end on the deployed bundle; no open verification debt remains for this wave.
- GitHub Actions was disabled (HTTP 422); candidate was built from the exact committed archive on ProDesk native Docker Buildx. Docker Scout was not run.
