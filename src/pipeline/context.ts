import type pg from "pg";
import type { Logger } from "../logger.js";
import type { BudgetedLlm } from "../llm/provider.js";
import type { JobQueue } from "../queue/types.js";
import type { ObjectStore } from "../storage/object-store.js";
import type { EvaluationStatus } from "../domain/evaluation-state.js";

export interface EvaluationRow {
  id: string;
  submission_id: string;
  rubric_id: string;
  status: EvaluationStatus;
  progress: number;
  attempt_count: number;
  max_attempts: number;
  requested_by: string | null;
  created_at: Date;
}

export interface SourceRow {
  id: string;
  kind: "github" | "zip" | "pdf" | "drive" | "video" | "docs" | "live_url";
  url: string | null;
  object_key: string | null;
  filename: string | null;
  size_bytes: string | null;
  status: string;
}

export interface StageContext {
  db: pg.Pool;
  queue: JobQueue;
  store: ObjectStore;
  llm: BudgetedLlm;
  log: Logger;
  evaluation: EvaluationRow;
  /** Scratch directory for this evaluation on the worker's disk. */
  workDir: string;
  /** Extend the job lease; call from long loops (SQS ChangeMessageVisibility). */
  heartbeat: () => Promise<void>;
}

/** Object-store keys for evaluation artifacts (checkpoints between stages). */
export const artifactKey = {
  inventory: (evaluationId: string) => `evaluations/${evaluationId}/inventory.json`,
  summaries: (evaluationId: string) => `evaluations/${evaluationId}/summaries.json`,
  projectCard: (evaluationId: string) => `evaluations/${evaluationId}/project_card.json`,
  excerpts: (evaluationId: string) => `evaluations/${evaluationId}/excerpts.json`,
  extractManifest: (evaluationId: string) => `evaluations/${evaluationId}/extract.json`,
};
