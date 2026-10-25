import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyShareLinkButton } from "./copy-share-link-button";
import ShareDialog from "./share-dialog";

const mocks = vi.hoisted(() => ({
  createAsync: vi.fn(),
  revokeAsync: vi.fn(),
  mutate: vi.fn(),
  links: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/mutations/share/use-share-links", () => ({
  useGetShareLinks: () => ({ data: mocks.links }),
  useCreateShareLink: () => ({
    data: undefined,
    mutate: mocks.mutate,
    mutateAsync: mocks.createAsync,
    isPending: false,
  }),
  useRevokeShareLink: () => ({
    mutate: mocks.mutate,
    mutateAsync: mocks.revokeAsync,
    isPending: false,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `share.${key}` }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTrigger: ({ render }: { render: ReactElement }) => render,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.links = [];
});

function legacyLink(permission: "view" | "edit" = "view") {
  return {
    id: "legacy-1",
    resourceType: "project",
    resourceId: "project-1",
    permission,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-10-20T00:00:00Z",
    url: null,
  };
}

function renderShareDialog(
  resourceType: "project" | "task_description" = "project",
  canCreateFull = false,
) {
  return render(
    <ShareDialog
      resourceType={resourceType}
      resourceId="project-1"
      canShare
      canCreateFull={canCreateFull}
    />,
  );
}

describe("share dialog permission controls", () => {
  it("does not offer edit links for view-only resource types", () => {
    renderShareDialog("task_description");

    expect(screen.getByText("share.permission.view")).toBeVisible();
    expect(screen.queryByText("share.permission.edit")).toBeNull();
  });

  it("does not render a full-permission warning block anymore", () => {
    renderShareDialog("project", true);

    fireEvent.click(
      screen.getByRole("button", { name: "share.permission.full" }),
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("creates an edit link only after selecting the edit scope", () => {
    renderShareDialog();

    fireEvent.click(
      screen.getByRole("button", { name: "share.permission.edit" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "share.create" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        resourceType: "project",
        resourceId: "project-1",
        permission: "edit",
      },
      expect.any(Object),
    );
  });
});

describe("copy share links", () => {
  it("reuses and copies an active link instead of creating a duplicate", async () => {
    mocks.links = [
      {
        ...legacyLink("view"),
        id: "active-1",
        url: "https://kaneo/share/existing",
      },
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    render(
      <CopyShareLinkButton
        resourceType="activity_comment"
        resourceId="comment-1"
        canShare
        label="Comment link"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Comment link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://kaneo/share/existing"),
    );
    expect(mocks.createAsync).not.toHaveBeenCalled();
  });

  it("confirms a legacy replacement, preserves its scope, and leaves the old URL active", async () => {
    mocks.links = [legacyLink("edit")];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mocks.createAsync.mockResolvedValue({
      id: "replacement-1",
      url: "https://kaneo/share/new",
    });

    renderShareDialog();
    fireEvent.click(screen.getByRole("button", { name: "share.manage" }));
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.copyReplacement" }),
    );
    expect(screen.getByText("share.legacy.description")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.replace" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://kaneo/share/new"),
    );
    expect(mocks.createAsync).toHaveBeenCalledWith({
      resourceType: "project",
      resourceId: "project-1",
      permission: "edit",
    });
    expect(mocks.revokeAsync).not.toHaveBeenCalled();
  });

  it("creates a new full link instead of revealing the stored full URL", async () => {
    mocks.links = [{ ...legacyLink(), permission: "full" }];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mocks.createAsync.mockResolvedValue({
      id: "replacement-full",
      url: "https://kaneo/share/full-new",
    });

    renderShareDialog("project", true);
    fireEvent.click(screen.getByRole("button", { name: "share.manage" }));
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.copyReplacement" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.replace" }),
    );

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://kaneo/share/full-new"),
    );
    expect(mocks.createAsync).toHaveBeenCalledWith({
      resourceType: "project",
      resourceId: "project-1",
      permission: "full",
    });
    expect(mocks.revokeAsync).not.toHaveBeenCalled();
  });

  it("keeps the legacy link when copying its replacement fails", async () => {
    mocks.links = [legacyLink("view")];
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mocks.createAsync.mockResolvedValue({
      id: "replacement-1",
      url: "https://kaneo/share/new",
    });

    renderShareDialog();
    fireEvent.click(screen.getByRole("button", { name: "share.manage" }));
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.copyReplacement" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "share.legacy.replace" }),
    );

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(mocks.revokeAsync).not.toHaveBeenCalled();
  });
});
