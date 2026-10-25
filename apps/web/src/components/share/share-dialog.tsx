import { Check, Copy, Link2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
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
  canCreateFull?: boolean;
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
  canCreateFull = false,
}: ShareDialogProps) {
  const { t } = useTranslation("share");
  const { data: links = [] } = useGetShareLinks(resourceType, resourceId);
  const createLink = useCreateShareLink();
  const revokeLink = useRevokeShareLink();
  const [permission, setPermission] = useState<"view" | "edit" | "full">(
    "view",
  );
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [legacyLinkId, setLegacyLinkId] = useState<string | null>(null);
  const supportsEdit =
    resourceType === "project" ||
    resourceType === "document" ||
    resourceType === "goal";
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const newLink = createLink.data;

  if (!canShare) {
    return null;
  }

  const handleCreate = () => {
    createLink.mutate(
      {
        resourceType,
        resourceId,
        permission: supportsEdit ? permission : "view",
      },
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
                toast.error(t("errors.copyFailed"));
              });
          } catch {
            // Clipboard API unavailable — the URL stays selected in the input.
          }
        },
        onError: () => toast.error(t("errors.createFailed")),
      },
    );
  };

  const handleCopy = async (url: string, rowId = url) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(rowId);
      window.setTimeout(() => setCopiedUrl(null), 1800);
      return true;
    } catch {
      toast.error(t("errors.copyFailed"));
      return false;
    }
  };

  const handleReplaceLegacy = async () => {
    const legacy = links.find((link) => link.id === legacyLinkId);
    if (!legacy) return;
    try {
      const created = await createLink.mutateAsync({
        resourceType,
        resourceId,
        permission: legacy.permission,
      });
      if (!(await handleCopy(created.url))) return;
      setLegacyLinkId(null);
    } catch {
      toast.error(t("errors.replaceFailed"));
    }
  };

  return (
    <>
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
        <DialogContent className="w-[calc(100vw-2rem)] max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
          </DialogHeader>

          {/* R3-T4: content padding mirrors the header (p-6) so rows and the
        URL input never touch the rounded border. */}
          <div className="space-y-3 p-6 pt-0">
            <div className="space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 gap-0.5 rounded-lg border border-border/80 bg-background p-0.5">
                  <Button
                    variant={permission === "view" ? "secondary" : "ghost"}
                    size="xs"
                    onClick={() => setPermission("view")}
                    className="min-h-11 min-w-0 flex-1 whitespace-normal px-1 text-center text-xs sm:min-h-8"
                  >
                    {t("permission.view")}
                  </Button>
                  {supportsEdit ? (
                    <Button
                      variant={permission === "edit" ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => setPermission("edit")}
                      className="min-h-11 min-w-0 flex-1 whitespace-normal px-1 text-center text-xs sm:min-h-8"
                    >
                      {t("permission.edit")}
                    </Button>
                  ) : null}
                  {resourceType === "project" && canCreateFull ? (
                    <Button
                      variant={permission === "full" ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => setPermission("full")}
                      className="min-h-11 min-w-0 flex-1 whitespace-normal px-1 text-center text-xs sm:min-h-8"
                    >
                      {t("permission.full")}
                    </Button>
                  ) : null}
                </div>
                <Button
                  size="xs"
                  className="min-h-11 w-full sm:w-auto sm:min-h-6"
                  onClick={handleCreate}
                  disabled={createLink.isPending}
                >
                  {createLink.isPending ? t("creating") : t("create")}
                </Button>
              </div>
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
                      {link.permission === "full"
                        ? t("permission.full")
                        : link.permission === "edit"
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
                      className="size-11 shrink-0 p-0 sm:size-7"
                      aria-label={
                        link.url ? t("copy") : t("legacy.copyReplacement")
                      }
                      title={link.url ? t("copy") : t("legacy.copyReplacement")}
                      disabled={createLink.isPending || revokeLink.isPending}
                      onClick={() => {
                        if (link.url) void handleCopy(link.url, link.id);
                        else setLegacyLinkId(link.id);
                      }}
                    >
                      {copiedUrl === link.id ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </Button>
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
      <AlertDialog
        open={legacyLinkId !== null}
        onOpenChange={(open) => !open && setLegacyLinkId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("legacy.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("legacy.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>
              <Button variant="outline" size="sm">
                {t("legacy.cancel")}
              </Button>
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={createLink.isPending || revokeLink.isPending}
              onClick={() => void handleReplaceLegacy()}
            >
              {t("legacy.replace")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
