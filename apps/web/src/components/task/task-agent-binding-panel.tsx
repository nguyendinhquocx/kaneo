import { ChevronRight, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentSessionRosterEntry } from "@/fetchers/agent-session/agent-session-roster";
import { useBindAgentSession } from "@/hooks/mutations/agent-session/use-bind-agent-session";
import { useUnbindAgentSession } from "@/hooks/mutations/agent-session/use-unbind-agent-session";
import { useGetAgentSessionRoster } from "@/hooks/queries/agent-session/use-get-agent-session-roster";
import { useGetTaskBindingStatus } from "@/hooks/queries/agent-session/use-get-task-binding-status";
import useGetTask from "@/hooks/queries/task/use-get-task";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

// SPEC-2026-11-25-kaneo-ui-agent-binding D4: the one "Agents" control in the
// task properties. Three states: S0 (unbound + empty roster) renders nothing
// — the card must stay pixel-identical; S1 (unbound + live sessions) offers
// a ghost picker row; S2 (bound) shows the bound session with Unbind /
// Change-session actions. Bind/unbind reuse the exact /kaneo-card endpoints;
// a rebind is a single POST — the server swaps atomically.

const SESSION_TTL_MS = 5 * 60_000;
// D4: "waiting for the session" ages into "disconnected" after 2x TTL.
export const PENDING_DISCONNECT_MS = 2 * SESSION_TTL_MS;

export type PendingBind = {
  bindingGeneration: number;
  since: number;
  observed: boolean;
};

// Resolution of the intermediate post-bind state (D4): while the new
// generation has not heartbeated yet the UI says "waiting for the session";
// after 2x TTL of silence it says "disconnected"; the moment that generation
// reports online it retires to the normal connected status.
export function resolvePendingStatus(input: {
  pending: PendingBind | null;
  bound: boolean;
  bindingGeneration?: number;
  online: boolean;
  clock: number;
}): "waiting" | "disconnected" | null {
  const { pending, bound, bindingGeneration, online, clock } = input;
  if (!pending) return null;
  const expired = clock - pending.since > PENDING_DISCONNECT_MS;
  // An older generation is never authority to resolve a newer bind, even if
  // that old row is online. A higher generation proves the server superseded
  // this mutation; an unbound response is authoritative only after the exact
  // mutation generation was observed (the bind mutation cancels pre-bind reads).
  if (
    typeof bindingGeneration === "number" &&
    bindingGeneration < pending.bindingGeneration
  ) {
    return expired ? "disconnected" : "waiting";
  }
  if (
    bindingGeneration === undefined ||
    bindingGeneration !== pending.bindingGeneration
  ) {
    if (
      bindingGeneration !== undefined &&
      bindingGeneration > pending.bindingGeneration
    )
      return null;
    if (pending.observed && !bound) return null;
    return expired ? "disconnected" : "waiting";
  }
  if (!bound)
    return pending.observed ? null : expired ? "disconnected" : "waiting";
  if (online) return null;
  return expired ? "disconnected" : "waiting";
}

type ConfirmState =
  | { kind: "rebind"; session: AgentSessionRosterEntry }
  | { kind: "unbind" }
  | null;

type TaskAgentBindingPanelProps = {
  taskId: string;
  /** "block" = desktop sidebar column, "row" = mobile full-width row. */
  layout: "block" | "row";
};

export default function TaskAgentBindingPanel({
  taskId,
  layout,
}: TaskAgentBindingPanelProps) {
  const { t } = useTranslation();
  const { data: bindingStatus } = useGetTaskBindingStatus(taskId);
  const { data: task } = useGetTask(taskId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [pending, setPending] = useState<PendingBind | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  const bound = bindingStatus?.bound === true;
  const online = bindingStatus?.online === true;

  const bindMutation = useBindAgentSession();
  const unbindMutation = useUnbindAgentSession();
  // Fetch once on mount in both bound and unbound states: unbound needs S0/S1,
  // while bound needs exact roster metadata for the current session. No poll.
  const roster = useGetAgentSessionRoster();

  const pendingStatus = resolvePendingStatus({
    pending,
    bound,
    bindingGeneration: bindingStatus?.bindingGeneration,
    online,
    clock,
  });

  // Re-render at most once per 15s while the bind is still "waiting" so the
  // label can age into "disconnected"; the interval dies once resolved.
  useEffect(() => {
    if (!pending || pendingStatus !== "waiting") return;
    const timer = setInterval(() => setClock(Date.now()), 15_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [pending, pendingStatus]);

  // Retire only after status has observed the mutation's generation. A stale
  // old/unbound cache cannot resolve the intermediate state; after observation,
  // a connected status or a later server-side change may retire it.
  useEffect(() => {
    if (!pending) return;
    const generation = bindingStatus?.bindingGeneration;
    const matchingGeneration = generation === pending.bindingGeneration;
    const superseded =
      typeof generation === "number" && generation > pending.bindingGeneration;
    const confirmedUnbound = pending.observed && bindingStatus?.bound === false;

    if (
      pendingStatus === null &&
      (matchingGeneration || superseded || confirmedUnbound)
    ) {
      setPending(null);
      return;
    }
    if (matchingGeneration && !pending.observed) {
      setPending({ ...pending, observed: true });
    }
  }, [
    pending,
    pendingStatus,
    bindingStatus?.bindingGeneration,
    bindingStatus?.bound,
  ]);

  const sessions = useMemo(() => {
    const all = roster.data?.sessions ?? [];
    // The roster is TTL-filtered server-side; filter again so a stale cache
    // can never offer an offline session for binding or metadata.
    const cutoff = clock - SESSION_TTL_MS;
    return all
      .filter((session) => Date.parse(session.lastSeenAt) > cutoff)
      .sort(
        (a, b) =>
          a.host.localeCompare(b.host) ||
          b.lastSeenAt.localeCompare(a.lastSeenAt),
      );
    // `clock` keeps the TTL filter honest between fetches.
  }, [roster.data, clock]);

  // A bound session is only considered available when its exact session ID is
  // still present in the live TTL-filtered roster. Never infer metadata from a
  // different row or from the binding's host label.
  const boundSession = useMemo(
    () =>
      bindingStatus?.sessionId
        ? sessions.find(
            (session) => session.sessionId === bindingStatus.sessionId,
          )
        : undefined,
    [sessions, bindingStatus?.sessionId],
  );

  // Re-filter an open picker locally at the next roster TTL boundary. This is
  // a one-shot timer, not network polling; changing `clock` schedules the next
  // nearest expiry if more than one session remains.
  useEffect(() => {
    const now = clock;
    const nextExpiry = (roster.data?.sessions ?? [])
      .map((session) => Date.parse(session.lastSeenAt) + SESSION_TTL_MS)
      .filter((expiresAt) => expiresAt > now)
      .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;
    const timer = setTimeout(
      () => setClock(Date.now()),
      Math.max(0, nextExpiry - now),
    );
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [roster.data, clock]);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) =>
      [session.title, session.host, session.cwd]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [sessions, search]);

  const groupedByHost = useMemo(() => {
    const groups = new Map<string, AgentSessionRosterEntry[]>();
    for (const session of filteredSessions) {
      const group = groups.get(session.host) ?? [];
      group.push(session);
      groups.set(session.host, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredSessions]);

  const handleBind = async (session: AgentSessionRosterEntry) => {
    setPickerOpen(false);
    setSearch("");
    try {
      const binding = await bindMutation.mutateAsync({
        taskId,
        agentPrincipalId: session.agentPrincipalId,
        sessionId: session.sessionId,
      });
      setPending({
        bindingGeneration: binding.bindingGeneration,
        since: Date.now(),
        observed: false,
      });
      setClock(Date.now());
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `${t("tasks:properties.agents.bindFailed")}: ${error.message}`
          : t("tasks:properties.agents.bindFailed"),
      );
    }
  };

  const handleUnbind = async () => {
    if (
      !bindingStatus?.bindingId ||
      !bindingStatus.sessionId ||
      bindingStatus.bindingGeneration === undefined
    ) {
      return;
    }
    try {
      await unbindMutation.mutateAsync({
        bindingId: bindingStatus.bindingId,
        sessionId: bindingStatus.sessionId,
        generation: bindingStatus.bindingGeneration,
      });
      setPending(null);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `${t("tasks:properties.agents.unbindFailed")}: ${error.message}`
          : t("tasks:properties.agents.unbindFailed"),
      );
    }
  };

  const sessionContextLabel = (session: AgentSessionRosterEntry) =>
    t("tasks:properties.agents.sessionContext", {
      cwd: session.cwd || "—",
      model: session.model || "—",
      host: session.host,
    });

  const affectedCardLabel = (session: AgentSessionRosterEntry) =>
    t("tasks:properties.agents.affectedCard", {
      number: session.binding?.taskNumber ?? "?",
      title: session.binding?.taskTitle ?? "",
    });

  // Waiting/connected/disconnected resolution for a UI-initiated bind (D4).
  const pendingLabel = pendingStatus
    ? t(`tasks:properties.agents.${pendingStatus}`)
    : null;
  const connectionOnline = pendingStatus === null && online;
  // The connectivity indicator must follow the same resolution as the label:
  // while a pending bind is unresolved, a stale generation's online bit must
  // not paint the session as connected.

  // S0: successful empty roster keeps the card pixel-identical. An initial
  // load failure is different: expose an accessible retry so the empty cache
  // does not hide a recoverable error.
  if (!bound && sessions.length === 0) {
    if (roster.isError) {
      return (
        <div className="flex min-h-11 items-center justify-between gap-2 px-1.5 text-xs text-muted-foreground">
          <span role="status">{t("tasks:properties.agents.loadError")}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void roster.refetch()}
          >
            {t("tasks:properties.agents.retry")}
          </Button>
        </div>
      );
    }
    return null;
  }

  const searchVisible = sessions.length >= 8;

  const renderSessionRow = (session: AgentSessionRosterEntry) => (
    <button
      key={session.sessionId}
      type="button"
      className="group flex min-h-11 w-full rounded-md text-left focus-visible:outline-none sm:min-h-9"
      onClick={() => {
        if (session.binding) {
          setConfirm({ kind: "rebind", session });
          return;
        }
        void handleBind(session);
      }}
    >
      <span className="flex w-fit max-w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 group-focus-visible:bg-accent/50 group-hover:bg-accent/50">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            title={session.lastSeenAt}
            className="size-1.5 shrink-0 rounded-full bg-success"
          />
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium"
            title={session.title}
          >
            {session.title || session.sessionId}
          </span>
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px]">
            {session.host}
          </Badge>
        </span>
        <span
          className="truncate pl-3 text-[10px] text-muted-foreground"
          title={session.cwd}
        >
          {session.cwd}
          {session.binding
            ? ` · #${session.binding.taskNumber ?? "?"} ${session.binding.taskTitle ?? ""}`
            : ""}
        </span>
      </span>
    </button>
  );

  const pickerContent = (
    <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {roster.isLoading ? (
        <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>{t("tasks:properties.agents.loading")}</span>
        </div>
      ) : roster.isError ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <span>{t("tasks:properties.agents.loadError")}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => void roster.refetch()}
          >
            {t("tasks:properties.agents.retry")}
          </Button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">
          {t("tasks:properties.agents.empty")}
        </div>
      ) : (
        <>
          {searchVisible ? (
            <div className="sticky top-0 bg-popover pb-1">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("tasks:properties.agents.searchPlaceholder")}
                  className="h-8 pl-7 text-xs"
                  aria-label={t("tasks:properties.agents.searchPlaceholder")}
                />
              </div>
            </div>
          ) : null}
          {groupedByHost.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {t("tasks:properties.agents.empty")}
            </div>
          ) : (
            groupedByHost.map(([host, group]) => (
              <div key={host} className="flex flex-col gap-0.5">
                <span className="px-2 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {host}
                </span>
                {group.map(renderSessionRow)}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );

  const rebindDialog = (
    <AlertDialog
      open={confirm?.kind === "rebind"}
      onOpenChange={(open) => {
        if (!open) setConfirm(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("tasks:properties.agents.rebindTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirm?.kind === "rebind"
              ? t("tasks:properties.agents.rebindBody", {
                  sessionId: confirm.session.sessionId,
                  number: confirm.session.binding?.taskNumber ?? "?",
                  cardTitle: confirm.session.binding?.taskTitle ?? "",
                })
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {confirm?.kind === "rebind" ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>{sessionContextLabel(confirm.session)}</span>
            <span>{affectedCardLabel(confirm.session)}</span>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose
            render={<Button type="button" variant="outline" size="sm" />}
          >
            {t("common:actions.cancel")}
          </AlertDialogClose>
          <AlertDialogClose
            render={<Button type="button" size="sm" />}
            onClick={() => {
              if (confirm?.kind === "rebind") void handleBind(confirm.session);
            }}
          >
            {t("tasks:properties.agents.change")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // S1: unbound with at least one live session — a quiet property-row trigger
  // matching the sibling "Marker" ghost button (same type scale, no noise).
  if (!bound) {
    const count = sessions.length;
    const accessibleLabel = `${t("tasks:properties.agents.assign")} · ${t(
      "tasks:properties.agents.runningCount",
      { count },
    )}`;
    return (
      <>
        <Popover
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            // D4: a stale cache is refreshed the moment the picker opens.
            if (open && roster.isStale) void roster.refetch();
            if (!open) setSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={accessibleLabel}
              aria-haspopup="dialog"
              className="h-auto min-h-11 w-full justify-start gap-1.5 px-2 py-1 text-left text-xs font-medium sm:min-h-7 sm:w-full"
            >
              <span className="truncate">
                {t("tasks:properties.agents.heading")}
              </span>
              <ChevronRight
                className="ml-auto size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 p-1"
            aria-label={t("tasks:properties.agents.pickerLabel")}
          >
            {pickerContent}
          </PopoverContent>
        </Popover>
        {rebindDialog}
      </>
    );
  }

  // S2: bound — dot/title/host/model + Unbind / Change (focus/tap reachable).
  const metadataUnavailable = !roster.isLoading && !boundSession;
  const unavailableLabel = t(
    "tasks:properties.agents.sessionDetailsUnavailable",
  );
  const statusText =
    pendingLabel ??
    (online
      ? t("tasks:detail.agentBinding.online")
      : t("tasks:detail.agentBinding.offline"));
  const title =
    boundSession?.title || bindingStatus?.sessionId || unavailableLabel;
  const panel = (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1",
        layout === "block" && "px-2",
        layout === "row" && "w-full px-2 pb-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            connectionOnline ? "bg-success" : "bg-muted-foreground/50",
          )}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={title}
              className="min-w-0 appearance-none truncate rounded-sm border-0 bg-transparent p-0 text-left text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              title={title}
            >
              {title}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="block max-w-64 break-all">{title}</span>
          </TooltipContent>
        </Tooltip>
        {bindingStatus?.hostId ? (
          <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px]">
            {bindingStatus.hostId}
          </Badge>
        ) : null}
      </div>
      {metadataUnavailable ? (
        <span className="text-[10px] text-muted-foreground" role="status">
          {t("tasks:properties.agents.sessionDetailsUnavailable")}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="text-[10px] text-muted-foreground" role="status">
          {statusText}
        </span>
        <span className="min-w-2 flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[10px]"
          disabled={unbindMutation.isPending}
          onClick={() => setConfirm({ kind: "unbind" })}
        >
          {t("tasks:properties.agents.unbind")}
        </Button>
        <Popover
          open={pickerOpen}
          onOpenChange={(open) => {
            setPickerOpen(open);
            if (open && roster.isStale) void roster.refetch();
            if (!open) setSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[10px]"
            >
              {t("tasks:properties.agents.change")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 p-1"
            aria-label={t("tasks:properties.agents.pickerLabel")}
          >
            {pickerContent}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );

  return (
    <>
      {panel}
      {rebindDialog}
      <AlertDialog
        open={confirm?.kind === "unbind"}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("tasks:properties.agents.unbindTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("tasks:properties.agents.unbindBody", {
                sessionId: bindingStatus?.sessionId ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>
              {t("tasks:properties.agents.affectedCard", {
                number: task?.number ?? "?",
                title: task?.title ?? "",
              })}
            </span>
            <span>
              {t("tasks:properties.agents.sessionContext", {
                cwd: boundSession?.cwd || unavailableLabel,
                model: boundSession?.model || unavailableLabel,
                host: bindingStatus?.hostId || unavailableLabel,
              })}
            </span>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button type="button" variant="outline" size="sm" />}
            >
              {t("common:actions.cancel")}
            </AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  type="button"
                  size="sm"
                  disabled={unbindMutation.isPending}
                />
              }
              onClick={() => {
                void handleUnbind();
              }}
            >
              {t("tasks:properties.agents.unbind")}
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
