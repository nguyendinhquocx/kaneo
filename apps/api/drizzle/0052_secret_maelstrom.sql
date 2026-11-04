CREATE TABLE "workspace_integration_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"mitra_enabled" boolean DEFAULT true NOT NULL,
	"wisemapping_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_integration_settings" ADD CONSTRAINT "workspace_integration_settings_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;