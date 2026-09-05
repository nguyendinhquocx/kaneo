# SPEC-kaneo-phase-cards-full-run-server-v0-1

Spec ID: `SPEC-kaneo-phase-cards-full-run-server-v0-1`

> Status: DRAFT — revision 4 của master `SPEC-kaneo-phase-cards-full-run-v0-4`
> Repo: `nguyendinhquocx/kaneo`
> Execution Mode: `full_run`
> Phase Map Version: 1
> Change Set: opaque parent-generated ID

## Context Snapshot

- API có task-run lease fence qua `leaseEpoch` + `X-Kaneo-Lease-Token`, checkpoint, report, recovery và parent finalization.
- Generic task/status/comment/relation/schedule routes chưa nhận biết phase-card mapping; checkpoint chưa có phase/spec/map provenance.
- Stream này chỉ sửa repo server. Parent/worker client, contract và directive nằm trong runtime spec repo `code-python`.

## Objective

Tạo authority server cho một FULL run có N phase child cards nhưng chỉ FULL task được claim. Phase progress phải fenced theo đúng run/lease/principal, idempotent, tuần tự, có checkpoint proof đúng phase, block/recovery/reject atomic và finalization không thể bỏ qua phase.

## Thuật ngữ

- `FULL`: task có schedule, lease, branch và parent finalization.
- `phase_card`: child card có mapping server-side, không thể claim.
- `sourcePhaseMapSha256`: hash Phase List không chứa child IDs.
- `graphMapSha256`: hash map sau khi server tạo child IDs.
- `same-row recovery`: cùng task_run, epoch mới, cùng branch.
- `fresh recovery`: run/branch mới, chỉ carry checkpoint ancestry đã verify.

## Canonical phase source

Spec có `## Phase List` với một entry cho execution stream này; feature test seed fixture 3 phase trong test, không nhét child IDs vào source hash. Mỗi entry có `phase_id`, `parser_task_id` khớp `T<number>`, `ordinal`, `required`, title, Files, Verify.

`phase_count` tối đa 30; server reject phase thứ 31 với `phase_count_exceeds_limit`. Canonicalization dùng UTF-8 không BOM, Unicode NFC, path `\\` đổi `/`, trim + reject absolute/traversal/empty path, object keys sort theo Unicode code point, phase entries sort ordinal, Files/Verify sort lexicographically, arrays khác giữ thứ tự, JSON compact `,`/`:`, SHA-256 raw bytes. Vector source 3 phase phải có hash `571b8fc41098e9bd924e17e708ff0adc2b6148b8acad4ebf055201381de3b3ff`; graph vector thêm `full_task_id=full` và child IDs `c1/c2/c3` phải có hash `717d7cda68bae645ec0a92959fce00874253feffa9398fb332e1a8b3e51c46cf`.

`sourcePhaseMapSha256` là SHA-256 canonical JSON theo algorithm master: UTF-8 không BOM, Unicode NFC, path `\\` thành `/`, trim/reject absolute/traversal/empty, object keys sort Unicode code point, phase entries/Files/Verify sort, JSON compact `,`/`:`, raw SHA-256. Không đưa child ID, timestamp, request key hoặc prose vào hash; `receiptSha256` bỏ chính field đó.

## Technical Approach

`project.projectRevision` là integer server-owned, default 1; migration 0047 thêm field. Graph-affecting task/relation/mapping mutation bump revision. Preview đọc revision; graph/ready CAS dùng `WHERE project_id = ? AND project_revision = expectedProjectRevision`, bump đúng một lần. Không nhận placeholder.

### Schema và proof

Thêm mapping `execution_phase_card` với unique `(full_task_id, phase_id)` và unique `child_task_id`; lưu `project_id`, `full_task_id`, `child_task_id`, `phase_id`, `parser_task_id`, `ordinal`, `required`, `spec_sha256`, `source_phase_map_sha256`, timestamps.

Thêm `execution_phase_progress` với unique `(full_task_id, phase_id)`; lưu ordinal, state `pending|in_progress|done|blocked`, run/parentRun, lease epoch, checkpoint ID, commit/branch/base, reason, failure kind, timestamps. Tạo pending rows trong graph transaction; index `(full_task_id, ordinal)` và `(run_id, state)`. Chỉ một phase `in_progress` trong một FULL; transaction lock toàn bộ ledger rows theo ordinal và yêu cầu predecessor required `done`.

Thêm `execution_phase_projection` outbox với unique `(full_task_id, phase_id, projection_kind, ledger_version)`, lưu child ID, desired column slug, structured marker payload/hash, state `pending|applied|failed`, attempt count, last error và timestamps. Graph/phase transaction ghi outbox. `POST /api/execution/task/:taskId/phase-projections/reconcile` là parent/dispatcher-only, claim bounded rows và áp status/comment idempotently sau crash; finalization cũng repair bounded. Comment không được là authority.

Mở rộng `task_run_checkpoint` với `phase_id`, `spec_sha256`, `source_phase_map_sha256`, `receipt_hash`; field bắt buộc cho FULL run mới và nullable/untrusted cho legacy. Tạo dedicated `POST /api/execution/task/:taskId/runs/:runId/phase-checkpoints`; body gồm `leaseEpoch`, `phaseId`, `headSha`, `commitSha`, `baseSha`, `guardReceipt`, `commands`, `artifactHashes`, `expectedRunRevision`, còn runtime tự điền spec/map hash. Generic `/checkpoints` trên FULL mapped run trả `409 use_phase_checkpoint`. Checkpoint response và stored idempotency response đều phải có `checkpoint_id`; request key là `phase-checkpoint:<runId>:<phaseId>:<commitSha>`.

### Graph publish wire contract

Route: `POST /api/execution/project/:projectId/full-run-graphs`.

Headers: `Authorization`, `Idempotency-Key`, `X-Kaneo-Change-Set`.

Body bắt buộc: `planHash`, `expectedProjectRevision`, `changeSetId`, `specId`, `specSha256`, `sourcePhaseMapSha256`, `baseBranch`, `full` gồm `title`, `description`, `scope`, `verify`, `taskExecutionState:published`, và `phases[]` gồm `phaseId`, `parserTaskId`, `ordinal`, `required`, `title`, `description`, `files`, `verify`, `status:to-do`.

`full.description` phải bắt đầu bằng legacy worker-contract JSON `schema:1` có `agent:pi-prodesk`, `repo`, `path:.`, `state:ready`, `spec_id`, `task_id:FULL`, và `files/scope/writes` là sorted union toàn bộ phase files. Phase map/envelope JSON nằm sau block này. Scheduled claim dùng đúng union đó; server không cắt scope.

Một transaction phải validate hash/ordinal/task ID/scope, tạo FULL với `task.executionState=published` + children + mapping + pending ledger rows + relation `subtask` đúng hướng + FULL envelope map + execution idempotency receipt. `workerContract.state=ready` trong description chỉ phục vụ eligibility, không đổi lifecycle. Lỗi rollback toàn bộ. Retry cùng request key/payload trả receipt cũ; key khác payload trả 409.

Receipt bắt buộc: `schemaVersion`, `graphId`, `projectId`, `projectRevision`, `fullTaskId`, `phaseCards[]` (`phaseId`, `parserTaskId`, `childTaskId`, `ordinal`, `required`), `sourcePhaseMapSha256`, `graphMapSha256`, `specSha256`, `changeSetId`, `planHash`, `taskRevision`, `receiptSha256`. `graphId` deterministic từ canonical `{projectId, changeSetId, planHash}`; `receiptSha256` bỏ chính field đó trước khi hash. Route GET `/api/execution/project/:projectId/full-run-graphs/:graphId` và `GET /api/execution/project/:projectId/full-run-graphs/by-request?requestKey=<url-encoded-key>` trả receipt bounded để reconcile; `requestKey` = giá trị `Idempotency-Key` header của POST graph publish, server lưu map requestKey → receipt trong execution idempotency. Receipt bind authenticated parent owner; `X-Kaneo-Change-Set` phải đúng body `changeSetId`. Ready-CAS cũng nhận `Idempotency-Key`; retry cùng key trả receipt cũ.

Tạo route parent-only `POST /api/execution/project/:projectId/full-run-graphs/:graphId/ready` nhận `planHash`, `expectedProjectRevision`, `expectedTaskRevision` và CAS `published → ready`; drift trả 409. Chỉ ready-CAS pass mới được schedule. Child không có execution envelope/schedule; mapping mới là claim guard.

### Phase-progress wire contract

`failureKind=malformed_phase_map` là canonical validation value cho `blocked_input`. `report(in_review)` trên FULL mapped run trả `409 phase_progress_incomplete` nếu required ledger chưa done và không deactivate lease. Generic report blocked/release/checkpoint trên FULL mapped run trả `409 use_phase_progress` hoặc `use_phase_checkpoint`.

GET: `/api/execution/task/:taskId/runs/:runId/phase-progress` trả map snapshot + ledger bounded; `phase_count <= 30` nên không pagination và không cắt authority.

POST: `/api/execution/task/:taskId/runs/:runId/phase-progress`.

Body: `leaseEpoch`, `phaseId`, `action`, `checkpointId` bắt buộc khi `complete`, `failureKind`, `reason`, `retryAt`, `expectedRunRevision`. Header `X-Kaneo-Lease-Token`, `Idempotency-Key`. Tool model-facing không nhận run/epoch/token; runtime tự gắn.

- `get`: đọc map và ledger.
- `begin`: `pending|blocked → in_progress`; cùng run same-row có ledger `in_progress` epoch cũ thì no-op + audit refresh; kiểm predecessor done và chỉ một phase active.
- `complete`: bắt buộc checkpoint ID; checkpoint phải đúng run/phase/spec/source-map/branch/base/ancestry/receipt hash. Epoch checkpoint được phép cũ hơn epoch hiện tại nếu cùng run, thuộc lineage và không ở tương lai; không chấp nhận commit SHA tự khai thay proof.
- `block`: một transaction ghi phase blocked, run canonical `blocked_quota|blocked_input|blocked_clarification|blocked_branch_drift|failed`, blocker/evidence/outbox và lease inactive bằng CAS. `failureKind=malformed_phase_map` là giá trị canonical cho map lỗi; validation phải cho phép giá trị này.

Lock order cố định: FULL task → run → tất cả ledger rows theo ordinal → phase row → child projection. Fence checker kiểm trước mutation; stale token/epoch/expired lease trả `stale_fence` và không mutate run.

Idempotency dùng bảng execution idempotency, không dùng một key duy nhất trên ledger. Key deterministic:

- `phase-begin:<runId>:<phaseId>`
- `phase-complete:<runId>:<phaseId>:<checkpointId>`
- `phase-block:<runId>:<phaseId>:<failureKind>`

Canonical request hash của `phase-begin` và `phase-block` loại `leaseEpoch` và free-text `reason` vì đó là fence/audit; `phaseId/action/failureKind` vẫn được hash. `phase-complete` chấp nhận checkpoint cùng run có epoch cũ hơn epoch hiện tại nếu lineage/branch/spec/map hợp lệ. Checkpoint ID phải nằm trong response mới và stored idempotency response.

### Projection và generic guards

Projection ledger commit tách khỏi child status/comment bằng durable projection outbox/reconcile. Projection lỗi trả `display_pending`, không rollback ledger và không block worker. Finalization repair projection hoặc trả reconcile error.

Central phase-card guard phải phủ toàn bộ write surface: normal/scheduled claim; schedule create/update/cancel; legacy checkpoint; report mọi state; supervisor-report; resume; fallback; release; task update/status/move/delete/bulk/import/create; comment create/update/delete; relation create/delete; label attach/detach/update/delete; asset/attachment mutation nếu route tồn tại; và MCP mutator route. Guard phải đặt ở service/middleware chung để phủ REST lẫn MCP, không chỉ đặt ở một controller. Agent principal không được generic `report(blocked_*)`, `report(in_review)`, `resume`, `fallback`, `release`, generic checkpoint, task mutation, `create_task` khi project có FULL graph active, label mutation hoặc relation forge trên FULL mapped run; trả `409 use_phase_progress`/`phase_progress_incomplete`. Fenced `/heartbeat` scope `run:heartbeat` GIỮ NGUYÊN cho worker trên FULL mapped run: chỉ renew lease, không đụng phase/ledger, không có gì để bypass; server kiểm fence chuẩn như hiện tại.

Schedule eligibility CAS authority: `assertScheduledTaskEligible` phải đọc `task.execution_state ∈ {ready, queued}` từ database column, KHÔNG fallback đọc envelope state trong description. FULL publish xong vẫn `published` → schedule/claim/dispatch bị chặn tới khi ready-CAS. Negative test bắt buộc: schedule FULL `published` → dispatch no-op/409; sau ready-CAS → dispatch pass.

Phase-progress/phase-checkpoint dùng fence-check thuần read-only: stale token/epoch/expired trả `stale_fence` và không mutate gì; orphaning lease chỉ thuộc watchdog/claim-recovery path, không nằm trong fence helper của phase path. Stored idempotency response rỗng (crash giữa reserve và save) xử lý như chưa-reserve: re-execute trong cùng request, không bao giờ replay `{}`; riêng phase-checkpoint có thể rebuild response từ checkpoint row.

Phase child chỉ nhận projection từ fenced phase-progress. Column resolve server-side theo slug `to-do`, `in-progress`, `done`; worker không gửi status string tự do. Marker server render từ structured receipt, không nhận free-text content.

Claim guard reject phase child cả normal claim lẫn scheduled claim bằng mapping table; không dựa vào thiếu envelope.

### Recovery, reject và block

- Lease expiry same-row, kể cả run `checkpointed`: cùng task_run/branch, epoch mới; phase `done` giữ nguyên; phase `in_progress` được `begin` no-op refresh và làm tiếp.
- Block: phase hiện tại blocked, phase done giữ; run blocked và lease inactive trong cùng transaction.
- Recovery từ blocked: run mới có `parentRunId`, branch mới bắt đầu từ checkpoint ancestry đã server validate; `begin` mở `blocked` phase.
- Parent reject: reset toàn bộ phase về pending trong cùng transaction + reset receipt; fresh run không skip phase bằng status cũ.
- Explicit fresh carry chỉ khi parent chỉ định và server xác nhận checkpoint ancestry/branch; nếu không reset.

Fresh resume dùng key `resume:<taskId>:<sourceRunId>:<sourceLeaseEpoch>:<sourceCheckpointId>`; `resumeTaskRun` không dùng `Date.now()` và không nhận raw commit làm proof. Git guard phải nhận start SHA từ server-validated checkpoint ancestry.

### Finalization

Finalization lock FULL + mapping + ledger; kiểm exact required set, predecessor/order, mọi phase done, checkpoint phase/spec/map/branch proof hợp lệ, không active/blocked/missing. Projection stale thì repair. Thiếu proof trả `409 phase_progress_incomplete`; comment/Kanban status/model verifyResult không bypass.

Reject phải reset toàn bộ phase ledger về `pending` trong cùng transaction, ghi reset receipt/reason. Recovery matrix phải có test: same-row `checkpointed` giữ branch; same-row `in_progress` refresh epoch; blocked recovery mở lại phase; reject reset atomic; fresh carry chỉ từ checkpoint ancestry đã validate.

## Scope

### In scope

- Schema/migration 0047, phase mapping/ledger/checkpoint proof/idempotency.
- Graph publish/reconcile route/service và receipt.
- Phase-progress route/service, order/one-active, block/recovery/reject/finalization.
- Guards tại task/comment/relation/schedule/MCP routes và regression tests.

### Out of scope

- Parent/worker TypeScript tools, contract text, runtime directive và source/runtime sync.
- UI dashboard mới, notification route mới.
- Deploy production; master integration gate xử lý r10.

## Phase List

- phase_id: P1
- parser_task_id: T1
- ordinal: 1
- required: true
- title: Server authority FULL-run phase cards
- Files:
  - apps/api/src/database/schema.ts
  - apps/api/src/database/index.ts
  - apps/api/src/execution/phase-progress.ts
  - apps/api/src/execution/phase-checkpoint.ts
  - apps/api/src/execution/graph-publish.ts
  - apps/api/src/execution/phase-projection.ts
  - apps/api/src/execution/service.ts
  - apps/api/src/execution/index.ts
  - apps/api/src/execution/finalization-gate.ts
  - apps/api/src/execution/transitions.ts
  - apps/api/src/execution/validation.ts
  - apps/api/src/execution/schedules.ts
  - apps/api/src/label/index.ts
  - apps/api/src/project/index.ts
  - apps/api/src/task/index.ts
  - apps/api/src/task/controllers/import-tasks.ts
  - apps/api/src/comment/index.ts
  - apps/api/src/activity/index.ts
  - apps/api/src/activity/controllers/create-comment.ts
  - apps/api/src/task-relation/index.ts
  - apps/api/src/mcp/tools.ts
  - apps/api/drizzle/0047_execution_phase_progress.sql
- Verify:
  - pnpm --filter @kaneo/api test:unit
  - pnpm --filter @kaneo/api test:integration

## Task List

### Server FULL — phase authority, graph receipt and all guards
- id: T1
- depends_on: []
- wave: 1
- risk: T3
- Reproduce: pnpm --filter @kaneo/api test:unit
- Acceptance:
  - phase child không claim/schedule/generic mutate/comment/relation forge được
  - stale/expired fence, wrong phase/checkpoint/hash/branch bị reject và không mutate
  - begin/complete/block tuần tự, one-active, idempotent; block atomic
  - checkpoint mới có phase/spec/map proof và retry luôn trả checkpoint ID
  - graph publish transaction rollback/retry/reconcile không orphan/duplicate
  - same-row checkpointed/in_progress recovery, blocked recovery và reject reset giữ đúng ledger/branch semantics
  - schedule eligibility đọc task.execution_state: FULL published bị chặn dispatch, ready-CAS xong mới dispatch
  - heartbeat fenced pass trên FULL run và refresh lease; stale fence không mutate
  - stored idempotency response rỗng được re-execute, không replay `{}`
  - phase_count trên 30 bị reject; report in_review sớm không deactivate lease
  - finalization thiếu required phase proof trả phase_progress_incomplete
- Verify:
  - pnpm --filter @kaneo/api test:unit
  - pnpm --filter @kaneo/api test:integration
- Files:
  - apps/api/src/database/schema.ts
  - apps/api/src/database/index.ts
  - apps/api/src/execution/phase-progress.ts
  - apps/api/src/execution/phase-checkpoint.ts
  - apps/api/src/execution/graph-publish.ts
  - apps/api/src/execution/phase-projection.ts
  - apps/api/src/execution/service.ts
  - apps/api/src/execution/index.ts
  - apps/api/src/execution/finalization-gate.ts
  - apps/api/src/execution/transitions.ts
  - apps/api/src/execution/validation.ts
  - apps/api/src/execution/schedules.ts
  - apps/api/src/label/index.ts
  - apps/api/src/project/index.ts
  - apps/api/src/task/index.ts
  - apps/api/src/task/controllers/import-tasks.ts
  - apps/api/src/comment/index.ts
  - apps/api/src/activity/index.ts
  - apps/api/src/activity/controllers/create-comment.ts
  - apps/api/src/task-relation/index.ts
  - apps/api/src/mcp/tools.ts
  - apps/api/drizzle/0047_execution_phase_progress.sql

## User Test

Không có user test trực tiếp trong server stream; integration stream chạy rehearsal board.

## Implementation Handoff

Worker làm toàn bộ T1 trong một phiên, checkpoint sau schema → phase API → guard/finalization test. Không review giữa milestone; parent review một lần cuối stream.

## External Review Brief

Chỉ APPROVED khi wire schema/receipt exact, graph thật sự transaction/idempotent, mọi generic bypass route bị guard, stale fence không mutate, phase ordering/one-active chạy được, checkpoint phase-bound và recovery/reject/block khớp matrix.
