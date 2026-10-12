import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

// Both /healthz and /health serve the liveness probe. /health is aliased
// to prevent 404s from standard external infrastructure probes or monitoring.
const healthHandler = (_req: unknown, res: any) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

router.get("/readyz", async (req, res) => {
  try {
    await db.execute(sql`select 1`);
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (err) {
    req.log?.error({ err }, "Readiness check failed");
    res.status(503).json({ status: "unavailable" });
  }
});

export default router;
