import { describe, expect, it, vi } from "vitest";
import {
  InvalidReelRoundTransitionError,
  ReelRoundStateMachine,
  type ReelRoundState,
} from "../src/reels/ReelRoundStateMachine";

function advanceThroughStops(machine: ReelRoundStateMachine): void {
  machine.transition({ type: "SPIN_ACCEPTED", roundId: "round-1" });
  machine.transition({ type: "REELS_STARTED" });
  machine.transition({ type: "RESULT_RECEIVED", roundId: "round-1", rows: 3 });
  machine.transition({ type: "REEL_STOP_STARTED", reel: 0 });
  machine.transition({ type: "REEL_STOP_STARTED", reel: 1 });
  machine.transition({ type: "REEL_STOP_STARTED", reel: 2 });
  machine.transition({ type: "ALL_REELS_STOPPED" });
}

describe("ReelRoundStateMachine", () => {
  it("runs the required visual lifecycle in its exact order", () => {
    const machine = new ReelRoundStateMachine();
    const states: ReelRoundState[] = [];
    machine.subscribe((snapshot) => states.push(snapshot.state));

    advanceThroughStops(machine);
    machine.transition({ type: "WIN_PRESENTATION_STARTED" });
    machine.transition({ type: "ROUND_COMPLETE" });

    expect(states).toEqual([
      "Idle",
      "Spin_Start",
      "Spinning",
      "Spin_Stopping",
      "Reel_Stop_One_By_One",
      "Reel_Stop_One_By_One",
      "Reel_Stop_One_By_One",
      "Result_Show",
      "Win_Line_Animation",
      "Idle",
    ]);
    expect(machine.snapshot).toMatchObject({
      state: "Idle",
      roundId: null,
      rows: null,
      stopStartedReels: [],
      lastEvent: "ROUND_COMPLETE",
    });
  });

  it("rejects mismatched results and out-of-order reel releases", () => {
    const machine = new ReelRoundStateMachine();
    machine.transition({ type: "SPIN_ACCEPTED", roundId: "round-1" });
    machine.transition({ type: "REELS_STARTED" });

    expect(() => machine.transition({
      type: "RESULT_RECEIVED",
      roundId: "round-other",
      rows: 3,
    })).toThrow(InvalidReelRoundTransitionError);

    machine.transition({ type: "RESULT_RECEIVED", roundId: "round-1", rows: 3 });
    expect(() => machine.transition({ type: "REEL_STOP_STARTED", reel: 1 }))
      .toThrow("first stopped reel must be reel 0");

    machine.transition({ type: "REEL_STOP_STARTED", reel: 0 });
    expect(() => machine.transition({ type: "REEL_STOP_STARTED", reel: 2 }))
      .toThrow("expected reel 1");
    expect(() => machine.transition({ type: "ALL_REELS_STOPPED" }))
      .toThrow("all three reel brakes must start first");
  });

  it("forces every no-win round through Win_Line_Animation before Idle", () => {
    const machine = new ReelRoundStateMachine();
    advanceThroughStops(machine);

    expect(() => machine.transition({ type: "ROUND_COMPLETE" }))
      .toThrow(InvalidReelRoundTransitionError);
    machine.transition({ type: "WIN_PRESENTATION_STARTED" });
    expect(machine.state).toBe("Win_Line_Animation");
    machine.transition({ type: "ROUND_COMPLETE" });
    expect(machine.state).toBe("Idle");
  });

  it("can be reset from an interrupted phase and isolates observer failures", () => {
    const machine = new ReelRoundStateMachine();
    const healthyObserver = vi.fn();
    machine.subscribe(() => { throw new Error("cosmetic observer failed"); });
    machine.subscribe(healthyObserver);

    machine.transition({ type: "SPIN_ACCEPTED", roundId: "round-1" });
    machine.transition({ type: "REELS_STARTED" });
    expect(() => machine.reset("network-rejected")).not.toThrow();
    expect(machine.snapshot).toMatchObject({ state: "Idle", lastEvent: "RESET" });
    expect(healthyObserver).toHaveBeenCalledTimes(4);
  });
});
