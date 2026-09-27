import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  businessesTable,
  passwordResetTokensTable,
} from "@workspace/db";
import { companyAcronym, generateId } from "../lib/id";
import {
  SESSION_COOKIE,
  signSession,
  sessionCookieOptions,
  verifySession,
} from "../lib/session";
import { sendPasswordResetEmail } from "../lib/email";

const RESET_TOKEN_TTL_MINUTES = 30;

// Hardcoded demo account - intentionally bypasses the database so the demo
// login works even when the database is unavailable.
export const DEMO_USER_ID = "demo-usr-000000000001";
export const DEMO_BUSINESS_ID = "demo-biz-000000000001";
export const DEMO_USER = {
  id: DEMO_USER_ID,
  email: "demo@demo.com",
  name: "Demo User",
  role: "owner" as const,
  businessId: DEMO_BUSINESS_ID,
  avatarUrl: null,
};

function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// The demo account is hardcoded and bypasses the DB for auth, but writes
// (creating customers/orders) need a real `businesses` row to exist or they
// fail the `business_id` foreign key. Seed that row (and a matching demo user)
// lazily on demo login so the demo is fully read/write. Idempotent via ON
// CONFLICT DO NOTHING, best-effort so a DB hiccup never breaks demo login, and
// memoized so it runs at most once per warm process. Demo login is gated to
// non-production, so this never seeds a deployed database.
let _demoSeedReady: Promise<void> | null = null;
async function ensureDemoSeed(): Promise<void> {
  if (_demoSeedReady) return _demoSeedReady;
  _demoSeedReady = (async () => {
    await db
      .insert(businessesTable)
      .values({
        id: DEMO_BUSINESS_ID,
        name: "Demo Business",
        slug: "demo-business",
        websiteUrl: "",
        supportEmail: "demo@demo.com",
        trackingIdPrefix: "TRK",
        monthlyEmailLimit: 500,
        onboardingCompleted: true,
        createdAt: new Date("2024-01-01"),
      })
      .onConflictDoNothing();
    await db
      .insert(usersTable)
      .values({
        id: DEMO_USER_ID,
        businessId: DEMO_BUSINESS_ID,
        name: DEMO_USER.name,
        email: DEMO_USER.email,
        role: DEMO_USER.role,
      })
      .onConflictDoNothing();
  })().catch((err) => {
    // Allow a retry on the next demo login rather than caching the failure.
    _demoSeedReady = null;
    throw err;
  });
  return _demoSeedReady;
}

// Self-healing schema guard. The production database may predate the
// password-auth migration and be missing the `password_hash` / `auth_user_id`
// columns, which makes every real login/signup query fail with Postgres code
// 42703 ("column does not exist"). Adding them is idempotent and additive
// (ADD COLUMN IF NOT EXISTS), so it is safe to run lazily before the first
// auth query and is a no-op once the columns exist. Memoized so it runs at
// most once per warm process; on failure the memo is cleared so a later
// request can retry. This is a stopgap so the app heals itself without a
// manual migration; the source-of-truth schema still lives in lib/db.
let _authSchemaReady: Promise<void> | null = null;
async function ensureAuthColumns(): Promise<void> {
  if (_authSchemaReady) return _authSchemaReady;
  _authSchemaReady = (async () => {
    await db.execute(
      sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_user_id" text`,
    );
    await db.execute(
      sql`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text`,
    );
  })().catch((err) => {
    // Allow a retry on the next request rather than caching the failure.
    _authSchemaReady = null;
    throw err;
  });
  return _authSchemaReady;
}

// Drizzle wraps the underlying pg error in a DrizzleQueryError whose own
// `.code`/`.detail` are undefined and whose `.message` is just "Failed query:
// ...". The real Postgres error (e.g. code 42703 "column ... does not exist")
// lives on `.cause`. Unwrap it so logs show the actionable cause instead of
// "undefined undefined".
function describeDbError(err: unknown): {
  code?: string;
  message?: string;
  detail?: string;
  chain?: string;
} {
  // Walk the full `.cause` chain. Drizzle wraps the real Postgres error (which
  // carries the useful `code`/`detail`) one or more levels deep inside a
  // generic "Failed query" error, so a single-level unwrap misses it.
  const parts: string[] = [];
  let pgErr:
    | { code?: string; message?: string; detail?: string }
    | undefined;
  let cur = err as
    | {
        name?: string;
        code?: string;
        message?: string;
        detail?: string;
        cause?: unknown;
      }
    | undefined;
  let depth = 0;
  while (cur && depth < 8) {
    const label = cur.name ?? cur.constructor?.name ?? "Error";
    parts.push(
      `${label}: ${cur.message ?? ""}${cur.code ? ` [${cur.code}]` : ""}`,
    );
    // First error in the chain that carries a Postgres-style code wins.
    if (cur.code && !pgErr) pgErr = cur;
    cur = cur.cause as typeof cur;
    depth += 1;
  }
  const top = err as { code?: string; message?: string; detail?: string };
  return {
    code: pgErr?.code ?? top?.code,
    message: pgErr?.message ?? top?.message,
    detail: pgErr?.detail ?? top?.detail,
    chain: parts.join("  <-  "),
  };
}

function buildResetLink(req: import("express").Request, token: string): string {
  // Prefer the first configured ALLOWED_ORIGINS entry (the production app
  // origin); fall back to the request's host so it still works in dev.
  const origins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base =
    origins[0] ??
    `${req.protocol}://${req.get("host") ?? "localhost"}`;
  return `${base.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

const router = Router();

const SignupBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  fullName: z.string().trim().min(1).max(120),
  businessName: z.string().trim().min(1).max(120),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(200),
});

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "workspace"
  );
}

router.post("/auth/signup", async (req, res) => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid signup details" });
    return;
  }
  const { email, password, fullName, businessName } = parsed.data;

  try {
    await ensureAuthColumns();
    const existing = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    });
    if (existing) {
      res.status(409).json({ error: "An account with this email already exists." });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const businessId = generateId();
    const userId = generateId();
    const slug = `${slugify(businessName)}-${businessId.slice(0, 6)}`;

    await db.transaction(async (tx) => {
      await tx.insert(businessesTable).values({
        id: businessId,
        name: businessName,
        slug,
        websiteUrl: "",
        supportEmail: email,
        trackingIdPrefix: companyAcronym(businessName),
      });
      await tx.insert(usersTable).values({
        id: userId,
        businessId,
        name: fullName,
        email,
        passwordHash,
        role: "owner",
      });
    });

    const token = signSession(userId);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.status(201).json({
      user: { id: userId, email, name: fullName, role: "owner", businessId },
    });
  } catch (err) {
    // Use console.error in addition to req.log because pino's async writes
    // sometimes don't flush before a serverless function freezes.
    const e = describeDbError(err);
    console.error(
      "[signup] failed:",
      e.code ?? "(no code)",
      "|",
      e.message,
      "|",
      e.detail ?? "",
      "| chain:",
      e.chain,
    );
    req.log?.error({ err }, "signup failed");
    res.status(500).json({ error: "Could not create account" });
  }
});

router.post("/auth/login", async (req, res) => {
  const rawEmail = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const rawPassword = typeof req.body?.password === "string" ? req.body.password : "";

  // Hardcoded demo credentials - works even when the database is unavailable.
  // Gated to non-production so it is never an auth-bypass path in a deployed app.
  if (
    process.env.NODE_ENV !== "production" &&
    (rawEmail === "demo" || rawEmail === "demo@demo.com") &&
    rawPassword === "demo"
  ) {
    // Best-effort: make sure the demo business/user rows exist so demo writes
    // (create customer/order) don't fail the business_id foreign key. A DB
    // failure here must not block login, which is meant to work even when the
    // database is unavailable.
    try {
      await ensureDemoSeed();
    } catch (err) {
      req.log.warn({ err }, "Demo seed failed; demo writes may not work");
    }
    const token = signSession(DEMO_USER_ID);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json({ user: DEMO_USER });
    return;
  }

  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid email or password" });
    return;
  }
  const { email, password } = parsed.data;

  try {
    await ensureAuthColumns();
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    });
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const token = signSession(user.id);
    const activeAt = new Date();
    await db.update(usersTable).set({ lastActiveAt: activeAt }).where(eq(usersTable.id, user.id));
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        businessId: user.businessId,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (err) {
    const e = describeDbError(err);
    console.error(
      "[login] failed:",
      e.code ?? "(no code)",
      "|",
      e.message,
      "|",
      e.detail ?? "",
      "| chain:",
      e.chain,
    );
    req.log?.error({ err }, "login failed");
    res.status(500).json({ error: "Login failed" });
  }
});

const ForgotBody = z.object({
  email: z.string().trim().toLowerCase().email(),
});

router.post("/auth/forgot-password", async (req, res) => {
  const parsed = ForgotBody.safeParse(req.body);
  // Always return 200 to avoid leaking which emails exist (account enumeration).
  if (!parsed.success) {
    res.json({ ok: true });
    return;
  }
  const { email } = parsed.data;
  try {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.email, email),
    });
    if (user) {
      // The reset request is unauthenticated. Resolve branding only through
      // this matched user's business, never from request-supplied tenant data.
      const business = await db.query.businessesTable.findFirst({
        where: eq(businessesTable.id, user.businessId),
      });
      const token = crypto.randomBytes(32).toString("base64url");
      const tokenHash = hashResetToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
      await db.insert(passwordResetTokensTable).values({
        id: generateId(),
        userId: user.id,
        tokenHash,
        expiresAt,
      });
      const link = buildResetLink(req, token);
      const result = await sendPasswordResetEmail({
        businessId: user.businessId,
        businessName: business?.name,
        supportEmail: business?.supportEmail,
        to: user.email,
        name: user.name,
        resetLink: link,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
      });
      if (!result.success) {
        req.log?.warn(
          { err: result.error },
          "password reset email send failed (token still issued)",
        );
      }
    }
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error("[forgot_password] failed:", e?.code, e?.message);
    req.log?.error({ err }, "forgot_password failed");
    // Still respond ok so the response shape is identical to the
    // happy path (no information leak based on errors).
  }
  res.json({ ok: true });
});

const ResetBody = z.object({
  token: z.string().min(10).max(200),
  password: z.string().min(8).max(200),
});

router.post("/auth/reset-password", async (req, res) => {
  const parsed = ResetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid token or password" });
    return;
  }
  const { token, password } = parsed.data;
  const tokenHash = hashResetToken(token);
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    // Atomic single-use: only one concurrent reset wins the race because
    // the UPDATE is guarded by `used_at IS NULL AND expires_at > now()`.
    // Whoever loses gets 0 rows back and we treat it as invalid.
    const claimed = await db
      .update(passwordResetTokensTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokensTable.tokenHash, tokenHash),
          isNull(passwordResetTokensTable.usedAt),
          gt(passwordResetTokensTable.expiresAt, new Date()),
        ),
      )
      .returning({
        id: passwordResetTokensTable.id,
        userId: passwordResetTokensTable.userId,
      });
    const row = claimed[0];
    if (!row) {
      res.status(400).json({ error: "This reset link is invalid or has expired." });
      return;
    }
    await db
      .update(usersTable)
      .set({ passwordHash })
      .where(eq(usersTable.id, row.userId));
    res.json({ ok: true });
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error("[reset_password] failed:", e?.code, e?.message);
    req.log?.error({ err }, "reset_password failed");
    res.status(500).json({ error: "Could not reset password" });
  }
});

router.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: 0 });
  res.json({ ok: true });
});

// Allow the currently signed-in admin to edit their own profile. Two
// independent concerns share this endpoint:
//   1. Update name / email (lightweight - email uniqueness re-checked).
//   2. Change password - requires `currentPassword` + `newPassword` so a
//      stolen-session attacker can't silently rotate the password.
// Any field can be omitted; only what's provided is touched.
const UpdateMeBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    currentPassword: z.string().min(1).max(200).optional(),
    newPassword: z.string().min(8).max(200).optional(),
    avatarUrl: z
      .union([
        z.string().max(500_000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Upload a PNG, JPEG or WebP image."),
        z.null(),
      ])
      .optional(),
  })
  .refine(
    (d) =>
      // Password change is all-or-nothing.
      (d.currentPassword == null && d.newPassword == null) ||
      (d.currentPassword != null && d.newPassword != null),
    { message: "Both currentPassword and newPassword are required to change password." },
  );

router.put("/auth/me", async (req, res) => {
  const token = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  const payload = verifySession(token);
  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Demo session is fully hardcoded and has no database row - mirror the
  // bypass in requireAuth so the profile page doesn't 401. Updates are a no-op.
  if (payload.userId === DEMO_USER_ID) {
    res.json({ user: DEMO_USER });
    return;
  }

  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    });
    return;
  }
  const { name, email, currentPassword, newPassword, avatarUrl } = parsed.data;

  try {
    const user = await db.query.usersTable.findFirst({
      where: eq(usersTable.id, payload.userId),
    });
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    // Email uniqueness check - only if the email is actually changing.
    if (email && email !== user.email) {
      const clash = await db.query.usersTable.findFirst({
        where: eq(usersTable.email, email),
      });
      if (clash) {
        res.status(409).json({ error: "Another account already uses this email." });
        return;
      }
    }

    // Password change path - verify current password before rotating.
    let nextPasswordHash: string | undefined;
    if (currentPassword && newPassword) {
      if (!user.passwordHash) {
        res.status(400).json({ error: "This account has no password set." });
        return;
      }
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) {
        res.status(400).json({ error: "Current password is incorrect." });
        return;
      }
      nextPasswordHash = await bcrypt.hash(newPassword, 10);
    }

    const updated = await db
      .update(usersTable)
      .set({
        name: name ?? user.name,
        email: email ?? user.email,
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
        ...(nextPasswordHash ? { passwordHash: nextPasswordHash } : {}),
      })
      .where(eq(usersTable.id, user.id))
      .returning();

    const u = updated[0]!;
    res.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        businessId: u.businessId,
        avatarUrl: u.avatarUrl,
      },
    });
  } catch (err) {
    const e = err as { message?: string; code?: string; detail?: string };
    console.error("[update_me] failed:", e?.code, e?.message, e?.detail);
    req.log?.error({ err }, "update_me failed");
    res.status(500).json({ error: "Could not update profile" });
  }
});

router.get("/auth/me", async (req, res) => {
  const token = (req as any).cookies?.[SESSION_COOKIE] as string | undefined;
  const payload = verifySession(token);
  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Demo session is fully hardcoded and has no database row - mirror the
  // bypass in requireAuth so session restore works on refresh.
  if (payload.userId === DEMO_USER_ID) {
    res.json({ user: DEMO_USER });
    return;
  }

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, payload.userId),
  });
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const activeAt = new Date();
  await db.update(usersTable).set({ lastActiveAt: activeAt }).where(eq(usersTable.id, user.id));
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      businessId: user.businessId,
      avatarUrl: user.avatarUrl,
    },
  });
});

export default router;
