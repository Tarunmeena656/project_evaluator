import { z } from "zod";

// Load .env if present (Node >= 20.12 built-in; no dotenv dependency needed).
try {
  process.loadEnvFile();
} catch {
  /* no .env file - rely on real environment variables */
}

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4200),
  JWT_SECRET: z.string().min(16).default("dev-only-secret-change-me-please-32b"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 ** 3),
  STORAGE_DIR: z.string().default("./data/objects"),
  WORK_DIR: z.string().default("./data/work"),
  LLM_PROVIDER: z.enum(["mock", "anthropic"]).default("mock"),
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_MODEL_EVALUATOR: z.string().default("claude-opus-5-5"),
  LLM_MODEL_SUMMARIZER: z.string().default("claude-haiku-5-5"),
  LLM_MAX_CALLS_PER_EVALUATION: z.coerce.number().int().positive().default(80),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(600),
  LOG_LEVEL: z.string().default("info"),
  NODE_ENV: z.string().default("development"),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);

/** Extraction limits - the first line of defence against zip bombs and huge repos. */
export const LIMITS = {
  maxArchiveEntries: 20_000,
  maxExtractedBytes: 2 * 1024 ** 3, // 2 GiB on disk
  maxCompressionRatio: 100, // uncompressed / compressed, per entry
  maxSingleFileBytes: 50 * 1024 ** 2, // 50 MiB
  maxAnalysedFileBytes: 512 * 1024, // files larger than this are inventoried, not read
  maxFilesSummarised: 40, // LLM budget: files that get an individual summary
  maxCharsPerFileForLlm: 24_000, // ~6k tokens
  maxProjectContextChars: 60_000, // ~15k tokens of summaries fed to the evaluator
  gitCloneTimeoutMs: 5 * 60_000,
} as const;
