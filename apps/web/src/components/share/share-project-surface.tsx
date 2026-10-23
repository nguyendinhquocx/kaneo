import { CalendarDays, FileText, SquareKanban, SquircleDashed } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import BoardToolbar from "@/components/board/board-toolbar";
import { setShareCapabilityProjectId } from "@/components/share/share-capability";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import useGetLabelsByWorkspace from "@/hooks/queries/label/use-get-labels-by-workspace";
import { useGetTasks } from "@/hooks/queries/task/use-get-tasks";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useBoardSort } from "@/hooks/use-board-sort";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import { useUserPreferencesStore } from "@/store/user-preferences";
import { ThemeToggle } from "@/components/public-project/theme-toggle";

// SPEC-2026-10-22 full-project-share-link: the guest work surface. Same
// owner building blocks (toolbar, kanban, list, docs) rendered through the
// capability transport — no workspace shell, no switchers, no share
// administration. Excluded controls are absent, not disabled.

type ShareSurfaceView = "backlog" | "board" | "gantt" | "docs";

export default function ShareProjectSurface({
  projectId,
  initialView = "board",
  children,
}: {
  token: string;
  projectId: string;
  initialView?: ShareSurfaceView;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { data: project } = useGetTasks(projectId);
  const { data: users } = useGetActiveWorkspaceUsers("");
  const { data: workspaceLabels = [] } = useGetLabelsByWorkspace("");
  const { viewMode, setViewMode } = useUserPreferencesStore();
  const { sort, setSort } = useBoardSort(projectId);
  const { filters, updateFilter, clearFilters, hasActiveFilters, updateLabelFilter } =
    useTaskFiltersWithLabelsSupport(project ?? null, projectId);
  const [view, setView] = useState<ShareSurfaceView>(initialView);

  // Surface the real project id to capability consumers once loaded.
  useEffect(() => {
    if (project?.id) {
      setShareCapabilityProjectId(project.id);
    }
  }, [project?.id]);

  // useTaskFiltersWithLabelsSupport already exposes the filtered task set —
  // reuse it instead of duplicating filter logic.
  const filteredProject = project;

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-border/80 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {project?.name ?? ""}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
            {t("share:full.holderBadge")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <nav className="hidden h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-background p-0.5 sm:inline-flex">
            {(
              [
                ["backlog", SquircleDashed],
                ["board", SquareKanban],
                ["gantt", CalendarDays],
                ["docs", FileText],
              ] as const
            ).map(([key, Icon]) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                onClick={() => setView(key)}
                className={`flex h-6 items-center gap-1.5 rounded-md px-2 text-xs ${
                  view === key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {t(`share:full.view.${key}`)}
              </button>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "docs" ? (
          children
        ) : (
          <div className="flex h-full flex-col gap-2 p-3">
            <BoardToolbar
              project={filteredProject ?? null}
              filters={filters}
              updateFilter={updateFilter}
              updateLabelFilter={updateLabelFilter}
              clearFilters={() => clearFilters()}
              hasActiveFilters={hasActiveFilters}
              users={users as never}
              workspaceLabels={workspaceLabels as never}
              viewMode={viewMode}
              setViewMode={setViewMode}
              sort={sort}
              onSortChange={setSort}
            />
            <div className="min-h-0 flex-1">
              {view === "board" && filteredProject ? (
                <KanbanBoard project={filteredProject} />
              ) : view === "board" ? null : filteredProject ? (
                <ListView project={filteredProject} />
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
