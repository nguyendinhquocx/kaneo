import { resolveApiBaseUrl } from "@kaneo/libs";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  LinkIcon,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/public-project/markdown-renderer";
import { ThemeToggle } from "@/components/public-project/theme-toggle";
import { Button } from "@/components/ui/button";

// SPEC-2026-10-08-kaneo-workspace-collaboration: public capability reader.
// Anyone holding the URL can read exactly the linked resource — no login,
// no cookies, no Tailscale. Bearer tokens never appear in page content and
// the page sends no referrer (meta referrer + server no-referrer header).

export const Route = createFileRoute("/share/$resourceType/$token")({
  component: ShareReader,
});

const apiBase = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL as string | undefined,
);

async function fetchShareResource(resourceType: string, token: string) {
  const response = await fetch(`${apiBase}/share/${resourceType}/${token}`);
  if (response.status === 404 || response.status === 403) {
    throw new Error("invalid");
  }
  if (response.status === 429) {
    throw new Error("rate-limited");
  }
  if (!response.ok) {
    throw new Error("error");
  }
  return (await response.json()) as Record<string, unknown>;
}

function ShareReader() {
  const { t } = useTranslation("share");
  const { resourceType, token } = Route.useParams();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ["share", resourceType, token],
    queryFn: () => fetchShareResource(resourceType, token),
    retry: (failureCount, err) =>
      !(err instanceof Error && err.message === "invalid") && failureCount < 2,
  });

  useEffect(() => {
    document.title = t("documentTitle");
  }, [t]);

  const isInvalid = error instanceof Error && error.message === "invalid";
  const isRateLimited =
    error instanceof Error && error.message === "rate-limited";

  return (
    // R2-T3: the root layout clips at viewport height (overflow-y-hidden),
    // so this page owns its own scroll container instead of relying on the
    // document flow (min-h-svh left long pages unreachable).
    <div className="h-svh w-full overflow-y-auto bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="sticky top-0 z-10 border-b border-border bg-background">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("badge")}
          </span>
          <div className="flex-1" />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {isLoading ? (
          <div className="space-y-3">
            <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-40 animate-pulse rounded bg-muted" />
          </div>
        ) : isInvalid ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldAlert className="size-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold text-foreground">
              {t("invalid.title")}
            </h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("invalid.description")}
            </p>
          </div>
        ) : isRateLimited ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <ShieldAlert className="size-8 text-muted-foreground" />
            <h1 className="text-lg font-semibold text-foreground">
              {t("rateLimited.title")}
            </h1>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("rateLimited.description")}
            </p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {t("rateLimited.retry")}
            </Button>
          </div>
        ) : data ? (
          resourceType === "document" ? (
            <article className="space-y-4">
              <h1 className="text-2xl font-semibold text-foreground">
                {String(data.title ?? "")}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t("document.updated", {
                  date: data.updatedAt
                    ? new Date(String(data.updatedAt)).toLocaleString(
                        undefined,
                        { dateStyle: "medium", timeStyle: "short" },
                      )
                    : "",
                })}
              </p>
              <MarkdownRenderer content={String(data.content ?? "")} />
              <p className="pt-4 text-[11px] text-muted-foreground">
                {t("document.rawHint")}
              </p>
            </article>
          ) : resourceType === "goal" ? (
            <GoalShareMatrix
              data={data as unknown as GoalShareData}
              token={token}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <LinkIcon className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t("unsupported")}
              </p>
            </div>
          )
        ) : (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <FileText className="size-8 text-muted-foreground" />
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              {t("rateLimited.retry")}
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}

type GoalShareCheckin = {
  checkInDate: string;
  completed: boolean;
  note: string;
};

type GoalShareData = {
  name: string;
  archivedAt: string | null;
  scope: "view" | "edit";
  targetPerWeek: number | null;
  checkins: GoalShareCheckin[];
};

// Monday-based week start, matching the in-app matrix.
function startOfWeek(date: Date): Date {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// R2-T8: the shared goal renders the same horizontal weekly matrix as the
// authenticated app — Mon–Sun columns, week navigation, an all-time total.
// Edit links toggle check-ins through the audited capability endpoint; view
// links get a read-only grid.
function GoalShareMatrix({
  data,
  token,
}: {
  data: GoalShareData;
  token: string;
}) {
  const { t } = useTranslation("share");
  const [weekOffset, setWeekOffset] = useState(0);
  const [checkins, setCheckins] = useState<GoalShareCheckin[]>(data.checkins);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const canEdit = data.scope === "edit" && data.archivedAt === null;

  const byDate = useMemo(
    () => new Map(checkins.map((ci) => [ci.checkInDate, ci])),
    [checkins],
  );
  const totalAllTime = checkins.filter((ci) => ci.completed).length;

  const weekStart = useMemo(() => {
    const start = startOfWeek(new Date());
    start.setDate(start.getDate() + weekOffset * 7);
    return start;
  }, [weekOffset]);
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, index) => {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + index);
        return day;
      }),
    [weekStart],
  );
  const weekdayFormatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  });
  const rangeFormatter = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  });

  const toggle = async (dateKey: string) => {
    if (!canEdit || pendingDate) return;
    const existing = byDate.get(dateKey);
    const nextCompleted = !(existing?.completed === true);
    setCheckins((current) =>
      existing
        ? current.map((ci) =>
            ci.checkInDate === dateKey
              ? { ...ci, completed: nextCompleted }
              : ci,
          )
        : [...current, { checkInDate: dateKey, completed: true, note: "" }],
    );
    setPendingDate(dateKey);
    try {
      const response = await fetch(`${apiBase}/share/goal/${token}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateKey }),
      });
      if (!response.ok) {
        throw new Error("toggle failed");
      }
    } catch {
      setCheckins((current) =>
        existing
          ? current.map((ci) => (ci.checkInDate === dateKey ? existing : ci))
          : current.filter((ci) => ci.checkInDate !== dateKey),
      );
    } finally {
      setPendingDate(null);
    }
  };

  const weekCompleted = days.filter(
    (day) => byDate.get(formatDateKey(day))?.completed === true,
  ).length;
  const notes = checkins
    .filter((ci) => ci.note)
    .sort((left, right) => right.checkInDate.localeCompare(left.checkInDate));

  return (
    <article className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{data.name}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("goal.totalAllTime", { total: totalAllTime })}
          {typeof data.targetPerWeek === "number"
            ? t("goal.perWeek", { target: data.targetPerWeek })
            : null}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={t("goal.prevWeek")}
          onClick={() => setWeekOffset((value) => value - 1)}
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-medium text-foreground">
          {rangeFormatter.format(days[0])} – {rangeFormatter.format(days[6])}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label={t("goal.nextWeek")}
          onClick={() => setWeekOffset((value) => value + 1)}
        >
          <ChevronRight className="size-3.5" />
        </Button>
        {weekOffset !== 0 ? (
          <Button variant="ghost" size="xs" onClick={() => setWeekOffset(0)}>
            {t("goal.thisWeek")}
          </Button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border/80">
        <table className="w-full min-w-max border-collapse text-sm">
          <thead>
            <tr className="border-b border-border/80">
              <th className="bg-card px-3 py-2 text-start text-xs font-medium text-muted-foreground">
                {t("goal.matrixGoal")}
              </th>
              {days.map((day) => (
                <th
                  key={formatDateKey(day)}
                  scope="col"
                  className="w-14 px-2 py-2 text-center"
                >
                  <span className="block text-[10px] font-normal text-muted-foreground">
                    {weekdayFormatter.format(day)}
                  </span>
                  <span className="block text-xs font-medium text-foreground">
                    {day.getDate()}
                  </span>
                </th>
              ))}
              <th className="w-16 px-2 py-2 text-center text-xs font-medium text-muted-foreground">
                {t("goal.totalColumn")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="max-w-48 truncate px-3 py-2.5 font-medium text-foreground">
                {data.name}
              </td>
              {days.map((day) => {
                const key = formatDateKey(day);
                const completed = byDate.get(key)?.completed === true;
                return (
                  <td key={key} className="px-2 py-2.5 text-center">
                    <input
                      type="checkbox"
                      checked={completed}
                      disabled={!canEdit || pendingDate !== null}
                      onChange={() => void toggle(key)}
                      aria-label={`${data.name} — ${key}`}
                      className="size-4 accent-[var(--primary)]"
                    />
                  </td>
                );
              })}
              <td className="px-2 py-2.5 text-center font-medium tabular-nums text-foreground">
                {weekCompleted}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {notes.length > 0 ? (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-foreground">
            {t("goal.notesTitle")}
          </h2>
          {notes.map((ci) => (
            <div
              key={ci.checkInDate}
              className="rounded-lg border border-border/80 p-2.5"
            >
              <span className="text-xs text-muted-foreground">
                {ci.checkInDate}
              </span>
              <MarkdownRenderer content={ci.note} />
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
}
