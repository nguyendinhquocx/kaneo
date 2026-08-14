import {
  ExternalLink,
  GitBranch,
  HeartPulse,
  Server,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ExecutionTaskRun } from "@/fetchers/execution/get-task-runs";
import useReviewTaskRun from "@/hooks/mutations/execution/use-review-task-run";
import useGetExecutionAgents from "@/hooks/queries/execution/use-get-execution-agents";
import useGetExecutionManifest from "@/hooks/queries/execution/use-get-execution-manifest";
import useGetTaskRunEvidence from "@/hooks/queries/execution/use-get-task-run-evidence";
import useGetTaskRuns from "@/hooks/queries/execution/use-get-task-runs";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

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

type ReviewAction = "none" | "create_pr" | "merge";
type ReviewPrStatus = "PASS" | "BLOCKED";

type TaskExecutionPanelProps = {
  taskId: string;
  projectId: string;
};

export default function TaskExecutionPanel({
  taskId,
  projectId,
}: TaskExecutionPanelProps) {
  const { t } = useTranslation();
  const { canReviewExecutions } = useWorkspacePermission();
  const { data: runs = [], isLoading, isError } = useGetTaskRuns(taskId);
  const { data: agents = [], isError: isAgentsError } = useGetExecutionAgents();
  const { data: manifest } = useGetExecutionManifest(projectId);
  const { data: evidence = [], isError: isEvidenceError } =
    useGetTaskRunEvidence(taskId, runs[0]?.id);
  const { mutateAsync: reviewTaskRun, isPending: isReviewing } =
    useReviewTaskRun();
  const [rejectionReason, setRejectionReason] = useState("");
  const [reviewAction, setReviewAction] = useState<ReviewAction>("none");
  const [verificationProfile, setVerificationProfile] = useState("");
  const [changedFiles, setChangedFiles] = useState("");
  const [verificationCommands, setVerificationCommands] = useState("");
  const [diffWithinScope, setDiffWithinScope] = useState(false);
  const [branchValid, setBranchValid] = useState(false);
  const [testsPassed, setTestsPassed] = useState(false);
  const [prStatus, setPrStatus] = useState<ReviewPrStatus>("BLOCKED");
  const [prNumber, setPrNumber] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [prState, setPrState] = useState("");
  const [prBlocker, setPrBlocker] = useState("credential_blocked");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const currentRun = runs[0];
  const agent = agents.find((item) => item.id === currentRun?.agentPrincipalId);
  const latestEvidence = evidence[evidence.length - 1];
  const evidencePayload = evidenceText(latestEvidence?.payload);
  const leaseExpired = Boolean(
    currentRun?.leaseActive &&
      currentRun.leaseExpiresAt &&
      new Date(currentRun.leaseExpiresAt).getTime() <= Date.now(),
  );
  const manifestMatchesRun = Boolean(
    currentRun &&
      manifest &&
      currentRun.manifestId === manifest.id &&
      currentRun.manifestVersion === manifest.manifestVersion,
  );

  useEffect(() => {
    if (!currentRun) return;
    const evidenceProfile = currentRun.evidence.verificationProfile;
    setVerificationProfile(
      manifest?.verificationProfile ??
        (typeof evidenceProfile === "string" ? evidenceProfile : ""),
    );
    setChangedFiles("");
    setVerificationCommands("");
    setDiffWithinScope(false);
    setBranchValid(false);
    setTestsPassed(false);
    setReviewAction("none");
    setPrStatus("BLOCKED");
    setPrNumber("");
    setPrUrl("");
    setPrState("");
    setPrBlocker("credential_blocked");
    setReviewError(null);
  }, [currentRun, manifest?.verificationProfile]);

  const parseLines = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const handleApprove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentRun) return;

    const files = parseLines(changedFiles);
    const commands = parseLines(verificationCommands);
    if (
      !verificationProfile.trim() ||
      files.length === 0 ||
      commands.length === 0
    ) {
      setReviewError(t("tasks:detail.execution.review.verificationRequired"));
      return;
    }
    if (!diffWithinScope || !branchValid || !testsPassed) {
      setReviewError(t("tasks:detail.execution.review.checksRequired"));
      return;
    }

    const verification = {
      verificationProfile: verificationProfile.trim(),
      baseSha: currentRun.baseSha ?? "",
      commitSha: currentRun.commitSha ?? "",
      changedFiles: files,
      commands,
      diffWithinScope: true as const,
      branchValid: true as const,
      testsPassed: true as const,
    };
    const prResult =
      reviewAction === "none"
        ? undefined
        : prStatus === "PASS"
          ? {
              status: "PASS" as const,
              operation: reviewAction,
              prNumber: Number(prNumber),
              prUrl: prUrl.trim(),
              prState: prState.trim(),
            }
          : {
              status: "BLOCKED" as const,
              operation: reviewAction,
              blocker: prBlocker,
              reason: rejectionReason.trim() || undefined,
            };

    setReviewError(null);
    try {
      await reviewTaskRun({
        taskId,
        runId: currentRun.id,
        json: {
          decision: "approve",
          action: reviewAction,
          verification,
          ...(prResult ? { prResult } : {}),
        },
      });
      toast.success(t("tasks:detail.execution.review.approved"));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("tasks:detail.execution.review.error");
      setReviewError(message);
      toast.error(message);
    }
  };

  const handleReject = async () => {
    const reason = rejectionReason.trim();
    if (!currentRun || !reason) {
      setReviewError(t("tasks:detail.execution.review.reasonRequired"));
      return;
    }

    setReviewError(null);
    try {
      await reviewTaskRun({
        taskId,
        runId: currentRun.id,
        json: {
          decision: "reject",
          action: "none",
          reason,
        },
      });
      setRejectionReason("");
      toast.success(t("tasks:detail.execution.review.rejected"));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t("tasks:detail.execution.review.error");
      setReviewError(message);
      toast.error(message);
    }
  };

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
              {t("tasks:detail.execution.title")}
            </h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("tasks:detail.execution.subtitle")}
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
          {t("tasks:detail.execution.loading")}
        </p>
      )}
      {isError && (
        <p className="mt-3 text-xs text-destructive">
          {t("tasks:detail.execution.error")}
        </p>
      )}
      {!isLoading && !isError && !currentRun && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t("tasks:detail.execution.noRun")}
        </p>
      )}
      {currentRun && isAgentsError && (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {t("tasks:detail.execution.agentsError")}
        </p>
      )}
      {currentRun && isEvidenceError && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {t("tasks:detail.execution.evidenceError")}
        </p>
      )}

      {currentRun && (
        <>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <DetailRow
              label={t("tasks:detail.execution.role")}
              value={currentRun.role}
            />
            <DetailRow
              label={t("tasks:detail.execution.worker")}
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
              label={t("tasks:detail.execution.branch")}
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
              label={t("tasks:detail.execution.commitBase")}
              value={
                <span className="font-mono">
                  {shortSha(currentRun.commitSha)} ·{" "}
                  {shortSha(currentRun.baseSha)}
                </span>
              }
            />
            <DetailRow
              label={t("tasks:detail.execution.pullRequest")}
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
              label={t("tasks:detail.execution.lastHeartbeat")}
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
                      ({t("tasks:detail.execution.leaseActive")})
                    </span>
                  )}
                </span>
              }
            />
            <DetailRow
              label={t("tasks:detail.execution.updated")}
              value={formatDate(currentRun.updatedAt)}
            />
            <DetailRow
              label={t("tasks:detail.execution.scope")}
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

          {manifest && (
            <div className="mt-3 min-w-0 rounded-md border border-border/70 bg-muted/15 px-2.5 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold">
                  {t("tasks:detail.execution.manifest.title")}
                </p>
                <Badge
                  variant={manifestMatchesRun ? "success" : "warning"}
                  size="sm"
                >
                  {manifestMatchesRun
                    ? t("tasks:detail.execution.manifest.match")
                    : t("tasks:detail.execution.manifest.changed")}
                </Badge>
              </div>
              <dl className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                <DetailRow
                  label={t("tasks:detail.execution.manifest.baseBranch")}
                  value={
                    <span className="font-mono">{manifest.baseBranch}</span>
                  }
                />
                <DetailRow
                  label={t("tasks:detail.execution.manifest.profile")}
                  value={
                    <span className="font-mono break-all">
                      {manifest.verificationProfile}
                    </span>
                  }
                />
                <DetailRow
                  label={t("tasks:detail.execution.manifest.version")}
                  value={`${manifest.manifestVersion} / ${manifest.protocolVersion}`}
                />
              </dl>
              {manifest.docs.length > 0 && (
                <p className="mt-2 break-words text-[11px] text-muted-foreground">
                  {t("tasks:detail.execution.manifest.docs")}:{" "}
                  {manifest.docs.join(", ")}
                </p>
              )}
            </div>
          )}

          {(currentRun.blocker || currentRun.nextAction) && (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {currentRun.blocker && (
                <div className="min-w-0 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-destructive">
                    {t("tasks:detail.execution.blocker")}
                  </p>
                  <p className="mt-1 break-words text-xs">
                    {currentRun.blocker}
                  </p>
                </div>
              )}
              {currentRun.nextAction && (
                <div className="min-w-0 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
                  <p className="text-[11px] font-medium text-warning-foreground">
                    {t("tasks:detail.execution.nextAction")}
                  </p>
                  <p className="mt-1 break-words text-xs">
                    {currentRun.nextAction}
                  </p>
                </div>
              )}
            </div>
          )}

          {currentRun.state === "in_review" && (
            <div className="mt-3 min-w-0 rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs font-medium">
                {t("tasks:detail.execution.review.title")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("tasks:detail.execution.review.hint")}
              </p>
              {canReviewExecutions() && (
                <form
                  className="mt-3 flex min-w-0 flex-col gap-3"
                  onSubmit={handleApprove}
                >
                  <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                    <label
                      className="min-w-0 text-[11px] font-medium text-muted-foreground"
                      htmlFor="task-execution-verification-profile"
                    >
                      {t("tasks:detail.execution.review.verificationProfile")}
                      <Input
                        id="task-execution-verification-profile"
                        className="mt-1 h-8 text-xs"
                        value={verificationProfile}
                        onChange={(event) =>
                          setVerificationProfile(event.target.value)
                        }
                        placeholder={t(
                          "tasks:detail.execution.review.verificationProfilePlaceholder",
                        )}
                      />
                    </label>
                    <div className="min-w-0 rounded-md bg-muted/35 px-2.5 py-2 text-[11px] text-muted-foreground">
                      <p className="font-medium">
                        {t("tasks:detail.execution.review.commitEvidence")}
                      </p>
                      <p className="mt-1 break-all font-mono">
                        base: {shortSha(currentRun.baseSha)}
                      </p>
                      <p className="break-all font-mono">
                        commit: {shortSha(currentRun.commitSha)}
                      </p>
                    </div>
                  </div>
                  <label
                    className="min-w-0 text-[11px] font-medium text-muted-foreground"
                    htmlFor="task-execution-changed-files"
                  >
                    {t("tasks:detail.execution.review.changedFiles")}
                    <Textarea
                      id="task-execution-changed-files"
                      className="mt-1"
                      value={changedFiles}
                      onChange={(event) => setChangedFiles(event.target.value)}
                      rows={3}
                      placeholder={t(
                        "tasks:detail.execution.review.changedFilesPlaceholder",
                      )}
                    />
                  </label>
                  <label
                    className="min-w-0 text-[11px] font-medium text-muted-foreground"
                    htmlFor="task-execution-verification-commands"
                  >
                    {t("tasks:detail.execution.review.commands")}
                    <Textarea
                      id="task-execution-verification-commands"
                      className="mt-1"
                      value={verificationCommands}
                      onChange={(event) =>
                        setVerificationCommands(event.target.value)
                      }
                      rows={3}
                      placeholder={t(
                        "tasks:detail.execution.review.commandsPlaceholder",
                      )}
                    />
                  </label>
                  <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
                    <label className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={diffWithinScope}
                        onChange={(event) =>
                          setDiffWithinScope(event.target.checked)
                        }
                      />
                      <span>
                        {t("tasks:detail.execution.review.diffWithinScope")}
                      </span>
                    </label>
                    <label className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={branchValid}
                        onChange={(event) =>
                          setBranchValid(event.target.checked)
                        }
                      />
                      <span>
                        {t("tasks:detail.execution.review.branchValid")}
                      </span>
                    </label>
                    <label className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        checked={testsPassed}
                        onChange={(event) =>
                          setTestsPassed(event.target.checked)
                        }
                      />
                      <span>
                        {t("tasks:detail.execution.review.testsPassed")}
                      </span>
                    </label>
                  </div>
                  <label
                    className="min-w-0 text-[11px] font-medium text-muted-foreground"
                    htmlFor="task-execution-review-action"
                  >
                    {t("tasks:detail.execution.review.action")}
                    <select
                      id="task-execution-review-action"
                      className="mt-1 flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      value={reviewAction}
                      onChange={(event) =>
                        setReviewAction(event.target.value as ReviewAction)
                      }
                    >
                      <option value="none">
                        {t("tasks:detail.execution.review.actionNone")}
                      </option>
                      <option value="create_pr">
                        {t("tasks:detail.execution.review.actionCreatePr")}
                      </option>
                      <option value="merge">
                        {t("tasks:detail.execution.review.actionMerge")}
                      </option>
                    </select>
                  </label>
                  {reviewAction !== "none" && (
                    <div className="grid min-w-0 grid-cols-1 gap-2 rounded-md border border-border/70 bg-card p-2.5 sm:grid-cols-2">
                      <label
                        className="min-w-0 text-[11px] font-medium text-muted-foreground"
                        htmlFor="task-execution-pr-status"
                      >
                        {t("tasks:detail.execution.review.prStatus")}
                        <select
                          id="task-execution-pr-status"
                          className="mt-1 flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          value={prStatus}
                          onChange={(event) =>
                            setPrStatus(event.target.value as ReviewPrStatus)
                          }
                        >
                          <option value="BLOCKED">BLOCKED</option>
                          <option value="PASS">PASS</option>
                        </select>
                      </label>
                      {prStatus === "PASS" ? (
                        <>
                          <label
                            className="min-w-0 text-[11px] font-medium text-muted-foreground"
                            htmlFor="task-execution-pr-number"
                          >
                            {t("tasks:detail.execution.review.prNumber")}
                            <Input
                              id="task-execution-pr-number"
                              className="mt-1 h-8 text-xs"
                              inputMode="numeric"
                              value={prNumber}
                              onChange={(event) =>
                                setPrNumber(event.target.value)
                              }
                            />
                          </label>
                          <label
                            className="min-w-0 text-[11px] font-medium text-muted-foreground"
                            htmlFor="task-execution-pr-url"
                          >
                            {t("tasks:detail.execution.review.prUrl")}
                            <Input
                              id="task-execution-pr-url"
                              className="mt-1 h-8 text-xs"
                              value={prUrl}
                              onChange={(event) => setPrUrl(event.target.value)}
                              placeholder="https://github.com/.../pull/1"
                            />
                          </label>
                          <label
                            className="min-w-0 text-[11px] font-medium text-muted-foreground"
                            htmlFor="task-execution-pr-state"
                          >
                            {t("tasks:detail.execution.review.prState")}
                            <Input
                              id="task-execution-pr-state"
                              className="mt-1 h-8 text-xs"
                              value={prState}
                              onChange={(event) =>
                                setPrState(event.target.value)
                              }
                              placeholder={
                                reviewAction === "merge" ? "merged" : "open"
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <label
                          className="min-w-0 text-[11px] font-medium text-muted-foreground"
                          htmlFor="task-execution-pr-blocker"
                        >
                          {t("tasks:detail.execution.review.prBlocker")}
                          <select
                            id="task-execution-pr-blocker"
                            className="mt-1 flex h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            value={prBlocker}
                            onChange={(event) =>
                              setPrBlocker(event.target.value)
                            }
                          >
                            <option value="credential_blocked">
                              credential_blocked
                            </option>
                            <option value="policy_blocked">
                              policy_blocked
                            </option>
                            <option value="merge_conflict">
                              merge_conflict
                            </option>
                            <option value="pr_conflict">pr_conflict</option>
                            <option value="pr_create_failed">
                              pr_create_failed
                            </option>
                            <option value="merge_failed">merge_failed</option>
                          </select>
                        </label>
                      )}
                    </div>
                  )}
                  <label
                    className="min-w-0 text-[11px] font-medium text-muted-foreground"
                    htmlFor="task-execution-rejection-reason"
                  >
                    {t("tasks:detail.execution.review.reasonLabel")}
                    <Textarea
                      id="task-execution-rejection-reason"
                      className="mt-1"
                      value={rejectionReason}
                      onChange={(event) =>
                        setRejectionReason(event.target.value)
                      }
                      maxLength={500}
                      rows={2}
                      placeholder={t(
                        "tasks:detail.execution.review.reasonPlaceholder",
                      )}
                      aria-describedby={
                        reviewError ? "task-execution-review-error" : undefined
                      }
                    />
                  </label>
                  {reviewError && (
                    <p
                      id="task-execution-review-error"
                      className="text-xs text-destructive"
                    >
                      {reviewError}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11px] text-muted-foreground">
                      {t("tasks:detail.execution.review.approvalHint")}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button type="submit" size="sm" loading={isReviewing}>
                        {t("tasks:detail.execution.review.approve")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive-outline"
                        size="sm"
                        loading={isReviewing}
                        disabled={!rejectionReason.trim()}
                        onClick={() => void handleReject()}
                      >
                        {t("tasks:detail.execution.review.reject")}
                      </Button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          )}

          {evidencePayload && (
            <details className="mt-3 min-w-0 rounded-md border border-border/70">
              <summary className="cursor-pointer px-2.5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                {t("tasks:detail.execution.evidence")}
              </summary>
              <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words border-t border-border/70 bg-muted/20 p-2.5 text-[11px] leading-relaxed">
                {evidencePayload}
              </pre>
            </details>
          )}

          {runs.length > 1 && (
            <details className="mt-3 min-w-0">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                {t("tasks:detail.execution.previousRuns", {
                  count: runs.length - 1,
                })}
              </summary>
              <ul
                className="mt-2 grid min-w-0 gap-1.5"
                aria-label={t("tasks:detail.execution.previousRunsAria")}
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
