import { getShareCapability } from "@/components/share/share-capability";

/**
 * Better Auth owner-component hooks run on some guest share surfaces. They
 * have no authenticated organization and the resulting 401s are expected but
 * noisy. Intercept only those lookups while a scoped share capability is
 * active; all authenticated and non-organization requests use the real fetch.
 */
export async function shareAwareAuthFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (
    url.includes("/api/auth/organization") &&
    getShareCapability() !== null
  ) {
    const body = url.includes("/list") ? "[]" : "{}";
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return fetch(input, init);
}
