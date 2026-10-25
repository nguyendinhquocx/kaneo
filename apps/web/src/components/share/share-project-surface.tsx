import { useNavigate } from "@tanstack/react-router";
import {
  CalendarDays,
  FileText,
  SquareKanban,
  SquircleDashed,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BacklogListView from "@/components/backlog-list-view";
import BoardToolbar from "@/components/board/board-toolbar";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import { ThemeToggle } from "@/components/public-project/theme-toggle";
import { setShareCapabilityProjectId } from "@/components/share/share-capability";
import ShareGanttView from "@/components/share/share-gantt-view";
import useGetLabelsByWorkspace from "@/hooks/queries/label/use-get-labels-by-workspace";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useBoardSort } from "@/hooks/use-board-sort";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import { sortTasks } from "@/lib/sort-tasks";
import useProjectStore from "@/store/project";
import { useUserPreferencesStore } from "@/store/user-preferences";
import type { ProjectWithTasks } from "@/types/project";

// SPEC-2026-10-22 full-project-share-link: the guest work surface. Same
// owner building blocks (toolbar, kanban, list, docs) rendered through the
// capability transport — no workspace shell, no switchers, no share
// administration. Excluded controls are absent, not disabled.

type ShareSurfaceView = "backlog" | "board" | "gantt" | "docs";

export default function ShareProjectSurface({
  token,
  projectId,
  initialView = "board",
  project,
  children,
}: {
  token: string;
  projectId: string;
  project: ProjectWithTasks;
  initialView?: ShareSurfaceView;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setProject } = useProjectStore();
  const { data: users } = useGetActiveWorkspaceUsers("");
  const { data: workspaceLabels = [] } = useGetLabelsByWorkspace("");
  const { viewMode, setViewMode } = useUserPreferencesStore();
  const { sort, setSort } = useBoardSort(projectId);
  const {
    filteredProject,
    filters,
    updateFilter,
    clearFilters,
    hasActiveFilters,
    updateLabelFilter,
  } = useTaskFiltersWithLabelsSupport(project ?? null, projectId);
  const [view, setView] = useState<ShareSurfaceView>(initialView);

  // Surface the real project id to capability consumers and shared owner
  // components once loaded.
  useEffect(() => {
    if (project?.id) {
      setShareCapabilityProjectId(project.id);
      setProject(project as unknown as Parameters<typeof setProject>[0]);
    }
  }, [project, setProject]);
  const sortedProject = useMemo(() => {
    if (!filteredProject) return null;
    const sortTasksInColumn = (
      tasks: (typeof filteredProject.columns)[number]["tasks"],
    ) => sortTasks(tasks, sort);
    return {
      ...filteredProject,
      columns: filteredProject.columns.map((column) => ({
        ...column,
        tasks: sortTasksInColumn(column.tasks),
      })),
      archivedTasks: sortTasks(filteredProject.archivedTasks ?? [], sort),
      plannedTasks: sortTasks(filteredProject.plannedTasks ?? [], sort),
    };
  }, [filteredProject, sort]);

  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-border/80 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {project?.name ?? ""}
          </span>
          <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
            {t("share:full.holderBadge")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <nav className="flex h-8 max-w-[60vw] items-center gap-0.5 overflow-x-auto rounded-lg border border-border/80 bg-background p-0.5 sm:max-w-none">
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
                aria-label={t(`share:full.view.${key}`)}
                onClick={() => setView(key)}
                className={`flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs ${
                  view === key
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                <span className="hidden sm:inline">
                  {t(`share:full.view.${key}`)}
                </span>
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
              {view === "gantt" && sortedProject ? (
                <ShareGanttView
                  project={sortedProject}
                  onOpenTask={(taskId) =>
                    navigate({
                      to: "/share/project/$token/task/$taskId",
                      params: { token, taskId },
                    })
                  }
                />
              ) : view === "backlog" && sortedProject ? (
                <BacklogListView project={sortedProject} />
              ) : view === "board" && sortedProject ? (
                viewMode === "board" ? (
                  <KanbanBoard project={sortedProject} />
                ) : (
                  <ListView project={sortedProject} />
                )
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
