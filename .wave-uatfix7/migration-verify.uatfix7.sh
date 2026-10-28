#!/bin/sh
# Fixed read-only Kaneo migration-head and schema verifier — uatfix7 wave pins.
# SQL is static and SELECT-only; this adapter never runs migrations or writes data.
set -eu

PROJECT_DIR=/srv/kaneo
COMPOSE_FILE=$PROJECT_DIR/compose.yml
EXPECTED_COMPOSE_SHA256=5b1a74918511a33a18577499399efac32405dba1fb07f4204c6f64bc803f976f
EXPECTED_IMAGE='ghcr.io/nguyendinhquocx/kaneo-vi-mcp:2.14.0-candidate-d56f1bba-subtask-board-markers-uatfix7@sha256:08a7f013cf8213813c8620dae1c94e71b5b352e6763ec4123028d12ef6e524cf'
EXPECTED_HEAD_ID=54
EXPECTED_HEAD_HASH=73246bf88aefd1634df1df1312489cf0b2aa89899efe5cd5345d75f4cd66a2f4
EXPECTED_MIGRATION_COUNT=54
EXPECTED_REQUIRED_COLUMNS=27
EXPECTED_REQUIRED_CONSTRAINTS=2

fail() { printf '%s\n' "Kaneo migration verify BLOCKED: $*" >&2; exit 2; }
[ "$#" -eq 0 ] || fail 'no arguments are accepted'
[ "$(id -u)" -eq 0 ] || fail 'root execution required'
[ -f "$COMPOSE_FILE" ] && [ ! -L "$COMPOSE_FILE" ] || fail 'candidate Compose missing or symlinked'
[ "$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')" = "$EXPECTED_COMPOSE_SHA256" ] || fail 'candidate Compose hash mismatch'
[ "$(docker inspect --format '{{.Config.Image}}' kaneo 2>/dev/null || true)" = "$EXPECTED_IMAGE" ] || fail 'running Kaneo image is not the candidate'
(cd "$PROJECT_DIR" && docker compose config --quiet)
docker compose -f "$COMPOSE_FILE" ps --status running --services | grep -Fxq postgres || fail 'postgres is not running'

run_sql() {
    sql=$1
    docker compose -f "$COMPOSE_FILE" exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$sql"
}

head_row=$(run_sql "SELECT id::text || '|' || hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;") || fail 'could not read Drizzle migration head'
IFS='|' read -r head_id head_hash <<EOF2
$head_row
EOF2
[ "$head_id" = "$EXPECTED_HEAD_ID" ] || fail "unexpected migration head id: $head_id"
[ "$head_hash" = "$EXPECTED_HEAD_HASH" ] || fail "unexpected migration head hash: $head_hash"
migration_count=$(run_sql "SELECT count(*)::text FROM drizzle.__drizzle_migrations;") || fail 'could not count Drizzle migrations'
[ "$migration_count" = "$EXPECTED_MIGRATION_COUNT" ] || fail "unexpected migration count: $migration_count"
required_columns=$(run_sql "WITH expected(table_name, column_name) AS (VALUES ('mcp_oauth_state','id'),('mcp_oauth_state','kind'),('mcp_oauth_state','key'),('mcp_oauth_state','payload'),('mcp_oauth_state','expires_at'),('mcp_oauth_state','created_at'),('mcp_oauth_state','updated_at'),('apikey','reference_id'),('workspace_member','user_id'),('session','active_organization_id'),('invitation','created_at'),('execution_flag','name'),('execution_flag','enabled'),('execution_flag','updated_at'),('github_integration','id'),('github_integration','project_id'),('github_integration','repository_owner'),('github_integration','repository_name'),('github_integration','installation_id'),('github_integration','is_active'),('github_integration','created_at'),('github_integration','updated_at'),('task_run','last_progress_at'),('task','work_marker_counts'),('project','show_subtask_cards_by_default'),('project','show_assignees_by_default'),('project','show_priority_by_default')) SELECT count(*)::text FROM expected WHERE EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=expected.table_name AND c.column_name=expected.column_name);") || fail 'could not inspect required schema columns'
[ "$required_columns" = "$EXPECTED_REQUIRED_COLUMNS" ] || fail "required schema columns present: $required_columns/$EXPECTED_REQUIRED_COLUMNS"
required_constraints=$(run_sql "SELECT count(*)::text FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname='public' AND t.relname='github_integration' AND c.conname IN ('github_integration_project_id_unique','github_integration_project_id_project_id_fk');") || fail 'could not inspect GitHub compatibility constraints'
[ "$required_constraints" = "$EXPECTED_REQUIRED_CONSTRAINTS" ] || fail "GitHub compatibility constraints present: $required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS"
backfill_gaps=$(run_sql "SELECT count(*)::text FROM integration i WHERE i.type='github' AND NULLIF(i.config::jsonb ->> 'repositoryOwner', '') IS NOT NULL AND NULLIF(i.config::jsonb ->> 'repositoryName', '') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM github_integration g WHERE g.project_id=i.project_id);") || fail 'could not verify GitHub compatibility backfill'
[ "$backfill_gaps" = "0" ] || fail "GitHub compatibility backfill gaps: $backfill_gaps"
project_default_gaps=$(run_sql "SELECT count(*)::text FROM project WHERE show_subtask_cards_by_default IS NULL OR show_assignees_by_default IS NULL OR show_priority_by_default IS NULL;") || fail 'could not verify project display-default backfill'
[ "$project_default_gaps" = "0" ] || fail "project display-default backfill gaps: $project_default_gaps"
marker_counts_valid=$(run_sql "SELECT count(*)::text FROM task WHERE work_marker_counts IS NULL OR (SELECT count(*) FROM jsonb_each(work_marker_counts)) <> 4 OR EXISTS (SELECT 1 FROM jsonb_each(work_marker_counts) e WHERE e.key NOT IN ('redCross','boxedRedCross','redCircle','greenCheck') OR jsonb_typeof(e.value) <> 'number' OR e.value #>> '{}' !~ '^[0-9]+$' OR (e.value #>> '{}')::int > 99);") || fail 'could not verify work marker counts shape'
[ "$marker_counts_valid" = "0" ] || fail "work marker counts outside the reviewed shape: $marker_counts_valid"
printf '%s\n' "Kaneo migration/schema PASS: head=0051_fuzzy_harry_osborn id=$head_id migrations=$migration_count hash=$head_hash required_columns=$required_columns/$EXPECTED_REQUIRED_COLUMNS github_constraints=$required_constraints/$EXPECTED_REQUIRED_CONSTRAINTS backfill_gaps=$backfill_gaps project_default_gaps=$project_default_gaps marker_counts_valid=$marker_counts_valid (read-only)"
