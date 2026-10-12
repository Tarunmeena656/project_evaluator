import path from "node:path";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { LIMITS } from "../config.js";
import { withTransaction } from "../db/pool.js";
import { transition } from "../domain/evaluation-state.js";
import type { Stage } from "../domain/evaluation-state.js";
import { LlmError } from "../llm/provider.js";
import {
  CriterionEvaluationSchema,
  FileSummarySchema,
  FinalSummarySchema,
  ProjectCardSchema,
  type CriterionEvaluation,
  type FileSummary,
  type ProjectCard,
} from "../llm/schemas.js";
import { aggregate, clamp, decideReview, type ScoredCriterion } from "./aggregate-math.js";
import { artifactKey, type SourceRow, type StageContext } from "./context.js";
import { extractSubmission, type ExtractManifest } from "./extract.js";
import { buildInventory, extractSymbols, readExcerpt, type Inventory } from "./inventory.js";
import * as P from "./prompts.js";

export type StageHandler = (ctx: StageContext) => Promise<void>;

export const STAGE_HANDLERS: Record<Stage, StageHandler> = {
  extract: extractStage,
  understand: understandStage,
  evaluate: evaluateStage,
  aggregate: aggregateStage,
};

interface CriterionRow {
  id: string;
  key: string;
  name: string;
  description: string;
  guidance: string;
  weight: string;
  max_score: number;
  position: number;
}

const projectDir = (ctx: StageContext) => path.join(ctx.workDir, "project");

// ---------------------------------------------------------------------------
// Stage 1: extract - materialise sources on disk, write manifest
// ---------------------------------------------------------------------------
async function extractStage(ctx: StageContext): Promise<void> {
  const { rows: sources } = await ctx.db.query<SourceRow>(
    `SELECT id, kind, url, object_key, filename, size_bytes::text, status
     FROM submission_sources WHERE submission_id = $1 ORDER BY created_at`,
    [ctx.evaluation.submission_id],
  );
  if (sources.length === 0) throw new StageError("submission has no sources", "no_sources", false);
  const manifest = await extractSubmission(ctx.store, sources, projectDir(ctx));
  await ctx.store.putText(artifactKey.extractManifest(ctx.evaluation.id), JSON.stringify(manifest, null, 2));
  ctx.log.info({ evaluationId: ctx.evaluation.id, files: manifest.fileCount, bytes: manifest.totalBytes }, "extracted");
}

// ---------------------------------------------------------------------------
// Stage 2: understand - inventory, per-file summaries (map), project card (reduce)
// ---------------------------------------------------------------------------
async function understandStage(ctx: StageContext): Promise<void> {
  const root = await ensureProjectOnDisk(ctx);
  const inventory = await buildInventory(root);
  await ctx.store.putText(artifactKey.inventory(ctx.evaluation.id), JSON.stringify(inventory, null, 2));

  // Checkpoint: if a previous attempt already produced summaries, reuse them.
  let summaries: FileSummary[];
  if (await ctx.store.exists(artifactKey.summaries(ctx.evaluation.id))) {
    summaries = JSON.parse(await ctx.store.getText(artifactKey.summaries(ctx.evaluation.id))) as FileSummary[];
    ctx.log.info({ evaluationId: ctx.evaluation.id }, "reusing file summaries from previous attempt");
  } else {
    const candidates = inventory.files
      .filter((f) => !f.skipReason && ["code", "test", "docs", "schema", "config"].includes(f.kind))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, LIMITS.maxFilesSummarised);

    summaries = await mapLimit(candidates, 4, async (f) => {
      const content = await readExcerpt(root, f.path);
      const res = await ctx.llm.completeStructured({
        task: "summarize_file",
        tier: "summarizer",
        system: P.SUMMARIZER_SYSTEM,
        user: P.fileSummaryUser({ path: f.path, kind: f.kind, lines: f.lines, content }),
        schema: FileSummarySchema,
        maxTokens: 1500,
        context: {
          path: f.path, kind: f.kind, lines: f.lines ?? 0, symbols: extractSymbols(content),
          hasSecretPattern: inventory.signals.secretPaths.includes(f.path),
        },
      });
      await ctx.heartbeat();
      return { ...res.data, path: f.path }; // path is authoritative from the inventory, not the model
    });
    await ctx.store.putText(artifactKey.summaries(ctx.evaluation.id), JSON.stringify(summaries, null, 2));
  }

  // Raw excerpts of the top files are kept for the evaluator stage (bounded).
  const topForExcerpts = inventory.files
    .filter((f) => !f.skipReason && ["code", "test", "schema", "docs"].includes(f.kind))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12);
  const excerpts = await Promise.all(
    topForExcerpts.map(async (f) => ({ path: f.path, content: await readExcerpt(root, f.path, 4000) })),
  );
  await ctx.store.putText(artifactKey.excerpts(ctx.evaluation.id), JSON.stringify(excerpts));

  const readme = inventory.files.find((f) => /^readme(\.|$)/i.test(path.posix.basename(f.path)) && !f.path.includes("/"));
  const readmeExcerpt = readme ? await readExcerpt(root, readme.path, 8000) : "";
  const summariesJson = truncate(JSON.stringify(summaries), LIMITS.maxProjectContextChars);

  const card = await ctx.llm.completeStructured({
    task: "project_card",
    tier: "evaluator",
    system: P.PROJECT_CARD_SYSTEM,
    user: P.projectCardUser({ inventoryBrief: inventoryBrief(inventory), readmeExcerpt, summariesJson }),
    schema: ProjectCardSchema,
    maxTokens: 3000,
    context: {
      name: projectNameFrom(inventory),
      readmeFirstLine: inventory.signals.readmeFirstLine,
      languages: Object.keys(inventory.languages).sort((a, b) => inventory.languages[b]! - inventory.languages[a]!),
      fileCount: inventory.signals.fileCount, dirCount: inventory.dirCount, entryPoints: inventory.signals.entryPoints,
      routeFiles: inventory.signals.routeFiles, hasSchema: inventory.signals.hasSchema, hasTests: inventory.signals.hasTests,
      testFileCount: inventory.signals.testFileCount, hasReadme: inventory.signals.hasReadme, readmeChars: inventory.signals.readmeChars,
      hasSecretPattern: inventory.signals.hasSecretPattern, mentionsAi: inventory.signals.mentionsAi,
    },
  });
  await ctx.store.putText(artifactKey.projectCard(ctx.evaluation.id), JSON.stringify(card.data, null, 2));
  ctx.log.info({ evaluationId: ctx.evaluation.id, summarised: summaries.length, llmCalls: ctx.llm.callCount }, "understood");
}

// ---------------------------------------------------------------------------
// Stage 3: evaluate - one structured LLM call per rubric criterion, checkpointed per criterion
// ---------------------------------------------------------------------------
async function evaluateStage(ctx: StageContext): Promise<void> {
  const criteria = await loadCriteria(ctx);
  const inventory = JSON.parse(await ctx.store.getText(artifactKey.inventory(ctx.evaluation.id))) as Inventory;
  const summaries = JSON.parse(await ctx.store.getText(artifactKey.summaries(ctx.evaluation.id))) as FileSummary[];
  const card = JSON.parse(await ctx.store.getText(artifactKey.projectCard(ctx.evaluation.id))) as ProjectCard;
  const excerpts = JSON.parse(await ctx.store.getText(artifactKey.excerpts(ctx.evaluation.id))) as Array<{ path: string; content: string }>;

  const { rows: done } = await ctx.db.query<{ criterion_id: string }>(
    `SELECT criterion_id FROM criterion_scores WHERE evaluation_id = $1`,
    [ctx.evaluation.id],
  );
  const doneIds = new Set(done.map((r) => r.criterion_id));
  const signalsJson = JSON.stringify(publicSignals(inventory), null, 1);
  const projectCardJson = JSON.stringify(card, null, 1);

  for (const c of criteria) {
    if (doneIds.has(c.id)) {
      ctx.log.info({ evaluationId: ctx.evaluation.id, criterion: c.key }, "criterion already scored (resume)");
      continue;
    }
    const relevant = rankEvidence(c, summaries, 10);
    const relevantPaths = new Set(relevant.map((s) => s.path));
    const relevantExcerpts = excerpts.filter((e) => relevantPaths.has(e.path)).slice(0, 4);

    let result: CriterionEvaluation;
    const extraFlags: string[] = [];
    try {
      const res = await ctx.llm.completeStructured({
        task: "evaluate_criterion",
        tier: "evaluator",
        system: P.CRITERION_SYSTEM,
        user: P.criterionUser({
          criterion: { ...c, weight: Number(c.weight) },
          projectCardJson,
          signalsJson,
          evidenceSummariesJson: truncate(JSON.stringify(relevant), 30_000),
          excerpts: relevantExcerpts,
        }),
        schema: CriterionEvaluationSchema,
        maxTokens: 3000,
        context: {
          criterionKey: c.key, maxScore: c.max_score, projectName: card.name,
          signals: publicSignals(inventory), topFiles: relevant.map((s) => s.path),
        },
      });
      result = res.data;
    } catch (err) {
      if (err instanceof LlmError && err.kind === "refusal") {
        // Do not fail the evaluation: record a zero-confidence placeholder and force human review.
        result = { score: 0, confidence: 0, rationale: "The model declined to evaluate this criterion; a human reviewer will score it.", evidence: [], flags: ["llm_refusal"] };
      } else {
        throw err;
      }
    }

    // Deterministic rules layered on top of the model's judgement.
    if (inventory.signals.hasSecretPattern && /code|quality|security/i.test(c.key + c.name)) extraFlags.push("secrets_committed");
    if (inventory.signals.promptInjectionSuspected) {
      extraFlags.push("prompt_injection_suspected");
      result.confidence = Math.min(result.confidence, 0.5);
    }
    const score = clamp(result.score, 0, c.max_score);
    const confidence = clamp(result.confidence, 0, 1);
    const flags = [...new Set([...result.flags, ...extraFlags])];
    const weighted = (Number(c.weight) * score) / c.max_score;

    await ctx.db.query(
      `INSERT INTO criterion_scores (evaluation_id, criterion_id, score, max_score, weight, weighted_score, confidence, rationale, evidence, flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       ON CONFLICT (evaluation_id, criterion_id) DO UPDATE
         SET score = EXCLUDED.score, weighted_score = EXCLUDED.weighted_score, confidence = EXCLUDED.confidence,
             rationale = EXCLUDED.rationale, evidence = EXCLUDED.evidence, flags = EXCLUDED.flags`,
      [ctx.evaluation.id, c.id, score, c.max_score, c.weight, weighted, confidence, result.rationale,
        JSON.stringify(result.evidence.slice(0, 8)), JSON.stringify(flags)],
    );
    await ctx.heartbeat();
    ctx.log.info({ evaluationId: ctx.evaluation.id, criterion: c.key, score, confidence }, "criterion scored");
  }
}

// ---------------------------------------------------------------------------
// Stage 4: aggregate - weighted total, review routing, final summary, notify
// ---------------------------------------------------------------------------
async function aggregateStage(ctx: StageContext): Promise<void> {
  const criteria = await loadCriteria(ctx);
  const { rows: scores } = await ctx.db.query<{
    criterion_id: string; score: string; confidence: string; flags: string[]; rationale: string; evidence: unknown;
  }>(`SELECT criterion_id, score::text, confidence::text, flags, rationale, evidence FROM criterion_scores WHERE evaluation_id = $1`, [ctx.evaluation.id]);
  const byId = new Map(scores.map((s) => [s.criterion_id, s]));
  const missing = criteria.filter((c) => !byId.has(c.id));
  if (missing.length) throw new StageError(`criteria not scored: ${missing.map((m) => m.key).join(", ")}`, "incomplete_scores", true);

  const scored: ScoredCriterion[] = criteria.map((c) => {
    const s = byId.get(c.id)!;
    return { key: c.key, weight: Number(c.weight), maxScore: c.max_score, score: Number(s.score), confidence: Number(s.confidence), flags: s.flags ?? [] };
  });
  const agg = aggregate(scored);
  const card = JSON.parse(await ctx.store.getText(artifactKey.projectCard(ctx.evaluation.id))) as ProjectCard;
  const review = decideReview(agg, scored);

  const criteriaJson = JSON.stringify(
    criteria.map((c) => {
      const s = byId.get(c.id)!;
      return { key: c.key, name: c.name, score: Number(s.score), max_score: c.max_score, weight: Number(c.weight), rationale: s.rationale, flags: s.flags };
    }),
  );
  const strengths = card.notable_strengths ?? [];
  const improvements = card.notable_risks ?? [];
  const summary = await ctx.llm.completeStructured({
    task: "final_summary",
    tier: "evaluator",
    system: P.FINAL_SUMMARY_SYSTEM,
    user: P.finalSummaryUser({ projectName: card.name, percentage: agg.percentage, criteriaJson }),
    schema: FinalSummarySchema,
    maxTokens: 2000,
    context: { percentage: agg.percentage, criteriaCount: criteria.length, strengths, improvements },
  });

  const allFlags = [...new Set(scored.flatMap((s) => s.flags))];
  const modelInfo = { provider: ctx.llm.name, prompt_version: P.PROMPT_VERSION, llm_calls: ctx.llm.callCount, usage: ctx.llm.usage };

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO evaluation_results (evaluation_id, total_score, max_total, percentage, confidence, summary, strengths, improvements, flags, project_card, model_info)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
       ON CONFLICT (evaluation_id) DO UPDATE SET
         total_score = EXCLUDED.total_score, max_total = EXCLUDED.max_total, percentage = EXCLUDED.percentage,
         confidence = EXCLUDED.confidence, summary = EXCLUDED.summary, strengths = EXCLUDED.strengths,
         improvements = EXCLUDED.improvements, flags = EXCLUDED.flags, project_card = EXCLUDED.project_card, model_info = EXCLUDED.model_info`,
      [ctx.evaluation.id, agg.totalScore, agg.maxTotal, agg.percentage, agg.confidence, summary.data.summary,
        JSON.stringify(summary.data.strengths), JSON.stringify(summary.data.improvements), JSON.stringify(allFlags),
        JSON.stringify(card), JSON.stringify(modelInfo)],
    );

    const nextStatus = review.needsReview ? "needs_review" : "completed";
    await transition(tx, ctx.evaluation.id, ["aggregating"], nextStatus, {
      progress: 100, completed: true, needs_review_reason: review.needsReview ? review.reasons.join("; ") : null,
    });
    if (review.needsReview) {
      await tx.query(
        `INSERT INTO human_reviews (evaluation_id, requested_by, reason) VALUES ($1, NULL, $2)
         ON CONFLICT DO NOTHING`,
        [ctx.evaluation.id, `auto: ${review.reasons.join("; ")}`],
      );
    }
    const { rows: sub } = await tx.query<{ student_id: string }>(
      `UPDATE submissions SET status = $2::submission_status, updated_at = now() WHERE id = $1 RETURNING student_id`,
      [ctx.evaluation.submission_id, review.needsReview ? "needs_review" : "evaluated"],
    );
    if (sub[0]) {
      await tx.query(
        `INSERT INTO notifications (user_id, kind, payload) VALUES ($1, $2, $3::jsonb)`,
        [sub[0].student_id, review.needsReview ? "evaluation.needs_review" : "evaluation.completed",
          JSON.stringify({ evaluation_id: ctx.evaluation.id, submission_id: ctx.evaluation.submission_id, percentage: agg.percentage })],
      );
    }
    await tx.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, meta) VALUES (NULL, 'evaluation.finished', 'evaluation', $1, $2::jsonb)`,
      [ctx.evaluation.id, JSON.stringify({ status: nextStatus, percentage: agg.percentage, reasons: review.reasons })],
    );
  });

  await rm(ctx.workDir, { recursive: true, force: true }).catch(() => undefined);
  ctx.log.info({ evaluationId: ctx.evaluation.id, percentage: agg.percentage, needsReview: review.needsReview, reasons: review.reasons }, "aggregated");
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export class StageError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean) {
    super(message);
    this.name = "StageError";
  }
}

async function loadCriteria(ctx: StageContext): Promise<CriterionRow[]> {
  const { rows } = await ctx.db.query<CriterionRow>(
    `SELECT id, key, name, description, guidance, weight::text, max_score, position
     FROM rubric_criteria WHERE rubric_id = $1 ORDER BY position, key`,
    [ctx.evaluation.rubric_id],
  );
  if (rows.length === 0) throw new StageError("rubric has no criteria", "empty_rubric", false);
  return rows;
}

/**
 * If this worker does not have the project on disk (previous stage ran on
 * another worker, or the worker restarted), re-run extraction. Extraction is
 * deterministic, so this is safe and keeps workers stateless.
 */
async function ensureProjectOnDisk(ctx: StageContext): Promise<string> {
  const root = projectDir(ctx);
  const { stat } = await import("node:fs/promises");
  const present = await stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (present) return root;
  ctx.log.info({ evaluationId: ctx.evaluation.id }, "project not on local disk; re-extracting");
  const { rows: sources } = await ctx.db.query<SourceRow>(
    `SELECT id, kind, url, object_key, filename, size_bytes::text, status FROM submission_sources WHERE submission_id = $1 ORDER BY created_at`,
    [ctx.evaluation.submission_id],
  );
  const manifest: ExtractManifest = await extractSubmission(ctx.store, sources, root);
  await ctx.store.putText(artifactKey.extractManifest(ctx.evaluation.id), JSON.stringify(manifest, null, 2));
  return root;
}

function inventoryBrief(inv: Inventory): string {
  const langs = Object.entries(inv.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n} lines)`).join(", ");
  const s = inv.signals;
  return [
    `${s.fileCount} files in ${inv.dirCount} directories, ${inv.totalBytes} bytes, ${s.totalLines} text lines`,
    `languages: ${langs || "none detected"}`,
    `code files: ${s.codeFileCount}, test files: ${s.testFileCount}, README: ${s.hasReadme}, CI: ${s.hasCi}, Docker: ${s.hasDocker}, schema files: ${s.hasSchema}`,
    `entry points: ${s.entryPoints.slice(0, 8).join(", ") || "none detected"}`,
    `route/controller files: ${s.routeFiles.slice(0, 8).join(", ") || "none detected"}`,
    `secrets pattern detected: ${s.hasSecretPattern}${s.secretPaths.length ? ` (${s.secretPaths.slice(0, 3).join(", ")})` : ""}`,
    `mentions AI/LLM libraries: ${s.mentionsAi}`,
  ].join("\n");
}

/** Signals shared with the model and the mock (no raw paths that could leak unrelated info). */
function publicSignals(inv: Inventory) {
  const s = inv.signals;
  return {
    fileCount: s.fileCount, codeFileCount: s.codeFileCount, testFileCount: s.testFileCount, totalLines: s.totalLines,
    hasTests: s.hasTests, hasReadme: s.hasReadme, readmeChars: s.readmeChars, hasCi: s.hasCi, hasDocker: s.hasDocker,
    hasSchema: s.hasSchema, hasSecretPattern: s.hasSecretPattern, mentionsAi: s.mentionsAi,
    promptInjectionSuspected: s.promptInjectionSuspected, languages: inv.languages,
  };
}

/** Lexical evidence retrieval (PoC). Production replaces this with pgvector similarity over summaries. */
function rankEvidence(c: CriterionRow, summaries: FileSummary[], limit: number): FileSummary[] {
  const KIND_HINTS: Record<string, RegExp> = {
    functionality: /test|spec|route|controller|handler|service|main|index|app/i,
    code_quality: /src|lib|service|util|helper|component/i,
    architecture: /schema|model|migration|config|docker|index|app|server|module|layer/i,
    documentation: /readme|docs?|contributing|changelog|\.md$/i,
    problem_solving: /algorithm|service|core|logic|engine|solver|util/i,
    innovation: /ai|llm|prompt|agent|embedding|model|openai|anthropic|rag/i,
  };
  const hintKey = Object.keys(KIND_HINTS).find((k) => c.key.includes(k) || k.includes(c.key.split("_")[0] ?? "")) ?? "";
  const hint = KIND_HINTS[hintKey];
  const terms = new Set(
    `${c.name} ${c.description} ${c.guidance}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3),
  );
  const scoreOf = (s: FileSummary) => {
    const text = `${s.path} ${s.purpose} ${s.key_elements.join(" ")} ${s.quality_notes.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (text.includes(t)) score += 1;
    if (hint && hint.test(s.path)) score += 3;
    if (s.red_flags.length) score += 1;
    return score;
  };
  return [...summaries].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, limit);
}

function projectNameFrom(inv: Inventory): string {
  if (inv.files.some((f) => f.path === "package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(inv.root, "package.json"), "utf8")) as { name?: string };
      if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
    } catch {
      /* fall through */
    }
  }
  const readme = inv.signals.readmeFirstLine;
  return readme ? readme.split(/[.:!]/)[0]!.slice(0, 60) : "student project";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} ...[truncated ${s.length - max} chars]`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
