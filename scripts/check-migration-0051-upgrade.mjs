// Verify the real upgrade path for 0051_fuzzy_harry_osborn.
// This check creates a uniquely named disposable database, applies every
// migration before 0051 (including 0050), seeds a legacy project, runs 0051,
// asserts old rows backfill true and new rows default false, then drops only
// that database. DATABASE_URL must point at a *_test database.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Client } = require("pg");
const migrationDir = new URL("../apps/api/drizzle/", import.meta.url);
const journalPath = new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url);
const targetTag = "0051_fuzzy_harry_osborn";
const databaseUrl = process.env.DATABASE_URL;
const tmpDatabase = `kaneo_migration_check_0051_${randomUUID().replaceAll("-", "")}`;

function fail(message) {
  throw new Error(message);
}

function loadMigrationStatements(tag) {
  const sql = readFileSync(new URL(`${tag}.sql`, migrationDir), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const backfills = loadMigrationStatements(targetTag).filter((statement) =>
  /^UPDATE\s+"project"/i.test(
    statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  ),
);
if (
  backfills.length !== 1 ||
  !backfills[0].includes('"show_assignees_by_default" = true') ||
  !backfills[0].includes('"show_priority_by_default" = true')
) {
  fail("0051 must contain one explicit project backfill setting both defaults true");
}

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

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const targetIndex = journal.entries.findIndex((entry) => entry.tag === targetTag);
if (targetIndex < 0) fail(`migration journal is missing ${targetTag}`);
const priorTags = journal.entries
  .slice(0, targetIndex)
  .map((entry) => entry.tag);

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
let adminConnected = false;
let tempDatabaseCreated = false;

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${tmpDatabase}"`);
  tempDatabaseCreated = true;

  const tmpUrl = new URL(databaseUrl);
  tmpUrl.pathname = `/${tmpDatabase}`;
  const client = new Client({ connectionString: tmpUrl.toString() });
  await client.connect();

  try {
    await applyMigrations(client, priorTags);
    console.log(`Pre-0051 schema PASS: applied ${priorTags.length} migrations`);

    const workspaceId = `ws-${randomUUID()}`;
    const legacyProjectId = `proj-${randomUUID()}`;
    await client.query(
      `INSERT INTO "workspace" ("id", "name", "slug", "created_at") VALUES ($1, 'Display defaults upgrade check', $2, now())`,
      [workspaceId, `upgrade-check-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO "project" ("id", "workspace_id", "name", "slug", "created_at") VALUES ($1, $2, 'Legacy project', $3, now())`,
      [legacyProjectId, workspaceId, `legacy-${randomUUID()}`],
    );

    for (const statement of loadMigrationStatements(targetTag)) {
      await client.query(statement);
    }

    const legacy = await client.query(
      `SELECT "show_assignees_by_default", "show_priority_by_default" FROM "project" WHERE "id" = $1`,
      [legacyProjectId],
    );
    if (
      legacy.rows[0]?.show_assignees_by_default !== true ||
      legacy.rows[0]?.show_priority_by_default !== true
    ) {
      fail(`legacy project did not backfill to true/true: ${JSON.stringify(legacy.rows[0])}`);
    }
    console.log("Legacy-project backfill PASS: assignees=true, priority=true");

    const newProject = await client.query(
      `INSERT INTO "project" ("id", "workspace_id", "name", "slug", "created_at") VALUES ($1, $2, 'New project', $3, now()) RETURNING "show_assignees_by_default", "show_priority_by_default"`,
      [`proj-${randomUUID()}`, workspaceId, `new-${randomUUID()}`],
    );
    if (
      newProject.rows[0]?.show_assignees_by_default !== false ||
      newProject.rows[0]?.show_priority_by_default !== false
    ) {
      fail(`new project defaults are not false/false: ${JSON.stringify(newProject.rows[0])}`);
    }
    console.log("New-project defaults PASS: assignees=false, priority=false");
  } finally {
    await client.end();
  }

  console.log("Upgrade check PASS: 0051 verified on a real pre-upgrade project row");
} finally {
  if (adminConnected) {
    if (tempDatabaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${tmpDatabase}" WITH (FORCE)`);
      console.log("Cleanup PASS: disposable migration-check database dropped");
    }
    await admin.end();
  }
}
