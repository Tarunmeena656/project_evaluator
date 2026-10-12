/**
 * Integration test for the Postgres queue. Runs only when DATABASE_URL points
 * at a reachable database (it is loaded from .env by src/config.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let reachable = false;
let pool: typeof import("../src/db/pool.js").pool;
let PgQueue: typeof import("../src/queue/pg-queue.js").PgQueue;
let migrate: typeof import("../src/db/migrate.js").migrate;

beforeAll(async () => {
  try {
    ({ pool } = await import("../src/db/pool.js"));
    ({ PgQueue } = await import("../src/queue/pg-queue.js"));
    ({ migrate } = await import("../src/db/migrate.js"));
    await pool.query("SELECT 1");
    await migrate();
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  if (!reachable) return;
  await pool.query(`DELETE FROM jobs WHERE queue LIKE 'test-%'`).catch(() => undefined);
  await pool.end();
});

describe("PgQueue", () => {
  // Each test gets its own queue so jobs never leak between tests.
  let q = "";
  beforeEach(() => {
    q = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  it("deduplicates by dedupKey", async () => {
    if (!reachable) return;
    const queue = new PgQueue(pool);
    const a = await queue.enqueue(q, { n: 1 }, { dedupKey: `${q}:dup` });
    const b = await queue.enqueue(q, { n: 1 }, { dedupKey: `${q}:dup` });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
  });

  it("leases with SKIP LOCKED semantics and counts attempts", async () => {
    if (!reachable) return;
    const queue = new PgQueue(pool);
    await queue.enqueue(q, { n: 2 }, { dedupKey: `${q}:lease`, maxAttempts: 2 });
    const first = await queue.lease(q, "w1", 60);
    expect(first).not.toBeNull();
    expect(first!.attempts).toBe(1);
    // The only job is leased by w1: a second worker gets nothing (SKIP LOCKED + status guard).
    expect(await queue.lease(q, "w2", 60)).toBeNull();

    // Fail once -> back to ready; lease again -> attempt 2; fail again -> dead (maxAttempts 2).
    expect(await queue.fail(first!.id, "boom", 0)).toBe("retry");
    const again = await queue.lease(q, "w3", 60);
    expect(again?.id).toBe(first!.id);
    expect(again?.attempts).toBe(2);
    expect(await queue.fail(first!.id, "boom again", 0)).toBe("dead");
    expect(await queue.lease(q, "w4", 60)).toBeNull();
  });

  it("re-queues expired leases (crash recovery)", async () => {
    if (!reachable) return;
    const queue = new PgQueue(pool);
    await queue.enqueue(q, { n: 3 }, { dedupKey: `${q}:crash` });
    const job = await queue.lease(q, "crashy", 1);
    expect(job).not.toBeNull();
    await pool.query(`UPDATE jobs SET leased_until = now() - interval '1 minute' WHERE id = $1`, [job!.id]);
    const reaped = await queue.reapExpiredLeases();
    expect(reaped).toBeGreaterThanOrEqual(1);
    const redelivered = await queue.lease(q, "healthy", 60);
    expect(redelivered?.id).toBe(job!.id);
    expect(redelivered?.attempts).toBe(2);
    await queue.complete(job!.id);
  });
});
