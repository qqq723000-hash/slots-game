import { parseExactHttpsHostOrigin } from "../protocol/rgsHostOrigin";
import { isWindowFramed } from "./operatorSessionBridge";

export const OPERATOR_SHELL_REQUEST_EVENT = "slots-game:operator-shell-request";
export const OPERATOR_SHELL_HOST_MESSAGE_TYPE = OPERATOR_SHELL_REQUEST_EVENT;
export const OPERATOR_SHELL_HOST_MESSAGE_VERSION = 1 as const;

export type OperatorShellAction = "home" | "exit";

/**
 * 这只是一个自愿请求。接收或发出该值并不表示宿主已接受请求，
 * 也不表示导航已完成。
 *
 * 英文 / English: This is a voluntary request only. Receiving or emitting this value does not indicate that the host has accepted the request, nor that navigation is complete.
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
 *
 * 英文 / English: Runtime verification adopts a deliberately closed strategy: only the action fields in the whitelist can cross the two host boundaries. The presence of unknown diagnostic, URL, or credential fields invalidates the entire request and will not be forwarded silently.
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
 *
 * 英文 / English: Makes a same-page request for the embedded origin host; when inside a frame, also sends a versioned message to the unique configured canonical HTTPS origin. This port will never close the window, change location, or claim that the host has performed an action.
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
      // 若同页面集成失败，父级通道仍然可用。 / English: If integration with the same page fails, the parent channel is still available.
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
    // 请求桥接仅尽力而为；游戏必须停留在当前页面。 / English: Requesting a bridge is a best-effort effort only; the game must stay on the current page.
  }
}
