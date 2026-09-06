# SPEC-kaneo-r10c-description-guard-v0-1

Ngày: 2026-09-06 · Repo: kaneo (branch `kaneo/prodesk-production`) · Ảnh: r10c

## Context

Rehearsal r10b phát hiện 3 gap production (đã ghi backlog trên FULL task `e1p7i1h4`):

1. **Outside writer ghi đè `description` FULL task** — lần 1 escape `\[` (dispatcher reject `contract_escaped_markup` → skip schedule), lần 2 thành CRLF. Mọi path update task qua API đều ghi thẳng, không phân biệt FULL mapped run.
2. **Worker report `in_review` không kèm `commitSha`** → `run.commit_sha` null → parent approve 409 "Worker commit evidence missing". Worker CÓ thể truyền (param tồn tại) nhưng không bắt buộc; runtime model-driven dễ quên.
3. **Projection outbox không autopilot** — `enqueuePhaseProjections` ghi pending rows rồi thôi; cards kẹt `to-do` dù ledger `done` cho tới khi parent gọi reconcile tay.

## Objective

Server-side vá 3 gap trên, giữ nguyên contract hiện có (không breaking change cho worker/extension đang chạy).

## Scope

### Fix 1 — FULL description/title mutation guard

- Helper `assertFullRunNotMutated(tx, taskId)` trong `apps/api/src/execution/finalization-gate.ts`: query `executionPhaseCardTable` WHERE `fullTaskId = taskId` LIMIT 1; có row → FULL mapped run.
- Gọi trong `updateTask` (PUT `/task/:id`) và `updateTaskDescription` (PATCH): nếu title/description THAY ĐỔI so với existing → 409 `use_phase_progress: FULL run task fields are immutable; use the graph publish API`.
- Status/column move vẫn cho phép qua gate hiện có (assertFinalTaskStatusGate đã chặn done).
- Chỉ chặn mutation nội dung; không chặn khi giá trị identical (idempotent writes).

### Fix 2 — report in_review tự derive commitSha

- Trong `reportTaskRun` (service.ts): khi `nextState === "in_review"` và `nextCommitSha` undefined và `run.commitSha` null → dùng `run.lastCommitSha` (đã verify push qua Git guard khi checkpoint).
- Ghi evidence field `commitShaDerived: true`? — Không: giữ evidence nguyên vẹn, chỉ set column. Mục tiêu: parent review `verification.commitSha` khớp `run.commit_sha`.

### Fix 3 — inline projection reconcile

- Trong `phase-progress.ts` action `complete` (và `begin`): sau `enqueuePhaseProjections`, gọi `reconcilePhaseProjections({ fullTaskId: taskId, executor: tx })` trong cùng transaction; `displayPending` trong response (`displayPending: boolean`) — non-fatal, không rollback khi fail (reconcile tự catch per-row).
- Circular import `phase-progress ↔ phase-projection` an toàn với ESM function exports (esbuild bundle) — đã verify pattern.
- Khi reconcile inline apply hết → cards trôi ngay tại checkpoint, không đợi parent.

## Non-goals

- Không sửa extension runtime (worker) trong wave này — fix server đủ.
- Không điều tra outside writer ở tầng client (guard API chặn mọi mutation qua API; nếu writer bypass API thì phải là DB access — đã monitor qua lần sau).
- Không đụng finalize/PR gate (backlog #4, #6 — wave sau).

## Acceptance

1. PUT/PATCH task FULL mapped run đổi title/description → 409 `use_phase_progress: FULL run task fields are immutable`. Task thường → không đổi hành vi.
2. Report `in_review` không kèm commitSha, run có `last_commit_sha` → `run.commit_sha` = last push; parent approve với headSha đó PASS gate "Worker commit evidence".
3. `phase-progress complete` → card childTask chuyển `done` ngay trong response (reconcile inline), không cần gọi tay `/phase-projections/reconcile`.
4. Unit + integration tests pass (Docker Desktop + `kaneo-pg-test`).

## Verify

- `npm run test:unit` trong apps/api (252 tests cũ + mới).
- Integration: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/kaneo npm run test:integration` (Docker Desktop phải chạy, container `kaneo-pg-test`).
- Build esbuild PASS.
