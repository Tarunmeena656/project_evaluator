# AI-Powered Project Evaluation Platform

Backend architecture assignment (SDE-II) for AlmaBetter, with a runnable proof of concept.

| What | Where |
|------|-------|
| **Architecture document (the deliverable)** | [docs/architecture.md](docs/architecture.md) |
| Proof of concept: API + worker + LLM evaluation pipeline | this repository |
| Database schema | [db/migrations/001_init.sql](db/migrations/001_init.sql) |
| End-to-end demo | `npm run demo` (see below) |

The PoC exists to make the design concrete. It is deliberately small, but every
piece that the document calls a design decision is real code here: the staged
pipeline with checkpoints, the Postgres queue with leases and dead-lettering,
idempotent evaluation start, the rubric versioning, the state machine guard,
the safe zip extraction, the LLM provider abstraction with structured outputs,
and the human-review routing.

## Stack

Node.js 22, TypeScript, Fastify 5, PostgreSQL 16 (plain SQL, no ORM), Zod,
Anthropic SDK (Claude) behind a provider interface with an offline mock, Docker.

## Run it locally

```bash
npm install
cp .env.example .env            # set DATABASE_URL (defaults to the docker-compose Postgres)
npm run migrate -- --seed       # creates schema + demo users, course, assignment, rubric
npm run dev:api                 # terminal 1  -> http://localhost:4200
npm run dev:worker              # terminal 2
npm run demo                    # terminal 3  -> uploads samples/sample-project and evaluates it
npm run demo -- --inject        # same, with a prompt-injection file -> routed to human review
```

With Docker: `docker compose up --build` starts Postgres, runs migrations and
seed, then the API (port 4200) and one worker.

`LLM_PROVIDER=mock` (default) runs the whole pipeline offline with a
deterministic provider. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`
to score with Claude (`claude-opus-5-5` for rubric scoring, `claude-haiku-5-5`
for per-file summaries).

Demo accounts (password `Demo-pass-123`): `student@demo.test`,
`evaluator@demo.test`, `admin@demo.test`.

## Tests

```bash
npm test          # 31 tests: scoring math, review policy, state machine, zip safety, inventory, Postgres queue
npm run typecheck
```

The queue test is an integration test and runs when `DATABASE_URL` is reachable.

## Layout

```
src/api/            Fastify app: auth (JWT + roles), idempotency, routes
src/worker/         queue consumer: lease -> stage handler -> next stage
src/pipeline/       extract -> understand -> evaluate -> aggregate; prompts; scoring math
src/llm/            provider interface, Anthropic implementation, offline mock, schemas
src/queue/          JobQueue interface + Postgres (SKIP LOCKED) implementation
src/storage/        ObjectStore interface + local disk implementation (S3 in production)
src/domain/         evaluation state machine
db/migrations/      SQL schema
samples/            a small student project used by the demo
tests/              vitest suites
docs/               the architecture document
```

## Key API calls

```
POST /auth/login
GET  /assignments                         GET  /assignments/:id/rubric      PUT /assignments/:id/rubric
POST /submissions                         POST /submissions/:id/sources/:sourceId/upload
GET  /submissions/:id                     GET  /submissions
POST /submissions/:id/evaluations         (Idempotency-Key header)
GET  /evaluations/:id                     GET  /evaluations/:id/result
POST /evaluations/:id/review-requests     POST /evaluations/:id/decision    GET /reviews
GET  /notifications                       GET  /healthz  /readyz            GET /admin/queue
```

Full request/response shapes and validation rules are in the architecture document, section 3.
