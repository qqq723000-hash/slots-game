import { describe, expect, it } from "vitest";
import { classifySpinResult, type SpinResultGuardState } from "../src/protocol/spinResultGuard";

const active: SpinResultGuardState = {
  sessionId: "session-1",
  pendingRoundId: "round-2",
  pendingBetMinor: "100",
  lastAppliedSequence: 7,
  lastAppliedRoundId: "round-1",
};

describe("classifySpinResult", () => {
  it("accepts only the pending round in the active session with a newer sequence", () => {
    expect(classifySpinResult(active, {
      sessionId: "session-1",
      roundId: "round-2",
      sequence: 8,
      betMinor: "100",
    })).toEqual({ kind: "accept" });
  });

  it.each([
    [{ ...active }, { sessionId: "other-session", roundId: "round-2", sequence: 8, betMinor: "100" }, "session-mismatch"],
    [{ ...active }, { sessionId: "session-1", roundId: "round-2", sequence: 6, betMinor: "100" }, "stale-sequence"],
    [{ ...active, pendingRoundId: null }, { sessionId: "session-1", roundId: "round-2", sequence: 8, betMinor: "100" }, "unsolicited"],
    [{ ...active }, { sessionId: "session-1", roundId: "other-round", sequence: 8, betMinor: "100" }, "round-mismatch"],
    [{ ...active }, { sessionId: "session-1", roundId: "round-2", sequence: 8, betMinor: "200" }, "bet-mismatch"],
    [{ ...active }, { sessionId: "session-1", roundId: "other-round", sequence: 7, betMinor: "100" }, "stale-sequence"],
  ] as const)("rejects a result that cannot update the projection", (state, result, reason) => {
    expect(classifySpinResult(state, result)).toEqual({ kind: "reject", reason });
  });

  it("recognizes an idempotent replay of the last applied round without reapplying it", () => {
    expect(classifySpinResult(active, {
      sessionId: "session-1",
      roundId: "round-1",
      sequence: 7,
      betMinor: "100",
    })).toEqual({ kind: "duplicate" });

    expect(classifySpinResult({ ...active, pendingRoundId: "round-1" }, {
      sessionId: "session-1",
      roundId: "round-1",
      sequence: 7,
      betMinor: "100",
    })).toEqual({ kind: "duplicate" });
  });
});
