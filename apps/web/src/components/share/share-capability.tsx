import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

// SPEC-2026-10-22 full-project-share-link: runtime marker for the guest
// project surface. Owner components/hooks stay untouched in authenticated
// mode; when this capability is present they transport through the share
// endpoints instead. A module-level ref keeps plain lib code (uploads) able
// to read the mode without prop drilling; only one share surface is mounted
// at a time, and the provider clears it on unmount.

export type ShareCapabilityRuntime = {
  token: string;
  projectId: string;
};

let runtime: ShareCapabilityRuntime | null = null;

export function getShareCapability(): ShareCapabilityRuntime | null {
  return runtime;
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
  children,
}: ShareCapabilityRuntime & { children: ReactNode }) {
  const previous = useRef<ShareCapabilityRuntime | null>(null);
  const capturedPrevious = useRef(false);

  // Set the runtime synchronously during render so the FIRST child queries
  // already snapshot the capability. Capture the prior value once (including
  // null), then restore it only if this provider still owns the active token.
  if (!capturedPrevious.current) {
    previous.current = runtime;
    capturedPrevious.current = true;
  }
  runtime = { token, projectId };

  useEffect(() => {
    return () => {
      if (runtime?.token === token) {
        runtime = previous.current;
      }
    };
  }, [token]);

  return (
    <ShareCapabilityContext.Provider value={{ token, projectId }}>
      {children}
    </ShareCapabilityContext.Provider>
  );
}
