# Kaneo workspace collaboration — pre-lock review

- Surf job: `02c638d9-c67e-4c63-9891-9da215629a5c`
- Review mode: pre-lock, visual-only; evidence was the user-provided weekly matrix sketch (`plans/ui-reviews/kaneo-workspace/weekly-goals-sketch.png`) and the bounded product brief.
- Product question: can Docs, Tasks/Records, and Weekly Goals form one collaboration workspace without collapsing distinct data semantics?
- Decision: GO có điều kiện. Keep shared workspace/project context and a common access layer, but keep documents, tasks/deliverables, goals, and daily check-ins as distinct entities.

## Findings

| Severity | Finding | Decision |
|---|---|---|
| P0 / high confidence | Public sharing is a new security boundary; a boolean `isPublic` cannot express resource/action scope. | Use explicit, server-enforced capabilities. Do not expose neighboring resources implicitly. |
| P1 / high confidence | Goal ownership and video date semantics affect privacy and analytics. | Goals private by default; distinguish completed and published dates; use calendar-date check-ins. |
| P1 / high confidence | A checkmark and note action in the same hit area will cause accidental toggles. | Separate toggle from detail/note action; keep the date grid inside its own horizontal-scroll container. |
| P1 / high confidence | Anonymous edits cannot identify a real person; leaked links inherit their write permission. | Attribute actions to the share capability, support revoke/expiry/rate limits, and exclude destructive/admin actions. |

## Product / UX direction

- Workspace flow: Docs explain the goal and approach; Tasks represent work; check-ins record repeated execution; public links expose only selected resources.
- The matrix uses goal rows, seven calendar-date columns, a computed row total, and persistent week navigation. Archive hides a goal from the active matrix without deleting its history.
- Weekly goal notes hold Markdown details for that date. The video example is tracked through goal check-ins and notes in v1; it is not a separate video database.
- Initial rollout should prioritize authenticated Docs collaboration and public read-only sharing. Public comment/edit is a later gated capability, not an unguarded default.

## External references cited by the review

- [WCAG 2.2 — Target Size (Minimum)](https://www.w3.org/TR/WCAG22/#target-size-minimum)
- [OWASP API Security Top 10 2023 — Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
- [RFC 6750 §2.3 — URI Query Parameter](https://www.rfc-editor.org/rfc/rfc6750#section-2.3)
- Notion Help Centre sharing/permissions was cited as a pattern reference only; no Notion behavior is treated as a Kaneo requirement.

## Limits

- This was advisory product/UX review, not a source-code audit or security approval.
- Full behavior, current code paths, and missing server-side guards are verified separately against Kaneo source in the working spec.
