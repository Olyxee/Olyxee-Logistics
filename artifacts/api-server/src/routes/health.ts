import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

import * as dbModule from "@workspace/db";
import { isTable, getTableName, getTableColumns } from "drizzle-orm";

let schemaDriftCheckCompleted = false;

// Dynamically derive expected tables and columns from all Drizzle tables exported by @workspace/db
function getExpectedSchemaColumns(): Array<{ table: string; column: string }> {
  const columns: Array<{ table: string; column: string }> = [];
  for (const exp of Object.values(dbModule)) {
    if (isTable(exp)) {
      const tableName = getTableName(exp);
      const tableCols = getTableColumns(exp);
      for (const col of Object.values(tableCols)) {
        if (col && typeof col.name === "string") {
          columns.push({ table: tableName, column: col.name });
        }
      }
    }
  }
  return columns;
}

export async function checkSchemaDrift(
  logger?: { warn: (obj: unknown, msg: string) => void },
  force = false,
): Promise<void> {
  if (schemaDriftCheckCompleted && !force) return;

  try {
    const expected = getExpectedSchemaColumns();
    if (expected.length === 0) return;

    // Read-only query against information_schema.columns for public tables
    const tableNames = Array.from(new Set(expected.map((c) => c.table)));
    const quotedTableNames = tableNames.map((t) => `'${t}'`).join(", ");

    const rows = await db.execute<{ table_name: string; column_name: string }>(
      sql.raw(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${quotedTableNames})`,
      ),
    );

    const existing = new Set(
      (rows.rows || []).map((r) => `${r.table_name}.${r.column_name}`),
    );

    const missing = expected.filter(
      (c) => !existing.has(`${c.table}.${c.column}`),
    );

    if (missing.length > 0) {
      logger?.warn(
        { missingColumns: missing.map((m) => `${m.table}.${m.column}`) },
        "Schema drift detected: database lacks columns defined in Drizzle schema",
      );
    }
    schemaDriftCheckCompleted = true;
  } catch (schemaErr) {
    logger?.warn({ err: schemaErr }, "Schema drift inspection query failed");
  }
}

router.get("/readyz", async (req, res) => {
  try {
    await db.execute(sql`select 1`);

    // Schema drift check: runs once per instance only when CHECK_SCHEMA_DRIFT=1 is set.
    // Never crashes the application or fails the readiness probe.
    // Discrepancies are logged with details only and never exposed in the HTTP response.
    if (process.env.CHECK_SCHEMA_DRIFT === "1" && !schemaDriftCheckCompleted) {
      await checkSchemaDrift(req.log);
    }

    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (err) {
    req.log?.error({ err }, "Readiness check failed");
    res.status(503).json({ status: "unavailable" });
  }
});

export default router;
