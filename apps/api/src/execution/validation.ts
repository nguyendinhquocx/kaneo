import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export const LEASE_TTL_MS = 60_000;
export const EXECUTION_PROTOCOL_VERSION = 1;

export const TASK_RUN_STATES = [
  "in_progress",
  "in_review",
  "blocked",
  "orphaned",
  "done",
  "rejected",
] as const;

export type TaskRunState = (typeof TASK_RUN_STATES)[number];

export function validateScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new HTTPException(400, {
      message: "Scope must contain between 1 and 100 relative paths",
    });
  }

  const scope = value.map((item) => {
    if (typeof item !== "string") {
      throw new HTTPException(400, { message: "Scope paths must be strings" });
    }

    const path = item.trim();
    if (
      !path ||
      path === "*" ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((segment) => segment === "..")
    ) {
      throw new HTTPException(400, {
        message: `Invalid scope path: ${item}`,
      });
    }

    return path;
  });

  return [...new Set(scope)];
}

export function validateBranchName(value: unknown, field = "baseBranch") {
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} must be a string` });
  }

  const branch = value.trim();
  if (
    !branch ||
    branch.length > 200 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\s~^:?*[\]]/.test(branch)
  ) {
    throw new HTTPException(400, { message: `Invalid ${field}` });
  }

  return branch;
}

export function validateVerificationProfile(value: unknown): string {
  if (typeof value !== "string") {
    throw new HTTPException(400, {
      message: "verificationProfile must be a source-owned profile name",
    });
  }

  const profile = value.trim();
  if (!/^[a-z0-9][a-z0-9._/-]{1,63}$/.test(profile)) {
    throw new HTTPException(400, {
      message: "verificationProfile must be a source-owned profile name",
    });
  }

  return profile;
}

export function validateGitSha(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/i.test(value.trim())) {
    throw new HTTPException(400, { message: `${field} must be a Git SHA` });
  }
  return value.trim();
}

export function validatePrUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2048) {
    throw new HTTPException(400, {
      message: "prUrl must be a bounded HTTPS URL",
    });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HTTPException(400, {
      message: "prUrl must be a bounded HTTPS URL",
    });
  }
  if (url.protocol !== "https:") {
    throw new HTTPException(400, {
      message: "prUrl must be a bounded HTTPS URL",
    });
  }
  return url.toString();
}

export function validateJsonObject(
  value: unknown,
  field: string,
  maxBytes = 64 * 1024,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HTTPException(400, { message: `${field} must be an object` });
  }
  const object = value as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(object), "utf8") > maxBytes) {
    throw new HTTPException(413, { message: `${field} is too large` });
  }
  return object;
}

export function validateDocs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HTTPException(400, {
      message: "docs must contain at most 100 relative references",
    });
  }

  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new HTTPException(400, {
        message: "docs references must be non-empty strings",
      });
    }
    const path = item.trim();
    if (
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.includes("\\") ||
      path.split("/").some((segment) => segment === "..")
    ) {
      throw new HTTPException(400, {
        message: `Invalid docs reference: ${item}`,
      });
    }
    return path;
  });
}

export function validateLeaseEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HTTPException(400, {
      message: "leaseEpoch must be a positive integer",
    });
  }
  return value;
}

export function validateRunState(value: unknown): TaskRunState {
  if (
    typeof value !== "string" ||
    !(TASK_RUN_STATES as readonly string[]).includes(value)
  ) {
    throw new HTTPException(400, { message: "Invalid task run state" });
  }
  return value as TaskRunState;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function createLeaseToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return {
    raw,
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

export function hashLeaseToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function getLeaseExpiry(now = new Date()): Date {
  return new Date(now.getTime() + LEASE_TTL_MS);
}

export function isLeaseExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function taskSlug(title: string): string {
  const slug = title
    .replace(/[đĐ]/g, "d")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}
