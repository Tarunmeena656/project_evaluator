import type { Queryable } from "../db/pool.js";
import type { EnqueueOptions, JobMessage, JobQueue } from "./types.js";

interface JobRow {
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
}

/**
 * Postgres-backed queue using SELECT ... FOR UPDATE SKIP LOCKED.
 * Good for tens of thousands of jobs/day on a single instance; the design
 * document explains when to move to SQS (and why the interface stays the same).
 */
export class PgQueue implements JobQueue {
  constructor(private readonly db: Queryable) {}

  async enqueue(queue: string, payload: unknown, opts: EnqueueOptions = {}) {
    const db = opts.tx ?? this.db;
    const res = await db.query<{ id: string }>(
      `INSERT INTO jobs (queue, payload, dedup_key, max_attempts, available_at)
       VALUES ($1, $2::jsonb, $3, $4, now() + ($5::int * interval '1 second'))
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [queue, JSON.stringify(payload), opts.dedupKey ?? null, opts.maxAttempts ?? 3, opts.delaySeconds ?? 0],
    );
    const row = res.rows[0];
    return row ? { id: row.id, duplicate: false } : { id: null, duplicate: true };
  }

  async lease(queue: string, workerId: string, leaseSeconds: number): Promise<JobMessage | null> {
    const res = await this.db.query<JobRow>(
      `WITH next AS (
         SELECT id FROM jobs
         WHERE queue = $1 AND status = 'ready' AND available_at <= now()
         ORDER BY available_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j
       SET status = 'leased',
           leased_by = $2,
           leased_until = now() + ($3::int * interval '1 second'),
           attempts = j.attempts + 1,
           updated_at = now()
       FROM next
       WHERE j.id = next.id
       RETURNING j.id, j.queue, j.payload, j.attempts, j.max_attempts`,
      [queue, workerId, leaseSeconds],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, queue: row.queue, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts };
  }

  async extendLease(jobId: string, leaseSeconds: number): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET leased_until = now() + ($2::int * interval '1 second'), updated_at = now()
       WHERE id = $1 AND status = 'leased'`,
      [jobId, leaseSeconds],
    );
  }

  async complete(jobId: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'done', leased_until = NULL, updated_at = now() WHERE id = $1`,
      [jobId],
    );
  }

  async fail(jobId: string, error: string, retryDelaySeconds: number): Promise<"retry" | "dead"> {
    const res = await this.db.query<{ status: string }>(
      `UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
           available_at = now() + ($3::int * interval '1 second'),
           leased_until = NULL,
           leased_by = NULL,
           last_error = left($2, 2000),
           updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [jobId, error, retryDelaySeconds],
    );
    return res.rows[0]?.status === "dead" ? "dead" : "retry";
  }

  async reapExpiredLeases(): Promise<number> {
    const res = await this.db.query(
      `UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'ready' END,
           leased_until = NULL,
           leased_by = NULL,
           last_error = coalesce(last_error, '') || ' | lease expired (worker crash?)',
           updated_at = now()
       WHERE status = 'leased' AND leased_until < now()`,
    );
    return res.rowCount ?? 0;
  }

  async stats() {
    const res = await this.db.query<{ queue: string; status: string; n: string }>(
      `SELECT queue, status, count(*)::text AS n FROM jobs GROUP BY queue, status`,
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of res.rows) (out[r.queue] ??= {})[r.status] = Number(r.n);
    return out;
  }
}
