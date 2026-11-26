import { Loader2, Search } from "lucide-react";
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

// Owner polish r3: an offline bound session must still show its NAME, not a
// raw session id. The live roster forgets a session after its TTL, so the
// panel keeps a tiny local title memory (sessionId -> last seen title) and
// falls back to the raw id only when the session was never seen.
const SESSION_TITLES_KEY = "kaneo:session-titles";
// Recency-bounded memory: session-id churn cannot grow the blob forever.
const SESSION_TITLES_MAX = 64;

function readCachedSessionTitle(sessionId: string | undefined): string | null {
  if (!sessionId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_TITLES_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as unknown;
    if (typeof map !== "object" || map === null) return null;
    const title = (map as Record<string, unknown>)[sessionId];
    return typeof title === "string" && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

function rememberSessionTitle(
  sessionId: string | undefined,
  title: string | null | undefined,
) {
  if (!sessionId || !title || typeof window === "undefined") return;
  try {
    let map: Record<string, string> = {};
    try {
      const raw = window.localStorage.getItem(SESSION_TITLES_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null) {
          map = parsed as Record<string, string>;
        }
      }
    } catch {
      // Corrupted cache: rebuild instead of blocking every future write.
      map = {};
    }
    if (map[sessionId] === title) return;
    map[sessionId] = title;
    const entries = Object.entries(map);
    const bounded =
      entries.length > SESSION_TITLES_MAX
        ? Object.fromEntries(entries.slice(-SESSION_TITLES_MAX))
        : map;
    window.localStorage.setItem(SESSION_TITLES_KEY, JSON.stringify(bounded));
  } catch {
    // Cache is best-effort decoration; never break the panel over it.
  }
}

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

  // Memory for offline display: every time the bound session is live, pin its
  // title so later disconnections keep the readable name.
  useEffect(() => {
    rememberSessionTitle(bindingStatus?.sessionId, boundSession?.title ?? null);
  }, [bindingStatus?.sessionId, boundSession?.title]);

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

  // Waiting/connected/disconnected resolution for a UI-initiated bind (D4).
  // The dot is the only visual surface for this state — no status text row.
  const connectionOnline = pendingStatus === null && online;

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
      className="group flex min-h-11 w-full items-start text-left focus-visible:outline-none sm:min-h-9"
      onClick={() => {
        if (session.binding) {
          setConfirm({ kind: "rebind", session });
          return;
        }
        void handleBind(session);
      }}
    >
      {/* Hover/press highlight hugs the content only, never the full width. */}
      <span className="flex min-w-0 max-w-full flex-col gap-0.5 rounded-md px-2 py-1.5 group-focus-visible:bg-accent/50 group-hover:bg-accent/50">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            title={session.lastSeenAt}
            className="size-1.5 shrink-0 rounded-full bg-success"
          />
          <span
            className="min-w-0 truncate text-xs font-medium"
            title={session.title}
          >
            {session.title || session.sessionId}
          </span>
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
      {/* Host stays as a right-aligned plain hint — no pill chrome. */}
      <span className="ml-auto shrink-0 py-1.5 pl-2 pr-2 text-[10px] text-muted-foreground">
        {session.host}
      </span>
    </button>
  );

  const pickerContent = (
    <div className="flex flex-col">
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
      ) : (
        <>
          {/* The search box lives OUTSIDE the scroll container so scrolled
              rows can never bleed under it; it is borderless with no hint
              text — the icon alone carries the affordance. */}
          {searchVisible ? (
            <div className="px-1 pb-1">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="h-8 border-none bg-transparent pl-7 text-xs shadow-none focus-visible:ring-0"
                  aria-label={t("tasks:properties.agents.searchPlaceholder")}
                />
              </div>
            </div>
          ) : null}
          <div className="max-h-64 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("tasks:properties.agents.empty")}
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {t("tasks:properties.agents.empty")}
              </div>
            ) : (
              // Hosts are already the primary sort; a per-row right hint
              // makes the grouped heading redundant chrome.
              filteredSessions.map(renderSessionRow)
            )}
          </div>
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
              ? confirm.session.title || confirm.session.sessionId
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
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
              // Same type scale as the "Nhãn" section label at every
              // breakpoint (the Button base scales up to sm:text-sm); the
              // hover highlight hugs the text instead of the whole row.
              className="h-auto min-h-11 w-fit justify-start gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-foreground/70 hover:text-foreground sm:min-h-7 sm:text-xs"
            >
              <span className="truncate">
                {t("tasks:properties.agents.heading")}
              </span>
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

  // S2: bound — one quiet row: dot + name + right-aligned host hint and the
  // two compact actions. The connectivity state lives in the dot alone.
  const cachedTitle = readCachedSessionTitle(bindingStatus?.sessionId);
  const title =
    boundSession?.title || cachedTitle || bindingStatus?.sessionId || "";
  const hostHint = boundSession?.host || bindingStatus?.hostId || "";
  const panel = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        layout === "block" && "px-2",
        layout === "row" && "w-full px-2 pb-2",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          connectionOnline ? "bg-success" : "bg-muted-foreground/50",
        )}
      />
      {/* The dot is the only visual surface for connectivity, but screen
          readers still get a state label without any visible text row. */}
      <span className="sr-only">
        {connectionOnline
          ? t("tasks:detail.agentBinding.online")
          : t("tasks:detail.agentBinding.offline")}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
            title={title}
          >
            {title}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <span className="block max-w-64 break-all">{title}</span>
        </TooltipContent>
      </Tooltip>
      {hostHint ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {hostHint}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground sm:text-[10px]"
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
            className="h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground sm:text-[10px]"
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
          </AlertDialogHeader>
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
