import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import BoardToolbar from "@/components/board/board-toolbar";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import { ShareScopeBadge } from "@/components/share/goal-share-reader";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import { useBoardSort } from "@/hooks/use-board-sort";
import { useUserPreferencesStore } from "@/store/user-preferences";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks, ProjectBoardTask } from "@/types/project";
import type { ShareTaskCard, TaskShareRootPayload } from "@/fetchers/share/share-task-api";

function toBoardTask(card: ShareTaskCard, projectId: string): ProjectBoardTask {
  return {
    id: card.id,
    projectId,
    number: card.number,
    title: card.title,
    description: card.description,
    status: card.status,
    priority: card.priority,
    startDate: card.startDate,
    dueDate: card.dueDate,
    position: 0,
    createdAt: new Date().toISOString(),
    userId: null,
    assigneeId: null,
    assigneeName: null,
    contentRevision: card.contentRevision,
    workMarkerCounts: card.workMarkerCounts,
    labels: card.labels.map((label) => ({
      ...label,
      color: label.color ?? "",
    })),
    isSubtask: false,
    nextSubtaskPreview: null,
  };
}

function toBoardProject(payload: TaskShareRootPayload): ProjectWithTasks {
  const projectId = payload.scopeProjectId;
  const root = toBoardTask(payload.root, projectId);
  const nextSubtask = payload.subtasks.find((task) => {
    const status = payload.statusOptions.find((option) => option.slug === task.status);
    return status && !status.isFinal;
  });
  if (nextSubtask) {
    root.nextSubtaskPreview = {
      id: nextSubtask.id,
      title: nextSubtask.title,
      workMarkerCounts: nextSubtask.workMarkerCounts,
    };
  }

  return {
    id: projectId,
    name: payload.root.title,
    slug: "shared-card",
    icon: null,
    description: null,
    workspaceId: "",
    isPublic: false,
    showSubtaskCardsByDefault: true,
    showAssigneesByDefault: false,
    showPriorityByDefault: true,
    columns: payload.statusOptions.map((status) => ({
      id: status.slug,
      slug: status.slug,
      name: status.name,
      icon: null,
      isFinal: status.isFinal,
      tasks: root.status === status.slug ? [root] : [],
    })),
    archivedTasks: root.status === "archived" ? [root] : [],
    plannedTasks: root.status === "planned" ? [root] : [],
  } as ProjectWithTasks;
}

export default function TaskShareBoard({
  token,
  payload,
}: {
  token: string;
  payload: TaskShareRootPayload;
}) {
  const navigate = useNavigate();
  const project = useMemo(() => toBoardProject(payload), [payload]);
  const { setProject } = useProjectStore();
  const { viewMode, setViewMode } = useUserPreferencesStore();
  const { sort, setSort } = useBoardSort(payload.scopeProjectId);
  const {
    filteredProject,
    filters,
    updateFilter,
    clearFilters,
    hasActiveFilters,
    updateLabelFilter,
  } = useTaskFiltersWithLabelsSupport(project, payload.scopeProjectId);
  const labels = useMemo(
    () => payload.root.labels.map((label) => ({ ...label, workspaceId: "" })),
    [payload.root.labels],
  );
  useEffect(() => {
    setProject(project as unknown as Parameters<typeof setProject>[0]);
  }, [project, setProject]);

  const sortedProject = useMemo(() => {
    if (!filteredProject) return null;
    return {
      ...filteredProject,
      columns: filteredProject.columns.map((column) => ({
        ...column,
        tasks: [...column.tasks].sort((left, right) =>
          sort.direction === "desc"
            ? (right.position ?? 0) - (left.position ?? 0)
            : (left.position ?? 0) - (right.position ?? 0),
        ),
      })),
    };
  }, [filteredProject, sort]);


  return (
    <div className="flex h-svh w-full flex-col overflow-hidden bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border/80 px-3 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {payload.root.title}
          </span>
          <ShareScopeBadge scope={payload.permission} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <BoardToolbar
          project={filteredProject ?? null}
          filters={filters}
          updateFilter={updateFilter}
          updateLabelFilter={updateLabelFilter}
          clearFilters={() => clearFilters()}
          hasActiveFilters={hasActiveFilters}
          users={[] as never}
          workspaceLabels={labels as never}
          viewMode={viewMode}
          setViewMode={setViewMode}
          sort={sort}
          onSortChange={setSort}
        />
        <div className="flex min-h-0 flex-1">
          {viewMode === "board" && sortedProject ? (
            <KanbanBoard
              project={sortedProject}
              disableDragDrop={payload.permission !== "edit" || hasActiveFilters}
              onTaskClick={(taskId) =>
                navigate({
                  to: "/share/task/$token/task/$taskId",
                  params: { token, taskId },
                })
              }
            />
          ) : sortedProject ? (
            <ListView
              project={sortedProject}
              onTaskClick={(taskId) =>
                navigate({
                  to: "/share/task/$token/task/$taskId",
                  params: { token, taskId },
                })
              }
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}
