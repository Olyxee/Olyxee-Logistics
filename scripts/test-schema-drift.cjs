/**
 * Test suite for schema drift detection in /api/readyz.
 * Verifies:
 * 1. Schema matches -> no warning
 * 2. One column missing -> warning logs table.column
 * 3. DB query throws -> readyz stays healthy and logs failure
 */

const expectedSchemaColumns = [
  { table: "businesses", column: "id" },
  { table: "businesses", column: "name" },
  { table: "businesses", column: "industry" },
  { table: "orders", column: "id" },
  { table: "orders", column: "transport_mode" },
];

async function checkSchemaDriftWithMock(mockDb, logger) {
  try {
    const tableNames = Array.from(new Set(expectedSchemaColumns.map((c) => c.table)));
    const quotedTableNames = tableNames.map((t) => `'${t}'`).join(", ");

    const rows = await mockDb.execute(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${quotedTableNames})`
    );

    const existing = new Set(
      (rows.rows || []).map((r) => `${r.table_name}.${r.column_name}`)
    );

    const missing = expectedSchemaColumns.filter(
      (c) => !existing.has(`${c.table}.${c.column}`)
    );

    if (missing.length > 0) {
      logger.warn(
        { missingColumns: missing.map((m) => `${m.table}.${m.column}`) },
        "Schema drift detected: database lacks columns defined in Drizzle schema"
      );
    }
    return { status: "ok" };
  } catch (schemaErr) {
    logger.warn({ err: schemaErr.message }, "Schema drift inspection query failed");
    return { status: "ok" };
  }
}

async function runTests() {
  console.log("=== Schema Drift Check Mock Test Suite ===");

  // TEST 1: Schema matches
  console.log("\n--- TEST 1: Schema matches perfectly ---");
  const logs1 = [];
  const mockDb1 = {
    async execute() {
      return {
        rows: [
          { table_name: "businesses", column_name: "id" },
          { table_name: "businesses", column_name: "name" },
          { table_name: "businesses", column_name: "industry" },
          { table_name: "orders", column_name: "id" },
          { table_name: "orders", column_name: "transport_mode" },
        ],
      };
    },
  };
  const logger1 = { warn: (obj, msg) => logs1.push({ obj, msg }) };
  const res1 = await checkSchemaDriftWithMock(mockDb1, logger1);
  console.log("readyz result:", res1);
  console.log("Warnings emitted count:", logs1.length);
  if (logs1.length === 0 && res1.status === "ok") {
    console.log("PASS: No warning logged when schema matches.");
  } else {
    console.error("FAIL: Unexpected warning emitted.");
  }

  // TEST 2: One column missing (e.g. orders.transport_mode)
  console.log("\n--- TEST 2: One column missing in database ---");
  const logs2 = [];
  const mockDb2 = {
    async execute() {
      return {
        rows: [
          { table_name: "businesses", column_name: "id" },
          { table_name: "businesses", column_name: "name" },
          { table_name: "businesses", column_name: "industry" },
          { table_name: "orders", column_name: "id" },
          // orders.transport_mode is missing!
        ],
      };
    },
  };
  const logger2 = { warn: (obj, msg) => logs2.push({ obj, msg }) };
  const res2 = await checkSchemaDriftWithMock(mockDb2, logger2);
  console.log("readyz result:", res2);
  console.log("Warnings emitted:", JSON.stringify(logs2, null, 2));
  if (
    logs2.length === 1 &&
    logs2[0].obj.missingColumns.includes("orders.transport_mode") &&
    res2.status === "ok"
  ) {
    console.log("PASS: Exactly logged missing column 'orders.transport_mode' while readyz remains ok.");
  } else {
    console.error("FAIL: Missing column was not properly warned.");
  }

  // TEST 3: DB query throws
  console.log("\n--- TEST 3: Database query throws error ---");
  const logs3 = [];
  const mockDb3 = {
    async execute() {
      throw new Error("connection terminated unexpectedly");
    },
  };
  const logger3 = { warn: (obj, msg) => logs3.push({ obj, msg }) };
  const res3 = await checkSchemaDriftWithMock(mockDb3, logger3);
  console.log("readyz result:", res3);
  console.log("Warnings emitted:", JSON.stringify(logs3, null, 2));
  if (
    logs3.length === 1 &&
    logs3[0].msg === "Schema drift inspection query failed" &&
    res3.status === "ok"
  ) {
    console.log("PASS: Caught query error, logged warning, readyz stayed healthy.");
  } else {
    console.error("FAIL: Thrown error was not properly handled.");
  }
}

runTests();
