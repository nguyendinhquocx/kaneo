import { Send } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSendCommentToPi } from "@/hooks/mutations/agent-session/use-send-comment-to-pi";
import { useGetTaskBindingStatus } from "@/hooks/queries/agent-session/use-get-task-binding-status";
import { useGetCommentDeliveryStatus } from "@/hooks/queries/agent-session/use-get-comment-delivery-status";
import type { CommentDeliveryState } from "@/fetchers/agent-session/comment-delivery";

export default function SendCommentToPiAction({
  taskId,
  commentId,
}: {
  taskId: string;
  commentId: string;
}) {
  const { t } = useTranslation();
  const binding = useGetTaskBindingStatus(taskId);
  const [deliveryId, setDeliveryId] = useState<string>();
  const [lastState, setLastState] = useState<CommentDeliveryState>();
  const [showUnknownWarning, setShowUnknownWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionKey = useRef<string | null>(null);
  const send = useSendCommentToPi();
  const delivery = useGetCommentDeliveryStatus(
    binding.data?.bindingId,
    deliveryId,
  );

  const state = delivery.data?.state ?? lastState;
  const bindingData = binding.data;
  const bindingId = bindingData?.bindingId;
  const sessionId = bindingData?.sessionId;
  const bindingGeneration = bindingData?.bindingGeneration;
  const hostId = bindingData?.hostId ?? "";
  const isActive = state === "queued" || state === "claimed";
  const isUnknown = state === "unknown";

  if (
    !bindingData?.bound ||
    !bindingData.online ||
    !bindingId ||
    !sessionId ||
    bindingGeneration === undefined
  ) {
    return null;
  }
  const targetLabel = t("activity:comment.sendToPiTarget", {
    sessionId,
    host: hostId,
  });

  const handleSend = async () => {
    if (isUnknown && !showUnknownWarning) {
      setShowUnknownWarning(true);
      return;
    }
    const key = actionKey.current ?? globalThis.crypto.randomUUID();
    actionKey.current = key;
    setError(null);
    try {
      const result = await send.mutateAsync({
        bindingId,
        sessionId,
        generation: bindingGeneration,
        commentId,
        clientActionKey: key,
      });
      setDeliveryId(result.receipt.deliveryId);
      setLastState(result.receipt.state);
      // A successful receipt ends this intent. Any later click is an explicit
      // resend with a new action key; transport errors keep this key for retry.
      actionKey.current = null;
      setShowUnknownWarning(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : t("activity:comment.sendToPiFailed"),
      );
    }
  };

  const statusText = state ? t(`activity:comment.delivery.${state}`) : null;
  const isPending = send.isPending || isActive;
  const label = isPending
    ? t("activity:comment.sendingToPi")
    : deliveryId || state
      ? t("activity:comment.resendToPi")
      : t("activity:comment.sendToPi");

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-11 p-0 sm:size-8"
            aria-label={`${label} — ${targetLabel}`}
            title={`${label} — ${targetLabel}`}
            aria-busy={isPending}
            disabled={isPending}
            onClick={() => void handleSend()}
          >
            <Send className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <span className="block">{label}</span>
          <span className="block text-[10px] text-muted-foreground">
            {targetLabel}
          </span>
        </TooltipContent>
      </Tooltip>
      {showUnknownWarning ? (
        <span className="max-w-56 text-right text-[10px] text-warning-foreground" role="alert">
          {t("activity:comment.unknownResendWarning")}
        </span>
      ) : null}
      {statusText ? (
        <span className="max-w-56 text-right text-[10px] text-muted-foreground" role="status" aria-live="polite">
          {statusText}
        </span>
      ) : null}
      {error ? (
        <span className="max-w-56 text-right text-[10px] text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
