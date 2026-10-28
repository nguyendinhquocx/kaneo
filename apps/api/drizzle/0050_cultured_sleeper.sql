ALTER TABLE "project" ADD COLUMN "show_subtask_cards_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- SPEC-2026-10-27-kaneo-subtask-board-focus-markers: projects that existed
-- before this migration keep subtask cards visible (legacy behavior). Rows
-- inserted after this migration take the `false` DB default instead.
UPDATE "project" SET "show_subtask_cards_by_default" = true;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "work_marker_counts" jsonb DEFAULT '{"redCross":0,"boxedRedCross":0,"redCircle":0,"greenCheck":0}'::jsonb NOT NULL;
