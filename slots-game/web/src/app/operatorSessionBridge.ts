import {
  OPERATOR_SESSION_REQUIRED_EVENT,
  safeCorrelationId,
  type OperatorSessionRequest,
} from "./playerFacingError";
import { parseExactHttpsHostOrigin } from "../protocol/rgsHostOrigin";

export { parseExactHttpsHostOrigin };

export const OPERATOR_SESSION_HOST_MESSAGE_TYPE = OPERATOR_SESSION_REQUIRED_EVENT;
export const OPERATOR_SESSION_HOST_MESSAGE_VERSION = 1 as const;

export interface OperatorSessionHostMessage {
  readonly type: typeof OPERATOR_SESSION_HOST_MESSAGE_TYPE;
  readonly version: typeof OPERATOR_SESSION_HOST_MESSAGE_VERSION;
  readonly reason: OperatorSessionRequest["reason"];
  readonly code: OperatorSessionRequest["code"];
  readonly correlationId?: string;
}

export function isWindowFramed(windowValue: Window): boolean {
  try {
    return windowValue.parent !== windowValue;
  } catch {
    // 无法确认顶层关系时按框架内页面处理，后续仍须有精确 targetOrigin 才能发送。 / English: When the top-level relationship cannot be confirmed, it will be processed as a page within the frame, and subsequent targetOrigin must still be accurate before it can be sent.
    return true;
  }
}

function allowlistedRequest(
  request: Readonly<OperatorSessionRequest>,
): Readonly<OperatorSessionRequest> | null {
  // 跨窗口安全边界不能依赖 TypeScript 类型；运行时值不在封闭枚举内就完全拒绝通知。 / English: Cross-window security boundaries cannot rely on TypeScript types; runtime values ​​not within the enclosing enumeration reject notifications entirely.
  const candidate: unknown = request;
  if (candidate === null || typeof candidate !== "object") return null;
  const values = candidate as Record<string, unknown>;
  const reason = values.reason;
  const code = values.code;
  if ((reason !== "initial-session-timeout" && reason !== "session-timeout"
      && reason !== "initial-session-failed"
      && reason !== "committed-result-recovery-required")
    || (code !== "SESSION_TIMEOUT" && code !== "OPERATOR_SESSION_REQUIRED")) {
    return null;
  }
  const correlationId = safeCorrelationId({ requestId: values.correlationId });
  return Object.freeze({
    reason,
    code,
    ...(correlationId ? { correlationId } : {}),
  });
}

/**
 * 同页事件供同源集成使用；跨框架消息只发往构建期锁定的精确来源。
 * 两条旁路都使用字段白名单，绝不携带底层错误/消息或一次性凭据。
 *
 * 英文 / English: Same-page events are used by same-origin integration; cross-frame messages are only sent to the exact source locked during build time. Both bypasses use field whitelisting and never carry underlying errors/messages or one-time credentials.
 */
export function notifyOperatorSessionRequired(
  windowValue: Window | undefined,
  request: Readonly<OperatorSessionRequest>,
  configuredHostOrigin?: string | null,
): void {
  if (!windowValue) return;
  const safeRequest = allowlistedRequest(request);
  if (!safeRequest) return;
  if (typeof windowValue.dispatchEvent === "function" && typeof CustomEvent === "function") {
    try {
      windowValue.dispatchEvent(new CustomEvent<OperatorSessionRequest>(
        OPERATOR_SESSION_REQUIRED_EVENT,
        { detail: safeRequest },
      ));
    } catch {
      // 同页通知是恢复旁路；派发失败不能重新启用已清除的一次性凭据。 / English: Same-page notifications are recovery bypass; failed delivery cannot re-enable cleared one-time credentials.
    }
  }

  let targetOrigin: string | null;
  try {
    targetOrigin = parseExactHttpsHostOrigin(configuredHostOrigin ?? undefined);
  } catch {
    return;
  }
  if (!targetOrigin || !isWindowFramed(windowValue)) return;

  const message: Readonly<OperatorSessionHostMessage> = Object.freeze({
    type: OPERATOR_SESSION_HOST_MESSAGE_TYPE,
    version: OPERATOR_SESSION_HOST_MESSAGE_VERSION,
    reason: safeRequest.reason,
    code: safeRequest.code,
    ...(safeRequest.correlationId ? { correlationId: safeRequest.correlationId } : {}),
  });
  try {
    windowValue.parent.postMessage(message, targetOrigin);
  } catch {
    // postMessage 是宿主恢复旁路；失败时游戏仍保持故障关闭。 / English: postMessage is the host recovery bypass; the game remains crash-closed on failure.
  }
}

/**
 * 顶层同源部署的显式退出兜底。跨框架生产始终只走精确 postMessage；未配置、
 * 跨源、协议相对、带查询/片段的目标一律不导航。
 *
 * 英文 / English: Explicit exit from top-level homologous deployments. Cross-framework production always only uses precise postMessage; unconfigured, cross-source, protocol-relative, and targets with queries/fragments are not navigated.
 */
export function returnTopLevelSessionToOperator(
  windowValue: Window | undefined,
  configuredPath?: string,
): boolean {
  if (!windowValue || !configuredPath || isWindowFramed(windowValue)) return false;
  if (!configuredPath.startsWith("/") || configuredPath.startsWith("//")) return false;
  let target: URL;
  try {
    target = new URL(configuredPath, windowValue.location.href);
  } catch {
    return false;
  }
  if (target.origin !== windowValue.location.origin
    || target.username !== "" || target.password !== ""
    || target.search !== "" || target.hash !== "") return false;
  try {
    windowValue.location.assign(target.toString());
    return true;
  } catch {
    return false;
  }
}
