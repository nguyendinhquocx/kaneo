CREATE TABLE "agent_principal" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"runtime_id" text NOT NULL,
	"host_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principal_user_runtime_unique" UNIQUE("user_id","runtime_id"),
	CONSTRAINT "agent_principal_runtime_unique" UNIQUE("runtime_id")
);
--> statement-breakpoint
CREATE TABLE "execution_idempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_principal_id" text,
	"run_id" text,
	"operation" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_idempotency_operation_key_unique" UNIQUE("operation","request_key")
);
--> statement-breakpoint
CREATE TABLE "execution_manifest" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"docs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verification_profile" text NOT NULL,
	"allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manifest_version" integer DEFAULT 1 NOT NULL,
	"protocol_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_manifest_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "task_run_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"agent_principal_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_run" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"manifest_id" text,
	"manifest_version" integer NOT NULL,
	"protocol_version" integer NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"base_branch" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"role" text DEFAULT 'worker' NOT NULL,
	"agent_principal_id" text,
	"host_id" text NOT NULL,
	"branch_name" text NOT NULL,
	"scope" jsonb NOT NULL,
	"base_sha" text,
	"commit_sha" text,
	"pr_number" integer,
	"pr_url" text,
	"pr_state" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blocker" text,
	"next_action" text,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"lease_epoch" integer DEFAULT 1 NOT NULL,
	"lease_token_hash" text NOT NULL,
	"lease_active" boolean DEFAULT true NOT NULL,
	"lease_expires_at" timestamp NOT NULL,
	"last_heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_run_requestKey_unique" UNIQUE("request_key")
);
--> statement-breakpoint
ALTER TABLE "agent_principal" ADD CONSTRAINT "agent_principal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_idempotency" ADD CONSTRAINT "execution_idempotency_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_idempotency" ADD CONSTRAINT "execution_idempotency_agent_principal_id_agent_principal_id_fk" FOREIGN KEY ("agent_principal_id") REFERENCES "public"."agent_principal"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_idempotency" ADD CONSTRAINT "execution_idempotency_run_id_task_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_manifest" ADD CONSTRAINT "execution_manifest_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_run_evidence" ADD CONSTRAINT "task_run_evidence_run_id_task_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_run_evidence" ADD CONSTRAINT "task_run_evidence_agent_principal_id_agent_principal_id_fk" FOREIGN KEY ("agent_principal_id") REFERENCES "public"."agent_principal"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_manifest_id_execution_manifest_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."execution_manifest"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_agent_principal_id_agent_principal_id_fk" FOREIGN KEY ("agent_principal_id") REFERENCES "public"."agent_principal"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "agent_principal_userId_idx" ON "agent_principal" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "execution_idempotency_userId_idx" ON "execution_idempotency" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "execution_idempotency_runId_idx" ON "execution_idempotency" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "execution_manifest_projectId_idx" ON "execution_manifest" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_run_evidence_runId_idx" ON "task_run_evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "task_run_evidence_agentPrincipalId_idx" ON "task_run_evidence" USING btree ("agent_principal_id");--> statement-breakpoint
CREATE INDEX "task_run_taskId_idx" ON "task_run" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_run_agentPrincipalId_idx" ON "task_run" USING btree ("agent_principal_id");--> statement-breakpoint
CREATE INDEX "task_run_leaseExpiresAt_idx" ON "task_run" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_run_active_task_unique" ON "task_run" USING btree ("task_id") WHERE "task_run"."lease_active" = true;