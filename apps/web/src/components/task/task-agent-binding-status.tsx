import { useTranslation } from "react-i18next";
import { useGetTaskBindingStatus } from "@/hooks/queries/agent-session/use-get-task-binding-status";

// SPEC-2026-11-10 T4: one compact, authenticated-owner status in card detail.
// Never mounted on share routes or Kanban cards; it reveals no session id or
// agent principal, only online/offline + the canonical host label.
export default function TaskAgentBindingStatus({ taskId }: { taskId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useGetTaskBindingStatus(taskId);

  if (isLoading || isError || !data?.bound) return null;

  const statusLabel = data.online
    ? t("tasks:detail.agentBinding.online")
    : t("tasks:detail.agentBinding.offline");

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      aria-label={statusLabel}
      role="status"
    >
      <span
        aria-hidden="true"
        className={
          data.online
            ? "size-1.5 shrink-0 rounded-full bg-success"
            : "size-1.5 shrink-0 rounded-full bg-muted-foreground/50"
        }
      />
      <span>{statusLabel}</span>
      {data.hostId ? (
        <>
          <span aria-hidden="true"> · </span>
          <span className="truncate">
            {t("tasks:detail.agentBinding.host", { host: data.hostId })}
          </span>
        </>
      ) : null}
    </div>
  );
}
