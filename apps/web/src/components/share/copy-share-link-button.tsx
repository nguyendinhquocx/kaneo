import { Check, Copy } from "lucide-react";
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
  type ShareResourceType,
  useCreateShareLink,
  useGetShareLinks,
} from "@/hooks/mutations/share/use-share-links";
import { toast } from "@/lib/toast";

export function CopyShareLinkButton({
  resourceType,
  resourceId,
  canShare,
  label,
}: {
  resourceType: ShareResourceType;
  resourceId: string;
  canShare: boolean;
  label: string;
}) {
  const { t } = useTranslation("share");
  const { data: links = [] } = useGetShareLinks(
    resourceType,
    canShare ? resourceId : null,
  );
  const createLink = useCreateShareLink();
  const [legacyLinkId, setLegacyLinkId] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const activeLinks = links.filter((link) => !link.revokedAt);
  const copyableLink = activeLinks.find((link) => Boolean(link.url));
  const legacyLink = activeLinks.find((link) => link.url === null);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setIsCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setIsCopied(false), 1800);
      return true;
    } catch {
      toast.error(t("errors.copyFailed"));
      return false;
    }
  };

  const handleCopy = async () => {
    if (copyableLink?.url) {
      await copy(copyableLink.url);
      return;
    }
    if (legacyLink) {
      setLegacyLinkId(legacyLink.id);
      return;
    }
    try {
      const created = await createLink.mutateAsync({
        resourceType,
        resourceId,
        permission: "view",
      });
      await copy(created.url);
    } catch {
      toast.error(t("errors.createFailed"));
    }
  };

  const handleReplaceLegacy = async () => {
    if (!legacyLink || legacyLink.id !== legacyLinkId) return;
    try {
      const created = await createLink.mutateAsync({
        resourceType,
        resourceId,
        permission: legacyLink.permission,
      });
      if (!(await copy(created.url))) return;
      setLegacyLinkId(null);
    } catch {
      toast.error(t("errors.replaceFailed"));
    }
  };

  if (!canShare) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-11 p-0 sm:size-8"
        aria-label={isCopied ? t("copied") : label}
        title={isCopied ? t("copied") : label}
        disabled={createLink.isPending}
        onClick={() => void handleCopy()}
      >
        {isCopied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {isCopied ? t("copied") : ""}
      </span>
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
              disabled={createLink.isPending}
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
