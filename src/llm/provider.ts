import type { z } from "zod";

export type LlmTier = "evaluator" | "summarizer";

/** Tags let the offline mock produce sensible output without parsing prose. */
export type LlmTask = "summarize_file" | "project_card" | "evaluate_criterion" | "final_summary";

export interface StructuredRequest<T> {
  task: LlmTask;
  tier: LlmTier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Structured facts the prompt was built from (used by the mock provider). */
  context?: Record<string, unknown>;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: LlmUsage;
  model: string;
}

export type LlmErrorKind =
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "network"
  | "malformed"
  | "token_limit"
  | "refusal"
  | "bad_request"
  | "auth"
  | "budget_exceeded"
  | "unknown";

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: LlmErrorKind,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmProvider {
  readonly name: string;
  completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BudgetedLlmOptions {
  maxCalls: number;
  maxRetries?: number;
  onUsage?: (usage: LlmUsage, model: string) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Wraps a provider with (1) a hard per-evaluation call budget and (2) bounded
 * retries with exponential backoff for retryable failures. Non-retryable errors
 * (refusal, bad request, token limit) propagate immediately so the stage can
 * decide what to do (shrink context, flag for human review, fail).
 */
export class BudgetedLlm implements LlmProvider {
  readonly name: string;
  private calls = 0;
  readonly usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  constructor(
    private readonly inner: LlmProvider,
    private readonly opts: BudgetedLlmOptions,
  ) {
    this.name = inner.name;
  }

  get callCount() {
    return this.calls;
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const maxRetries = this.opts.maxRetries ?? 3;
    let attempt = 0;
    for (;;) {
      if (this.calls >= this.opts.maxCalls) {
        throw new LlmError(`LLM call budget of ${this.opts.maxCalls} exceeded`, "budget_exceeded", false);
      }
      this.calls += 1;
      try {
        const res = await this.inner.completeStructured(req);
        this.usage.inputTokens += res.usage.inputTokens;
        this.usage.outputTokens += res.usage.outputTokens;
        this.usage.cacheReadTokens += res.usage.cacheReadTokens;
        this.opts.onUsage?.(res.usage, res.model);
        return res;
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError(String(err), "unknown", true, err);
        if (!e.retryable || attempt >= maxRetries) throw e;
        attempt += 1;
        const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
        this.opts.log?.(`llm ${e.kind}; retry ${attempt}/${maxRetries} in ${delay}ms`, { task: req.task });
        await sleep(delay);
      }
    }
  }
}
