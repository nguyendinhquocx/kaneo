import { resolveApiBaseUrl } from "@kaneo/libs";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileText, LinkIcon, ShieldAlert } from "lucide-react";
import { useEffect } from "react";
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
    <div className="flex min-h-svh w-full flex-col bg-background">
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
            <article className="space-y-4">
              <h1 className="text-2xl font-semibold text-foreground">
                {String(data.name ?? "")}
              </h1>
              <p className="text-xs text-muted-foreground">
                {t("goal.total", {
                  total: Array.isArray(data.checkins)
                    ? (data.checkins as Array<unknown>).filter(
                        (ci) =>
                          (ci as { completed?: boolean }).completed === true,
                      ).length
                    : 0,
                  target:
                    typeof data.targetPerWeek === "number"
                      ? String(data.targetPerWeek)
                      : "—",
                })}
              </p>
              <ul className="space-y-1.5">
                {Array.isArray(data.checkins)
                  ? (
                      data.checkins as Array<{
                        checkInDate: string;
                        completed: boolean;
                        note: string;
                      }>
                    ).map((ci) => (
                      <li
                        key={ci.checkInDate}
                        className="rounded-lg border border-border/80 p-2.5"
                      >
                        <span className="text-sm text-foreground">
                          {ci.checkInDate}
                        </span>
                        <span
                          className={
                            ci.completed
                              ? "ml-2 text-xs text-success"
                              : "ml-2 text-xs text-muted-foreground"
                          }
                        >
                          {ci.completed ? t("goal.done") : t("goal.notDone")}
                        </span>
                        {ci.note ? (
                          <div className="mt-1.5">
                            <MarkdownRenderer content={ci.note} />
                          </div>
                        ) : null}
                      </li>
                    ))
                  : null}
              </ul>
            </article>
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

      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          <p className="text-xs text-muted-foreground">{t("footer")}</p>
        </div>
      </footer>
    </div>
  );
}
