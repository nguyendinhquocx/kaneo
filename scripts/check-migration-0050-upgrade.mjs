// SPEC-2026-10-27-kaneo-subtask-board-focus-markers — real upgrade-path
// check for 0050_cultured_sleeper.sql.
//
// The integration harness migrates then TRUNCATEs, so it can never prove the
// legacy backfill. This check builds a throwaway database that mimics the
// pre-upgrade state and then runs the real migration:
//   1. reviews the migration file for an explicit UPDATE statement,
//   2. creates a disposable `kaneo_migration_check_tmp` database,
//   3. applies migrations 0000..0049 (everything BEFORE 0050),
//   4. seeds a legacy workspace/project/task (rows that exist before the
//      new migration),
//   5. applies 0050 and asserts the legacy project flips to `true` while
//      rows inserted after it default to `false`.
// The disposable database is dropped at the end — no shared state touched.
//
// Usage: node scripts/check-migration-0050-upgrade.mjs
// (DATABASE_URL must point at a *_test database; only its server connection
// info is reused — the check runs against its own temporary database.)
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// pnpm keeps `pg` inside apps/api's dependency folder — resolve from there.
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Client } = require("pg");

const migrationDir = new URL("../apps/api/drizzle/", import.meta.url);
const migration0050Tag = "0050_cultured_sleeper";
const journalPath = new URL("meta/_journal.json", migrationDir);
const tmpDatabase = `kaneo_migration_check_${randomUUID().replaceAll("-", "")}`;

function fail(message) {
  throw new Error(message);
}

function loadMigrationStatements(tag) {
  const sql = readFileSync(new URL(`${tag}.sql`, migrationDir), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function stripCommentLines(statement) {
  return statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

// 1. SQL review: the backfill must be an explicit UPDATE inside 0050.
const updateStatements = loadMigrationStatements(migration0050Tag)
  .map(stripCommentLines)
  .filter((statement) => /^UPDATE\s+"project"/i.test(statement));
if (updateStatements.length !== 1) {
  fail(
    `expected exactly one "UPDATE \\"project\\"..." backfill statement in 0050, found ${updateStatements.length}`,
  );
}
console.log(`SQL review OK: backfill statement found:\n  ${updateStatements[0]}`);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  fail("DATABASE_URL must point at a *_test database");
}

async function applyMigrations(client, tags) {
  for (const tag of tags) {
    for (const statement of loadMigrationStatements(tag)) {
      await client.query(statement);
    }
  }
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
let adminConnected = false;
let tempDatabaseCreated = false;

try {
  await admin.connect();
  adminConnected = true;
  // Use a unique database name; never delete or reuse an existing database.
  await admin.query(`CREATE DATABASE "${tmpDatabase}"`);
  tempDatabaseCreated = true;

  const tmpUrl = new URL(databaseUrl);
  tmpUrl.pathname = `/${tmpDatabase}`;
  const client = new Client({ connectionString: tmpUrl.toString() });
  await client.connect();

  try {
    // 2. Pre-upgrade state: every migration BEFORE 0050.
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    const before0050 = journal.entries
      .filter((entry) => entry.tag !== migration0050Tag)
      .map((entry) => entry.tag);
    await applyMigrations(client, before0050);
    console.log(
      `Pre-upgrade schema OK: applied ${before0050.length} migrations before 0050`,
    );

    // 3. Rows that exist BEFORE the new migration.
    const workspaceId = `ws-${randomUUID()}`;
    const projectId = `proj-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    await client.query(
      `INSERT INTO "workspace" ("id", "name", "slug", "created_at") VALUES ($1, 'Legacy upgrade check', $2, now())`,
      [workspaceId, `upgrade-check-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO "project" ("id", "workspace_id", "name", "slug", "created_at") VALUES ($1, $2, 'Legacy project', $3, now())`,
      [projectId, workspaceId, `legacy-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO "task" ("id", "project_id", "number", "title", "status", "created_at") VALUES ($1, $2, 1, 'Legacy task', 'to-do', now())`,
      [taskId, projectId],
    );

    // 4. Run the real migration (both statements: column add + backfill).
    for (const statement of loadMigrationStatements(migration0050Tag)) {
      await client.query(statement);
    }
    console.log("Migration 0050 applied on the disposable upgrade database");

    const legacyProject = await client.query(
      `SELECT "show_subtask_cards_by_default" FROM "project" WHERE "id" = $1`,
      [projectId],
    );
    if (legacyProject.rows[0]?.show_subtask_cards_by_default !== true) {
      fail("legacy project row did not backfill to true");
    }
    console.log("Backfill OK: pre-existing project row flipped to true");

    const legacyTask = await client.query(
      `SELECT "work_marker_counts" FROM "task" WHERE "id" = $1`,
      [taskId],
    );
    const counts = legacyTask.rows[0]?.work_marker_counts;
    if (
      counts?.redCross !== 0 ||
      counts?.boxedRedCross !== 0 ||
      counts?.redCircle !== 0 ||
      counts?.greenCheck !== 0
    ) {
      fail(`legacy task row must get all-zero marker counts, got ${JSON.stringify(counts)}`);
    }
    console.log("Backfill OK: pre-existing task row got all-zero marker counts");

    // 5. Rows inserted after the migration default to false.
    const newProject = await client.query(
      `INSERT INTO "project" ("id", "workspace_id", "name", "slug", "created_at") VALUES ($1, $2, 'Post-upgrade project', $3, now()) RETURNING "show_subtask_cards_by_default"`,
      [`proj-${randomUUID()}`, workspaceId, `post-${randomUUID()}`],
    );
    if (newProject.rows[0].show_subtask_cards_by_default !== false) {
      fail("post-migration project rows must default to false");
    }
    console.log("New-row check OK: post-migration inserts default to false");
  } finally {
    await client.end();
  }
  console.log("Upgrade check PASS: 0050 verified on a real pre-upgrade database");
} finally {
  if (adminConnected) {
    if (tempDatabaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${tmpDatabase}" WITH (FORCE)`);
      console.log("Cleanup OK: disposable database dropped");
    }
    await admin.end();
  }
}
