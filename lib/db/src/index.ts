import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Lazy initialization: importing this module must NOT throw when
// DATABASE_URL is missing. The pg Pool (and the missing-DATABASE_URL error)
// are deferred until the database is first actually used, so DB-free code
// paths (e.g. the hardcoded demo login) can run with no database connected.

let _pool: pg.Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

function initPool(): pg.Pool {
  if (_pool) return _pool;

  // Prefer an explicit app-provided connection (e.g. an external Supabase DB)
  // over the platform-managed DATABASE_URL so the app can point at a custom
  // database without touching the runtime-managed variable.
  const dbUrl = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }

  // Validate connection URL formatting and detect unencoded special characters in password.
  // In connection URIs (postgres://user:password@host...), characters such as '#', '/', '?', or a
  // stray '%' not followed by two hex digits break standard URL parsing (e.g. '#' truncates the host
  // into a hash fragment; '/' or '?' alters the path or query parameters). Special characters in the
  // password must be percent-encoded (e.g. '%23' for '#', '%2F' for '/', '%3F' for '?', '%25' for '%').
  // Note: unencoded '@' is parsed as userinfo delimiter by WHATWG/pg, but '#' / '/' / '?' fail driver resolution.
  let sslmode: string | null = null;
  let connectionString = dbUrl;
  try {
    let u: URL;
    try {
      u = new URL(dbUrl);
    } catch (urlErr) {
      // WHATWG URL parser rejects empty hostname with userinfo (e.g. postgresql://user:pass@/db?host=/path)
      // Allow fallback parsing if a socket `host` parameter is supplied:
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

    // Check for stray '%' in the password not followed by two hex digits:
    if (u.password && /%(?![0-9A-Fa-f]{2})/.test(u.password)) {
      throw new Error(
        "Invalid database connection URL: malformed percent-encoding in password. Special characters (such as '#', '/', '?', or stray '%') must be percent-encoded (e.g. '%23' for '#', '%2F' for '/', '%3F' for '?', '%25' for '%').",
      );
    }

    // Secondary check: verify that host is present (either via hostname or socket-style `host` query param)
    const hasHost = Boolean((u.hostname && u.hostname !== "socket-placeholder") || u.searchParams.get("host"));
    if (!hasHost) {
      throw new Error(
        "Invalid database connection URL: missing host. Special characters in the password (such as '#', '/', '?', or stray '%') must be percent-encoded (e.g. '%23' for '#', '%2F' for '/', '%3F' for '?').",
      );
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith("Invalid database connection URL")) {
      throw err;
    }
    throw new Error(
      "Invalid database connection URL format. Ensure the URL is valid and special characters in the password (such as '#', '/', '?', or stray '%') are percent-encoded.",
    );
  }

  // Decide SSL:
  // - `sslmode=disable` or an explicitly local host -> no SSL (local dev,
  //   Replit's internal `helium` DB which does not speak SSL).
  // - everything else -> SSL on, but don't reject self-signed certs (Supabase,
  //   Neon, RDS, etc. commonly present a self-signed cert in the chain).
  const isLocal = /@(localhost|127\.0\.0\.1|::1)/i.test(dbUrl);
  const ssl =
    sslmode?.toLowerCase() === "disable" || isLocal
      ? false
      : { rejectUnauthorized: false };

  _pool = new Pool({ connectionString, ssl });
  return _pool;
}

function initDb(): NodePgDatabase<typeof schema> {
  if (_db) return _db;
  _db = drizzle(initPool(), { schema });
  return _db;
}

// Exported proxies preserve the existing `db` and `pool` import surface while
// deferring connection setup to first access.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(initPool(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(initPool(), prop);
  },
});

export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(initDb(), prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(initDb(), prop);
  },
});

export * from "./schema";
