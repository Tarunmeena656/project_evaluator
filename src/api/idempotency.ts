import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { AppError } from "./errors.js";

/**
 * Idempotency-Key support for unsafe POSTs (Stripe-style).
 *   - first request with a key: runs the handler, stores status + body
 *   - same key + same payload: replays the stored response (Idempotent-Replayed: true)
 *   - same key + different payload: 422
 *   - same key while the first is still running: 409
 * The key is scoped per user and route so users cannot collide with each other.
 */
export async function withIdempotency(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  payloadForHash: unknown,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const header = req.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    const out = await run();
    void reply.status(out.status).send(out.body);
    return;
  }
  if (key.length > 200) throw new AppError(400, "bad_request", "Idempotency-Key too long");
  const requestHash = createHash("sha256").update(JSON.stringify(payloadForHash)).digest("hex");

  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
    [scope, key, requestHash],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await pool.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
      `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const existing = rows[0];
    if (!existing) throw new AppError(409, "idempotency_conflict", "concurrent request with the same key; retry");
    if (existing.request_hash !== requestHash) {
      throw new AppError(422, "idempotency_key_reused", "Idempotency-Key was already used with a different request body");
    }
    if (existing.response_status === null) {
      throw new AppError(409, "idempotency_in_progress", "a request with this Idempotency-Key is still being processed");
    }
    void reply.status(existing.response_status).header("Idempotent-Replayed", "true").send(existing.response_body);
    return;
  }

  try {
    const out = await run();
    await pool.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4::jsonb WHERE scope = $1 AND key = $2`,
      [scope, key, out.status, JSON.stringify(out.body)],
    );
    void reply.status(out.status).send(out.body);
  } catch (err) {
    // Let the client retry with the same key after a failure.
    await pool.query(`DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2`, [scope, key]).catch(() => undefined);
    throw err;
  }
}
