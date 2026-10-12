import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import type { JobQueue } from "../../queue/types.js";
import { requireRole } from "../auth.js";

export async function miscRoutes(app: FastifyInstance, queue: JobQueue): Promise<void> {
  // Liveness: process is up. Readiness: dependencies reachable.
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { ok: true, queue: await queue.stats() };
    } catch (err) {
      void reply.status(503);
      return { ok: false, error: (err as Error).message };
    }
  });

  app.get("/notifications", { preHandler: [app.authenticate] }, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, kind, payload, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY read_at IS NULL DESC, created_at DESC LIMIT 100`,
      [req.user.sub],
    );
    return { notifications: rows };
  });

  app.post("/notifications/:id/read", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await pool.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`, [id, req.user.sub]);
    return { ok: true };
  });

  app.get("/admin/queue", { preHandler: [app.authenticate, requireRole("admin")] }, async () => {
    const dead = await pool.query(`SELECT id, queue, payload, attempts, last_error, updated_at FROM jobs WHERE status = 'dead' ORDER BY updated_at DESC LIMIT 50`);
    return { stats: await queue.stats(), dead: dead.rows };
  });

  app.get("/admin/evaluations", { preHandler: [app.authenticate, requireRole("admin", "evaluator")] }, async () => {
    const { rows } = await pool.query(
      `SELECT status, count(*)::int AS n, round(avg(extract(epoch FROM (completed_at - started_at)))::numeric, 1) AS avg_seconds
       FROM evaluations GROUP BY status ORDER BY status`,
    );
    return { by_status: rows };
  });
}
