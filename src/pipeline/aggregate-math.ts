/**
 * Pure scoring math and review-routing policy. No I/O, fully unit-tested.
 */

export interface ScoredCriterion {
  key: string;
  weight: number; // percent of total, all weights sum to 100
  maxScore: number;
  score: number;
  confidence: number; // 0..1
  flags: string[];
}

export interface Aggregate {
  totalScore: number; // out of maxTotal (= sum of weights, normally 100)
  maxTotal: number;
  percentage: number;
  confidence: number; // min across criteria - one weak criterion makes the whole result uncertain
  weighted: Array<{ key: string; weightedScore: number }>;
}

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

export function aggregate(criteria: ScoredCriterion[]): Aggregate {
  if (criteria.length === 0) throw new Error("cannot aggregate zero criteria");
  let total = 0;
  let maxTotal = 0;
  let confidence = 1;
  const weighted = criteria.map((c) => {
    const score = clamp(c.score, 0, c.maxScore);
    const weightedScore = round4((c.weight * score) / c.maxScore);
    total += weightedScore;
    maxTotal += c.weight;
    confidence = Math.min(confidence, clamp(c.confidence, 0, 1));
    return { key: c.key, weightedScore };
  });
  const percentage = maxTotal > 0 ? round2((total / maxTotal) * 100) : 0;
  return { totalScore: round2(total), maxTotal: round2(maxTotal), percentage, confidence: round3(confidence), weighted };
}

export interface ReviewPolicy {
  minConfidence: number; // below this -> human review
  lowPercentage: number; // very low results are double-checked before a student sees them
  highPercentage: number; // very high results too (gaming / plagiarism risk)
  alwaysReviewFlags: string[];
  maxInsufficientEvidence: number; // more criteria than this with insufficient_evidence -> review
}

export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  minConfidence: 0.6,
  lowPercentage: 35,
  highPercentage: 92,
  alwaysReviewFlags: ["prompt_injection_suspected", "possible_plagiarism", "secrets_committed", "llm_refusal"],
  maxInsufficientEvidence: 1,
};

export interface ReviewDecision {
  needsReview: boolean;
  reasons: string[];
}

export function decideReview(
  agg: Aggregate,
  criteria: ScoredCriterion[],
  extraFlags: string[] = [],
  policy: ReviewPolicy = DEFAULT_REVIEW_POLICY,
): ReviewDecision {
  const reasons: string[] = [];
  if (agg.confidence < policy.minConfidence) reasons.push(`low_confidence:${agg.confidence}`);
  if (agg.percentage < policy.lowPercentage) reasons.push(`very_low_score:${agg.percentage}`);
  if (agg.percentage > policy.highPercentage) reasons.push(`very_high_score:${agg.percentage}`);
  const allFlags = new Set([...extraFlags, ...criteria.flatMap((c) => c.flags)]);
  for (const f of policy.alwaysReviewFlags) if (allFlags.has(f)) reasons.push(`flag:${f}`);
  const insufficient = criteria.filter((c) => c.flags.includes("insufficient_evidence")).length;
  if (insufficient > policy.maxInsufficientEvidence) reasons.push(`insufficient_evidence_on_${insufficient}_criteria`);
  return { needsReview: reasons.length > 0, reasons };
}

/** Apply a reviewer's overrides {criterionKey: newScore}; returns a new array. */
export function applyOverrides(criteria: ScoredCriterion[], overrides: Record<string, number>): ScoredCriterion[] {
  return criteria.map((c) =>
    overrides[c.key] !== undefined ? { ...c, score: clamp(overrides[c.key]!, 0, c.maxScore), confidence: 1 } : c,
  );
}

export function validateWeights(weights: number[]): string | null {
  if (weights.length === 0) return "rubric needs at least one criterion";
  if (weights.some((w) => w < 0)) return "weights must be non-negative";
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) return `weights must sum to 100 (got ${round2(sum)})`;
  return null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
