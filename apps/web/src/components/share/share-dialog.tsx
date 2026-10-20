import { Copy, Link2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type ShareResourceType,
  useCreateShareLink,
  useGetShareLinks,
  useRevokeShareLink,
} from "@/hooks/mutations/share/use-share-links";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

type ShareDialogProps = {
  resourceType: ShareResourceType;
  resourceId: string;
  canShare: boolean;
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function ShareDialog({
  resourceType,
  resourceId,
  canShare,
}: ShareDialogProps) {
  const { t } = useTranslation("share");
  const { data: links = [] } = useGetShareLinks(resourceType, resourceId);
  const createLink = useCreateShareLink();
  const revokeLink = useRevokeShareLink();
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const newLink = createLink.data;

  if (!canShare) {
    return null;
  }

  const handleCreate = () => {
    createLink.mutate(
      { resourceType, resourceId, permission },
      {
        onSuccess: (created) => {
          // UAT: the one-time URL was easy to miss at the bottom of the
          // dialog — surface it right under the actions and pre-select it.
          window.setTimeout(() => {
            urlInputRef.current?.focus();
            urlInputRef.current?.select();
          }, 50);
          // Reviewer P2: writeText rejects asynchronously when the clipboard
          // is denied — only claim "copied" once it actually resolved.
          try {
            void navigator.clipboard
              .writeText(created.url)
              .then(() => {
                setCopiedUrl(created.url);
                window.setTimeout(() => setCopiedUrl(null), 2000);
              })
              .catch(() => {
                // Clipboard unavailable — the URL stays selected in the input.
              });
          } catch {
            // Clipboard API unavailable — the URL stays selected in the input.
          }
        },
        onError: () => toast.error(t("errors.createFailed")),
      },
    );
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      window.setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // Clipboard unavailable — the URL stays selectable in the input.
    }
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-11 min-h-11 gap-1.5 text-xs sm:h-7 sm:min-h-0"
          >
            <Link2 className="size-3.5" />
            {t("manage")}
          </Button>
        }
      />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        {/* R3-T4: content padding mirrors the header (p-6) so rows and the
        URL input never touch the rounded border. */}
        <div className="space-y-3 p-6 pt-0">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-0.5 rounded-lg border border-border/80 bg-background p-0.5">
              <Button
                variant={permission === "view" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setPermission("view")}
                className="h-11 flex-1 text-xs sm:h-6"
              >
                {t("permission.view")}
              </Button>
              <Button
                variant={permission === "edit" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setPermission("edit")}
                className="h-11 flex-1 text-xs sm:h-6"
              >
                {t("permission.edit")}
              </Button>
            </div>
            <Button
              size="xs"
              className="min-h-11 sm:min-h-6"
              onClick={handleCreate}
              disabled={createLink.isPending}
            >
              {createLink.isPending ? t("creating") : t("create")}
            </Button>
          </div>

          {newLink ? (
            <div className="space-y-1.5 rounded-lg border border-border/80 bg-muted/40 p-2.5">
              <p className="text-[11px] text-muted-foreground">
                {t("copyHint")}
              </p>
              <div className="flex items-center gap-1.5">
                <Input
                  ref={urlInputRef}
                  readOnly
                  value={newLink.url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-7 font-mono text-[11px]"
                />
                <Button
                  variant="secondary"
                  size="xs"
                  className="h-11 gap-1.5 sm:h-7"
                  onClick={() => handleCopy(newLink.url)}
                >
                  <Copy className="size-3.5" />
                  {copiedUrl === newLink.url ? t("copied") : t("copy")}
                </Button>
              </div>
            </div>
          ) : null}

          {links.length > 0 ? (
            <div className="space-y-2">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-lg border border-border/80 p-2.5"
                >
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-medium",
                      link.permission === "edit"
                        ? "bg-warning/20 text-warning-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {link.permission === "edit"
                      ? t("permission.edit")
                      : t("permission.view")}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {link.expiresAt
                      ? t("expires", { date: formatDate(link.expiresAt) ?? "" })
                      : t("neverExpires")}
                  </span>
                  <div className="flex-1" />
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-11 p-0 sm:size-7"
                    aria-label={t("revoke")}
                    title={t("revoke")}
                    disabled={revokeLink.isPending}
                    onClick={() =>
                      revokeLink.mutate(link.id, {
                        onError: () => toast.error(t("errors.revokeFailed")),
                      })
                    }
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
