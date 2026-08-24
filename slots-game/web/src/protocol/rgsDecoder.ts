import type {
  FeatureState,
  MoneyMinor,
  SessionOpened,
  SpinResult,
} from "../app/state/types";
import {
  decodeServerMessage,
  type SpinResultProjectionDecodeStage,
} from "./decoder";
import { ENGINE_RULES_VERSION } from "./messages";
import {
  LOCKED_VAULT_FACES,
  type LockedVaultFace,
} from "./protocolConstants";

export class RgsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RgsProtocolError";
  }
}

export interface RgsBinding {
  readonly operatorId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly jurisdiction: string;
}

export interface DecodedRgsSession {
  readonly binding: RgsBinding;
  readonly status: "ACTIVE" | "BLOCKED" | "CLOSED" | "EXPIRED";
  readonly expiresAt: string;
  readonly idleDisconnectAt: string;
  readonly balanceMinor: MoneyMinor;
  readonly revision: string;
  readonly sequence: number;
  readonly featureState: FeatureState;
}

export interface DecodedRgsExchange {
  readonly requestId: string;
  readonly accessToken: string;
  readonly serverTime: string;
  readonly session: DecodedRgsSession;
}

export interface DecodedRgsSessionStatus {
  readonly requestId: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly status: "ACTIVE" | "EXPIRED";
  readonly idleDisconnectAt: string;
  readonly serverTime: string;
}

export type RgsRoundKind = "BASE" | "FREE_SPIN" | "BONUS";

export type RgsSpinBinding = Pick<
  RgsBinding,
  | "operatorId"
  | "sessionId"
  | "gameId"
  | "definitionVersion"
  | "definitionHash"
  | "currency"
>;

export interface DecodedRgsSpin {
  readonly result: SpinResult;
  readonly binding: RgsSpinBinding;
  readonly roundKind: RgsRoundKind;
  readonly serverTransactionId: string;
  readonly walletTransactionId: string;
  readonly startRevision: string;
  readonly endRevision: string;
  readonly resultHash: string;
  /** 本次权威轮次提交后更新的服务端空闲断开绝对时间。 */
  readonly idleDisconnectAt: string;
}

/** 仅用于定位旋转响应解码边界，不得携带响应值、标识或异常内容。 */
export type RgsSpinDecodeStage =
  | SpinResultProjectionDecodeStage
  | "decode-envelope"
  | "decode-request-id"
  | "decode-data-shape"
  | "decode-binding"
  | "decode-metadata"
  | "decode-grid"
  | "decode-wins"
  | "decode-events"
  | "decode-feature"
  | "decode-projection"
  | "projection-round-id"
  | "projection-sequence"
  | "projection-money-fields"
  | "projection-message-input"
  | "decode-commit-metadata"
  | "decode-complete";

type RgsSpinDecodeStageObserver = (stage: RgsSpinDecodeStage) => void;

export interface DecodedRgsRoundStatus {
  readonly requestId: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly roundId: string;
  readonly status: "PREPARED" | "WALLET_PENDING" | "COMMITTED" | "REJECTED" | "MANUAL_REVIEW";
  readonly result?: DecodedRgsSpin;
}

export interface DecodedPendingResultDelivery {
  readonly requestId: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly roundId: string;
  readonly sequence: number;
  readonly resultHash: string;
  /** 服务端与轮次同步持久化的 RNG 求值前特性状态。 */
  readonly originFeatureState: FeatureState;
  readonly result: DecodedRgsSpin;
}

export interface DecodedRgsError {
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
}

export interface DecodedResultDeliveryAcknowledgement {
  readonly requestId: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly roundId: string;
  readonly sequence: number;
  readonly resultHash: string;
  readonly acknowledgedAt: string;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const JURISDICTION_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
const MONEY_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_MONEY_PATTERN = /^[1-9][0-9]*$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_CLIENT_INTEGER = 9_007_199_254_740_991;
const lockedVaultFaceSet = new Set<string>(LOCKED_VAULT_FACES);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RgsProtocolError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new RgsProtocolError(`${path}.${unexpected} is not allowed`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new RgsProtocolError(`${path}.${missing} is required`);
}

function text(value: unknown, path: string, minimum = 1, maximum = 128): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new RgsProtocolError(`${path} must be a string with length ${minimum}-${maximum}`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const decoded = text(value, path);
  if (!IDENTIFIER_PATTERN.test(decoded)) throw new RgsProtocolError(`${path} must be an identifier`);
  return decoded;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new RgsProtocolError(`${path} must be boolean`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RgsProtocolError(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function decimal(value: unknown, path: string, positive = false): MoneyMinor {
  const decoded = text(value, path, 1, 19);
  const pattern = positive ? POSITIVE_MONEY_PATTERN : MONEY_PATTERN;
  if (!pattern.test(decoded) || BigInt(decoded) > MAX_SIGNED_INT64) {
    throw new RgsProtocolError(`${path} must be a canonical signed-int64 decimal string`);
  }
  return decoded;
}

function revision(value: unknown, path: string): string {
  return decimal(value, path);
}

function sequence(value: unknown, path: string): number {
  const decoded = decimal(value, path);
  const numeric = Number(decoded);
  if (!Number.isSafeInteger(numeric) || numeric > MAX_CLIENT_INTEGER) {
    throw new RgsProtocolError(`${path} exceeds the browser sequence domain`);
  }
  return numeric;
}

function positivePresentationInteger(value: unknown, path: string): number {
  const decoded = decimal(value, path, true);
  const numeric = Number(decoded);
  if (!Number.isSafeInteger(numeric) || numeric > 1_000_000) {
    throw new RgsProtocolError(`${path} exceeds the presentation integer domain`);
  }
  return numeric;
}

function binding(value: unknown, path: string): RgsBinding {
  const decoded = record(value, path);
  const keys = [
    "operatorId",
    "sessionId",
    "gameId",
    "definitionVersion",
    "definitionHash",
    "currency",
    "currencyExponent",
    "jurisdiction",
  ] as const;
  for (const key of keys) {
    if (!Object.hasOwn(decoded, key)) throw new RgsProtocolError(`${path}.${key} is required`);
  }
  const definitionHash = text(decoded.definitionHash, `${path}.definitionHash`, 64, 64);
  const currency = text(decoded.currency, `${path}.currency`, 3, 3);
  const jurisdiction = text(decoded.jurisdiction, `${path}.jurisdiction`, 2, 16);
  if (!DIGEST_PATTERN.test(definitionHash)) {
    throw new RgsProtocolError(`${path}.definitionHash must be a lowercase SHA-256 digest`);
  }
  if (!CURRENCY_PATTERN.test(currency)) throw new RgsProtocolError(`${path}.currency is invalid`);
  if (!JURISDICTION_PATTERN.test(jurisdiction)) {
    throw new RgsProtocolError(`${path}.jurisdiction is invalid`);
  }
  return Object.freeze({
    operatorId: identifier(decoded.operatorId, `${path}.operatorId`),
    sessionId: identifier(decoded.sessionId, `${path}.sessionId`),
    gameId: identifier(decoded.gameId, `${path}.gameId`),
    definitionVersion: identifier(decoded.definitionVersion, `${path}.definitionVersion`),
    definitionHash,
    currency,
    currencyExponent: integer(decoded.currencyExponent, `${path}.currencyExponent`, 0, 6),
    jurisdiction,
  });
}

export function sameRgsBinding(left: RgsBinding, right: RgsBinding): boolean {
  return left.operatorId === right.operatorId
    && left.sessionId === right.sessionId
    && left.gameId === right.gameId
    && left.definitionVersion === right.definitionVersion
    && left.definitionHash === right.definitionHash
    && left.currency === right.currency
    && left.currencyExponent === right.currencyExponent
    && left.jurisdiction === right.jurisdiction;
}

function featureState(value: unknown, path: string): FeatureState {
  const decoded = record(value, path);
  const keys = [
    "mode",
    "remaining",
    "awarded",
    "betMinor",
    "winMinor",
    "rageLevel",
    "rageCollected",
  ] as const;
  exactKeys(decoded, keys, keys, path);
  const mode = text(decoded.mode, `${path}.mode`);
  if (mode !== "NONE" && mode !== "EXPANSION" && mode !== "OVERDRIVE") {
    throw new RgsProtocolError(`${path}.mode is unsupported`);
  }
  const remaining = integer(decoded.remaining, `${path}.remaining`, 0, 1_000_000);
  const awarded = integer(decoded.awarded, `${path}.awarded`, 0, 1_000_000);
  const betMinor = decimal(decoded.betMinor, `${path}.betMinor`);
  const winMinor = decimal(decoded.winMinor, `${path}.winMinor`);
  const rageLevel = integer(decoded.rageLevel, `${path}.rageLevel`, 1, 1_000_000);
  const rageCollected = integer(decoded.rageCollected, `${path}.rageCollected`, 0, 1_000_000);
  if (mode === "NONE") {
    if (remaining !== 0 || awarded !== 0 || betMinor !== "0" || winMinor !== "0") {
      throw new RgsProtocolError(`${path} has a non-canonical NONE projection`);
    }
    return Object.freeze({
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel,
      rageCollected,
    });
  }
  if (remaining < 1 || awarded < remaining || betMinor === "0") {
    throw new RgsProtocolError(`${path} has invalid active Free Spins counters or bet`);
  }
  return Object.freeze({
    mode,
    freeSpinsRemaining: remaining,
    freeSpinsPlayed: awarded - remaining,
    baseBetMinor: betMinor,
    freeSpinsWinMinor: winMinor,
    rageLevel,
    rageCollected,
  });
}

function envelope(value: unknown, path: string): { data: unknown; requestId: string } {
  const decoded = record(value, path);
  exactKeys(decoded, ["data", "requestId"], ["data", "requestId"], path);
  return { data: decoded.data, requestId: identifier(decoded.requestId, `${path}.requestId`) };
}

function requireMatchingRequestId(actual: string, expected: string): void {
  if (actual !== expected) throw new RgsProtocolError("response requestId does not match the request");
}

export function decodeRgsExchange(
  value: unknown,
  expectedRequestId: string,
  expectedOperatorId: string,
  expectedSessionId: string,
): DecodedRgsExchange {
  const decodedEnvelope = envelope(value, "response");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  const data = record(decodedEnvelope.data, "response.data");
  exactKeys(
    data,
    ["accessToken", "serverTime", "session"],
    ["accessToken", "serverTime", "session"],
    "response.data",
  );
  const accessToken = text(data.accessToken, "response.data.accessToken", 80, 8_192);
  const serverTime = text(data.serverTime, "response.data.serverTime", 20, 64);
  if (!Number.isFinite(Date.parse(serverTime))) {
    throw new RgsProtocolError("response.data.serverTime must be an RFC3339 timestamp");
  }
  const rawSession = record(data.session, "response.data.session");
  const sessionKeys = [
    "operatorId",
    "sessionId",
    "gameId",
    "definitionVersion",
    "definitionHash",
    "currency",
    "currencyExponent",
    "jurisdiction",
    "status",
    "expiresAt",
    "idleDisconnectAt",
    "balanceMinor",
    "revision",
    "sequence",
    "feature",
  ] as const;
  exactKeys(rawSession, sessionKeys, sessionKeys, "response.data.session");
  const decodedBinding = binding(rawSession, "response.data.session");
  if (decodedBinding.operatorId !== expectedOperatorId || decodedBinding.sessionId !== expectedSessionId) {
    throw new RgsProtocolError("exchange returned a foreign operator/session binding");
  }
  const status = text(rawSession.status, "response.data.session.status") as DecodedRgsSession["status"];
  if (!(["ACTIVE", "BLOCKED", "CLOSED", "EXPIRED"] as const).includes(status)) {
    throw new RgsProtocolError("response.data.session.status is unsupported");
  }
  const expiresAt = text(rawSession.expiresAt, "response.data.session.expiresAt", 20, 64);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new RgsProtocolError("response.data.session.expiresAt must be an RFC3339 timestamp");
  }
  const idleDisconnectAt = text(
    rawSession.idleDisconnectAt,
    "response.data.session.idleDisconnectAt",
    20,
    64,
  );
  const idleDisconnectTime = Date.parse(idleDisconnectAt);
  if (!Number.isFinite(idleDisconnectTime)) {
    throw new RgsProtocolError(
      "response.data.session.idleDisconnectAt must be an RFC3339 timestamp",
    );
  }
  if (idleDisconnectTime > Date.parse(expiresAt)) {
    throw new RgsProtocolError(
      "response.data.session.idleDisconnectAt must not exceed the session expiry",
    );
  }
  return Object.freeze({
    requestId: decodedEnvelope.requestId,
    accessToken,
    serverTime,
    session: Object.freeze({
      binding: decodedBinding,
      status,
      expiresAt,
      idleDisconnectAt,
      balanceMinor: decimal(rawSession.balanceMinor, "response.data.session.balanceMinor"),
      revision: revision(rawSession.revision, "response.data.session.revision"),
      sequence: sequence(rawSession.sequence, "response.data.session.sequence"),
      featureState: featureState(rawSession.feature, "response.data.session.feature"),
    }),
  });
}

export function rgsSessionOpened(
  exchange: Pick<DecodedRgsExchange, "requestId" | "session">,
  betOptionsMinor: readonly MoneyMinor[],
  defaultBetMinor: MoneyMinor,
): SessionOpened {
  const decoded = decodeServerMessage({
    type: "session.opened",
    protocolVersion: 1,
    // RGS 另行绑定不可变数学定义；共享客户端状态机仍必须证明当前浏览器构建与其他
    // gateway 使用同一套表现/校验规则版本。
    engineRulesVersion: ENGINE_RULES_VERSION,
    requestId: exchange.requestId,
    sessionId: exchange.session.binding.sessionId,
    currency: exchange.session.binding.currency,
    currencyExponent: exchange.session.binding.currencyExponent,
    balanceMinor: exchange.session.balanceMinor,
    betOptionsMinor: [...betOptionsMinor],
    defaultBetMinor,
    featureState: exchange.session.featureState,
  });
  if (decoded.type !== "session.opened") throw new RgsProtocolError("invalid session projection");
  // 通用消息解码器只负责共享玩法协议；RGS 在其已验证的完整绑定上追加表现规则身份。
  return {
    ...decoded,
    idleDisconnectAt: exchange.session.idleDisconnectAt,
    definitionBinding: Object.freeze({
      gameId: exchange.session.binding.gameId,
      definitionVersion: exchange.session.binding.definitionVersion,
      definitionHash: exchange.session.binding.definitionHash,
    }),
  };
}

/**
 * 原版 FLUSH 的 HTTP 等价物：只读取会话终止状态与服务端时间，绝不携带或更新
 * 余额、轮次、特性、revision 或 sequence。
 */
export function decodeRgsSessionStatus(
  value: unknown,
  expectedRequestId: string,
  expectedOperatorId: string,
  expectedSessionId: string,
): DecodedRgsSessionStatus {
  const decodedEnvelope = envelope(value, "response");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  const decoded = record(decodedEnvelope.data, "response.data");
  const keys = [
    "operatorId",
    "sessionId",
    "status",
    "idleDisconnectAt",
    "serverTime",
  ] as const;
  exactKeys(decoded, keys, keys, "response.data");
  const operatorId = identifier(decoded.operatorId, "response.data.operatorId");
  const sessionId = identifier(decoded.sessionId, "response.data.sessionId");
  if (operatorId !== expectedOperatorId || sessionId !== expectedSessionId) {
    throw new RgsProtocolError("session status returned a foreign operator/session binding");
  }
  const status = text(decoded.status, "response.data.status") as DecodedRgsSessionStatus["status"];
  if (status !== "ACTIVE" && status !== "EXPIRED") {
    throw new RgsProtocolError("response.data.status is unsupported");
  }
  const idleDisconnectAt = text(
    decoded.idleDisconnectAt,
    "response.data.idleDisconnectAt",
    20,
    64,
  );
  const serverTime = text(decoded.serverTime, "response.data.serverTime", 20, 64);
  if (!Number.isFinite(Date.parse(idleDisconnectAt))) {
    throw new RgsProtocolError(
      "response.data.idleDisconnectAt must be an RFC3339 timestamp",
    );
  }
  if (!Number.isFinite(Date.parse(serverTime))) {
    throw new RgsProtocolError("response.data.serverTime must be an RFC3339 timestamp");
  }
  return Object.freeze({
    requestId: decodedEnvelope.requestId,
    operatorId,
    sessionId,
    status,
    idleDisconnectAt,
    serverTime,
  });
}

function position(value: unknown, path: string): { reel: number; row: number } {
  const decoded = record(value, path);
  exactKeys(decoded, ["reel", "row"], ["reel", "row"], path);
  return {
    reel: integer(decoded.reel, `${path}.reel`, 0, 2),
    row: integer(decoded.row, `${path}.row`, 0, 7),
  };
}

function positions(value: unknown, path: string, minimum: number, maximum: number): { reel: number; row: number }[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new RgsProtocolError(`${path} must contain ${minimum}-${maximum} positions`);
  }
  return value.map((item, index) => position(item, `${path}[${index}]`));
}

function translatedGrid(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new RgsProtocolError("response.data.grid must contain exactly three reels");
  }
  return value.map((rawReel, reelIndex) => {
    if (!Array.isArray(rawReel) || rawReel.length < 3 || rawReel.length > 8) {
      throw new RgsProtocolError(`response.data.grid[${reelIndex}] must contain 3-8 rows`);
    }
    return rawReel.map((rawCell, rowIndex) => {
      const path = `response.data.grid[${reelIndex}][${rowIndex}]`;
      const decoded = record(rawCell, path);
      exactKeys(
        decoded,
        ["symbol", "multiplier", "prize", "lockedVaultFace"],
        ["symbol"],
        path,
      );
      const symbol = identifier(decoded.symbol, `${path}.symbol`);
      const result: Record<string, unknown> = { symbol };
      if (decoded.multiplier !== undefined) {
        result.multiplier = integer(decoded.multiplier, `${path}.multiplier`, 1, 1_000_000);
      }
      if (decoded.prize !== undefined) result.prize = identifier(decoded.prize, `${path}.prize`);
      if (decoded.lockedVaultFace !== undefined) {
        const face = text(decoded.lockedVaultFace, `${path}.lockedVaultFace`) as LockedVaultFace;
        if (!lockedVaultFaceSet.has(face)) {
          throw new RgsProtocolError(`${path}.lockedVaultFace is unsupported`);
        }
        if (symbol !== "VAULT") {
          throw new RgsProtocolError(`${path}.lockedVaultFace is only allowed on VAULT`);
        }
        if (decoded.multiplier !== undefined || decoded.prize !== undefined) {
          throw new RgsProtocolError(
            `${path}.lockedVaultFace cannot coexist with multiplier or prize`,
          );
        }
        result.lockedVaultFace = face;
      }
      return result;
    });
  });
}

function translatedWins(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new RgsProtocolError("response.data.wins must be an array with at most 4096 entries");
  }
  return value.map((rawWin, winIndex) => {
    const path = `response.data.wins[${winIndex}]`;
    const decoded = record(rawWin, path);
    const required = ["id", "symbol", "ways", "amountMinor", "cells", "pathAwards"] as const;
    exactKeys(decoded, [...required, "multiplier"], required, path);
    if (!Array.isArray(decoded.pathAwards) || decoded.pathAwards.length < 1 || decoded.pathAwards.length > 512) {
      throw new RgsProtocolError(`${path}.pathAwards must contain 1-512 entries`);
    }
    const translated: Record<string, unknown> = {
      id: identifier(decoded.id, `${path}.id`),
      symbol: identifier(decoded.symbol, `${path}.symbol`),
      ways: integer(decoded.ways, `${path}.ways`, 1, 512),
      amountMinor: decimal(decoded.amountMinor, `${path}.amountMinor`, true),
      cells: positions(decoded.cells, `${path}.cells`, 1, 24),
      pathAwards: decoded.pathAwards.map((rawAward, awardIndex) => {
        const awardPath = `${path}.pathAwards[${awardIndex}]`;
        const award = record(rawAward, awardPath);
        const keys = ["cells", "multiplier", "baseAmountMinor", "amountMinor"] as const;
        exactKeys(award, keys, keys, awardPath);
        return {
          cells: positions(award.cells, `${awardPath}.cells`, 3, 3),
          multiplier: positivePresentationInteger(award.multiplier, `${awardPath}.multiplier`),
          baseAmountMinor: decimal(award.baseAmountMinor, `${awardPath}.baseAmountMinor`),
          amountMinor: decimal(award.amountMinor, `${awardPath}.amountMinor`),
        };
      }),
    };
    if (decoded.multiplier !== undefined) {
      translated.multiplier = positivePresentationInteger(decoded.multiplier, `${path}.multiplier`);
    }
    return translated;
  });
}

const RGS_EVENT_KEYS = [
  "type",
  "count",
  "cells",
  "triggered",
  "guaranteed",
  "outcome",
  "prize",
  "multiplier",
  "amountMinor",
  "cumulativeWinMinor",
  "mode",
  "awarded",
  "rows",
  "ways",
  "reel",
  "row",
  "level",
  "total",
  "step",
  "fromMultiplier",
  "toMultiplier",
] as const;

function translatedEvents(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 4_096) {
    throw new RgsProtocolError("response.data.events must be an array with at most 4096 entries");
  }
  return value.map((rawEvent, eventIndex) => {
    const path = `response.data.events[${eventIndex}]`;
    const decoded = record(rawEvent, path);
    exactKeys(decoded, RGS_EVENT_KEYS, RGS_EVENT_KEYS, path);
    const type = identifier(decoded.type, `${path}.type`);
    const count = integer(decoded.count, `${path}.count`, 0, 1_000_000);
    const cells = positions(decoded.cells, `${path}.cells`, 0, 24);
    const triggered = boolean(decoded.triggered, `${path}.triggered`);
    const guaranteed = boolean(decoded.guaranteed, `${path}.guaranteed`);
    const outcome = text(decoded.outcome, `${path}.outcome`, 0, 128);
    const prize = text(decoded.prize, `${path}.prize`, 0, 128);
    const multiplier = decimal(decoded.multiplier, `${path}.multiplier`);
    const amountMinor = decimal(decoded.amountMinor, `${path}.amountMinor`);
    const cumulativeWinMinor = decimal(decoded.cumulativeWinMinor, `${path}.cumulativeWinMinor`);
    const mode = text(decoded.mode, `${path}.mode`);
    if (mode !== "NONE" && mode !== "EXPANSION" && mode !== "OVERDRIVE") {
      throw new RgsProtocolError(`${path}.mode is unsupported`);
    }
    const awarded = integer(decoded.awarded, `${path}.awarded`, 0, 1_000_000);
    const rows = integer(decoded.rows, `${path}.rows`, 0, 8);
    const ways = integer(decoded.ways, `${path}.ways`, 0, 2_147_483_647);
    const reel = integer(decoded.reel, `${path}.reel`, 0, 2);
    const row = integer(decoded.row, `${path}.row`, 0, 7);
    const level = integer(decoded.level, `${path}.level`, 0, 1_000_000);
    const total = integer(decoded.total, `${path}.total`, 0, 1_000_000);
    const step = integer(decoded.step, `${path}.step`, 0, 16);
    const fromMultiplier = decimal(decoded.fromMultiplier, `${path}.fromMultiplier`);
    const toMultiplier = decimal(decoded.toMultiplier, `${path}.toMultiplier`);

    switch (type) {
      case "surge.collected":
        return { type, count, cells, triggered, guaranteed, level, total };
      case "rage.transformed":
        return { type, count, cells, level, total };
      case "wheel.started":
        return { type };
      case "wheel.awarded":
        if (outcome === "INSTANT") {
          return {
            type,
            outcome,
            prize: identifier(prize, `${path}.prize`),
            multiplier: positivePresentationInteger(multiplier, `${path}.multiplier`),
            amountMinor,
          };
        }
        if (outcome === "EXPANSION" || outcome === "OVERDRIVE") return { type, outcome };
        throw new RgsProtocolError(`${path}.outcome is unsupported`);
      case "free_spins.started":
        if (mode === "NONE") throw new RgsProtocolError(`${path}.mode cannot be NONE`);
        return { type, mode, awarded };
      case "grid.expanded":
        return { type, rows, ways };
      case "vaults.landed":
      case "vaults.locked":
      case "vaults.unlock.started":
      case "vaults.unlock.completed":
        return { type, count, cells };
      case "vault.unlocked": {
        const event: Record<string, unknown> = {
          type,
          reel,
          row,
          prize: identifier(prize, `${path}.prize`),
        };
        if (multiplier !== "0") {
          event.multiplier = positivePresentationInteger(multiplier, `${path}.multiplier`);
        }
        return event;
      }
      case "vault.awarded":
        return {
          type,
          reel,
          row,
          prize: identifier(prize, `${path}.prize`),
          multiplier: positivePresentationInteger(multiplier, `${path}.multiplier`),
          amountMinor,
        };
      case "free_spin.awarded":
        return { type, count, reel, row };
      case "free_spin.cap_reached":
        return { type, reel, row };
      case "vaults.upgrade.started":
        return { type, count, step };
      case "vault.upgraded":
        return {
          type,
          reel,
          row,
          fromMultiplier: positivePresentationInteger(fromMultiplier, `${path}.fromMultiplier`),
          toMultiplier: positivePresentationInteger(toMultiplier, `${path}.toMultiplier`),
          prize: identifier(prize, `${path}.prize`),
          step,
        };
      case "free_spins.completed":
        if (mode === "NONE") throw new RgsProtocolError(`${path}.mode cannot be NONE`);
        return { type, mode, awarded, cumulativeWinMinor };
      default:
        throw new RgsProtocolError(`${path}.type is unsupported`);
    }
  });
}

function decodedSpinData(
  value: unknown,
  requestId: string,
  onStage?: RgsSpinDecodeStageObserver,
): DecodedRgsSpin {
  onStage?.("decode-data-shape");
  const decoded = record(value, "response.data");
  const keys = [
    "operatorId",
    "sessionId",
    "roundId",
    "gameId",
    "definitionVersion",
    "definitionHash",
    "currency",
    "roundKind",
    "serverTransactionId",
    "walletTransactionId",
    "startRevision",
    "endRevision",
    "resultHash",
    "idleDisconnectAt",
    "sequence",
    "betMinor",
    "chargedBetMinor",
    "balanceMinor",
    "totalWinMinor",
    "grid",
    "wins",
    "events",
    "feature",
  ] as const;
  exactKeys(decoded, keys, keys, "response.data");
  // 旋转响应省略会话交换绑定中保持不可变的 exponent/jurisdiction；这里只解码返回的
  // 经济身份，再由网关与完整会话交换绑定合并并逐项比较。
  onStage?.("decode-binding");
  const operatorId = identifier(decoded.operatorId, "response.data.operatorId");
  const sessionId = identifier(decoded.sessionId, "response.data.sessionId");
  const gameId = identifier(decoded.gameId, "response.data.gameId");

  onStage?.("decode-metadata");
  const definitionVersion = identifier(decoded.definitionVersion, "response.data.definitionVersion");
  const definitionHash = text(decoded.definitionHash, "response.data.definitionHash", 64, 64);
  if (!DIGEST_PATTERN.test(definitionHash)) throw new RgsProtocolError("response.data.definitionHash is invalid");
  const currency = text(decoded.currency, "response.data.currency", 3, 3);
  if (!CURRENCY_PATTERN.test(currency)) throw new RgsProtocolError("response.data.currency is invalid");
  const roundKind = text(decoded.roundKind, "response.data.roundKind") as RgsRoundKind;
  if (!(["BASE", "FREE_SPIN", "BONUS"] as const).includes(roundKind)) {
    throw new RgsProtocolError("response.data.roundKind is unsupported");
  }

  onStage?.("decode-grid");
  const grid = translatedGrid(decoded.grid);

  onStage?.("decode-wins");
  const wins = translatedWins(decoded.wins);

  onStage?.("decode-events");
  const events = translatedEvents(decoded.events);

  onStage?.("decode-feature");
  const decodedFeatureState = featureState(decoded.feature, "response.data.feature");

  onStage?.("decode-projection");
  onStage?.("projection-round-id");
  const roundId = identifier(decoded.roundId, "response.data.roundId");

  onStage?.("projection-sequence");
  const decodedSequence = sequence(decoded.sequence, "response.data.sequence");

  onStage?.("projection-money-fields");
  const betMinor = decimal(decoded.betMinor, "response.data.betMinor", true);
  const chargedBetMinor = decimal(decoded.chargedBetMinor, "response.data.chargedBetMinor");
  const balanceMinor = decimal(decoded.balanceMinor, "response.data.balanceMinor");
  const totalWinMinor = decimal(decoded.totalWinMinor, "response.data.totalWinMinor");

  onStage?.("projection-message-input");
  const translated = decodeServerMessage({
    type: "spin.result",
    protocolVersion: 1,
    requestId,
    sessionId,
    roundId,
    sequence: decodedSequence,
    betMinor,
    chargedBetMinor,
    balanceMinor,
    totalWinMinor,
    grid,
    wins,
    events,
    featureState: decodedFeatureState,
  }, onStage);
  if (translated.type !== "spin.result") throw new RgsProtocolError("invalid spin projection");

  onStage?.("decode-commit-metadata");
  const serverTransactionId = identifier(
    decoded.serverTransactionId,
    "response.data.serverTransactionId",
  );
  const walletTransactionId = identifier(
    decoded.walletTransactionId,
    "response.data.walletTransactionId",
  );
  const startRevision = revision(decoded.startRevision, "response.data.startRevision");
  const endRevision = revision(decoded.endRevision, "response.data.endRevision");
  const resultHash = text(decoded.resultHash, "response.data.resultHash", 64, 64);
  if (!DIGEST_PATTERN.test(resultHash)) {
    throw new RgsProtocolError("response.data.resultHash is invalid");
  }
  const idleDisconnectAt = text(
    decoded.idleDisconnectAt,
    "response.data.idleDisconnectAt",
    20,
    64,
  );
  if (!Number.isFinite(Date.parse(idleDisconnectAt))) {
    throw new RgsProtocolError(
      "response.data.idleDisconnectAt must be an RFC3339 timestamp",
    );
  }

  const result = Object.freeze({
    result: translated,
    binding: Object.freeze({
      operatorId,
      sessionId,
      gameId,
      definitionVersion,
      definitionHash,
      currency,
    }),
    roundKind,
    serverTransactionId,
    walletTransactionId,
    startRevision,
    endRevision,
    resultHash,
    idleDisconnectAt,
  });
  onStage?.("decode-complete");
  return result;
}

export function decodeRgsSpin(
  value: unknown,
  expectedRequestId: string,
  onStage?: RgsSpinDecodeStageObserver,
): DecodedRgsSpin {
  onStage?.("decode-envelope");
  const decodedEnvelope = envelope(value, "response");
  onStage?.("decode-request-id");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  return decodedSpinData(decodedEnvelope.data, decodedEnvelope.requestId, onStage);
}

export function decodeRgsRoundStatus(
  value: unknown,
  expectedRequestId: string,
): DecodedRgsRoundStatus {
  const decodedEnvelope = envelope(value, "response");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  const decoded = record(decodedEnvelope.data, "response.data");
  const required = ["operatorId", "sessionId", "roundId", "status"] as const;
  exactKeys(decoded, [...required, "result"], required, "response.data");
  const status = text(decoded.status, "response.data.status") as DecodedRgsRoundStatus["status"];
  if (!(["PREPARED", "WALLET_PENDING", "COMMITTED", "REJECTED", "MANUAL_REVIEW"] as const).includes(status)) {
    throw new RgsProtocolError("response.data.status is unsupported");
  }
  if ((status === "COMMITTED") !== Object.hasOwn(decoded, "result")) {
    throw new RgsProtocolError("only COMMITTED round status may contain result");
  }
  const base = {
    requestId: decodedEnvelope.requestId,
    operatorId: identifier(decoded.operatorId, "response.data.operatorId"),
    sessionId: identifier(decoded.sessionId, "response.data.sessionId"),
    roundId: identifier(decoded.roundId, "response.data.roundId"),
    status,
  };
  return Object.freeze(status === "COMMITTED"
    ? { ...base, result: decodedSpinData(decoded.result, decodedEnvelope.requestId) }
    : base);
}

export function decodePendingResultDelivery(
  value: unknown,
  expectedRequestId: string,
): DecodedPendingResultDelivery {
  const decodedEnvelope = envelope(value, "response");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  const decoded = record(decodedEnvelope.data, "response.data");
  const keys = [
    "operatorId",
    "sessionId",
    "roundId",
    "sequence",
    "resultHash",
    "originFeature",
    "result",
  ] as const;
  exactKeys(decoded, keys, keys, "response.data");
  const operatorId = identifier(decoded.operatorId, "response.data.operatorId");
  const sessionId = identifier(decoded.sessionId, "response.data.sessionId");
  const roundId = identifier(decoded.roundId, "response.data.roundId");
  const deliveredSequence = sequence(decoded.sequence, "response.data.sequence");
  const resultHash = text(decoded.resultHash, "response.data.resultHash", 64, 64);
  if (!DIGEST_PATTERN.test(resultHash)) {
    throw new RgsProtocolError("response.data.resultHash is invalid");
  }
  const result = decodedSpinData(decoded.result, decodedEnvelope.requestId);
  if (result.binding.operatorId !== operatorId || result.binding.sessionId !== sessionId
    || result.result.roundId !== roundId || result.result.sequence !== deliveredSequence
    || result.resultHash !== resultHash) {
    throw new RgsProtocolError("pending result delivery identity mismatch");
  }
  return Object.freeze({
    requestId: decodedEnvelope.requestId,
    operatorId,
    sessionId,
    roundId,
    sequence: deliveredSequence,
    resultHash,
    originFeatureState: featureState(decoded.originFeature, "response.data.originFeature"),
    result,
  });
}

export function decodeResultDeliveryAcknowledgement(
  value: unknown,
  expectedRequestId: string,
  expectedOperatorId: string,
  expectedSessionId: string,
  expectedRoundId: string,
  expectedSequence: number,
  expectedResultHash: string,
): DecodedResultDeliveryAcknowledgement {
  const decodedEnvelope = envelope(value, "response");
  requireMatchingRequestId(decodedEnvelope.requestId, expectedRequestId);
  const decoded = record(decodedEnvelope.data, "response.data");
  const keys = [
    "operatorId", "sessionId", "roundId", "sequence", "resultHash", "acknowledgedAt",
  ] as const;
  exactKeys(decoded, keys, keys, "response.data");
  const operatorId = identifier(decoded.operatorId, "response.data.operatorId");
  const sessionId = identifier(decoded.sessionId, "response.data.sessionId");
  const roundId = identifier(decoded.roundId, "response.data.roundId");
  const deliveredSequence = sequence(decoded.sequence, "response.data.sequence");
  const resultHash = text(decoded.resultHash, "response.data.resultHash", 64, 64);
  if (!DIGEST_PATTERN.test(resultHash)) {
    throw new RgsProtocolError("response.data.resultHash is invalid");
  }
  if (operatorId !== expectedOperatorId || sessionId !== expectedSessionId
    || roundId !== expectedRoundId || deliveredSequence !== expectedSequence
    || resultHash !== expectedResultHash) {
    throw new RgsProtocolError("result delivery acknowledgement identity mismatch");
  }
  const acknowledgedAt = text(decoded.acknowledgedAt, "response.data.acknowledgedAt", 20, 64);
  if (Number.isNaN(Date.parse(acknowledgedAt))) {
    throw new RgsProtocolError("response.data.acknowledgedAt is invalid");
  }
  return Object.freeze({
    requestId: decodedEnvelope.requestId,
    operatorId,
    sessionId,
    roundId,
    sequence: deliveredSequence,
    resultHash,
    acknowledgedAt,
  });
}

export function decodeRgsError(value: unknown, expectedRequestId: string): DecodedRgsError {
  const decoded = record(value, "response");
  exactKeys(decoded, ["error", "requestId"], ["error", "requestId"], "response");
  const requestId = identifier(decoded.requestId, "response.requestId");
  requireMatchingRequestId(requestId, expectedRequestId);
  const body = record(decoded.error, "response.error");
  exactKeys(body, ["code", "message"], ["code", "message"], "response.error");
  const code = text(body.code, "response.error.code", 2, 128);
  if (!ERROR_CODE_PATTERN.test(code)) throw new RgsProtocolError("response.error.code is invalid");
  return Object.freeze({
    requestId,
    code,
    message: text(body.message, "response.error.message", 1, 256),
  });
}

export function parseRgsJson(textValue: string): unknown {
  if (textValue.length === 0 || textValue.length > 4 * 1024 * 1024) {
    throw new RgsProtocolError("RGS response body is empty or exceeds 4 MiB");
  }
  try {
    return JSON.parse(textValue) as unknown;
  } catch {
    throw new RgsProtocolError("RGS response is not valid JSON");
  }
}
