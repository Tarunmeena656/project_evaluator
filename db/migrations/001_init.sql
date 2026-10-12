-- 001_init.sql
-- Core schema for the AI-powered project evaluation platform.
-- Conventions: uuid primary keys, timestamptz, enums for closed state sets,
-- partial unique indexes to enforce "only one active X" invariants in the DB.

CREATE TYPE user_role AS ENUM ('student', 'evaluator', 'admin');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  role           user_role NOT NULL DEFAULT 'student',
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assignments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id         uuid NOT NULL REFERENCES courses(id),
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  active_rubric_id  uuid,                       -- FK added after rubrics exists
  due_at            timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assignments_course_idx ON assignments(course_id);

-- Rubrics are versioned and immutable once published. An evaluation pins the
-- rubric version it was scored against, so history stays reproducible even
-- after the course team edits the rubric.
CREATE TABLE rubrics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  uuid NOT NULL REFERENCES assignments(id),
  version        int  NOT NULL,
  status         text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  UNIQUE (assignment_id, version)
);

ALTER TABLE assignments
  ADD CONSTRAINT assignments_active_rubric_fk
  FOREIGN KEY (active_rubric_id) REFERENCES rubrics(id);

CREATE TABLE rubric_criteria (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric_id    uuid NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
  key          text NOT NULL,                   -- stable machine key, e.g. "code_quality"
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  guidance     text NOT NULL DEFAULT '',        -- what excellent / adequate / poor looks like
  weight       numeric(5,2) NOT NULL CHECK (weight >= 0 AND weight <= 100),
  max_score    int NOT NULL DEFAULT 10 CHECK (max_score > 0),
  position     int NOT NULL DEFAULT 0,
  UNIQUE (rubric_id, key)
);

CREATE TYPE submission_status AS ENUM (
  'draft', 'submitted', 'evaluating', 'evaluated', 'needs_review', 'finalized', 'failed'
);

CREATE TABLE submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id  uuid NOT NULL REFERENCES assignments(id),
  student_id     uuid NOT NULL REFERENCES users(id),
  status         submission_status NOT NULL DEFAULT 'draft',
  title          text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submissions_student_idx    ON submissions(student_id, created_at DESC);
CREATE INDEX submissions_assignment_idx ON submissions(assignment_id, status);

-- A submission is made of one or more sources (repo URL, uploaded zip, PDF...).
-- Uploaded bytes live in object storage; only the key + checksum live here.
CREATE TABLE submission_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('github', 'zip', 'pdf', 'drive', 'video', 'docs', 'live_url')),
  url            text,
  object_key     text,
  filename       text,
  size_bytes     bigint,
  sha256         text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_sources_submission_idx ON submission_sources(submission_id);

CREATE TYPE evaluation_status AS ENUM (
  'queued', 'extracting', 'understanding', 'evaluating', 'aggregating',
  'needs_review', 'completed', 'approved', 'rejected', 'failed', 'cancelled'
);

-- An evaluation is the job record: one row per evaluation run of a submission.
-- Re-running creates a new evaluation; old ones stay as history.
CREATE TABLE evaluations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id        uuid NOT NULL REFERENCES submissions(id),
  rubric_id            uuid NOT NULL REFERENCES rubrics(id),   -- pinned version
  status               evaluation_status NOT NULL DEFAULT 'queued',
  progress             int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count        int NOT NULL DEFAULT 0,
  max_attempts         int NOT NULL DEFAULT 3,
  requested_by         uuid REFERENCES users(id),
  needs_review_reason  text,
  error_code           text,
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluations_submission_idx ON evaluations(submission_id, created_at DESC);
CREATE INDEX evaluations_status_idx     ON evaluations(status) WHERE status IN ('queued', 'needs_review');

-- Invariant: at most ONE in-flight evaluation per submission. This is what makes
-- "POST /evaluate called five times" safe even if the idempotency layer is bypassed.
CREATE UNIQUE INDEX evaluations_one_active_per_submission
  ON evaluations(submission_id)
  WHERE status IN ('queued', 'extracting', 'understanding', 'evaluating', 'aggregating');

-- Every worker attempt at every stage is recorded: this is the audit trail for
-- retries, crashes and cost, and the basis for "what happened to my evaluation".
CREATE TABLE evaluation_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id  uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  stage          text NOT NULL,                 -- extract | understand | evaluate | aggregate
  attempt        int  NOT NULL,
  worker_id      text NOT NULL,
  status         text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error          text,
  llm_calls      int NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (evaluation_id, stage, attempt)
);

-- Aggregate result: one per evaluation.
CREATE TABLE evaluation_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id   uuid NOT NULL UNIQUE REFERENCES evaluations(id) ON DELETE CASCADE,
  total_score     numeric(7,2) NOT NULL,
  max_total       numeric(7,2) NOT NULL,
  percentage      numeric(5,2) NOT NULL,
  confidence      numeric(4,3) NOT NULL,        -- 0..1, min over criteria
  summary         text NOT NULL,
  strengths       jsonb NOT NULL DEFAULT '[]',
  improvements    jsonb NOT NULL DEFAULT '[]',
  flags           jsonb NOT NULL DEFAULT '[]',  -- e.g. ["prompt_injection_suspected"]
  project_card    jsonb NOT NULL DEFAULT '{}',  -- the project understanding artifact
  model_info      jsonb NOT NULL DEFAULT '{}',  -- provider/model ids used
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Per-criterion score with evidence. UNIQUE(evaluation_id, criterion_id) makes
-- the evaluate stage idempotent: a retried stage upserts, never duplicates.
CREATE TABLE criterion_scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id   uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  criterion_id    uuid NOT NULL REFERENCES rubric_criteria(id),
  score           numeric(6,2) NOT NULL,
  max_score       int NOT NULL,
  weight          numeric(5,2) NOT NULL,
  weighted_score  numeric(8,4) NOT NULL,
  confidence      numeric(4,3) NOT NULL,
  rationale       text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]',  -- [{path, excerpt, note}]
  flags           jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, criterion_id)
);

CREATE TABLE human_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id    uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  requested_by     uuid REFERENCES users(id),
  reviewer_id      uuid REFERENCES users(id),
  status           text NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'in_progress', 'approved', 'rejected')),
  reason           text NOT NULL DEFAULT '',
  decision_comment text,
  score_overrides  jsonb NOT NULL DEFAULT '{}',  -- {criterion_key: newScore}
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);
CREATE INDEX human_reviews_open_idx ON human_reviews(requested_at) WHERE status IN ('requested', 'in_progress');
-- One open review per evaluation.
CREATE UNIQUE INDEX human_reviews_one_open_per_evaluation
  ON human_reviews(evaluation_id) WHERE status IN ('requested', 'in_progress');

-- Idempotency keys for unsafe POSTs. The stored response is replayed on retry.
CREATE TABLE idempotency_keys (
  scope            text NOT NULL,               -- e.g. "evaluations:<userId>"
  key              text NOT NULL,
  request_hash     text NOT NULL,
  response_status  int,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Postgres-backed job queue (local/dev and small deployments). Production uses
-- SQS behind the same JobQueue interface. Semantics mirror SQS: visibility
-- timeout (lease), redelivery, max receive count -> dead letter (status='dead').
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue         text NOT NULL,
  payload       jsonb NOT NULL,
  dedup_key     text UNIQUE,                    -- e.g. "<evaluationId>:extract"
  status        text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'leased', 'done', 'dead')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 3,
  available_at  timestamptz NOT NULL DEFAULT now(),
  leased_until  timestamptz,
  leased_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx  ON jobs(queue, available_at) WHERE status = 'ready';
CREATE INDEX jobs_leased_idx ON jobs(leased_until) WHERE status = 'leased';
CREATE INDEX jobs_dead_idx   ON jobs(updated_at) WHERE status = 'dead';

-- Student-facing notifications (dashboard). Written in the same transaction as
-- the state change they describe (outbox style), delivered by polling the API.
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at DESC);
