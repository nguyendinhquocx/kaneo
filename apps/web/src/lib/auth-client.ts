import { apiKeyClient } from "@better-auth/api-key/client";
import {
  adminClient,
  anonymousClient,
  deviceAuthorizationClient,
  emailOTPClient,
  genericOAuthClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import type { AccessControl } from "better-auth/plugins/access";
import { createAuthClient } from "better-auth/react";
import { getShareCapability } from "@/components/share/share-capability";
import { ac, admin, member, owner, viewer } from "./permissions";

const getBaseURL = () => {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:1337";
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return apiUrl.split("/").slice(0, 3).join("/");
  }
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  basePath: "/api/auth",
  // R3 UAT cleanup: guest share surfaces mount owner components whose
  // better-auth organization hooks fire authenticated lookups that always
  // 401 for guests. Answer those with an empty success payload while a share
  // capability is active instead of hitting the network at all.
  fetch: (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
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
  }) as typeof fetch,
  plugins: [
    anonymousClient(),
    lastLoginMethodClient(),
    magicLinkClient(),
    emailOTPClient(),
    organizationClient({
      // The shared access-control statement includes Kaneo resources in
      // addition to Better Auth's built-in organization resources.
      ac: ac as unknown as AccessControl,
      roles: {
        viewer,
        member,
        admin,
        owner,
      },
      dynamicAccessControl: {
        enabled: true,
      },
    }),
    genericOAuthClient(),
    deviceAuthorizationClient(),
    apiKeyClient(),
    adminClient(),
    inferAdditionalFields({
      user: {
        locale: {
          type: "string",
          required: false,
          input: true,
        },
      },
    }),
  ],
});
