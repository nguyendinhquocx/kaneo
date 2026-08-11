-- Keep the legacy compatibility table aligned with the canonical integration table.
-- The execution service still reads github_integration, while the GitHub UI writes
-- integration.config. This idempotent bridge preserves existing legacy rows and
-- refreshes their repository identity from the canonical active/inactive record.
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
