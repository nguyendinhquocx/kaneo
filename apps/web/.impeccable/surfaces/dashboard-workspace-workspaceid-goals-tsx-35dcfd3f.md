# Surface brief — Weekly Goals matrix

Route: `src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/goals.tsx`.
Sources: user sketch `plans/ui-reviews/kaneo-workspace/weekly-goals-sketch.png` (hierarchy reference, not pixel-copy); incumbent refs `project/$projectId/gantt.tsx` (inner horizontal scroll), `task-details-sheet.tsx` (detail sheet), `task-description.tsx` (Markdown editor).

## Journey

1. Member opens workspace → Goals (beside Overview/Members in workspace nav).
2. Default view: current Monday–Sunday week; rows = active goals; columns = 7 dates; right column = total (`count` or `count/target`).
3. Tap/click the cell checkbox → completion toggles with immediate feedback; nothing else changes.
4. A separate "note/details" affordance per row opens a responsive sheet: Markdown note for the selected day, related project doc link, save with revision CAS.
5. Previous/next week navigation + current-week reset; past weeks stay readable; archived goals leave the matrix without deleting history (secondary "archived" view).
6. Optional: scoped share link for a goal (view/edit check-ins) from the row or sheet.

## First viewport

Header: week label + prev/next + "this week"; matrix table with goal names, seven date columns (weekday + calendar date), total column; one "New goal" action. On mobile the goal column stays fixed/legible and only the 7-date region scrolls horizontally.

## Signature interactions

- Tick vs note are visually distinct affordances (checkbox vs note button) — never one combined control.
- Total column updates instantly from check-in rows; target shown as `count/target`.
- Horizontal scroll confined to the date-grid container with a visible scrollbar; body never overflows.

## States

Empty (one create action), loading, error, saving/saved on notes, archived (secondary list with restore), revoked/expired share links (explain + recovery).
