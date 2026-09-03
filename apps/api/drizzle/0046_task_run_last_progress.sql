-- SPEC-kaneo-wavefix-v0-2 (T0): durable liveness/progress timestamp.
--
-- `last_progress_at` records the last claim/heartbeat/report/checkpoint
-- signal so the no-progress watchdog can distinguish "spawned but never
-- heartbeated" from "stalled mid-run" and apply a spawn grace window.
-- Backfilled from last_heartbeat_at; NULL for rows is treated by readers
-- as "fall back to last_heartbeat_at".

ALTER TABLE "task_run" ADD COLUMN "last_progress_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "task_run" SET "last_progress_at" = "last_heartbeat_at" WHERE "last_progress_at" IS NULL;
