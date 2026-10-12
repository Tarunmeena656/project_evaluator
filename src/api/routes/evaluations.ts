import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { transition, type EvaluationStatus } from "../../domain/evaluation-state.js";
import { aggregate, applyOverrides, type ScoredCriterion } from "../../pipeline/aggregate-math.js";
import type { JobQueue } from "../../queue/types.js";
import { STAGE_QUEUE, type StageJobPayload } from "../../worker/main.js";
import { requireRole } from "../auth.js";
import { AppError, badRequest, conflict, notFound } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import { ownedSubmission } from "./submissions.js";

const IdParams = z.object({ id: z.string().uuid() });
const ReviewRequestBody = z.object({ reason: z.string().min(3).max(2000) });
const DecisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  comment: z.string().max(5000).default(""),
  score_overrides: z.record(z.string(), z.number()).default({}),
});

const READY: EvaluationStatus[] = ["completed", "needs_review", "approved", "rejected"];

export async function evaluationRoutes(app: FastifyInstance, queue: JobQueue): Promise<void> {
  /**
   * Start an evaluation. Idempotent two ways:
   *   1. Idempotency-Key header -> identical replay
   *   2. DB partial unique index -> at most one active evaluation per submission (409 otherwise)
   * The job is enqueued in the SAME transaction as the evaluation row.
   */
  app.post("/submissions/:id/evaluations", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const sub = await ownedSubmission(id, req.user);

    await withIdempotency(req, reply, `evaluations:${req.user.sub}`, { submission_id: id }, async () => {
      const evaluation = await withTransaction(async (tx) => {
        await tx.query(`SELECT id FROM submissions WHERE id = $1 FOR UPDATE`, [id]);
        const pending = await tx.query(`SELECT count(*)::int AS n FROM submission_sources WHERE submission_id = $1 AND status <> 'stored'`, [id]);
        if (pending.rows[0]?.n > 0) throw conflict("sources_pending", "all sources must be uploaded before evaluation");
        const rubric = await tx.query<{ id: string }>(
          `SELECT r.id FROM assignments a JOIN rubrics r ON r.id = a.active_rubric_id WHERE a.id = $1 AND r.status = 'published'`,
          [sub.assignment_id],
        );
        if (!rubric.rows[0]) throw conflict("no_rubric", "assignment has no published rubric");

        let evalRow;
        try {
          evalRow = (await tx.query(
            `INSERT INTO evaluations (submission_id, rubric_id, status, requested_by) VALUES ($1, $2, 'queued', $3) RETURNING *`,
            [id, rubric.rows[0].id, req.user.sub],
          )).rows[0] as { id: string };
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            const active = await pool.query(`SELECT id, status FROM evaluations WHERE submission_id = $1 AND status IN ('queued','extracting','understanding','evaluating','aggregating')`, [id]);
            throw conflict("evaluation_in_progress", "an evaluation is already running for this submission", { active_evaluation: active.rows[0] });
          }
          throw err;
        }
        await queue.enqueue(STAGE_QUEUE, { evaluationId: evalRow.id, stage: "extract" } satisfies StageJobPayload, {
          dedupKey: `${evalRow.id}:extract`, tx,
        });
        await tx.query(
          `UPDATE submissions SET status = 'evaluating', submitted_at = coalesce(submitted_at, now()), updated_at = now() WHERE id = $1`,
          [id],
        );
        await tx.query(
          `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, meta) VALUES ($1, 'evaluation.requested', 'evaluation', $2, $3::jsonb)`,
          [req.user.sub, evalRow.id, JSON.stringify({ submission_id: id })],
        );
        return evalRow;
      });
      return { status: 202, body: { evaluation: await loadEvaluation((evaluation as { id: string }).id) } };
    });
  });

  app.get("/evaluations/:id", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const e = await loadEvaluation(id);
    if (!e) throw notFound("evaluation");
    await ownedSubmission(e.submission_id as string, req.user);
    return e;
  });

  app.get("/evaluations/:id/result", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const e = await loadEvaluation(id);
    if (!e) throw notFound("evaluation");
    await ownedSubmission(e.submission_id as string, req.user);
    if (!READY.includes(e.status as EvaluationStatus)) {
      void reply.status(202);
      return { evaluation_id: id, status: e.status, progress: e.progress, message: "evaluation not finished yet" };
    }
    return loadResult(id, e);
  });

  app.post("/evaluations/:id/review-requests", { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = ReviewRequestBody.parse(req.body);
    const e = await loadEvaluation(id);
    if (!e) throw notFound("evaluation");
    await ownedSubmission(e.submission_id as string, req.user);
    if (e.status === "needs_review") throw conflict("review_open", "a human review is already open for this evaluation");
    if (e.status !== "completed") throw conflict("not_reviewable", `evaluation is ${e.status}; only completed evaluations can be sent for review`);

    const review = await withTransaction(async (tx) => {
      await transition(tx, id, ["completed"], "needs_review", { needs_review_reason: `requested: ${body.reason}` });
      const r = await tx.query(
        `INSERT INTO human_reviews (evaluation_id, requested_by, reason) VALUES ($1, $2, $3) RETURNING *`,
        [id, req.user.sub, body.reason],
      );
      await tx.query(`UPDATE submissions SET status = 'needs_review', updated_at = now() WHERE id = $1`, [e.submission_id]);
      await tx.query(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, meta) VALUES ($1, 'review.requested', 'evaluation', $2, $3::jsonb)`,
        [req.user.sub, id, JSON.stringify({ reason: body.reason })]);
      return r.rows[0];
    });
    void reply.status(201);
    return { review };
  });

  app.post("/evaluations/:id/decision", { preHandler: [app.authenticate, requireRole("evaluator", "admin")] }, async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = DecisionBody.parse(req.body);
    const e = await loadEvaluation(id);
    if (!e) throw notFound("evaluation");
    if (e.status !== "needs_review" && e.status !== "completed") {
      throw conflict("not_decidable", `evaluation is ${e.status}`);
    }

    const out = await withTransaction(async (tx) => {
      // Lock + load scores with their criterion keys.
      const scores = await tx.query<{ criterion_id: string; key: string; weight: string; max_score: number; score: string; confidence: string; flags: string[] }>(
        `SELECT cs.criterion_id, rc.key, cs.weight::text, cs.max_score, cs.score::text, cs.confidence::text, cs.flags
         FROM criterion_scores cs JOIN rubric_criteria rc ON rc.id = cs.criterion_id
         WHERE cs.evaluation_id = $1 FOR UPDATE OF cs`,
        [id],
      );
      const known = new Set(scores.rows.map((s) => s.key));
      for (const k of Object.keys(body.score_overrides)) if (!known.has(k)) throw badRequest(`unknown criterion key in score_overrides: ${k}`);

      const scored: ScoredCriterion[] = scores.rows.map((s) => ({
        key: s.key, weight: Number(s.weight), maxScore: s.max_score, score: Number(s.score), confidence: Number(s.confidence), flags: s.flags ?? [],
      }));
      const adjusted = applyOverrides(scored, body.score_overrides);
      if (Object.keys(body.score_overrides).length) {
        for (const c of adjusted) {
          if (body.score_overrides[c.key] === undefined) continue;
          await tx.query(
            `UPDATE criterion_scores SET score = $3, weighted_score = $4, confidence = 1,
                    flags = (SELECT jsonb_agg(DISTINCT f) FROM jsonb_array_elements(flags || '["human_override"]'::jsonb) f)
             WHERE evaluation_id = $1 AND criterion_id = (SELECT id FROM rubric_criteria WHERE rubric_id = $5 AND key = $2)`,
            [id, c.key, c.score, (c.weight * c.score) / c.maxScore, e.rubric_id],
          );
        }
        const agg = aggregate(adjusted);
        await tx.query(
          `UPDATE evaluation_results SET total_score = $2, max_total = $3, percentage = $4, confidence = $5 WHERE evaluation_id = $1`,
          [id, agg.totalScore, agg.maxTotal, agg.percentage, agg.confidence],
        );
      }

      // Ensure a review row exists (direct approval of a completed evaluation creates one).
      const open = await tx.query<{ id: string }>(`SELECT id FROM human_reviews WHERE evaluation_id = $1 AND status IN ('requested','in_progress') FOR UPDATE`, [id]);
      let reviewId = open.rows[0]?.id;
      if (!reviewId) {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO human_reviews (evaluation_id, requested_by, reason, status) VALUES ($1, $2, 'direct decision by staff', 'in_progress') RETURNING id`,
          [id, req.user.sub],
        );
        reviewId = r.rows[0]!.id;
      }
      const final: EvaluationStatus = body.decision === "approve" ? "approved" : "rejected";
      const review = (await tx.query(
        `UPDATE human_reviews SET status = $2, reviewer_id = $3, decision_comment = $4, score_overrides = $5::jsonb, decided_at = now()
         WHERE id = $1 RETURNING *`,
        [reviewId, final, req.user.sub, body.comment, JSON.stringify(body.score_overrides)],
      )).rows[0];
      await transition(tx, id, ["needs_review", "completed"], final, { completed: true });
      // Approved -> final grade visible. Rejected -> the submission can be re-evaluated; this run stays in history.
      await tx.query(`UPDATE submissions SET status = $2::submission_status, updated_at = now() WHERE id = $1`,
        [e.submission_id, final === "approved" ? "finalized" : "submitted"]);
      const student = await tx.query<{ student_id: string }>(`SELECT student_id FROM submissions WHERE id = $1`, [e.submission_id]);
      if (student.rows[0]) {
        await tx.query(`INSERT INTO notifications (user_id, kind, payload) VALUES ($1, $2, $3::jsonb)`,
          [student.rows[0].student_id, `evaluation.${final}`, JSON.stringify({ evaluation_id: id, comment: body.comment })]);
      }
      await tx.query(`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, meta) VALUES ($1, $2, 'evaluation', $3, $4::jsonb)`,
        [req.user.sub, `evaluation.${final}`, id, JSON.stringify({ overrides: body.score_overrides, comment: body.comment })]);
      return review;
    });

    const refreshed = await loadEvaluation(id);
    return { evaluation: refreshed, review: out, result: await loadResult(id, refreshed!) };
  });

  app.get("/reviews", { preHandler: [app.authenticate, requireRole("evaluator", "admin")] }, async () => {
    const { rows } = await pool.query(
      `SELECT hr.id, hr.evaluation_id, hr.status, hr.reason, hr.requested_at, e.submission_id, s.title, r.percentage, r.confidence, r.flags
       FROM human_reviews hr
       JOIN evaluations e ON e.id = hr.evaluation_id
       JOIN submissions s ON s.id = e.submission_id
       LEFT JOIN evaluation_results r ON r.evaluation_id = e.id
       WHERE hr.status IN ('requested', 'in_progress')
       ORDER BY hr.requested_at`,
    );
    return { reviews: rows };
  });

}

export async function loadEvaluation(id: string) {
  const { rows } = await pool.query(
    `SELECT e.*,
            (SELECT json_agg(json_build_object('stage', a.stage, 'attempt', a.attempt, 'status', a.status, 'worker_id', a.worker_id,
                                               'started_at', a.started_at, 'finished_at', a.finished_at, 'error', a.error,
                                               'llm_calls', a.llm_calls, 'input_tokens', a.input_tokens, 'output_tokens', a.output_tokens)
                             ORDER BY a.started_at)
             FROM evaluation_attempts a WHERE a.evaluation_id = e.id) AS attempts
     FROM evaluations e WHERE e.id = $1`,
    [id],
  );
  const row = rows[0] as (Record<string, unknown> & { submission_id: string; status: string; progress: number; rubric_id: string }) | undefined;
  return row ?? null;
}

async function loadResult(id: string, e: { status: string }) {
  const result = (await pool.query(`SELECT * FROM evaluation_results WHERE evaluation_id = $1`, [id])).rows[0];
  if (!result) throw new AppError(500, "result_missing", "evaluation finished but no result row exists");
  const criteria = (await pool.query(
    `SELECT rc.key, rc.name, rc.position, cs.score::float AS score, cs.max_score, cs.weight::float AS weight, cs.weighted_score::float AS weighted_score,
            cs.confidence::float AS confidence, cs.rationale, cs.evidence, cs.flags
     FROM criterion_scores cs JOIN rubric_criteria rc ON rc.id = cs.criterion_id
     WHERE cs.evaluation_id = $1 ORDER BY rc.position, rc.key`,
    [id],
  )).rows;
  const review = (await pool.query(`SELECT * FROM human_reviews WHERE evaluation_id = $1 ORDER BY requested_at DESC LIMIT 1`, [id])).rows[0] ?? null;
  return { evaluation_id: id, status: e.status, result, criteria, human_review: review };
}
