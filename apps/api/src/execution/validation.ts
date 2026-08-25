import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export const LEASE_TTL_MS = 60_000;
export const EXECUTION_PROTOCOL_VERSION = 1;

export const TASK_RUN_STATES = [
  "in_progress",
  "in_review",
  "blocked",
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
  "orphaned",
  "failed",
  "cancelled",
  "superseded",
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

export function validateModelId(value: unknown, field = "model"): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.trim())
  ) {
    throw new HTTPException(400, {
      message: `${field} must be a bounded registry model id`,
    });
  }
  return value.trim();
}

export interface WorkerContractScope {
  files: string[];
  laptopOnly: boolean;
}

function parseEmbeddedJsonObject(
  source: string,
  start: number,
): unknown | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function extractWorkerContractScope(
  description: unknown,
): WorkerContractScope | null {
  if (typeof description !== "string" || description.length > 128 * 1024) {
    return null;
  }
  for (let start = 0; start < description.length; start += 1) {
    if (description[start] !== "{") continue;
    const candidate = parseEmbeddedJsonObject(description, start);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue;
    }
    const files = (candidate as Record<string, unknown>).files;
    if (!Array.isArray(files) || files.length === 0) continue;
    const normalized: string[] = [];
    let hasLaptopOnlyMarker = false;
    for (const value of files) {
      if (typeof value !== "string" || !value.trim()) return null;
      const path = value.trim();
      if (path === "laptop-only") {
        hasLaptopOnlyMarker = true;
        continue;
      }
      if (
        path.length > 500 ||
        path.startsWith("/") ||
        path.startsWith("\\") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((segment) => segment === "..")
      ) {
        return null;
      }
      normalized.push(path);
    }
    const laptopOnly =
      (candidate as Record<string, unknown>).laptop_only === true ||
      (hasLaptopOnlyMarker && normalized.length === 0);
    if (hasLaptopOnlyMarker && normalized.length > 0) return null;
    return { files: [...new Set(normalized)], laptopOnly };
  }
  return null;
}

export class ScheduleEligibilityError extends Error {
  readonly code = "schedule_eligibility";

  constructor(message: string) {
    super(message);
    this.name = "ScheduleEligibilityError";
  }
}

export const SCHEDULE_FALLBACK_MODES = ["manual", "preapproved"] as const;
export const SCHEDULE_OCCURRENCE_STATES = [
  "planned",
  "claimed",
  "dispatched",
  "superseded",
  "failed",
] as const;
export const SCHEDULE_MAX_RUNTIME_BOUNDS = { min: 60, max: 86_400 } as const;

/**
 * Canonical occurrence key: scheduleId + scheduled_for in UTC ISO with
 * millisecond precision. The unique constraint on this string is the
 * exactly-once dispatch fence required by the agent-control contract.
 */
export function occurrenceKey(scheduleId: string, scheduledFor: Date): string {
  return `${scheduleId}:${scheduledFor.toISOString()}`;
}

/**
 * v1 supports one-shot schedules only (notBefore). Cron expressions are
 * rejected fail-closed until occurrence idempotency has proven itself.
 */
export function assertScheduleShape(input: {
  notBefore: unknown;
  cronExpr?: unknown;
}): void {
  if (input.cronExpr !== undefined && input.cronExpr !== null) {
    throw new HTTPException(400, {
      message: "cron schedules are not supported in v1; use notBefore",
    });
  }
  if (
    !(input.notBefore instanceof Date) ||
    Number.isNaN(input.notBefore.getTime())
  ) {
    throw new HTTPException(400, {
      message: "notBefore must be a valid date",
    });
  }
}

export function validateSchedulePolicy(input: {
  host?: unknown;
  maxRuntimeSeconds: unknown;
  fallbackMode?: unknown;
  fallbackModels?: unknown;
  concurrencyKey?: unknown;
}): {
  host: string;
  maxRuntimeSeconds: number;
  fallbackMode: (typeof SCHEDULE_FALLBACK_MODES)[number];
  fallbackModels: string[];
  concurrencyKey: string;
} {
  const host =
    typeof input.host === "string" && input.host.trim().length > 0
      ? input.host.trim()
      : "prodesk-home";
  if (!/^[a-z0-9][a-z0-9-_.]{1,63}$/i.test(host)) {
    throw new HTTPException(400, { message: "invalid host binding" });
  }
  const maxRuntimeSeconds = Number(input.maxRuntimeSeconds);
  if (
    !Number.isInteger(maxRuntimeSeconds) ||
    maxRuntimeSeconds < SCHEDULE_MAX_RUNTIME_BOUNDS.min ||
    maxRuntimeSeconds > SCHEDULE_MAX_RUNTIME_BOUNDS.max
  ) {
    throw new HTTPException(400, {
      message: `maxRuntimeSeconds must be an integer between ${SCHEDULE_MAX_RUNTIME_BOUNDS.min} and ${SCHEDULE_MAX_RUNTIME_BOUNDS.max}`,
    });
  }
  const fallbackMode =
    input.fallbackMode === undefined || input.fallbackMode === null
      ? "manual"
      : input.fallbackMode;
  if (
    !(SCHEDULE_FALLBACK_MODES as readonly string[]).includes(
      fallbackMode as string,
    )
  ) {
    throw new HTTPException(400, {
      message: `fallbackMode must be one of ${SCHEDULE_FALLBACK_MODES.join(", ")}`,
    });
  }
  const fallbackModels =
    input.fallbackModels === undefined || input.fallbackModels === null
      ? []
      : input.fallbackModels;
  if (
    !Array.isArray(fallbackModels) ||
    fallbackModels.some((model) => {
      if (typeof model !== "string" || model.length > 120) return true;
      try {
        validateModelId(model, "fallback model");
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new HTTPException(400, {
      message: "fallbackModels must be an array of registry model ids",
    });
  }
  if (fallbackMode === "preapproved" && fallbackModels.length === 0) {
    throw new HTTPException(400, {
      message: "preapproved fallbackMode requires at least one fallback model",
    });
  }
  const normalizedFallbackModels = (fallbackModels as unknown[]).map((model) =>
    validateModelId(model, "fallback model"),
  );
  const concurrencyKey =
    typeof input.concurrencyKey === "string" &&
    input.concurrencyKey.trim().length > 0
      ? input.concurrencyKey.trim()
      : host;
  if (concurrencyKey.length > 120) {
    throw new HTTPException(400, { message: "concurrencyKey too long" });
  }
  return {
    host,
    maxRuntimeSeconds,
    fallbackMode: fallbackMode as (typeof SCHEDULE_FALLBACK_MODES)[number],
    fallbackModels: normalizedFallbackModels,
    concurrencyKey,
  };
}

export function validateRetryPolicy(value?: unknown): Record<string, number> {
  if (value === undefined || value === null) return {};
  const policy = validateJsonObject(value, "retryPolicy", 8 * 1024);
  const allowedKeys = new Set(["maxAttempts", "backoffSeconds"]);
  for (const key of Object.keys(policy)) {
    if (!allowedKeys.has(key)) {
      throw new HTTPException(400, {
        message: `retryPolicy contains unsupported field: ${key}`,
      });
    }
  }
  const maxAttempts = policy.maxAttempts;
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 10)
  ) {
    throw new HTTPException(400, {
      message: "retryPolicy.maxAttempts must be an integer between 1 and 10",
    });
  }
  const backoffSeconds = policy.backoffSeconds;
  if (
    backoffSeconds !== undefined &&
    (typeof backoffSeconds !== "number" ||
      !Number.isInteger(backoffSeconds) ||
      backoffSeconds < 15 ||
      backoffSeconds > 86_400)
  ) {
    throw new HTTPException(400, {
      message:
        "retryPolicy.backoffSeconds must be an integer between 15 and 86400",
    });
  }
  return Object.fromEntries(
    Object.entries(policy).map(([key, number]) => [key, number as number]),
  );
}

export function isScheduleDue(
  input: { enabled: boolean; notBefore: Date; host: string },
  now = new Date(),
  hostFilter?: string,
): boolean {
  if (!input.enabled) {
    return false;
  }
  if (hostFilter && input.host !== hostFilter) {
    return false;
  }
  return input.notBefore.getTime() <= now.getTime();
}
