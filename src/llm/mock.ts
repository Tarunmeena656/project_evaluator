import { createHash } from "node:crypto";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./provider.js";

/**
 * Deterministic offline provider. It never calls a network and derives its
 * answers from the structured `context` the pipeline passes alongside the
 * prompt (file inventory signals, criterion key, etc.). Used for local runs,
 * CI, and the evaluation-engine unit tests. Scores are heuristic, but stable
 * for the same input, which makes pipeline behaviour testable.
 */
export class MockProvider implements LlmProvider {
  readonly name = "mock";

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const ctx = req.context ?? {};
    let data: unknown;
    switch (req.task) {
      case "summarize_file":
        data = summarizeFile(ctx);
        break;
      case "project_card":
        data = projectCard(ctx);
        break;
      case "evaluate_criterion":
        data = evaluateCriterion(ctx);
        break;
      case "final_summary":
        data = finalSummary(ctx);
        break;
    }
    const parsed = req.schema.parse(data);
    const approxIn = Math.ceil((req.system.length + req.user.length) / 4);
    return {
      data: parsed,
      model: "mock-deterministic-v1",
      usage: { inputTokens: approxIn, outputTokens: 300, cacheReadTokens: 0 },
    };
  }
}

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown) => v === true;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function summarizeFile(ctx: Record<string, unknown>) {
  const path = str(ctx.path, "unknown");
  const lines = num(ctx.lines);
  const kind = str(ctx.kind, "code");
  return {
    path,
    purpose: `${kind} file with ${lines} lines (${path.split("/").pop()}).`,
    key_elements: arr(ctx.symbols).slice(0, 8),
    quality_notes: lines > 400 ? ["Long file; consider splitting into smaller modules."] : ["Reasonable size."],
    red_flags: bool(ctx.hasSecretPattern) ? ["Possible hard-coded secret"] : [],
  };
}

function projectCard(ctx: Record<string, unknown>) {
  const langs = arr(ctx.languages);
  return {
    name: str(ctx.name, "Student project"),
    one_liner: str(ctx.readmeFirstLine, "A software project submitted for evaluation."),
    domain: "unknown",
    tech_stack: langs,
    architecture_summary: `${num(ctx.fileCount)} files across ${num(ctx.dirCount)} directories; primary language ${langs[0] ?? "n/a"}.`,
    entry_points: arr(ctx.entryPoints),
    data_model_summary: bool(ctx.hasSchema) ? "Schema/migration files present." : "No explicit schema files found.",
    api_surface: arr(ctx.routeFiles),
    testing_summary: bool(ctx.hasTests) ? `${num(ctx.testFileCount)} test files found.` : "No tests found.",
    documentation_summary: bool(ctx.hasReadme) ? `README present (${num(ctx.readmeChars)} chars).` : "No README.",
    notable_strengths: bool(ctx.hasTests) ? ["Automated tests present"] : [],
    notable_risks: bool(ctx.hasSecretPattern) ? ["Possible secrets committed"] : [],
    ai_usage_notes: bool(ctx.mentionsAi) ? "Project references AI/LLM libraries or APIs." : "No AI usage detected.",
  };
}

function evaluateCriterion(ctx: Record<string, unknown>) {
  const key = str(ctx.criterionKey, "general");
  const max = num(ctx.maxScore, 10);
  const signals = (ctx.signals ?? {}) as Record<string, unknown>;
  // Heuristic base in [0.35, 0.9] of max from deterministic signals.
  let ratio = 0.5;
  if (bool(signals.hasTests)) ratio += 0.12;
  if (bool(signals.hasReadme)) ratio += 0.08;
  if (bool(signals.hasCi)) ratio += 0.05;
  if (bool(signals.hasDocker)) ratio += 0.05;
  if (bool(signals.hasSecretPattern)) ratio -= 0.1;
  if (num(signals.fileCount) < 3) ratio -= 0.15;
  if (key === "documentation") ratio = bool(signals.hasReadme) ? Math.min(0.9, ratio + 0.1) : 0.3;
  if (key === "functionality" && !bool(signals.hasTests)) ratio -= 0.05;
  if (key.includes("innovation") || key.includes("ai")) ratio = bool(signals.mentionsAi) ? ratio + 0.1 : ratio - 0.1;
  // Small stable per-criterion variation so scores are not all identical.
  const h = createHash("sha1").update(`${key}:${str(ctx.projectName)}`).digest()[0]! / 255;
  ratio = Math.max(0.1, Math.min(0.95, ratio + (h - 0.5) * 0.1));
  const score = Math.round(ratio * max * 2) / 2;
  const files = arr(ctx.topFiles);
  const injected = bool(signals.promptInjectionSuspected);
  return {
    score,
    confidence: injected ? 0.4 : files.length >= 3 ? 0.75 : 0.55,
    rationale:
      `[mock evaluator] ${key}: scored ${score}/${max} from deterministic signals ` +
      `(tests=${bool(signals.hasTests)}, readme=${bool(signals.hasReadme)}, ci=${bool(signals.hasCi)}).`,
    evidence: files.slice(0, 3).map((p) => ({ path: p, excerpt: "(mock) file inspected", note: `Relevant to ${key}` })),
    flags: [...(files.length < 3 ? ["insufficient_evidence"] : []), ...(injected ? ["prompt_injection_suspected"] : [])],
  };
}

function finalSummary(ctx: Record<string, unknown>) {
  const pct = num(ctx.percentage);
  return {
    summary:
      `[mock] Overall ${pct.toFixed(1)}%. The project was evaluated against ${num(ctx.criteriaCount)} criteria ` +
      `using deterministic signals only (offline mode).`,
    strengths: arr(ctx.strengths).slice(0, 4),
    improvements: arr(ctx.improvements).slice(0, 4),
  };
}
