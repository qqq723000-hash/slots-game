import { describe, expect, it } from "vitest";
import { GameStateMachine, InvalidGameTransitionError } from "../src/app/state/GameStateMachine";

describe("GameStateMachine", () => {
  it("allows exactly one in-flight spin until presentation completes", () => {
    const machine = new GameStateMachine();
    machine.transition({ type: "START" });
    machine.transition({ type: "SESSION_OPENED" });
    expect(machine.canSpin).toBe(true);

    machine.transition({ type: "SPIN_REQUESTED" });
    expect(machine.canSpin).toBe(false);
    expect(() => machine.transition({ type: "SPIN_REQUESTED" })).toThrow(InvalidGameTransitionError);

    machine.transition({ type: "SPIN_RESULT" });
    expect(machine.phase).toBe("presenting");
    machine.transition({ type: "PRESENTATION_COMPLETE" });
    expect(machine.canSpin).toBe(true);
  });

  it("recovers an in-flight request through a resumed session", () => {
    const machine = new GameStateMachine();
    machine.transition({ type: "START" });
    machine.transition({ type: "SESSION_OPENED" });
    machine.transition({ type: "SPIN_REQUESTED" });
    machine.transition({ type: "CONNECTION_LOST" });
    expect(machine.phase).toBe("recovering");
    machine.transition({ type: "SESSION_OPENED" });
    machine.transition({ type: "SPIN_REQUESTED" });
    expect(machine.phase).toBe("requesting");
  });
});
