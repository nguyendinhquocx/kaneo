---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-09-06-spec-kaneo-r10c-review-hardening-v0-1"
status: "archived"
title: "SPEC-kaneo-r10c-review-hardening-v0-1"
archived_at: "2026-09-06T20:39:14+07:00"
source_file: "SPEC-kaneo-r10c-review-hardening-v0-1.md"
source_sha256: "1a7b9cd810d88e86a74760fd95e4d8fb3b23f62226c2fef75402fdde27749fdd"
implementation_ref: "1449400e2d750a0a4095b727275af42eba707a68"
working_tree: "clean"
related_paths: ["apps/api/src/execution", "apps/api/src/task/controllers", "tests/api-integration"]
---

# Spec: SPEC-kaneo-r10c-review-hardening-v0-1

Ngày: 2026-09-06 · Supersedes: SPEC-kaneo-r10c-description-guard-v0-1

## Context

Final-gate review phát hiện ba lỗ hổng trong wave r10c ban đầu:

1. `reportTaskRun` cho phép generic report ghi `lastCommitSha` từ `commitSha` tự khai; Fix 2 sau đó dùng giá trị này làm fallback cho parent review.
2. PATCH description kiểm tra mapping rồi update bằng hai query riêng, không khóa task trong cùng transaction.
3. Regression test chỉ chứng minh PUT tổng quát; chưa chứng minh endpoint description riêng.

## Objective

Làm cho Fix 1/2 của r10c có trust boundary và coverage đủ để deploy lại production mà không đổi contract worker hợp lệ.

## Scope

- `apps/api/src/execution/service.ts`
- `apps/api/src/task/controllers/update-task-description.ts`
- `tests/api-integration/execution-phase-cards.test.ts`

## Decisions

### Trusted commit provenance

- `lastCommitSha` chỉ được cập nhật bởi generic checkpoint và dedicated phase-checkpoint routes sau khi guard receipt đã validate.
- `reportTaskRun` không promote `commitSha` tự khai vào `lastCommitSha`.
- Khi report `in_review` thiếu `commitSha`, server lấy `commitSha` từ checkpoint row mới nhất của chính run; checkpoint row chứa guard receipt đã validate. Nếu không có checkpoint thì không tự bịa evidence.
- `run.commitSha` đã tồn tại vẫn được giữ nguyên vì đó là explicit worker evidence; parent review vẫn phải cung cấp verification độc lập.

### Atomic description guard

- Endpoint `/task/description/:id` khóa task row trong transaction, kiểm tra FULL mapping và update description trong cùng transaction.
- FULL title/description mutation trả 409; identical write vẫn idempotent.

### Regression coverage

- PUT tổng quát dùng normal parent user để thật sự chạm controller guard, không bị agent-principal middleware chặn trước.
- Endpoint description riêng có test đổi nội dung trên FULL task → 409.
- Flow checkpoint → report `in_review` không có `commitSha` chứng minh derive từ checkpoint durable.

## Acceptance / verify

- Unit `252/252` pass.
- Integration `15 files, 125/125` pass với Docker test database.
- API bundle esbuild pass.
- `git diff --check` pass.
- Production image r10d deploy + migration/backup metadata verify pass.
- Reviewer GLM Flash và Luna đều PASS sau deploy.

## Maintenance context

- Commit provenance: `apps/api/src/execution/service.ts`, `phase-checkpoint.ts`, `phase-progress.ts`.
- Content mutation boundary: `finalization-gate.ts`, `update-task.ts`, `update-task-description.ts`.
- Regression suite: `tests/api-integration/execution-phase-cards.test.ts`.
- Failure mode nếu thiếu checkpoint: parent review phải dừng ở `Worker commit evidence is missing`, không tự lấy SHA từ generic report.
