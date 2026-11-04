import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

// If the frame is still loading after this long, surface a hint — browsers
// do not reliably fire iframe error events for DNS/CSP/X-Frame-Options
// failures, so the hint is the dependable recovery path (never a mode switch).
const SLOW_FRAME_HINT_MS = 8000;

type EmbeddedFrameProps = {
  src: string;
  title: string;
  /** URL for the always-available "open in its own tab" recovery action. */
  externalUrl: string;
  className?: string;
  testId?: string;
};

/**
 * Embedded service frame with explicit loading, error and recovery states.
 * A failed load never silently retries and never infers the view mode — the
 * configured mode stays authoritative; this only offers recovery actions.
 */
export default function EmbeddedFrame({
  src,
  title,
  externalUrl,
  className,
  testId,
}: EmbeddedFrameProps) {
  const { t } = useTranslation("embedded");
  const [reloadKey, setReloadKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [showSlowHint, setShowSlowHint] = useState(false);

  useEffect(() => {
    if (!isLoading) {
      setShowSlowHint(false);
      return;
    }
    const timer = setTimeout(() => setShowSlowHint(true), SLOW_FRAME_HINT_MS);
    return () => clearTimeout(timer);
  }, [isLoading, reloadKey]);

  if (hasError) {
    return (
      <div
        role="status"
        className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 py-10 text-center"
      >
        <p className="text-sm font-medium text-foreground">{t("frameError")}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11"
            onClick={() => {
              setHasError(false);
              setIsLoading(true);
              setReloadKey((key) => key + 1);
            }}
          >
            <RefreshCw className="size-4" />
            {t("retry")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:min-h-11"
            render={
              <a href={externalUrl} target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLink className="size-4" />
            {t("openExternally")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("relative h-full w-full", className)}>
      {isLoading && (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-4 text-center"
        >
          <span className="text-sm text-muted-foreground">{t("loading")}</span>
          {showSlowHint && (
            <span className="max-w-md text-xs text-muted-foreground">
              {t("frameSlowHint")}
            </span>
          )}
        </div>
      )}
      <iframe
        key={reloadKey}
        src={src}
        title={title}
        data-testid={testId}
        onLoad={() => setIsLoading(false)}
        onError={() => {
          setIsLoading(false);
          setHasError(true);
        }}
        className="h-full w-full border-0 bg-background"
      />
    </div>
  );
}
