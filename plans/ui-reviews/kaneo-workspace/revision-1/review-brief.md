# Kaneo workspace collaboration — UAT revision 1

- Product/surface: authenticated Kaneo workspace, project Docs and workspace Goals; this is an Operate surface, not a landing page.
- Target user: workspace owner and collaborators who capture project knowledge and recurring daily progress.
- Job: write Markdown docs and comments; share a scoped link; review/restore archived docs; tick goals, add notes for any date, and understand the all-time total.
- Success: saved content survives reload/navigation; comments sit at the lower edge of the editor viewport; archived docs are recoverable; share link is easy to copy; goal notes are discoverable by direct date selection and history; save state is visible; all-time total stays distinct from the currently viewed week.
- Revision: `4ef440e7` was already live; this revision repairs owner UAT findings and configures 60-day sessions.
- Constraints: preserve Kaneo's existing calm utility UI; remove only the exact noisy copy reported by owner; keep capability tokens one-time/hash-only; never turn note-only rows into completed check-ins; keep project public-URL behavior distinct from scoped capability links.
- `docs-editor-desktop.png`: full-page Docs editor with a persisted test document and the comments section below the larger editor.
- `docs-editor-mobile.png`: same Docs editor at 375px with a long title, visible ellipsis, and reflowed touch controls.
- `goal-notes-desktop.png`: Goals details sheet with date navigation and note history.
- `goal-notes-mobile.png`: same note sheet at 375px, with a native date input and a saved note visible in history.
- `share-dialog-desktop.png`: scoped-share dialog after link creation, showing the one-time URL and copy control.

Review mode: implementation-aware for visible layout/copy/flow only. Treat screenshots as synthetic local test data; do not infer production account or customer content.
