/**
 * Worker: leases stage jobs from the queue, runs the stage handler with a
 * heartbeat, records every attempt, and enqueues the next stage.
 *
 * Failure semantics (see docs/architecture.md section 6):
 *   - handler throws retryable error  -> job returns to queue with backoff;
 *                                         after max attempts -> dead + evaluation failed
 *   - handler throws non-retryable    -> evaluation failed immediately, job done
 *   - worker crashes                  -> lease expires, job re-delivered, handler is idempotent
 *   - duplicate delivery              -> state-machine guard rejects, job completed
 */
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { closePool, pool } from "../db/pool.js";
import { IllegalTransitionError, STAGES, STAGE_STATUS, transition, type Stage } from "../domain/evaluation-state.js";
import { createLlmProvider } from "../llm/index.js";
import { BudgetedLlm, LlmError } from "../llm/provider.js";
import { logger } from "../logger.js";
import { PgQueue } from "../queue/pg-queue.js";
import { backoffSeconds, type JobMessage, type JobQueue } from "../queue/types.js";
import { LocalObjectStore } from "../storage/object-store.js";
import type { EvaluationRow } from "../pipeline/context.js";
import { ExtractionError } from "../pipeline/extract.js";
import { STAGE_HANDLERS, StageError } from "../pipeline/stages.js";

export const STAGE_QUEUE = "evaluation-stages";

export interface StageJobPayload {
  evaluationId: string;
  stage: Stage;
}

const workerId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const log = logger.child({ workerId });
let stopping = false;

export async function runStageJob(queue: JobQueue, job: JobMessage<StageJobPayload>): Promise<void> {
  const { evaluationId, stage } = job.payload;
  const stageIdx = STAGES.indexOf(stage);
  if (stageIdx < 0) {
    log.error({ job }, "unknown stage; completing job");
    await queue.complete(job.id);
    return;
  }
  const jlog = log.child({ evaluationId, stage, attempt: job.attempts, jobId: job.id });

  const { rows } = await pool.query<EvaluationRow>(`SELECT * FROM evaluations WHERE id = $1`, [evaluationId]);
  const evaluation = rows[0];
  if (!evaluation) {
    jlog.warn("evaluation not found; dropping job");
    await queue.complete(job.id);
    return;
  }

  // Move into this stage's status. Allowed from: queued (first stage), the
  // previous stage's status, or this stage's own status (retry / redelivery).
  const from = stageIdx === 0
    ? (["queued", STAGE_STATUS[stage].status] as const)
    : ([STAGE_STATUS[STAGES[stageIdx - 1]!].status, STAGE_STATUS[stage].status] as const);
  try {
    await transition(pool, evaluationId, [...from], STAGE_STATUS[stage].status, {
      progress: STAGE_STATUS[stage].progress, started: true, error_code: null, error_message: null,
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      jlog.warn({ status: evaluation.status }, "evaluation not in an eligible state (duplicate/late delivery); completing job");
      await queue.complete(job.id);
      return;
    }
    throw err;
  }

  const { rows: attemptRows } = await pool.query<{ id: string }>(
    `INSERT INTO evaluation_attempts (evaluation_id, stage, attempt, worker_id, status)
     VALUES ($1, $2, $3, $4, 'running')
     ON CONFLICT (evaluation_id, stage, attempt) DO UPDATE SET worker_id = EXCLUDED.worker_id, status = 'running', started_at = now(), error = NULL
     RETURNING id`,
    [evaluationId, stage, job.attempts, workerId],
  );
  const attemptId = attemptRows[0]!.id;
  await pool.query(`UPDATE evaluations SET attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1`, [evaluationId]);

  const store = new LocalObjectStore(config.STORAGE_DIR);
  const llm = new BudgetedLlm(createLlmProvider(), {
    maxCalls: config.LLM_MAX_CALLS_PER_EVALUATION,
    log: (msg, extra) => jlog.warn(extra ?? {}, msg),
  });
  const heartbeat = () => queue.extendLease(job.id, config.JOB_LEASE_SECONDS);
  const timer = setInterval(() => void heartbeat().catch((e) => jlog.warn({ err: e }, "heartbeat failed")), (config.JOB_LEASE_SECONDS * 1000) / 3);

  const started = Date.now();
  try {
    await STAGE_HANDLERS[stage]({
      db: pool, queue, store, llm, log: jlog, evaluation,
      workDir: path.resolve(config.WORK_DIR, evaluationId),
      heartbeat,
    });
    clearInterval(timer);
    await pool.query(
      `UPDATE evaluation_attempts SET status = 'succeeded', finished_at = now(), llm_calls = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1`,
      [attemptId, llm.callCount, llm.usage.inputTokens, llm.usage.outputTokens],
    );
    const next = STAGES[stageIdx + 1];
    if (next) {
      await queue.enqueue(STAGE_QUEUE, { evaluationId, stage: next } satisfies StageJobPayload, {
        dedupKey: `${evaluationId}:${next}`, maxAttempts: evaluation.max_attempts,
      });
    }
    await queue.complete(job.id);
    jlog.info({ ms: Date.now() - started, llmCalls: llm.callCount }, "stage succeeded");
  } catch (err) {
    clearInterval(timer);
    const { retryable, code, message } = describeError(err);
    await pool.query(
      `UPDATE evaluation_attempts SET status = 'failed', finished_at = now(), error = $2, llm_calls = $3, input_tokens = $4, output_tokens = $5 WHERE id = $1`,
      [attemptId, `${code}: ${message}`.slice(0, 4000), llm.callCount, llm.usage.inputTokens, llm.usage.outputTokens],
    );
    if (!retryable) {
      await failEvaluation(evaluationId, stage, code, message);
      await queue.complete(job.id);
      jlog.error({ err: message, code }, "stage failed (non-retryable); evaluation failed");
      return;
    }
    const outcome = await queue.fail(job.id, `${code}: ${message}`, backoffSeconds(job.attempts));
    if (outcome === "dead") {
      await failEvaluation(evaluationId, stage, code, `${message} (after ${job.attempts} attempts)`);
      jlog.error({ err: message, code }, "stage failed; max attempts reached; evaluation failed");
    } else {
      await pool.query(`UPDATE evaluations SET error_code = $2, error_message = $3, updated_at = now() WHERE id = $1`,
        [evaluationId, code, `retrying after: ${message}`.slice(0, 2000)]);
      jlog.warn({ err: message, code, attempt: job.attempts }, "stage failed; will retry");
    }
  }
}

function describeError(err: unknown): { retryable: boolean; code: string; message: string } {
  if (err instanceof ExtractionError) return { retryable: err.code === "clone_failed", code: err.code, message: err.message };
  if (err instanceof StageError) return { retryable: err.retryable, code: err.code, message: err.message };
  if (err instanceof LlmError) return { retryable: err.retryable, code: `llm_${err.kind}`, message: err.message };
  if (err instanceof IllegalTransitionError) return { retryable: false, code: "illegal_transition", message: err.message };
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT" || e?.code === "57P01") return { retryable: true, code: e.code, message: e.message };
  return { retryable: true, code: "unexpected", message: e?.message ?? String(err) };
}

async function failEvaluation(evaluationId: string, stage: Stage, code: string, message: string): Promise<void> {
  try {
    await transition(pool, evaluationId, [STAGE_STATUS[stage].status], "failed", { error_code: code, error_message: message.slice(0, 2000), completed: true });
    const { rows } = await pool.query<{ student_id: string }>(
      `UPDATE submissions s SET status = 'failed', updated_at = now()
       FROM evaluations e WHERE e.id = $1 AND s.id = e.submission_id RETURNING s.student_id`,
      [evaluationId],
    );
    if (rows[0]) {
      await pool.query(`INSERT INTO notifications (user_id, kind, payload) VALUES ($1, 'evaluation.failed', $2::jsonb)`,
        [rows[0].student_id, JSON.stringify({ evaluation_id: evaluationId, code })]);
    }
  } catch (err) {
    log.error({ err, evaluationId }, "could not mark evaluation failed");
  }
}

async function pollLoop(queue: JobQueue, slot: number): Promise<void> {
  const slog = log.child({ slot });
  let idle = 0;
  while (!stopping) {
    try {
      if (slot === 0 && idle % 10 === 0) {
        const reaped = await queue.reapExpiredLeases();
        if (reaped) slog.warn({ reaped }, "re-queued jobs with expired leases");
      }
      const job = await queue.lease(STAGE_QUEUE, workerId, config.JOB_LEASE_SECONDS);
      if (!job) {
        idle += 1;
        await sleep(Math.min(2000, 250 + idle * 50));
        continue;
      }
      idle = 0;
      await runStageJob(queue, job as JobMessage<StageJobPayload>);
    } catch (err) {
      slog.error({ err }, "poll loop error");
      await sleep(2000);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isMain = process.argv[1] && /worker[\\/]main\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const queue = new PgQueue(pool);
  log.info({ concurrency: config.WORKER_CONCURRENCY, provider: config.LLM_PROVIDER }, "worker starting");
  const loops = Array.from({ length: config.WORKER_CONCURRENCY }, (_, i) => pollLoop(queue, i));
  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker stopping; waiting for in-flight jobs");
    stopping = true;
    await Promise.race([Promise.all(loops), sleep(30_000)]);
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
