import type { MoneyMinor, SpinResult } from "../app/state/types";

export interface SpinResultGuardState {
  sessionId: string | null;
  pendingRoundId: string | null;
  pendingBetMinor: MoneyMinor | null;
  lastAppliedSequence: number;
  lastAppliedRoundId: string | null;
}

export type SpinResultDecision =
  | { kind: "accept" }
  | { kind: "duplicate" }
  | { kind: "reject"; reason: "session-mismatch" | "stale-sequence" | "unsolicited" | "round-mismatch" | "bet-mismatch" };

export function classifySpinResult(
  state: SpinResultGuardState,
  result: Pick<SpinResult, "sessionId" | "roundId" | "sequence" | "betMinor">,
): SpinResultDecision {
  if (!state.sessionId || result.sessionId !== state.sessionId) {
    return { kind: "reject", reason: "session-mismatch" };
  }

  if (result.sequence < state.lastAppliedSequence) {
    return { kind: "reject", reason: "stale-sequence" };
  }

  if (result.sequence === state.lastAppliedSequence) {
    return result.roundId === state.lastAppliedRoundId
      ? { kind: "duplicate" }
      : { kind: "reject", reason: "stale-sequence" };
  }

  if (!state.pendingRoundId) return { kind: "reject", reason: "unsolicited" };
  if (result.roundId !== state.pendingRoundId) return { kind: "reject", reason: "round-mismatch" };
  if (!state.pendingBetMinor || result.betMinor !== state.pendingBetMinor) {
    return { kind: "reject", reason: "bet-mismatch" };
  }
  return { kind: "accept" };
}
