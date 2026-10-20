ALTER TABLE "asset" DROP CONSTRAINT "asset_project_id_project_id_fk";
--> statement-breakpoint
ALTER TABLE "asset" DROP CONSTRAINT "asset_activity_id_activity_id_fk";
--> statement-breakpoint
ALTER TABLE "asset" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "document_id" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "document_comment_id" text;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "goal_checkin_id" text;--> statement-breakpoint
ALTER TABLE "share_link" ADD COLUMN "token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "task_relation" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_document_comment_id_document_comment_id_fk" FOREIGN KEY ("document_comment_id") REFERENCES "public"."document_comment"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_goal_checkin_id_goal_checkin_id_fk" FOREIGN KEY ("goal_checkin_id") REFERENCES "public"."goal_checkin"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "asset_documentId_idx" ON "asset" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "asset_documentCommentId_idx" ON "asset" USING btree ("document_comment_id");--> statement-breakpoint
CREATE INDEX "asset_goalCheckinId_idx" ON "asset" USING btree ("goal_checkin_id");