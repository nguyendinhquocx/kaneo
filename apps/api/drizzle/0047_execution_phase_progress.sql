-- SPEC-kaneo-phase-cards-full-run-server-v0-1 (T1): phase-card mapping,
-- fenced phase-progress ledger, projection outbox, project revision CAS and
-- phase-provenance checkpoint fields. Existing checkpoint rows keep nullable
-- phase fields (legacy checkpoints never become phase proof).

ALTER TABLE "project" ADD COLUMN "project_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "task_run_checkpoint" ADD COLUMN "phase_id" text;
ALTER TABLE "task_run_checkpoint" ADD COLUMN "spec_sha256" text;
ALTER TABLE "task_run_checkpoint" ADD COLUMN "source_phase_map_sha256" text;
ALTER TABLE "task_run_checkpoint" ADD COLUMN "receipt_hash" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_phase_card" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"full_task_id" text NOT NULL,
	"child_task_id" text NOT NULL,
	"phase_id" text NOT NULL,
	"parser_task_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"graph_id" text NOT NULL,
	"spec_sha256" text NOT NULL,
	"source_phase_map_sha256" text NOT NULL,
	"graph_map_sha256" text NOT NULL,
	"plan_hash" text NOT NULL,
	"change_set_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_phase_card_full_phase_unique" UNIQUE("full_task_id","phase_id"),
	CONSTRAINT "execution_phase_card_child_task_unique" UNIQUE("child_task_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_phase_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"full_task_id" text NOT NULL,
	"phase_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"run_id" text,
	"parent_run_id" text,
	"lease_epoch" integer,
	"ledger_version" integer DEFAULT 1 NOT NULL,
	"checkpoint_id" text,
	"commit_sha" text,
	"branch_name" text,
	"base_sha" text,
	"reason" text,
	"failure_kind" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_phase_progress_full_phase_unique" UNIQUE("full_task_id","phase_id"),
	CONSTRAINT "execution_phase_progress_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "task_run"("id") ON DELETE SET NULL ON UPDATE CASCADE,
	CONSTRAINT "execution_phase_progress_parent_run_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "task_run"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_phase_progress_full_ordinal_idx" ON "execution_phase_progress" ("full_task_id","ordinal");
CREATE INDEX IF NOT EXISTS "execution_phase_progress_run_state_idx" ON "execution_phase_progress" ("run_id","state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_phase_projection" (
	"id" text PRIMARY KEY NOT NULL,
	"full_task_id" text NOT NULL,
	"phase_id" text NOT NULL,
	"projection_kind" text NOT NULL,
	"ledger_version" integer NOT NULL,
	"child_task_id" text NOT NULL,
	"desired_column_slug" text,
	"marker_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"marker_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_phase_projection_unique" UNIQUE("full_task_id","phase_id","projection_kind","ledger_version")
);
--> statement-breakpoint
ALTER TABLE "execution_phase_card" ADD CONSTRAINT "execution_phase_card_project_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "execution_phase_card" ADD CONSTRAINT "execution_phase_card_full_task_fk" FOREIGN KEY ("full_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "execution_phase_card" ADD CONSTRAINT "execution_phase_card_child_task_fk" FOREIGN KEY ("child_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--> statement-breakpoint
ALTER TABLE "execution_phase_projection" ADD CONSTRAINT "execution_phase_projection_full_task_fk" FOREIGN KEY ("full_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "execution_phase_projection" ADD CONSTRAINT "execution_phase_projection_child_task_fk" FOREIGN KEY ("child_task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
