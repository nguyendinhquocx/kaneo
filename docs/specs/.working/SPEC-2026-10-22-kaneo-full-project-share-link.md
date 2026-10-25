# Spec: Full project share link — owner workflow without login

## Context Snapshot

- Project: Kaneo self-hosted PM app; API Hono + PostgreSQL/Drizzle, web React/TanStack Router/TanStack Query/Tailwind v4, pnpm 10.32.1.
- Source revision reviewed: `a8cb40f3`; repository was clean before this spec.
- Supersedes: the *public project share write boundary only* in `SPEC-2026-10-08-kaneo-workspace-collaboration`. All other collaboration behavior remains unchanged.
- Current behavior: `/public-project/:id` is read-only. `/share/project/:token` supports `view` and `edit`; `edit` only creates/updates basic task fields through a separate simplified page. Existing `edit` links are bearer capabilities, expiring after 30 days and revocable.
- Owner surface: authenticated project routes provide board/list/Gantt/backlog/Docs, toolbar/search/filter/sort, task detail sheet and full-page task route, task properties, comments/files, subtasks/relations, project settings, and project documents. Current owner entry is `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board.tsx`; `ProjectLayout` also adds workspace/project navigation and an authenticated project WebSocket.
- Relevant implementation: `apps/web/src/components/share/project-share-reader.tsx`, `apps/web/src/routes/share/$resourceType/$token.tsx`, `apps/api/src/share/manage.ts`, `apps/api/src/share/resolve-share-link.ts`, `apps/api/src/share/public-write.ts`, `apps/api/src/project/controllers/public-project-dto.ts`, `apps/api/src/activity/index.ts`, `apps/api/src/activity/controllers/create-comment.ts`, activity/notification/execution services, authenticated project/task routes and their hooks.
- Visual authority: `apps/web/DESIGN.md` and the incumbent authenticated project surfaces. Mode is Operate. Reuse the owner UI and its tokens/components; this is not a redesign.
- Product decision: the owner explicitly chose a full capability scoped to one project, with a 30-day expiry and early revocation. It must not grant workspace/account administration, credentials/integration secrets, cross-project operations, or agent-control. Ordinary project work must remain usable when unrelated agent-control data exists; if a specific object/action cannot be proven unrelated, deny it.
- No code, migration, deployment, or production data change is authorized by this spec alone.

## Objective

Someone holding a new full-project link can work in the shared project without signing in, using the same project UI and the same project-scoped actions the owner uses. A normal share `edit` link remains limited and does not silently gain these powers. The link is still a secret key: record edits as link activity, never pretend the anonymous holder is the owner.

## Scope

### In

- Add a distinct `full` permission for project capability links. Preserve existing `view`/`edit` behavior, expiry, revocation, and old links.
- Give the holder parity with authenticated owner operations whose target is wholly inside the one linked project: board/list/Gantt/Docs, tasks and supported destructive actions, project-local workflow/labels, task properties, comments, relations/subtasks, and project-scoped files. The exact action/API matrix is a required T1 artifact inside this spec before implementation; every owner control, route target, auth/render dependency, data disclosure, side effect, and realtime transport must be classified as `full`, `excluded`, or `not applicable`, with an evidence path.
- Owner task assignment and assignee filters use a minimal capability-scoped member directory: active assignable members' stable ID, display name, and avatar only. Never expose email, roles, invite state, or unrelated workspace projects.
- Use the owner project components and interactions for all in-scope project surfaces. Do not build a second simplified board/detail/form set for `full` links.
- Let a valid full link holder perform ordinary operations on project objects that are not agent-controlled. Block execution manifests, schedules, runs, execution actions, and task objects/fields that may contain execution envelopes. If the server cannot prove an object is unrelated, fail closed for that object/action.
- Support full-link creation, listing, and revocation from authenticated visibility/share settings. Only authenticated workspace admin/owner with `project:share` may create, list, or revoke `full` links; custom roles keep existing `view`/`edit` link behavior but cannot see full-link rows/URLs or revoke them. Full-link holders cannot manage links. Reveal a full-link URL/token only in the one-time creation response to its authorized creator; full-link list rows return `url: null`.
- Keep the old `/public-project/:id` URL read-only and keep `view` and basic `edit` links unchanged.
- Record every anonymous mutation against the share-link ID/action in the same database transaction as the mutation. UI and activity must label the actor as an unverified share-link holder, never as the owner or a verified person.
- For `full`, the only raw-token exception is the one-time token/URL returned to an authenticated workspace admin/owner when creating that link; full-link listing never re-reveals it. Preserve the existing authenticated URL-list behavior for legacy `view`/`edit` links. Never include a full token in public resource responses, page content, activity, audit metadata, or logs; test both sides of the boundary.
- Full links expire after 30 days by default and can be revoked earlier. Revocation/expiry must deny subsequent data, write, and asset requests.

### Out

- Workspace/account administration, role/member/invite management, authentication/account changes, API keys, secret values, integration setup/management, cross-project task moves/relations, and any access outside the linked project.
- Agent-control manifests, schedules, runs, worker actions, execution data, and edits to any task/field whose relation to agent-control cannot be disproved. A project-level manifest must not be exposed by this capability.
- Full project UI excludes workspace/project switching, cross-project task moves/relations, authenticated task URLs, credential-dependent integration management, workspace Goals, and share-link administration. Excluded controls must be absent, not visible-but-disabled.
- Anonymous comments must never impersonate a user or invoke `maybeSteerActiveRunFromComment`. T1 must classify websocket/activity publication, assignee/mention notifications, and execution steering separately; preserve only ordinary member-facing side effects that can be safely attributed to the share link and rate-limited.
- Changing ordinary `view` or `edit` link power, changing the legacy public URL contract, user impersonation, or anonymous login/account creation.
- Redesigning Kaneo's visual identity or adding a second CSS/component system.

## UX Baseline

| # | Requirement | Pass condition |
|---|---|---|
| 1 | Keyboard | Tab follows visible order; Enter activates/submits; Space toggles controls; Escape closes owner sheets/dialogs and focus returns to the trigger. |
| 2 | Focus | Keyboard `:focus-visible` is clear in light/dark themes; mouse focus does not show a heavy black ring. |
| 3 | Accessibility | Inputs have labels; errors are associated and announced; contrast ≥4.5:1; touch targets ≥44px. |
| 4 | Viewports | 320–1440px has no page-level horizontal overflow or clipped project controls; wide data surfaces scroll internally as owner UI does. |
| 5 | States | Loading, empty, save/success, conflict, network failure, invalid/expired/revoked link, forbidden agent-control object, and upload failure each have an understandable recovery. |
| 6 | Consistency | Reuse current project components and `apps/web/DESIGN.md` tokens; no parallel visual system or duplicated simplified owner components. |
| 7 | Platform | Web behavior, scrolling, selection, and theme follow the incumbent app. |
| 8 | Copy | The creator sees a plain warning that anyone holding the link gets full rights within this project and cannot be reliably identified; the recipient sees no false owner identity. |

## Thuật ngữ

- **Full project capability**: a new bearer link granting the explicitly scoped project operations in this spec; it is not a user account, workspace membership, or owner identity.
- **Owner project surface**: the authenticated board/list/Gantt/backlog/Docs, task sheet/full-page detail, and project-local resource/settings UI. It excludes the global account/workspace shell and data outside the linked project.
- **Agent-controlled object**: a task/resource/field connected to a manifest, run, schedule, execution workflow, or any embedded execution envelope. If that relation is uncertain, treat it as controlled.
- **Capability transport**: an explicit server-authorized request path using the link's scope; it must not synthesize an authenticated `userId` or disable global authentication.

## Assumptions and open questions

- Owner confirmed full-link administration is owner/admin-only: workspace admin/owner with `project:share` may create/list/revoke full links; custom roles retain existing view/edit management but cannot list full-link rows/URLs or revoke them. Full holders cannot manage links. Full-link URLs are one-time creator output only; a full-link list response must not reveal the bearer URL.
- Existing 30-day edit-link TTL is reused for full links; no no-expiry full link is added.
- Owner-approved upload caps: 10 MiB per file, 100 MiB total per full link, and 20 files per task/document/comment; both ticket and finalize requests use the existing share-write rate limit. Allow only `image/apng`, `image/avif`, `image/gif`, `image/heic`, `image/heif`, `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/xml`, and `text/xml`. Reject HTML, SVG, scripts, executables, archives, and other MIME types. Non-image files are served only as downloads; image MIME and actual object size/type are verified at finalize.
- Project deletion, if exposed by the authenticated project UI, remains an owner-equivalent destructive action and must revoke/cascade all project capabilities.
- Full links may be created for a project with agent-control data; per-object restrictions apply at read/action time. The existing project+basic-`edit` creation guard remains unchanged.
- Agent-control boundary is deterministic: if a project has any execution manifest, all task descriptions are hidden and read-only project-wide because they are free text that may contain an envelope. Without a project manifest, a task linked to a run/schedule has its description hidden and all mutations denied. Structural fields remain mutable only for tasks proven absent from every manifest task scope and without a run/schedule. If a task's membership cannot be proven, deny the whole task. T1 must verify these predicates against source; no content heuristic may declare free text safe.
- Task relations/subtasks are available only when both endpoint tasks have `projectId === link.resourceId`; cross-project relation reads and writes fail closed even when both projects share a workspace.
- Approved member-data disclosure: active assignable member ID, display name, and avatar only; no email/role/invite fields.

## Approach

Keep `view`, `edit`, and the legacy public URL as-is. Add a distinct project-only `full` capability so creating the stronger link never upgrades existing recipients. Resolve it as a separate server principal with an explicit action matrix. Each read/write/upload/delete route validates token, project, resource ownership, expiry/revocation, action, and agent-control boundary; no global auth middleware bypass and no fake owner `userId`.

For database-backed writes, commit the mutation and share audit row atomically; if audit persistence fails, the mutation must not commit. For object-storage writes, stage the object so it is not addressable until metadata+audit commit, then clean up the staged object on failure. Emit websocket/notification side effects only after the durable write and with share-link attribution; T1 classifies which existing side effects are safe to preserve.

For the web surface, route a full link into the authenticated project components through a capability-aware data/API adapter. Keep the same project controls and responsive behavior; omit only workspace/account navigation and controls explicitly outside scope. Don't clone the current `ProjectShareReader` into another parallel implementation. Reuse existing business logic only behind explicit capability checks; don't forward a bearer token into an authenticated endpoint that assumes workspace membership.

## Capability Flow

```mermaid
sequenceDiagram
    actor Owner as Chủ dự án
    actor Holder as Người giữ link
    participant Web as Giao diện project
    participant API as Share API
    participant DB as Cơ sở dữ liệu
    participant Store as Object storage
    Owner->>API: Tạo full link (đã đăng nhập + project:share)
    API->>DB: Lưu hash/token mã hoá, project scope, hạn 30 ngày
    API-->>Owner: Trả URL một lần cho người tạo được phép
    Holder->>Web: Mở link không cần đăng nhập
    Web->>API: Đọc hoặc ghi bằng capability
    API->>DB: Kiểm token, scope, action, hạn/revoke, agent boundary
    alt Ghi dữ liệu trong database
        API->>DB: Ghi mutation + audit trong cùng transaction
        DB-->>API: Commit
    else Upload file
        API->>Store: Đưa file vào vùng staging chưa truy cập được
        API->>DB: Ghi metadata + audit cùng transaction
        DB-->>API: Commit rồi mới cho đọc file
    else Bị từ chối hoặc audit lỗi
        API-->>Web: Fail closed; không commit mutation
    end
    API-->>Web: Trả dữ liệu an toàn, không giả danh owner/echo token
```

## Risks

- Anyone holding the URL has all included project powers until 30-day expiry or revocation; an in-flight request may finish before revocation takes effect.
- A missed route/resource check can become an IDOR or global auth bypass; a task description may carry hidden execution data.
- Existing comment handlers assume an authenticated user and include agent-steering, activity, websocket, and notification side effects; they cannot be reused blindly.
- Database mutation followed by a separate audit insert can report failure after data already changed; storage uploads can leave unreferenced objects if their metadata/audit transaction fails.
- Owner UI hooks may assume a real workspace member. Use a capability transport, never a synthetic owner identity.

## User Journey

1. Owner opens project visibility/share settings and chooses `Full project access` separately from view/basic edit.
2. UI states the 30-day lifetime and that anyone holding the URL can perform the listed project-level actions; owner creates and copies the one-time URL.
3. Recipient opens the URL in a private window with no account/cookie and sees the same project work surface as owner, including all in-scope owner controls.
4. Recipient works normally; saves, conflicts, file operations, and forbidden agent-controlled objects report truthful states. Activity identifies the share link, not the owner.
5. Owner returns to share settings, identifies the full link, revokes it; after revocation every project, write, and asset request through it fails closed.

## Task List

### T1 — Inventory owner controls and prove the project/agent boundary

- Files: `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board.tsx`, `docs.tsx`, `task/$taskId_.tsx`, `apps/web/src/components/common/project-layout.tsx`, `apps/web/src/components/board/board-toolbar.tsx`, `apps/web/src/components/task/task-details-sheet.tsx`, `task-details-content.tsx`, `task-properties-sidebar.tsx`, `apps/web/src/hooks/use-project-websocket.ts`, `apps/web/src/components/docs/`, document hooks, `apps/web/src/components/share/`, `apps/api/src/share/`, `apps/api/src/activity/`, `apps/api/src/document/`, `apps/api/src/task-relation/controllers/`, `apps/api/src/asset/content-upload.ts`, `apps/api/src/storage/s3.ts`, `apps/api/src/execution/`, `apps/api/src/database/schema.ts`, `packages/permissions/src/index.ts`.
- Work: build a table in this spec of every owner project control/navigation target, its route/API/hook, auth/render dependency, target resource, data disclosed, current auth requirement, guest transport, side effects, and classification (`full`/`excluded`/`not applicable`), with evidence. Required rows: comment composer gated by `useAuth`; task maximize/full-page and parent-task navigation; assignable-member list/assignee filters; cross-project move; task-link and branch copy; Docs vs workspace Goals; real-time updates; relation/subtask reads and writes; attachment upload/finalize/read; share-link settings; project deletion. Trace agent-control manifest task scope/envelopes. Use only the owner-approved active-member ID/name/avatar fields; never email, role, invite state, or unrelated workspace data. Define a capability-safe WebSocket ticket or a measured refetch fallback (≤10 seconds while visible, plus focus/after-mutation refetch); never mount the authenticated WebSocket with a guest session. Enforce the owner-approved caps and MIME allowlist in Assumptions, including actual object metadata checks at finalize. No implementation until this matrix and agent-control/upload boundaries are proven against source.
- Acceptance: every owner control, route target, identity exposure, side effect, and live-update path is classified; Docs is full; Goals, workspace/project switching, cross-project move, and share-link administration are excluded; task full-page/parent navigation stays inside the share route; both relation endpoints are proven inside the linked project; unknown relation fails closed; no workspace/account/credential/agent-control action is mislabeled as `full`; no guest action is recorded as the owner.
- Reproduce: `pnpm --filter @kaneo/web test` and `pnpm --filter @kaneo/api test` as current-baseline inventory; source-only task adds no code.
- Verify: parent reviews matrix against actual owner routes, hooks, API middleware, and schema. Any feature without a source path stays out until identified.

### T2 — Add the full capability and server-side authorization

- Files: `apps/api/src/share/manage.ts`, `apps/api/src/share/resolve-share-link.ts`, `apps/api/src/share/token.ts`, `apps/api/src/share/index.ts`, `apps/api/src/share/public-write.ts`, `apps/api/src/activity/`, `apps/api/src/document/`, `apps/api/src/task-relation/`, `apps/api/src/asset/content-upload.ts`, `apps/api/src/storage/s3.ts`, relevant project/task/resource controllers, `apps/api/src/database/schema.ts` only if required, `tests/api-integration/share-link-write.test.ts`, `tests/api-integration/public-share.test.ts`.
- Work: add `full` link creation/expiry/revoke support without changing `view`/`edit`; full-link creation remains allowed when the project contains agent-control data, with per-object denials at use time; preserve the existing basic-edit creation guard. Restrict full-link list/revoke as well as creation to owner/admin; never return a full URL from list. Implement explicit per-action authorization for every T1 `full` row; scope every target to the link's project. Relation create/delete/reorder must lock and re-check both endpoint tasks inside the same transaction that mutates the relation. Task deletion must lock/re-check the root `projectId` and every cascade endpoint before delete. Use a dedicated guest-comment path that stores share-link attribution without fake `userId` or agent-run steering; keep safe comments visible after refetch while filtering bot/system activity. Commit each DB mutation and its audit row atomically. Stage external objects until metadata+audit commit; verify actual object size/type plus safe-inline image signature, restrict to T1 MIME/resource matrix, enforce per-link quota and atomically serialized per-resource count caps, and clean staged objects if commit fails. Never expose credentials/execution data.
- Acceptance: no mutation/read crosses project scope, including relation endpoints and delete cascades, even when an owner moves a task concurrently; full-link create/list/revoke is owner/admin-only and list never returns a full URL; ordinary owner routes keep normal auth/RBAC; view/basic edit behavior stays unchanged; full links enforce expiry/revocation/rate-limit/audit; agent-controlled/uncertain objects deny; each in-scope mutation works anonymously; audit failure leaves no DB mutation; staged files stay unaddressable; oversized/disallowed-MIME/signature-mismatch/over-quota/concurrent excessive-count uploads fail; destructive writes retain owner-equivalent confirmation semantics.
- Reproduce: `pnpm --filter @kaneo/api test:integration` and `pnpm --filter @kaneo/api test`.
- Verify: integration matrix for each full action and denial path; test wrong project/task/asset IDs, cross-project relation endpoints and concurrent task moves during relation create/delete/reorder/task deletion, revoked/expired token, view/edit scope, missing token, agent-controlled task/field/description policy, guest-comment actor/side effects, one-time link token response, upload actual-size/MIME/signature/count/per-link quota, and audit-write failure. Existing authenticated RBAC tests remain PASS.

### T3 — Render the same project UI through capability transport

- Files: `apps/web/src/routes/share/$resourceType/$token.tsx`, new share-scoped full-task route, `apps/web/src/components/share/project-share-reader.tsx`, `apps/web/src/components/common/project-layout.tsx`, owner project routes including `docs.tsx` and task full-page route, `apps/web/src/components/board/board-toolbar.tsx`, task details/content/properties, `apps/web/src/hooks/use-project-websocket.ts`, project docs components/hooks, capability fetchers, `apps/web/src/components/share/share-dialog.tsx`, relevant i18n files and web tests.
- Work: add full-link mode in creator settings and route. The shared `/share/project/:token` route must dispatch on the server-returned permission before mounting the full surface; existing `view`/`edit` links continue through `ProjectShareReader`. Reuse owner project components for board/list/Gantt/backlog/Docs, toolbar, task detail, comments, and all T1 in-scope controls; route requests through the capability-aware adapter. Comment composer must render and submit for a full-link holder without `useAuth().user.id`; attribution stays link-scoped and safe comments remain visible after refetch. Add a full-page task route under the same share capability and keep maximize/parent navigation inside that route; never navigate the holder to `/dashboard/...` or another project. Use one capability-aware task-link path builder for sidebar and board/list context-menu copy; guests always receive the share-scoped full-task URL. Hide cross-project move, workspace/project switchers, and excluded controls rather than showing broken/disabled fakes. For real-time updates, never mount the authenticated project WebSocket in guest mode; use a capability ticket or refetch-on-focus plus bounded polling (≤10 seconds while visible), with no auth reconnect loop. Render explicit loading/invalid/revoked/rate-limit/network states and never keep stale capability data visible after authorization fails.
- UX Contract:
  - Surface brief: existing project Operate surface; `apps/web/DESIGN.md` + authenticated board/task-detail components are the visual source of truth. Do not create a new surface brief or visual world.
  - States: normal owner loading/empty/success states; full-link invalid/expired/revoked; save/error/conflict; attachment transfer; denied agent-controlled object. Show guest attribution where owner UI displays an actor; never show the owner as actor.
  - Interaction: same control placement and behavior as owner for every `full` action; no separate edit toggle/basic-form-only mode; all edits persist after refresh. Comment composer renders without a signed-in user. Maximize, parent-task and Docs navigation stay inside the share capability. Cross-project move and workspace/account navigation are absent.
  - Identity: use only active assignable-member ID, display name, and avatar for assignment/filter; no email, role, invite state, or unrelated workspace projects.
  - Freshness: guest updates arrive via the T1-approved capability event or within 10 seconds through visible-tab polling; never run the authenticated WebSocket as a guest.
  - Responsive: same owner layout at 320–1440px; wide boards remain inner-scroll surfaces.
  - Token: use existing `apps/web/DESIGN.md`; no hard-coded alternate share-link styling.
- Skills: `flow`, `impeccable`, `mobile-responsive`.
- Visual Ref: `apps/web/DESIGN.md`, `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board.tsx`, `apps/web/src/components/task/task-details-sheet.tsx`.
- Acceptance: full links use shared owner components and all T1 actions; existing view/edit links retain their current UI/behavior; no login/cookie; no false global/account UI; guest composer is visible, posts, and remains visible after refetch even in manifest projects while bot/non-comment activity stays hidden; Docs CRUD works in project scope; task/parent/Docs navigation and both task-link copy affordances stay capability-scoped; invalid/expired/revoked links show recovery instead of cached/blank content; excluded controls are absent; member directory/assignment uses only active owner/admin/member records; polling meets the 10-second bound without authenticated WebSocket errors.
- Reproduce: `pnpm --filter @kaneo/web test && pnpm --filter @kaneo/web typecheck && pnpm --filter @kaneo/web build`.
- Verify: component/route tests for scope dispatch on the static project path (full vs legacy view/edit), no-auth full-link path, task-sheet removal after revoked-link response, comment composer rendering+submit and manifest-project refetch, full-page/parent-task routes and both task-link copy surfaces, Docs, member-data boundary, denied agent objects, no authenticated WebSocket loop, and unchanged view/edit modes; UI Verify Gate below.

### T4 — End-to-end security, parity, and release readiness

- Files: T1 matrix; tests from T2/T3; `apps/web/src/components/share/` and `tests/api-integration/` as needed.
- Work: test the full capability in a disposable project with normal tasks, project Docs, comments/files, destructive actions, cross-project relation attempts (including a task move interleaved between guest precheck and transaction), and a separate agent-controlled task/object; verify owner and share settings can revoke it.
- Acceptance: all T1 in-scope operations work without login; all excluded operations fail server-side; no other project/account/workspace data is readable or mutable; relation expansion and mutation cannot cross project boundaries; revocation blocks subsequent API and asset requests; no raw token, fake user identity, or execution payload leaks in public resource responses, page content, activity, audit metadata, or logs. The authenticated one-time link-creation response is the only raw-token exception and returns it only to an authorized creator.
- Reproduce: `pnpm --filter @kaneo/api test:integration && pnpm --filter @kaneo/web test && pnpm --filter @kaneo/web typecheck && pnpm --filter @kaneo/web build`.
- Verify: full security matrix, owner-route regression, one-time token exposure boundary, guest comment side-effect matrix, and audit-failure atomicity pass. Production deployment requires a separate guarded release plan and owner UAT; this spec does not authorize deploy.

## T1 Action Matrix (proven against source `a8cb40f3`, 2026-10-23)

Sources: `apps/api/src/share/*` (token/resolve/manage/public-write/index/rate-limit), `apps/api/src/project/controllers/public-project-dto.ts`, `apps/api/src/activity/controllers/create-comment.ts`, `apps/api/src/execution/*` + schema tables, `apps/api/src/asset/content-upload.ts`, `apps/api/src/storage/*`, `apps/api/src/task-relation/controllers/*`, `packages/permissions/src/index.ts`, `apps/api/src/utils/require-workspace-permission.ts`, owner web routes/components (`project-layout.tsx`, `board-toolbar.tsx`, `task-details-sheet/content/properties`, `documents-view.tsx`, `document-workspace.tsx`, `use-project-websocket.ts`, `use-auth`, `share-dialog.tsx`, `project-share-reader.tsx`, `routes/share/$resourceType/$token.tsx`).

### A. Permission model facts (verified)

- `SharePermission` union is `"view" | "edit"` at `resolve-share-link.ts:13`; `linkGrantsPermission` (`:69-75`): `edit` implies `view`, `view` grants nothing. New `full` must extend both the union and this function as `full ⊃ edit ⊃ view`; an `edit`/`view` link must never satisfy a `full` requirement and vice versa.
- Permission is baked into the token AAD (`token.ts:63-68`), so an existing ciphertext cannot be re-used for a different permission — links are never upgraded in place, only new links carry `full`.
- DB column `share_link.permission` is plain text (schema.ts:1633+), no migration needed.
- Link creation first requires `requireWorkspacePermission({ project: ["share"] })` (`manage.ts`): built-in role checks and custom `workspace_role.permission` behavior remain unchanged for ordinary view/edit links. Owner-approved `full` links add a stricter second gate: workspace membership role must be `owner` or `admin`, or the authenticated user must be an instance administrator; a custom role with `project:share` alone cannot mint full capabilities.
- TTL: only `edit` sets 30 days today (`manage.ts:28,212-215`); `full` must set the same 30-day expiry. `view` stays never-expiring.
- Existing agent-control creation guards preserved unchanged: project+`edit` 403 when `isProjectAgentControlled` (`manage.ts:173-181`); `full` creation has NO project-level guard (allowed for agent-controlled projects, per-object denial at use time).
- Audit: `appendShareActionAudit` runs AFTER commit today (`public-write.ts:105,201,249,368,421`) — T2 must move it inside the mutation transaction for every full write (and refactor existing public-write writes to comply with this spec's atomicity requirement).
- Rate limits: `assertShareRateLimit` guards every public `/share/*` route; read 60/min, write 20/min per token hash + per-IP (×10). Upload ticket + finalize use the write scope.
- Mount order is safe: `/share` registered before global auth middleware (`index.ts:229` vs `:500`); `/share-manage` after it (authenticated). Guest full routes must stay in the public router; no new global-auth bypass.

### B. Agent-control boundary (deterministic, proven in schema)

- Legacy `isProjectAgentControlled(projectId)` (`public-project-dto.ts:31-84`) is broader: manifest OR any project task run/schedule, and remains unchanged for `view`/`edit`. Owner-approved `full` boundary is narrower and deterministic: only an `execution_manifest.projectId` hides/makes descriptions read-only project-wide; without a manifest, run/schedule/phase-card tasks are denied whole-object by the task-level predicate below. Full links use their dedicated manifest-only predicate and never infer safety from description text.
- Task-level deny predicate (all four ORs; schema.ts:576-599, 980-999): EXISTS `task_run.taskId` OR EXISTS `execution_schedule.taskId` OR EXISTS `execution_phase_card.fullTaskId` OR EXISTS `execution_phase_card.childTaskId`. Such tasks are omitted from project payloads and full-task reads return generic 404; they are not merely editable-disabled. Helper `getPhaseCardContext` (`phase-progress.ts:103-126`) already exposes full-run/phase-child lookups. Uncertain ⇒ deny whole task.
- Description policy under `full`: if project has a manifest → ALL task descriptions hidden + description writes denied project-wide (free text may embed an envelope; parser `extractWorkerContractState` at `validation.ts:973-999` scans anywhere in text, no safe heuristic exists). Without a manifest → description hidden + mutations denied only for tasks matching the task-level predicate; structural fields (title/status/priority/dates/assignee/labels/subtask structure) stay editable for proven-ordinary tasks; the FULL run task itself has title/description immutable via existing `assertFullRunFieldsImmutable` (`finalization-gate.ts:49-79`) and the whole task is denied for guests anyway.
- Existing execution guards stay active on guest mutations wherever the reused logic runs: `assertFullRunFieldsImmutable`, `assertFinalTaskStatusGate`, `assertTaskMoveExecutionGate`, `phaseCardTaskGuard` (`finalization-gate.ts`, `phase-progress.ts`). Guests additionally never reach execution routes at all (matrix §C).
- Activity exposure: worker bot replies (`[🤖]` markers, steer fallback inserts at `service.ts:3625-3641`) live in the same activity table read by the task timeline. Task-level execution tasks are denied whole-object. On ordinary tasks in a manifest project, expose only human-authored comments and comments attributed to a share link; omit bot/system and all non-comment activity. This preserves comment continuity without exposing execution narrative; task descriptions remain hidden project-wide.

### C. Owner control classification (guest transport = capability fetchers on `/api/share/project/:token/...`)

| # | Owner control / target | Source evidence | Current auth | Data disclosed | Side effects | Classification (`full`) |
|---|---|---|---|---|---|---|
| 1 | Board view (Kanban) + board search Ctrl+F | `board.tsx:110-140`, `project-layout.tsx:148-205` | session + workspace | project payload | none | **full** — read via capability adapter |
| 2 | List view | `board-toolbar.tsx:563-590` | session | project payload | none | **full** |
| 3 | Backlog view + bulk toolbar | `backlog.tsx:209-276,357-560` | session | project payload | bulk mutations | **full** for read/filter/sort/bulk status/priority/archive/delete/assign; bulk cross-project move excluded (row 14) |
| 4 | Gantt view + drag date updates | `gantt.tsx` | session | project payload | task date writes | **full** (subject to agent predicate) |
| 5 | Docs tab: list/create/edit/archive/delete + revision conflict | `docs.tsx:46-51`, `documents-view.tsx:88-160`, `document-workspace.tsx:126-180,385-460` | `task:update`/`task:delete` via `useWorkspacePermission` | project documents | document writes, `deleteOrphanedAssets` | **full** — project-scoped document CRUD; document comments excluded because `document_comment.user_id` is NOT NULL and cannot represent a share-link principal without schema/identity changes |
| 6 | Workspace Goals | `goals-matrix.tsx`, workspace route | session | workspace goals | — | **excluded** — workspace-level resource, absent from guest shell |
| 7 | Task sheet (dialog) + maximize to full page | `task-details-sheet.tsx:60-104` | session | task detail | none | **full** — maximize navigates to the share-scoped task route, never `/dashboard/...` |
| 8 | Task full-page + parent-task navigation + TaskCrumbSelect | `task/$taskId_.tsx:33-60`, `task-layout.tsx:60-85`, `task-details-content.tsx:43-63` | session | task tree | none | **full** — only when the parent/target task `projectId === link.resourceId`; cross-project parent link is denied/absent |
| 9 | Status/priority/start/due popovers, title/description editor, drag & drop, context menu (incl. archive/planned status) | `task-properties-sidebar.tsx:166-268`, `kanban-board/index.tsx:67-178`, `task-card-context-menu-content.tsx:136-304` | `task:update` | task fields | `task.updated`/`task-relation.refresh` events, `deleteOrphanedAssets` | **full** (agent predicate applies; virtual statuses allowed for full links, still denied for basic edit) |
| 10 | Assignee popover + assignee filters | `task-properties-sidebar.tsx:190-230`, `board-toolbar.tsx:250-470`, `useGetActiveWorkspaceUsers` | `task:update` + workspace members API (email/role) | member identity | assignment write | **full** via new capability member-directory endpoint returning ONLY id/displayName/avatarUrl of active assignable members (rows 24-26); assignee filters fed from the same endpoint |
| 11 | Labels: attach/create/delete on a task | `labelTable` unique `(taskId,name)` (schema.ts), `task-labels-popover.tsx:68-69` | `task:update` | label name/color of that task | label writes | **full** — labels are per-task rows scoped by taskId; guest label writes verify the task's project |
| 12 | Comments: composer + activity timeline | `task-details-content.tsx:103` gates composer on `useAuth().user.id`; `comment-input.tsx:24` | `useAuth` + `task:update` | comments, actor name | see §D | **full** — composer renders without auth; guest posts via capability route with link attribution |
| 13 | Subtasks create/delete/reorder/status + relations create/delete | `task-subtasks.tsx:71-298`, `task-relations.tsx:96-224`, `task-relation/controllers/*` | `task:update` | related tasks | relation writes, events | **full** — read expansion and writes verify BOTH endpoint tasks `projectId === link.resourceId`; cross-project or unknown relation fails closed (404) |
| 14 | Cross-project task move (TaskMovePopover) | `task-properties-sidebar.tsx:141-146,232-237`, `task-move-popover.tsx:33-130` | session | other projects list | move write | **excluded** — absent from guest UI; the authenticated move endpoint stays auth-only |
| 15 | Copy task link (sidebar + board/list context menu) | `task-properties-sidebar.tsx:99-105`, `task-card-context-menu-content.tsx` | none (client) | internal URL | none | **full** — both copy affordances use the share-scoped full-task URL for guests |
| 16 | Copy branch (GitHub/Gitea integration) | `task-properties-sidebar.tsx:107-118,160-180` | session + integration creds | integration config | none | **excluded** — credential-dependent, absent |
| 17 | External links accordion | `task-details-content.tsx:71-78` | session | integration data | none | **excluded** — absent |
| 18 | Execution panel / run review | `task-details-content.tsx:69`, `task-execution-panel.tsx:129` | session + execution perms | manifest/run data | steering | **not applicable** — execution surface never rendered for guests; execution API stays authenticated |
| 19 | Attachment upload (description/comment/doc) 2-step ticket+finalize | `content-upload.ts:228-342`, `comment-editor.tsx:88,322-391,419` | `task:update` + workspace | asset rows | S3 presign PUT, asset insert, `asset.created` event | **full** via capability ticket+finalize routes; owner-approved caps + MIME allowlist + actual-object verification + staged cleanup; see §E |
| 20 | Asset read (inline image / download attachment) | `/asset/:id` (index.ts:267-329), share asset route `share/index.ts:355-395` | session or capability ref check | object bytes | none | **full** — extend `canShareReadAsset` for project full links: asset row must belong to the linked project (task description/comment/document surface); non-images served as downloads (`buildAssetResponse`) |
| 21 | Real-time updates | `use-project-websocket.ts:37` gates on `session.user.id`; ws auth `authenticateApiRequest` + `validateWorkspaceAccess` (`index.ts:626+`) | session cookie | live event IDs | none | **excluded (transport)** — guest uses refetch-on-focus + bounded visible-tab polling ≤10s; no capability WS ticket in v1; never mount the authenticated WS. `TASK_RUN_UPDATED` leakage risk moot since no guest stream exists |
| 22 | Share settings (create/list/revoke links) | `share-dialog.tsx`, `settings/.../visibility.tsx:183`, `share-manage` routes | `project:share` + owner/admin gate for `full` | link rows; one-time full URL only on create | link writes | **excluded for holder** — absent from guest UI; full-link list/revoke is owner/admin-only and list never returns a full URL; view/edit management semantics stay unchanged |
| 23 | Project settings: general (rename/delete), visibility (isPublic toggle), integrations, workflow/columns CRUD | `settings/projects/$projectId/*` (`general.tsx:305`, `visibility.tsx:62-92`) | `project:update`/`project:delete`/`project:share` | project fields | project writes | **excluded** — settings surface stays outside the linked work surface; no column CRUD for guests in this iteration (column routes `column/index.ts:40-150` remain auth-only) |
| 24 | Project deletion (owner) | `nav-projects.tsx:226-247`, `general.tsx:305` | `project:delete` | — | cascade delete | **excluded for holder**; T2 adds capability revocation when a project is deleted so links cannot dangle (see §F) |
| 25 | Create project / project switcher / workspace switcher / sidebar | `project-layout.tsx:99-121`, `workspace-switcher.tsx:44-56`, `app-sidebar.tsx` | session | workspace/project lists | none | **excluded** — guest shell omits these; view switcher (row 1-5) is the only retained navigation |
| 26 | Member directory (new) | derived from `workspace_member` + `user` tables; owner UI source `useGetActiveWorkspaceUsers` | session | email/role in owner API | none | **full (new capability read)** — `GET /api/share/project/:token/members` returns active assignable members only: `{ id, name, avatarUrl }`; assignable = workspace member with role owner/admin/member only (viewers and custom roles excluded); never email/role/invite state |
| 27 | Guest comment websockets/notifications (side effects of row 12) | `create-comment.ts:15-121` | authenticated controller | actor name | steering, mentions, assignee notify, ws broadcast | **see §D** |

### D. Guest comment side-effect classification (T1-approved)

Guest comment path is a NEW dedicated controller (no fake `userId`, no reuse of the authenticated `createComment`):

1. INSERT `activity` (`type: "comment"`, `userId: null`, link attribution via new columns/label `externalUserName = "Share link holder"` — schema already has `externalUserName`/`externalSource`, schema.ts:1223-1225) — **KEEP**.
2. Asset binding (`extractAssetIds` → `assetTable.activityId`) — **KEEP** (same transaction as the insert).
3. `publishEvent("comment.created")` → ws broadcast (payload only IDs, project-scoped) — **KEEP** (after durable write).
4. `maybeSteerActiveRunFromComment` — **REMOVE** (spec Out; guest must never steer worker runs; also avoids the `[🤖]` fallback bot reply).
5. Mention notifications (`parseMentionIds` → `createNotification(task_mention)`) — **REMOVE** in v1: email delivery + notification rows are user-facing side effects not safely attributable/rate-bounded per recipient; guest mention markup renders as plain text.
6. Assignee notification (`task_comment`) — **REMOVE** in v1 for the same reason; assignee sees the comment via polling/refresh on the task.
7. `deleteOrphanedAssets` on comment edit/delete — **KEEP** (cleanup only).
8. Comment edit/delete by guest: allowed only on comments created by the same share link (attribution check); existing `assertCommentMutationGuard` stays.

### E. Upload boundary (owner-approved, verified against pipeline)

- Flow stays presign + finalize (2-step), keys `workspace/<wsId>/content/<ownerType>/<ownerId>/...` (private bucket; no DB row ⇒ not addressable through any read route — `GET /asset/:id` and the share asset route both look up `assetTable` first). "Staged not addressable until commit" holds without moving objects: presigned PUT writes the object, but the capability finalize inserts the row + audit atomically, and on failure deletes the staged object via existing `deleteS3Object` (`s3.ts:424-431`).
- New capability routes (write rate limit both): `POST /share/project/:token/asset/upload-ticket` and `POST /share/project/:token/asset/finalize`.
- Caps: ≤10 MiB/file (existing `MAX_IMAGE_UPLOAD_BYTES` semantics), ≤100 MiB total per full link, ≤20 files per resource (task description / task comments / project document each a resource). Count + quota checked at ticket AND re-verified at finalize.
- MIME allowlist exactly as recorded in Assumptions (owner-approved; images from the existing `allowedImageMimeTypes` + listed document types). Reject HTML/SVG/scripts/executables/archives/`application/octet-stream` and everything else. `validateTaskAssetUploadInput` gains the allowlist check (it currently only checks size — verified gap).
- Finalize verifies ACTUAL object metadata (HEAD/GetObject metadata: `ContentLength`, `ContentType`) against declared values + allowlist before insert; safe-inline image MIME must also match actual file-signature bytes, otherwise return 400 and delete the staged object. Non-image files remain download-only.
- Recheck the 20-file resource cap inside the finalization transaction while holding the task/document resource row lock, so concurrent uploads through separate links cannot race past the cap.
- `phaseCardTaskGuard` stays for task-owned uploads; uploads to agent-controlled tasks are denied with the task (§B).

### F. Share-link administration & revocation cascade

- Management remains on `/share-manage/*`, authenticated + `project:share`. `full` is project-only, 30-day TTL, and owner/admin-only for create/list/revoke; custom roles retain existing view/edit operations but cannot see/revoke full rows. The full URL appears only in its authorized create response; full list rows return no URL. Creation guard order: workspace lookup → `project:share` → owner/admin check → insert; no agent-control creation guard for `full`.
- Full-link responses never include the raw token except the one-time create response to an authorized owner/admin; full-link list responses contain no URL/token. Existing view/edit list behavior remains unchanged.
- Revocation by owner → all subsequent data/write/asset requests through the link fail with the generic 404 (existing `resolveShareLink` checks). In-flight requests may complete (accepted risk, unchanged).
- Project deletion: T2 revokes (sets `revokedAt`) all share links whose `resourceType === "project" AND resourceId = projectId` in the delete transaction, because `share_link.resourceId` is polymorphic with no FK — without this, links dangle (reads already fail closed via resource lookup, but revocation is explicit per spec Assumptions).

### G. Realtime decision (recorded)

Polling fallback: refetch on window focus + bounded interval poll ≤10s while `document.visibilityState === "visible"` + refetch after each mutation; no authenticated WebSocket mount, no reconnect loop, no capability WS ticket in v1. Matches UX Contract Freshness; owner may upgrade to a filtered WS ticket later (out of scope).

## Implementation Progress (EP)

- T1 DONE: matrix §A-G proven against source; baseline tests recorded (api 264 unit / web 62).
- T2 DONE (commit 12714b08): full capability server-side; integration 191→194 PASS incl. 19 full-share tests.
- T3 DONE (commit 3433a418): capability transport + owner component parity; web typecheck 0 errors, build PASS, tests 62/62.
- T4 DONE at worker handoff (commit 81978644): initial security matrix tests; worker reports full suite green.
- Production release 2026-10-24: commit `09a9fe89` deployed as fullshare image digest `3108cd3f…`; guarded wave receipt `.wave-fullshare/APPLY-RECEIPT.md`, migration/schema and encrypted backup/R2 mirror PASS.
- Owner UAT 2026-10-25 on production `708d1712` returned NEEDS REVISION: share dialog warning/label, intermittent 400/429, guest drag, mobile headers, and public task modal. Root cause verified: full-share payload used column nanoid where Kanban sends `column.id` as status slug; drag also fanned out per-card writes. First UAT repairs shipped in `708d1712` (column IDs, rate budget/poll recovery, copy/label/mobile fixes); current follow-up adds a single atomic integer-index move endpoint, optimistic rollback/error feedback, null/tie ordering, sort/filter drag guard, 44px controls and docs poll deduplication. This follow-up is not deployed yet.
- Not done by design: final owner UAT after uatfix4 (required before `/verify`/archive); doc comments for guests (schema `document_comment.user_id` NOT NULL — excluded, matrix §C row 5); capability WS ticket (polling fallback per §G).

## Checkpoints

1. T1 matrix and agent-control partition reviewed before any authorization/UI implementation.
2. T2 API tests prove project-boundary, old-scope compatibility, expiry/revoke, and no escalation before enabling the UI.
3. T3 owner-component parity and rendered evidence pass before UAT.
4. T4 security matrix, owner regression, production deploy gate, and owner UAT all pass before `/verify` and archive.

## External Review Brief

Reviewer must decide whether the capability principal is strictly project-scoped; whether every owner project action is classified; whether the auth boundary avoids user impersonation/global bypass; whether uploads/comments/deletes and cross-project references are safe; whether the agent-control partition can miss embedded envelopes; and whether reused owner UI truly has functional parity.

Read first: this spec, `SPEC-2026-10-08-kaneo-workspace-collaboration/SPEC.md` sections on share boundaries and R4, `apps/web/DESIGN.md`, `apps/web/PRODUCT.md`, owner board/task routes, share routes, share API, share token resolver, permission middleware, and execution manifest/task-run schema.

Do not review/reopen: Kaneo's overall visual identity, workspace RBAC for normal signed-in users, the legacy read-only public URL, or unrelated goals/docs behavior except where T1 identifies a project-local control.

## User Test

| Hành động | Kết quả kỳ vọng | Chuẩn nhìn |
|---|---|---|
| Tạo full link, mở trong cửa sổ riêng chưa đăng nhập | Mở đúng project, dùng được các chế độ và toolbar như owner | Project surface là owner UI, không phải board guest giản lược |
| Sửa task, assignee/label/date/description, comment và file | Thay đổi lưu và còn sau refresh | Control và feedback khớp owner; actor hiển thị qua share link |
| Mở Docs, tạo/sửa/xóa tài liệu và quay lại board | Tài liệu thuộc đúng project và thay đổi được giữ | Docs tab cùng hệ UI; không nhảy sang dashboard/login |
| Mở task full-page, đi parent/subtask, dùng copy-task-link | Link luôn mở cùng full-share capability | Không URL `/dashboard`; không nhảy ra project khác |
| Thử thao tác phá huỷ trong project | Hành động owner-equivalent chạy sau cùng confirm phù hợp | Cùng vị trí/confirmation pattern owner |
| Mở task agent-controlled/field có execution envelope | Nội dung nhạy cảm bị ẩn; action bị từ chối rõ ràng | Không lộ manifest/run data; task thường vẫn dùng được theo ma trận |
| Mở lại link `view`/`edit` đã có trước feature | View giữ read-only; edit giữ basic task form | Không bị full UI chiếm route |
| Owner thu hồi link rồi refresh trang và mở asset cũ | Link không đọc/sửa được nữa | Thông báo link đã hết hiệu lực, không lộ data cũ |

5 câu Y/N:
1. Project surface có cùng controls/chế độ với owner và dùng được không?
2. Thao tác chính có lưu thật qua refresh mà không đăng nhập không?
3. Comments/activity nói rõ đây là người giữ link, không gán nhầm owner không?
4. Task/field agent-controlled bị chặn nhưng task thường trong cùng project vẫn làm được không?
5. Thu hồi link có chặn được cả API lẫn file cũ không?

## Completion Gates

- T1 action matrix complete and reviewed; no unclassified owner control is claimed as full.
- T2 server-side authorization, old view/edit compatibility, revocation/expiry, rate-limit, atomic mutation+audit behavior, one-time token exposure boundary, project-IDOR, asset, guest-comment side effects, and agent-control isolation tests pass.
- T3 same owner project components provide all in-scope actions; user can complete the project workflow with no login; visual evidence at 1280×800 and 375×812 plus overflow check at 320/375/768/1280.
- T4 full suite, owner regression, `/verify`, production release gate, and explicit owner UAT PASS.
- Archive only after all gates pass; no deployment is implied by spec approval.
