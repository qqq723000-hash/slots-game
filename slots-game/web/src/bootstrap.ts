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
    // 无论交接实现是否异常，生产入口都会在缺少 preflight 时失败关闭。
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
  // 无论 preflight 是否下载成功，模块入口都必须先同步清理一次性片段。
  // 正式产物若没有看到已锁定的经典 preflight，只能显示固定失败外壳；
  // 禁止在网络、CDN 或 CSP 单点故障时绕过能力检测后装配主应用。
  burnEarlyLaunchHandoff(window);
  [opaqueLaunchPageUrl, hadLaunchHandoff] = scrubLaunchFragment(window);
  if (import.meta.env.PROD) {
    opaqueLaunchPageUrl = null;
    launchHandoff = Promise.reject(new Error("Browser preflight state is missing"));
  } else {
    // Vitest/直接模块宿主没有生产 HTML，仍可单独验证同步清理与交接。
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
  // 下游代码块或 DOM 契约失败时只显示固定文案，禁止把不透明 URL/异常文本写入 DOM 或日志。
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
