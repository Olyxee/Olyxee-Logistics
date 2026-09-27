import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import publicTrackingRouter from "./routes/public-tracking";
import retellWebhookRouter from "./routes/webhooks/retell";
import internalVoiceRouter from "./routes/internal-voice";
import { logger } from "./lib/logger";
import {
  getAllowedOrigins,
  getBusinessAllowedOrigins,
  ensureBusinessAllowedOrigins,
  validateEnv,
  warmBusinessAllowedOrigins,
} from "./lib/env";

validateEnv();
warmBusinessAllowedOrigins();

const app: Express = express();

// Trust the platform proxy so req.ip reflects the real client
// IP for rate limiting and logging. Trusting "1" hop is the safe default.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Security headers. CSP is intentionally not enabled here because the SPA is
// served separately by the web artifact; this API only emits JSON.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Strict CORS for the authenticated/admin API surface: explicit allowlist
// from ALLOWED_ORIGINS only. Same-origin requests (no Origin header) are
// always allowed so server-to-server calls and the SPA-on-same-domain deploy
// keep working. Per-business customer origins are intentionally NOT honored
// here - they only apply to the public tracking surface below, otherwise a
// tenant's website would gain CORS access to authenticated endpoints (cookies
// stripped by browser but still a wider surface than needed).
const allowedOrigins = getAllowedOrigins();
const adminCors = cors({
  credentials: true,
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins === true) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
});

// Public tracking CORS: env allowlist UNION every business's whitelisted
// customer-site origins. No credentials - the public endpoint never reads
// cookies, so allowing arbitrary tenant origins is bounded to read-only
// tracking data. Scoped to /api/public/* below so it cannot widen access
// on authenticated routes.
const publicCors = cors({
  credentials: false,
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins === true) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Await on a cold-start cache so the first preflight on a fresh
    // instance doesn't 403 before the per-business origins load.
    ensureBusinessAllowedOrigins()
      .then((origins) => {
        if (origins.has(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} not allowed by CORS`));
      })
      .catch((err) => cb(err));
  },
});

app.use("/api/public", publicCors);
app.use(adminCors);

app.use(cookieParser());
app.use(
  express.json({
    // 1mb so branding uploads (logo/favicon data URLs from onboarding and
    // settings) fit; everything else stays far below this.
    limit: "1mb",
    // Stash the raw body so the Paystack webhook can verify its HMAC signature
    // against the exact bytes received. Harmless for every other route.
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Per-IP rate limit on all /api routes. Generous default so legitimate admin
// usage is unaffected; abusive bursts get throttled.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests, please try again shortly." },
});

// Stricter limit on mutating endpoints (orders/customers writes, status updates,
// resend-email). 60 mutations/min/IP is plenty for an admin UI.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many write requests, please slow down." },
});

// Public tracking is mounted BEFORE the write-mutation limiter and the
// authenticated router so it stays unauthenticated and read-only. It still
// inherits the per-IP apiLimiter (300 req/min) which comfortably covers the
// brief's ~60 req/min/IP target.
app.use("/api", apiLimiter);
app.use("/api", publicTrackingRouter);

// Retell webhook: unauthenticated-by-session but signature-verified. Mounted
// before the authenticated router. Does NOT inherit publicCors (no browser
// origin expected from Retell's infrastructure).
app.use("/api", retellWebhookRouter);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
  if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "PATCH" ||
    req.method === "DELETE"
  ) {
    writeLimiter(req, res, next);
    return;
  }
  next();
});

// Internal voice endpoints: server-to-server, strict bearer auth.
app.use("/api", internalVoiceRouter);

app.use("/api", router);

// Final error handler: never leak stack traces. Map known errors (CORS, body
// size, malformed JSON) to specific 4xx codes; everything else is a generic
// 500 with the error logged server-side.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as { message?: string; type?: string; statusCode?: number; status?: number };
  const message = typeof e?.message === "string" ? e.message : String(err);

  if (message.startsWith("Origin ") && message.includes("not allowed by CORS")) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (e?.type === "entity.too.large" || e?.statusCode === 413 || e?.status === 413) {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  if (e?.type === "entity.parse.failed" || e?.statusCode === 400 || e?.status === 400) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  req.log?.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
