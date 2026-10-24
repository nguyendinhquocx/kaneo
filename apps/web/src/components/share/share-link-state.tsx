import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "@/components/public-project/theme-toggle";
import { Button } from "@/components/ui/button";
import type { ShareRequestErrorKind } from "@/fetchers/share/share-request-error";

type ShareLinkStateProps = {
  kind: ShareRequestErrorKind | "loading";
  onRetry?: () => void;
};

export default function ShareLinkState({ kind, onRetry }: ShareLinkStateProps) {
  const { t } = useTranslation("share");

  const messageKey = kind === "error" ? "loadError" : kind;
  const content =
    kind === "loading" ? (
      <div className="space-y-3" role="status" aria-label={t("loading")}>
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-40 animate-pulse rounded bg-muted" />
      </div>
    ) : (
      <div
        className="flex flex-col items-center gap-3 py-16 text-center"
        role="alert"
      >
        <ShieldAlert
          aria-hidden="true"
          className="size-8 text-muted-foreground"
        />
        <h1 className="text-lg font-semibold text-foreground">
          {t(`${messageKey}.title`)}
        </h1>
        <p className="max-w-md break-words text-sm text-muted-foreground">
          {t(`${messageKey}.description`)}
        </p>
        {onRetry && kind !== "invalid" ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("rateLimited.retry")}
          </Button>
        ) : null}
      </div>
    );

  return (
    <div className="scrollbar-none min-h-svh w-full overflow-y-auto bg-background">
      <meta name="robots" content="noindex, nofollow" />
      <meta name="referrer" content="no-referrer" />
      <header className="sticky top-0 z-10 bg-background">
        <div className="mx-auto flex w-full max-w-[1600px] items-center justify-end px-4 py-2.5">
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] px-4 py-6">{content}</main>
    </div>
  );
}
