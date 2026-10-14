# Surface brief — Project Docs

Route: `src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/docs.tsx` (+ public reader `public-project.$projectId` family for shared documents).
Sources: user sketch hierarchy in `plans/ui-reviews/kaneo-workspace/pre-lock.md`; incumbent refs `board.tsx`/`gantt.tsx` (same directory), `task-description.tsx`, `comment-editor.tsx`.

## Journey

1. Member opens project → Docs entry in desktop project nav and mobile project menu.
2. Docs view: flat list of document titles + updated time; one direct "New document" action; opening a doc goes straight to the editor (no intermediate screen).
3. Editor: title + Tiptap Markdown body; save states inline (`Đang lưu` / `Đã lưu` / `Lỗi`); stale-revision save shows a conflict choice (reload or copy my draft) — never silent overwrite.
4. Member comments in a sidebar/section below the document; comments are account-attributed.
5. Share dialog: create view/edit link scoped to this document, copy inline, revoke.
6. External reader (public page or agent): title + rendered Markdown, no login chrome; agents fetch raw `text/markdown`.

## First viewport

Doc list (authenticated): page header with project name + "New document" button, then the flat document list. Reader (public): document title + content at reading max-width, updated time, no app chrome.

## Signature interactions

- Inline save-state text that flips to conflict state with two explicit actions (Reload / Copy draft).
- Copy-link gives an inline "Đã sao chép" confirmation at the button, not a toast.
- Empty state: one direct create action.

## States

Loading (skeleton), empty (create CTA), error (retry), saving/saved, conflict (reload or copy draft), revoked/expired link (explain + ask owner for a new link).
