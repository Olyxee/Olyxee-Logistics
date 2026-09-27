import { logger } from "./logger";
import { db, businessesTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";

type EnvCheck = {
  name: string;
  required: boolean;
  description: string;
};

const REQUIRED_ALWAYS: EnvCheck[] = [
  {
    name: "DATABASE_URL",
    required: true,
    description: "Postgres connection string.",
  },
];

const REQUIRED_IN_PRODUCTION: EnvCheck[] = [
  {
    name: "SESSION_SECRET",
    required: true,
    description: "Long random string (>=16 chars) used to sign session cookies.",
  },
];

const RECOMMENDED: EnvCheck[] = [
  {
    name: "ALLOWED_ORIGINS",
    required: false,
    description:
      "Comma-separated list of origins allowed to call the API cross-origin (e.g. https://admin.example.com). Not needed when the SPA and API are served from the same domain.",
  },
  {
    name: "RESEND_API_KEY",
    required: false,
    description: "Resend API key - order status emails will be skipped without it.",
  },
  {
    name: "EMAIL_FROM_ADDRESS",
    required: false,
    description:
      "Verified sender address on your own domain (e.g. notifications@yourdomain.com). Required for outbound email; the business name is used as the display name and the business's support email as Reply-To.",
  },
];

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === "production";
  const checks = [
    ...REQUIRED_ALWAYS,
    ...(isProd ? REQUIRED_IN_PRODUCTION : []),
  ];

  const missing: EnvCheck[] = [];
  for (const c of checks) {
    if (!process.env[c.name]) missing.push(c);
  }

  if (missing.length > 0) {
    const lines = missing
      .map((m) => `  - ${m.name}: ${m.description}`)
      .join("\n");
    const msg = `Missing required environment variables:\n${lines}`;
    if (isProd) {
      throw new Error(msg);
    }
    logger.warn({ missing: missing.map((m) => m.name) }, msg);
  }

  for (const c of RECOMMENDED) {
    if (!process.env[c.name]) {
      logger.warn(
        { env: c.name },
        `Recommended env not set: ${c.name} - ${c.description}`,
      );
    }
  }
}

export function getAllowedOrigins(): string[] | true {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw) {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.CORS_ALLOW_ALL === "1") {
    return true;
  }
  if (process.env.NODE_ENV !== "production") {
    const origins = new Set<string>();
    const dev = process.env.REPLIT_DEV_DOMAIN;
    if (dev) origins.add(`https://${dev}`);
    const list = (process.env.REPLIT_DOMAINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const d of list) origins.add(`https://${d}`);
    origins.add("http://localhost:80");
    return Array.from(origins);
  }
  return [];
}

// In-memory cache of per-business allowed origins. We refresh it lazily on the
// next request after the TTL expires so the CORS callback never blocks on a
// DB call in the hot path of a healthy cache, and stale entries are bounded
// to TTL_MS. A second concurrent miss reuses the in-flight promise.
const BUSINESS_ORIGIN_TTL_MS = 60_000;
let businessOriginCache: Set<string> = new Set();
let businessOriginCacheExpiresAt = 0;
let businessOriginRefresh: Promise<Set<string>> | null = null;

async function refreshBusinessOrigins(): Promise<Set<string>> {
  const rows = await db
    .select({ allowedOrigins: businessesTable.allowedOrigins })
    .from(businessesTable)
    .where(isNotNull(businessesTable.allowedOrigins));
  const next = new Set<string>();
  for (const row of rows) {
    if (!row.allowedOrigins) continue;
    for (const origin of row.allowedOrigins.split(",")) {
      const trimmed = origin.trim();
      if (trimmed) next.add(trimmed);
    }
  }
  businessOriginCache = next;
  businessOriginCacheExpiresAt = Date.now() + BUSINESS_ORIGIN_TTL_MS;
  return next;
}

// Returns the union of currently-known per-business allowed origins. Triggers
// (but does NOT await) a background refresh when the cache is stale so CORS
// preflight stays synchronous and fast.
export function getBusinessAllowedOrigins(): Set<string> {
  if (Date.now() > businessOriginCacheExpiresAt && !businessOriginRefresh) {
    businessOriginRefresh = refreshBusinessOrigins()
      .catch((err) => {
        logger.warn({ err }, "Failed to refresh per-business allowed origins");
        // Push the next attempt out so we don't hammer the DB on a flap.
        businessOriginCacheExpiresAt = Date.now() + 10_000;
        return businessOriginCache;
      })
      .finally(() => {
        businessOriginRefresh = null;
      });
  }
  return businessOriginCache;
}

// Same as getBusinessAllowedOrigins, but on a serverless cold start (cache
// never warmed yet) we AWAIT the first refresh instead of returning an empty
// set and triggering a background fetch. Without this, the very first
  // cross-origin preflight on each cold API instance would otherwise 403
// because the cache hasn't been populated - every customer who happens to
// hit a fresh instance sees "Tracking is temporarily unavailable".
export async function ensureBusinessAllowedOrigins(): Promise<Set<string>> {
  if (businessOriginCacheExpiresAt === 0) {
    // First call ever on this instance - populate synchronously.
    if (!businessOriginRefresh) {
      businessOriginRefresh = refreshBusinessOrigins()
        .catch((err) => {
          logger.warn(
            { err },
            "Failed to refresh per-business allowed origins (cold start)",
          );
          businessOriginCacheExpiresAt = Date.now() + 10_000;
          return businessOriginCache;
        })
        .finally(() => {
          businessOriginRefresh = null;
        });
    }
    return businessOriginRefresh;
  }
  // Cache is warm - fall back to the existing stale-while-revalidate behavior.
  return getBusinessAllowedOrigins();
}

// Eagerly warm the cache at boot so the first cross-origin request from a
// tenant's website doesn't pay the refresh latency.
export function warmBusinessAllowedOrigins(): void {
  refreshBusinessOrigins().catch((err) =>
    logger.warn({ err }, "Initial per-business origin cache warm failed"),
  );
}

