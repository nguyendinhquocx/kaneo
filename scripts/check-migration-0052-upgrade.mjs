// Verify the real upgrade path for 0052_secret_maelstrom.
// This check creates a uniquely named disposable database, applies every
// migration before 0052 (including 0051), runs 0052, then asserts the new
// workspace_integration_settings shape: PK on workspace_id, cascade FK to
// workspace, defaults mitra_enabled/wisemapping_enabled = true, and no
// backfill rows are invented. It then drops only that database.
// DATABASE_URL must point at a *_test database.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Client } = require("pg");
const migrationDir = new URL("../apps/api/drizzle/", import.meta.url);
const journalPath = new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url);
const targetTag = "0052_secret_maelstrom";
const databaseUrl = process.env.DATABASE_URL;
const tmpDatabase = `kaneo_migration_check_0052_${randomUUID().replaceAll("-", "")}`;

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

const sql = readFileSync(new URL(`${targetTag}.sql`, migrationDir), "utf8");
if (!/CREATE TABLE "workspace_integration_settings"/i.test(sql)) {
  fail("0052 must create workspace_integration_settings");
}
if (!/"workspace_id"\s+text\s+PRIMARY KEY/i.test(sql)) {
  fail("0052 must make workspace_id the primary key");
}
if (!/"mitra_enabled"\s+boolean\s+DEFAULT true\s+NOT NULL/i.test(sql)) {
  fail("0052 must default mitra_enabled to true");
}
if (!/"wisemapping_enabled"\s+boolean\s+DEFAULT true\s+NOT NULL/i.test(sql)) {
  fail("0052 must default wisemapping_enabled to true");
}
if (!/ON DELETE cascade/i.test(sql)) {
  fail("0052 must cascade-delete settings with the workspace");
}
const backfills = sql
  .split("--> statement-breakpoint")
  .filter((statement) => /^(INSERT|UPDATE)\s/i.test(statement));
if (backfills.length !== 0) {
  fail(`0052 must stay additive; found ${backfills.length} backfill statement(s)`);
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
    console.log(`Pre-0052 schema PASS: applied ${priorTags.length} migrations`);

    const workspaceId = `ws-${randomUUID()}`;
    await client.query(
      `INSERT INTO "workspace" ("id", "name", "slug", "created_at") VALUES ($1, 'Integration settings upgrade check', $2, now())`,
      [workspaceId, `upgrade-check-${randomUUID()}`],
    );

    for (const statement of loadMigrationStatements(targetTag)) {
      await client.query(statement);
    }

    const constraint = await client.query(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'workspace_integration_settings' AND c.contype = 'f'
         AND c.conname = 'workspace_integration_settings_workspace_id_workspace_id_fk'`,
    );
    if (constraint.rows[0]?.n !== 1) {
      fail(`cascade FK constraint missing: ${JSON.stringify(constraint.rows[0])}`);
    }
    console.log("Cascade FK constraint PASS");

    const defaults = await client.query(
      `INSERT INTO "workspace_integration_settings" ("workspace_id", "created_at", "updated_at")
       VALUES ($1, now(), now())
       RETURNING "mitra_enabled", "wisemapping_enabled"`,
      [workspaceId],
    );
    if (
      defaults.rows[0]?.mitra_enabled !== true ||
      defaults.rows[0]?.wisemapping_enabled !== true
    ) {
      fail(`service toggles did not default to true/true: ${JSON.stringify(defaults.rows[0])}`);
    }
    console.log("Service toggle defaults PASS: mitra=true, wisemapping=true");

    try {
      await client.query(
        `INSERT INTO "workspace_integration_settings" ("workspace_id", "created_at", "updated_at") VALUES ($1, now(), now())`,
        [workspaceId],
      );
      fail("duplicate workspace_id insert should have violated the primary key");
    } catch (error) {
      if (!`${error.code ?? ""}`.startsWith("23")) {
        throw error;
      }
    }
    console.log("Primary key uniqueness PASS");

    try {
      await client.query(
        `INSERT INTO "workspace_integration_settings" ("workspace_id", "created_at", "updated_at") VALUES ($1, now(), now())`,
        [`ws-${randomUUID()}`],
      );
      fail("insert with unknown workspace_id should have violated the foreign key");
    } catch (error) {
      if (!`${error.code ?? ""}`.startsWith("23")) {
        throw error;
      }
    }
    console.log("Foreign key enforcement PASS");

    await client.query(`DELETE FROM "workspace" WHERE "id" = $1`, [workspaceId]);
    const afterCascade = await client.query(
      `SELECT count(*)::int AS n FROM "workspace_integration_settings" WHERE "workspace_id" = $1`,
      [workspaceId],
    );
    if (afterCascade.rows[0]?.n !== 0) {
      fail(`cascade delete left rows behind: ${JSON.stringify(afterCascade.rows[0])}`);
    }
    console.log("Cascade delete PASS");

    const rowTotal = await client.query(
      `SELECT count(*)::int AS n FROM "workspace_integration_settings"`,
    );
    if (rowTotal.rows[0]?.n !== 0) {
      fail(`0052 invented backfill rows: ${JSON.stringify(rowTotal.rows[0])}`);
    }
    console.log("No-backfill PASS: table starts empty");
  } finally {
    await client.end();
  }

  console.log("Upgrade check PASS: 0052 verified on a real post-upgrade workspace row");
} finally {
  if (adminConnected) {
    if (tempDatabaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${tmpDatabase}" WITH (FORCE)`);
      console.log("Cleanup PASS: disposable migration-check database dropped");
    }
    await admin.end();
  }
}
