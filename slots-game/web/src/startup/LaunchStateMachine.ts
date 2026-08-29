export type LaunchPhase = "boot" | "preloading" | "intro" | "waiting-session" | "ready" | "failed";

export type LaunchEvent =
  | { type: "START_PRELOAD" }
  | { type: "PRELOAD_COMPLETE" }
  | { type: "SESSION_READY" }
  | { type: "INTRO_COMPLETE" }
  | { type: "FAIL" };

export class InvalidLaunchTransitionError extends Error {
  constructor(phase: LaunchPhase, event: LaunchEvent["type"]) {
    super(`Cannot apply ${event} while launch is ${phase}`);
    this.name = "InvalidLaunchTransitionError";
  }
}

/** 协调独立的视觉介绍和初始会话门。 / English: Coordinate separate visual introductions and initial conversational gates. */
export class LaunchStateMachine {
  private currentPhase: LaunchPhase = "boot";
  private sessionReady = false;

  get phase(): LaunchPhase {
    return this.currentPhase;
  }

  get canEnterGame(): boolean {
    return this.currentPhase === "ready";
  }

  /** 在第一次权威重新连接/会话之后启动启动激活。 / English: Start activation after first authoritative reconnect/session. */
  get hasSession(): boolean {
    return this.sessionReady;
  }

  transition(event: LaunchEvent): LaunchPhase {
    if (event.type === "FAIL") {
      this.currentPhase = "failed";
      return this.currentPhase;
    }

    if (event.type === "SESSION_READY") {
      this.sessionReady = true;
      if (this.currentPhase === "waiting-session") this.currentPhase = "ready";
      return this.currentPhase;
    }

    if (this.currentPhase === "boot" && event.type === "START_PRELOAD") {
      this.currentPhase = "preloading";
      return this.currentPhase;
    }

    if (this.currentPhase === "preloading" && event.type === "PRELOAD_COMPLETE") {
      this.currentPhase = "intro";
      return this.currentPhase;
    }

    if (this.currentPhase === "intro" && event.type === "INTRO_COMPLETE") {
      // 在第一个权威重新连接/会话激活 Splash Continue 之前，捕获的启动器永远不会启动视觉介绍。在这里保留一个防御性失败封闭守卫， / English: The captured launcher never starts the visual intro until the first authoritative reconnect/session activates Splash Continue. Keep a defensive fail closure guard here,
      // 这样呼叫者就无法制造过时的介绍优先路径。 / English: This way callers cannot create outdated introduction priority paths.
      if (!this.sessionReady) {
        throw new InvalidLaunchTransitionError(this.currentPhase, event.type);
      }
      this.currentPhase = "ready";
      return this.currentPhase;
    }

    throw new InvalidLaunchTransitionError(this.currentPhase, event.type);
  }
}
