import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

export function CopyUrlButton() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy URL:", error);
      toast.error(t("publicProject:copyUrl.errorToast"));
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopyUrl}
      aria-label={
        copied
          ? t("publicProject:copyUrl.copied")
          : t("publicProject:copyUrl.share")
      }
      className="h-11 w-11 shrink-0 gap-2 p-0 sm:h-8 sm:w-auto sm:p-2"
    >
      {copied ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      <span className="hidden whitespace-nowrap text-xs sm:inline">
        {copied
          ? t("publicProject:copyUrl.copied")
          : t("publicProject:copyUrl.share")}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? t("publicProject:copyUrl.copied") : ""}
      </span>
    </Button>
  );
}
