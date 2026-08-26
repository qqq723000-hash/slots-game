import { parseExactHttpsHostOrigin } from "../protocol/rgsHostOrigin";
import { isWindowFramed } from "./operatorSessionBridge";

export const OPERATOR_SHELL_REQUEST_EVENT = "slots-game:operator-shell-request";
export const OPERATOR_SHELL_HOST_MESSAGE_TYPE = OPERATOR_SHELL_REQUEST_EVENT;
export const OPERATOR_SHELL_HOST_MESSAGE_VERSION = 1 as const;

export type OperatorShellAction = "home" | "exit";

/**
 * 这只是一个自愿请求。接收或发出该值并不表示宿主已接受请求，
 * 也不表示导航已完成。
 */
export interface OperatorShellRequest {
  readonly action: OperatorShellAction;
}

export type OperatorShellRequestHandler = (
  request: Readonly<OperatorShellRequest>,
) => void;

export interface OperatorShellHostMessage extends OperatorShellRequest {
  readonly type: typeof OPERATOR_SHELL_HOST_MESSAGE_TYPE;
  readonly version: typeof OPERATOR_SHELL_HOST_MESSAGE_VERSION;
}

function isPlainClosedRequest(value: unknown): value is Readonly<OperatorShellRequest> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== 1 || ownKeys[0] !== "action") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "action");
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    return descriptor.value === "home" || descriptor.value === "exit";
  } catch {
    return false;
  }
}

/**
 * 运行时校验刻意采用封闭策略：只有白名单中的 action 字段可跨越两个宿主边界。
 * 出现未知的诊断、URL 或凭据字段会使整个请求无效，而不会被静默转发。
 */
export function validateOperatorShellRequest(
  value: unknown,
): Readonly<OperatorShellRequest> | null {
  if (!isPlainClosedRequest(value)) return null;
  return Object.freeze({ action: value.action });
}

/**
 * 为嵌入的同源宿主发出同页面请求；位于框架内时，还会向唯一配置的规范 HTTPS
 * 来源发送带版本的消息。此端口绝不会关闭窗口、变更位置或声称宿主已执行操作。
 */
export function requestOperatorShellAction(
  windowValue: Window | undefined,
  request: unknown,
  configuredHostOrigin?: string | null,
): void {
  if (!windowValue) return;
  const safeRequest = validateOperatorShellRequest(request);
  if (!safeRequest) return;

  if (typeof windowValue.dispatchEvent === "function" && typeof CustomEvent === "function") {
    try {
      windowValue.dispatchEvent(new CustomEvent<Readonly<OperatorShellRequest>>(
        OPERATOR_SHELL_REQUEST_EVENT,
        { detail: safeRequest },
      ));
    } catch {
      // 若同页面集成失败，父级通道仍然可用。
    }
  }

  let targetOrigin: string | null;
  try {
    targetOrigin = parseExactHttpsHostOrigin(configuredHostOrigin ?? undefined);
  } catch {
    return;
  }
  if (!targetOrigin || !isWindowFramed(windowValue)) return;

  const message: Readonly<OperatorShellHostMessage> = Object.freeze({
    type: OPERATOR_SHELL_HOST_MESSAGE_TYPE,
    version: OPERATOR_SHELL_HOST_MESSAGE_VERSION,
    action: safeRequest.action,
  });
  try {
    windowValue.parent.postMessage(message, targetOrigin);
  } catch {
    // 请求桥接仅尽力而为；游戏必须停留在当前页面。
  }
}
