// SPEC-2026-10-27-kaneo-subtask-board-focus-markers — migration upgrade
// check for 0050_cultured_sleeper.sql.
//
// The integration harness migrates then TRUNCATEs, so it can never prove the
// legacy backfill. This check instead:
//   1. reviews the migration file for an explicit UPDATE statement, and
//   2. replays the exact backfill statement against a legacy-shaped project
//      row (show_subtask_cards_by_default = false, the value the ADD COLUMN
//      default assigns at migration time) and asserts it flips to true.
//
// Usage: node scripts/check-migration-0050-upgrade.mjs (DATABASE_URL must
// point at the *_test database; the script cleans up its own row).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

// pnpm keeps `pg` inside apps/api's dependency folder — resolve from there.
const require = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const { Client } = require("pg");

const migrationPath = new URL(
  "../apps/api/drizzle/0050_cultured_sleeper.sql",
  import.meta.url,
);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const migrationSql = readFileSync(migrationPath, "utf8");

// 1. SQL review: the backfill must be an explicit UPDATE inside the same
// migration file that adds the column.
const updateStatements = migrationSql
  .split("--> statement-breakpoint")
  .map((statement) =>
    statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
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

const client = new Client({ connectionString: databaseUrl });
await client.connect();

try {
  // 2. Replay the exact backfill statement against a legacy-shaped row.
  const slug = `migration-check-${randomUUID()}`;
  const insert = await client.query(
    `INSERT INTO "project" ("id", "workspace_id", "name", "slug")
     SELECT $1, "id", 'Migration check', $2 FROM "workspace" LIMIT 1
     RETURNING "id"`,
    [randomUUID(), slug],
  );
  if (insert.rowCount !== 1) {
    fail("could not seed a legacy-shaped project row (no workspace found)");
  }
  const projectId = insert.rows[0].id;

  await client.query(
    `UPDATE "project" SET "show_subtask_cards_by_default" = false WHERE "id" = $1`,
    [projectId],
  );

  await client.query(updateStatements[0]);

  const after = await client.query(
    `SELECT "show_subtask_cards_by_default" FROM "project" WHERE "id" = $1`,
    [projectId],
  );
  const value = after.rows[0]?.show_subtask_cards_by_default;
  if (value !== true) {
    fail(`legacy row did not flip to true after replay (got ${value})`);
  }
  console.log(
    "Upgrade check OK: replayed backfill flipped the legacy-shaped row to true",
  );

  // 3. New-row default check: rows inserted after the migration stay false.
  const postMigration = await client.query(
    `INSERT INTO "project" ("id", "workspace_id", "name", "slug")
     SELECT $1, "id", 'Migration check new', $2 FROM "workspace" LIMIT 1
     RETURNING "show_subtask_cards_by_default"`,
    [randomUUID(), `migration-check-new-${randomUUID()}`],
  );
  if (postMigration.rows[0].show_subtask_cards_by_default !== false) {
    fail("post-migration rows must default to false");
  }
  console.log("New-row check OK: post-migration inserts default to false");

  await client.query(`DELETE FROM "project" WHERE "workspace_id" IN (
    SELECT "id" FROM "workspace" LIMIT 1
  ) AND "slug" LIKE 'migration-check-%'`);
  console.log("Cleanup OK: migration-check rows removed");
} finally {
  await client.end();
}
