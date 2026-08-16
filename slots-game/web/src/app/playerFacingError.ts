import type { ServerError } from "./state/types";

/**
 * 面向玩家的错误码是产品契约，不是服务端或协议的透传。不要把异常消息、
 * URL、令牌、请求体或堆栈带到这个模块的输出里。
 */
export const PLAYER_FACING_ERROR_CODES = {
  LAUNCH_UNAVAILABLE: "LAUNCH_UNAVAILABLE",
  SESSION_TIMEOUT: "SESSION_TIMEOUT",
  OPERATOR_SESSION_REQUIRED: "OPERATOR_SESSION_REQUIRED",
  CONNECTION_RETRYING: "CONNECTION_RETRYING",
  REQUEST_UNAVAILABLE: "REQUEST_UNAVAILABLE",
  RESULT_UNAVAILABLE: "RESULT_UNAVAILABLE",
  PRESENTATION_UNAVAILABLE: "PRESENTATION_UNAVAILABLE",
} as const;

export type PlayerFacingErrorCode = typeof PLAYER_FACING_ERROR_CODES[
  keyof typeof PLAYER_FACING_ERROR_CODES
];

export interface PlayerFacingError {
  readonly code: PlayerFacingErrorCode;
  readonly message: string;
  /**
   * 仅供受控宿主诊断；永远不会拼进玩家文案或 DOM 可见文本。
   * requestId 不是认证凭据，但仍须按诊断数据处理。
   */
  readonly correlationId?: string;
}

export const OPERATOR_SESSION_REQUIRED_EVENT = "slots-game:operator-session-required";
export const PLAYER_ERROR_DIAGNOSTIC_EVENT = "slots-game:player-error";

export type OperatorSessionRequestReason =
  | "initial-session-timeout"
  | "initial-session-failed"
  | "committed-result-recovery-required";
export type OperatorSessionRequestCode =
  | typeof PLAYER_FACING_ERROR_CODES.SESSION_TIMEOUT
  | typeof PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED;

export interface PlayerErrorDiagnostic {
  readonly code: PlayerFacingError["code"];
  readonly correlationId?: string;
}

export type PlayerErrorDiagnosticHandler = (diagnostic: Readonly<PlayerErrorDiagnostic>) => void;

export interface OperatorSessionRequest extends PlayerErrorDiagnostic {
  readonly reason: OperatorSessionRequestReason;
  readonly code: OperatorSessionRequestCode;
}

export type OperatorSessionRequestHandler = (request: Readonly<OperatorSessionRequest>) => void;

export type PlayerFacingErrorContext =
  | "launch"
  | "initial-rgs-session"
  | "connection"
  | "round-request"
  | "round-result"
  | "presentation"
  | "acknowledgement"
  | "feature-presentation"
  | "unsolicited-result";

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PLAYER_FACING_MESSAGES: Readonly<Record<PlayerFacingErrorCode, string>> = Object.freeze({
  LAUNCH_UNAVAILABLE: "The game could not start. Please try again.",
  SESSION_TIMEOUT: "The game session did not start in time. Return to your operator and start a new session.",
  OPERATOR_SESSION_REQUIRED: "This game session is unavailable. Return to your operator and start a new session.",
  CONNECTION_RETRYING: "Connection interrupted. Retrying.",
  REQUEST_UNAVAILABLE: "This request could not be completed. Please try again.",
  RESULT_UNAVAILABLE: "The game result could not be displayed. Please contact support if this continues.",
  PRESENTATION_UNAVAILABLE: "The game could not finish this presentation. Please contact support if this continues.",
});

function isServerError(value: unknown): value is ServerError {
  return value !== null && typeof value === "object"
    && (value as { type?: unknown }).type === "error"
    && typeof (value as { retryable?: unknown }).retryable === "boolean";
}

/** 只提取受模式约束的关联 ID；绝不读取服务端消息。 */
export function safeCorrelationId(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object") return undefined;
  const requestId = (cause as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && CORRELATION_ID_PATTERN.test(requestId)
    ? requestId
    : undefined;
}

export function playerFacingError(
  code: PlayerFacingErrorCode,
  cause?: unknown,
): PlayerFacingError {
  const correlationId = safeCorrelationId(cause);
  return Object.freeze({
    code,
    message: PLAYER_FACING_MESSAGES[code],
    ...(correlationId ? { correlationId } : {}),
  });
}

/**
 * 将传输/协议/运行时故障统一转换为稳定玩家文案。
 * 此处刻意不读取 `cause.message`：该字段可能由服务端控制或包含实现细节，
 * 不得进入玩家可见表面。
 */
export function playerFacingErrorFor(
  cause: unknown,
  context: PlayerFacingErrorContext,
): PlayerFacingError {
  switch (context) {
    case "initial-rgs-session":
      return playerFacingError(PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED, cause);
    case "connection":
      return playerFacingError(PLAYER_FACING_ERROR_CODES.CONNECTION_RETRYING, cause);
    case "round-request":
      return playerFacingError(
        isServerError(cause) && cause.retryable
          ? PLAYER_FACING_ERROR_CODES.CONNECTION_RETRYING
          : PLAYER_FACING_ERROR_CODES.REQUEST_UNAVAILABLE,
        cause,
      );
    case "round-result":
    case "unsolicited-result":
      return playerFacingError(PLAYER_FACING_ERROR_CODES.RESULT_UNAVAILABLE, cause);
    case "presentation":
    case "acknowledgement":
    case "feature-presentation":
      return playerFacingError(PLAYER_FACING_ERROR_CODES.PRESENTATION_UNAVAILABLE, cause);
    case "launch":
      return playerFacingError(PLAYER_FACING_ERROR_CODES.LAUNCH_UNAVAILABLE, cause);
  }
}
