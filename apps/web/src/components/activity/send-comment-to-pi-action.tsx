import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CommentDeliveryState } from "@/fetchers/agent-session/comment-delivery";
import { useSendCommentToPi } from "@/hooks/mutations/agent-session/use-send-comment-to-pi";
import { useGetCommentDeliveryByComment } from "@/hooks/queries/agent-session/use-get-comment-delivery-by-comment";
import { useGetCommentDeliveryStatus } from "@/hooks/queries/agent-session/use-get-comment-delivery-status";
import { useGetTaskBindingStatus } from "@/hooks/queries/agent-session/use-get-task-binding-status";

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
  const [transientState, setTransientState] = useState<CommentDeliveryState>();
  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showUnknownWarning, setShowUnknownWarning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionKey = useRef<string | null>(null);
  const send = useSendCommentToPi();
  const liveDelivery = useGetCommentDeliveryStatus(
    binding.data?.bindingId,
    deliveryId,
  );
  // After a reload the local receipt is gone; restore the latest server
  // receipt for this comment so queued/unknown state stays visible.
  const restoredDelivery = useGetCommentDeliveryByComment(
    binding.data?.bindingId,
    commentId,
  );

  const state =
    liveDelivery.data?.state ??
    lastState ??
    restoredDelivery.data?.delivery?.state;
  const bindingData = binding.data;
  const bindingId = bindingData?.bindingId;
  const sessionId = bindingData?.sessionId;
  const bindingGeneration = bindingData?.bindingGeneration;
  const hostId = bindingData?.hostId ?? "";
  const isActive = state === "queued" || state === "claimed";
  const isUnknown = state === "unknown";
  const isPending = send.isPending || isActive;
  const dotState =
    state === "enqueued"
      ? "reached"
      : isPending || state === "unknown"
        ? "waiting"
        : null;

  useEffect(
    () => () => {
      if (transientTimer.current) clearTimeout(transientTimer.current);
    },
    [],
  );

  const showTransientNotice = (nextState: CommentDeliveryState) => {
    if (transientTimer.current) clearTimeout(transientTimer.current);
    setTransientState(nextState);
    transientTimer.current = setTimeout(() => {
      setTransientState(undefined);
      transientTimer.current = null;
    }, 3_000);
  };

  // R1-T4: the affordance must stay visible even without a live binding —
  // a hidden button reads as "the feature does not exist" during UAT.
  // Disabled with a direct hint instead of vanishing.
  if (
    !bindingData?.bound ||
    !bindingData.online ||
    !bindingId ||
    !sessionId ||
    bindingGeneration === undefined
  ) {
    const hintKey = bindingData?.bound
      ? "activity:comment.sendToPiOffline"
      : "activity:comment.sendToPiUnbound";
    const hint = t(hintKey);
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-11 p-0 opacity-40 sm:size-8"
              aria-label={hint}
              title={hint}
              aria-disabled="true"
              disabled
            >
              <Send className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span className="block max-w-64 text-[10px] text-muted-foreground">
              {hint}
            </span>
          </TooltipContent>
        </Tooltip>
      </span>
    );
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
    if (transientTimer.current) clearTimeout(transientTimer.current);
    transientTimer.current = null;
    setTransientState(undefined);
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
      showTransientNotice(result.receipt.state);
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

  const statusText = state
    ? t(`activity:comment.delivery.${state}`)
    : send.isPending
      ? t("activity:comment.sendingToPi")
      : null;
  const transientText = transientState
    ? t(`activity:comment.delivery.${transientState}`)
    : null;
  const label = isPending
    ? t("activity:comment.sendingToPi")
    : deliveryId || state
      ? t("activity:comment.resendToPi")
      : t("activity:comment.sendToPi");

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-11 p-0 sm:size-8"
              aria-label={`${label} — ${targetLabel}`}
              title={`${label} — ${targetLabel}${statusText ? ` — ${statusText}` : ""}`}
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
        {dotState ? (
          <span
            aria-hidden="true"
            title={statusText ?? undefined}
            data-delivery-dot={dotState}
            className={`inline-flex size-2 shrink-0 rounded-full ${dotState === "reached" ? "bg-success" : "bg-foreground"}`}
          />
        ) : null}
      </span>
      {showUnknownWarning ? (
        <span
          className="max-w-56 text-right text-[10px] text-warning-foreground"
          role="alert"
        >
          {t("activity:comment.unknownResendWarning")}
        </span>
      ) : null}
      {statusText ? (
        <span className="sr-only" role="status" aria-live="polite">
          {statusText}
        </span>
      ) : null}
      {transientText ? (
        <span
          className="max-w-56 text-right text-[10px] text-muted-foreground"
          aria-hidden="true"
        >
          {transientText}
        </span>
      ) : null}
      {error ? (
        <span
          className="max-w-56 text-right text-[10px] text-destructive"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
