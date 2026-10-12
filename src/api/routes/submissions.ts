import type { FastifyInstance } from "fastify";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "../../config.js";
import { pool, withTransaction } from "../../db/pool.js";
import { validateGitHubUrl } from "../../pipeline/extract.js";
import { LocalObjectStore, ObjectTooLargeError } from "../../storage/object-store.js";
import { isStaff, type AuthUser } from "../auth.js";
import { AppError, badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertPublicHttpUrl } from "../url-safety.js";

const SourceInput = z.object({
  kind: z.enum(["github", "zip", "pdf", "drive", "video", "docs", "live_url"]),
  url: z.string().max(2000).optional(),
  filename: z.string().max(255).optional(),
});
const CreateBody = z.object({
  assignment_id: z.string().uuid(),
  title: z.string().min(1).max(200),
  notes: z.string().max(5000).default(""),
  sources: z.array(SourceInput).min(1).max(10),
});
const IdParams = z.object({ id: z.string().uuid() });
const UploadParams = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() });
const ListQuery = z.object({
  assignment_id: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const UPLOAD_KINDS = new Set(["zip", "pdf", "docs"]);
const URL_KINDS = new Set(["github", "drive", "video", "live_url"]);

export async function submissionRoutes(app: FastifyInstance): Promise<void> {
  const store = new LocalObjectStore(config.STORAGE_DIR);

  app.post("/submissions", { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = CreateBody.parse(req.body);

    // Validate each source up front so the student gets one clear error list.
    const normalised = body.sources.map((s, i) => {
      if (UPLOAD_KINDS.has(s.kind)) {
        if (s.url) throw badRequest(`sources[${i}]: ${s.kind} sources are uploaded, not linked`);
        return { ...s, url: null, status: "pending" as const };
      }
      if (!s.url) throw badRequest(`sources[${i}]: ${s.kind} requires a url`);
      try {
        if (s.kind === "github") return { ...s, url: validateGitHubUrl(s.url), status: "stored" as const };
        return { ...s, url: assertPublicHttpUrl(s.url).toString(), status: "stored" as const };
      } catch (err) {
        throw badRequest(`sources[${i}]: ${(err as Error).message}`);
      }
    });

    const a = await pool.query(`SELECT id, active_rubric_id FROM assignments WHERE id = $1`, [body.assignment_id]);
    if (!a.rows[0]) throw notFound("assignment");

    const result = await withTransaction(async (tx) => {
      const s = await tx.query<{ id: string }>(
        `INSERT INTO submissions (assignment_id, student_id, title, notes, status) VALUES ($1, $2, $3, $4, 'draft') RETURNING id`,
        [body.assignment_id, req.user.sub, body.title, body.notes],
      );
      const submissionId = s.rows[0]!.id;
      const sources: Array<Record<string, unknown>> = [];
      for (const src of normalised) {
        const r = await tx.query(
          `INSERT INTO submission_sources (submission_id, kind, url, filename, status) VALUES ($1, $2, $3, $4, $5)
           RETURNING id, kind, url, filename, status`,
          [submissionId, src.kind, src.url, src.filename ?? null, src.status],
        );
        sources.push(r.rows[0] as Record<string, unknown>);
      }
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES ($1, 'submission.created', 'submission', $2)`,
        [req.user.sub, submissionId],
      );
      return { submissionId, sources };
    });

    void reply.status(201);
    return {
      submission: await loadSubmission(result.submissionId),
      // Production: these would be presigned S3 multipart URLs; the API never proxies large files.
      uploads: result.sources
        .filter((s) => UPLOAD_KINDS.has(String(s.kind)))
        .map((s) => ({ source_id: s.id, method: "POST", url: `/submissions/${result.submissionId}/sources/${s.id}/upload`, field: "file" })),
    };
  });

  app.post("/submissions/:id/sources/:sourceId/upload", { preHandler: [app.authenticate] }, async (req) => {
    const { id, sourceId } = UploadParams.parse(req.params);
    const sub = await ownedSubmission(id, req.user);
    if (sub.status !== "draft") throw conflict("not_editable", `submission is ${sub.status}; uploads are only accepted while draft`);
    const src = (await pool.query(`SELECT id, kind, status FROM submission_sources WHERE id = $1 AND submission_id = $2`, [sourceId, id])).rows[0] as
      | { id: string; kind: string; status: string }
      | undefined;
    if (!src) throw notFound("source");
    if (!UPLOAD_KINDS.has(src.kind)) throw badRequest(`${src.kind} sources are not uploaded`);

    const part = await req.file();
    if (!part) throw badRequest("multipart field 'file' is required");
    const safeName = path.basename(part.filename || `${src.kind}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || src.kind;
    const key = `submissions/${id}/${sourceId}/${safeName}`;

    let put;
    try {
      put = await store.putStream(key, part.file, config.MAX_UPLOAD_BYTES);
    } catch (err) {
      if (err instanceof ObjectTooLargeError) throw new AppError(413, "payload_too_large", `file exceeds ${config.MAX_UPLOAD_BYTES} bytes`);
      throw err;
    }
    if (part.file.truncated) throw new AppError(413, "payload_too_large", `file exceeds ${config.MAX_UPLOAD_BYTES} bytes`);

    // Content sniffing: the declared kind must match the magic bytes.
    const magic = await readMagic(path.resolve(config.STORAGE_DIR, key));
    const ok = src.kind === "zip" ? magic.startsWith("504b0304") || magic.startsWith("504b0506") : src.kind === "pdf" ? magic.startsWith("25504446") : true;
    if (!ok) {
      await unlink(path.resolve(config.STORAGE_DIR, key)).catch(() => undefined);
      throw badRequest(`uploaded file is not a valid ${src.kind}`);
    }

    const { rows } = await pool.query(
      `UPDATE submission_sources SET object_key = $3, filename = $4, size_bytes = $5, sha256 = $6, status = 'stored'
       WHERE id = $1 AND submission_id = $2 RETURNING id, kind, filename, size_bytes::text, sha256, status`,
      [sourceId, id, key, safeName, put.sizeBytes, put.sha256],
    );
    return { source: rows[0] };
  });

  app.get("/submissions", { preHandler: [app.authenticate] }, async (req) => {
    const q = ListQuery.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    if (!isStaff(req.user)) {
      params.push(req.user.sub);
      where.push(`s.student_id = $${params.length}`);
    }
    if (q.assignment_id) {
      params.push(q.assignment_id);
      where.push(`s.assignment_id = $${params.length}`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`s.status = $${params.length}::submission_status`);
    }
    params.push(q.limit);
    const { rows } = await pool.query(
      `SELECT s.id, s.assignment_id, s.student_id, s.status, s.title, s.submitted_at, s.created_at,
              (SELECT e.id FROM evaluations e WHERE e.submission_id = s.id ORDER BY e.created_at DESC LIMIT 1) AS latest_evaluation_id
       FROM submissions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY s.created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { submissions: rows };
  });

  app.get("/submissions/:id", { preHandler: [app.authenticate] }, async (req) => {
    const { id } = IdParams.parse(req.params);
    await ownedSubmission(id, req.user);
    return loadSubmission(id);
  });
}

export async function ownedSubmission(id: string, user: AuthUser) {
  const { rows } = await pool.query<{ id: string; student_id: string; status: string; assignment_id: string }>(
    `SELECT id, student_id, status, assignment_id FROM submissions WHERE id = $1`,
    [id],
  );
  const sub = rows[0];
  if (!sub) throw notFound("submission");
  if (sub.student_id !== user.sub && !isStaff(user)) throw forbidden();
  return sub;
}

export async function loadSubmission(id: string) {
  const s = await pool.query(
    `SELECT id, assignment_id, student_id, status, title, notes, submitted_at, created_at, updated_at FROM submissions WHERE id = $1`,
    [id],
  );
  const sources = await pool.query(
    `SELECT id, kind, url, filename, size_bytes::text, sha256, status, created_at FROM submission_sources WHERE submission_id = $1 ORDER BY created_at`,
    [id],
  );
  const evaluations = await pool.query(
    `SELECT id, status, progress, rubric_id, created_at, completed_at FROM evaluations WHERE submission_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  return { ...s.rows[0], sources: sources.rows, evaluations: evaluations.rows };
}

async function readMagic(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return buf.subarray(0, bytesRead).toString("hex");
  } finally {
    await fh.close();
  }
}
