---
artifact_type: "completed-spec"
spec_id: "SPEC-2026-11-25-kaneo-ui-agent-binding"
status: "archived"
title: "Kaneo UI Agent Binding — gắn session Pi vào card trực tiếp từ UI (SPEC-2026-11-25)"
archived_at: "2026-11-26T11:41:55+07:00"
source_file: "SPEC-2026-11-25-kaneo-ui-agent-binding.md"
source_sha256: "6d9d52cf33673805a9c264b0f6e1e6e8a71cac03b235cb794318ec7b4f980d37"
implementation_ref: "d061f21aa8e40122cda135079d35c60346434d0a"
working_tree: "dirty"
related_paths: ["apps/api/src/agent-session", "apps/web/src/components/task", "apps/web/src/hooks", "apps/web/src/fetchers/agent-session", "tests/api-integration", ".wave-ui-agent-binding-r1"]
---

# Spec: Kaneo UI Agent Binding — gắn session Pi vào card trực tiếp từ UI (SPEC-2026-11-25)

## Context Snapshot

- **Owner decision (2026-11-25):** thêm đường gán session Pi ↔ card Kaneo trực tiếp từ card detail (control "Agents"), song song với đường `/kaneo-card` hiện tại. Ràng buộc cứng: khi không gán, card phải nhìn bình thường hoàn toàn — không rác UI.
- **Đã đánh giá 3 model (GLM-5.3-Flash, Luna/GPT-6, Sonnet-4-6 thay Opus do provider capacity chết 2 lần) + parent analysis: consensus 4/4** — discovery = extension self-registration (Option A), UI = sidebar block 3-state, bind/unbind UI đi đúng endpoint `/kaneo-card` dùng. LiX gateway (Option B) bị loại: pair token cá nhân 1-client-per-pairing memory-only, tailnet-only WSS, không có server-to-server credential. Đọc session files trực tiếp (C) loại: ProDesk không thấy filesystem laptop.
- **Verified facts:** `agentSessionBinding` có generation CAS + 1-active-binding-per-task; bind/unbind/heartbeat API sẵn (`POST /api/agent-session/bindings`, `DELETE .../bindings/:id?sessionId=&generation=`, `POST .../heartbeat`); extension heartbeat + delivery poller CHỈ chạy khi bound (`card-binding.ts:149 if (!this.binding) return`); hành vi revoke/clean đã verify production (card #239 xoá → session dừng sạch); web đã có `task-agent-binding-status` ("Pi đang kết nối · Máy: pi-laptop") khi bound; `heartbeatAgentSessionBinding` dùng `loadOwnedBinding(userId, bindingId, sessionId, generation)` — model cho ownership guard.
- **Gap đã biết:** session UNBOUND hiện không có loop nào → không tự biết bị gán từ ngoài. Đây là mảnh phải build.
- **Kaneo Actions (GH) đang disabled server-side** — không ảnh hưởng feature này (deploy qua ProDesk buildx).
- **Rebind semantics hiện hành [verified GLM-review]:** `bindAgentSession` trong 1 transaction đã revoke binding cũ match theo taskId OR sessionId + fence deliveries (queued→stale) trước khi insert → "Đổi session" = 1 POST duy nhất, atomic.
- **Review round 1 [2026-11-25]:** Opus APPROVED (2×P3); Luna + GLM + GLM-UIUX NEEDS REVISION — toàn bộ findings đã vá trong bản này (chi tiết: adoption response full-shape + savedKaneoMode, ownership guard scope theo caller type, presence UPSERT khi heartbeat, roster eager-fetch-once khi unbound, mount TaskPropertiesSidebar cả 2 variant, pattern ui/popover + ui/alert-dialog, pixel-identical = screenshot diff, pending-state điều kiện chốt).
- **Ảnh tham khảo UI:** `D:\pcloud\workspace\obsidian\archive\images\20261125184604.png` (modal), `20261125184624.png` (full page + sidebar), `20261125185208.png` (li.quoc.app host picker pattern).

## Objective

Workspace member/owner gắn (và bỏ gắn) một session Pi đang sống vào một card Kaneo ngay trên card detail, mà không cần mở session gõ `/kaneo-card`. Session được gán tự phát hiện binding, sync card, chạy delivery loop như đường TUI. Khi không có gán nào, card render pixel-identical với hiện tại.

## Scope

### In
1. Presence/roster: bảng + announce endpoint + roster read endpoint + TTL lifecycle.
2. Extension kaneo-mcp: unbound announce loop (dual-purpose presence + inbound-bind discovery) + adopt-binding-from-announce.
3. Web: component Agents 3-state (S0/S1/S2) render ở task detail full page + modal, popover picker group theo host, search client-side, confirm rebind, block offline session.
4. i18n đầy đủ 13 ngôn ngữ.
5. Ownership guard cho bind-from-UI.

### Out (later — không làm trong spec này)
- Busy-guard session mid-task (chỉ hiển thị dấu hiệu last-seen, không chặn theo "đang bận").
- WSS push realtime thay poll.
- Badge board-level cho card bound; lịch sử gán vào activity feed.
- Deep-link mở session trong LiX; tạo session mới từ card.
- Multi-agent per card (giữ 1 active binding per task).
- Deploy production + pins (wave riêng sau UAT, theo runbook guarded hiện hành).

## Architecture & Decisions

### D1 — Presence = extension self-registration (Option A)
- Bảng mới `agent_session_presence` (migration `0057_agent_session_presence`):
  - `session_id` text PK; `agent_principal_id` text not null; `host` text not null; `title` text not null default ''; `cwd` text not null default ''; `model` text not null default ''; `first_seen_at`, `last_seen_at` timestamptz not null default now().
  - KHÔNG FK tới tasks. Index `last_seen_at` cho TTL filter. Migration hiện có đến `0056`; next = `0057` (đếm chính xác lúc implement, không hard-code con số trong acceptance).
- TTL live = `last_seen_at >= now() - interval '5 minutes'`. Cleanup lazy: mọi read filter TTL; sweep xoá row `last_seen_at < now() - interval '7 days'` chạy trong announce handler (xác suất thấp, ví dụ ~2% call) — không cần cron mới.

### D2 — Announce loop dual-purpose (extension, chỉ khi unbound)
- **Tick 0 chạy NGAY khi extension start** (không đợi interval đầu); các tick sau `90s ± jitter 15s`, timer `unref`, `announceBusy` guard chống chồng (pattern heartbeat sẵn có).
- 1 call: `POST /api/agent-session/sessions/announce` body `{sessionId, agentPrincipalId, host, title, cwd, model}` → response `{binding: <full presentBinding shape> | null}` — full shape như POST /bindings trả về (bindingId, taskId, projectId, sessionId, hostId, status, bindingGeneration, revision) CỘNG `taskTitle` + `taskNumber`, đủ để persist `PersistedCardBinding` (validator check 9 field: taskId, projectId, bindingId, bindingGeneration, hostId, sessionId, savedKaneoMode, boundAt, version — trong đó `boundAt` = `new Date().toISOString()` client-side và `version` = 1 do extension tự điền, mirror `bind()`; `savedKaneoMode` derive theo trên).
- Response `binding != null` và khác local state → **adopt**: derive `savedKaneoMode` từ active tools hiện tại TRƯỚC khi set binding (mirror `bind()` — capture trước khi `applyToolSet` đổi toolset), rồi set persisted binding state, `applyToolSet()`, inject system message "Kaneo card <task> được gán từ Kaneo UI — đã đồng bộ", start heartbeat + delivery poller, dừng announce loop.
- Khi bound: announce loop KHÔNG chạy; presence do `heartbeatAgentSessionBinding` piggyback — **UPSERT `ON CONFLICT (session_id)`** (không phải update-only): session restore/resume-bound không bao giờ announce nên chưa chắc có row; server tự điền principal/host từ binding row; title/cwd/model dùng **COALESCE** — giữ giá trị hiện có khi announce đã populate, chỉ fill khi thiếu (UPSERT literal `SET title=excluded.title` sẽ clobber thành '' vì announce đã dừng khi bound). 0 request thêm từ extension.
- Session exit → process chết → TTL tự rơi khỏi roster. Không ghost loop (timer unref).
- Announce lỗi network/404 → fail-open: bỏ qua, retry chu kỳ sau; 3 fail liên tiếp → backoff 5 phút, không log spam (chi tiết T2).

### D3 — Bind/unbind UI đi đúng endpoint của `/kaneo-card` (một đường ghi)
- UI gọi `POST /api/agent-session/bindings` + `DELETE /api/agent-session/bindings/:id?sessionId=&generation=` — KHÔNG tạo route bind mới. Invariant generation CAS + 1-active-per-task + advisory locks sống ở một chỗ (đã có).
- Rebind (session đang bound card khác): server move-binding theo semantic hiện hành (unbind cũ + bind mới, generation mới). UI confirm trước: "Session đang gắn card X — chuyển sang đây?".
- **Ownership guard (mới, bắt buộc) — scope theo caller type:**
  - Caller **web/session-cookie** (`!requestActorIsAgent(c)`): `sessionId` phải có presence row của đúng `agentPrincipalId` thuộc user, trong grace 2×TTL. Route preflight chỉ để trả lỗi sớm; invariant bắt buộc được kiểm tra lại **bên trong bind transaction**, sau session advisory lock và trước revoke/insert.
  - Trong transaction, web caller không được revoke active binding cùng `sessionId` nếu principal sở hữu binding thuộc user khác; đây phải là invariant của service, không chỉ check-then-act ở route.
  - Announce check-owner + UPSERT phải atomic dưới cùng session lock `session:<sessionId>`; heartbeat UPSERT cũng lấy session lock TRƯỚC task/binding row locks (lock order session→task→binding), tránh announce cross-account race mà không tạo deadlock.
  - Caller **API-key/extension** (`requestActorIsAgent(c)`): KHÔNG đổi — bind không cần presence row (bảo vệ cold-start `/kaneo-card`: session mới tick-0 chưa kịp announce vẫn bind được như hiện tại). Pre-existing trust behavior không mở rộng thêm.
- Roster là advisory: response bind/roster luôn trả trạng thái thật từ server; client không tự merge.

### D4 — UI: block "Agents" 3-state trong properties
- Vị trí: sidebar "Thuộc tính" full page (dưới block Nhãn) + cùng component render tại khu properties của modal. Không thêm icon toolbar, không đụng board card.
- **S0** (unbound + roster rỗng): không render gì — pixel-identical.
- **S1** (unbound + roster ≥1): 1 ghost Button cùng hệ property rows hiện có (`h-7 px-1.5 gap-1.5 w-full`, hover accent, chevron › affordance — KHÔNG phải static text): `Gán agent · N đang chạy ›`. Click → popover theo pattern `ui/popover` (WorkMarkerPicker): group theo host (`pi-laptop` / `prodesk-home` — pattern host picker li.quoc.app), mỗi dòng: dot last-seen + title (truncate ellipsis + tooltip dùng được cả focus) + host badge + model, secondary line cwd/project; session offline (quá TTL) không render; chọn → bind. Search box client-side hiện khi ≥8 dòng — lọc theo title + host + cwd; trùng title phân biệt bằng host badge + cwd suffix. Popover states phụ: loading = spinner row; lỗi = 1 dòng muted + nút thử lại; rỗng lúc mở (stale cache nói có) = 1 dòng "Không có session nào đang chạy" (không auto-close sột mí).
- **S2** (bound): block đầy đủ — dot trạng thái dùng field `online` từ hook binding-status (server-computed; KHÔNG đọc lastHeartbeatAt client-side) + title + host + model; actions "Gỡ" và "Đổi session" visible khi focus/tap (không hover-only — touch + keyboard accessible, focus cue rõ). Title dài truncate + tooltip, không wrap. Session chết (online=false) → dot xám "mất kết nối", block vẫn hiện, vẫn gỡ được.
- **Đổi session = 1 POST bind duy nhất** — server swap atomic (revoke cũ + insert mới + fence deliveries trong 1 transaction, semantic hiện hành đã verified). UI KHÔNG làm DELETE-then-POST.
- State trung gian sau bind: `đã gán · đang chờ session nhận` → **connected** khi binding-status trả `bound && online` với generation mới; → **mất kết nối** nếu offline kéo dài quá 2×TTL (~10 phút) — hiện trạng thái mất kết nối + vẫn cho Gỡ/Đổi. Không dùng heartbeat của generation cũ làm tín hiệu connected.
- **Cross-project session:** CHO PHÉP bind (binding scope là task; Kaneo project không map được cwd nên KHÔNG claim auto-detect khác project). Dòng session trong picker + confirm LUÔN hiển thị cwd + model + host của session target để user tự nhận diện context; confirm rebind nêu rõ card + task mà session đang giữ.
- Mutation error feedback: bind/unbind fail (network/500) → toast lỗi theo pattern hiện hành của codebase + state không đổi, không pop-in im lặng.
- Fetch model roster: khi `!bound` → **fetch 1 lần eager on mount** (staleTime ~60s, refetchOnWindowFocus, KHÔNG refetchInterval — không poll nền) để quyết S0/S1 + count N; popover mở → refetch nếu stale. Khi bound → chỉ fetch khi mở popover "Đổi session".
- Dòng indicator hiện có dưới title ("Pi đang kết nối · Máy: X") giữ nguyên — **non-interactive** (`role="status"`, không onClick) — control duy nhất ở block Agents. Không đổi format, không thêm.
- **Mount points [verified GLM-UIUX]:** component duy nhất mount trong `TaskPropertiesSidebar` — file có 2 layout variant (mobile `lg:hidden` hàng ngang + desktop `hidden lg:block` cột dọc), modal reuse component này qua `task-details-sheet`. Panel render ở **CẢ 2 variant**: desktop = block dọc sau Nhãn; mobile/<lg = 1 row full-width dưới hàng properties ngang (S0 vẫn không render gì nên mobile unbound vẫn sạch).
- Confirm rebind/unbind dùng `ui/alert-dialog` (pattern hiện hành task-card/backlog): confirm nêu đầy đủ mọi binding bị ảnh hưởng (card + project của session target), KHÔNG xếp nối tiếp nhiều confirm.

### D5 — Latency & feedback
- Loop 90s: user bind từ UI → server truth flip ngay (UI hiện S2 + "đang chờ session nhận"), session thấy trong ≤1 chu kỳ (~90s). Không xuống <30s (wake laptop spam), không lên >120s (cảm giác chết).

## Tasks

### T1 — API presence + roster + ownership guard (kaneo repo, wave 1)
- Migration `0057_agent_session_presence` (bảng theo D1; mọi migration hiện có đến `0056` intact).
- `POST /api/agent-session/sessions/announce` — auth agent-session chuẩn; trong transaction lấy advisory lock `session:<sessionId>`, kiểm principal-owner rồi UPSERT presence, đảm bảo hai account announce cùng sessionId không thể check-then-overwrite; conflict cross-account → 409, không đổi owner. `agentPrincipalId` không thuộc user → 403 qua `getOwnedAgentPrincipal`; lazy sweep với cơ chế xác định; response `{binding: full presentBinding shape + taskTitle + taskNumber | null}`.
- `GET /api/agent-session/sessions/roster` — live rows TTL-filtered, JOIN active binding (taskId + **taskTitle + taskNumber** cho confirm rebind), mỗi row kèm `agentPrincipalId` (UI bind cần điền body POST /bindings), chỉ rows của principals thuộc user; sort host rồi lastSeenAt desc.
- `bindAgentSession`: nhận caller-kind; sau session advisory lock, web caller recheck presence cùng `sessionId` + `agentPrincipalId` + principal owner/grace, và recheck active session binding owner ngay trong transaction trước mọi revoke; API-key/extension giữ cold-start path.
- `heartbeatAgentSessionBinding`: lấy session advisory lock trước task/binding row locks, rồi piggyback presence theo D2 — UPSERT `ON CONFLICT (session_id)` (session restore-bound không announce vẫn có row), server điền principal/host từ binding row.
- Tests: `tests/api-integration/agent-session-presence.test.ts` — announce upsert + TTL expiry + roster group/filter + bind guard (web caller session lạ → block; có presence → pass; API-key caller không cần presence) + announce principal lạ → 403 + heartbeat piggyback UPSERT + sweep. Thêm concurrency/barrier tests: (a) hai account announce đồng thời cùng sessionId → tối đa một owner, request còn lại 409; (b) binding cross-account commit sau route preflight nhưng trước bind transaction → web bind bị chặn trong service, binding cũ không bị revoke.
- Acceptance:
  - [ ] Announce 2 lần → 1 row, `sessionId` đúng; test chủ động làm cũ `last_seen_at` lần 1 rồi xác nhận lần 2 tăng timestamp (không chỉ assert timestamp gần hiện tại); response binding full shape đủ persist PersistedCardBinding 9 field (kể cả boundAt + version client-side).
  - [ ] Roster chỉ trả rows TTL-live của user; offline row không xuất hiện; bound session có kèm taskTitle + taskNumber.
  - [ ] Bind web-caller với sessionId không có presence (khác principal) → bị chặn; có presence → pass; bind API-key caller không bị guard chặn.
  - [ ] Announce với agentPrincipalId không thuộc user → 403; hai account announce đồng thời cùng sessionId không takeover được presence.
  - [ ] Web bind recheck principal-owner bên trong transaction sau session lock; mô phỏng race sau route preflight không revoke binding cross-account.
  - [ ] Heartbeat khi bound UPSERT presence (kể cả session chưa từng announce — restore/resume case) và dùng cùng lock order session→task→binding.
  - [ ] Migration 0057 upgrade sạch; rollback tương đương drop index + bảng được ghi trong deploy receipt, mọi migration hiện có intact (repo không dùng file down-migration riêng).
- Verify: `pnpm --filter @kaneo/api vitest run tests/api-integration/agent-session-presence.test.ts` + `pnpm --filter @kaneo/api build` + `tsc`.

### T2 — Extension announce loop + adopt binding (python repo, wave 1 sau T1 deploy staging hoặc cùng PR)
- `card-binding.ts`: thêm `startUnboundAnnounce()` — tick 0 chạy ngay khi start, các tick 90s±15s jitter, unref, busy-guard; body announce theo D2; adopt path: derive `savedKaneoMode` từ active tools TRƯỚC khi set binding (mirror `bind()`), persist full shape từ response, inject system message; dừng loop khi bound; restart loop khi revoke/unbound (stale path `clearStaleBinding`).
- Announce lỗi network/404 (API cũ chưa có route) → fail-open: bỏ qua, retry chu kỳ sau, không log spam (backoff đơn giản sau 3 fail liên tiếp → 5 phút).
- Tests: `card-binding-announce.test.ts` — adopt binding từ full-shape response (persist đủ 9 field hợp lệ + savedKaneoMode đúng + heartbeat/poller bật + message inject), fail-open khi 404/500, loop dừng khi bound, timer unref, tick 0 chạy ngay khi start.
- Acceptance:
  - [ ] Session unbound + API trả binding → session bound đúng (persist hợp lệ, không mất binding khi resume), tools hiện, poller chạy, message hiện ≤1 chu kỳ.
  - [ ] API 404 (chưa deploy) → không crash, không spam, retry im lặng + backoff.
  - [ ] Revoke từ server → announce loop quay lại, session dừng sạch (hành vi hiện tại giữ nguyên).
  - [ ] Không đổi hành vi nào của `/kaneo-card` hiện tại (test suite cũ 99/99 vẫn pass).
- Verify: `node --experimental-strip-types --experimental-transform-types --test *.test.ts` (99 cũ + mới, 0 fail) + tsc card files sạch (chỉ còn 2 diagnostic pre-existing execution-runtime duplicate-reason).

### T3 — Web Agents panel (kaneo repo, wave 1 sau T1)
- Component `task-agent-binding-panel.tsx` 3 state theo D4 + hook `use-agent-session-roster` (eager-fetch-once khi !bound: staleTime ~60s, không poll; popover mở → refetch stale) + mutations bind/unbind (endpoint chung, guard theo D3) + confirm flows (`ui/alert-dialog`: rebind, unbind) + state "đang chờ session nhận" với điều kiện connected/failed theo D4 (reuse `use-get-task-binding-status`, dùng field `online`).
- Render trong `TaskPropertiesSidebar` CẢ 2 variant (desktop `hidden lg:block` block dọc sau Nhãn; mobile `lg:hidden` 1 row full-width dưới hàng ngang properties); modal reuse cùng component qua `task-details-sheet`. Đổi session = 1 POST bind. Popover theo pattern `ui/popover` (WorkMarkerPicker); truncate + tooltip (cả focus) title; group theo host; search ≥8 dòng; offline session không render; popover loading/error/empty states theo D4.
- i18n 13 files (key mới, không đổi key cũ; `pnpm i18n:check` pass).
- Tests: component test 3 state + confirm rebind (`ui/alert-dialog`) + offline không render + pending-state transitions (connected/failed) + render cả 2 variant sidebar + i18n snapshot; theo pattern `task-agent-binding-status.test.tsx` / `send-comment-to-pi-action.test.tsx`.
- Acceptance:
  - [ ] S0: không render node nào (assert container rỗng) khi unbound + roster rỗng — cả 2 variant.
  - [ ] S0/S1 quyết được từ eager-fetch-once (không poll nền); S1 ghost button hệ `h-7` + chevron, không phải static text.
  - [ ] S1: popover group đúng 2 host (pattern ui/popover); search lọc client-side theo title/host/cwd; offline không có trong list; loading/error/empty states đúng D4.
  - [ ] S2: block đủ title/host/model/dot (`online` field); actions Gỡ/Đổi accessible focus/tap; unbind confirm; đổi session = 1 POST (không DELETE-then-POST); bind offline bị chặn.
  - [ ] Rebind/unbind confirm (`ui/alert-dialog`) MỘT lần duy nhất, bắt buộc hiển thị taskTitle + taskNumber của card bị ảnh hưởng + cwd/model/host của session target (không chỉ taskId thô).
  - [ ] "Đang chờ session nhận" → connected khi `bound && online` generation mới; → mất kết nối sau 2×TTL offline.
  - [ ] Indicator dưới title non-interactive (không onClick).
  - [ ] Card unbound render không đổi: screenshot diff trước/sau (modal + full page, cùng viewport) — không chỉ container assert.
- Verify: `pnpm --filter @kaneo/web vitest run` + `pnpm i18n:check` + `pnpm --filter @kaneo/web build`.

### T4 — UAT live + deploy readiness (sau T1–T3, wave riêng có owner approval)
- UAT trên throwaway card (pattern established: tạo card thật qua UI, xoá sau): (a) bind từ UI vào session laptop idle → session adopt ≤90s, sync card; (b) unbind từ UI → session dừng sạch; (c) bind từ UI session trên ProDesk (spawn qua schedule) → roster hiện, adopt OK; (d) đua: `/kaneo-card` card A trong session + bind UI card B gần đồng thời → đúng 1 winner, UI + session hội tụ; (e) session đóng process → mất khỏi roster ≤5 phút; (f) card unbound screenshot diff trước/sau (modal + full page, cùng viewport) — pixel-identical; (g) session resume đã-bound (không announce) → vẫn hiện trong picker "Đổi session" (heartbeat UPSERT) + still online; (h) bind session cwd khác project card → cho phép + confirm/cwd hiển thị rõ; (i) session mới start cold → `/kaneo-card` ngay không bị guard chặn.
- Deploy theo runbook guarded hiện hành (API trước extension — announce 404 được extension fail-open nên thứ tự an toàn cả 2 chiều; extension sync D→C cả laptop + prodesk qua parity lane).
- Acceptance: 6 kịch bản UAT PASS + receipts; production pins/receipts theo template `.wave-*` (wave riêng).
- Verify: receipts + screenshots + card comments (pattern UAT child-activity r1).

## Risks

- **Bind-from-UI vào session đang mid-turn:** message inject bị queue tới khi idle; poller vẫn bật. Đã chấp nhận (session Pi queue steering). Later: busy-guard.
- **Roster spoofing:** announce yêu cầu auth user; `agentPrincipalId` lạ → 403 qua `getOwnedAgentPrincipal`; kaneo tự host 1 user — nguy cơ thấp; guard D3 (web-caller) chặn bind session ngoài presence; API-key caller không đổi (cold-start an toàn).
- **Announce loop wake laptop:** 90s quá dài để giữ wake; laptop sleep → process dừng → TTL rơi khỏi roster — hành vi đúng (session ngủ không bind được).
- **Migration 0057:** bảng mới thuần, không đụng bảng cũ — rủi ro thấp; verify head hash như mọi wave.

## External Review Brief

- Reviewer lens cần: **architect** (invariant 2 đường bind, generation CAS, ownership guard có đủ không), **flow** (S0/S1/S2, popover, confirm không phiền), **security** (announce auth surface mới có mở rộng attack surface không), **deploy** (thứ tự API↔extension, fail-open có đủ không).
- Câu hỏi mở cho reviewer: (1) ownership guard D3 có cần chặt hơn (ví dụ bind phải kèm challenge session phải trả lời)? (2) TTL 5 phút + loop 90s có hợp lý cho mạng tailnet hay cần hysteresis? (3) Có case nào 2 đường bind sinh binding mồ côi dù CAS không?
- Chỉ review, không implement. Kiểm Context Snapshot + facts verified ở trên trước khi phán.

## T4 UAT receipts (local stack, 2026-11-26)

- Environment: laptop docker postgres 15432 (migration head 0057 `e03ce7c2…`), API dev :1337 (HEAD d9975628), web dev :5173 (HEAD) + :5174 (pre-feature baseline 90bc84b4), extension synced D→C laptop + ProDesk (`card-binding-announce` suite 14/14 trên ProDesk).
- (a) UI bind laptop session → adopt + heartbeat ≤1 announce cycle, `online:true`, UI dot xanh. (b) UI unbind → binding `revoked/unbound`, heartbeat dừng, UI về S1. (c) ProDesk tmux session (endpoint qua tailnet `100.108.110.22:1337`) → roster host `prodesk` → UI bind → adopt + connected. (d) `/kaneo-card` #4 vs UI bind #3 cùng session → 1 winner (gen CAS, loser `rebound`), UI + session hội tụ card #3. (e) process kill → roster TTL-empty đúng 5 phút, binding giữ `online:false`. (f) card unbound S0: Agents-capable region modal (x386-1280, y40-108) và full-page top strip pixel-identical (0 px khác) giữa HEAD và 90bc84b4; khác biệt còn lại là timestamp/state động ngoài feature (git diff chỉ 8 files agent-session/panel). (g) resume cùng session file → re-adopt + heartbeat UPSERT + session hiện trong picker Đổi session. (h) session cwd khác project → bind cho phép, cwd hiển thị trong picker row, rebind 1 POST (loser `rebound`). (i) session lạnh → `/kaneo-card` ngay: bind gen 1, 13 card tools active, không bị web-ownership guard chặn.
- P2 phát hiện runtime: change-session popover (S2) thiếu refetch-when-stale → empty state dù server TTL-live — đã vá `d9975628` + focused tests 28/28.
- Screenshots: `%TEMP%/kaneo-t4/` (f-before-modal-unbound, a-after-bound-connected, b-unbind-confirm, d-race-card-b-bound, c-prodesk-bound-connected, f-head/base-modal-full-s0, diff-mask-*).

## Gates

- [x] spec-check PASS
- [x] External review APPROVED (owner duyệt trước implement)
- [x] T1–T3 tests + builds PASS
- [x] T4 UAT 9/9 PASS + deploy production PASS (owner duyệt 2026-11-26; image be955119, migration 0057 live; receipts .wave-ui-agent-binding-r1/APPLY-RECEIPT.md)
