import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTransaction } from "../../db/pool.js";
import { validateWeights } from "../../pipeline/aggregate-math.js";
import { requireRole } from "../auth.js";
import { badRequest, notFound } from "../errors.js";

const Params = z.object({ id: z.string().uuid() });

const CriterionInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "key must be snake_case"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  guidance: z.string().max(4000).default(""),
  weight: z.number().min(0).max(100),
  max_score: z.number().int().min(1).max(100).default(10),
});
const RubricBody = z.object({ criteria: z.array(CriterionInput).min(1).max(30) });

export async function assignmentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/assignments", { preHandler: [app.authenticate] }, async () => {
    const { rows } = await pool.query(
      `SELECT a.id, a.title, a.description, a.due_at, a.active_rubric_id, c.code AS course_code, c.title AS course_title
       FROM assignments a JOIN courses c ON c.id = a.course_id ORDER BY a.created_at`,
    );
    return { assignments: rows };
  });

  app.get("/assignments/:id/rubric", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = Params.parse(req.params);
    const rubric = await loadActiveRubric(id);
    if (!rubric) throw notFound("active rubric");
    return rubric;
  });

  app.get("/assignments/:id/rubrics", { preHandler: [app.authenticate, requireRole("evaluator", "admin")] }, async (req) => {
    const { id } = Params.parse(req.params);
    const { rows } = await pool.query(
      `SELECT r.id, r.version, r.status, r.created_at, r.published_at,
              (SELECT count(*) FROM evaluations e WHERE e.rubric_id = r.id)::int AS evaluations_using
       FROM rubrics r WHERE r.assignment_id = $1 ORDER BY r.version DESC`,
      [id],
    );
    return { rubrics: rows };
  });

  /**
   * Replace the rubric: creates a NEW published version and archives the old
   * one. Evaluations already running keep the version they pinned.
   */
  app.put("/assignments/:id/rubric", { preHandler: [app.authenticate, requireRole("evaluator", "admin")] }, async (req, reply) => {
    const { id } = Params.parse(req.params);
    const body = RubricBody.parse(req.body);
    const weightError = validateWeights(body.criteria.map((c) => c.weight));
    if (weightError) throw badRequest(weightError);
    const keys = new Set(body.criteria.map((c) => c.key));
    if (keys.size !== body.criteria.length) throw badRequest("criterion keys must be unique");

    const rubricId = await withTransaction(async (tx) => {
      const a = await tx.query(`SELECT id, active_rubric_id FROM assignments WHERE id = $1 FOR UPDATE`, [id]);
      if (!a.rows[0]) throw notFound("assignment");
      const v = await tx.query<{ next: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS next FROM rubrics WHERE assignment_id = $1`,
        [id],
      );
      const r = await tx.query<{ id: string }>(
        `INSERT INTO rubrics (assignment_id, version, status, created_by, published_at)
         VALUES ($1, $2, 'published', $3, now()) RETURNING id`,
        [id, v.rows[0]!.next, req.user.sub],
      );
      const newId = r.rows[0]!.id;
      for (const [i, c] of body.criteria.entries()) {
        await tx.query(
          `INSERT INTO rubric_criteria (rubric_id, key, name, description, guidance, weight, max_score, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId, c.key, c.name, c.description, c.guidance, c.weight, c.max_score, i],
        );
      }
      await tx.query(`UPDATE rubrics SET status = 'archived' WHERE assignment_id = $1 AND status = 'published' AND id <> $2`, [id, newId]);
      await tx.query(`UPDATE assignments SET active_rubric_id = $2 WHERE id = $1`, [id, newId]);
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, meta) VALUES ($1, 'rubric.published', 'rubric', $2, $3::jsonb)`,
        [req.user.sub, newId, JSON.stringify({ assignment_id: id, version: v.rows[0]!.next })],
      );
      return newId;
    });
    void reply.status(201);
    return loadRubric(rubricId);
  });
}

export async function loadActiveRubric(assignmentId: string) {
  const { rows } = await pool.query<{ active_rubric_id: string | null }>(`SELECT active_rubric_id FROM assignments WHERE id = $1`, [assignmentId]);
  const id = rows[0]?.active_rubric_id;
  return id ? loadRubric(id) : null;
}

export async function loadRubric(rubricId: string) {
  const r = await pool.query(`SELECT id, assignment_id, version, status, created_at, published_at FROM rubrics WHERE id = $1`, [rubricId]);
  if (!r.rows[0]) return null;
  const c = await pool.query(
    `SELECT id, key, name, description, guidance, weight::float AS weight, max_score, position
     FROM rubric_criteria WHERE rubric_id = $1 ORDER BY position, key`,
    [rubricId],
  );
  return { ...r.rows[0], criteria: c.rows };
}
