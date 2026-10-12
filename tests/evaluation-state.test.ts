import { describe, expect, it } from "vitest";
import { ACTIVE_STATUSES, canTransition, STAGES, STAGE_STATUS, TERMINAL_STATUSES, TRANSITIONS, type EvaluationStatus } from "../src/domain/evaluation-state.js";

describe("evaluation state machine", () => {
  it("terminal states have no outgoing transitions except failed -> queued (manual retry)", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(TRANSITIONS[s]).toEqual(s === "failed" ? ["queued"] : []);
    }
  });

  it("every stage can follow the previous stage and retry itself", () => {
    let prev: EvaluationStatus = "queued";
    for (const stage of STAGES) {
      const s = STAGE_STATUS[stage].status;
      expect(canTransition(prev, s)).toBe(true);
      expect(canTransition(s, s)).toBe(true); // redelivery / retry
      expect(canTransition(s, "failed")).toBe(true);
      prev = s;
    }
  });

  it("human decisions only apply to finished evaluations", () => {
    expect(canTransition("needs_review", "approved")).toBe(true);
    expect(canTransition("completed", "rejected")).toBe(true);
    for (const s of ACTIVE_STATUSES) {
      expect(canTransition(s, "approved")).toBe(false);
      expect(canTransition(s, "rejected")).toBe(false);
    }
  });

  it("cannot skip stages", () => {
    expect(canTransition("queued", "evaluating")).toBe(false);
    expect(canTransition("extracting", "aggregating")).toBe(false);
    expect(canTransition("understanding", "completed")).toBe(false);
  });

  it("progress is monotonic across stages", () => {
    const p = STAGES.map((s) => STAGE_STATUS[s].progress);
    expect([...p].sort((a, b) => a - b)).toEqual(p);
  });
});
