export type GamePhase =
  | "booting"
  | "connecting"
  | "ready"
  | "requesting"
  | "presenting"
  | "recovering"
  | "failed";

export type GameEvent =
  | { type: "START" }
  | { type: "SESSION_OPENED" }
  | { type: "SPIN_REQUESTED" }
  | { type: "SPIN_RESULT" }
  | { type: "SPIN_FAILED" }
  | { type: "PRESENTATION_COMPLETE" }
  | { type: "CONNECTION_LOST" }
  | { type: "FATAL_ERROR" }
  | { type: "RETRY" };

export class InvalidGameTransitionError extends Error {
  constructor(phase: GamePhase, event: GameEvent["type"]) {
    super(`Cannot apply ${event} while game is ${phase}`);
    this.name = "InvalidGameTransitionError";
  }
}

export class GameStateMachine {
  private currentPhase: GamePhase = "booting";

  get phase(): GamePhase {
    return this.currentPhase;
  }

  get canSpin(): boolean {
    return this.currentPhase === "ready";
  }

  transition(event: GameEvent): GamePhase {
    const next = this.resolve(this.currentPhase, event);
    if (next === null) {
      throw new InvalidGameTransitionError(this.currentPhase, event.type);
    }
    this.currentPhase = next;
    return next;
  }

  private resolve(phase: GamePhase, event: GameEvent): GamePhase | null {
    if (event.type === "FATAL_ERROR") return "failed";

    if (event.type === "CONNECTION_LOST") {
      return phase === "booting" || phase === "failed" ? phase : "recovering";
    }

    switch (phase) {
      case "booting":
        return event.type === "START" ? "connecting" : null;
      case "connecting":
      case "recovering":
        return event.type === "SESSION_OPENED" ? "ready" : null;
      case "ready":
        return event.type === "SPIN_REQUESTED" ? "requesting" : null;
      case "requesting":
        if (event.type === "SPIN_RESULT") return "presenting";
        return event.type === "SPIN_FAILED" ? "ready" : null;
      case "presenting":
        return event.type === "PRESENTATION_COMPLETE" ? "ready" : null;
      case "failed":
        return event.type === "RETRY" ? "connecting" : null;
      default: {
        const exhaustive: never = phase;
        return exhaustive;
      }
    }
  }
}
