import { config } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import type { LlmProvider } from "./provider.js";

export function createLlmProvider(): LlmProvider {
  if (config.LLM_PROVIDER === "anthropic") {
    if (!config.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
    return new AnthropicProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      evaluatorModel: config.LLM_MODEL_EVALUATOR,
      summarizerModel: config.LLM_MODEL_SUMMARIZER,
    });
  }
  return new MockProvider();
}
