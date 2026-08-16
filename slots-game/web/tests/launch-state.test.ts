import { describe, expect, it } from "vitest";
import { InvalidLaunchTransitionError, LaunchStateMachine } from "../src/startup/LaunchStateMachine";

describe("LaunchStateMachine", () => {
  it("fails closed if a caller tries to finish intro before session activation", () => {
    const launch = new LaunchStateMachine();
    launch.transition({ type: "START_PRELOAD" });
    expect(launch.phase).toBe("preloading");
    launch.transition({ type: "PRELOAD_COMPLETE" });
    expect(launch.hasSession).toBe(false);
    expect(() => launch.transition({ type: "INTRO_COMPLETE" }))
      .toThrow(InvalidLaunchTransitionError);
    expect(launch.phase).toBe("intro");
    expect(launch.canEnterGame).toBe(false);
    launch.transition({ type: "SESSION_READY" });
    expect(launch.phase).toBe("intro");
    launch.transition({ type: "INTRO_COMPLETE" });
    expect(launch.phase).toBe("ready");
  });

  it("keeps the intro gate closed when the session arrives first", () => {
    const launch = new LaunchStateMachine();
    launch.transition({ type: "START_PRELOAD" });
    launch.transition({ type: "SESSION_READY" });
    launch.transition({ type: "PRELOAD_COMPLETE" });
    expect(launch.phase).toBe("intro");
    expect(launch.canEnterGame).toBe(false);
    launch.transition({ type: "INTRO_COMPLETE" });
    expect(launch.canEnterGame).toBe(true);
  });

  it("does not replay the intro after reaching ready", () => {
    const launch = new LaunchStateMachine();
    launch.transition({ type: "START_PRELOAD" });
    launch.transition({ type: "SESSION_READY" });
    launch.transition({ type: "PRELOAD_COMPLETE" });
    launch.transition({ type: "INTRO_COMPLETE" });
    expect(() => launch.transition({ type: "START_PRELOAD" })).toThrow(InvalidLaunchTransitionError);
    expect(launch.phase).toBe("ready");
  });
});
