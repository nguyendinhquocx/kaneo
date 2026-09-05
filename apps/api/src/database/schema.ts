import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userTable = pgTable("user", {
  id: text("id")
    .$defaultFn(() => createId())
    .primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  locale: text("locale"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  isAnonymous: boolean("is_anonymous").default(false),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { mode: "date" }),
});

export const agentPrincipalTable = pgTable(
  "agent_principal",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    runtimeId: text("runtime_id").notNull(),
    hostId: text("host_id").notNull(),
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("agent_principal_userId_idx").on(table.userId),
    unique("agent_principal_user_runtime_unique").on(
      table.userId,
      table.runtimeId,
    ),
    unique("agent_principal_runtime_unique").on(table.runtimeId),
  ],
);

export const sessionTable = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const accountTable = pgTable(
  "account",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      mode: "date",
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      mode: "date",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verificationTable = pgTable(
  "verification",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const workspaceTable = pgTable("workspace", {
  id: text("id")
    .$defaultFn(() => createId())
    .primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  description: text("description"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
});

export const workspaceUserTable = pgTable(
  "workspace_member",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
      }),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
      }),
    role: text("role").default("member").notNull(),
    joinedAt: timestamp("joined_at", { mode: "date" }).notNull(),
  },
  (table) => [
    index("workspace_member_workspaceId_idx").on(table.workspaceId),
    index("workspace_member_userId_idx").on(table.userId),
  ],
);

export const teamTable = pgTable(
  "team",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").$onUpdate(
      () => /* @__PURE__ */ new Date(),
    ),
  },
  (table) => [index("team_workspaceId_idx").on(table.workspaceId)],
);

export const teamMemberTable = pgTable(
  "team_member",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teamTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("teamMember_teamId_idx").on(table.teamId),
    index("teamMember_userId_idx").on(table.userId),
  ],
);

export const invitationTable = pgTable(
  "invitation",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    teamId: text("team_id"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_workspaceId_idx").on(table.workspaceId),
    index("invitation_email_idx").on(table.email),
    index("invitation_inviterId_idx").on(table.inviterId),
  ],
);

export const workspaceRoleTable = pgTable(
  "workspace_role",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    role: text("role").notNull(),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("workspace_role_workspaceId_idx").on(table.workspaceId),
    index("workspace_role_role_idx").on(table.role),
  ],
);

export const projectTable = pgTable(
  "project",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    slug: text("slug").notNull(),
    icon: text("icon").default("Layout"),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    isPublic: boolean("is_public").default(false),
    archivedAt: timestamp("archived_at", { mode: "date" }),
    lastTaskNumber: integer("last_task_number").notNull().default(0),
    // SPEC-kaneo-phase-cards-full-run-server-v0-1: server-owned revision for
    // graph publish / ready CAS (WHERE project_revision = expected).
    projectRevision: integer("project_revision").notNull().default(1),
  },
  (table) => [
    unique("project_workspace_id_id_unique").on(table.workspaceId, table.id),
  ],
);

export const executionFlagTable = pgTable("execution_flag", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const executionManifestTable = pgTable(
  "execution_manifest",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      })
      .unique(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    baseBranch: text("base_branch").notNull().default("main"),
    docs: jsonb("docs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    verificationProfile: text("verification_profile").notNull(),
    allowedAgentIds: jsonb("allowed_agent_ids")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    policy: jsonb("policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    manifestVersion: integer("manifest_version").notNull().default(1),
    protocolVersion: integer("protocol_version").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("execution_manifest_projectId_idx").on(table.projectId)],
);

export const executionScheduleTable = pgTable(
  "execution_schedule",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    requestKey: text("request_key").notNull().unique(),
    notBefore: timestamp("not_before", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    cronExpr: text("cron_expr"),
    timezone: text("timezone").notNull().default("UTC"),
    host: text("host").notNull().default("prodesk-home"),
    preferredModel: text("preferred_model"),
    fallbackModels: jsonb("fallback_models")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fallbackMode: text("fallback_mode").notNull().default("manual"),
    maxRuntimeSeconds: integer("max_runtime_seconds").notNull(),
    retryPolicy: jsonb("retry_policy")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    concurrencyKey: text("concurrency_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // SPEC-kaneo-native-telegram-control-v0-1: dispatch binds this snapshot.
    scheduleRevision: integer("schedule_revision").notNull().default(1),
    disableReason: text("disable_reason"),
    lastFailureAt: timestamp("last_failure_at", {
      mode: "date",
      withTimezone: true,
    }),
    dependencyPolicy: text("dependency_policy").notNull().default("reject"),
    notificationRoute: text("notification_route"),
    telegramQuotaResume: text("telegram_quota_resume")
      .notNull()
      .default("disabled"),
    planHash: text("plan_hash"),
    lastDispatchAt: timestamp("last_dispatch_at", {
      mode: "date",
      withTimezone: true,
    }),
    nextDispatchAt: timestamp("next_dispatch_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("execution_schedule_taskId_idx").on(table.taskId),
    index("execution_schedule_due_idx").on(
      table.enabled,
      table.host,
      table.notBefore,
    ),
  ],
);

export const executionScheduleOccurrenceTable = pgTable(
  "execution_schedule_occurrence",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => executionScheduleTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    occurrenceKey: text("occurrence_key").notNull().unique(),
    scheduledFor: timestamp("scheduled_for", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    state: text("state").notNull().default("planned"),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true }),
    claimGeneration: integer("claim_generation").notNull().default(0),
    // Snapshot bound at dispatch (revision CAS against schedule/task drift).
    scheduleRevision: integer("schedule_revision").notNull().default(1),
    taskRevision: integer("task_revision").notNull().default(1),
    manifestVersion: integer("manifest_version").notNull().default(1),
    planHash: text("plan_hash"),
    // Hash of the one-time supervisor fence handed to the fixed runner via
    // the local 0600 handoff file; required by /supervisor-report.
    supervisorFenceHash: text("supervisor_fence_hash"),
    ackTokenHash: text("ack_token_hash"),
    runId: text("run_id").references(() => taskRunTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("execution_schedule_occurrence_scheduleId_idx").on(table.scheduleId),
    index("execution_schedule_occurrence_runId_idx").on(table.runId),
  ],
);

export const columnTable = pgTable(
  "column",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    position: integer("position").notNull().default(0),
    icon: text("icon"),
    color: text("color"),
    isFinal: boolean("is_final").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("column_projectId_idx").on(table.projectId)],
);

export const workflowRuleTable = pgTable(
  "workflow_rule",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationType: text("integration_type").notNull(),
    eventType: text("event_type").notNull(),
    columnId: text("column_id")
      .notNull()
      .references(() => columnTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("workflow_rule_projectId_idx").on(table.projectId),
    index("workflow_rule_columnId_idx").on(table.columnId),
  ],
);

export const taskTable = pgTable(
  "task",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    position: integer("position").default(0),
    number: integer("number").default(1),
    userId: text("assignee_id").references(() => userTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("to-do"),
    columnId: text("column_id").references(() => columnTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    priority: text("priority").default("low"),
    startDate: timestamp("start_date", { mode: "date" }),
    dueDate: timestamp("due_date", { mode: "date" }),
    // SPEC-kaneo-native-telegram-control-v0-1: execution lifecycle authority.
    // Kanban `status`/`columnId` above are presentation mapping only.
    executionState: text("execution_state").notNull().default("published"),
    taskRevision: integer("task_revision").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("task_projectId_idx").on(table.projectId),
    index("task_dueDate_idx").on(table.dueDate),
    index("task_assigneeId_idx").on(table.userId),
    index("task_columnId_idx").on(table.columnId),
    unique("task_project_number_unique").on(table.projectId, table.number),
  ],
);

export const taskRunTable = pgTable(
  "task_run",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    scheduleId: text("schedule_id").references(
      () => executionScheduleTable.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    manifestId: text("manifest_id").references(
      () => executionManifestTable.id,
      {
        onDelete: "set null",
        onUpdate: "cascade",
      },
    ),
    manifestVersion: integer("manifest_version").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: text("state").notNull().default("in_progress"),
    role: text("role").notNull().default("worker"),
    agentPrincipalId: text("agent_principal_id").references(
      () => agentPrincipalTable.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    hostId: text("host_id").notNull(),
    branchName: text("branch_name").notNull(),
    scope: jsonb("scope").$type<string[]>().notNull(),
    baseSha: text("base_sha"),
    commitSha: text("commit_sha"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prState: text("pr_state"),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    blocker: text("blocker"),
    nextAction: text("next_action"),
    // SPEC-kaneo-native-telegram-control-v0-1: revision CAS fence + lineage.
    runRevision: integer("run_revision").notNull().default(1),
    taskRevisionAtClaim: integer("task_revision_at_claim").notNull().default(1),
    scheduleRevision: integer("schedule_revision"),
    parentRunId: text("parent_run_id").references(
      (): AnyPgColumn => taskRunTable.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    logicalSessionId: text("logical_session_id"),
    retryAt: timestamp("retry_at", { mode: "date", withTimezone: true }),
    modelFailed: text("model_failed"),
    failureKind: text("failure_kind"),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(1),
    lastCheckpointSha: text("last_checkpoint_sha"),
    lastCommitSha: text("last_commit_sha"),
    finalizationReceipt: jsonb("finalization_receipt")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    manualRecoveryRequired: boolean("manual_recovery_required")
      .notNull()
      .default(false),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    leaseEpoch: integer("lease_epoch").notNull().default(1),
    leaseTokenHash: text("lease_token_hash").notNull(),
    leaseActive: boolean("lease_active").notNull().default(true),
    leaseExpiresAt: timestamp("lease_expires_at", { mode: "date" }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { mode: "date" })
      .defaultNow()
      .notNull(),
    // SPEC-kaneo-wavefix-v0-2 (T0): last liveness/progress signal (claim,
    // heartbeat, report, checkpoint). Nullable for rows predating the
    // column; watchdogs fall back to last_heartbeat_at when null.
    lastProgressAt: timestamp("last_progress_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("task_run_taskId_idx").on(table.taskId),
    index("task_run_scheduleId_idx").on(table.scheduleId),
    index("task_run_agentPrincipalId_idx").on(table.agentPrincipalId),
    index("task_run_leaseExpiresAt_idx").on(table.leaseExpiresAt),
    unique("task_run_requestKey_unique").on(table.requestKey),
    uniqueIndex("task_run_active_task_unique")
      .on(table.taskId)
      .where(sql`${table.leaseActive} = true`),
  ],
);

export const taskRunEvidenceTable = pgTable(
  "task_run_evidence",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => taskRunTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    agentPrincipalId: text("agent_principal_id").references(
      () => agentPrincipalTable.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("task_run_evidence_runId_idx").on(table.runId),
    index("task_run_evidence_agentPrincipalId_idx").on(table.agentPrincipalId),
  ],
);

// SPEC-kaneo-native-telegram-control-v0-1 (T1): durable checkpoint ledger.
// A checkpoint is only accepted with a fixed Git guard push receipt proving
// remote head == commit; requestId gives at-most-once acceptance per receipt.
export const taskRunCheckpointTable = pgTable(
  "task_run_checkpoint",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => taskRunTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    requestId: text("request_id").notNull().unique(),
    leaseEpoch: integer("lease_epoch").notNull(),
    baseSha: text("base_sha"),
    headSha: text("head_sha").notNull(),
    commitSha: text("commit_sha").notNull(),
    guardReceipt: jsonb("guard_receipt")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    commands: jsonb("commands")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    artifactHashes: jsonb("artifact_hashes")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    verifyResult: jsonb("verify_result")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // SPEC-kaneo-phase-cards-full-run-server-v0-1: phase provenance. Required
    // for new FULL-run phase checkpoints; nullable for legacy rows which are
    // never accepted as phase proof.
    phaseId: text("phase_id"),
    specSha256: text("spec_sha256"),
    sourcePhaseMapSha256: text("source_phase_map_sha256"),
    receiptHash: text("receipt_hash"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("task_run_checkpoint_runId_idx").on(table.runId)],
);

// Control requests are structured mutations created by parent or the Telegram
// observer; only the dispatcher consumes them with a CAS claim. The actor is
// always derived from the authenticated principal, never from the body.
export const executionControlRequestTable = pgTable(
  "execution_control_request",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    requestId: text("request_id").notNull().unique(),
    actorType: text("actor_type").notNull(),
    authenticatedPrincipalId: text("authenticated_principal_id"),
    actorUserId: text("actor_user_id").references(() => userTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    route: text("route"),
    host: text("host"),
    action: text("action").notNull(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    runId: text("run_id").references(() => taskRunTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    eventId: text("event_id"),
    deliveryId: text("delivery_id"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    expectedTaskRevision: integer("expected_task_revision"),
    expectedRunRevision: integer("expected_run_revision"),
    state: text("state").notNull().default("pending"),
    resultHash: text("result_hash"),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    appliedAt: timestamp("applied_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("execution_control_request_state_idx").on(
      table.state,
      table.expiresAt,
    ),
    index("execution_control_request_host_idx").on(table.host, table.state),
  ],
);

// Per-task monotonic sequence allocator for the transactional notification
// outbox. Allocated with FOR UPDATE inside the emitting transaction.
export const executionNotificationSequenceTable = pgTable(
  "execution_notification_sequence",
  {
    taskId: text("task_id")
      .primaryKey()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    nextSequence: integer("next_sequence").notNull().default(0),
  },
);

// Transactional notification outbox. Rows are written in the same DB
// transaction as the state mutation they announce; FIFO per task by sequence.
export const executionNotificationEventTable = pgTable(
  "execution_notification_event",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    runId: text("run_id").references(() => taskRunTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    sequence: integer("sequence").notNull(),
    kind: text("kind").notNull(),
    route: text("route").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    payloadHash: text("payload_hash"),
    state: text("state").notNull().default("pending"),
    availableAt: timestamp("available_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("execution_notification_event_route_state_idx").on(
      table.route,
      table.state,
      table.availableAt,
    ),
  ],
);

// Delivery tracking for outbox events (at-least-once Telegram semantics).
// send_unknown marks crash-after-send; reconcile, never auto-resend blindly.
export const executionNotificationDeliveryTable = pgTable(
  "execution_notification_delivery",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => executionNotificationEventTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    route: text("route").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimExpiresAt: timestamp("claim_expires_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastError: text("last_error"),
    sendUnknown: boolean("send_unknown").notNull().default(false),
    telegramMessageIds: jsonb("telegram_message_ids")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    ackedAt: timestamp("acked_at", { mode: "date", withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("execution_notification_delivery_eventId_idx").on(table.eventId),
    index("execution_notification_delivery_claim_idx").on(
      table.state,
      table.claimExpiresAt,
    ),
    // Mirrors the UNIQUE(event_id, route) constraint created by migration
    // 0045. Declared here so drizzle-kit push/regen cannot silently drop the
    // dedupe boundary the outbox ON CONFLICT depends on.
    uniqueIndex("execution_notification_delivery_event_id_route_uidx").on(
      table.eventId,
      table.route,
    ),
  ],
);

export const executionIdempotencyTable = pgTable(
  "execution_idempotency",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    agentPrincipalId: text("agent_principal_id").references(
      () => agentPrincipalTable.id,
      { onDelete: "set null", onUpdate: "cascade" },
    ),
    runId: text("run_id").references(() => taskRunTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    operation: text("operation").notNull(),
    requestKey: text("request_key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("execution_idempotency_userId_idx").on(table.userId),
    index("execution_idempotency_runId_idx").on(table.runId),
    unique("execution_idempotency_operation_key_unique").on(
      table.operation,
      table.requestKey,
    ),
  ],
);

// SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): server-side mapping of
// FULL task phases to child Kanban cards. The mapping — never a missing
// envelope — is the claim guard: a phase child cannot be claimed, scheduled
// or generically mutated. Exactly one card per (full_task_id, phase_id) and
// one mapping per child.
export const executionPhaseCardTable = pgTable(
  "execution_phase_card",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    fullTaskId: text("full_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    childTaskId: text("child_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    phaseId: text("phase_id").notNull(),
    parserTaskId: text("parser_task_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    required: boolean("required").notNull().default(true),
    graphId: text("graph_id").notNull(),
    specSha256: text("spec_sha256").notNull(),
    sourcePhaseMapSha256: text("source_phase_map_sha256").notNull(),
    graphMapSha256: text("graph_map_sha256").notNull(),
    planHash: text("plan_hash").notNull(),
    changeSetId: text("change_set_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("execution_phase_card_full_ordinal_idx").on(
      table.fullTaskId,
      table.ordinal,
    ),
    index("execution_phase_card_projectId_idx").on(table.projectId),
    unique("execution_phase_card_full_phase_unique").on(
      table.fullTaskId,
      table.phaseId,
    ),
    unique("execution_phase_card_child_task_unique").on(table.childTaskId),
  ],
);

// Fenced progress ledger: the server authority for phase state and checkpoint
// provenance. Kanban cards are projections of this ledger, never the reverse.
export const executionPhaseProgressTable = pgTable(
  "execution_phase_progress",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    fullTaskId: text("full_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    phaseId: text("phase_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    // pending | in_progress | done | blocked
    state: text("state").notNull().default("pending"),
    runId: text("run_id").references(() => taskRunTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    parentRunId: text("parent_run_id").references(() => taskRunTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    leaseEpoch: integer("lease_epoch"),
    ledgerVersion: integer("ledger_version").notNull().default(1),
    checkpointId: text("checkpoint_id"),
    commitSha: text("commit_sha"),
    branchName: text("branch_name"),
    baseSha: text("base_sha"),
    reason: text("reason"),
    failureKind: text("failure_kind"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("execution_phase_progress_full_ordinal_idx").on(
      table.fullTaskId,
      table.ordinal,
    ),
    index("execution_phase_progress_run_state_idx").on(
      table.runId,
      table.state,
    ),
    unique("execution_phase_progress_full_phase_unique").on(
      table.fullTaskId,
      table.phaseId,
    ),
  ],
);

// Durable projection outbox decoupling ledger commits from child card
// status/comment writes. Reconcile is idempotent per
// (fullTaskId, phaseId, projectionKind, ledgerVersion); a failed projection
// is display_pending and never blocks the worker or rolls back the ledger.
export const executionPhaseProjectionTable = pgTable(
  "execution_phase_projection",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    fullTaskId: text("full_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    phaseId: text("phase_id").notNull(),
    projectionKind: text("projection_kind").notNull(),
    ledgerVersion: integer("ledger_version").notNull(),
    childTaskId: text("child_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    desiredColumnSlug: text("desired_column_slug"),
    markerPayload: jsonb("marker_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    markerHash: text("marker_hash").notNull(),
    // pending | applied | failed
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    appliedAt: timestamp("applied_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("execution_phase_projection_state_idx").on(table.state),
    unique("execution_phase_projection_unique").on(
      table.fullTaskId,
      table.phaseId,
      table.projectionKind,
      table.ledgerVersion,
    ),
  ],
);

export const taskReminderSentTable = pgTable(
  "task_reminder_sent",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    reminderType: text("reminder_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("task_reminder_sent_taskId_idx").on(table.taskId),
    unique("task_reminder_sent_task_type_unique").on(
      table.taskId,
      table.reminderType,
    ),
  ],
);

export const timeEntryTable = pgTable(
  "time_entry",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userId: text("user_id").references(() => userTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    description: text("description"),
    startTime: timestamp("start_time", { mode: "date" }).notNull(),
    endTime: timestamp("end_time", { mode: "date" }),
    duration: integer("duration").default(0),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("time_entry_taskId_idx").on(table.taskId),
    index("time_entry_userId_idx").on(table.userId),
  ],
);

export const activityTable = pgTable(
  "activity",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id").references(() => userTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    content: text("content"),
    eventData: jsonb("event_data"),
    externalUserName: text("external_user_name"),
    externalUserAvatar: text("external_user_avatar"),
    externalSource: text("external_source"),
    externalUrl: text("external_url"),
  },
  (table) => [
    index("activity_task_id_idx").on(table.taskId),
    index("activity_userId_idx").on(table.userId),
    unique("activity_task_external_source_external_url_unique").on(
      table.taskId,
      table.externalSource,
      table.externalUrl,
    ),
  ],
);

export const assetTable = pgTable(
  "asset",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    taskId: text("task_id").references(() => taskTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    activityId: text("activity_id").references(() => activityTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    objectKey: text("object_key").notNull().unique(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    kind: text("kind").notNull().default("image"),
    surface: text("surface").notNull().default("description"),
    createdBy: text("created_by").references(() => userTable.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("asset_workspaceId_idx").on(table.workspaceId),
    index("asset_projectId_idx").on(table.projectId),
    index("asset_taskId_idx").on(table.taskId),
    index("asset_activityId_idx").on(table.activityId),
    index("asset_createdBy_idx").on(table.createdBy),
  ],
);

export const labelTable = pgTable(
  "label",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    taskId: text("task_id").references(() => taskTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    workspaceId: text("workspace_id").references(() => workspaceTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
  },
  (table) => [
    index("label_task_id_idx").on(table.taskId),
    index("label_workspace_id_idx").on(table.workspaceId),
    unique("label_task_name_unique").on(table.taskId, table.name),
    uniqueIndex("label_workspace_name_unique")
      .on(table.workspaceId, table.name)
      .where(sql`${table.taskId} is null`),
  ],
);

export const notificationTable = pgTable(
  "notification",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    title: text("title"),
    content: text("content"),
    type: text("type").notNull().default("info"),
    eventData: jsonb("event_data"),
    isRead: boolean("is_read").default(false),
    resourceId: text("resource_id"),
    resourceType: text("resource_type"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("notification_userId_idx").on(table.userId)],
);

export const userNotificationPreferenceTable = pgTable(
  "user_notification_preference",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    emailEnabled: boolean("email_enabled").default(false).notNull(),
    ntfyEnabled: boolean("ntfy_enabled").default(false).notNull(),
    ntfyServerUrl: text("ntfy_server_url"),
    ntfyTopic: text("ntfy_topic"),
    ntfyToken: text("ntfy_token"),
    gotifyEnabled: boolean("gotify_enabled").default(false).notNull(),
    gotifyServerUrl: text("gotify_server_url"),
    gotifyToken: text("gotify_token"),
    webhookEnabled: boolean("webhook_enabled").default(false).notNull(),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret"),
    taskAssignmentEnabled: boolean("task_assignment_enabled")
      .default(true)
      .notNull(),
    taskCommentEnabled: boolean("task_comment_enabled").default(true).notNull(),
    taskStatusChangeEnabled: boolean("task_status_change_enabled")
      .default(true)
      .notNull(),
    dueDateReminderEnabled: boolean("due_date_reminder_enabled")
      .default(true)
      .notNull(),
    dueDateReminderLeadTimeMinutes: integer(
      "due_date_reminder_lead_time_minutes",
    )
      .default(1440)
      .notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
);

export const userNotificationWorkspaceRuleTable = pgTable(
  "user_notification_workspace_rule",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    isActive: boolean("is_active").default(true).notNull(),
    emailEnabled: boolean("email_enabled").default(false).notNull(),
    ntfyEnabled: boolean("ntfy_enabled").default(false).notNull(),
    gotifyEnabled: boolean("gotify_enabled").default(false).notNull(),
    webhookEnabled: boolean("webhook_enabled").default(false).notNull(),
    projectMode: text("project_mode").default("all").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("user_notification_workspace_rule_userId_idx").on(table.userId),
    index("user_notification_workspace_rule_workspaceId_idx").on(
      table.workspaceId,
    ),
    unique("user_notification_workspace_rule_user_workspace_unique").on(
      table.userId,
      table.workspaceId,
    ),
    unique("user_notification_workspace_rule_workspace_id_id_unique").on(
      table.workspaceId,
      table.id,
    ),
  ],
);

export const userNotificationWorkspaceProjectTable = pgTable(
  "user_notification_workspace_project",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    workspaceRuleId: text("workspace_rule_id").notNull(),
    projectId: text("project_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.workspaceRuleId],
      foreignColumns: [
        userNotificationWorkspaceRuleTable.workspaceId,
        userNotificationWorkspaceRuleTable.id,
      ],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [projectTable.workspaceId, projectTable.id],
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    index("user_notification_workspace_project_ruleId_idx").on(
      table.workspaceRuleId,
    ),
    index("user_notification_workspace_project_projectId_idx").on(
      table.projectId,
    ),
    index("user_notification_workspace_project_workspaceId_projectId_idx").on(
      table.workspaceId,
      table.projectId,
    ),
    index("unwp_workspaceId_workspaceRuleId_idx").on(
      table.workspaceId,
      table.workspaceRuleId,
    ),
    unique("user_notification_workspace_project_rule_project_unique").on(
      table.workspaceRuleId,
      table.projectId,
    ),
  ],
);

export const githubIntegrationTable = pgTable("github_integration", {
  id: text("id")
    .$defaultFn(() => createId())
    .primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projectTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    })
    .unique(),
  repositoryOwner: text("repository_owner").notNull(),
  repositoryName: text("repository_name").notNull(),
  installationId: integer("installation_id"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const integrationTable = pgTable(
  "integration",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projectTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    type: text("type").notNull(),
    config: text("config").notNull(),
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("integration_projectId_idx").on(table.projectId),
    index("integration_type_idx").on(table.type),
    unique("integration_project_type_unique").on(table.projectId, table.type),
  ],
);

export const externalLinkTable = pgTable(
  "external_link",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: text("integration_id")
      .notNull()
      .references(() => integrationTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    resourceType: text("resource_type").notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("external_link_taskId_idx").on(table.taskId),
    index("external_link_integrationId_idx").on(table.integrationId),
    index("external_link_externalId_idx").on(table.externalId),
    index("external_link_resourceType_idx").on(table.resourceType),
  ],
);

export const commentTable = pgTable(
  "comment",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    userId: text("user_id")
      .notNull()
      .references(() => userTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("comment_task_idx").on(table.taskId),
    index("comment_user_idx").on(table.userId),
  ],
);

export const taskRelationTable = pgTable(
  "task_relation",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    sourceTaskId: text("source_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    targetTaskId: text("target_task_id")
      .notNull()
      .references(() => taskTable.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    relationType: text("relation_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("task_relation_source_idx").on(table.sourceTaskId),
    index("task_relation_target_idx").on(table.targetTaskId),
  ],
);

export const apikeyTable = pgTable(
  "apikey",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    configId: text("config_id").default("default").notNull(),
    name: text("name"),
    start: text("start"),
    referenceId: text("reference_id")
      .notNull()
      .references(() => userTable.id, { onDelete: "cascade" }),
    prefix: text("prefix"),
    key: text("key").notNull(),
    userId: text("user_id").references(() => userTable.id, {
      onDelete: "cascade",
    }),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { mode: "date" }),
    enabled: boolean("enabled").default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window").default(86400000),
    rateLimitMax: integer("rate_limit_max").default(10),
    requestCount: integer("request_count").default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_configId_idx").on(table.configId),
    index("apikey_key_idx").on(table.key),
    index("apikey_referenceId_idx").on(table.referenceId),
    index("apikey_userId_idx").on(table.userId),
  ],
);

export const deviceCodeTable = pgTable(
  "device_code",
  {
    id: text("id")
      .$defaultFn(() => createId())
      .primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id").references(() => userTable.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    status: text("status").notNull(),
    lastPolledAt: timestamp("last_polled_at", { mode: "date" }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (table) => [
    uniqueIndex("device_code_device_code_uidx").on(table.deviceCode),
    uniqueIndex("device_code_user_code_uidx").on(table.userCode),
    index("device_code_user_id_idx").on(table.userId),
  ],
);

// Auth-schema compatible aliases in schema.ts
export const user = userTable;
export const session = sessionTable;
export const account = accountTable;
export const verification = verificationTable;
export const workspace = workspaceTable;
export const team = teamTable;
export const teamMember = teamMemberTable;
export const workspace_member = workspaceUserTable;
export const invitation = invitationTable;
export const organizationRole = workspaceRoleTable;
export const apikey = apikeyTable;
export const deviceCode = deviceCodeTable;

// Auth-schema compatible relation exports in schema.ts
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  teamMembers: many(teamMember),
  workspace_members: many(workspace_member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const workspaceRelations = relations(workspace, ({ many }) => ({
  teams: many(team),
  workspace_members: many(workspace_member),
  invitations: many(invitation),
}));

export const teamRelations = relations(team, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [team.workspaceId],
    references: [workspace.id],
  }),
  teamMembers: many(teamMember),
}));

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
  team: one(team, {
    fields: [teamMember.teamId],
    references: [team.id],
  }),
  user: one(user, {
    fields: [teamMember.userId],
    references: [user.id],
  }),
}));

export const workspace_memberRelations = relations(
  workspace_member,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [workspace_member.workspaceId],
      references: [workspace.id],
    }),
    user: one(user, {
      fields: [workspace_member.userId],
      references: [user.id],
    }),
  }),
);

export const invitationRelations = relations(invitation, ({ one }) => ({
  workspace: one(workspace, {
    fields: [invitation.workspaceId],
    references: [workspace.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

export const organizationRoleRelations = relations(
  organizationRole,
  ({ one }) => ({
    workspace: one(workspace, {
      fields: [organizationRole.workspaceId],
      references: [workspace.id],
    }),
  }),
);
