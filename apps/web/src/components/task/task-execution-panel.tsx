import {
  ExternalLink,
  GitBranch,
  HeartPulse,
  Server,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { ExecutionTaskRun } from "@/fetchers/execution/get-task-runs";
import useGetExecutionAgents from "@/hooks/queries/execution/use-get-execution-agents";
import useGetTaskRunEvidence from "@/hooks/queries/execution/use-get-task-run-evidence";
import useGetTaskRuns from "@/hooks/queries/execution/use-get-task-runs";
import { cn } from "@/lib/cn";

function stateVariant(
  state: string,
): "success" | "warning" | "error" | "info" | "secondary" {
  switch (state) {
    case "done":
      return "success";
    case "blocked":
    case "orphaned":
    case "rejected":
      return "error";
    case "in_review":
      return "warning";
    case "in_progress":
      return "info";
    default:
      return "secondary";
  }
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : "—";
}

function evidenceText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…` : text;
  } catch {
    return null;
  }
}

type DetailRowProps = {
  label: string;
  value: ReactNode;
  className?: string;
};

function DetailRow({ label, value, className }: DetailRowProps) {
  return (
    <div
      className={cn("min-w-0 rounded-md bg-muted/35 px-2.5 py-2", className)}
    >
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-xs text-foreground">
        {value}
      </dd>
    </div>
  );
}

function RunHistoryItem({ run }: { run: ExecutionTaskRun }) {
  return (
    <li className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-2 text-xs">
      <span className="min-w-0 truncate font-mono text-muted-foreground">
        {run.id}
      </span>
      <Badge variant={stateVariant(run.state)} size="sm">
        {run.state}
      </Badge>
    </li>
  );
}

type TaskExecutionPanelProps = {
  taskId: string;
};

export default function TaskExecutionPanel({
  taskId,
}: TaskExecutionPanelProps) {
  const { t } = useTranslation();
  const { data: runs = [], isLoading, isError } = useGetTaskRuns(taskId);
  const { data: agents = [] } = useGetExecutionAgents();
  const currentRun = runs[0];
  const { data: evidence = [] } = useGetTaskRunEvidence(taskId, currentRun?.id);
  const agent = agents.find((item) => item.id === currentRun?.agentPrincipalId);
  const latestEvidence = evidence[evidence.length - 1];
  const evidencePayload = evidenceText(latestEvidence?.payload);
  const leaseExpired = Boolean(
    currentRun?.leaseActive &&
      currentRun.leaseExpiresAt &&
      new Date(currentRun.leaseExpiresAt).getTime() <= Date.now(),
  );

  return (
    <section
      className="min-w-0 rounded-lg border border-border/80 bg-card p-3 sm:p-4"
      aria-labelledby="task-execution-heading"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <h2
              id="task-execution-heading"
              className="truncate text-sm font-semibold"
            >
              Execution
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Durable worker and parent review state
          </p>
        </div>
        {currentRun && (
          <Badge variant={stateVariant(currentRun.state)}>
            {currentRun.state}
          </Badge>
        )}
      </div>

      {isLoading && (
        <p className="mt-3 text-xs text-muted-foreground">
          Loading execution state…
        </p>
      )}
      {isError && (
        <p className="mt-3 text-xs text-destructive">
          Unable to load execution state.
        </p>
      )}
      {!isLoading && !isError && !currentRun && (
        <p className="mt-3 text-xs text-muted-foreground">
          No execution run has been claimed for this task.
        </p>
      )}

      {currentRun && (
        <>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <DetailRow label="Role" value={currentRun.role} />
            <DetailRow
              label="Worker / host"
              value={
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <Server
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="break-words">
                    {agent?.runtimeId ?? currentRun.agentPrincipalId ?? "—"}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>{currentRun.hostId}</span>
                </span>
              }
            />
            <DetailRow
              label="Branch"
              value={
                <span className="inline-flex min-w-0 items-start gap-1.5">
                  <GitBranch
                    className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="break-all font-mono">
                    {currentRun.branchName}
                  </span>
                </span>
              }
            />
            <DetailRow
              label="Commit / base"
              value={
                <span className="font-mono">
                  {shortSha(currentRun.commitSha)} ·{" "}
                  {shortSha(currentRun.baseSha)}
                </span>
              }
            />
            <DetailRow
              label="Pull request"
              value={
                currentRun.prUrl ? (
                  <a
                    className="inline-flex max-w-full items-center gap-1 text-primary underline-offset-2 hover:underline"
                    href={currentRun.prUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="truncate">
                      #{currentRun.prNumber ?? "?"} {currentRun.prState ?? ""}
                    </span>
                    <ExternalLink
                      className="size-3 shrink-0"
                      aria-hidden="true"
                    />
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <DetailRow
              label="Last heartbeat"
              value={
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    leaseExpired && "text-destructive",
                  )}
                >
                  <HeartPulse className="size-3 shrink-0" aria-hidden="true" />
                  {formatDate(currentRun.lastHeartbeatAt)}
                  {currentRun.leaseActive && !leaseExpired && (
                    <span className="text-muted-foreground">
                      (lease active)
                    </span>
                  )}
                </span>
              }
            />
            <DetailRow
              label="Updated"
              value={formatDate(currentRun.updatedAt)}
            />
            <DetailRow
              label="Scope"
              className="sm:col-span-2"
              value={
                <span className="break-words font-mono">
                  {currentRun.scope.length > 0
                    ? currentRun.scope.join(", ")
                    : "—"}
                </span>
              }
            />
          </dl>

          {(currentRun.blocker || currentRun.nextAction) && (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {currentRun.blocker && (
                <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-destructive">
                    Blocker
                  </p>
                  <p className="mt-1 break-words text-xs">
                    {currentRun.blocker}
                  </p>
                </div>
              )}
              {currentRun.nextAction && (
                <div className="min-w-0 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-warning-foreground">
                    Next action
                  </p>
                  <p className="mt-1 break-words text-xs">
                    {currentRun.nextAction}
                  </p>
                </div>
              )}
            </div>
          )}

          {evidencePayload && (
            <details className="mt-3 min-w-0 rounded-md border border-border/70">
              <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                {t("tasks:detail.activity")} evidence
              </summary>
              <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words border-t border-border/70 bg-muted/20 p-2.5 text-[11px] leading-relaxed">
                {evidencePayload}
              </pre>
            </details>
          )}

          {runs.length > 1 && (
            <details className="mt-3 min-w-0">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                {runs.length - 1} previous run{runs.length === 2 ? "" : "s"}
              </summary>
              <ul
                className="mt-2 grid min-w-0 gap-1.5"
                aria-label="Previous execution runs"
              >
                {runs.slice(1).map((run) => (
                  <RunHistoryItem key={run.id} run={run} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
