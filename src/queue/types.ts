import type { Queryable } from "../db/pool.js";

export interface JobMessage<T = unknown> {
  id: string;
  queue: string;
  payload: T;
  attempts: number; // 1 on first delivery (mirrors SQS ApproximateReceiveCount)
  maxAttempts: number;
}

export interface EnqueueOptions {
  /** Same dedupKey -> the second enqueue is a no-op (SQS FIFO MessageDeduplicationId). */
  dedupKey?: string;
  delaySeconds?: number;
  maxAttempts?: number;
  /** Enqueue inside the caller's transaction so job + state change commit atomically. */
  tx?: Queryable;
}

/**
 * Queue abstraction. The PoC ships a Postgres implementation (SKIP LOCKED);
 * production swaps in SQS behind the same interface. Semantics are modelled on
 * SQS so the swap is mechanical: lease == visibility timeout, fail with
 * attempts >= maxAttempts == dead-letter queue.
 */
export interface JobQueue {
  enqueue(queue: string, payload: unknown, opts?: EnqueueOptions): Promise<{ id: string | null; duplicate: boolean }>;
  lease(queue: string, workerId: string, leaseSeconds: number): Promise<JobMessage | null>;
  /** Heartbeat: extend the lease of a long-running job (SQS ChangeMessageVisibility). */
  extendLease(jobId: string, leaseSeconds: number): Promise<void>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, error: string, retryDelaySeconds: number): Promise<"retry" | "dead">;
  /** Return expired leases to the ready state (what SQS does automatically). */
  reapExpiredLeases(): Promise<number>;
  stats(): Promise<Record<string, Record<string, number>>>;
}

export function backoffSeconds(attempt: number, base = 15, cap = 600): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(30, exp / 2));
  return exp + jitter;
}
