const RGS_FRAGMENT_KEYS = [
  "rgsLaunchCode",
  "rgsOperatorId",
  "rgsSessionId",
] as const;

const PUBLIC_BOOTSTRAP_FAILURE = "The game could not start. Please try again.";

/**
 * 一次性凭据必须在任何应用依赖求值前从地址栏清除。这里只按键删除，
 * 不解析字段值、不访问存储；原始 URL 仅作为短生命周期不透明参数交给网关。
 */
export function scrubLaunchFragment(windowValue: Window): readonly [string, boolean] {
  const opaquePageUrl = windowValue.location.href;
  const scrubbedUrl = new URL(opaquePageUrl);
  const parameters = new URLSearchParams(
    scrubbedUrl.hash.startsWith("#") ? scrubbedUrl.hash.slice(1) : scrubbedUrl.hash,
  );
  let containsLaunchHandoff = false;
  for (const key of RGS_FRAGMENT_KEYS) {
    if (parameters.has(key)) containsLaunchHandoff = true;
    parameters.delete(key);
  }
  if (containsLaunchHandoff) {
    const remaining = parameters.toString();
    scrubbedUrl.hash = remaining ? `#${remaining}` : "";
    const sanitizedUrl = scrubbedUrl.toString();
    try {
      windowValue.history.replaceState(windowValue.history.state, "", sanitizedUrl);
    } catch {
      // 不透明来源/沙箱可能禁止历史记录 API；此时只能导航到已去凭据 URL，
      // 并立即终止当前模块，禁止继续加载应用或在错误中携带原始 URL。
      try {
        windowValue.location.replace(sanitizedUrl);
      } catch {
        // 导航 API 同样不可用时仍以固定错误终止，绝不输出或恢复一次性凭据。
      }
      throw new Error("Launch fragment sanitization navigation requested");
    }
  }
  return [opaquePageUrl, containsLaunchHandoff] as const;
}

let opaqueLaunchPageUrl: string | null;
let hadLaunchHandoff: boolean;
[opaqueLaunchPageUrl, hadLaunchHandoff] = scrubLaunchFragment(window);

export const applicationBootstrap: Promise<void> = import("./main").then(
  ({ startApplication }) => {
    const launchPageUrl = opaqueLaunchPageUrl;
    opaqueLaunchPageUrl = null;
    if (launchPageUrl === null) throw new Error("Launch handoff is unavailable");
    startApplication(launchPageUrl);
  },
  (error: unknown) => {
    opaqueLaunchPageUrl = null;
    throw error;
  },
);

void applicationBootstrap.catch(() => {
  opaqueLaunchPageUrl = null;
  notifyOperatorAfterBootstrapFailure();
  const root = document.querySelector<HTMLElement>("#app");
  const loading = root?.querySelector<HTMLElement>('[data-role="launch-loading"]');
  const status = loading?.querySelector<HTMLElement>(".launch-loading__status");
  // 下游代码块或 DOM 契约失败时只显示固定文案，禁止把不透明 URL/异常文本写入 DOM 或日志。
  if (status) status.textContent = PUBLIC_BOOTSTRAP_FAILURE;
});

function notifyOperatorAfterBootstrapFailure(): void {
  if (!hadLaunchHandoff) return;
  const configuredOrigin: unknown = import.meta.env.VITE_RGS_HOST_ORIGIN;
  if (typeof configuredOrigin !== "string") return;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(configuredOrigin);
  } catch {
    return;
  }
  if (parsedOrigin.protocol !== "https:"
    || parsedOrigin.username !== "" || parsedOrigin.password !== ""
    || parsedOrigin.pathname !== "/" || parsedOrigin.search !== "" || parsedOrigin.hash !== ""
    || parsedOrigin.origin !== configuredOrigin) return;

  // 主模块尚未加载时只能使用固定白名单消息；不附带异常、URL 或片段字段值。
  const message = Object.freeze({
    type: "slots-game:operator-session-required",
    version: 1,
    reason: "initial-session-failed",
    code: "OPERATOR_SESSION_REQUIRED",
  });
  try {
    if (window.parent === window) return;
    window.parent.postMessage(message, parsedOrigin.origin);
  } catch {
    // 宿主旁路不可用时仍保持启动失败，绝不改用通配符 targetOrigin。
  }
}
