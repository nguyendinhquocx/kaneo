# PRODUCT.md — Kaneo

Written from confirmed facts in `docs/specs/.working/SPEC-2026-10-08-kaneo-workspace-collaboration.md` (pre-lock review record: `plans/ui-reviews/kaneo-workspace/pre-lock.md`) and the incumbent implementation. No invented brand or visual world. Owner review is part of the T1 checkpoint.

## Overview

Kaneo is a self-hosted project management app: workspaces contain projects, projects contain tasks on a Kanban/List/Gantt/Backlog board. It also hosts a custom agent-control layer (execution manifests, schedules, runs) that drives coding agents against repos. This spec extends it into a small-team workspace where the reason for work (Markdown docs), the work itself (tasks), and recurring progress (weekly goals + daily check-ins) stay connected but distinct.

## Users

- **Workspace member**: named account inside a workspace; role matrix (viewer/member/admin/owner) governs projects/tasks/labels. Members write docs, tick goals, comment, and manage share links for resources they may share.
- **Share-link holder**: anyone holding a capability URL — a teammate without an account, an external collaborator, or an automation/agent. Cannot be reliably identified; gets exactly the view/edit scope the link grants and nothing else. Never becomes a member.
- **Agent (via raw Markdown)**: fetches shared document content as `text/markdown` without login, JavaScript, cookies, or Tailscale.

## Jobs to be done

- Write and discuss project Markdown docs with conflict detection (revision CAS), comments attributed to members.
- Track recurring goals as a weekly Monday–Sunday matrix: one tick per goal per day, a separate Markdown note per check-in, totals computed from check-in rows (days checked, never parsed note content).
- Give a person or agent exactly one resource with exactly one permission level through a revocable, expiring link — and nothing more.
- Keep agent-controlled projects safe: projects with execution manifests or managed runs deny public writes.

## Voice

Plain, direct, honest about security. Public edit surfaces say who can do what ("anyone holding the link can change this resource; they cannot be reliably identified") instead of hiding capability behind friendly copy. Errors state what happened and how to recover (ask the owner for a new link — never a signup redirect).

## Platform

`web` (responsive 320–1440px). Desktop-first app shell (sidebar + project/workspace layouts) extended with mobile-safe patterns already present (inner horizontal scroll for wide grids, responsive sheets).

## Constraints

- Registration stays disabled; named collaboration is workspace membership only. Share links are not accounts.
- Anonymous writes never touch workspace/project settings, roles, invites, API keys, integrations, agent execution (manifests/schedules/runs), or deletes.
- Public reads expose minimized DTOs: no workspace IDs, user identities/avatars, external integration metadata, or agent-control fields. Task descriptions are redacted from public DTOs when an execution envelope may live inside them.
- Extend the incumbent visual system (`DESIGN.md`); no redesign, no second CSS system.
