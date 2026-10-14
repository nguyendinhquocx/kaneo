import { Copy, Link2, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

type ShareDialogProps = {
  resourceType: ShareResourceType;
  resourceId: string;
  resourceLabel: string;
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
  resourceLabel,
  canShare,
}: ShareDialogProps) {
  const { t } = useTranslation("share");
  const { data: links = [] } = useGetShareLinks(resourceType, resourceId);
  const createLink = useCreateShareLink();
  const revokeLink = useRevokeShareLink();
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [editConfirmed, setEditConfirmed] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  if (!canShare) {
    return null;
  }

  const handleCreate = () => {
    if (permission === "edit" && !editConfirmed) {
      setEditConfirmed(true);
      return;
    }
    setEditConfirmed(false);
    createLink.mutate({ resourceType, resourceId, permission });
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

  const activeLinks = links;

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs">
            <Link2 className="size-3.5" />
            {t("manage")}
          </Button>
        }
      />
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title", { name: resourceLabel })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex flex-1 gap-0.5 rounded-lg border border-border/80 bg-background p-0.5">
              <Button
                variant={permission === "view" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setPermission("view")}
                className="h-6 flex-1 text-xs"
              >
                {t("permission.view")}
              </Button>
              <Button
                variant={permission === "edit" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setPermission("edit")}
                className="h-6 flex-1 text-xs"
              >
                {t("permission.edit")}
              </Button>
            </div>
            <Button
              size="xs"
              onClick={handleCreate}
              disabled={createLink.isPending}
            >
              {createLink.isPending ? t("creating") : t("create")}
            </Button>
          </div>

          {permission === "edit" && editConfirmed && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
              <p className="text-xs text-foreground">{t("editWarning")}</p>
            </div>
          )}

          <div className="space-y-2">
            {activeLinks.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("empty")}</p>
            ) : (
              activeLinks.map((link) => (
                <div
                  key={link.id}
                  className="space-y-1.5 rounded-lg border border-border/80 p-2.5"
                >
                  <div className="flex items-center gap-2">
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
                        ? t("expires", {
                            date: formatDate(link.expiresAt) ?? "",
                          })
                        : t("neverExpires")}
                    </span>
                    <div className="flex-1" />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("revoke")}
                      disabled={revokeLink.isPending}
                      onClick={() => revokeLink.mutate(link.id)}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                  {link.revokedAt ? (
                    <p className="text-[11px] text-muted-foreground">
                      {t("revoked")}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {createLink.data ? (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground">
                {t("copyHint")}
              </p>
              <div className="flex items-center gap-1.5">
                <Input
                  readOnly
                  value={createLink.data.url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-7 font-mono text-[11px]"
                />
                <Button
                  variant="secondary"
                  size="xs"
                  className="h-7 gap-1.5"
                  onClick={() => handleCopy(createLink.data.url)}
                >
                  <Copy className="size-3.5" />
                  {copiedUrl === createLink.data.url ? t("copied") : t("copy")}
                </Button>
              </div>
              {createLink.data.permission === "edit" ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("editScopeNote")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
