import { resolveApiBaseUrl } from "@kaneo/libs";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { FileText, LinkIcon, ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "@/components/public-project/theme-toggle";
import DocumentShareReader from "@/components/share/document-share-reader";
import GoalShareReader, {
  type GoalShareData,
  SharedMarkdown,
  ShareScopeBadge,
} from "@/components/share/goal-share-reader";
import ProjectShareReader from "@/components/share/project-share-reader";
import { Button } from "@/components/ui/button";
import type { SharedDocumentPayload } from "@/fetchers/share/share-public-api";

type ProjectShareData =
  import("@/types/public-project").PublicProjectPayload & {
    scope?: "view" | "edit";
  };

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
  const pageWidthClass =
    resourceType === "project" ? "max-w-[1600px]" : "max-w-3xl";
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
    // document flow (min-h-svh left long pages unreachable). R3-T2: no
    // visible scrollbar, no header divider, no badge chrome.
    <div className="scrollbar-none h-svh w-full overflow-y-auto bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="sticky top-0 z-10 bg-background">
        <div
          className={`mx-auto flex w-full ${pageWidthClass} items-center justify-end px-4 py-2.5`}
        >
          <ThemeToggle />
        </div>
      </header>

      <main className={`mx-auto w-full ${pageWidthClass} flex-1 px-4 py-6`}>
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
          resourceType === "project" ? (
            <ProjectShareReader
              data={data as unknown as ProjectShareData}
              token={token}
            />
          ) : resourceType === "document" ? (
            <DocumentShareReader
              data={data as unknown as SharedDocumentPayload}
              token={token}
            />
          ) : resourceType === "goal" ? (
            <GoalShareReader
              data={data as unknown as GoalShareData}
              token={token}
            />
          ) : resourceType === "task_description" ? (
            <article className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-foreground">
                  {String(data.title ?? "")}
                </h1>
                {/* R4-T4: description links are view-only by contract — show
                the scope chip instead of fake edit affordances. */}
                <ShareScopeBadge scope="view" />
              </div>
              <SharedMarkdown
                content={String(data.content ?? "")}
                resourceType={resourceType}
                token={token}
              />
            </article>
          ) : resourceType === "activity_comment" ? (
            <article className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {data.createdAt
                    ? new Date(String(data.createdAt)).toLocaleString(
                        undefined,
                        { dateStyle: "medium", timeStyle: "short" },
                      )
                    : ""}
                </span>
                <ShareScopeBadge scope="view" />
              </div>
              {/* R4-T4: a comment link grants exactly this comment — no
              author identity, no avatar, no neighboring thread. */}
              <SharedMarkdown
                content={String(data.content ?? "")}
                resourceType={resourceType}
                token={token}
              />
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
    </div>
  );
}
