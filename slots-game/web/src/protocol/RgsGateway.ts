import type {
  FeatureMode,
  FeatureState,
  MoneyMinor,
  ServerError,
  SpinResult,
} from "../app/state/types";
import type {
  GameGateway,
  GatewayCallbacks,
  ResultDeliveryStage,
} from "./GameGateway";
import { createRequestId } from "./messages";
import {
  decodeResultDeliveryAcknowledgement,
  decodePendingResultDelivery,
  decodeRgsError,
  decodeRgsExchange,
  decodeRgsRoundStatus,
  decodeRgsSpin,
  parseRgsJson,
  rgsSessionOpened,
  type DecodedRgsExchange,
  type DecodedPendingResultDelivery,
  type DecodedRgsSession,
  type DecodedRgsSpin,
  type RgsBinding,
  type RgsRoundKind,
  RgsProtocolError,
} from "./rgsDecoder";
import { classifySpinResult } from "./spinResultGuard";
import { validateSpinResultAgainstOrigin } from "./spinResultOriginGuard";
import { parseExactHttpsHostOrigin } from "./rgsHostOrigin";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  NetworkResponseBodyError,
  NetworkResponseLimitError,
  readBoundedResponseText,
} from "../network/boundedResponse";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LAUNCH_CODE_PATTERN = /^lc_[A-Za-z0-9_-]{43}$/;
const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_DELAY_MS = 250;
const DEFAULT_MAX_POLL_ATTEMPTS = 24;
const DEFAULT_ACKNOWLEDGEMENT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_ACKNOWLEDGEMENT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_ACKNOWLEDGEMENT_MAX_ATTEMPTS = 8;
const DEFAULT_ACKNOWLEDGEMENT_RETRY_WINDOW_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const IMF_FIXDATE_PATTERN = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/;

export class RgsGatewayConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RgsGatewayConfigurationError";
  }
}

export interface RgsRecoveryLedger {
  readonly version: 2;
  readonly bindingFingerprint: string;
  readonly roundId: string;
  readonly betMinor: MoneyMinor;
  readonly startRevision: string;
  readonly originFeatureState: Readonly<FeatureState>;
}

interface LegacyRgsRecoveryLedger {
  readonly version: 1;
  readonly bindingFingerprint: string;
  readonly roundId: string;
  readonly betMinor: MoneyMinor;
  readonly startRevision: string;
  readonly originMode: FeatureMode;
}

type DecodedRgsRecoveryLedger = RgsRecoveryLedger | LegacyRgsRecoveryLedger;

export interface RgsRecoveryLedgerStorage {
  load(): unknown | null;
  save(ledger: Readonly<RgsRecoveryLedger>): void;
  clear(): void;
}

export class JsonRgsRecoveryLedgerStorage implements RgsRecoveryLedgerStorage {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
    private readonly key = "slots-game:rgs-round-ledger:v1",
  ) {
    if (!storage || typeof storage.getItem !== "function"
      || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
      throw new RgsGatewayConfigurationError("RGS ledger storage must implement the Storage contract");
    }
    if (!IDENTIFIER_PATTERN.test(key)) {
      throw new RgsGatewayConfigurationError("RGS ledger storage key must be a protocol identifier");
    }
  }

  load(): unknown | null {
    const encoded = this.storage.getItem(this.key);
    if (encoded === null) return null;
    try {
      return JSON.parse(encoded) as unknown;
    } catch {
      throw new RgsProtocolError("persisted RGS recovery ledger is not valid JSON");
    }
  }

  save(ledger: Readonly<RgsRecoveryLedger>): void {
    // 必须保持显式字段白名单；令牌、启动码、钱包标识、请求体与结果
    // 均不得进入浏览器持久化。
    const originFeatureState = persistedLedgerFeatureState(
      ledger.originFeatureState,
      ledger.betMinor,
    );
    this.storage.setItem(this.key, JSON.stringify({
      version: 2,
      bindingFingerprint: ledger.bindingFingerprint,
      roundId: ledger.roundId,
      betMinor: ledger.betMinor,
      startRevision: ledger.startRevision,
      originFeatureState,
    }));
  }

  clear(): void {
    this.storage.removeItem(this.key);
  }
}

export interface RgsGatewayTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RgsGatewayConfig {
  readonly baseUrl: string;
  readonly launchCode: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly betOptionsMinor: readonly MoneyMinor[];
  readonly defaultBetMinor: MoneyMinor;
  readonly operatorHostOrigin?: string;
  readonly fetch?: typeof fetch;
  readonly ledgerStorage?: RgsRecoveryLedgerStorage;
  readonly timers?: RgsGatewayTimers;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly requestTimeoutMs?: number;
  readonly pollDelayMs?: number;
  readonly maxPollAttempts?: number;
  readonly acknowledgementRetryBaseDelayMs?: number;
  readonly acknowledgementRetryMaxDelayMs?: number;
  readonly acknowledgementMaxAttempts?: number;
  readonly acknowledgementRetryWindowMs?: number;
  readonly bindingFingerprint?: (binding: Readonly<RgsBinding>) => Promise<string>;
}

interface ValidatedConfig {
  readonly baseUrl: string;
  readonly exchangeUrl: string;
  readonly refreshUrl: string;
  readonly spinUrl: string;
  readonly statusUrl: string;
  readonly acknowledgementUrl: string;
  readonly pendingResultUrl: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly betOptionsMinor: readonly MoneyMinor[];
  readonly defaultBetMinor: MoneyMinor;
  readonly operatorHostOrigin?: string;
  readonly fetch: typeof fetch;
  readonly ledgerStorage?: RgsRecoveryLedgerStorage;
  readonly timers: RgsGatewayTimers;
  readonly now: () => number;
  readonly requestId: () => string;
  readonly requestTimeoutMs: number;
  readonly pollDelayMs: number;
  readonly maxPollAttempts: number;
  readonly acknowledgementRetryBaseDelayMs: number;
  readonly acknowledgementRetryMaxDelayMs: number;
  readonly acknowledgementMaxAttempts: number;
  readonly acknowledgementRetryWindowMs: number;
  readonly bindingFingerprint: (binding: Readonly<RgsBinding>) => Promise<string>;
}

interface PendingRound {
  readonly ledger: DecodedRgsRecoveryLedger;
  readonly roundKind: Exclude<RgsRoundKind, "BONUS">;
  originFeatureState: Readonly<FeatureState> | null;
  pollAttempts: number;
  spinAttempts: number;
  blocked: boolean;
  deliveredSequence: number | null;
  deliveredResultHash: string | null;
  acknowledgementInFlight: boolean;
  acknowledgementAttempts: number;
  acknowledgementStartedAtMs: number | null;
  acknowledgementExhausted: boolean;
}

class RgsHttpError extends Error {
  constructor(
    readonly status: number,
    readonly requestId: string,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "RgsHttpError";
  }
}

class RgsNetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    /** 请求关联标识仅供诊断；AppController 永不渲染。 */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "RgsNetworkError";
  }
}

class RgsDeliveryError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "RgsDeliveryError";
  }
}

const NULL_CALLBACKS: GatewayCallbacks = {
  onStatus: () => undefined,
  onSession: () => undefined,
  onSpinResult: () => undefined,
  onError: () => undefined,
};

function canonicalMoney(value: unknown, path: string, positive = false): MoneyMinor {
  if (typeof value !== "string" || value.length > 19 || !MONEY_PATTERN.test(value)
    || BigInt(value) > MAX_SIGNED_INT64 || (positive && value === "0")) {
    throw new RgsGatewayConfigurationError(`${path} must be a canonical signed-int64 decimal string`);
  }
  return value;
}

function configuredInteger(
  value: number | undefined,
  fallback: number,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const decoded = value ?? fallback;
  if (!Number.isSafeInteger(decoded) || decoded < minimum || decoded > maximum) {
    throw new RgsGatewayConfigurationError(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return decoded;
}

/**
 * Retry-After 是不可信网络输入。只接受规范的正整数秒或 IMF-fixdate，且解析后的
 * 延迟必须落在本页 ACK 配置的安全上限内；负数、零、重复合并值和超大值一律忽略。
 */
function safeRetryAfterMs(value: string | null, nowMs: number, maximumMs: number): number | null {
  if (value === null) return null;
  let delayMs: number;
  if (/^[1-9][0-9]{0,5}$/.test(value)) {
    delayMs = Number(value) * 1_000;
  } else if (IMF_FIXDATE_PATTERN.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value) return null;
    delayMs = parsed - nowMs;
  } else {
    return null;
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 1_000 || delayMs > maximumMs) return null;
  return delayMs;
}

function endpoint(baseUrl: URL, path: string): string {
  const result = new URL(baseUrl.toString());
  result.pathname = `${result.pathname.replace(/\/$/, "")}${path}`;
  return result.toString();
}

function validateConfig(config: RgsGatewayConfig): ValidatedConfig {
  if (!config || typeof config !== "object") {
    throw new RgsGatewayConfigurationError("complete RGS gateway configuration is required");
  }
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new RgsGatewayConfigurationError("RGS baseUrl must be an absolute HTTPS URL");
  }
  if (base.protocol !== "https:" || base.username !== "" || base.password !== ""
    || base.search !== "" || base.hash !== "") {
    throw new RgsGatewayConfigurationError("RGS baseUrl must be a credential-free HTTPS origin/path");
  }
  base.pathname = base.pathname.replace(/\/$/, "");
  if (!LAUNCH_CODE_PATTERN.test(config.launchCode)) {
    throw new RgsGatewayConfigurationError("RGS launchCode is missing or malformed");
  }
  if (!IDENTIFIER_PATTERN.test(config.operatorId)) {
    throw new RgsGatewayConfigurationError("RGS operatorId is missing or malformed");
  }
  if (!IDENTIFIER_PATTERN.test(config.sessionId)) {
    throw new RgsGatewayConfigurationError("RGS sessionId is missing or malformed");
  }
  if (!Array.isArray(config.betOptionsMinor)
    || config.betOptionsMinor.length < 1 || config.betOptionsMinor.length > 100) {
    throw new RgsGatewayConfigurationError("RGS betOptionsMinor must contain 1-100 values");
  }
  const betOptionsMinor = config.betOptionsMinor.map((value, index) => (
    canonicalMoney(value, `RGS betOptionsMinor[${index}]`, true)
  ));
  if (new Set(betOptionsMinor).size !== betOptionsMinor.length) {
    throw new RgsGatewayConfigurationError("RGS betOptionsMinor must be unique");
  }
  const defaultBetMinor = canonicalMoney(config.defaultBetMinor, "RGS defaultBetMinor", true);
  if (!betOptionsMinor.includes(defaultBetMinor)) {
    throw new RgsGatewayConfigurationError("RGS defaultBetMinor must occur in betOptionsMinor");
  }
  let operatorHostOrigin: string | null;
  try {
    operatorHostOrigin = parseExactHttpsHostOrigin(config.operatorHostOrigin);
  } catch (error) {
    throw new RgsGatewayConfigurationError(
      error instanceof Error ? error.message : "RGS host origin is invalid",
    );
  }
  const fetchImplementation = config.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new RgsGatewayConfigurationError("RGS fetch implementation is required");
  }
  const nativeTimers: RgsGatewayTimers = {
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const acknowledgementRetryBaseDelayMs = configuredInteger(
    config.acknowledgementRetryBaseDelayMs,
    DEFAULT_ACKNOWLEDGEMENT_RETRY_BASE_DELAY_MS,
    "RGS acknowledgementRetryBaseDelayMs",
    100,
    10_000,
  );
  const acknowledgementRetryMaxDelayMs = configuredInteger(
    config.acknowledgementRetryMaxDelayMs,
    DEFAULT_ACKNOWLEDGEMENT_RETRY_MAX_DELAY_MS,
    "RGS acknowledgementRetryMaxDelayMs",
    100,
    60_000,
  );
  const acknowledgementRetryWindowMs = configuredInteger(
    config.acknowledgementRetryWindowMs,
    DEFAULT_ACKNOWLEDGEMENT_RETRY_WINDOW_MS,
    "RGS acknowledgementRetryWindowMs",
    1_000,
    600_000,
  );
  if (acknowledgementRetryMaxDelayMs < acknowledgementRetryBaseDelayMs
    || acknowledgementRetryWindowMs < acknowledgementRetryMaxDelayMs) {
    throw new RgsGatewayConfigurationError(
      "RGS acknowledgement retry delays must satisfy base <= max <= window",
    );
  }
  return Object.freeze({
    baseUrl: base.toString(),
    exchangeUrl: endpoint(base, "/client/v1/sessions/exchange"),
    refreshUrl: endpoint(base, "/client/v1/sessions/refresh"),
    spinUrl: endpoint(base, "/client/v1/spins"),
    statusUrl: endpoint(base, "/client/v1/rounds/status"),
    acknowledgementUrl: endpoint(base, "/client/v1/results/acknowledgements"),
    pendingResultUrl: endpoint(base, "/client/v1/results/pending"),
    operatorId: config.operatorId,
    sessionId: config.sessionId,
    betOptionsMinor: Object.freeze(betOptionsMinor),
    defaultBetMinor,
    ...(operatorHostOrigin ? { operatorHostOrigin } : {}),
    fetch: fetchImplementation.bind(globalThis),
    ...(config.ledgerStorage ? { ledgerStorage: config.ledgerStorage } : {}),
    timers: config.timers ?? nativeTimers,
    now: config.now ?? Date.now,
    requestId: config.requestId ?? (() => createRequestId("rgs")),
    requestTimeoutMs: configuredInteger(
      config.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "RGS requestTimeoutMs",
      100,
      120_000,
    ),
    pollDelayMs: configuredInteger(
      config.pollDelayMs,
      DEFAULT_POLL_DELAY_MS,
      "RGS pollDelayMs",
      10,
      60_000,
    ),
    maxPollAttempts: configuredInteger(
      config.maxPollAttempts,
      DEFAULT_MAX_POLL_ATTEMPTS,
      "RGS maxPollAttempts",
      1,
      100,
    ),
    acknowledgementRetryBaseDelayMs,
    acknowledgementRetryMaxDelayMs,
    acknowledgementMaxAttempts: configuredInteger(
      config.acknowledgementMaxAttempts,
      DEFAULT_ACKNOWLEDGEMENT_MAX_ATTEMPTS,
      "RGS acknowledgementMaxAttempts",
      1,
      20,
    ),
    acknowledgementRetryWindowMs,
    bindingFingerprint: config.bindingFingerprint ?? sha256BindingFingerprint,
  });
}

function cloneFeatureState(state: Readonly<FeatureState>): Readonly<FeatureState> {
  return Object.freeze({ ...state });
}

function isFeatureMode(value: unknown): value is FeatureMode {
  return value === "BASE" || value === "EXPANSION" || value === "OVERDRIVE";
}

const BASE_LEDGER_FEATURE_KEYS = [
  "mode",
  "freeSpinsRemaining",
  "freeSpinsPlayed",
  "rageLevel",
  "rageCollected",
] as const;

const ACTIVE_LEDGER_FEATURE_KEYS = [
  ...BASE_LEDGER_FEATURE_KEYS,
  "baseBetMinor",
  "freeSpinsWinMinor",
] as const;

function exactLedgerRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RgsProtocolError(`${path} must be an object`);
  }
  const decoded = value as Record<string, unknown>;
  if (Object.keys(decoded).length !== keys.length || keys.some((key) => !Object.hasOwn(decoded, key))) {
    throw new RgsProtocolError(`${path} has an unexpected shape`);
  }
  return decoded;
}

function ledgerInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = 1_000_000,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RgsProtocolError(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function decodeLedgerFeatureState(value: unknown, ledgerBetMinor: MoneyMinor): Readonly<FeatureState> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RgsProtocolError("ledger.originFeatureState must be an object");
  }
  const mode = (value as Record<string, unknown>).mode;
  if (!isFeatureMode(mode)) {
    throw new RgsProtocolError("ledger.originFeatureState.mode is unsupported");
  }
  const keys = mode === "BASE" ? BASE_LEDGER_FEATURE_KEYS : ACTIVE_LEDGER_FEATURE_KEYS;
  const decoded = exactLedgerRecord(value, keys, "ledger.originFeatureState");
  const freeSpinsRemaining = ledgerInteger(
    decoded.freeSpinsRemaining,
    "ledger.originFeatureState.freeSpinsRemaining",
    0,
  );
  const freeSpinsPlayed = ledgerInteger(
    decoded.freeSpinsPlayed,
    "ledger.originFeatureState.freeSpinsPlayed",
    0,
  );
  const rageLevel = ledgerInteger(decoded.rageLevel, "ledger.originFeatureState.rageLevel", 1);
  const rageCollected = ledgerInteger(
    decoded.rageCollected,
    "ledger.originFeatureState.rageCollected",
    0,
  );
  if (rageCollected === 0 && rageLevel !== 1) {
    throw new RgsProtocolError("ledger.originFeatureState has a non-canonical empty Rage meter");
  }
  if (mode === "BASE") {
    if (freeSpinsRemaining !== 0 || freeSpinsPlayed !== 0) {
      throw new RgsProtocolError("ledger.originFeatureState has a non-canonical Base projection");
    }
    return Object.freeze({
      mode,
      freeSpinsRemaining,
      freeSpinsPlayed,
      rageLevel,
      rageCollected,
    });
  }
  const baseBetMinor = canonicalMoneyForProtocol(
    decoded.baseBetMinor,
    "ledger.originFeatureState.baseBetMinor",
    true,
  );
  const freeSpinsWinMinor = canonicalMoneyForProtocol(
    decoded.freeSpinsWinMinor,
    "ledger.originFeatureState.freeSpinsWinMinor",
  );
  if (freeSpinsRemaining < 1
    || freeSpinsRemaining + freeSpinsPlayed > 1_000_000
    || baseBetMinor !== ledgerBetMinor) {
    throw new RgsProtocolError(
      "ledger.originFeatureState has invalid active Free Spins counters or locked bet",
    );
  }
  return Object.freeze({
    mode,
    freeSpinsRemaining,
    freeSpinsPlayed,
    baseBetMinor,
    freeSpinsWinMinor,
    rageLevel,
    rageCollected,
  });
}

function persistedLedgerFeatureState(
  state: Readonly<FeatureState>,
  ledgerBetMinor: MoneyMinor,
): Readonly<FeatureState> {
  const allowlisted = state.mode === "BASE"
    ? {
        mode: state.mode,
        freeSpinsRemaining: state.freeSpinsRemaining,
        freeSpinsPlayed: state.freeSpinsPlayed,
        rageLevel: state.rageLevel,
        rageCollected: state.rageCollected,
      }
    : {
        mode: state.mode,
        freeSpinsRemaining: state.freeSpinsRemaining,
        freeSpinsPlayed: state.freeSpinsPlayed,
        rageLevel: state.rageLevel,
        rageCollected: state.rageCollected,
        baseBetMinor: state.baseBetMinor,
        freeSpinsWinMinor: state.freeSpinsWinMinor,
      };
  return decodeLedgerFeatureState(allowlisted, ledgerBetMinor);
}

function decodeLedgerCommon(decoded: Record<string, unknown>): Readonly<{
  bindingFingerprint: string;
  roundId: string;
  betMinor: MoneyMinor;
  startRevision: string;
}> {
  if (typeof decoded.bindingFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(decoded.bindingFingerprint)
    || typeof decoded.roundId !== "string" || !IDENTIFIER_PATTERN.test(decoded.roundId)
    || typeof decoded.betMinor !== "string"
    || typeof decoded.startRevision !== "string") {
    throw new RgsProtocolError("persisted RGS recovery ledger contains invalid fields");
  }
  const betMinor = canonicalMoneyForProtocol(decoded.betMinor, "ledger.betMinor", true);
  const startRevision = canonicalMoneyForProtocol(decoded.startRevision, "ledger.startRevision");
  return Object.freeze({
    bindingFingerprint: decoded.bindingFingerprint,
    roundId: decoded.roundId,
    betMinor,
    startRevision,
  });
}

function decodeLedger(value: unknown): DecodedRgsRecoveryLedger {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RgsProtocolError("persisted RGS recovery ledger must be an object");
  }
  const version = (value as Record<string, unknown>).version;
  if (version === 1) {
    const decoded = exactLedgerRecord(value, [
      "version",
      "bindingFingerprint",
      "roundId",
      "betMinor",
      "startRevision",
      "originMode",
    ], "persisted RGS recovery ledger");
    const common = decodeLedgerCommon(decoded);
    if (!isFeatureMode(decoded.originMode)) {
      throw new RgsProtocolError("persisted RGS recovery ledger contains invalid fields");
    }
    return Object.freeze({ version, ...common, originMode: decoded.originMode });
  }
  if (version === 2) {
    const decoded = exactLedgerRecord(value, [
      "version",
      "bindingFingerprint",
      "roundId",
      "betMinor",
      "startRevision",
      "originFeatureState",
    ], "persisted RGS recovery ledger");
    const common = decodeLedgerCommon(decoded);
    return Object.freeze({
      version,
      ...common,
      originFeatureState: decodeLedgerFeatureState(decoded.originFeatureState, common.betMinor),
    });
  }
  throw new RgsProtocolError("persisted RGS recovery ledger version is unsupported");
}

function ledgerOriginMode(ledger: Readonly<DecodedRgsRecoveryLedger>): FeatureMode {
  return ledger.version === 2 ? ledger.originFeatureState.mode : ledger.originMode;
}

function sameFeatureState(left: Readonly<FeatureState>, right: Readonly<FeatureState>): boolean {
  return left.mode === right.mode
    && left.freeSpinsRemaining === right.freeSpinsRemaining
    && (left.freeSpinsPlayed ?? 0) === (right.freeSpinsPlayed ?? 0)
    && left.baseBetMinor === right.baseBetMinor
    && left.freeSpinsWinMinor === right.freeSpinsWinMinor
    && left.rageLevel === right.rageLevel
    && left.rageCollected === right.rageCollected;
}

function canonicalMoneyForProtocol(value: unknown, path: string, positive = false): MoneyMinor {
  if (typeof value !== "string" || value.length > 19 || !MONEY_PATTERN.test(value)
    || BigInt(value) > MAX_SIGNED_INT64 || (positive && value === "0")) {
    throw new RgsProtocolError(`${path} must be a canonical signed-int64 decimal string`);
  }
  return value;
}

function bindingPayload(binding: Readonly<RgsBinding>): Record<string, string | number> {
  return {
    operatorId: binding.operatorId,
    sessionId: binding.sessionId,
    gameId: binding.gameId,
    definitionVersion: binding.definitionVersion,
    definitionHash: binding.definitionHash,
    currency: binding.currency,
    currencyExponent: binding.currencyExponent,
    jurisdiction: binding.jurisdiction,
  };
}

async function sha256BindingFingerprint(binding: Readonly<RgsBinding>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new RgsProtocolError("Web Crypto is required for the RGS recovery ledger");
  const canonical = [
    binding.operatorId,
    binding.sessionId,
    binding.gameId,
    binding.definitionVersion,
    binding.definitionHash,
    binding.currency,
    String(binding.currencyExponent),
    binding.jurisdiction,
  ].join("\n");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function partialBindingMatches(spin: DecodedRgsSpin, binding: Readonly<RgsBinding>): boolean {
  return spin.binding.operatorId === binding.operatorId
    && spin.binding.sessionId === binding.sessionId
    && spin.binding.gameId === binding.gameId
    && spin.binding.definitionVersion === binding.definitionVersion
    && spin.binding.definitionHash === binding.definitionHash
    && spin.binding.currency === binding.currency;
}

function addRevision(revision: string, increment: bigint): string {
  const result = BigInt(revision) + increment;
  if (result < 0n || result > MAX_SIGNED_INT64) throw new RgsProtocolError("RGS revision overflow");
  return result.toString();
}

function subtractMoney(left: MoneyMinor, right: MoneyMinor, path: string): MoneyMinor {
  const result = BigInt(left) - BigInt(right);
  if (result < 0n || result > MAX_SIGNED_INT64) {
    throw new RgsProtocolError(`${path} cannot be reconstructed safely`);
  }
  return result.toString();
}

function provableLegacyRageOriginForBase(
  result: Readonly<SpinResult>,
): Pick<FeatureState, "rageLevel" | "rageCollected"> {
  const collection = result.events.find((event) => event.type === "surge.collected");
  if (!collection || collection.type !== "surge.collected") {
    return {
      rageLevel: result.featureState.rageLevel,
      rageCollected: result.featureState.rageCollected,
    };
  }
  if (collection.count !== 3) {
    // 旧版 v1 账本只保留 BASE 模式；结算一到两个 Rage 时，total-count 能证明旧总数，
    // 但跨不可变定义的 PPS 边界后，新等级无法证明旧等级。
    throw new RgsProtocolError(
      "committed v1 Base recovery cannot reconstruct a one/two-Rage origin safely",
    );
  }
  return {
    rageLevel: collection.level,
    rageCollected: collection.total,
  };
}

function reconstructOriginFeatureState(
  pending: Readonly<PendingRound>,
  result: Readonly<SpinResult>,
): Readonly<FeatureState> {
  if (pending.originFeatureState) return pending.originFeatureState;
  const originMode = ledgerOriginMode(pending.ledger);
  if (originMode === "BASE") {
    return Object.freeze({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      ...provableLegacyRageOriginForBase(result),
    });
  }
  const awardedThisRound = result.events.reduce((count, event) => (
    count + (event.type === "free_spin.awarded" ? event.count : 0)
  ), 0);
  const completion = result.events.find((event) => event.type === "free_spins.completed");
  if (result.featureState.mode === originMode) {
    const played = result.featureState.freeSpinsPlayed;
    const runningWin = result.featureState.freeSpinsWinMinor;
    const remaining = result.featureState.freeSpinsRemaining + 1 - awardedThisRound;
    if (played === undefined || played < 1 || runningWin === undefined || remaining < 1) {
      throw new RgsProtocolError("active Free Spins origin cannot be reconstructed");
    }
    return Object.freeze({
      mode: originMode,
      freeSpinsRemaining: remaining,
      freeSpinsPlayed: played - 1,
      baseBetMinor: pending.ledger.betMinor,
      freeSpinsWinMinor: subtractMoney(runningWin, result.totalWinMinor, "Free Spins running win"),
      rageLevel: result.featureState.rageLevel,
      rageCollected: result.featureState.rageCollected,
    });
  }
  if (!completion || completion.type !== "free_spins.completed"
    || completion.mode !== originMode || awardedThisRound !== 0) {
    throw new RgsProtocolError("terminal Free Spins origin cannot be reconstructed");
  }
  return Object.freeze({
    mode: originMode,
    freeSpinsRemaining: 1,
    freeSpinsPlayed: completion.awarded - 1,
    baseBetMinor: pending.ledger.betMinor,
    freeSpinsWinMinor: subtractMoney(
      completion.cumulativeWinMinor,
      result.totalWinMinor,
      "terminal Free Spins running win",
    ),
    rageLevel: result.featureState.rageLevel,
    rageCollected: result.featureState.rageCollected,
  });
}

function tokenRefreshDelayMs(token: string, nowMs: number): number | null {
  const lifetime = compactTokenLifetime(token);
  if (!lifetime) return null;
  const { issuedMs, expiresMs } = lifetime;
  const target = Math.min(
    issuedMs + Math.floor((expiresMs - issuedMs) * 0.8),
    expiresMs - 30_000,
  );
  return Math.max(1_000, Math.min(MAX_TIMER_DELAY_MS, target - nowMs));
}

function compactTokenLifetime(token: string): { issuedMs: number; expiresMs: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || typeof globalThis.atob !== "function") return null;
  try {
    const encoded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const claims = JSON.parse(globalThis.atob(padded)) as unknown;
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
    const { iat, exp } = claims as Record<string, unknown>;
    if (typeof iat !== "number" || typeof exp !== "number"
      || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) return null;
    return { issuedMs: iat * 1_000, expiresMs: exp * 1_000 };
  } catch {
    return null;
  }
}

function retryableHttp(error: RgsHttpError): boolean {
  return error.status === 202 || error.status === 429 || error.status >= 500;
}

function serverError(
  error: RgsHttpError,
  sessionId?: string,
  roundId?: string,
): ServerError {
  return {
    type: "error",
    protocolVersion: 1,
    requestId: error.requestId,
    ...(sessionId ? { sessionId } : {}),
    ...(roundId ? { roundId } : {}),
    code: error.code,
    message: error.message,
    retryable: retryableHttp(error),
  };
}

export class RgsGateway implements GameGateway {
  /**
   * 安全不重放：RGS 启动码是一次性宿主交接凭据。首会话失败后只能由
   * 运营方重新签发会话，浏览器不得用旧启动码自动重试或建议直接刷新。
   */
  readonly initialSessionRecoveryMode = "operator-session" as const;
  readonly operatorHostOrigin: string | undefined;
  private readonly config: ValidatedConfig;
  private callbacks: GatewayCallbacks = NULL_CALLBACKS;
  private launchCode: string | null;
  private accessToken: string | null = null;
  private session: DecodedRgsSession | null = null;
  private bindingFingerprint: string | null = null;
  private pending: PendingRound | null = null;
  private lastAppliedSequence = 0;
  private lastAppliedRoundId: string | null = null;
  private connecting = false;
  private connected = false;
  private wageringBlocked = false;
  private closed = false;
  private generation = 0;
  private readonly activeRequests = new Set<AbortController>();
  private pollTimer: unknown | null = null;
  private acknowledgementRetryTimer: unknown | null = null;
  private acknowledgementDeadlineTimer: unknown | null = null;
  private refreshTimer: unknown | null = null;
  private refreshPromise: Promise<void> | null = null;
  private proactiveRefreshAttempt = 0;

  constructor(config: RgsGatewayConfig) {
    this.config = validateConfig(config);
    this.operatorHostOrigin = this.config.operatorHostOrigin;
    this.launchCode = config.launchCode;
  }

  setCallbacks(callbacks: GatewayCallbacks): void {
    this.callbacks = callbacks;
  }

  private reportResultDeliveryStage(stage: ResultDeliveryStage): void {
    try {
      this.callbacks.onResultDeliveryStage?.(stage);
    } catch {
      // 固定诊断观察不属于传输或权威结果路径。
    }
  }

  get hasPendingSpin(): boolean {
    return this.pending !== null;
  }

  connect(): void {
    if (this.closed || this.connecting || this.connected) return;
    if (!this.launchCode) {
      this.callbacks.onError(new RgsGatewayConfigurationError(
        "RGS launch code has already been consumed; obtain a fresh operator relaunch",
      ));
      return;
    }
    this.connecting = true;
    const generation = this.generation;
    this.callbacks.onStatus("connecting");
    void this.exchange(generation);
  }

  requestSpin(roundId: string, betMinor: MoneyMinor): boolean {
    if (this.closed || this.wageringBlocked || !this.connected
      || this.pending || !this.session || !this.accessToken
      || this.session.status !== "ACTIVE" || !IDENTIFIER_PATTERN.test(roundId)) return false;
    let canonicalBet: MoneyMinor;
    try {
      canonicalBet = canonicalMoneyForProtocol(betMinor, "spin.betMinor", true);
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error("Invalid RGS bet"));
      return false;
    }
    if (!this.config.betOptionsMinor.includes(canonicalBet)) return false;
    const origin = cloneFeatureState(this.session.featureState);
    const activeFeature = origin.mode !== "BASE";
    if (activeFeature && origin.baseBetMinor !== canonicalBet) return false;
    if (!this.bindingFingerprint) {
      this.callbacks.onError(new RgsProtocolError("RGS binding fingerprint is not ready"));
      return false;
    }
    const originFeatureState = persistedLedgerFeatureState(origin, canonicalBet);
    const ledger: RgsRecoveryLedger = Object.freeze({
      version: 2,
      bindingFingerprint: this.bindingFingerprint,
      roundId,
      betMinor: canonicalBet,
      startRevision: this.session.revision,
      originFeatureState,
    });
    try {
      this.config.ledgerStorage?.save(ledger);
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error : new Error("Could not persist RGS recovery ledger"));
      return false;
    }
    const pending: PendingRound = {
      ledger,
      roundKind: activeFeature ? "FREE_SPIN" : "BASE",
      originFeatureState,
      pollAttempts: 0,
      spinAttempts: 0,
      blocked: false,
      deliveredSequence: null,
      deliveredResultHash: null,
      acknowledgementInFlight: false,
      acknowledgementAttempts: 0,
      acknowledgementStartedAtMs: null,
      acknowledgementExhausted: false,
    };
    this.pending = pending;
    void this.submitPending(pending);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.connecting = false;
    this.generation += 1;
    this.clearPollTimer();
    this.clearAcknowledgementRetryTimer();
    this.clearAcknowledgementDeadlineTimer();
    this.clearRefreshTimer();
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.accessToken = null;
    this.launchCode = null;
    this.callbacks.onStatus("offline");
  }

  acknowledgeSpinResult(roundId: string, sequence: number): boolean {
    const pending = this.pending;
    if (!pending || !this.isPending(pending) || pending.deliveredSequence === null
      || pending.deliveredResultHash === null
      || pending.ledger.roundId !== roundId
      || pending.deliveredSequence !== sequence
      || pending.acknowledgementExhausted) return false;
    if (!pending.acknowledgementInFlight) {
      if (pending.acknowledgementStartedAtMs === null) {
        pending.acknowledgementStartedAtMs = this.config.now();
        this.scheduleAcknowledgementDeadline(pending);
      }
      if (!this.acknowledgementAttemptAllowed(pending)) {
        this.exhaustResultAcknowledgement(pending);
        return false;
      }
      pending.acknowledgementInFlight = true;
      void this.submitResultAcknowledgement(pending);
    }
    return true;
  }

  private async submitResultAcknowledgement(pending: PendingRound): Promise<void> {
    const sequence = pending.deliveredSequence;
    const resultHash = pending.deliveredResultHash;
    if (!this.isPending(pending) || sequence === null || resultHash === null) return;
    if (!this.acknowledgementAttemptAllowed(pending)) {
      this.exhaustResultAcknowledgement(pending);
      return;
    }
    pending.acknowledgementAttempts += 1;
    try {
      const session = this.requireSession();
      await this.authorizedPost(
        this.config.acknowledgementUrl,
        {
          ...bindingPayload(session.binding),
          roundId: pending.ledger.roundId,
          sequence: String(sequence),
          resultHash,
        },
        (raw, requestId) => decodeResultDeliveryAcknowledgement(
          raw,
          requestId,
          session.binding.operatorId,
          session.binding.sessionId,
          pending.ledger.roundId,
          sequence,
          resultHash,
        ),
        () => this.assertAcknowledgementWindowOpen(pending),
      );
      if (!this.isPending(pending)) return;
      this.clearPending(pending);
      this.callbacks.onSpinResultAcknowledged?.(pending.ledger.roundId, sequence);
    } catch (error) {
      if (!this.isPending(pending)) return;
      this.reportError(error, pending);
      if (error instanceof RgsNetworkError
        || (error instanceof RgsHttpError && retryableHttp(error))) {
        this.scheduleAcknowledgementRetry(pending, error);
        return;
      }
      if (this.accessToken === null || (error instanceof RgsHttpError
        && (error.status === 401 || error.status === 403
          || error.status === 410 || error.status === 423))) {
        this.exhaustResultAcknowledgement(pending, error);
        return;
      }
      // 协议不一致或本地持久存储故障不能盲目循环；保留账本，允许
      // 受控调用方在修复后以同一元组再次显式提交。
      pending.acknowledgementInFlight = false;
    }
  }

  private acknowledgementAttemptAllowed(pending: Readonly<PendingRound>): boolean {
    const startedAt = pending.acknowledgementStartedAtMs;
    return startedAt !== null
      && pending.acknowledgementAttempts < this.config.acknowledgementMaxAttempts
      && this.config.now() < startedAt + this.config.acknowledgementRetryWindowMs;
  }

  private assertAcknowledgementWindowOpen(pending: PendingRound): void {
    if (!this.isPending(pending) || pending.acknowledgementExhausted
      || pending.acknowledgementStartedAtMs === null
      || this.config.now() >= pending.acknowledgementStartedAtMs
        + this.config.acknowledgementRetryWindowMs) {
      throw new RgsProtocolError("RGS result acknowledgement recovery window expired");
    }
  }

  private scheduleAcknowledgementRetry(
    pending: PendingRound,
    error: RgsNetworkError | RgsHttpError,
  ): void {
    if (!this.isPending(pending) || pending.acknowledgementExhausted) return;
    const startedAt = pending.acknowledgementStartedAtMs;
    if (startedAt === null
      || pending.acknowledgementAttempts >= this.config.acknowledgementMaxAttempts) {
      this.exhaustResultAcknowledgement(pending, error);
      return;
    }
    const exponentialDelay = Math.min(
      this.config.acknowledgementRetryMaxDelayMs,
      this.config.acknowledgementRetryBaseDelayMs
        * 2 ** Math.min(pending.acknowledgementAttempts - 1, 10),
    );
    const delay = Math.max(
      exponentialDelay,
      error instanceof RgsHttpError ? error.retryAfterMs ?? 0 : 0,
    );
    const now = this.config.now();
    const deadline = startedAt + this.config.acknowledgementRetryWindowMs;
    // 服务端建议只能延后下一次请求，不能延长本页固定窗口；等于截止时间也不再发包。
    if (now >= deadline || delay >= deadline - now) {
      this.exhaustResultAcknowledgement(pending, error);
      return;
    }
    this.clearAcknowledgementRetryTimer();
    const generation = this.generation;
    this.acknowledgementRetryTimer = this.config.timers.setTimeout(() => {
      this.acknowledgementRetryTimer = null;
      if (!this.isCurrent(generation) || !this.isPending(pending)
        || pending.acknowledgementExhausted) return;
      void this.submitResultAcknowledgement(pending);
    }, delay);
  }

  private scheduleAcknowledgementDeadline(pending: PendingRound): void {
    this.clearAcknowledgementDeadlineTimer();
    const generation = this.generation;
    this.acknowledgementDeadlineTimer = this.config.timers.setTimeout(() => {
      this.acknowledgementDeadlineTimer = null;
      if (!this.isCurrent(generation) || !this.isPending(pending)
        || pending.acknowledgementExhausted) return;
      this.exhaustResultAcknowledgement(pending);
    }, this.config.acknowledgementRetryWindowMs);
  }

  private exhaustResultAcknowledgement(pending: PendingRound, cause?: unknown): void {
    if (!this.isPending(pending) || pending.acknowledgementExhausted) return;
    pending.acknowledgementExhausted = true;
    pending.acknowledgementInFlight = false;
    pending.blocked = true;
    const requestId = cause instanceof RgsHttpError || cause instanceof RgsNetworkError
      ? cause.requestId
      : undefined;
    const terminal: ServerError = {
      type: "error",
      protocolVersion: 1,
      ...(requestId ? { requestId } : {}),
      sessionId: this.session?.binding.sessionId,
      roundId: pending.ledger.roundId,
      code: "RESULT_ACKNOWLEDGEMENT_RECOVERY_REQUIRED",
      message: "Committed result acknowledgement requires an operator relaunch",
      retryable: false,
    };
    this.terminateForOperatorRelaunch(terminal);
  }

  /**
   * 终止一个无法在当前页安全恢复的授权上下文。此边界故意保留 pending 与持久账本，
   * 让运营商新会话仍能按同一经济身份查询/交付可能已经提交的结果。
   */
  private terminateForOperatorRelaunch(cause: ServerError | Error): void {
    if (this.closed) return;
    const notifyOffline = this.connected || this.connecting;
    if (this.pending) {
      this.pending.blocked = true;
      this.pending.acknowledgementInFlight = false;
    }
    this.wageringBlocked = true;
    this.closed = true;
    this.connected = false;
    this.connecting = false;
    this.generation += 1;
    this.clearPollTimer();
    this.clearAcknowledgementRetryTimer();
    this.clearAcknowledgementDeadlineTimer();
    this.clearRefreshTimer();
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
    this.accessToken = null;
    this.launchCode = null;
    if (notifyOffline) {
      try {
        this.callbacks.onStatus("offline");
      } catch {
        // 状态观察者不拥有终止流程；即使 UI 状态回调故障，也必须继续通知诊断与宿主恢复。
      }
    }
    try {
      this.callbacks.onError(cause);
    } catch {
      // 诊断观察者与宿主接管相互隔离，禁止前者异常吞掉唯一的恢复通知。
    }
    try {
      this.callbacks.onOperatorSessionRequired?.(cause);
    } catch {
      // 宿主接管通知是旁路；回调异常不能复活旧令牌或解除结果交付栅栏。
    }
  }

  private async exchange(generation: number): Promise<void> {
    try {
      const requestId = this.nextRequestId();
      const launchCode = this.launchCode;
      if (!launchCode) throw new RgsGatewayConfigurationError("RGS launch code is unavailable");
      const raw = await this.post(
        this.config.exchangeUrl,
        { launchCode, operatorId: this.config.operatorId, sessionId: this.config.sessionId },
        requestId,
        null,
      );
      // 任意 HTTP 响应都可能表示一次性启动码已消费；成功解码会话交换响应后
      // 禁止继续保留该启动码。
      const exchange = decodeRgsExchange(
        raw,
        requestId,
        this.config.operatorId,
        this.config.sessionId,
      );
      this.launchCode = null;
      if (exchange.session.status !== "ACTIVE") {
        throw new RgsProtocolError("RGS exchange returned a non-ACTIVE session");
      }
      const fingerprint = await this.config.bindingFingerprint(exchange.session.binding);
      if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw new RgsProtocolError("RGS binding fingerprint is invalid");
      }
      if (!this.isCurrent(generation)) return;
      this.accessToken = exchange.accessToken;
      this.session = exchange.session;
      this.bindingFingerprint = fingerprint;
      this.restorePendingLedger(exchange.session, fingerprint);
      const discovered = this.pending === null
        ? await this.discoverPendingResult(exchange.session, fingerprint)
        : null;
      if (!this.isCurrent(generation)) return;
      this.connecting = false;
      this.connected = true;
      this.wageringBlocked = false;
      this.callbacks.onStatus("online");
      this.callbacks.onSession(rgsSessionOpened(
        exchange,
        this.config.betOptionsMinor,
        this.config.defaultBetMinor,
      ));
      this.scheduleProactiveRefresh(exchange.accessToken);
      if (discovered !== null && this.pending !== null) {
        const pending = this.pending;
        try {
          this.acceptCommitted(pending, discovered.result);
        } catch (error) {
          if (this.isPending(pending)) {
            if (error instanceof RgsDeliveryError) {
              this.reportError(error, pending);
              this.schedulePoll(pending);
            } else {
              pending.blocked = true;
              this.reportError(error, pending);
            }
          }
        }
      } else if (this.pending) {
        this.schedulePoll(this.pending, 0);
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.connecting = false;
      this.connected = false;
      this.callbacks.onStatus("offline");
      this.reportError(error);
    }
  }

  private restorePendingLedger(session: DecodedRgsSession, fingerprint: string): void {
    const rawLedger = this.config.ledgerStorage?.load() ?? null;
    if (rawLedger === null) {
      this.lastAppliedSequence = session.sequence;
      this.lastAppliedRoundId = null;
      return;
    }
    let ledger = decodeLedger(rawLedger);
    if (ledger.bindingFingerprint !== fingerprint) {
      this.config.ledgerStorage?.clear();
      this.lastAppliedSequence = session.sequence;
      this.lastAppliedRoundId = null;
      return;
    }
    if (!this.config.betOptionsMinor.includes(ledger.betMinor)) {
      throw new RgsProtocolError("persisted RGS round uses an unconfigured bet");
    }
    const originMode = ledgerOriginMode(ledger);
    const revisionDelta = BigInt(session.revision) - BigInt(ledger.startRevision);
    if (revisionDelta < 0n || revisionDelta > 1n) {
      throw new RgsProtocolError("persisted RGS round does not match the durable session revision");
    }
    let originFeatureState: Readonly<FeatureState> | null = ledger.version === 2
      ? ledger.originFeatureState
      : null;
    if (revisionDelta === 0n) {
      if (session.featureState.mode !== originMode
        || (originMode !== "BASE" && session.featureState.baseBetMinor !== ledger.betMinor)) {
        throw new RgsProtocolError("persisted RGS round origin does not match the durable feature state");
      }
      if (ledger.version === 2 && !sameFeatureState(session.featureState, ledger.originFeatureState)) {
        throw new RgsProtocolError("persisted RGS round origin does not match the durable feature state");
      }
      if (ledger.version === 1) {
        originFeatureState = persistedLedgerFeatureState(session.featureState, ledger.betMinor);
        const upgradedLedger: RgsRecoveryLedger = Object.freeze({
          version: 2,
          bindingFingerprint: ledger.bindingFingerprint,
          roundId: ledger.roundId,
          betMinor: ledger.betMinor,
          startRevision: ledger.startRevision,
          originFeatureState,
        });
        // 替换写入成功前旧账本仍是权威证据；在精确请求来源尚未持久化时，
        // 禁止提交或轮询 revision 为零的旧轮次。
        this.config.ledgerStorage?.save(upgradedLedger);
        ledger = upgradedLedger;
      }
      this.lastAppliedSequence = session.sequence;
    } else {
      if (session.sequence < 1) {
        throw new RgsProtocolError("committed RGS recovery has no result sequence");
      }
      // 当前会话交换已包含此已提交结果；轮次状态只能恢复这一条精确 sequence。
      this.lastAppliedSequence = session.sequence - 1;
    }
    this.lastAppliedRoundId = null;
    this.pending = {
      ledger,
      roundKind: originMode === "BASE" ? "BASE" : "FREE_SPIN",
      originFeatureState,
      pollAttempts: 0,
      spinAttempts: 0,
      blocked: false,
      deliveredSequence: null,
      deliveredResultHash: null,
      acknowledgementInFlight: false,
      acknowledgementAttempts: 0,
      acknowledgementStartedAtMs: null,
      acknowledgementExhausted: false,
    };
  }

  private async discoverPendingResult(
    session: Readonly<DecodedRgsSession>,
    fingerprint: string,
  ): Promise<DecodedPendingResultDelivery | null> {
    // sequence=0 可证明该会话从未提交结果，因此无需增加一次恢复请求。
    if (session.sequence === 0) return null;
    const requestId = this.nextRequestId();
    const delivery = await this.getPendingResult(
      this.config.pendingResultUrl,
      requestId,
      this.requireAccessToken(),
    );
    if (delivery === null) return null;
    const decoded = decodePendingResultDelivery(delivery, requestId);
    const committed = decoded.result;
    const result = committed.result;
    const origin = persistedLedgerFeatureState(
      decoded.originFeatureState,
      result.betMinor,
    );
    const expectedRoundKind = origin.mode === "BASE" ? "BASE" : "FREE_SPIN";
    if (decoded.operatorId !== session.binding.operatorId
      || decoded.sessionId !== session.binding.sessionId
      || !partialBindingMatches(committed, session.binding)
      || result.sessionId !== session.binding.sessionId
      || result.roundId !== decoded.roundId
      || result.sequence !== session.sequence
      || result.balanceMinor !== session.balanceMinor
      || committed.endRevision !== session.revision
      || committed.endRevision !== addRevision(committed.startRevision, 1n)
      || committed.roundKind !== expectedRoundKind
      || !sameFeatureState(result.featureState, session.featureState)) {
      throw new RgsProtocolError(
        "pending result delivery does not match the exchanged authoritative session",
      );
    }
    validateSpinResultAgainstOrigin(origin, result);
    // 服务端游标已是跨重载权威；发现路径只在内存恢复账本，不把响应结果或
    // 令牌写入 sessionStorage。页面再次中断时会重新查询同一条未 ACK 结果。
    const ledger: RgsRecoveryLedger = Object.freeze({
      version: 2,
      bindingFingerprint: fingerprint,
      roundId: decoded.roundId,
      betMinor: result.betMinor,
      startRevision: committed.startRevision,
      originFeatureState: origin,
    });
    this.lastAppliedSequence = session.sequence - 1;
    this.lastAppliedRoundId = null;
    this.pending = {
      ledger,
      roundKind: expectedRoundKind,
      originFeatureState: origin,
      pollAttempts: 0,
      spinAttempts: 0,
      blocked: false,
      deliveredSequence: null,
      deliveredResultHash: null,
      acknowledgementInFlight: false,
      acknowledgementAttempts: 0,
      acknowledgementStartedAtMs: null,
      acknowledgementExhausted: false,
    };
    return decoded;
  }

  private async submitPending(pending: PendingRound): Promise<void> {
    if (!this.isPending(pending) || pending.blocked) return;
    pending.spinAttempts += 1;
    try {
      const decoded = await this.authorizedPost(
        this.config.spinUrl,
        {
          ...bindingPayload(this.requireSession().binding),
          roundId: pending.ledger.roundId,
          roundKind: pending.roundKind,
          betMinor: pending.ledger.betMinor,
          startRevision: pending.ledger.startRevision,
        },
        (raw, requestId) => {
          this.reportResultDeliveryStage("post-response-before-decode");
          const result = decodeRgsSpin(raw, requestId, (stage) => {
            this.reportResultDeliveryStage(stage);
          });
          this.reportResultDeliveryStage("decoded");
          return result;
        },
      );
      this.acceptCommitted(pending, decoded);
    } catch (error) {
      if (!this.isPending(pending)) return;
      if (error instanceof RgsHttpError && error.status === 202 && error.code === "ROUND_PENDING") {
        this.schedulePoll(pending);
        return;
      }
      if (error instanceof RgsNetworkError
        || (error instanceof RgsHttpError && retryableHttp(error))) {
        this.reportError(error, pending);
        this.schedulePoll(pending);
        return;
      }
      if (error instanceof RgsDeliveryError) {
        this.reportError(error, pending);
        this.schedulePoll(pending);
        return;
      }
      pending.blocked = true;
      this.reportError(error, pending);
    }
  }

  private schedulePoll(pending: PendingRound, explicitDelayMs?: number): void {
    if (!this.isPending(pending) || pending.blocked || this.pollTimer !== null) return;
    if (pending.pollAttempts >= this.config.maxPollAttempts) {
      pending.blocked = true;
      this.callbacks.onError({
        type: "error",
        protocolVersion: 1,
        sessionId: this.session?.binding.sessionId,
        roundId: pending.ledger.roundId,
        code: "ROUND_RECOVERY_EXHAUSTED",
        message: "Round recovery polling is exhausted; obtain a fresh operator relaunch",
        retryable: true,
      });
      return;
    }
    const delay = explicitDelayMs ?? Math.min(
      8_000,
      this.config.pollDelayMs * 2 ** Math.min(pending.pollAttempts, 5),
    );
    this.pollTimer = this.config.timers.setTimeout(() => {
      this.pollTimer = null;
      void this.pollPending(pending);
    }, delay);
  }

  private async pollPending(pending: PendingRound): Promise<void> {
    if (!this.isPending(pending) || pending.blocked) return;
    pending.pollAttempts += 1;
    try {
      const status = await this.authorizedPost(
        this.config.statusUrl,
        {
          ...bindingPayload(this.requireSession().binding),
          roundId: pending.ledger.roundId,
        },
        (raw, requestId) => decodeRgsRoundStatus(raw, requestId),
      );
      const binding = this.requireSession().binding;
      if (status.operatorId !== binding.operatorId || status.sessionId !== binding.sessionId
        || status.roundId !== pending.ledger.roundId) {
        throw new RgsProtocolError("round status returned a foreign binding or round");
      }
      switch (status.status) {
        case "COMMITTED":
          if (!status.result) throw new RgsProtocolError("COMMITTED status omitted its result");
          this.acceptCommitted(pending, status.result);
          return;
        case "PREPARED":
        case "WALLET_PENDING":
          this.schedulePoll(pending);
          return;
        case "REJECTED":
          this.finishRejectedRound(pending, "ROUND_REJECTED", "Round was rejected");
          return;
        case "MANUAL_REVIEW":
          this.blockForManualReview(pending);
          return;
      }
    } catch (error) {
      if (!this.isPending(pending)) return;
      if (error instanceof RgsHttpError && error.status === 404
        && pending.spinAttempts < 2
        && this.session?.revision === pending.ledger.startRevision) {
        // 原请求可能未到达 RGS；重试必须复用字节等价的经济身份，绝不创建新轮次。
        void this.submitPending(pending);
        return;
      }
      if (error instanceof RgsNetworkError
        || (error instanceof RgsHttpError && retryableHttp(error))) {
        this.reportError(error, pending);
        this.schedulePoll(pending);
        return;
      }
      if (error instanceof RgsDeliveryError) {
        this.reportError(error, pending);
        this.schedulePoll(pending);
        return;
      }
      pending.blocked = true;
      this.reportError(error, pending);
    }
  }

  private acceptCommitted(pending: PendingRound, decoded: DecodedRgsSpin): void {
    if (!this.isPending(pending)) return;
    const session = this.requireSession();
    const binding = session.binding;
    const result = decoded.result;
    this.reportResultDeliveryStage("economic-identity");
    if (!partialBindingMatches(decoded, binding)
      || result.sessionId !== binding.sessionId
      || result.roundId !== pending.ledger.roundId
      || result.betMinor !== pending.ledger.betMinor
      || decoded.startRevision !== pending.ledger.startRevision
      || decoded.endRevision !== addRevision(pending.ledger.startRevision, 1n)
      || decoded.roundKind !== pending.roundKind
      || (pending.roundKind === "BASE" && result.chargedBetMinor !== pending.ledger.betMinor)
      || (pending.roundKind === "FREE_SPIN" && result.chargedBetMinor !== "0")) {
      throw new RgsProtocolError("committed RGS result does not match the pending economic identity");
    }
    this.reportResultDeliveryStage("sequence-guard");
    const guardState = {
      sessionId: binding.sessionId,
      pendingRoundId: pending.ledger.roundId,
      pendingBetMinor: pending.ledger.betMinor,
      lastAppliedSequence: this.lastAppliedSequence,
      lastAppliedRoundId: this.lastAppliedRoundId,
    };
    const decision = classifySpinResult(guardState, result);
    if (decision.kind === "reject") {
      throw new RgsProtocolError(`committed RGS result was rejected: ${decision.reason}`);
    }
    if (decision.kind === "duplicate") {
      // 已交付结果在控制器确认可见展示或兜底提交前必须保持持久；
      // 重复网络响应不得 ACK 它。
      if (pending.deliveredSequence !== result.sequence) this.clearPending(pending);
      this.reportResultDeliveryStage("delivered");
      return;
    }
    this.reportResultDeliveryStage("origin-reconstructed");
    const origin = reconstructOriginFeatureState(pending, result);
    this.reportResultDeliveryStage("origin-validated");
    validateSpinResultAgainstOrigin(origin, result);
    const nextSession = Object.freeze({
      ...session,
      balanceMinor: result.balanceMinor,
      revision: decoded.endRevision,
      sequence: result.sequence,
      featureState: cloneFeatureState(result.featureState),
    });
    this.reportResultDeliveryStage("controller-dispatch");
    try {
      this.callbacks.onSpinResult(result, origin);
    } catch (error) {
      throw new RgsDeliveryError(
        "Committed RGS result could not be delivered to the game controller",
        error,
      );
    }
    // 该回调是持久交接边界；控制器接受前不得改动恢复账本、
    // 对应 sequence 或待处理身份。
    if (!this.isPending(pending)) return;
    this.lastAppliedSequence = result.sequence;
    this.lastAppliedRoundId = result.roundId;
    this.session = nextSession;
    pending.deliveredSequence = result.sequence;
    pending.deliveredResultHash = decoded.resultHash;
    pending.acknowledgementInFlight = false;
    this.clearPollTimer();
    this.reportResultDeliveryStage("delivered");
  }

  private finishRejectedRound(pending: PendingRound, code: string, message: string): void {
    const sessionId = this.session?.binding.sessionId;
    const roundId = pending.ledger.roundId;
    this.clearPending(pending);
    this.callbacks.onError({
      type: "error",
      protocolVersion: 1,
      ...(sessionId ? { sessionId } : {}),
      roundId,
      code,
      message,
      retryable: false,
    });
  }

  private blockForManualReview(pending: PendingRound): void {
    if (!this.isPending(pending)) return;
    pending.blocked = true;
    this.wageringBlocked = true;
    this.connected = false;
    this.accessToken = null;
    this.clearPollTimer();
    this.clearRefreshTimer();
    this.callbacks.onStatus("offline");
    this.callbacks.onError({
      type: "error",
      protocolVersion: 1,
      sessionId: this.session?.binding.sessionId,
      roundId: pending.ledger.roundId,
      code: "MANUAL_REVIEW",
      message: "Session requires manual review",
      retryable: false,
    });
  }

  private clearPending(pending: PendingRound): void {
    if (!this.isPending(pending)) return;
    this.config.ledgerStorage?.clear();
    this.clearPollTimer();
    this.clearAcknowledgementRetryTimer();
    this.clearAcknowledgementDeadlineTimer();
    this.pending = null;
  }

  private async authorizedPost<T>(
    url: string,
    body: Record<string, unknown>,
    decode: (value: unknown, requestId: string) => T,
    beforeRequest?: () => void,
  ): Promise<T> {
    if (this.refreshPromise) await this.refreshPromise;
    beforeRequest?.();
    let requestId = this.nextRequestId();
    try {
      const raw = await this.post(url, body, requestId, this.requireAccessToken());
      return decode(raw, requestId);
    } catch (error) {
      if (!(error instanceof RgsHttpError) || error.status !== 401) throw error;
      await this.refreshAccessToken();
      beforeRequest?.();
      requestId = this.nextRequestId();
      const raw = await this.post(url, body, requestId, this.requireAccessToken());
      return decode(raw, requestId);
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const refresh = (async (): Promise<void> => {
      let exchange: DecodedRgsExchange;
      try {
        const sessionBefore = this.requireSession();
        const requestId = this.nextRequestId();
        const raw = await this.post(
          this.config.refreshUrl,
          bindingPayload(sessionBefore.binding),
          requestId,
          this.requireAccessToken(),
        );
        exchange = decodeRgsExchange(
          raw,
          requestId,
          sessionBefore.binding.operatorId,
          sessionBefore.binding.sessionId,
        );
        if (exchange.session.status !== "ACTIVE"
          || !sameCompleteBinding(exchange.session.binding, sessionBefore.binding)) {
          throw new RgsProtocolError("RGS refresh changed the immutable session binding or status");
        }
        this.validateRefreshedSession(exchange.session);
      } catch (error) {
        if (error instanceof RgsProtocolError && this.isCurrent(generation)) {
          this.terminateForOperatorRelaunch(error);
        }
        throw error;
      }
      if (!this.isCurrent(generation)) return;
      this.accessToken = exchange.accessToken;
      this.session = exchange.session;
      this.wageringBlocked = false;
      this.proactiveRefreshAttempt = 0;
      this.callbacks.onSession(rgsSessionOpened(
        exchange,
        this.config.betOptionsMinor,
        this.config.defaultBetMinor,
      ));
      this.scheduleProactiveRefresh(exchange.accessToken);
    })();
    this.refreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null;
    }
  }

  private validateRefreshedSession(refreshed: DecodedRgsSession): void {
    const current = this.requireSession();
    if (!this.pending) {
      if (refreshed.revision !== current.revision || refreshed.sequence !== current.sequence) {
        throw new RgsProtocolError("RGS session advanced without a pending browser round");
      }
      return;
    }
    const startRevision = BigInt(this.pending.ledger.startRevision);
    const currentRevision = BigInt(current.revision);
    const refreshedRevision = BigInt(refreshed.revision);
    const revisionDelta = refreshedRevision - currentRevision;
    // pending 轮次至多提交一次：refresh 可以保持当前游标，或同时推进 revision/sequence 一步。
    // 已观察到提交后的当前游标绝不能倒退回 startRevision。
    if (refreshedRevision < startRevision
      || refreshedRevision > startRevision + 1n
      || revisionDelta < 0n
      || revisionDelta > 1n
      || refreshed.sequence !== current.sequence + Number(revisionDelta)) {
      throw new RgsProtocolError(
        "refreshed RGS session is outside the pending round revision/sequence window",
      );
    }
  }

  private scheduleProactiveRefresh(token: string): void {
    this.clearRefreshTimer();
    this.proactiveRefreshAttempt = 0;
    const delay = tokenRefreshDelayMs(token, this.config.now());
    if (delay === null || this.closed) return;
    this.scheduleProactiveRefreshAttempt(token, delay);
  }

  private scheduleProactiveRefreshAttempt(token: string, delay: number): void {
    if (this.closed) return;
    this.refreshTimer = this.config.timers.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshAccessToken().catch((error: unknown) => {
        if (this.closed) return;
        this.reportError(error, this.pending ?? undefined);
        if (error instanceof RgsNetworkError
          || (error instanceof RgsHttpError && retryableHttp(error))) {
          const lifetime = compactTokenLifetime(token);
          const now = this.config.now();
          const remaining = lifetime ? lifetime.expiresMs - now : 0;
          const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.proactiveRefreshAttempt, 5));
          this.proactiveRefreshAttempt += 1;
          if (remaining > backoff + 1_000) {
            this.scheduleProactiveRefreshAttempt(token, backoff);
            return;
          }
        }
        this.failClosedAfterRefresh(error);
      });
    }, delay);
  }

  private failClosedAfterRefresh(error: unknown): void {
    if (this.closed) return;
    const notifyOffline = this.connected;
    this.wageringBlocked = true;
    this.connected = false;
    this.accessToken = null;
    this.clearRefreshTimer();
    if (notifyOffline) this.callbacks.onStatus("offline");
    if (!(error instanceof RgsHttpError)) {
      // 此 HTTP 故障已在上方标准化并上报；该标记说明原本可重试的传输故障
      // 为何转为终止状态。
      this.callbacks.onError(new RgsProtocolError(
        "RGS access token could not be refreshed before expiry; operator relaunch is required",
      ));
    }
  }

  private async getPendingResult(
    url: string,
    requestId: string,
    accessToken: string,
  ): Promise<unknown | null> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timedOut = false;
    const timeout = this.config.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.config.fetch(url, {
          method: "GET",
          headers: {
            "X-Request-Id": requestId,
            "X-Operator-Id": this.config.operatorId,
            Authorization: `Bearer ${accessToken}`,
          },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (this.closed || controller.signal.aborted && !timedOut) throw error;
        throw new RgsNetworkError(
          timedOut ? "RGS pending-result request timed out" : "RGS pending-result request failed",
          timedOut,
          requestId,
        );
      }
      let responseText: string;
      try {
        responseText = await readBoundedResponseText(response, {
          label: "RGS response body",
          maxBytes: NETWORK_RESPONSE_LIMITS.rgsJsonBytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof NetworkResponseLimitError) {
          throw new RgsProtocolError("RGS response body exceeds the 4 MiB safety limit");
        }
        if (error instanceof NetworkResponseBodyError) {
          throw new RgsProtocolError("RGS response body cannot be decoded safely");
        }
        if (this.closed || controller.signal.aborted && !timedOut) throw error;
        throw new RgsNetworkError(
          timedOut ? "RGS pending-result body timed out" : "RGS pending-result body was interrupted",
          timedOut,
          requestId,
        );
      }
      if (response.status === 204) {
        if (responseText !== "") {
          throw new RgsProtocolError("RGS 204 pending-result response must have an empty body");
        }
        return null;
      }
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        const error = new RgsProtocolError("RGS response Content-Type must be application/json");
        cancelNetworkResponse(response, error);
        throw error;
      }
      const raw = parseRgsJson(responseText);
      if (!response.ok) {
        const decoded = decodeRgsError(raw, requestId);
        throw new RgsHttpError(
          response.status,
          requestId,
          decoded.code,
          decoded.message,
          safeRetryAfterMs(
            response.headers.get("Retry-After"),
            this.config.now(),
            this.config.acknowledgementRetryMaxDelayMs,
          ),
        );
      }
      if (response.status !== 200) {
        throw new RgsProtocolError(`unexpected successful RGS HTTP status ${response.status}`);
      }
      return raw;
    } finally {
      this.config.timers.clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }

  private async post(
    url: string,
    body: Record<string, unknown>,
    requestId: string,
    accessToken: string | null,
  ): Promise<unknown> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    let timedOut = false;
    const timeout = this.config.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.requestTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.config.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-Id": requestId,
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        if (this.closed || controller.signal.aborted && !timedOut) throw error;
        throw new RgsNetworkError(
          timedOut ? "RGS request timed out" : "RGS network request failed",
          timedOut,
          requestId,
        );
      }
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        const error = new RgsProtocolError("RGS response Content-Type must be application/json");
        cancelNetworkResponse(response, error);
        throw error;
      }
      let responseText: string;
      try {
        responseText = await readBoundedResponseText(response, {
          label: "RGS response body",
          maxBytes: NETWORK_RESPONSE_LIMITS.rgsJsonBytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof NetworkResponseLimitError) {
          throw new RgsProtocolError("RGS response body exceeds the 4 MiB safety limit");
        }
        if (error instanceof NetworkResponseBodyError) {
          throw new RgsProtocolError("RGS response body cannot be decoded safely");
        }
        if (this.closed || controller.signal.aborted && !timedOut) throw error;
        throw new RgsNetworkError(
          timedOut ? "RGS response body timed out" : "RGS response body was interrupted",
          timedOut,
          requestId,
        );
      }
      const raw = parseRgsJson(responseText);
      if (!response.ok || response.status === 202) {
        const decoded = decodeRgsError(raw, requestId);
        throw new RgsHttpError(
          response.status,
          requestId,
          decoded.code,
          decoded.message,
          safeRetryAfterMs(
            response.headers.get("Retry-After"),
            this.config.now(),
            this.config.acknowledgementRetryMaxDelayMs,
          ),
        );
      }
      if (response.status !== 200) {
        throw new RgsProtocolError(`unexpected successful RGS HTTP status ${response.status}`);
      }
      return raw;
    } finally {
      this.config.timers.clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }

  private reportError(error: unknown, pending?: PendingRound): void {
    if (this.closed) return;
    if (error instanceof RgsHttpError) {
      if (error.status === 401 || error.status === 403
        || error.status === 410 || error.status === 423) {
        const notifyOffline = this.connected;
        this.wageringBlocked = true;
        this.connected = false;
        this.accessToken = null;
        this.clearRefreshTimer();
        if (notifyOffline) this.callbacks.onStatus("offline");
      }
      this.callbacks.onError(serverError(
        error,
        this.session?.binding.sessionId,
        pending?.ledger.roundId,
      ));
      return;
    }
    this.callbacks.onError(error instanceof Error ? error : new Error("Unknown RGS gateway error"));
  }

  private nextRequestId(): string {
    const requestId = this.config.requestId();
    if (!IDENTIFIER_PATTERN.test(requestId)) {
      throw new RgsProtocolError("generated RGS requestId is invalid");
    }
    return requestId;
  }

  private requireSession(): DecodedRgsSession {
    if (!this.session) throw new RgsProtocolError("RGS session is not established");
    return this.session;
  }

  private requireAccessToken(): string {
    if (!this.accessToken) throw new RgsProtocolError("RGS access token is not available");
    return this.accessToken;
  }

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }

  private isPending(pending: PendingRound): boolean {
    return !this.closed && this.pending === pending;
  }

  private clearPollTimer(): void {
    if (this.pollTimer === null) return;
    this.config.timers.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private clearAcknowledgementRetryTimer(): void {
    if (this.acknowledgementRetryTimer === null) return;
    this.config.timers.clearTimeout(this.acknowledgementRetryTimer);
    this.acknowledgementRetryTimer = null;
  }

  private clearAcknowledgementDeadlineTimer(): void {
    if (this.acknowledgementDeadlineTimer === null) return;
    this.config.timers.clearTimeout(this.acknowledgementDeadlineTimer);
    this.acknowledgementDeadlineTimer = null;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer === null) return;
    this.config.timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}

function sameCompleteBinding(left: Readonly<RgsBinding>, right: Readonly<RgsBinding>): boolean {
  return left.operatorId === right.operatorId
    && left.sessionId === right.sessionId
    && left.gameId === right.gameId
    && left.definitionVersion === right.definitionVersion
    && left.definitionHash === right.definitionHash
    && left.currency === right.currency
    && left.currencyExponent === right.currencyExponent
    && left.jurisdiction === right.jurisdiction;
}
