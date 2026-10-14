/**
 * Test suite for lib/db connection URL password encoding and host validation.
 * Run with: node scripts/test-db-url-validation.cjs
 */

function validateDbUrl(dbUrl) {
  let sslmode = null;
  let connectionString = dbUrl;
  try {
    let u;
    try {
      u = new URL(dbUrl);
    } catch (urlErr) {
      if (dbUrl.includes("?host=") || dbUrl.includes("&host=")) {
        u = new URL(dbUrl.replace("://", "://socket-placeholder/"));
      } else {
        throw urlErr;
      }
    }

    sslmode = u.searchParams.get("sslmode");
    if (u.hostname !== "socket-placeholder") {
      u.searchParams.delete("sslmode");
      connectionString = u.toString();
    }

    if (u.password && /%(?![0-9A-Fa-f]{2})/.test(u.password)) {
      throw new Error(
        "Invalid database connection URL: malformed percent-encoding in password. Special characters (such as '#', '/', '?', or stray '%') must be percent-encoded (e.g. '%23' for '#', '%2F' for '/', '%3F' for '?', '%25' for '%').",
      );
    }

    const hasHost = Boolean((u.hostname && u.hostname !== "socket-placeholder") || u.searchParams.get("host"));
    if (!hasHost) {
      throw new Error(
        "Invalid database connection URL: missing host. Special characters in the password (such as '#', '/', '?', or stray '%') must be percent-encoded (e.g. '%23' for '#', '%2F' for '/', '%3F' for '?').",
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Invalid database connection URL")) {
      throw err;
    }
    throw new Error(
      "Invalid database connection URL format. Ensure the URL is valid and special characters in the password (such as '#', '/', '?', or stray '%') are percent-encoded.",
    );
  }

  const isLocal = /@(localhost|127\.0\.0\.1|::1)/i.test(dbUrl);
  const ssl = sslmode?.toLowerCase() === "disable" || isLocal ? false : { rejectUnauthorized: false };
  return { connectionString, ssl };
}

const testCases = [
  {
    name: "1. Percent-encoded password (%40, %23)",
    url: "postgresql://postgres.dummyref:p%40ss%23word@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: false,
  },
  {
    name: "2. Plain alphanumeric password",
    url: "postgresql://postgres.dummyref:plainSecretPassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: false,
  },
  {
    name: "3. Raw unencoded @ in password (must NOT throw)",
    url: "postgresql://postgres.dummyref:p@ssword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: false,
  },
  {
    name: "4. Raw unencoded # in password (must throw)",
    url: "postgresql://postgres.dummyref:p#ssword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: true,
  },
  {
    name: "5. Raw unencoded / in password (must throw)",
    url: "postgresql://postgres.dummyref:p/ssword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: true,
  },
  {
    name: "6. Raw unencoded ? in password (must throw)",
    url: "postgresql://postgres.dummyref:p?ssword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: true,
  },
  {
    name: "7. Malformed stray % not followed by hex digits (must throw)",
    url: "postgresql://postgres.dummyref:p%zzword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    shouldThrow: true,
  },
  {
    name: "8. Socket-style URL with host parameter (must NOT throw)",
    url: "postgresql://postgres.dummyref:plainSecretPassword123@/postgres?host=%2Fvar%2Frun%2Fpostgresql",
    shouldThrow: false,
  },
];

console.log("=== DB Connection URL Validation Test Suite ===");
let passed = 0;
for (const tc of testCases) {
  try {
    const result = validateDbUrl(tc.url);
    if (tc.shouldThrow) {
      console.error(`FAIL: ${tc.name} expected error but passed.`);
    } else {
      console.log(`PASS: ${tc.name} successfully parsed.`);
      passed++;
    }
  } catch (err) {
    if (tc.shouldThrow) {
      console.log(`PASS: ${tc.name} threw expected error: "${err.message}"`);
      passed++;
    } else {
      console.error(`FAIL: ${tc.name} threw unexpected error: "${err.message}"`);
    }
  }
}

console.log(`\nResult: ${passed}/${testCases.length} tests passed.`);
if (passed !== testCases.length) {
  process.exit(1);
}
