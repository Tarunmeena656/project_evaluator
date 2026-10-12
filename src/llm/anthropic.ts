import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { LlmError, type LlmProvider, type StructuredRequest, type StructuredResult } from "./provider.js";

export interface AnthropicProviderOptions {
  apiKey: string;
  evaluatorModel: string; // e.g. claude-opus-5-5
  summarizerModel: string; // e.g. claude-haiku-5-5
  timeoutMs?: number;
}

/**
 * Claude via the official SDK. Structured outputs (`messages.parse` +
 * `output_config.format`) guarantee schema-valid JSON, so the pipeline never
 * parses free text. The system prompt is cache-marked: it is identical across
 * every file summary / criterion call in an evaluation, so the prefix is served
 * from cache after the first call.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      timeout: opts.timeoutMs ?? 180_000,
      maxRetries: 0, // BudgetedLlm owns retries so they are visible and bounded
    });
  }

  private modelFor(tier: StructuredRequest<unknown>["tier"]): string {
    return tier === "evaluator" ? this.opts.evaluatorModel : this.opts.summarizerModel;
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const model = this.modelFor(req.tier);
    try {
      const response = await this.client.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 8_000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: zodOutputFormat(req.schema),
          effort: req.tier === "evaluator" ? "high" : "medium",
        },
      });

      if (response.stop_reason === "refusal") {
        throw new LlmError("model declined the request (safety refusal)", "refusal", false);
      }
      if (response.stop_reason === "max_tokens") {
        throw new LlmError("output truncated at max_tokens", "token_limit", false);
      }
      if (!response.parsed_output) {
        throw new LlmError("model output did not match the schema", "malformed", true);
      }
      return {
        data: response.parsed_output,
        model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw classify(err);
    }
  }
}

/** Map SDK exceptions to retryable / non-retryable LlmErrors, most specific first. */
function classify(err: unknown): LlmError {
  if (err instanceof Anthropic.RateLimitError) return new LlmError(err.message, "rate_limit", true, err);
  if (err instanceof Anthropic.AuthenticationError) return new LlmError(err.message, "auth", false, err);
  if (err instanceof Anthropic.BadRequestError) return new LlmError(err.message, "bad_request", false, err);
  if (err instanceof Anthropic.InternalServerError) return new LlmError(err.message, "unavailable", true, err);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError(err.message, "timeout", true, err);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError(err.message, "network", true, err);
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 409;
    return new LlmError(err.message, retryable ? "unavailable" : "unknown", retryable, err);
  }
  return new LlmError(err instanceof Error ? err.message : String(err), "unknown", false, err);
}
