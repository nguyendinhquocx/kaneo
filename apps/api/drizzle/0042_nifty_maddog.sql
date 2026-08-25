ALTER TABLE "task_run" ADD COLUMN "schedule_id" text;--> statement-breakpoint
ALTER TABLE "task_run" ADD CONSTRAINT "task_run_schedule_id_execution_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."execution_schedule"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "task_run_scheduleId_idx" ON "task_run" USING btree ("schedule_id");