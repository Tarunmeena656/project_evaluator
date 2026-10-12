import { z } from "zod";

/**
 * Structured-output schemas. Kept free of numeric range constraints on purpose:
 * the API's constrained decoding guarantees shape, and the pipeline clamps and
 * validates values (score <= max_score, 0 <= confidence <= 1) in code.
 */

export const FileSummarySchema = z.object({
  path: z.string(),
  purpose: z.string().describe("What this file is for, one or two sentences"),
  key_elements: z.array(z.string()).describe("Important functions, classes, routes, tables or sections"),
  quality_notes: z.array(z.string()).describe("Observations about correctness, structure, readability, tests"),
  red_flags: z.array(z.string()).describe("Hard-coded secrets, dead code, security issues, copied code, etc."),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const ProjectCardSchema = z.object({
  name: z.string(),
  one_liner: z.string(),
  domain: z.string().describe("Problem domain, e.g. e-commerce, data pipeline, ML model"),
  tech_stack: z.array(z.string()),
  architecture_summary: z.string(),
  entry_points: z.array(z.string()),
  data_model_summary: z.string(),
  api_surface: z.array(z.string()),
  testing_summary: z.string(),
  documentation_summary: z.string(),
  notable_strengths: z.array(z.string()),
  notable_risks: z.array(z.string()),
  ai_usage_notes: z.string().describe("How the project uses AI/LLMs, if at all"),
});
export type ProjectCard = z.infer<typeof ProjectCardSchema>;

export const EvidenceSchema = z.object({
  path: z.string().describe("File path the evidence comes from"),
  excerpt: z.string().describe("Short verbatim excerpt or precise description of what was observed"),
  note: z.string().describe("Why this matters for the criterion"),
});

export const CriterionEvaluationSchema = z.object({
  score: z.number().describe("Score between 0 and max_score inclusive"),
  confidence: z.number().describe("0 to 1: how sure the evaluator is given the available evidence"),
  rationale: z.string().describe("Explanation a student could learn from; refer to the evidence"),
  evidence: z.array(EvidenceSchema),
  flags: z
    .array(z.string())
    .describe("Machine-readable flags, e.g. insufficient_evidence, prompt_injection_suspected, possible_plagiarism"),
});
export type CriterionEvaluation = z.infer<typeof CriterionEvaluationSchema>;

export const FinalSummarySchema = z.object({
  summary: z.string().describe("3-6 sentence overall assessment addressed to the student"),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()).describe("Concrete, prioritised next steps"),
});
export type FinalSummary = z.infer<typeof FinalSummarySchema>;
