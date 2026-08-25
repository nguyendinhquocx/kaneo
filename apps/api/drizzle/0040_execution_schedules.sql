CREATE TABLE "execution_schedule_occurrence" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"occurrence_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"run_id" text,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "execution_schedule_occurrence_occurrence_key_unique" UNIQUE("occurrence_key")
);
--> statement-breakpoint
CREATE TABLE "execution_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"cron_expr" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"host" text DEFAULT 'prodesk-home' NOT NULL,
	"preferred_model" text,
	"fallback_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fallback_mode" text DEFAULT 'manual' NOT NULL,
	"max_runtime_seconds" integer NOT NULL,
	"retry_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"concurrency_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_dispatch_at" timestamp with time zone,
	"next_dispatch_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_schedule_occurrence" ADD CONSTRAINT "execution_schedule_occurrence_schedule_id_execution_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."execution_schedule"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_schedule_occurrence" ADD CONSTRAINT "execution_schedule_occurrence_run_id_task_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_run"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD CONSTRAINT "execution_schedule_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD CONSTRAINT "execution_schedule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "execution_schedule" ADD CONSTRAINT "execution_schedule_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "execution_schedule_occurrence_scheduleId_idx" ON "execution_schedule_occurrence" USING btree ("schedule_id");--> statement-breakpoint
CREATE INDEX "execution_schedule_occurrence_runId_idx" ON "execution_schedule_occurrence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "execution_schedule_taskId_idx" ON "execution_schedule" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "execution_schedule_due_idx" ON "execution_schedule" USING btree ("enabled","host","not_before");