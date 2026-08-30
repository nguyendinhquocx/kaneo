-- SPEC-kaneo-native-telegram-control-v0-1 (T1): canonical execution state,
-- monotonic revision counters (CAS), run lineage/checkpoint records, control
-- requests and the transactional notification outbox. Existing rows backfill
-- revision counters to 1; `task.execution_state` is backfilled from the only
-- trustworthy signal (`status = 'done'`), everything else restarts as
-- `published` so the parent explicitly re-readies tasks for native execution.

ALTER TABLE "task" ADD COLUMN "execution_state" text DEFAULT 'published' NOT NULL;
ALTER TABLE "task" ADD COLUMN "task_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "task" SET "execution_state" = 'done' WHERE "status" = 'done';
--> statement-breakpoint
ALTER TABLE "task_run" ADD COLUMN "run_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "task_run" ADD COLUMN "task_revision_at_claim" integer DEFAULT 1 NOT NULL;
ALTER TABLE "task_run" ADD COLUMN "schedule_revision" integer;
ALTER TABLE "task_run" ADD COLUMN "parent_run_id" text;
ALTER TABLE "task_run" ADD COLUMN "logical_session_id" text;
ALTER TABLE "task_run" ADD COLUMN "retry_at" timestamp with time zone;
ALTER TABLE "task_run" ADD COLUMN "model_failed" text;
ALTER TABLE "task_run" ADD COLUMN "failure_kind" text;
ALTER TABLE "task_run" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;
ALTER TABLE "task_run" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;
ALTER TABLE "task_run" ADD COLUMN "last_checkpoint_sha" text;
ALTER TABLE "task_run" ADD COLUMN "last_commit_sha" text;
ALTER TABLE "task_run" ADD COLUMN "finalization_receipt" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "task_run" ADD COLUMN "manual_recovery_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD COLUMN "schedule_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "execution_schedule" ADD COLUMN "disable_reason" text;
ALTER TABLE "execution_schedule" ADD COLUMN "last_failure_at" timestamp with time zone;
ALTER TABLE "execution_schedule" ADD COLUMN "dependency_policy" text DEFAULT 'reject' NOT NULL;
ALTER TABLE "execution_schedule" ADD COLUMN "notification_route" text;
ALTER TABLE "execution_schedule" ADD COLUMN "telegram_quota_resume" text DEFAULT 'disabled' NOT NULL;
ALTER TABLE "execution_schedule" ADD COLUMN "plan_hash" text;
--> statement-breakpoint
ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "schedule_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "task_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "manifest_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "plan_hash" text;
ALTER TABLE "execution_schedule_occurrence" ADD COLUMN "supervisor_fence_hash" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_run_checkpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"task_id" text NOT NULL,
	"request_id" text NOT NULL,
	"lease_epoch" integer NOT NULL,
	"base_sha" text,
	"head_sha" text NOT NULL,
	"commit_sha" text NOT NULL,
	"guard_receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verify_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_run_checkpoint_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_control_request" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"authenticated_principal_id" text,
	"actor_user_id" text,
	"route" text,
	"host" text,
	"action" text NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"event_id" text,
	"delivery_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expected_task_revision" integer,
	"expected_run_revision" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"result_hash" text,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_control_request_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_notification_sequence" (
	"task_id" text PRIMARY KEY NOT NULL,
	"next_sequence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_notification_event" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"route" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_hash" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_notification_event_task_id_sequence_unique" UNIQUE("task_id","sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_notification_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"route" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claim_expires_at" timestamp with time zone,
	"last_error" text,
	"send_unknown" boolean DEFAULT false NOT NULL,
	"telegram_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acked_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_notification_delivery_event_id_route_unique" UNIQUE("event_id","route")
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'task_run_parent_run_id_task_run_id_fk'
		  AND conrelid = 'task_run'::regclass
	) THEN
		ALTER TABLE "task_run" ADD CONSTRAINT "task_run_parent_run_id_task_run_id_fk"
			FOREIGN KEY ("parent_run_id") REFERENCES "public"."task_run"("id")
			ON DELETE set null ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'task_run_checkpoint_run_id_task_run_id_fk'
		  AND conrelid = 'task_run_checkpoint'::regclass
	) THEN
		ALTER TABLE "task_run_checkpoint" ADD CONSTRAINT "task_run_checkpoint_run_id_task_run_id_fk"
			FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'task_run_checkpoint_task_id_task_id_fk'
		  AND conrelid = 'task_run_checkpoint'::regclass
	) THEN
		ALTER TABLE "task_run_checkpoint" ADD CONSTRAINT "task_run_checkpoint_task_id_task_id_fk"
			FOREIGN KEY ("task_id") REFERENCES "public"."task"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_control_request_actor_user_id_user_id_fk'
		  AND conrelid = 'execution_control_request'::regclass
	) THEN
		ALTER TABLE "execution_control_request" ADD CONSTRAINT "execution_control_request_actor_user_id_user_id_fk"
			FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id")
			ON DELETE set null ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_control_request_task_id_task_id_fk'
		  AND conrelid = 'execution_control_request'::regclass
	) THEN
		ALTER TABLE "execution_control_request" ADD CONSTRAINT "execution_control_request_task_id_task_id_fk"
			FOREIGN KEY ("task_id") REFERENCES "public"."task"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_control_request_run_id_task_run_id_fk'
		  AND conrelid = 'execution_control_request'::regclass
	) THEN
		ALTER TABLE "execution_control_request" ADD CONSTRAINT "execution_control_request_run_id_task_run_id_fk"
			FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id")
			ON DELETE set null ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_notification_sequence_task_id_task_id_fk'
		  AND conrelid = 'execution_notification_sequence'::regclass
	) THEN
		ALTER TABLE "execution_notification_sequence" ADD CONSTRAINT "execution_notification_sequence_task_id_task_id_fk"
			FOREIGN KEY ("task_id") REFERENCES "public"."task"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_notification_event_task_id_task_id_fk'
		  AND conrelid = 'execution_notification_event'::regclass
	) THEN
		ALTER TABLE "execution_notification_event" ADD CONSTRAINT "execution_notification_event_task_id_task_id_fk"
			FOREIGN KEY ("task_id") REFERENCES "public"."task"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_notification_event_run_id_task_run_id_fk'
		  AND conrelid = 'execution_notification_event'::regclass
	) THEN
		ALTER TABLE "execution_notification_event" ADD CONSTRAINT "execution_notification_event_run_id_task_run_id_fk"
			FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id")
			ON DELETE set null ON UPDATE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'execution_notification_delivery_event_id_execution_notification_event_id_fk'
		  AND conrelid = 'execution_notification_delivery'::regclass
	) THEN
		ALTER TABLE "execution_notification_delivery" ADD CONSTRAINT "execution_notification_delivery_event_id_execution_notification_event_id_fk"
			FOREIGN KEY ("event_id") REFERENCES "public"."execution_notification_event"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_run_parent_run_id_idx" ON "task_run" USING btree ("parent_run_id");
CREATE INDEX IF NOT EXISTS "task_run_logical_session_id_idx" ON "task_run" USING btree ("logical_session_id");
CREATE INDEX IF NOT EXISTS "task_run_checkpoint_run_id_idx" ON "task_run_checkpoint" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "execution_control_request_state_idx" ON "execution_control_request" USING btree ("state","expires_at");
CREATE INDEX IF NOT EXISTS "execution_control_request_host_idx" ON "execution_control_request" USING btree ("host","state");
CREATE INDEX IF NOT EXISTS "execution_notification_event_route_state_idx" ON "execution_notification_event" USING btree ("route","state","available_at");
CREATE INDEX IF NOT EXISTS "execution_notification_delivery_event_id_idx" ON "execution_notification_delivery" USING btree ("event_id");
CREATE INDEX IF NOT EXISTS "execution_notification_delivery_claim_idx" ON "execution_notification_delivery" USING btree ("state","claim_expires_at");
