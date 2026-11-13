import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

// SPEC-2026-10-22 full-project-share-link: runtime marker for the guest
// project surface. Owner components/hooks stay untouched in authenticated
// mode; when this capability is present they transport through the share
// endpoints instead. A module-level ref keeps plain lib code (uploads) able
// to read the mode without prop drilling; only one share surface is mounted
// at a time, and the provider clears it on unmount.
//
// SPEC-2026-11-10 T3: the runtime is now discriminated — a project
// capability (view/edit/full) and a task capability (view/edit over one
// card + its live subtask tree) expose different surfaces and different
// mutation matrices. A module-level ref keeps plain lib code (uploads) able
// to read the mode without prop drilling; only one share surface is mounted
// at a time, and the provider clears it on unmount.

export type ShareCapabilityRuntime =
  | {
      resourceType: "project";
      permission: "view" | "edit" | "full";
      token: string;
      projectId: string;
      rootTaskId?: undefined;
    }
  | {
      resourceType: "task";
      permission: "view" | "edit";
      token: string;
      projectId: string;
      rootTaskId: string;
    };

let runtime: ShareCapabilityRuntime | null = null;

export function getShareCapability(): ShareCapabilityRuntime | null {
  return runtime;
}

// True when a guest holds a task card capability (view or edit).
export function isTaskShareCapability(
  capability: ShareCapabilityRuntime | null,
): capability is Extract<ShareCapabilityRuntime, { resourceType: "task" }> {
  return capability?.resourceType === "task";
}

// True when a guest holds a FULL project capability — the only mode granted
// owner-like project-work capabilities.
export function isFullProjectCapability(
  capability: ShareCapabilityRuntime | null,
): capability is Extract<ShareCapabilityRuntime, { resourceType: "project" }> {
  return (
    capability?.resourceType === "project" && capability.permission === "full"
  );
}

// The route only knows the token at mount; the real project id arrives with
// the first payload. Hooks that map owner shapes (docs, parent navigation)
// read it from here.
export function setShareCapabilityProjectId(projectId: string) {
  if (runtime) {
    runtime = { ...runtime, projectId };
  }
}

// Invalidate the guest query tree after a capability mutation. Safe to call
// from authenticated paths — it is a no-op without an active capability.
export function invalidateShareQueries(
  queryClient: { invalidateQueries: (options: { queryKey: string[] }) => void },
) {
  const capability = getShareCapability();
  if (capability) {
    queryClient.invalidateQueries({
      queryKey: ["share-full", capability.token],
    });
    queryClient.invalidateQueries({
      queryKey: ["share-task", capability.token],
    });
  }
}

const ShareCapabilityContext = createContext<ShareCapabilityRuntime | null>(
  null,
);

export function useShareCapability(): ShareCapabilityRuntime | null {
  return useContext(ShareCapabilityContext);
}

export function ShareCapabilityProvider({
  token,
  projectId,
  resourceType = "project",
  permission = resourceType === "task" ? "view" : "view",
  rootTaskId,
  children,
}: {
  token: string;
  projectId: string;
  resourceType?: "project" | "task";
  permission?: "view" | "edit" | "full";
  rootTaskId?: string;
  children: ReactNode;
}) {
  const previous = useRef<ShareCapabilityRuntime | null>(null);
  const capturedPrevious = useRef(false);

  // Set the runtime synchronously during render so the FIRST child queries
  // already snapshot the capability. Capture the prior value once (including
  // null), then restore it only if this provider still owns the active token.
  if (!capturedPrevious.current) {
    previous.current = runtime;
    capturedPrevious.current = true;
  }
  runtime =
    resourceType === "task"
      ? { resourceType, permission: permission === "edit" ? "edit" : "view", token, projectId, rootTaskId: rootTaskId ?? "" }
      : { resourceType, permission, token, projectId };

  useEffect(() => {
    return () => {
      if (runtime?.token === token) {
        runtime = previous.current;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, resourceType, permission, rootTaskId]);

  const value: ShareCapabilityRuntime =
    resourceType === "task"
      ? { resourceType, permission: permission === "edit" ? "edit" : "view", token, projectId, rootTaskId: rootTaskId ?? "" }
      : { resourceType, permission, token, projectId };

  return (
    <ShareCapabilityContext.Provider value={value}>
      {children}
    </ShareCapabilityContext.Provider>
  );
}
