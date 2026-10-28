import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { motion, useReducedMotion } from "framer-motion";
import { Check, GripVertical, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import TaskCardContextMenuContent from "@/components/kanban-board/task-card-context-menu/task-card-context-menu-content";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { useUpdateTaskTitle } from "@/hooks/mutations/task/use-update-task-title";
import { getColumnIcon } from "@/lib/column";
import { getInitials } from "@/lib/get-initials";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";
import SubtaskAssigneePopover from "./subtask-assignee-popover";
import SubtaskStatusPopover from "./subtask-status-popover";
import WorkMarkerCountList from "./work-marker-counts";

type SubtaskRowProps = {
  task: Task;
  tasks: Task[];
  projectId: string;
  workspaceId: string;
  isSelected: boolean;
  isFocused: boolean;
  isCompleted: boolean;
  canEdit: boolean;
  selectionRadius: string;
  assignee: {
    user?: { image?: string | null; name?: string | null } | null;
  } | null;
  onToggleComplete: () => void;
  onNavigate: () => void;
  onDeleteClick: () => void;
};

export default function SubtaskRow({
  task,
  tasks,
  projectId,
  workspaceId,
  isSelected,
  isFocused,
  isCompleted,
  canEdit,
  selectionRadius,
  assignee,
  onToggleComplete,
  onNavigate,
  onDeleteClick,
}: SubtaskRowProps) {
  const reduceMotion = useReducedMotion();
  const { t } = useTranslation();
  const { mutateAsync: updateTaskTitle, isPending: isSavingTitle } =
    useUpdateTaskTitle();
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [displayTitle, setDisplayTitle] = useState(task.title);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new task may have the same title
  useEffect(() => {
    setTitleDraft(task.title);
    setDisplayTitle(task.title);
  }, [task.id, task.title]);

  const saveTitle = async () => {
    const nextTitle = titleDraft.trim();
    if (!nextTitle) {
      toast.error(t("tasks:update.error"));
      return;
    }
    if (nextTitle === displayTitle) {
      setIsEditingTitle(false);
      return;
    }

    try {
      await updateTaskTitle({ ...task, title: nextTitle });
      setDisplayTitle(nextTitle);
      setIsEditingTitle(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("tasks:update.error"),
      );
    }
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: !canEdit });

  return (
    <motion.div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      // No `layout` prop here: framer's layout animations rewrite `transform`
      // on the same element dnd-kit drives, which breaks drop-target hit
      // testing and snaps dragged rows back to their old slot.
      initial={
        reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.98 }
      }
      animate={
        reduceMotion ? { opacity: 1 } : { opacity: 1, height: "auto", scale: 1 }
      }
      exit={
        reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.98 }
      }
      transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={`group flex flex-wrap items-center gap-2 py-1 px-2 ${selectionRadius} transition-colors cursor-default sm:flex-nowrap ${isSelected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-accent/50"} ${isFocused ? "ring-1 ring-inset ring-ring/50" : ""}`}
          >
            {canEdit ? (
              <button
                type="button"
                ref={setActivatorNodeRef}
                className="relative flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 sm:size-7"
                aria-label={t("tasks:subtasks.drag", { title: task.title })}
                {...attributes}
                {...listeners}
              >
                <GripVertical className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}

            {/* Completion — toggles the subtask done/undone and persists it. */}
            <Checkbox
              checked={isCompleted}
              onCheckedChange={onToggleComplete}
              disabled={!canEdit}
              aria-label={t("tasks:subtasks.completeAria", {
                defaultValue: "Mark subtask complete",
              })}
            />

            <SubtaskStatusPopover tasks={tasks} projectId={projectId}>
              <button
                type="button"
                className="shrink-0 flex items-center justify-center rounded p-0.5 transition-colors outline-none [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground"
              >
                {getColumnIcon(task.status, false)}
              </button>
            </SubtaskStatusPopover>

            <div className="flex w-full min-w-0 basis-full flex-col gap-0.5 sm:basis-0 sm:flex-1 sm:flex-row sm:items-center sm:gap-1">
              <div className="flex w-full min-w-0 items-center gap-1 sm:w-auto sm:flex-1">
                {isEditingTitle ? (
                  <>
                    <Input
                      autoFocus
                      value={titleDraft}
                      disabled={isSavingTitle}
                      aria-label={t("tasks:subtasks.editTitle", {
                        title: displayTitle,
                      })}
                      className="h-11 min-w-0 flex-1 sm:h-8"
                      onChange={(event) => setTitleDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.stopPropagation();
                          void saveTitle();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setTitleDraft(displayTitle);
                          setIsEditingTitle(false);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-50 sm:size-7"
                      aria-label={t("tasks:subtasks.saveTitle")}
                      disabled={isSavingTitle || !titleDraft.trim()}
                      onClick={() => void saveTitle()}
                    >
                      <Check className="size-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent disabled:opacity-50 sm:size-7"
                      aria-label={t("common:actions.cancel")}
                      disabled={isSavingTitle}
                      onClick={() => {
                        setTitleDraft(displayTitle);
                        setIsEditingTitle(false);
                      }}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 text-left outline-none"
                      onClick={onNavigate}
                    >
                      <span
                        className={`block truncate text-sm ${isCompleted ? "line-through text-muted-foreground" : "text-foreground/90"}`}
                      >
                        {displayTitle}
                      </span>
                    </button>
                    {canEdit ? (
                      <button
                        type="button"
                        className="flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent sm:size-7"
                        aria-label={t("tasks:subtasks.editTitle", {
                          title: displayTitle,
                        })}
                        onClick={() => {
                          setTitleDraft(displayTitle);
                          setIsEditingTitle(true);
                        }}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </>
                )}
                <SubtaskAssigneePopover tasks={tasks} workspaceId={workspaceId}>
                  <button
                    type="button"
                    className="flex shrink-0 items-center justify-center rounded p-0.5 transition-colors outline-none"
                  >
                    {task.userId && assignee ? (
                      <Avatar className="h-5 w-5">
                        <AvatarImage
                          src={assignee?.user?.image ?? ""}
                          alt={assignee?.user?.name || ""}
                        />
                        <AvatarFallback className="text-[9px] font-medium border border-border/30">
                          {getInitials(assignee?.user?.name)}
                        </AvatarFallback>
                      </Avatar>
                    ) : (
                      <div
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border/70"
                        title={t("tasks:popover.assignee.unassigned")}
                      >
                        <span className="text-[9px] font-medium text-muted-foreground">
                          ?
                        </span>
                      </div>
                    )}
                  </button>
                </SubtaskAssigneePopover>
              </div>
              <WorkMarkerCountList counts={task.workMarkerCounts} />
            </div>
          </div>
        </ContextMenuTrigger>

        <TaskCardContextMenuContent
          task={task}
          taskCardContext={{
            projectId,
            worskpaceId: workspaceId,
          }}
          onDeleteClick={onDeleteClick}
        />
      </ContextMenu>
    </motion.div>
  );
}
