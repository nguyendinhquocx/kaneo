import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import db, { schema } from "../../../apps/api/src/database";

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(currentDir, "../../../apps/api/drizzle");

let migrationPromise: Promise<void> | null = null;

function getDatabaseName(connectionString: string) {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

function getAdminDatabaseUrl(connectionString: string) {
  const url = new URL(connectionString);
  url.pathname = "/postgres";
  return url.toString();
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function ensureTestDatabaseExists() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL must be defined for integration tests");
  }

  const databaseName = getDatabaseName(connectionString);

  if (!databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing to manage non-test database "${databaseName}". DATABASE_URL must point to a test database.`,
    );
  }

  const adminClient = new Client({
    connectionString: getAdminDatabaseUrl(connectionString),
  });

  await adminClient.connect();

  try {
    const result = await adminClient.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [databaseName],
    );

    if (result.rowCount === 0) {
      await adminClient.query(
        `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
      );
    }
  } finally {
    await adminClient.end();
  }
}

export async function ensureTestDatabaseMigrated() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await ensureTestDatabaseExists();
      await migrate(db, {
        migrationsFolder,
      });
    })();
  }

  try {
    await migrationPromise;
  } catch (error) {
    migrationPromise = null;
    throw error;
  }
}

export async function resetTestDatabase() {
  await ensureTestDatabaseMigrated();

  await db.execute(
    sql.raw(`
      TRUNCATE TABLE
        "activity",
        "account",
        "apikey",
        "asset",
        "column",
        "comment",
        "external_link",
        "execution_flag",
        "execution_idempotency",
        "task_run_evidence",
        "task_run",
        "execution_manifest",
        "agent_principal",
        "github_integration",
        "integration",
        "invitation",
        "label",
        "notification",
        "project",
        "session",
        "task",
        "task_relation",
        "team",
        "team_member",
        "time_entry",
        "verification",
        "workflow_rule",
        "workspace",
        "workspace_member",
        "user"
      RESTART IDENTITY CASCADE
    `),
  );

  await db
    .insert(schema.executionFlagTable)
    .values([
      { name: "agent_inbox_dispatch_enabled", enabled: false },
      { name: "agent_reply_enabled", enabled: false },
      { name: "guest_mutation_enabled", enabled: false },
      { name: "guest_agent_mentions_enabled", enabled: false },
      { name: "git_push_enabled", enabled: true },
      { name: "pr_creation_enabled", enabled: true },
      { name: "merge_enabled", enabled: true },
    ])
    .onConflictDoUpdate({
      target: schema.executionFlagTable.name,
      set: {
        enabled: sql`excluded.enabled`,
        updatedAt: new Date(),
      },
    });
}
