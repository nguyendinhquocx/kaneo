// Verify the real additive upgrade path through T5 durable deliveries.
// Creates one uniquely named disposable database, applies migrations in
// journal order through 0055, checks binding/outbox columns and uniqueness
// fences, then drops only that temporary database.
// DATABASE_URL must point at a *_test database.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Client } = require("pg");
const migrationDir = new URL("../apps/api/drizzle/", import.meta.url);
const journalPath = new URL("../apps/api/drizzle/meta/_journal.json", import.meta.url);
const targetTag = "0056_agent_session_delivery_generation";
const databaseUrl = process.env.DATABASE_URL;
const tempDatabase = `kaneo_migration_check_0055_${randomUUID().replaceAll("-", "")}`;

function fail(message) {
  throw new Error(message);
}

function migrationStatements(tag) {
  const sql = readFileSync(new URL(`${tag}.sql`, migrationDir), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test")) {
  fail("DATABASE_URL must point at a *_test database");
}

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const targetIndex = journal.entries.findIndex((entry) => entry.tag === targetTag);
if (targetIndex < 0) fail(`migration journal is missing ${targetTag}`);
const migrationTags = journal.entries
  .slice(0, targetIndex + 1)
  .map((entry) => entry.tag);

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = new Client({ connectionString: adminUrl.toString() });
let adminConnected = false;
let created = false;

async function main() {
  await admin.connect();
  adminConnected = true;
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [tempDatabase],
  );
  if (existing.rowCount > 0) fail(`temporary database ${tempDatabase} already exists`);
  await admin.query(`CREATE DATABASE "${tempDatabase}"`);
  created = true;

  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${tempDatabase}`;
  const client = new Client({ connectionString: upgradeUrl.toString() });
  await client.connect();
  try {
    for (const tag of migrationTags) {
      for (const statement of migrationStatements(tag)) {
        await client.query(statement);
      }
    }

    const requiredBindingColumns = [
      "task_id",
      "project_id",
      "agent_principal_id",
      "host_id",
      "session_id",
      "binding_generation",
      "status",
      "last_heartbeat_at",
      "revoked_at",
      "revision",
    ];
    const bindingColumns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_session_binding'",
    );
    const bindingNames = new Set(bindingColumns.rows.map((row) => row.column_name));
    for (const column of requiredBindingColumns) {
      if (!bindingNames.has(column)) fail(`binding migration is missing ${column}`);
    }

    const requiredDeliveryColumns = [
      "binding_id",
      "task_id",
      "binding_generation",
      "client_action_key",
      "comment_id",
      "comment_updated_at",
      "comment_content_hash",
      "state",
      "claimed_lease_expires_at",
      "expires_at",
    ];
    const deliveryColumns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_session_delivery'",
    );
    const deliveryNames = new Set(deliveryColumns.rows.map((row) => row.column_name));
    for (const column of requiredDeliveryColumns) {
      if (!deliveryNames.has(column)) fail(`delivery migration is missing ${column}`);
    }

    const indexes = await client.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_session_binding'",
    );
    const activeTask = indexes.rows.find(
      (row) => row.indexname === "agent_session_binding_active_task_unique",
    );
    const activeSession = indexes.rows.find(
      (row) => row.indexname === "agent_session_binding_active_session_unique",
    );
    if (!activeTask?.indexdef.includes("UNIQUE") || !activeTask.indexdef.includes("status = 'active'")) {
      fail("active task binding unique index is missing or not partial");
    }
    if (!activeSession?.indexdef.includes("UNIQUE") || !activeSession.indexdef.includes("status = 'active'")) {
      fail("active session binding unique index is missing or not partial");
    }

    const deliveryIndexes = await client.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'agent_session_delivery'",
    );
    const actionKey = deliveryIndexes.rows.find(
      (row) => row.indexname === "agent_session_delivery_action_key_unique",
    );
    if (!actionKey?.indexdef.includes("UNIQUE")) {
      fail("delivery idempotency unique key (binding_id, client_action_key) is missing");
    }
  } finally {
    await client.end();
  }

  console.log("0056 upgrade path check passed");
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (adminConnected && created) {
        await admin.query(`DROP DATABASE "${tempDatabase}"`);
      }
    } catch (error) {
      console.error(`Failed to drop temporary database: ${error.message}`);
    } finally {
      if (adminConnected) await admin.end();
    }
  });
