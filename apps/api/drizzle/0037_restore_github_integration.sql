CREATE TABLE IF NOT EXISTS "github_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"installation_id" integer,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'github_integration_project_id_unique'
	) THEN
		ALTER TABLE "github_integration"
			ADD CONSTRAINT "github_integration_project_id_unique"
			UNIQUE("project_id");
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'github_integration_project_id_project_id_fk'
	) THEN
		ALTER TABLE "github_integration"
			ADD CONSTRAINT "github_integration_project_id_project_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "public"."project"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
END $$;
