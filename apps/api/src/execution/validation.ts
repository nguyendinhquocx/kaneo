import { createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";

export const LEASE_TTL_MS = 60_000;
export const EXECUTION_PROTOCOL_VERSION = 1;

// Canonical run states (SPEC-kaneo-native-telegram-control-v0-1). Legacy
// names (`running`, `stale`, `blocked`, `done`) are rejected on new writes
// and only accepted through mapLegacyRunState for migration/reads.
export const TASK_RUN_STATES = [
  "created",
  "leased",
  "in_progress",
  "checkpointed",
  "in_review",
  "finalized",
  "rejected",
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
  "orphaned",
  "failed",
  "cancelled",
  "superseded",
] as const;

export type TaskRunState = (typeof TASK_RUN_STATES)[number];

/** `in_review` is worker-terminal only; parent review owns the outgoing
 * transitions (finalized/rejected). Fully-terminal states must never have
 * outgoing transitions (machine-enforced contract invariant). */
export const WORKER_TERMINAL_RUN_STATES = ["in_review"] as const;

export const FULLY_TERMINAL_RUN_STATES = [
  "finalized",
  "rejected",
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
  "orphaned",
  "failed",
  "cancelled",
  "superseded",
] as const;

/** States a worker may report through the fenced worker report endpoint.
 * `checkpointed` is NOT reportable here: checkpoints must go through the
 * dedicated /checkpoints endpoint with a fixed Git guard push receipt. */
export const WORKER_REPORTABLE_STATES = [
  "in_progress",
  "in_review",
  "blocked_quota",
  "blocked_input",
  "blocked_clarification",
  "blocked_branch_drift",
  "failed",
] as const;

export const WORKER_FAILURE_KINDS = [
  "provider_quota",
  "provider_timeout",
  "provider_5xx",
  "provider_auth",
  "worker_crash",
  "test_failure",
  // SPEC-kaneo-phase-cards-full-run-server-v0-1: canonical validation value
  // for blocked_input — a phase map failed server validation.
  "malformed_phase_map",
] as const;

export type WorkerFailureKind = (typeof WORKER_FAILURE_KINDS)[number];

export function validateFailureKind(
  value: unknown,
): WorkerFailureKind | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !(WORKER_FAILURE_KINDS as readonly string[]).includes(value)
  ) {
    throw new HTTPException(400, { message: "Invalid failureKind" });
  }
  return value as WorkerFailureKind;
}

export const LEGACY_TASK_RUN_STATES = [
  "running",
  "stale",
  "blocked",
  "done",
] as const;

export type LegacyTaskRunState = (typeof LEGACY_TASK_RUN_STATES)[number];

/**
 * Map a legacy run state to its canonical replacement for reads/migration.
 * - `blocked` and `done` are ambiguous without evidence, so they map to
 *   `failed`/`in_review` respectively and the caller must flag manual
 *   recovery/review; new writes must never accept these names.
 */
export function mapLegacyRunState(
  value: string,
): { state: TaskRunState; manualFollowUpRequired: boolean } | null {
  if ((TASK_RUN_STATES as readonly string[]).includes(value)) {
    return { state: value as TaskRunState, manualFollowUpRequired: false };
  }
  switch (value) {
    case "running":
      return { state: "in_progress", manualFollowUpRequired: false };
    case "stale":
      return { state: "orphaned", manualFollowUpRequired: false };
    case "blocked":
      return { state: "failed", manualFollowUpRequired: true };
    case "done":
      return { state: "in_review", manualFollowUpRequired: true };
    default:
      return null;
  }
}

/** Task lifecycle authority stored in `task.execution_state`. */
export const TASK_EXECUTION_STATES = [
  "published",
  "ready",
  "queued",
  "running",
  "in_review",
  "done",
  "archived",
  "blocked",
] as const;

export type TaskExecutionState = (typeof TASK_EXECUTION_STATES)[number];

export const CONTROL_REQUEST_ACTIONS = [
  "read_status",
  "notification_ack",
  "create_dispatch_request",
  "answer_clarification",
  "continue_quota",
  "steer_message",
] as const;

export type ControlRequestAction = (typeof CONTROL_REQUEST_ACTIONS)[number];

export const CONTROL_REQUEST_STATES = [
  "pending",
  "claimed",
  "applied",
  "rejected",
  "expired",
] as const;

export type ControlRequestState = (typeof CONTROL_REQUEST_STATES)[number];

export const NOTIFICATION_EVENT_KINDS = [
  "started",
  "checkpoint",
  "blocked_quota",
  "needs_input",
  "in_review",
  "failed",
  "done",
  "chain_paused",
] as const;

export type NotificationEventKind = (typeof NOTIFICATION_EVENT_KINDS)[number];

export const NOTIFICATION_DELIVERY_STATES = [
  "pending",
  "sending",
  "sent",
  "send_unknown",
  "acked",
  "dead_letter",
] as const;

export type NotificationDeliveryState =
  (typeof NOTIFICATION_DELIVERY_STATES)[number];

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
    if (
      typeof value === "string" &&
      (LEGACY_TASK_RUN_STATES as readonly string[]).includes(value)
    ) {
      throw new HTTPException(400, {
        message: `Legacy run state "${value}" is rejected on new writes; use the canonical state instead`,
      });
    }
    throw new HTTPException(400, { message: "Invalid task run state" });
  }
  return value as TaskRunState;
}

export function validateWorkerReportState(value: unknown): TaskRunState {
  if (
    typeof value !== "string" ||
    !(WORKER_REPORTABLE_STATES as readonly string[]).includes(value)
  ) {
    if (typeof value === "string" && value === "blocked") {
      throw new HTTPException(400, {
        message:
          'Generic "blocked" report is rejected; use blocked_quota, blocked_input, blocked_clarification, blocked_branch_drift or failed with failureKind',
      });
    }
    throw new HTTPException(400, {
      message: "Invalid worker report state",
    });
  }
  return value as TaskRunState;
}

export function validateExecutionState(value: unknown): TaskExecutionState {
  if (
    typeof value !== "string" ||
    !(TASK_EXECUTION_STATES as readonly string[]).includes(value)
  ) {
    throw new HTTPException(400, { message: "Invalid task execution state" });
  }
  return value as TaskExecutionState;
}

export function validateRevision(
  value: unknown,
  field = "revision",
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HTTPException(400, {
      message: `${field} must be a positive integer`,
    });
  }
  return value;
}

export function validateControlAction(value: unknown): ControlRequestAction {
  if (
    typeof value !== "string" ||
    !(CONTROL_REQUEST_ACTIONS as readonly string[]).includes(value)
  ) {
    throw new HTTPException(400, { message: "Invalid control request action" });
  }
  return value as ControlRequestAction;
}

export function validateNotificationKind(
  value: unknown,
): NotificationEventKind {
  if (
    typeof value !== "string" ||
    !(NOTIFICATION_EVENT_KINDS as readonly string[]).includes(value)
  ) {
    throw new HTTPException(400, {
      message: "Invalid notification event kind",
    });
  }
  return value as NotificationEventKind;
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

// --- SPEC-kaneo-phase-cards-full-run-server-v0-1: canonical phase map -----
// Canonicalization (master spec): UTF-8 without BOM, Unicode NFC, path `\\`
// becomes `/`, trim + reject absolute/traversal/empty paths, object keys sort
// by Unicode code point, phase entries sort by ordinal, Files/Verify sort
// lexicographically, other arrays keep declaration order, compact JSON
// (`,`/`:`), SHA-256 over the raw bytes. Child IDs, timestamps, request keys
// and prose never enter the source hash; receiptSha256 excludes itself.

export const PHASE_COUNT_LIMIT = 30;
export const SPEC_SHA256_RE = /^[0-9a-f]{64}$/;

/** Canonical phase entry as accepted from the parent graph request. */
export type CanonicalPhaseInput = {
  phaseId: string;
  parserTaskId: string;
  ordinal: number;
  required: boolean;
  title: string;
  description?: string;
  files: string[];
  verify: string[];
};

export function normalizeRelativePath(value: unknown, field = "path"): string {
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${field} must be a string` });
  }
  const path = value.normalize("NFC").trim().replace(/\\/g, "/");
  if (
    !path ||
    path === "*" ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "..")
  ) {
    throw new HTTPException(400, { message: `Invalid ${field}: ${value}` });
  }
  return path;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Recursively normalize values for hashing (NFC strings, sorted keys). */
function canonicalHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareCodePoint)
        .map((key) => [key, canonicalHashValue(record[key])]),
    );
  }
  if (typeof value === "string") return value.normalize("NFC");
  return value;
}

/** Compact canonical JSON text of a value (sorted keys, NFC strings). */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalHashValue(value));
}

/** SHA-256 hex over the compact canonical JSON bytes of a value. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJsonString(value), "utf8")
    .digest("hex");
}

/** Source-hash entry shape: no child IDs, no prose, normalized + sorted. */
function canonicalSourcePhaseEntry(phase: CanonicalPhaseInput) {
  return {
    phase_id: phase.phaseId,
    parser_task_id: phase.parserTaskId,
    ordinal: phase.ordinal,
    required: phase.required,
    title: phase.title,
    files: phase.files
      .map((file) => normalizeRelativePath(file, "phase file"))
      .sort(compareCodePoint),
    verify: phase.verify
      .map((command) => command.normalize("NFC").trim())
      .sort(compareCodePoint),
  };
}

/**
 * Canonical source phase map bytes: sorted array of phase entries without
 * child IDs. Must reproduce the master spec vector
 * 571b8fc41098e9bd924e17e708ff0adc2b6148b8acad4ebf055201381de3b3ff.
 */
export function computeSourcePhaseMapHash(
  phases: CanonicalPhaseInput[],
): string {
  const entries = [...phases]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(canonicalSourcePhaseEntry);
  return canonicalSha256(entries);
}

/**
 * Canonical graph map hash: source entries plus server-allocated child IDs
 * and the FULL task id. Must reproduce the master spec graph vector
 * 717d7cda68bae645ec0a92959fce00874253feffa9398fb332e1a8b3e51c46cf.
 */
export function computeGraphMapHash(
  fullTaskId: string,
  phases: Array<CanonicalPhaseInput & { childTaskId: string }>,
): string {
  const entries = [...phases]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((phase) => ({
      ...canonicalSourcePhaseEntry(phase),
      child_task_id: phase.childTaskId,
    }));
  return canonicalSha256({ full_task_id: fullTaskId, phases: entries });
}

/** Deterministic graph id from canonical {projectId, changeSetId, planHash}. */
export function computeGraphId(input: {
  projectId: string;
  changeSetId: string;
  planHash: string;
}): string {
  return `graph-${canonicalSha256({
    projectId: input.projectId,
    changeSetId: input.changeSetId,
    planHash: input.planHash,
  })}`;
}

/**
 * Validate and canonicalize the parent-supplied phase list. Rejects more
 * than PHASE_COUNT_LIMIT phases (`phase_count_exceeds_limit`), duplicate
 * phase ids/ordinals/parser ids, and malformed file/command entries.
 */
export function validatePhaseMapInput(phases: unknown): CanonicalPhaseInput[] {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new HTTPException(400, {
      message: "phases must be a non-empty array",
    });
  }
  if (phases.length > PHASE_COUNT_LIMIT) {
    throw new HTTPException(409, {
      message: `phase_count_exceeds_limit: at most ${PHASE_COUNT_LIMIT} phases are allowed per FULL run`,
    });
  }
  const seenPhaseIds = new Set<string>();
  const seenParserTaskIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  const canonical: CanonicalPhaseInput[] = phases.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HTTPException(400, {
        message: "phase entries must be objects",
      });
    }
    const entry = raw as Record<string, unknown>;
    const phaseId = entry.phaseId;
    if (typeof phaseId !== "string" || !phaseId.trim() || phaseId.length > 64) {
      throw new HTTPException(400, {
        message: "phase phaseId must be a bounded non-empty string",
      });
    }
    const parserTaskId = entry.parserTaskId;
    if (
      typeof parserTaskId !== "string" ||
      !/^T[0-9]{1,4}$/.test(parserTaskId.trim())
    ) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} parserTaskId must match T<number>`,
      });
    }
    const ordinal = entry.ordinal;
    if (
      typeof ordinal !== "number" ||
      !Number.isInteger(ordinal) ||
      ordinal < 1 ||
      ordinal > PHASE_COUNT_LIMIT
    ) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} ordinal must be an integer between 1 and ${PHASE_COUNT_LIMIT}`,
      });
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new HTTPException(400, {
        message: `phase ${phaseId} required must be a boolean`,
      });
    }
    const title = entry.title;
    if (typeof title !== "string" || !title.trim() || title.length > 300) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} title must be a bounded non-empty string`,
      });
    }
    const description = entry.description;
    if (
      description !== undefined &&
      (typeof description !== "string" || description.length > 16_000)
    ) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} description must be a bounded string`,
      });
    }
    const files = entry.files;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > 200 ||
      files.some((file) => typeof file !== "string")
    ) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} files must be a non-empty array of relative paths`,
      });
    }
    const verify = entry.verify;
    if (
      !Array.isArray(verify) ||
      verify.length === 0 ||
      verify.length > 50 ||
      verify.some((command) => typeof command !== "string")
    ) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} verify must be a non-empty array of commands`,
      });
    }
    const normalizedFiles = files.map((file) =>
      normalizeRelativePath(file, `phase ${phaseId} file`),
    );
    if (new Set(normalizedFiles).size !== normalizedFiles.length) {
      throw new HTTPException(400, {
        message: `phase ${phaseId} files must not contain duplicates`,
      });
    }
    return {
      phaseId: phaseId.trim(),
      parserTaskId: parserTaskId.trim(),
      ordinal,
      required: entry.required === undefined ? true : entry.required,
      title: title.trim(),
      ...(description === undefined ? {} : { description }),
      files: normalizedFiles,
      verify: verify.map((command) => command.trim()),
    };
  });
  for (const phase of canonical) {
    if (seenPhaseIds.has(phase.phaseId)) {
      throw new HTTPException(400, {
        message: `duplicate phaseId: ${phase.phaseId}`,
      });
    }
    seenPhaseIds.add(phase.phaseId);
    if (seenParserTaskIds.has(phase.parserTaskId)) {
      throw new HTTPException(400, {
        message: `duplicate parserTaskId: ${phase.parserTaskId}`,
      });
    }
    seenParserTaskIds.add(phase.parserTaskId);
    if (seenOrdinals.has(phase.ordinal)) {
      throw new HTTPException(400, {
        message: `duplicate ordinal: ${phase.ordinal}`,
      });
    }
    seenOrdinals.add(phase.ordinal);
  }
  return canonical.sort((left, right) => left.ordinal - right.ordinal);
}

/**
 * Validate the legacy worker-contract JSON block that must start the FULL
 * task description: schema 1, agent pi-prodesk, repo, path '.', state ready,
 * spec id, task_id FULL, and files/scope/writes equal to the sorted union of
 * all phase files.
 */
export function parseFullRunWorkerContract(
  description: unknown,
  expected: { specId: string; sortedUnionFiles: string[] },
): Record<string, unknown> {
  if (typeof description !== "string" || description.length > 128 * 1024) {
    throw new HTTPException(400, {
      message: "full.description must be a bounded string",
    });
  }
  if (!description.startsWith("{")) {
    throw new HTTPException(400, {
      message:
        "full.description must start with the legacy worker-contract JSON block",
    });
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < description.length; index += 1) {
    const character = description[index];
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
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    throw new HTTPException(400, {
      message: "full.description worker-contract JSON block is unterminated",
    });
  }
  let contract: unknown;
  try {
    contract = JSON.parse(description.slice(0, end + 1));
  } catch {
    throw new HTTPException(400, {
      message: "full.description worker-contract JSON block is invalid",
    });
  }
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new HTTPException(400, {
      message: "full.description must start with a JSON object",
    });
  }
  const record = contract as Record<string, unknown>;
  if (record.schema !== 1) {
    throw new HTTPException(400, {
      message: "worker contract schema must be 1",
    });
  }
  if (record.agent !== "pi-prodesk") {
    throw new HTTPException(400, {
      message: "worker contract agent must be pi-prodesk",
    });
  }
  if (typeof record.repo !== "string" || !record.repo.trim()) {
    throw new HTTPException(400, {
      message: "worker contract repo is required",
    });
  }
  if (record.path !== ".") {
    throw new HTTPException(400, {
      message: 'worker contract path must be "."',
    });
  }
  if (record.state !== "ready") {
    throw new HTTPException(400, {
      message: "worker contract state must be ready",
    });
  }
  if (record.spec_id !== expected.specId) {
    throw new HTTPException(400, {
      message: "worker contract spec_id must match the published specId",
    });
  }
  if (record.task_id !== "FULL") {
    throw new HTTPException(400, {
      message: 'worker contract task_id must be "FULL"',
    });
  }
  const unionJson = JSON.stringify(expected.sortedUnionFiles);
  for (const field of ["files", "scope", "writes"]) {
    const value = record[field];
    if (!Array.isArray(value)) {
      throw new HTTPException(400, {
        message: `worker contract ${field} must be the sorted union of all phase files`,
      });
    }
    let normalized: string[];
    try {
      normalized = value.map((file) => normalizeRelativePath(file, field));
    } catch {
      throw new HTTPException(400, {
        message: `worker contract ${field} contains an invalid path`,
      });
    }
    if (JSON.stringify(normalized) !== unionJson) {
      throw new HTTPException(400, {
        message: `worker contract ${field} must equal the sorted union of all phase files`,
      });
    }
  }
  return record;
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

/**
 * Read the control-plane task state from the machine-readable envelope.
 * Normal Kaneo columns intentionally remain user-facing workflow columns, so
 * scheduled execution must not confuse a column slug such as `to-do` with the
 * internal published/ready/queued lifecycle.
 */
export function extractWorkerContractState(
  description: unknown,
): string | null {
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
    const record = candidate as Record<string, unknown>;
    if (
      (record.schema === 1 || typeof record.agent === "string") &&
      typeof record.state === "string"
    ) {
      return record.state.trim();
    }
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
    fallbackModels.length > 10 ||
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
      message:
        "fallbackModels must be an array of at most 10 registry model ids",
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
  if (
    new Set(normalizedFallbackModels).size !== normalizedFallbackModels.length
  ) {
    throw new HTTPException(400, {
      message: "fallbackModels must not contain duplicate models",
    });
  }
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
