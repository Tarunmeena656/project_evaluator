import type { Queryable } from "../db/pool.js";

export type EvaluationStatus =
  | "queued"
  | "extracting"
  | "understanding"
  | "evaluating"
  | "aggregating"
  | "needs_review"
  | "completed"
  | "approved"
  | "rejected"
  | "failed"
  | "cancelled";

export type Stage = "extract" | "understand" | "evaluate" | "aggregate";

export const STAGES: Stage[] = ["extract", "understand", "evaluate", "aggregate"];

/** Which status a stage puts the evaluation into while it runs, and its progress. */
export const STAGE_STATUS: Record<Stage, { status: EvaluationStatus; progress: number }> = {
  extract: { status: "extracting", progress: 10 },
  understand: { status: "understanding", progress: 35 },
  evaluate: { status: "evaluating", progress: 60 },
  aggregate: { status: "aggregating", progress: 90 },
};

export const ACTIVE_STATUSES: EvaluationStatus[] = ["queued", "extracting", "understanding", "evaluating", "aggregating"];
/** "completed" is NOT terminal: a human can still approve/reject or send it to review. */
export const TERMINAL_STATUSES: EvaluationStatus[] = ["approved", "rejected", "failed", "cancelled"];

/**
 * Legal transitions. Anything not listed is rejected at the database level by
 * the `WHERE status = ANY(from)` guard in `transition()`, which is what keeps
 * two workers (or a worker and an API call) from producing inconsistent states.
 */
export const TRANSITIONS: Record<EvaluationStatus, EvaluationStatus[]> = {
  queued: ["extracting", "failed", "cancelled"],
  extracting: ["understanding", "extracting", "failed", "queued"],
  understanding: ["evaluating", "understanding", "failed", "queued"],
  evaluating: ["aggregating", "evaluating", "failed", "queued"],
  aggregating: ["completed", "needs_review", "aggregating", "failed", "queued"],
  needs_review: ["approved", "rejected"],
  completed: ["needs_review", "approved", "rejected"],
  approved: [],
  rejected: [],
  failed: ["queued"], // manual retry creates a fresh run from the beginning
  cancelled: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly evaluationId: string,
    public readonly from: EvaluationStatus[],
    public readonly to: EvaluationStatus,
  ) {
    super(`evaluation ${evaluationId}: cannot move to '${to}' from any of [${from.join(", ")}]`);
  }
}

export function canTransition(from: EvaluationStatus, to: EvaluationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

interface TransitionPatch {
  progress?: number;
  error_code?: string | null;
  error_message?: string | null;
  needs_review_reason?: string | null;
  started?: boolean;
  completed?: boolean;
}

/**
 * Compare-and-set state change. Returns the updated row or throws if the row is
 * not in one of the expected `from` states (lost race, duplicate delivery...).
 */
export async function transition(
  db: Queryable,
  evaluationId: string,
  from: EvaluationStatus[],
  to: EvaluationStatus,
  patch: TransitionPatch = {},
): Promise<Record<string, unknown>> {
  for (const f of from) {
    if (!canTransition(f, to)) throw new IllegalTransitionError(evaluationId, [f], to);
  }
  const res = await db.query(
    `UPDATE evaluations
     SET status = $3::evaluation_status,
         progress = coalesce($4, progress),
         error_code = CASE WHEN $5::boolean THEN $6 ELSE error_code END,
         error_message = CASE WHEN $5::boolean THEN $7 ELSE error_message END,
         needs_review_reason = coalesce($8, needs_review_reason),
         started_at = CASE WHEN $9::boolean THEN coalesce(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN $10::boolean THEN now() ELSE completed_at END,
         updated_at = now()
     WHERE id = $1 AND status = ANY($2::evaluation_status[])
     RETURNING *`,
    [
      evaluationId,
      from,
      to,
      patch.progress ?? null,
      patch.error_code !== undefined || patch.error_message !== undefined,
      patch.error_code ?? null,
      patch.error_message ?? null,
      patch.needs_review_reason ?? null,
      patch.started ?? false,
      patch.completed ?? false,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new IllegalTransitionError(evaluationId, from, to);
  return row as Record<string, unknown>;
}
