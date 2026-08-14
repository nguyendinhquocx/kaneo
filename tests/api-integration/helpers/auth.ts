import type { Session, User } from "better-auth/types";
import { vi } from "vitest";
import { auth } from "../../../apps/api/src/auth";

function createSession(userId: string): Session {
  const now = new Date();

  return {
    id: `session-${userId}`,
    token: `token-${userId}`,
    userId,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
  };
}

export function mockAuthenticatedSession(user: User) {
  return vi.spyOn(auth.api, "getSession").mockResolvedValue({
    session: createSession(user.id),
    user,
  });
}

export function mockAnonymousSession() {
  return vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
}

/**
 * Model separate authenticated principals in one Hono integration test. The
 * real API derives userId from the bearer/session context; the request token
 * selects which fixture user that context represents.
 */
export function mockAuthenticatedSessions(
  defaultUser: User,
  bearerUsers: Record<string, User>,
) {
  return vi
    .spyOn(auth.api, "getSession")
    .mockImplementation(async ({ headers }) => {
      const bearer = headers
        .get("authorization")
        ?.match(/^Bearer\s+(\S+)$/i)?.[1];
      const user = bearer ? bearerUsers[bearer] : defaultUser;
      if (!user) return null;
      return {
        session: createSession(user.id),
        user,
      };
    });
}
