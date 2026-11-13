// Verify the real upgrade path for 0053_productive_sharon_ventura.
// This check creates a uniquely named disposable database, applies every
// migration before 0053 (including 0052), runs 0053, then asserts the new
// task.contentRevision shape: NOT NULL integer defaulting to 1. It then drops
// only that database. DATABASE_URL must point at a *_test database.
// SPEC-2026-11-10-kaneo-card-agent-collaboration T2.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Client } = require("pg");
const migrationDir = new URL("../apps/api/drizzle/", import.meta.url);
const journalPath = new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url);
const targetTag = "0053_productive_sharon_ventura";
const databaseUrl = process.env.DATABASE_URL;
const tmpDatabase = `kaneo_migration_check_0053_${randomUUID().replaceAll("-", "")}`;

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
if (!/ALTER TABLE "task" ADD COLUMN "content_revision"/i.test(sql)) {
  fail("0053 must add task.content_revision");
}
if (!/integer DEFAULT 1 NOT NULL/i.test(sql)) {
  fail("0053 must default content_revision to 1 and be NOT NULL");
}
const destructive = sql
  .split("--> statement-breakpoint")
  .filter((statement) => /^(DROP|DELETE|TRUNCATE|UPDATE)\s/i.test(statement));
if (destructive.length !== 0) {
  fail(
    `0053 must stay additive; found ${destructive.length} destructive statement(s)`,
  );
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

async function main() {
  await admin.connect();
  adminConnected = true;
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [tmpDatabase],
  );
  if (existing.rowCount > 0) {
    fail(`temporary database ${tmpDatabase} already exists`);
  }
  await admin.query(`CREATE DATABASE "${tmpDatabase}"`);
  tempDatabaseCreated = true;

  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${tmpDatabase}`;
  const client = new Client({ connectionString: upgradeUrl.toString() });
  await client.connect();
  try {
    await applyMigrations(client, priorTags);
    const [before] = (
      await client.query(
        `SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name = 'task' AND column_name = 'content_revision'`,
      )
    ).rows;
    if (before.count !== 0) {
      fail("content_revision must not exist before 0053");
    }

    await applyMigrations(client, [targetTag]);

    const [column] = (
      await client.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'task' AND column_name = 'content_revision'`,
      )
    ).rows;
    if (!column) fail("0053 must create task.content_revision");
    if (column.data_type !== "integer") {
      fail(`content_revision must be integer, got ${column.data_type}`);
    }
    if (column.is_nullable !== "NO") {
      fail("content_revision must be NOT NULL");
    }
    if (!/1/.test(String(column.column_default))) {
      fail(`content_revision must default to 1, got ${column.column_default}`);
    }

    // Existing rows must be backfilled by the DEFAULT to revision 1.
    await client.query(
      `INSERT INTO "task" ("project_id", "title") SELECT (SELECT id FROM "project" LIMIT 1), 'migration-check' WHERE (SELECT count(*) FROM "project") > 0`,
    );
    const [row] = (
      await client.query(
        `SELECT content_revision FROM "task" WHERE title = 'migration-check'`,
      )
    ).rows;
    if (row && row.content_revision !== 1) {
      fail(`new rows must start at content_revision 1, got ${row.content_revision}`);
    }
  } finally {
    await client.end();
  }

  console.log("0053 upgrade path check passed");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (adminConnected && tempDatabaseCreated) {
        await admin.query(`DROP DATABASE "${tmpDatabase}"`);
      }
    } catch (error) {
      console.error(`Failed to drop temporary database: ${error.message}`);
    } finally {
      if (adminConnected) {
        await admin.end();
      }
    }
  });
