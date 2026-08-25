-- Repair a drifted database where the legacy execution compatibility table
-- is absent even though migrations 0036-0038 are recorded as applied.
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
		  AND conrelid = 'github_integration'::regclass
	) THEN
		ALTER TABLE "github_integration"
			ADD CONSTRAINT "github_integration_project_id_unique"
			UNIQUE("project_id");
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM pg_constraint
		WHERE conname = 'github_integration_project_id_project_id_fk'
		  AND conrelid = 'github_integration'::regclass
	) THEN
		ALTER TABLE "github_integration"
			ADD CONSTRAINT "github_integration_project_id_project_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "public"."project"("id")
			ON DELETE cascade ON UPDATE cascade;
	END IF;
END $$;
--> statement-breakpoint
INSERT INTO "github_integration" (
  "id",
  "project_id",
  "repository_owner",
  "repository_name",
  "installation_id",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  i."id" || '-compat',
  i."project_id",
  parsed."config" ->> 'repositoryOwner',
  parsed."config" ->> 'repositoryName',
  CASE
    WHEN NULLIF(parsed."config" ->> 'installationId', '') ~ '^[0-9]+$'
      THEN (parsed."config" ->> 'installationId')::integer
    ELSE NULL
  END,
  COALESCE(i."is_active", true),
  i."created_at",
  i."updated_at"
FROM "integration" AS i
CROSS JOIN LATERAL (
  SELECT i."config"::jsonb AS "config"
) AS parsed
WHERE i."type" = 'github'
  AND NULLIF(parsed."config" ->> 'repositoryOwner', '') IS NOT NULL
  AND NULLIF(parsed."config" ->> 'repositoryName', '') IS NOT NULL
ON CONFLICT ("project_id") DO UPDATE
SET
  "repository_owner" = EXCLUDED."repository_owner",
  "repository_name" = EXCLUDED."repository_name",
  "installation_id" = EXCLUDED."installation_id",
  "is_active" = EXCLUDED."is_active",
  "updated_at" = EXCLUDED."updated_at";
