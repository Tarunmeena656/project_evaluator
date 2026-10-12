import { describe, expect, it } from "vitest";
import { aggregate, applyOverrides, decideReview, validateWeights, type ScoredCriterion } from "../src/pipeline/aggregate-math.js";

const base: ScoredCriterion[] = [
  { key: "functionality", weight: 25, maxScore: 10, score: 8, confidence: 0.8, flags: [] },
  { key: "code_quality", weight: 20, maxScore: 10, score: 7, confidence: 0.75, flags: [] },
  { key: "architecture", weight: 20, maxScore: 10, score: 6, confidence: 0.7, flags: [] },
  { key: "problem_solving", weight: 15, maxScore: 10, score: 7, confidence: 0.8, flags: [] },
  { key: "documentation", weight: 10, maxScore: 10, score: 9, confidence: 0.9, flags: [] },
  { key: "innovation_ai_usage", weight: 10, maxScore: 10, score: 5, confidence: 0.65, flags: [] },
];

describe("aggregate", () => {
  it("computes the weighted total out of the sum of weights", () => {
    const a = aggregate(base);
    // 25*0.8 + 20*0.7 + 20*0.6 + 15*0.7 + 10*0.9 + 10*0.5 = 20+14+12+10.5+9+5 = 70.5
    expect(a.totalScore).toBe(70.5);
    expect(a.maxTotal).toBe(100);
    expect(a.percentage).toBe(70.5);
    expect(a.confidence).toBe(0.65); // minimum across criteria
  });

  it("clamps out-of-range scores instead of trusting the model", () => {
    const a = aggregate([{ key: "x", weight: 100, maxScore: 10, score: 14, confidence: 2, flags: [] }]);
    expect(a.percentage).toBe(100);
    expect(a.confidence).toBe(1);
  });

  it("works with a different max_score per criterion", () => {
    const a = aggregate([
      { key: "a", weight: 50, maxScore: 5, score: 5, confidence: 1, flags: [] },
      { key: "b", weight: 50, maxScore: 20, score: 10, confidence: 1, flags: [] },
    ]);
    expect(a.percentage).toBe(75);
  });
});

describe("decideReview", () => {
  it("does not route a confident mid-range result", () => {
    expect(decideReview(aggregate(base), base).needsReview).toBe(false);
  });

  it("routes on low confidence", () => {
    const low = base.map((c) => (c.key === "architecture" ? { ...c, confidence: 0.4 } : c));
    const d = decideReview(aggregate(low), low);
    expect(d.needsReview).toBe(true);
    expect(d.reasons[0]).toMatch(/low_confidence/);
  });

  it("routes on prompt injection and secrets flags", () => {
    const flagged = base.map((c) => (c.key === "code_quality" ? { ...c, flags: ["prompt_injection_suspected"] } : c));
    expect(decideReview(aggregate(flagged), flagged).reasons).toContain("flag:prompt_injection_suspected");
    expect(decideReview(aggregate(base), base, ["secrets_committed"]).reasons).toContain("flag:secrets_committed");
  });

  it("routes extreme scores for a human look", () => {
    const perfect = base.map((c) => ({ ...c, score: 10, confidence: 0.9 }));
    expect(decideReview(aggregate(perfect), perfect).reasons.some((r) => r.startsWith("very_high_score"))).toBe(true);
    const poor = base.map((c) => ({ ...c, score: 2, confidence: 0.9 }));
    expect(decideReview(aggregate(poor), poor).reasons.some((r) => r.startsWith("very_low_score"))).toBe(true);
  });

  it("routes when more than one criterion lacked evidence", () => {
    const thin = base.map((c, i) => (i < 2 ? { ...c, flags: ["insufficient_evidence"] } : c));
    expect(decideReview(aggregate(thin), thin).reasons).toContain("insufficient_evidence_on_2_criteria");
    const one = base.map((c, i) => (i < 1 ? { ...c, flags: ["insufficient_evidence"] } : c));
    expect(decideReview(aggregate(one), one).needsReview).toBe(false);
  });
});

describe("applyOverrides", () => {
  it("replaces scores, clamps them and sets confidence to 1", () => {
    const out = applyOverrides(base, { documentation: 4, functionality: 99 });
    expect(out.find((c) => c.key === "documentation")).toMatchObject({ score: 4, confidence: 1 });
    expect(out.find((c) => c.key === "functionality")).toMatchObject({ score: 10, confidence: 1 });
    expect(out.find((c) => c.key === "architecture")!.score).toBe(6);
    expect(base.find((c) => c.key === "documentation")!.score).toBe(9); // input untouched
  });
});

describe("validateWeights", () => {
  it("requires weights to sum to 100", () => {
    expect(validateWeights([25, 20, 20, 15, 10, 10])).toBeNull();
    expect(validateWeights([50, 49])).toMatch(/sum to 100/);
    expect(validateWeights([])).toMatch(/at least one/);
    expect(validateWeights([110, -10])).toMatch(/non-negative/);
  });
});
