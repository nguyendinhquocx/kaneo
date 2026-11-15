import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BoardToolbar from "@/components/board/board-toolbar";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import { setShareCapabilityProjectId } from "@/components/share/share-capability";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogPopup } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createSharedProjectTask,
  type SharedTaskWrite,
  ShareConflictError,
  updateSharedProjectTask,
} from "@/fetchers/share/share-public-api";
import type {
  PublicProjectPayload,
  PublicProjectTask,
} from "@/types/public-project";
import type { ProjectBoardTask, ProjectWithTasks } from "@/types/project";
import useProjectStore from "@/store/project";
import { useBoardSort } from "@/hooks/use-board-sort";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import { useUserPreferencesStore } from "@/store/user-preferences";
import { sortTasks } from "@/lib/sort-tasks";
import { SharedMarkdown, ShareScopeBadge } from "./goal-share-reader";

type ProjectShareData = PublicProjectPayload & { scope?: "view" | "edit" };

function mapPublicTask(task: PublicProjectTask, projectId: string): ProjectBoardTask {
  return {
    id: task.id,
    projectId,
    number: task.number,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    startDate: task.startDate ? task.startDate.toString() : null,
    dueDate: task.dueDate ? task.dueDate.toString() : null,
    position: task.position,
    createdAt: task.createdAt.toString(),
    userId: null,
    assigneeId: null,
    assigneeName: null,
    contentRevision: task.contentRevision,
    labels: task.labels.map((label) => ({ ...label, color: label.color ?? "" })),
    workMarkerCounts: {
      redCross: 0,
      boxedRedCross: 0,
      redCircle: 0,
      greenCheck: 0,
    },
    isSubtask: task.isSubtask,
    nextSubtaskPreview: task.nextSubtaskPreview,
  };
}

function mapPublicProjectToBoard(data: ProjectShareData): ProjectWithTasks {
  return {
    id: data.id,
    name: data.name,
    slug: data.slug,
    icon: data.icon,
    description: data.description,
    workspaceId: "",
    isPublic: data.isPublic,
    showSubtaskCardsByDefault: true,
    showAssigneesByDefault: false,
    showPriorityByDefault: true,
    columns: data.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) => mapPublicTask(task, data.id)),
    })),
    archivedTasks: data.archivedTasks.map((task) => mapPublicTask(task, data.id)),
    plannedTasks: data.plannedTasks.map((task) => mapPublicTask(task, data.id)),
  } as ProjectWithTasks;
}

const PRIORITY_VALUES = [
  "no-priority",
  "low",
  "medium",
  "high",
  "urgent",
] as const;

// R4-T4: the project token page. View links render the same read-only board
// as the legacy public page. Edit links additionally expose a visible
// "Chỉnh sửa" surface limited to the T7 basic task fields (create + update);
// every write goes through the audited capability endpoints.
export default function ProjectShareReader({
  data,
  token,
}: {
  data: ProjectShareData;
  token: string;
}) {
  const { t } = useTranslation("share");
  const queryClient = useQueryClient();
  const canEdit = data.scope === "edit";
  const [isEditing, setIsEditing] = useState(false);
  const { setProject } = useProjectStore();
  const { viewMode, setViewMode } = useUserPreferencesStore();
  const { sort, setSort } = useBoardSort(data.id);
  const project = useMemo(() => mapPublicProjectToBoard(data), [data]);
  const {
    filteredProject,
    filters,
    updateFilter,
    clearFilters,
    hasActiveFilters,
    updateLabelFilter,
  } = useTaskFiltersWithLabelsSupport(project, data.id);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const allTasks = useMemo(
    () => (data.columns ?? []).flatMap((column) => column.tasks ?? []),
    [data.columns],
  );
  const selectedTask =
    allTasks.find((task) => task.id === selectedTaskId) ?? null;
  const workspaceLabels = useMemo(() => {
    const labels = new Map<string, { id: string; name: string; color: string }>();
    for (const task of allTasks) {
      for (const label of task.labels ?? []) {
        labels.set(label.id, { ...label, color: label.color ?? "" });
      }
    }
    return [...labels.values()];
  }, [allTasks]);

  useEffect(() => {
    setShareCapabilityProjectId(data.id);
    setProject(project as unknown as Parameters<typeof setProject>[0]);
    // The owner KanbanBoard move hook uses a scoped cache snapshot for the
    // legacy edit capability so it can send the current contentRevision.
    queryClient.setQueryData(["share-full", token], project);
  }, [data.id, project, queryClient, setProject, token]);

  const sortedProject = useMemo(() => {
    if (!filteredProject) return null;
    return {
      ...filteredProject,
      columns: filteredProject.columns.map((column) => ({
        ...column,
        tasks: sortTasks(column.tasks, sort),
      })),
    };
  }, [filteredProject, sort]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["share", "project", token],
      }),
      queryClient.invalidateQueries({
        queryKey: ["share-project-route", token],
        exact: true,
      }),
    ]);

  return (
    <article className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold text-foreground">{data.name}</h1>
        <ShareScopeBadge scope={canEdit ? "edit" : "view"} />
        <div className="flex-1" />
        {canEdit ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-8"
              aria-pressed={isEditing}
              onClick={() => {
                setSelectedTaskId(null);
                setIsEditing((current) => !current);
              }}
            >
              {isEditing ? t("doneEditing") : t("edit")}
            </Button>
            {isEditing ? (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-8"
                onClick={() => setIsCreating(true)}
              >
                <Plus className="size-3.5" />
                {t("project.newTask")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {data.description ? (
        <p className="text-sm text-muted-foreground">{data.description}</p>
      ) : null}
      {canEdit ? null : (
        <p className="text-xs text-muted-foreground">{t("project.viewHint")}</p>
      )}

      <div className="flex h-[70vh] min-h-0 flex-col gap-2">
        <BoardToolbar
          project={filteredProject ?? null}
          filters={filters}
          updateFilter={updateFilter}
          updateLabelFilter={updateLabelFilter}
          clearFilters={() => clearFilters()}
          hasActiveFilters={hasActiveFilters}
          users={[] as never}
          workspaceLabels={workspaceLabels as never}
          viewMode={viewMode}
          setViewMode={setViewMode}
          sort={sort}
          onSortChange={setSort}
        />
        <div className="min-h-0 flex-1">
          {viewMode === "board" && sortedProject ? (
            <KanbanBoard
              project={sortedProject}
              disableDragDrop={!canEdit || !isEditing || hasActiveFilters}
              onTaskClick={(taskId) => setSelectedTaskId(taskId)}
            />
          ) : sortedProject ? (
            <ListView
              project={sortedProject}
              onTaskClick={(taskId) => setSelectedTaskId(taskId)}
            />
          ) : null}
        </div>
      </div>

      {canEdit && isCreating ? (
        <SharedTaskFormDialog
          token={token}
          columns={data.columns ?? []}
          open={isCreating}
          onOpenChange={setIsCreating}
          onSaved={() => {
            setIsCreating(false);
            void refresh();
          }}
        />
      ) : null}

      {canEdit && isEditing && selectedTask ? (
        <SharedTaskEditDialog
          token={token}
          task={selectedTask}
          columns={data.columns ?? []}
          open={Boolean(selectedTask)}
          onOpenChange={(open) => {
            if (!open) setSelectedTaskId(null);
          }}
          onSaved={() => {
            void refresh();
            setSelectedTaskId(null);
          }}
        />
      ) : null}

      {(!canEdit || !isEditing) && selectedTask ? (
        <Dialog
          open={Boolean(selectedTask)}
          onOpenChange={(open) => {
            if (!open) setSelectedTaskId(null);
          }}
        >
          <DialogPopup className="w-full max-w-2xl">
            <div className="flex items-center justify-between border-border/70 border-b px-4 py-3">
              <span className="truncate text-sm font-medium text-foreground">
                {data.slug?.toUpperCase()}-{selectedTask.number}{" "}
                {selectedTask.title}
              </span>
              <DialogClose
                className="rounded p-1.5 hover:bg-muted"
                render={
                  <button type="button" aria-label={t("project.close")} />
                }
              >
                <X className="size-4 text-muted-foreground" />
              </DialogClose>
            </div>
            <div className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4">
              {selectedTask.description ? (
                <SharedMarkdown
                  content={selectedTask.description}
                  resourceType="project"
                  token={token}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("project.noDescription")}
                </p>
              )}
            </div>
          </DialogPopup>
        </Dialog>
      ) : null}
    </article>
  );
}

function StatusSelect({
  columns,
  value,
  onChange,
  label,
  includeEmpty = false,
}: {
  columns: ProjectShareData["columns"];
  value: string;
  onChange: (value: string) => void;
  label: string;
  includeEmpty?: boolean;
}) {
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <select
        className="mt-1 flex h-11 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {includeEmpty ? <option value="">—</option> : null}
        {columns.map((column) => (
          <option key={column.id} value={column.slug ?? column.id}>
            {column.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function PrioritySelect({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const { t } = useTranslation("tasks");
  return (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <select
        className="mt-1 flex h-11 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {PRIORITY_VALUES.map((priority) => (
          <option key={priority} value={priority}>
            {t(`priority.${priority}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SharedTaskFormDialog({
  token,
  columns,
  open,
  onOpenChange,
  onSaved,
}: {
  token: string;
  columns: ProjectShareData["columns"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("share");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState(columns[0]?.slug ?? "");
  const [priority, setPriority] = useState("no-priority");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    setError(null);
    const task: SharedTaskWrite & { title: string } = { title: title.trim() };
    if (status) task.status = status;
    if (priority) task.priority = priority;
    if (startDate) task.startDate = startDate;
    if (dueDate) task.dueDate = dueDate;
    if (description.trim()) task.description = description;
    try {
      await createSharedProjectTask({ token, task });
      setTitle("");
      setDescription("");
      setStartDate("");
      setDueDate("");
      onSaved();
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== "error"
          ? caught.message
          : t("project.saveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        <div className="flex items-center justify-between border-border/70 border-b px-4 py-3">
          <span className="text-sm font-semibold text-foreground">
            {t("project.newTask")}
          </span>
          <DialogClose
            className="rounded p-1.5 hover:bg-muted"
            render={<button type="button" aria-label={t("project.close")} />}
          >
            <X className="size-4 text-muted-foreground" />
          </DialogClose>
        </div>
        <form
          className="space-y-3 px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label
            htmlFor="shared-task-new-title"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("project.titleLabel")}
            <Input
              id="shared-task-new-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 h-11 sm:h-8"
              autoFocus
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatusSelect
              columns={columns}
              value={status}
              onChange={setStatus}
              label={t("project.statusLabel")}
            />
            <PrioritySelect
              value={priority}
              onChange={setPriority}
              label={t("project.priorityLabel")}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label
              htmlFor="shared-task-new-start-date"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("project.startDateLabel")}
              <Input
                id="shared-task-new-start-date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="mt-1 h-11 sm:h-8"
              />
            </label>
            <label
              htmlFor="shared-task-new-due-date"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("project.dueDateLabel")}
              <Input
                id="shared-task-new-due-date"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="mt-1 h-11 sm:h-8"
              />
            </label>
          </div>
          <label
            htmlFor="shared-task-new-description"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("project.descriptionLabel")}
            <Textarea
              id="shared-task-new-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="mt-1"
            />
          </label>
          {error ? (
            <p className="text-xs text-foreground" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-8"
              disabled={isSaving}
              onClick={() => onOpenChange(false)}
            >
              {t("project.cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={isSaving || !title.trim()}
            >
              {isSaving ? t("project.saving") : t("project.create")}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SharedTaskEditDialog({
  token,
  task,
  columns,
  open,
  onOpenChange,
  onSaved,
}: {
  token: string;
  task: PublicProjectTask;
  columns: ProjectShareData["columns"];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("share");
  const [title, setTitle] = useState(task.title);
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState(task.priority ?? "no-priority");
  const [startDate, setStartDate] = useState(
    task.startDate ? String(task.startDate).slice(0, 10) : "",
  );
  const [dueDate, setDueDate] = useState(
    task.dueDate ? String(task.dueDate).slice(0, 10) : "",
  );
  const [description, setDescription] = useState(task.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    setError(null);
    setSaved(false);
    const taskWrite: SharedTaskWrite = {};
    if (title.trim() !== task.title) taskWrite.title = title.trim();
    if (status !== task.status) taskWrite.status = status;
    if (priority !== (task.priority ?? "no-priority")) {
      taskWrite.priority = priority;
    }
    const currentStart = task.startDate
      ? String(task.startDate).slice(0, 10)
      : "";
    if (startDate !== currentStart) taskWrite.startDate = startDate || null;
    const currentDue = task.dueDate ? String(task.dueDate).slice(0, 10) : "";
    if (dueDate !== currentDue) taskWrite.dueDate = dueDate || null;
    if (description !== (task.description ?? "")) {
      taskWrite.description = description;
    }
    try {
      await updateSharedProjectTask({
        token,
        taskId: task.id,
        task: taskWrite,
        // SPEC-2026-11-10 T3: public edit writes CAS the card; a stale
        // token surfaces as a recoverable conflict in the same dialog.
        expectedContentRevision: task.contentRevision ?? 1,
      });
      setSaved(true);
      onSaved();
    } catch (caught) {
      if (caught instanceof ShareConflictError) {
        setError(t("project.conflictRetry"));
        onSaved();
        return;
      }
      setError(
        caught instanceof Error && caught.message !== "error"
          ? caught.message
          : t("project.saveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full max-w-lg">
        <div className="flex items-center justify-between border-border/70 border-b px-4 py-3">
          <span className="truncate text-sm font-semibold text-foreground">
            {t("project.editTaskTitle")}
          </span>
          <DialogClose
            className="rounded p-1.5 hover:bg-muted"
            render={<button type="button" aria-label={t("project.close")} />}
          >
            <X className="size-4 text-muted-foreground" />
          </DialogClose>
        </div>
        <form
          className="space-y-3 px-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label
            htmlFor="shared-task-edit-title"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("project.titleLabel")}
            <Input
              id="shared-task-edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 h-11 sm:h-8"
            />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatusSelect
              columns={columns}
              value={status}
              onChange={setStatus}
              label={t("project.statusLabel")}
            />
            <PrioritySelect
              value={priority}
              onChange={setPriority}
              label={t("project.priorityLabel")}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label
              htmlFor="shared-task-edit-start-date"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("project.startDateLabel")}
              <Input
                id="shared-task-edit-start-date"
                type="date"
                value={startDate}
                onChange={(event) => setStartDate(event.target.value)}
                className="mt-1 h-11 sm:h-8"
              />
            </label>
            <label
              htmlFor="shared-task-edit-due-date"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t("project.dueDateLabel")}
              <Input
                id="shared-task-edit-due-date"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                className="mt-1 h-11 sm:h-8"
              />
            </label>
          </div>
          <label
            htmlFor="shared-task-edit-description"
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("project.descriptionLabel")}
            <Textarea
              id="shared-task-edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={5}
              className="mt-1"
            />
          </label>
          {error ? (
            <p className="text-xs text-foreground" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {saved ? (
              <span className="mr-auto text-xs text-muted-foreground">
                {t("project.saved")}
              </span>
            ) : null}
            <Button
              type="submit"
              size="sm"
              className="min-h-11 gap-1.5 sm:min-h-8"
              disabled={isSaving || !title.trim()}
            >
              <Pencil className="size-3.5" />
              {isSaving ? t("project.saving") : t("project.save")}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
