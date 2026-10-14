-- SPEC-2026-10-08-kaneo-workspace-collaboration
-- Workspace collaboration entities: project documents + member comments,
-- workspace goals + date-only check-ins, capability share links + audit.
-- NOTE: hand-trimmed after `drizzle-kit generate` — the generated output
-- re-included CREATE/ALTER statements already shipped by hand-written repair
-- migrations 0044-0047 (their snapshots are absent from meta/), which would
-- fail on both clean and upgrade databases. Only the spec's own diff remains.

CREATE TABLE "document" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_comment" (
	"id" text PRIMARY KEY NOT NULL,
	"document_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"target_per_week" integer,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_checkin" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"check_in_date" date NOT NULL,
	"completed" boolean DEFAULT true NOT NULL,
	"checked_by_user_id" text,
	"note" text DEFAULT '' NOT NULL,
	"note_revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "goal_checkin_goal_date_unique" UNIQUE("goal_id","check_in_date")
);
--> statement-breakpoint
CREATE TABLE "share_action_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"share_link_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"permission" text NOT NULL,
	"token_hash" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "document_comment" ADD CONSTRAINT "document_comment_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "document_comment" ADD CONSTRAINT "document_comment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "goal_checkin" ADD CONSTRAINT "goal_checkin_goal_id_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goal"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "goal_checkin" ADD CONSTRAINT "goal_checkin_checked_by_user_id_user_id_fk" FOREIGN KEY ("checked_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "share_action_audit" ADD CONSTRAINT "share_action_audit_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
--> statement-breakpoint
CREATE INDEX "document_comment_documentId_idx" ON "document_comment" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "document_comment_userId_idx" ON "document_comment" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "document_projectId_idx" ON "document" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "goal_checkin_goalId_idx" ON "goal_checkin" USING btree ("goal_id");
--> statement-breakpoint
CREATE INDEX "goal_checkin_date_idx" ON "goal_checkin" USING btree ("check_in_date");
--> statement-breakpoint
CREATE INDEX "goal_workspaceId_idx" ON "goal" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "goal_ownerUserId_idx" ON "goal" USING btree ("owner_user_id");
--> statement-breakpoint
CREATE INDEX "goal_projectId_idx" ON "goal" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "share_action_audit_shareLinkId_idx" ON "share_action_audit" USING btree ("share_link_id");
--> statement-breakpoint
CREATE INDEX "share_action_audit_resource_idx" ON "share_action_audit" USING btree ("resource_type","resource_id");
--> statement-breakpoint
CREATE INDEX "share_link_resource_idx" ON "share_link" USING btree ("resource_type","resource_id");
--> statement-breakpoint
CREATE INDEX "share_link_workspaceId_idx" ON "share_link" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "share_link_createdBy_idx" ON "share_link" USING btree ("created_by_user_id");
