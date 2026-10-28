ALTER TABLE "project" ADD COLUMN "show_assignees_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "show_priority_by_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing projects keep the current global display behavior. New projects use
-- the false database defaults unless their owner chooses otherwise.
UPDATE "project" SET "show_assignees_by_default" = true, "show_priority_by_default" = true;