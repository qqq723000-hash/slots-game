const RGS_FRAGMENT_KEYS = [
  "rgsLaunchCode",
  "rgsOperatorId",
  "rgsSessionId",
] as const;

const PUBLIC_BOOTSTRAP_FAILURE = "The game could not start. Please try again.";
const APPLICATION_MODULE_TIMEOUT_MS = 15_000;

/**
 * 一次性凭据必须在任何应用依赖求值前从地址栏清除。这里只按键删除，
 * 不解析字段值、不访问存储；原始 URL 仅作为短生命周期不透明参数交给网关。
 *
 * 英文 / English: One-time credentials must be cleared from the address bar before any application dependencies are evaluated. Here, only key deletion is performed, field values ​​are not parsed, and storage is not accessed; the original URL is only given to the gateway as a short-lifecycle opaque parameter.
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
      // 不透明来源/沙箱可能禁止历史记录 API；此时只能导航到已去凭据 URL， / English: Opaque origins/sandboxes may disable the History API; only navigation to the de-credentialed URL is possible at this time,
      // 并立即终止当前模块，禁止继续加载应用或在错误中携带原始 URL。 / English: and immediately terminates the current module, disabling further application loading or carrying the original URL in the error.
      try {
        windowValue.location.replace(sanitizedUrl);
      } catch {
        // 导航 API 同样不可用时仍以固定错误终止，绝不输出或恢复一次性凭据。 / English: The Navigation API still terminates with a fixed error when also unavailable and never outputs or restores one-time credentials.
      }
      throw new Error("Launch fragment sanitization navigation requested");
    }
  }
  return [opaquePageUrl, containsLaunchHandoff] as const;
}

interface BrowserPreflightState {
  readonly schema: 1;
  readonly supported: boolean;
  readonly hadLaunchHandoff: boolean;
  readonly takeLaunchHandoff: () => unknown;
}

interface BrowserPreflightHandoff {
  readonly pageUrl: string;
  readonly hadLaunchHandoff: boolean;
}

interface EarlyLaunchHandoffState {
  readonly schema: 1;
  readonly hadLaunchHandoff: boolean;
  readonly take: () => unknown;
}

/**
 * 内联片段清理器可能已暂存原始 URL，但外部 preflight 下载失败。此时模块入口必须
 * 同步消费并丢弃该一次性交接，不能让凭据继续等待兜底超时。
 *
 * 英文 / English: The inline fragment cleaner may have staged the original URL, but the external preflight download failed. At this time, the module entrance must synchronize consumption and discard the one-time handover, and the credentials cannot continue to wait for the timeout.
 */
function burnEarlyLaunchHandoff(windowValue: Window): void {
  try {
    const value = (windowValue as Window & { __slotsEarlyLaunchHandoff?: unknown })
      .__slotsEarlyLaunchHandoff;
    const ownKeys = value !== null && typeof value === "object" ? Object.keys(value) : [];
    if (value === null || typeof value !== "object"
      || !Object.isFrozen(value)
      || ownKeys.length !== 3
      || !["hadLaunchHandoff", "schema", "take"].every((key) => ownKeys.includes(key))
      || (value as { schema?: unknown }).schema !== 1
      || typeof (value as { hadLaunchHandoff?: unknown }).hadLaunchHandoff !== "boolean"
      || typeof (value as { take?: unknown }).take !== "function") return;
    (value as EarlyLaunchHandoffState).take();
  } catch {
    // 无论交接实现是否异常，生产入口都会在缺少 preflight 时失败关闭。 / English: Regardless of whether the handover implementation is abnormal or not, the production portal will fail to close when preflight is missing.
  }
}

function browserPreflightState(windowValue: Window): BrowserPreflightState | null | undefined {
  const value = (windowValue as Window & { __slotsBrowserPreflight?: unknown })
    .__slotsBrowserPreflight;
  if (value === undefined) return undefined;
  const ownKeys = value !== null && typeof value === "object" ? Object.keys(value) : [];
  if (value === null || typeof value !== "object"
    || !Object.isFrozen(value)
    || ownKeys.length !== 4
    || !["hadLaunchHandoff", "schema", "supported", "takeLaunchHandoff"]
      .every((key) => ownKeys.includes(key))
    || (value as { schema?: unknown }).schema !== 1
    || typeof (value as { supported?: unknown }).supported !== "boolean"
    || typeof (value as { hadLaunchHandoff?: unknown }).hadLaunchHandoff !== "boolean"
    || typeof (value as { takeLaunchHandoff?: unknown }).takeLaunchHandoff !== "function") {
    return null;
  }
  return value as BrowserPreflightState;
}

let opaqueLaunchPageUrl: string | null = null;
let hadLaunchHandoff = false;
const preflight = browserPreflightState(window);
let launchHandoff: Promise<string | null>;

if (preflight === undefined) {
  // 无论 preflight 是否下载成功，模块入口都必须先同步清理一次性片段。 / English: Regardless of whether preflight is downloaded successfully, the module entry must first clean up the one-time fragment synchronously.
  // 正式产物若没有看到已锁定的经典 preflight，只能显示固定失败外壳； / English: If the official product does not see the locked classic preflight, it will only display the fixed failure shell;
  // 禁止在网络、CDN 或 CSP 单点故障时绕过能力检测后装配主应用。 / English: It is prohibited to assemble the main application after bypassing capability detection in the event of a network, CDN or CSP single point of failure.
  burnEarlyLaunchHandoff(window);
  [opaqueLaunchPageUrl, hadLaunchHandoff] = scrubLaunchFragment(window);
  if (import.meta.env.PROD) {
    opaqueLaunchPageUrl = null;
    launchHandoff = Promise.reject(new Error("Browser preflight state is missing"));
  } else {
    // Vitest/直接模块宿主没有生产 HTML，仍可单独验证同步清理与交接。 / English: Vitest/direct module hosting does not produce HTML and can still independently verify synchronized cleanup and handover.
    launchHandoff = Promise.resolve(opaqueLaunchPageUrl);
  }
} else if (preflight === null || !preflight.supported) {
  launchHandoff = preflight === null
    ? Promise.reject(new Error("Browser preflight state is invalid"))
    : Promise.resolve(null);
} else {
  try {
    const detail = preflight.takeLaunchHandoff();
    if (detail === null || typeof detail !== "object"
      || typeof (detail as { pageUrl?: unknown }).pageUrl !== "string"
      || (detail as { pageUrl: string }).pageUrl === ""
      || (detail as { hadLaunchHandoff?: unknown }).hadLaunchHandoff
        !== preflight.hadLaunchHandoff) {
      throw new Error("Browser preflight handoff is invalid");
    }
    const accepted = detail as BrowserPreflightHandoff;
    hadLaunchHandoff = accepted.hadLaunchHandoff;
    opaqueLaunchPageUrl = accepted.pageUrl;
    launchHandoff = Promise.resolve(accepted.pageUrl);
  } catch {
    launchHandoff = Promise.reject(new Error("Browser preflight handoff is invalid"));
  }
}

export const applicationBootstrap: Promise<void> = launchHandoff.then(async (launchPageUrl) => {
  if (launchPageUrl === null) return;
  try {
    const { startApplication } = await importApplicationModule();
    opaqueLaunchPageUrl = null;
    startApplication(launchPageUrl);
  } catch (error) {
    opaqueLaunchPageUrl = null;
    throw error;
  }
});

void applicationBootstrap.catch(() => {
  opaqueLaunchPageUrl = null;
  notifyOperatorAfterBootstrapFailure();
  const root = document.querySelector<HTMLElement>("#app");
  const loading = root?.querySelector<HTMLElement>('[data-role="launch-loading"]');
  const status = loading?.querySelector<HTMLElement>(".launch-loading__status");
  // 下游代码块或 DOM 契约失败时只显示固定文案，禁止把不透明 URL/异常文本写入 DOM 或日志。 / English: Only fixed text will be displayed when a downstream code block or DOM contract fails, and opaque URL/exception text will not be written to the DOM or log.
  if (root) root.dataset.browserCompatibility = "bootstrap-failed";
  if (loading) {
    loading.dataset.visible = "true";
    loading.dataset.stage = "bootstrap-failed";
    loading.setAttribute("aria-hidden", "false");
    loading.removeAttribute("inert");
  }
  if (status) status.textContent = PUBLIC_BOOTSTRAP_FAILURE;
});

async function importApplicationModule(): Promise<typeof import("./main")> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      import("./main"),
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timeoutHandle = setTimeout(() => {
          rejectPromise(new Error("Application module load timed out"));
        }, APPLICATION_MODULE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

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

  // 主模块尚未加载时只能使用固定白名单消息；不附带异常、URL 或片段字段值。 / English: Only fixed whitelist messages are available when the main module has not been loaded; no exception, URL or fragment field values ​​are attached.
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
    // 宿主旁路不可用时仍保持启动失败，绝不改用通配符 targetOrigin。 / English: Keep startup failing when host bypass is unavailable, never use wildcard targetOrigin instead.
  }
}
