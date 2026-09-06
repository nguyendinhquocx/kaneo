---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-09-06-spec-kaneo-r10e-final-gate-v0-1"
status: "archived"
title: "SPEC-kaneo-r10e-final-gate-v0-1"
archived_at: "2026-09-06T22:11:04+07:00"
source_file: "SPEC-kaneo-r10e-final-gate-v0-1.md"
source_sha256: "3871a40eb05f73e7312b1176f4965fce8ac0c7ea6ff83c45e3994887886c28d1"
implementation_ref: "1464f3ce697fb27db94171cd2f936eb54e40d131"
working_tree: "dirty"
related_paths: ["apps/api/src/execution", "apps/api/src/task/controllers", "tests/api-integration", "compose.yml", "artifact-lock.json", "infra/host"]
---

# Spec: SPEC-kaneo-r10e-final-gate-v0-1

Ngày: 2026-09-06 · Supersedes: SPEC-kaneo-r10c-review-hardening-v0-1

## Objective

Đóng các finding cuối của final-gate review và làm cho production source-of-truth không còn mơ hồ giữa release r10e hiện tại và legacy release lane.

## Scope

### Runtime trust boundary

- `reportTaskRun` không ghi `lastCommitSha` từ report snapshot; field này chỉ thuộc checkpoint routes.
- `in_review` không có `commitSha` chỉ derive từ checkpoint row mới nhất của chính run, nơi commit đã đi qua Git guard receipt.
- Regression chứng minh generic report với free-form `commitSha` không ghi đè checkpoint provenance.

### Source/pin alignment

- Canonical `compose.yml`, `artifact-lock.json`, README, preflight/install checks và `upgrade-kaneo.sh` trỏ r10e image `1464f3ce` digest `c870ca32...`.
- Core direct guarded rollout chain trỏ r10d → r10e: compose `38ca4420...`, wrapper `420b7faa`, metadata/snapshot/installer hashes.
- Legacy upgrade/activate/stage/kill/rollback adapters được đánh dấu rõ trong `infra/host/LEGACY_RELEASE_LANES.md`; chúng giữ old pins chỉ cho historical receipts và không phải authority của r10e.

## Acceptance / evidence

- Unit: 252/252.
- Integration: 15 files, 126/126.
- esbuild bundle và `node --check` pass.
- Production r10e rollout: image digest `c870ca32...`, source revision `1464f3ce697fb27db94171cd2f936eb54e40d131`, migration id=50/head hash `e20d8fce...`, zero backfill gaps, wrapper `420b7faa`.
- Production GET: health ok; FULL tasks `grqdgz8g3txcej6dvttcseci` và `e1p7i1h4zoldns5t3qgazv2y` đều `done`; runs `tpbcx15j8h9xyayqwsus95ym` và `nl1boj4h3y1x5u8biypyqgi2` đều `finalized`; todoX PR #1/#2 merged.
- Final GLM Flash + Luna review phải PASS.

## Maintenance context

- Runtime trust: `apps/api/src/execution/service.ts`, `phase-checkpoint.ts`, `phase-progress.ts`.
- Mutation guard: `finalization-gate.ts`, `update-task.ts`, `update-task-description.ts`.
- Release source: `compose.yml`, `artifact-lock.json`, `recovery/backup-kaneo.sh`, `infra/host/LEGACY_RELEASE_LANES.md`.
- Tests: `tests/api-integration/execution-phase-cards.test.ts`.
