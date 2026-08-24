import type { GameGateway } from "./GameGateway";
import {
  JsonRgsRecoveryLedgerStorage,
  RgsGateway,
  RgsGatewayConfigurationError,
  type RgsGatewayConfig,
  type RgsRecoveryLedgerStorage,
} from "./RgsGateway";
import { parseExactHttpsHostOrigin } from "./rgsHostOrigin";

const RGS_FRAGMENT_KEYS = [
  "rgsLaunchCode",
  "rgsOperatorId",
  "rgsSessionId",
] as const;

const RGS_STORAGE_PROBE_KEY = "slots-game:rgs-ledger-storage-probe:v1";
const RGS_STORAGE_PROBE_VALUE = "writable-v1";

export interface GatewayEnvironment {
  readonly VITE_RGS_BASE_URL?: string;
  readonly VITE_RGS_BET_OPTIONS_MINOR?: string;
  readonly VITE_RGS_DEFAULT_BET_MINOR?: string;
  readonly VITE_RGS_HOST_ORIGIN?: string;
}

export interface GatewayHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface ConfiguredGatewayOptions {
  readonly env: GatewayEnvironment;
  readonly pageUrl: string;
  readonly history: GatewayHistory;
  readonly isFramed?: boolean;
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly rgsDependencies?: Pick<
    RgsGatewayConfig,
    | "fetch"
    | "ledgerStorage"
    | "timers"
    | "now"
    | "monotonicNow"
    | "sessionStatusIntervalMs"
    | "requestId"
    | "requestTimeoutMs"
    | "pollDelayMs"
    | "maxPollAttempts"
    | "bindingFingerprint"
  >;
}

function fragmentValues(url: URL): Map<typeof RGS_FRAGMENT_KEYS[number], string | undefined> {
  const parameters = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const result = new Map<typeof RGS_FRAGMENT_KEYS[number], string | undefined>();
  for (const key of RGS_FRAGMENT_KEYS) {
    const values = parameters.getAll(key);
    if (values.length > 1) {
      throw new RgsGatewayConfigurationError(`URL fragment contains duplicate ${key}`);
    }
    result.set(key, values[0]);
  }
  return result;
}

function scrubRgsFragment(url: URL, history: GatewayHistory): void {
  const parameters = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  RGS_FRAGMENT_KEYS.forEach((key) => parameters.delete(key));
  const remaining = parameters.toString();
  url.hash = remaining ? `#${remaining}` : "";
  history.replaceState(history.state, "", url.toString());
}

function betOptions(value: string): string[] {
  const options = value.split(",");
  if (options.length === 0 || options.some((option) => option === "" || option.trim() !== option)) {
    throw new RgsGatewayConfigurationError(
      "VITE_RGS_BET_OPTIONS_MINOR must be a comma-separated canonical decimal list",
    );
  }
  return options;
}

function assertWritableRecoveryStorage(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  let previous: string | null | undefined;
  let restoreRequired = false;
  try {
    previous = storage.getItem(RGS_STORAGE_PROBE_KEY);
    const probeValue = previous === RGS_STORAGE_PROBE_VALUE
      ? `${RGS_STORAGE_PROBE_VALUE}-alternate`
      : RGS_STORAGE_PROBE_VALUE;
    restoreRequired = true;
    storage.setItem(RGS_STORAGE_PROBE_KEY, probeValue);
    if (storage.getItem(RGS_STORAGE_PROBE_KEY) !== probeValue) {
      throw new Error("storage write was not durable");
    }
    if (previous === null) storage.removeItem(RGS_STORAGE_PROBE_KEY);
    else storage.setItem(RGS_STORAGE_PROBE_KEY, previous);
    restoreRequired = false;
    if (storage.getItem(RGS_STORAGE_PROBE_KEY) !== previous) {
      throw new Error("storage probe cleanup failed");
    }
  } catch {
    if (restoreRequired && previous !== undefined) {
      try {
        if (previous === null) storage.removeItem(RGS_STORAGE_PROBE_KEY);
        else storage.setItem(RGS_STORAGE_PROBE_KEY, previous);
      } catch {
        // 预检已经失败；清理异常不能覆盖统一、无底层细节的配置错误。
      }
    }
    throw new RgsGatewayConfigurationError(
      "Production RGS requires writable recovery ledger storage",
    );
  }
}

/**
 * 生产入口只允许完整的 HTTPS RGS 配置与一次性交接值。任何缺失或畸形输入
 * 都必须故障关闭，禁止浏览器切换到未认证的备用传输。
 */
export function createConfiguredGameGateway(options: ConfiguredGatewayOptions): GameGateway {
  const pageUrl = new URL(options.pageUrl);
  let fragments: Map<typeof RGS_FRAGMENT_KEYS[number], string | undefined>;
  try {
    fragments = fragmentValues(pageUrl);
  } catch (error) {
    scrubRgsFragment(pageUrl, options.history);
    throw error;
  }
  const environmentValues = [
    options.env.VITE_RGS_BASE_URL,
    options.env.VITE_RGS_BET_OPTIONS_MINOR,
    options.env.VITE_RGS_DEFAULT_BET_MINOR,
    options.env.VITE_RGS_HOST_ORIGIN,
  ];
  // 无论配置是否完整都先清除一次性凭据，禁止失败页把它留在地址栏、截图或浏览器历史中。
  scrubRgsFragment(pageUrl, options.history);
  const launchCode = fragments.get("rgsLaunchCode");
  const operatorId = fragments.get("rgsOperatorId");
  const sessionId = fragments.get("rgsSessionId");
  const [baseUrl, configuredBets, defaultBetMinor, configuredHostOrigin] = environmentValues;
  if ([launchCode, operatorId, sessionId, baseUrl, configuredBets, defaultBetMinor]
    .some((value) => value === undefined || value === "")) {
    throw new RgsGatewayConfigurationError(
      "Production RGS activation requires all environment and fragment fields",
    );
  }

  const normalizedBets = betOptions(configuredBets!);
  let operatorHostOrigin: string | null;
  try {
    operatorHostOrigin = parseExactHttpsHostOrigin(configuredHostOrigin);
  } catch (error) {
    throw new RgsGatewayConfigurationError(
      error instanceof Error ? error.message : "RGS host origin is invalid",
    );
  }
  if (options.isFramed && !operatorHostOrigin) {
    // 跨源 iframe 无法依赖子窗口 CustomEvent；没有精确宿主来源时禁止启动，
    // 绝不使用 `*` 绕过一次性会话的安全恢复边界。
    throw new RgsGatewayConfigurationError(
      "framed RGS requires VITE_RGS_HOST_ORIGIN",
    );
  }

  let ledgerStorage: RgsRecoveryLedgerStorage | undefined = options.rgsDependencies?.ledgerStorage;
  if (!ledgerStorage) {
    if (!options.sessionStorage) {
      throw new RgsGatewayConfigurationError(
        "Production RGS requires writable recovery ledger storage",
      );
    }
    // 资金恢复不变量：会话交换前必须证明浏览器能同步持久化并清理轮次账本。
    // 若此处降级，下注可能已提交却没有可恢复的原始轮次证据。
    assertWritableRecoveryStorage(options.sessionStorage);
    ledgerStorage = new JsonRgsRecoveryLedgerStorage(options.sessionStorage);
  }
  return new RgsGateway({
    ...options.rgsDependencies,
    baseUrl: baseUrl!,
    launchCode: launchCode!,
    operatorId: operatorId!,
    sessionId: sessionId!,
    betOptionsMinor: normalizedBets,
    defaultBetMinor: defaultBetMinor!,
    ...(operatorHostOrigin ? { operatorHostOrigin } : {}),
    ledgerStorage,
  });
}

export function optionalWindowSessionStorage(windowValue: Window): Storage | null {
  try {
    return windowValue.sessionStorage;
  } catch {
    return null;
  }
}
