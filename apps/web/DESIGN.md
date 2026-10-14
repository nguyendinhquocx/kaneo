# DESIGN.md — Kaneo web incumbent system

Documented from the incumbent implementation (`apps/web/src/index.css`, component library, route patterns). This is an extension surface: new Docs/Goals/share UI reuses these tokens and components. No redesign.

## Stack

- React 19 + TanStack Router (file routes under `src/routes/`) + TanStack Query; Vite build.
- Tailwind CSS **v4** (`@import "tailwindcss"` in `src/index.css`) with `@theme inline` mapping to CSS variables; `@custom-variant dark (&:is(.dark *))` for dark mode.
- Primitives: Base UI (`@base-ui/react`) + Radix (dialog, dropdown-menu, popover, select, switch, tabs, tooltip, …); local `src/components/ui/*` wrappers with `data-slot` attributes.
- Tiptap Markdown editor (reusable; see `src/components/activity/comment-editor.tsx`, `src/components/task/task-description.tsx`).
- dnd-kit for board drag; lucide icons.

## Type

- `--font-sans`: **Cal Sans UI** (variable 300–700, `woff2` in `src/assets/fonts/`).
- `--font-heading`: **Cal Sans Heading** (SemiBold 600).
- `--font-mono`: **Paper Mono**.

## Color tokens

Semantic CSS variables consumed through `@theme inline` (both light and dark themes defined as variable sets; dark flips values under `.dark`):

| Token | Use |
| --- | --- |
| `--background` / `--foreground` | Page surface / text |
| `--card` + `--card-foreground` | Card surfaces |
| `--popover` / `--popover-foreground` | Menus, popups, sheets |
| `--primary` / `--primary-foreground` | Primary actions |
| `--secondary`, `--muted`, `--accent` (+ each `-foreground`) | Quiet surfaces, hover accents |
| `--destructive` (+ `-foreground`) | Destructive actions |
| `--success`, `--warning`, `--info` (+ `-foreground`) | Status colors |
| `--border`, `--input`, `--ring` | Borders, inputs, focus rings |
| `--sidebar*` (background, foreground, primary, accent, border, ring) | App sidebar |
| `--code`, `--code-foreground`, `--code-highlight` | Code blocks in Markdown |
| `--chart-1..5` | Chart series |

## Radius & motion

- Radius scale derived from `--radius`: `--radius-sm: calc(var(--radius) - 4px)`, `--radius-md: - 2px`, `--radius-lg: var(--radius)`, `--radius-xl: + 4px`.
- Easing: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)`.
- Skeleton shimmer animation (`--animate-skeleton`).
- `prefers-reduced-motion: reduce` collapses scale/translate movement to opacity fades for all `data-slot` popups (dialog, sheet, popover, menu, tooltip, command, toast) and disables sidebar transitions. Keep this behavior for any new popup-based surface.

## Layout patterns

- App shell: sidebar (`src/components/ui/sidebar.tsx`, `app-sidebar.tsx`) + workspace/project layouts in `src/components/common/workspace-layout.tsx` and `project-layout.tsx`; desktop project navigation plus `header/mobile-project-nav.tsx` for small screens.
- Wide data grids scroll **inside their container** (`overflow-auto` + `min-width` columns + touch-pan; reference `project/$projectId/gantt.tsx`) — never page-level horizontal scroll.
- Detail surfaces are responsive sheets (`src/components/ui/sheet.tsx`, pattern: `task-details-sheet.tsx`).
- Feedback: inline save states ("Đang lưu"/"Đã lưu"/"Lỗi"), toasts via popup system; avoid toast spam for copy actions (inline "Đã sao chép").

## Accessibility baseline

Visible focus rings (`--ring`), 44px touch targets on interactive cells, labeled controls, Escape closes sheets/dialogs, keyboard-operable menus. Text contrast ≥ 4.5:1 in both themes.
