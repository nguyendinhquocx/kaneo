import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SendCommentToPiAction from "./send-comment-to-pi-action";

const state = vi.hoisted(() => ({
  binding: null as unknown,
  bindingIsLoading: false,
  bindingIsError: false,
  delivery: null as unknown,
  restoredDelivery: null as unknown,
  isPending: false,
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/queries/agent-session/use-get-task-binding-status", () => ({
  useGetTaskBindingStatus: () => ({
    data: state.binding,
    isLoading: state.bindingIsLoading,
    isError: state.bindingIsError,
  }),
}));
vi.mock(
  "@/hooks/queries/agent-session/use-get-comment-delivery-status",
  () => ({
    useGetCommentDeliveryStatus: () => ({ data: state.delivery }),
  }),
);
vi.mock(
  "@/hooks/queries/agent-session/use-get-comment-delivery-by-comment",
  () => ({
    useGetCommentDeliveryByComment: () => ({ data: state.restoredDelivery }),
  }),
);
vi.mock("@/hooks/mutations/agent-session/use-send-comment-to-pi", () => ({
  useSendCommentToPi: () => ({
    mutateAsync: state.mutateAsync,
    isPending: state.isPending,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { sessionId?: string; host?: string }) => {
      const values: Record<string, string> = {
        "activity:comment.sendToPi": "Send to Pi",
        "activity:comment.resendToPi": "Send again",
        "activity:comment.sendingToPi": "Sending to Pi",
        "activity:comment.sendToPiFailed": "Could not queue",
        "activity:comment.sendToPiCheckingBinding": "Checking binding",
        "activity:comment.sendToPiStatusUnavailable":
          "Agent status unavailable",
        "activity:comment.sendToPiUnbound":
          "No agent is bound to this card yet.",
        "activity:comment.sendToPiOffline": "The bound agent is offline.",
        "activity:comment.unknownResendWarning":
          "Previous attempt may already have arrived.",
        "activity:comment.delivery.queued": "Queued for Pi",
        "activity:comment.delivery.claimed": "Pi is receiving it",
        "activity:comment.delivery.enqueued":
          "Queued to Pi, not confirmed read",
        "activity:comment.delivery.stale": "Comment is stale",
        "activity:comment.delivery.expired": "Delivery expired",
        "activity:comment.delivery.failed_before_send": "Delivery failed",
        "activity:comment.delivery.unknown": "Outcome unknown",
      };
      if (key === "activity:comment.sendToPiTarget") {
        return `session ${vars?.sessionId} on ${vars?.host}`;
      }
      return values[key] ?? key;
    },
  }),
}));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

function liveBinding() {
  state.binding = {
    bound: true,
    online: true,
    bindingId: "binding-1",
    bindingGeneration: 4,
    sessionId: "pi-session-exact",
    hostId: "pi-prodesk",
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  state.binding = null;
  state.bindingIsLoading = false;
  state.bindingIsError = false;
  state.delivery = null;
  state.restoredDelivery = null;
  state.isPending = false;
  state.mutateAsync.mockReset();
  let next = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `client-key-${++next}` });
});

describe("SendCommentToPiAction", () => {
  it("sends the existing comment to the exact bound session and creates a fresh key for explicit resend", async () => {
    liveBinding();
    state.mutateAsync.mockImplementation(async (input: unknown) => ({
      duplicate: false,
      receipt: {
        deliveryId: "delivery-1",
        state: "enqueued",
        ...(input as object),
      },
    }));
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const send = screen.getByRole("button", {
      name: /Send to Pi.*pi-session-exact.*pi-prodesk/,
    });
    fireEvent.click(send);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(1));
    expect(state.mutateAsync).toHaveBeenLastCalledWith({
      bindingId: "binding-1",
      sessionId: "pi-session-exact",
      generation: 4,
      commentId: "comment-1",
      clientActionKey: "client-key-1",
    });

    fireEvent.click(screen.getByRole("button", { name: /Send again/ }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
    expect(state.mutateAsync.mock.calls[1]?.[0]).toMatchObject({
      commentId: "comment-1",
      clientActionKey: "client-key-2",
    });
  });

  it("restores the last server receipt for a comment after reload", () => {
    liveBinding();
    state.restoredDelivery = {
      delivery: {
        deliveryId: "delivery-restored",
        bindingId: "binding-1",
        bindingGeneration: 4,
        commentId: "comment-1",
        clientActionKey: "key-1",
        state: "enqueued",
        createdAt: "2026-11-14T09:00:00.000Z",
        expiresAt: "2026-11-14T10:00:00.000Z",
        enqueuedAt: "2026-11-14T09:00:05.000Z",
      },
    };
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);
    expect(
      screen.queryByText(/Queued to Pi, not confirmed read/, {
        selector: 'span[aria-hidden="true"]',
      }),
    ).toBeNull();
    expect(
      screen.getByText(/Queued to Pi, not confirmed read/, {
        selector: "span.sr-only",
      }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-delivery-dot="reached"]')?.className,
    ).toContain("bg-success");
    expect(screen.getByRole("button", { name: /Send again/ })).toBeVisible();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("shows a waiting dot while queued, then hides the notice after three seconds", async () => {
    liveBinding();
    vi.useFakeTimers();
    state.mutateAsync.mockResolvedValue({
      duplicate: false,
      receipt: { deliveryId: "delivery-new", state: "queued" },
    });
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send to Pi/ }));
      await Promise.resolve();
    });

    expect(
      screen.getByText("Queued for Pi", {
        selector: 'span[aria-hidden="true"]',
      }),
    ).toBeVisible();
    expect(
      screen.getByText("Queued for Pi", { selector: "span.sr-only" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-delivery-dot="waiting"]')?.className,
    ).toContain("bg-foreground");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(
      screen.queryByText("Queued for Pi", {
        selector: 'span[aria-hidden="true"]',
      }),
    ).toBeNull();
    expect(
      screen.getByText("Queued for Pi", { selector: "span.sr-only" }),
    ).toBeInTheDocument();
  });

  it("shows the waiting dot while the send request is pending", () => {
    liveBinding();
    state.isPending = true;
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);
    expect(
      document.querySelector('[data-delivery-dot="waiting"]'),
    ).toBeVisible();
    expect(
      screen.getByText("Sending to Pi", { selector: "span.sr-only" }),
    ).toBeInTheDocument();
  });

  it("shows no delivery dot before the comment has a receipt", () => {
    liveBinding();
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /Send to Pi/ })).toBeVisible();
  });

  it("requires an explicit warned resend after an unknown attempt", async () => {
    liveBinding();
    state.delivery = { state: "unknown" };
    state.mutateAsync.mockResolvedValue({
      duplicate: false,
      receipt: { deliveryId: "delivery-2", state: "queued" },
    });
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    expect(
      screen.getByText("Outcome unknown", { selector: "span.sr-only" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-delivery-dot="waiting"]')?.className,
    ).toContain("bg-foreground");
    fireEvent.click(screen.getByRole("button", { name: /Send again/ }));
    expect(
      await screen.findByText(/Previous attempt may already have arrived/),
    ).toBeVisible();
    expect(state.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Send again/ }));
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledOnce());
  });

  it("stays visible and disabled with a truthful hint when the task is confirmed unbound", () => {
    state.binding = { bound: false, online: false };
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const button = screen.getByRole("button", {
      name: /Send to Pi.*No agent is bound/,
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps the Send-to-Pi action and known target in its accessible name while offline", () => {
    state.binding = {
      bound: true,
      online: false,
      bindingId: "binding-1",
      bindingGeneration: 4,
      sessionId: "pi-session-exact",
      hostId: "pi-prodesk",
    };
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const button = screen.getByRole("button", {
      name: /Send to Pi.*session pi-session-exact on pi-prodesk.*offline/i,
    });
    expect(button).toBeDisabled();
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not misreport a binding-status query error as unbound", () => {
    state.bindingIsError = true;
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const button = screen.getByRole("button", {
      name: /Send to Pi.*Agent status unavailable/,
    });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Agent status unavailable",
    );
    expect(screen.queryByText(/No agent is bound/)).toBeNull();
  });

  it("announces binding lookup as checking, not as a confirmed unbound state", () => {
    state.bindingIsLoading = true;
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const button = screen.getByRole("button", {
      name: /Send to Pi.*Checking binding/,
    });
    expect(button).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking binding");
    expect(screen.queryByText(/No agent is bound/)).toBeNull();
  });

  it("shows send errors without success and keeps the same idempotency key for retry", async () => {
    liveBinding();
    state.mutateAsync.mockRejectedValue(new Error("network unavailable"));
    render(<SendCommentToPiAction taskId="task-1" commentId="comment-1" />);

    const send = screen.getByRole("button", {
      name: /Send to Pi.*pi-session-exact/,
    });
    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "network unavailable",
    );
    expect(screen.queryByText(/Queued to Pi/)).toBeNull();

    fireEvent.click(send);
    await waitFor(() => expect(state.mutateAsync).toHaveBeenCalledTimes(2));
    expect(state.mutateAsync.mock.calls[0]?.[0]).toMatchObject({
      clientActionKey: "client-key-1",
    });
    expect(state.mutateAsync.mock.calls[1]?.[0]).toMatchObject({
      clientActionKey: "client-key-1",
    });
  });
});
