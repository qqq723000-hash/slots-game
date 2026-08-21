import type {
  CellAddress,
  FeatureEvent,
  FeatureMode,
  FeatureState,
  GridCell,
  MoneyMinor,
  PathAward,
  ServerMessage,
  SpinResult,
  WheelAwardedEvent,
  Win,
} from "../app/state/types";
import {
  SpinResultOriginError,
  validateVaultEventsAgainstOrigin,
} from "./spinResultOriginGuard";
import { ENGINE_RULES_VERSION } from "./messages";
import {
  LOCKED_VAULT_FACES,
  SYMBOL_IDS,
  WHEEL_INSTANT_MULTIPLIER_BY_TIER,
  type SymbolId,
  type WheelJackpotTier,
} from "./protocolConstants";

export class ProtocolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

/** 只标记 spin.result 投影内部的固定校验边界，不携带任何业务值。 */
export type SpinResultProjectionDecodeStage =
  | "projection-message-shape"
  | "projection-message-grid"
  | "projection-message-wins"
  | "projection-message-events"
  | "projection-message-feature"
  | "projection-invariant-win-identities"
  | "projection-invariant-award-total"
  | "projection-invariant-wheel"
  | "projection-invariant-vault"
  | "projection-invariant-reels"
  | "projection-message-output";

type SpinResultProjectionStageObserver = (stage: SpinResultProjectionDecodeStage) => void;

const MONEY_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const symbolSet = new Set<string>(SYMBOL_IDS);
const lockedVaultFaceSet = new Set<string>(LOCKED_VAULT_FACES);
const payingSymbolSet = new Set<SymbolId>(["ORBIT", "PRISM", "PULSE", "NOVA", "CIRCUIT", "TANK"]);
const featureModes = new Set<FeatureMode>(["BASE", "EXPANSION", "OVERDRIVE"]);
const VAULT_EVENT_TYPES = new Set<FeatureEvent["type"]>([
  "vaults.landed",
  "vaults.locked",
  "vaults.unlock.started",
  "vaults.unlock.completed",
  "vault.unlocked",
  "vault.awarded",
  "vaults.upgrade.started",
  "vault.upgraded",
  "free_spin.awarded",
  "free_spin.cap_reached",
]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolDecodeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new ProtocolDecodeError(`${path}.${unexpected} is not allowed`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolDecodeError(`${path} must be a non-empty string`);
  }
  return value;
}

function boundedString(value: unknown, path: string, maximumLength: number): string {
  const decoded = string(value, path);
  if (decoded.length > maximumLength) {
    throw new ProtocolDecodeError(`${path} must be at most ${maximumLength} characters`);
  }
  return decoded;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolDecodeError(`${path} must be a finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const decoded = number(value, path);
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new ProtocolDecodeError(`${path} must be a non-negative safe integer`);
  }
  return decoded;
}

function positiveInteger(value: unknown, path: string): number {
  const decoded = nonNegativeInteger(value, path);
  if (decoded === 0) throw new ProtocolDecodeError(`${path} must be a positive safe integer`);
  return decoded;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const decoded = number(value, path);
  if (!Number.isSafeInteger(decoded) || decoded < minimum || decoded > maximum) {
    throw new ProtocolDecodeError(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return decoded;
}

function money(value: unknown, path: string): MoneyMinor {
  const decoded = string(value, path);
  if (!MONEY_PATTERN.test(decoded)
    || decoded.length > 19
    || BigInt(decoded) > MAX_SIGNED_INT64) {
    throw new ProtocolDecodeError(`${path} must be a non-negative signed-int64 minor-unit integer string`);
  }
  return decoded;
}

function identifier(value: unknown, path: string): string {
  const decoded = string(value, path);
  if (decoded.length > 128 || !IDENTIFIER_PATTERN.test(decoded)) {
    throw new ProtocolDecodeError(`${path} must be a protocol identifier`);
  }
  return decoded;
}

function optionalIdentifier(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : identifier(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ProtocolDecodeError(`${path} must be boolean`);
  return value;
}

function symbol(value: unknown, path: string): SymbolId {
  const decoded = string(value, path);
  if (!symbolSet.has(decoded)) {
    throw new ProtocolDecodeError(`${path} contains unsupported symbol ${decoded}`);
  }
  return decoded as SymbolId;
}

function featureState(value: unknown, path: string): FeatureState {
  const decoded = record(value, path);
  exactKeys(decoded, [
    "mode",
    "freeSpinsRemaining",
    "freeSpinsPlayed",
    "baseBetMinor",
    "freeSpinsWinMinor",
    "rageLevel",
    "rageCollected",
  ], path);
  const mode = string(decoded.mode, `${path}.mode`) as FeatureMode;
  if (!featureModes.has(mode)) throw new ProtocolDecodeError(`${path}.mode is unsupported`);

  const state: FeatureState = {
    mode,
    freeSpinsRemaining: boundedInteger(decoded.freeSpinsRemaining, `${path}.freeSpinsRemaining`, 0, 1_000_000),
    // 这两个字段晚于首版客户端投影。缺失时仅为旧会话夹具提供兼容默认值；
    // 所有在线服务端状态仍会归一化为可安全重连的 Rage 投影。
    rageLevel: decoded.rageLevel === undefined
      ? 1
      : boundedInteger(decoded.rageLevel, `${path}.rageLevel`, 1, 1_000_000),
    rageCollected: decoded.rageCollected === undefined
      ? 0
      : boundedInteger(decoded.rageCollected, `${path}.rageCollected`, 0, 1_000_000),
  };
  if (decoded.freeSpinsPlayed !== undefined) {
    state.freeSpinsPlayed = boundedInteger(decoded.freeSpinsPlayed, `${path}.freeSpinsPlayed`, 0, 1_000_000);
  }
  if (decoded.baseBetMinor !== undefined) {
    state.baseBetMinor = money(decoded.baseBetMinor, `${path}.baseBetMinor`);
  }
  if (decoded.freeSpinsWinMinor !== undefined) {
    state.freeSpinsWinMinor = money(decoded.freeSpinsWinMinor, `${path}.freeSpinsWinMinor`);
  }
  return state;
}

function cell(value: unknown, path: string): GridCell {
  const decoded = record(value, path);
  exactKeys(decoded, ["symbol", "multiplier", "prize", "lockedVaultFace"], path);
  const result: GridCell = { symbol: symbol(decoded.symbol, `${path}.symbol`) };
  if (decoded.multiplier !== undefined) {
    result.multiplier = boundedInteger(decoded.multiplier, `${path}.multiplier`, 1, 1_000_000);
  }
  if (decoded.prize !== undefined) {
    result.prize = identifier(decoded.prize, `${path}.prize`);
  }
  if (decoded.lockedVaultFace !== undefined) {
    const face = string(decoded.lockedVaultFace, `${path}.lockedVaultFace`);
    if (!lockedVaultFaceSet.has(face)) {
      throw new ProtocolDecodeError(`${path}.lockedVaultFace is unsupported`);
    }
    if (result.symbol !== "VAULT") {
      throw new ProtocolDecodeError(`${path}.lockedVaultFace is only allowed on VAULT`);
    }
    if (result.multiplier !== undefined || result.prize !== undefined) {
      throw new ProtocolDecodeError(
        `${path}.lockedVaultFace cannot coexist with multiplier or prize`,
      );
    }
    result.lockedVaultFace = face as GridCell["lockedVaultFace"];
  }
  return result;
}

function grid(value: unknown, path: string): GridCell[][] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new ProtocolDecodeError(`${path} must contain exactly three reels`);
  }
  const decoded = value.map((reel, reelIndex) => {
    if (!Array.isArray(reel) || reel.length < 3 || reel.length > 8) {
      throw new ProtocolDecodeError(`${path}[${reelIndex}] must contain 3-8 rows`);
    }
    return reel.map((value, rowIndex) => {
      const decodedCell = cell(value, `${path}[${reelIndex}][${rowIndex}]`);
      if ((decodedCell.symbol === "WILD" || decodedCell.symbol === "VAULT")
        && reelIndex !== 1) {
        throw new ProtocolDecodeError(
          `${path}[${reelIndex}][${rowIndex}].symbol ${decodedCell.symbol} is only allowed on reel 1`,
        );
      }
      return decodedCell;
    });
  });
  const rowCount = decoded[0]?.length;
  if (decoded.some((reel) => reel.length !== rowCount)) {
    throw new ProtocolDecodeError(`${path} reels must use the same row count`);
  }
  return decoded;
}

function cellAddress(value: unknown, path: string): CellAddress {
  const decoded = record(value, path);
  exactKeys(decoded, ["reel", "row"], path);
  return {
    reel: boundedInteger(decoded.reel, `${path}.reel`, 0, 255),
    row: boundedInteger(decoded.row, `${path}.row`, 0, 255),
  };
}

function eventCellAddresses(
  value: unknown,
  path: string,
  decodedGrid: GridCell[][],
  minimum: number,
  maximum: number,
): readonly Readonly<CellAddress>[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new ProtocolDecodeError(`${path} must contain ${minimum}-${maximum} entries`);
  }
  const cells = value.map((item, index) => Object.freeze(cellAddress(item, `${path}[${index}]`)));
  const seen = new Set<string>();
  for (const address of cells) {
    if (address.reel >= decodedGrid.length || address.row >= (decodedGrid[address.reel]?.length ?? 0)) {
      throw new ProtocolDecodeError(`${path} contains an address outside the grid`);
    }
    const key = `${address.reel}:${address.row}`;
    if (seen.has(key)) throw new ProtocolDecodeError(`${path} must not contain duplicate addresses`);
    seen.add(key);
  }
  return Object.freeze(cells);
}

function eventCellAddress(
  decoded: Record<string, unknown>,
  path: string,
  decodedGrid: GridCell[][],
): Readonly<CellAddress> {
  const address = Object.freeze({
    reel: boundedInteger(decoded.reel, `${path}.reel`, 0, 255),
    row: boundedInteger(decoded.row, `${path}.row`, 0, 255),
  });
  if (address.reel >= decodedGrid.length || address.row >= (decodedGrid[address.reel]?.length ?? 0)) {
    throw new ProtocolDecodeError(`${path} contains an address outside the grid`);
  }
  return address;
}

function vaultEventCellAddresses(
  value: unknown,
  path: string,
  decodedGrid: GridCell[][],
  minimum: number,
  maximum: number,
): readonly Readonly<CellAddress>[] {
  const cells = eventCellAddresses(value, path, decodedGrid, minimum, maximum);
  for (const address of cells) {
    if (decodedGrid[address.reel]?.[address.row]?.symbol !== "VAULT") {
      throw new ProtocolDecodeError(`${path} must reference only settled VAULT cells`);
    }
  }
  return cells;
}

function vaultEventCellAddress(
  decoded: Record<string, unknown>,
  path: string,
  decodedGrid: GridCell[][],
): Readonly<CellAddress> {
  const address = eventCellAddress(decoded, path, decodedGrid);
  if (decodedGrid[address.reel]?.[address.row]?.symbol !== "VAULT") {
    throw new ProtocolDecodeError(`${path} must reference a settled VAULT cell`);
  }
  return address;
}

function win(value: unknown, path: string, decodedGrid: GridCell[][]): Win {
  const decoded = record(value, path);
  exactKeys(decoded, ["id", "symbol", "ways", "amountMinor", "multiplier", "cells", "pathAwards"], path);
  if (!Array.isArray(decoded.cells) || decoded.cells.length === 0 || decoded.cells.length > 256) {
    throw new ProtocolDecodeError(`${path}.cells must contain 1-256 entries`);
  }
  const cells = decoded.cells.map((value, index) => cellAddress(value, `${path}.cells[${index}]`));
  const aggregateCellKeys = new Set<string>();
  for (const address of cells) {
    if (address.reel >= decodedGrid.length || address.row >= (decodedGrid[address.reel]?.length ?? 0)) {
      throw new ProtocolDecodeError(`${path}.cells contains an address outside the grid`);
    }
    const key = `${address.reel}:${address.row}`;
    if (aggregateCellKeys.has(key)) {
      throw new ProtocolDecodeError(`${path}.cells must not contain duplicate addresses`);
    }
    aggregateCellKeys.add(key);
  }
  const targetSymbol = symbol(decoded.symbol, `${path}.symbol`);
  const amountMinor = money(decoded.amountMinor, `${path}.amountMinor`);
  const hasWays = decoded.ways !== undefined;
  const hasPathAwards = decoded.pathAwards !== undefined;
  if (hasWays !== hasPathAwards) {
    throw new ProtocolDecodeError(`${path}.ways and ${path}.pathAwards must be supplied together`);
  }
  const result: Win = {
    id: identifier(decoded.id, `${path}.id`),
    symbol: targetSymbol,
    amountMinor,
    cells,
  };
  if (decoded.multiplier !== undefined) {
    result.multiplier = boundedInteger(
      decoded.multiplier,
      `${path}.multiplier`,
      1,
      1_000_000,
    );
  }
  // 兼容范围仅限同时缺少两个新字段的历史记录；在线响应必须携带并校验下方由服务端
  // 解析完成的 Ways 明细，客户端不得自行补算。
  if (!hasWays) return result;
  if (!payingSymbolSet.has(targetSymbol)) {
    throw new ProtocolDecodeError(`${path}.symbol must be a paying symbol when pathAwards are present`);
  }
  const ways = boundedInteger(decoded.ways, `${path}.ways`, 1, 512);
  if (!Array.isArray(decoded.pathAwards) || decoded.pathAwards.length !== ways) {
    throw new ProtocolDecodeError(`${path}.pathAwards length must equal ${path}.ways`);
  }
  const pathCellKeys = new Set<string>();
  const seenPaths = new Set<string>();
  let pathAmountTotal = 0n;
  const pathAwards = decoded.pathAwards.map((item, pathIndex): PathAward => {
    const awardPath = `${path}.pathAwards[${pathIndex}]`;
    const award = record(item, awardPath);
    exactKeys(award, ["cells", "multiplier", "baseAmountMinor", "amountMinor"], awardPath);
    if (!Array.isArray(award.cells) || award.cells.length !== 3) {
      throw new ProtocolDecodeError(`${awardPath}.cells must contain exactly three entries`);
    }
    const pathCells = award.cells.map((cellValue, reel) => {
      const address = cellAddress(cellValue, `${awardPath}.cells[${reel}]`);
      if (address.reel !== reel) {
        throw new ProtocolDecodeError(`${awardPath}.cells must be ordered with one cell for each reel`);
      }
      const settledCell = decodedGrid[address.reel]?.[address.row];
      if (!settledCell) {
        throw new ProtocolDecodeError(`${awardPath}.cells contains an address outside the grid`);
      }
      if (settledCell.symbol !== targetSymbol && settledCell.symbol !== "WILD") {
        throw new ProtocolDecodeError(`${awardPath}.cells must reference only ${targetSymbol} or WILD cells`);
      }
      pathCellKeys.add(`${address.reel}:${address.row}`);
      return address;
    });
    const pathKey = pathCells.map(({ row }) => row).join(":");
    if (seenPaths.has(pathKey)) {
      throw new ProtocolDecodeError(`${path}.pathAwards must not contain duplicate paths`);
    }
    seenPaths.add(pathKey);
    let expectedMultiplier = 1;
    pathCells.forEach((address) => {
      const settledCell = decodedGrid[address.reel]?.[address.row];
      if (settledCell?.symbol !== "WILD") return;
      expectedMultiplier *= settledCell.multiplier ?? 1;
      if (!Number.isSafeInteger(expectedMultiplier) || expectedMultiplier > 1_000_000) {
        throw new ProtocolDecodeError(`${awardPath}.multiplier exceeds the supported range`);
      }
    });
    const multiplier = boundedInteger(award.multiplier, `${awardPath}.multiplier`, 1, 1_000_000);
    if (multiplier !== expectedMultiplier) {
      throw new ProtocolDecodeError(`${awardPath}.multiplier must match its WILD cells`);
    }
    const baseAmountMinor = money(award.baseAmountMinor, `${awardPath}.baseAmountMinor`);
    const pathAmountMinor = money(award.amountMinor, `${awardPath}.amountMinor`);
    const baseAmount = BigInt(baseAmountMinor);
    const pathAmount = BigInt(pathAmountMinor);
    if (baseAmount > pathAmount
      || (pathAmount === 0n && baseAmount !== 0n)
      || (pathAmount > 0n && baseAmount === 0n)
      || (multiplier === 1 && baseAmount !== pathAmount)) {
      throw new ProtocolDecodeError(`${awardPath}.baseAmountMinor is inconsistent with the settled path award`);
    }
    pathAmountTotal += BigInt(pathAmountMinor);
    return { cells: pathCells, multiplier, baseAmountMinor, amountMinor: pathAmountMinor };
  });
  if (result.multiplier !== undefined
    && pathAwards.some((award) => award.multiplier !== result.multiplier)) {
    throw new ProtocolDecodeError(
      `${path}.multiplier must equal the uniform multiplier of every pathAward`,
    );
  }
  if (pathAmountTotal !== BigInt(amountMinor)) {
    throw new ProtocolDecodeError(`${path}.pathAwards amounts must sum to ${path}.amountMinor`);
  }
  if (pathCellKeys.size !== aggregateCellKeys.size
    || [...aggregateCellKeys].some((key) => !pathCellKeys.has(key))) {
    throw new ProtocolDecodeError(`${path}.cells must equal the union of ${path}.pathAwards cells`);
  }
  result.ways = ways;
  result.pathAwards = pathAwards;
  return result;
}

/**
 * 实时结果把同一获奖符号聚合为一个 Win，但旧重放仍可能省略 Ways 明细；保留该兼容性时，
 * 必须拒绝重复身份或重复的现代路径，避免同一笔可见奖励被呈现多次。
 */
function validateWinIdentities(wins: readonly Win[]): void {
  const seenIDs = new Set<string>();
  const seenPathSets = new Set<string>();
  const claimedPaths = new Set<string>();

  wins.forEach((decodedWin, winIndex) => {
    if (seenIDs.has(decodedWin.id)) {
      throw new ProtocolDecodeError("wins must not contain duplicate ids");
    }
    seenIDs.add(decodedWin.id);

    if (decodedWin.pathAwards === undefined) return;
    const pathKeys = decodedWin.pathAwards.map((award) => (
      award.cells.map(({ reel, row }) => `${reel}:${row}`).join("|")
    ));
    const semanticSet = `${decodedWin.symbol}|${[...pathKeys].sort().join(",")}`;
    if (seenPathSets.has(semanticSet)) {
      throw new ProtocolDecodeError("wins must not contain duplicate semantic path sets");
    }
    seenPathSets.add(semanticSet);

    for (const pathKey of pathKeys) {
      if (claimedPaths.has(pathKey)) {
        throw new ProtocolDecodeError(`wins[${winIndex}].pathAwards must not reuse a path from another win`);
      }
      claimedPaths.add(pathKey);
    }
  });
}

/** 与服务端 game.ValidateOutcomeStructure 的可见奖励核算规则保持完全一致。 */
function validateVisibleAwardTotal(
  wins: readonly Win[],
  decodedEvents: readonly FeatureEvent[],
  totalWinMinor: MoneyMinor,
): void {
  let visibleAwards = wins.reduce((total, decodedWin) => total + BigInt(decodedWin.amountMinor), 0n);
  for (const event of decodedEvents) {
    if (event.type !== "wheel.awarded" && event.type !== "vault.awarded") continue;
    if (event.amountMinor !== undefined) visibleAwards += BigInt(event.amountMinor);
  }
  if (visibleAwards !== BigInt(totalWinMinor)) {
    throw new ProtocolDecodeError("totalWinMinor must equal the sum of visible win and monetary event awards");
  }
}

function validateWheelAwardProjection(
  decodedEvents: readonly FeatureEvent[],
  decodedFeatureState: Readonly<FeatureState>,
  betMinor: MoneyMinor,
): void {
  const wheelAwardedIndex = decodedEvents.findIndex((event) => event.type === "wheel.awarded");
  if (wheelAwardedIndex < 0) return;
  const wheelAwarded = decodedEvents[wheelAwardedIndex];
  if (wheelAwarded?.type !== "wheel.awarded") {
    throw new ProtocolDecodeError("events has an invalid wheel.awarded event");
  }

  const freeSpinsStarted = decodedEvents[wheelAwardedIndex + 1];
  if (wheelAwarded.outcome === "INSTANT") {
    const expectedAmount = BigInt(betMinor) * BigInt(wheelAwarded.multiplier);
    if (expectedAmount > MAX_SIGNED_INT64) {
      throw new ProtocolDecodeError(
        "wheel.awarded INSTANT amount exceeds the signed-int64 money domain",
      );
    }
    if (BigInt(wheelAwarded.amountMinor) !== expectedAmount) {
      throw new ProtocolDecodeError(
        "wheel.awarded INSTANT amountMinor must equal betMinor multiplied by multiplier",
      );
    }
    if (freeSpinsStarted?.type === "free_spins.started") {
      throw new ProtocolDecodeError("wheel.awarded INSTANT must not start Free Spins");
    }
    if (decodedFeatureState.mode !== "BASE"
      || decodedFeatureState.freeSpinsRemaining !== 0
      || (decodedFeatureState.freeSpinsPlayed ?? 0) !== 0) {
      throw new ProtocolDecodeError(
        "wheel.awarded INSTANT must project the next feature state as BASE",
      );
    }
    return;
  }

  if (freeSpinsStarted?.type !== "free_spins.started"
    || freeSpinsStarted.mode !== wheelAwarded.outcome) {
    throw new ProtocolDecodeError(
      "feature wheel outcomes must be immediately followed by matching free_spins.started",
    );
  }
  if (decodedFeatureState.mode !== freeSpinsStarted.mode
    || decodedFeatureState.freeSpinsRemaining !== freeSpinsStarted.awarded
    || decodedFeatureState.freeSpinsPlayed !== 0
    || decodedFeatureState.baseBetMinor !== betMinor
    || decodedFeatureState.freeSpinsWinMinor !== "0") {
    throw new ProtocolDecodeError(
      "feature wheel outcomes must project eight unplayed Free Spins at the locked bet",
    );
  }
}

/**
 * v1 响应只暴露下一特性状态，不包含提交请求时的状态。以下事件边界仍能唯一确定 Vault 归属：
 * Kong 拥有前置扩展，终止事件声明结束模式，未终止的活动结果保留原模式；只有 Base 触发投影
 * 会在活动结果中携带 free_spins.started。
 */
function inferredVaultOriginMode(
  decodedEvents: readonly FeatureEvent[],
  decodedFeatureState: Readonly<FeatureState>,
): FeatureMode {
  if (decodedEvents.some((event) => event.type === "grid.expanded")) return "EXPANSION";
  const completion = decodedEvents.find((event) => event.type === "free_spins.completed");
  if (completion?.type === "free_spins.completed") return completion.mode;
  const startsFeature = decodedEvents.some((event) => event.type === "free_spins.started");
  if (!startsFeature && decodedFeatureState.mode !== "BASE") return decodedFeatureState.mode;
  return "BASE";
}

function validateVaultAwardProjection(
  decodedGrid: GridCell[][],
  decodedEvents: readonly FeatureEvent[],
  decodedFeatureState: Readonly<FeatureState>,
  betMinor: MoneyMinor,
): void {
  if (!decodedEvents.some((event) => VAULT_EVENT_TYPES.has(event.type))) return;
  const inferredOrigin: FeatureState = {
    ...decodedFeatureState,
    mode: inferredVaultOriginMode(decodedEvents, decodedFeatureState),
  };
  try {
    validateVaultEventsAgainstOrigin(inferredOrigin, {
      grid: decodedGrid,
      events: decodedEvents,
      betMinor,
    });
  } catch (error) {
    if (error instanceof SpinResultOriginError) {
      throw new ProtocolDecodeError(`events violate the Vault result contract: ${error.message}`);
    }
    throw error;
  }
}

function surgeCellAddresses(
  value: unknown,
  path: string,
  decodedGrid: GridCell[][],
): readonly Readonly<CellAddress>[] {
  const cells = eventCellAddresses(value, path, decodedGrid, 1, 3);
  const seen = new Set<string>();
  for (const address of cells) {
    const key = `${address.reel}:${address.row}`;
    seen.add(key);
    if (decodedGrid[address.reel]?.[address.row]?.symbol !== "SURGE") {
      throw new ProtocolDecodeError(`${path} must reference only settled SURGE cells`);
    }
  }

  const settledSurges = new Set<string>();
  decodedGrid.forEach((reel, reelIndex) => {
    reel.forEach((gridCell, rowIndex) => {
      if (gridCell.symbol === "SURGE") settledSurges.add(`${reelIndex}:${rowIndex}`);
    });
  });
  if (settledSurges.size !== seen.size || [...settledSurges].some((key) => !seen.has(key))) {
    throw new ProtocolDecodeError(`${path} must list every settled SURGE cell exactly once`);
  }
  return cells;
}

function wheelJackpotTier(value: unknown, path: string): WheelJackpotTier {
  const decoded = identifier(value, path);
  if (!Object.hasOwn(WHEEL_INSTANT_MULTIPLIER_BY_TIER, decoded)) {
    throw new ProtocolDecodeError(
      `${path} must be one of MINI, MINOR, MAJOR, MEGA, or GRAND`,
    );
  }
  return decoded as WheelJackpotTier;
}

function wheelAwardedEvent(
  decoded: Record<string, unknown>,
  path: string,
): WheelAwardedEvent {
  exactKeys(decoded, ["type", "outcome", "prize", "multiplier", "amountMinor"], path);
  const outcome = identifier(decoded.outcome, `${path}.outcome`);

  if (outcome === "INSTANT") {
    const prize = wheelJackpotTier(decoded.prize, `${path}.prize`);
    const suppliedMultiplier = boundedInteger(
      decoded.multiplier,
      `${path}.multiplier`,
      1,
      1_000_000,
    );
    const multiplier = WHEEL_INSTANT_MULTIPLIER_BY_TIER[prize];
    if (suppliedMultiplier !== multiplier) {
      throw new ProtocolDecodeError(
        `${path}.multiplier must equal ${multiplier} for ${prize}`,
      );
    }
    return Object.freeze({
      type: "wheel.awarded",
      outcome,
      prize,
      multiplier,
      amountMinor: money(decoded.amountMinor, `${path}.amountMinor`),
    });
  }

  if (outcome === "EXPANSION" || outcome === "OVERDRIVE") {
    if (Object.hasOwn(decoded, "multiplier") || Object.hasOwn(decoded, "amountMinor")) {
      throw new ProtocolDecodeError(
        `${path} feature outcomes must not contain multiplier or amountMinor`,
      );
    }
    const expectedPrize = outcome === "EXPANSION" ? "KONG_QUEST" : "KING_SPIN";
    if (!Object.hasOwn(decoded, "prize")) {
      return outcome === "EXPANSION"
        ? Object.freeze({ type: "wheel.awarded", outcome: "EXPANSION" })
        : Object.freeze({ type: "wheel.awarded", outcome: "OVERDRIVE" });
    }
    const prize = identifier(decoded.prize, `${path}.prize`);
    if (prize !== expectedPrize) {
      throw new ProtocolDecodeError(
        `${path}.prize must be ${expectedPrize} for ${outcome}`,
      );
    }
    return outcome === "EXPANSION"
      ? Object.freeze({ type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" })
      : Object.freeze({ type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" });
  }

  throw new ProtocolDecodeError(
    `${path}.outcome must be INSTANT, EXPANSION, or OVERDRIVE`,
  );
}

function featureEvent(value: unknown, path: string, decodedGrid: GridCell[][]): FeatureEvent {
  const decoded = record(value, path);
  const type = string(decoded.type, `${path}.type`);
  switch (type) {
    case "surge.collected": {
      exactKeys(decoded, ["type", "count", "cells", "triggered", "guaranteed", "level", "total"], path);
      const count = boundedInteger(decoded.count, `${path}.count`, 1, 3);
      const cells = surgeCellAddresses(decoded.cells, `${path}.cells`, decodedGrid);
      const triggered = boolean(decoded.triggered, `${path}.triggered`);
      const guaranteed = boolean(decoded.guaranteed, `${path}.guaranteed`);
      if (count !== cells.length) {
        throw new ProtocolDecodeError(`${path}.count must equal ${path}.cells length`);
      }
      if (guaranteed !== (count === 3)) {
        throw new ProtocolDecodeError(`${path}.guaranteed must be true exactly when count is 3`);
      }
      if (guaranteed && !triggered) {
        throw new ProtocolDecodeError(`${path}.triggered must be true for a guaranteed collection`);
      }
      const level = boundedInteger(decoded.level, `${path}.level`, 1, 1_000_000);
      const total = boundedInteger(decoded.total, `${path}.total`, 0, 1_000_000);
      return Object.freeze({ type, count, cells, triggered, guaranteed, level, total });
    }
    case "rage.transformed": {
      exactKeys(decoded, ["type", "count", "cells", "level", "total"], path);
      const count = boundedInteger(decoded.count, `${path}.count`, 1, 24);
      const cells = eventCellAddresses(decoded.cells, `${path}.cells`, decodedGrid, 1, 24);
      if (count !== cells.length) {
        throw new ProtocolDecodeError(`${path}.count must equal ${path}.cells length`);
      }
      const level = boundedInteger(decoded.level, `${path}.level`, 1, 1_000_000);
      const total = boundedInteger(decoded.total, `${path}.total`, 0, 1_000_000);
      return Object.freeze({ type, count, cells, level, total });
    }
    case "wheel.started":
      exactKeys(decoded, ["type"], path);
      return Object.freeze({ type });
    case "wheel.awarded":
      return wheelAwardedEvent(decoded, path);
    case "free_spins.started": {
      exactKeys(decoded, ["type", "mode", "awarded"], path);
      const mode = string(decoded.mode, `${path}.mode`);
      if (mode !== "EXPANSION" && mode !== "OVERDRIVE") {
        throw new ProtocolDecodeError(`${path}.mode must be EXPANSION or OVERDRIVE`);
      }
      const awarded = boundedInteger(decoded.awarded, `${path}.awarded`, 1, 1_000_000);
      if (awarded !== 8) {
        throw new ProtocolDecodeError(`${path}.awarded must equal the captured initial 8 Free Spins`);
      }
      return Object.freeze({ type, mode, awarded });
    }
    case "grid.expanded":
      exactKeys(decoded, ["type", "rows", "ways"], path);
      return Object.freeze({
        type,
        rows: boundedInteger(decoded.rows, `${path}.rows`, 1, 255),
        ways: boundedInteger(decoded.ways, `${path}.ways`, 1, 2_147_483_647),
      });
    case "vaults.landed":
    case "vaults.locked":
    case "vaults.unlock.started":
    case "vaults.unlock.completed": {
      exactKeys(decoded, ["type", "count", "cells"], path);
      const count = boundedInteger(decoded.count, `${path}.count`, 1, 8);
      const cells = vaultEventCellAddresses(decoded.cells, `${path}.cells`, decodedGrid, 1, 8);
      if (count !== cells.length) {
        throw new ProtocolDecodeError(`${path}.count must equal ${path}.cells length`);
      }
      return Object.freeze({ type, count, cells });
    }
    case "vault.unlocked": {
      exactKeys(decoded, ["type", "reel", "row", "prize", "multiplier"], path);
      const address = vaultEventCellAddress(decoded, path, decodedGrid);
      const event: FeatureEvent = {
        type,
        ...address,
        prize: identifier(decoded.prize, `${path}.prize`),
      };
      if (decoded.multiplier !== undefined) {
        event.multiplier = boundedInteger(decoded.multiplier, `${path}.multiplier`, 1, 1_000_000);
      }
      return Object.freeze(event);
    }
    case "vault.awarded": {
      exactKeys(decoded, ["type", "reel", "row", "prize", "multiplier", "amountMinor"], path);
      const address = vaultEventCellAddress(decoded, path, decodedGrid);
      const event: FeatureEvent = {
        type,
        ...address,
        multiplier: boundedInteger(decoded.multiplier, `${path}.multiplier`, 1, 1_000_000),
        amountMinor: money(decoded.amountMinor, `${path}.amountMinor`),
      };
      if (decoded.prize !== undefined) event.prize = identifier(decoded.prize, `${path}.prize`);
      return Object.freeze(event);
    }
    case "free_spin.awarded": {
      exactKeys(decoded, ["type", "count", "reel", "row"], path);
      const event: FeatureEvent = {
        type,
        count: boundedInteger(decoded.count, `${path}.count`, 1, 1_000_000),
      };
      if ((decoded.reel === undefined) !== (decoded.row === undefined)) {
        throw new ProtocolDecodeError(`${path}.reel and ${path}.row must be supplied together`);
      }
      if (decoded.reel !== undefined) Object.assign(event, vaultEventCellAddress(decoded, path, decodedGrid));
      return Object.freeze(event);
    }
    case "free_spin.cap_reached": {
      exactKeys(decoded, ["type", "reel", "row"], path);
      return Object.freeze({ type, ...vaultEventCellAddress(decoded, path, decodedGrid) });
    }
    case "vaults.upgrade.started":
      exactKeys(decoded, ["type", "count", "step"], path);
      return Object.freeze({
        type,
        count: boundedInteger(decoded.count, `${path}.count`, 1, 8),
        step: boundedInteger(decoded.step, `${path}.step`, 1, 16),
      });
    case "vault.upgraded": {
      exactKeys(decoded, ["type", "reel", "row", "fromMultiplier", "toMultiplier", "prize", "step"], path);
      const address = vaultEventCellAddress(decoded, path, decodedGrid);
      const fromMultiplier = boundedInteger(decoded.fromMultiplier, `${path}.fromMultiplier`, 1, 1_000_000);
      const toMultiplier = boundedInteger(decoded.toMultiplier, `${path}.toMultiplier`, 1, 1_000_000);
      if (toMultiplier <= fromMultiplier) {
        throw new ProtocolDecodeError(`${path}.toMultiplier must be greater than ${path}.fromMultiplier`);
      }
      return Object.freeze({
        type,
        ...address,
        fromMultiplier,
        toMultiplier,
        prize: identifier(decoded.prize, `${path}.prize`),
        step: boundedInteger(decoded.step, `${path}.step`, 1, 16),
      });
    }
    case "free_spins.completed": {
      exactKeys(decoded, ["type", "mode", "awarded", "cumulativeWinMinor"], path);
      const mode = string(decoded.mode, `${path}.mode`);
      if (mode !== "EXPANSION" && mode !== "OVERDRIVE") {
        throw new ProtocolDecodeError(`${path}.mode must be EXPANSION or OVERDRIVE`);
      }
      return Object.freeze({
        type,
        mode,
        awarded: boundedInteger(decoded.awarded, `${path}.awarded`, 1, 1_000_000),
        cumulativeWinMinor: money(decoded.cumulativeWinMinor, `${path}.cumulativeWinMinor`),
      });
    }
    default:
      throw new ProtocolDecodeError(`${path}.type contains unsupported feature event ${type}`);
  }
}

function events(value: unknown, path: string, decodedGrid: GridCell[][]): readonly FeatureEvent[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new ProtocolDecodeError(`${path} must be an array with at most 10000 entries`);
  }
  const decoded = value.map((item, index) => featureEvent(item, `${path}[${index}]`, decodedGrid));
  const singletonTypes = [
    "grid.expanded",
    "surge.collected",
    "rage.transformed",
    "wheel.started",
    "wheel.awarded",
    "free_spins.started",
    "free_spins.completed",
    "vaults.landed",
    "vaults.locked",
    "vaults.unlock.started",
    "vaults.unlock.completed",
  ] as const;
  for (const singletonType of singletonTypes) {
    if (decoded.filter((event) => event.type === singletonType).length > 1) {
      throw new ProtocolDecodeError(`${path} must not contain duplicate ${singletonType} events`);
    }
  }

  const gridExpandedIndex = decoded.findIndex((event) => event.type === "grid.expanded");
  if (gridExpandedIndex >= 0) {
    const expanded = decoded[gridExpandedIndex];
    if (expanded?.type !== "grid.expanded") throw new ProtocolDecodeError(`${path} has an invalid grid expansion`);
    const rows = decodedGrid[0]?.length ?? 0;
    if (gridExpandedIndex !== 0 || expanded.rows !== rows || expanded.ways !== rows ** 3) {
      throw new ProtocolDecodeError(`${path} grid.expanded must be first and match the result grid`);
    }
  }

  const surgeIndex = decoded.findIndex((event) => event.type === "surge.collected");
  const transformedIndex = decoded.findIndex((event) => event.type === "rage.transformed");
  const wheelStartedIndex = decoded.findIndex((event) => event.type === "wheel.started");
  const wheelAwardedIndex = decoded.findIndex((event) => event.type === "wheel.awarded");
  if ((wheelStartedIndex >= 0) !== (wheelAwardedIndex >= 0)) {
    throw new ProtocolDecodeError(`${path} wheel.started and wheel.awarded must occur together`);
  }
  if (wheelStartedIndex >= 0 && wheelStartedIndex >= wheelAwardedIndex) {
    throw new ProtocolDecodeError(`${path} wheel.started must precede wheel.awarded`);
  }
  if (surgeIndex >= 0) {
    const surge = decoded[surgeIndex];
    if (surge?.type !== "surge.collected") {
      throw new ProtocolDecodeError(`${path} has an invalid surge.collected event`);
    }
    if (surge.triggered !== (wheelStartedIndex >= 0)) {
      throw new ProtocolDecodeError(`${path}[${surgeIndex}].triggered must match wheel event presence`);
    }
    if (wheelStartedIndex >= 0 && surgeIndex >= wheelStartedIndex) {
      throw new ProtocolDecodeError(`${path} surge.collected must precede wheel.started`);
    }
    if (surge.triggered && surge.count < 3 && transformedIndex < 0) {
      throw new ProtocolDecodeError(`${path} a one/two-Rage trigger requires rage.transformed`);
    }
    if ((!surge.triggered || surge.count === 3) && transformedIndex >= 0) {
      throw new ProtocolDecodeError(`${path} rage.transformed is only valid for a triggered one/two-Rage result`);
    }
    if (transformedIndex >= 0) {
      const transformed = decoded[transformedIndex];
      if (transformed?.type !== "rage.transformed"
        || !surge.triggered || surge.count + transformed.count !== 3
        || transformed.level !== surge.level || transformed.total !== surge.total
        || transformedIndex <= surgeIndex || transformedIndex >= wheelStartedIndex) {
        throw new ProtocolDecodeError(`${path} rage.transformed must complete a triggered collection to three before wheel.started`);
      }
    }
  } else if (wheelStartedIndex >= 0 || transformedIndex >= 0) {
    throw new ProtocolDecodeError(`${path} Rage transformation and wheel events require surge.collected`);
  }

  const freeSpinsStartedIndex = decoded.findIndex((event) => event.type === "free_spins.started");
  if (freeSpinsStartedIndex >= 0
    && (wheelAwardedIndex < 0 || freeSpinsStartedIndex !== wheelAwardedIndex + 1)) {
    throw new ProtocolDecodeError(`${path} free_spins.started must immediately follow wheel.awarded`);
  }
  if (wheelAwardedIndex >= 0) {
    const wheelAward = decoded[wheelAwardedIndex];
    if (wheelAward?.type !== "wheel.awarded") {
      throw new ProtocolDecodeError(`${path} has an invalid wheel.awarded event`);
    }
    if (wheelAward.outcome === "INSTANT") {
      if (freeSpinsStartedIndex >= 0) {
        throw new ProtocolDecodeError(`${path} INSTANT must not start Free Spins`);
      }
    } else {
      if (freeSpinsStartedIndex < 0) {
        throw new ProtocolDecodeError(`${path} feature wheel outcomes require free_spins.started`);
      }
      const started = decoded[freeSpinsStartedIndex];
      if (started?.type !== "free_spins.started" || started.mode !== wheelAward.outcome) {
        throw new ProtocolDecodeError(`${path} wheel outcome must match the started Free Spins mode`);
      }
    }
  }
  const completedIndex = decoded.findIndex((event) => event.type === "free_spins.completed");
  if (completedIndex >= 0 && completedIndex !== decoded.length - 1) {
    throw new ProtocolDecodeError(`${path} free_spins.completed must be the final event`);
  }

  const vaultLandedIndex = decoded.findIndex((event) => event.type === "vaults.landed");
  const vaultLockedIndex = decoded.findIndex((event) => event.type === "vaults.locked");
  const unlockStartedIndex = decoded.findIndex((event) => event.type === "vaults.unlock.started");
  const unlockCompletedIndex = decoded.findIndex((event) => event.type === "vaults.unlock.completed");
  const vaultDetailIndices = decoded.flatMap((event, index) => (
    event.type.startsWith("vault.") || event.type.startsWith("vaults.")
      || event.type === "free_spin.awarded" || event.type === "free_spin.cap_reached"
      ? [index]
      : []
  ));
  if (vaultDetailIndices.length > 0 && vaultLandedIndex < 0) {
    throw new ProtocolDecodeError(`${path} Vault detail events require vaults.landed`);
  }
  if (vaultLandedIndex >= 0 && vaultDetailIndices.some((index) => index < vaultLandedIndex)) {
    throw new ProtocolDecodeError(`${path} vaults.landed must precede Vault detail events`);
  }
  if (vaultLockedIndex >= 0 && unlockStartedIndex >= 0) {
    throw new ProtocolDecodeError(`${path} locked and unlocked Vault branches are mutually exclusive`);
  }
  if ((unlockStartedIndex >= 0) !== (unlockCompletedIndex >= 0)
    || (unlockStartedIndex >= 0 && unlockStartedIndex >= unlockCompletedIndex)) {
    throw new ProtocolDecodeError(`${path} Vault unlock start/completion events must be an ordered pair`);
  }
  decoded.forEach((event, index) => {
    if (event.type === "vault.unlocked"
      && (unlockStartedIndex < 0 || index <= unlockStartedIndex || index >= unlockCompletedIndex)) {
      throw new ProtocolDecodeError(`${path} vault.unlocked must occur inside the unlock group`);
    }
    if (event.type === "vault.upgraded") {
      const startedIndex = decoded.findIndex((candidate) => (
        candidate.type === "vaults.upgrade.started" && candidate.step === event.step
      ));
      if (startedIndex < 0 || startedIndex >= index) {
        throw new ProtocolDecodeError(`${path} vault.upgraded must follow its matching upgrade start`);
      }
    }
    if (event.type === "vaults.upgrade.started") {
      const upgrades = decoded.filter((candidate) => (
        candidate.type === "vault.upgraded" && candidate.step === event.step
      ));
      if (upgrades.length !== event.count) {
        throw new ProtocolDecodeError(`${path} Vault upgrade count must match its step events`);
      }
      if (unlockCompletedIndex < 0 || index <= unlockCompletedIndex) {
        throw new ProtocolDecodeError(`${path} Vault upgrades must follow unlock completion`);
      }
    }
  });
  if (vaultLockedIndex >= 0 && vaultLockedIndex <= vaultLandedIndex) {
    throw new ProtocolDecodeError(`${path} vaults.locked must follow vaults.landed`);
  }
  return Object.freeze(decoded);
}

function validateResultReelProjection(
  decodedGrid: GridCell[][],
  decodedEvents: readonly FeatureEvent[],
  decodedFeatureState: FeatureState,
): void {
  const rows = decodedGrid[0]?.length ?? 0;
  if (rows < 3 || rows > 8) {
    throw new ProtocolDecodeError("grid must contain 3-8 rows per reel");
  }
  const startsExpansion = decodedEvents.some((event) => (
    event.type === "free_spins.started" && event.mode === "EXPANSION"
  ));
  const completesExpansion = decodedEvents.some((event) => (
    event.type === "free_spins.completed" && event.mode === "EXPANSION"
  ));
  // Base 触发局已投影新的 EXPANSION 状态，但该局停轴仍是普通 3x3；之后每个 Kong
  // 结果（含终局响应）都必须携带前置扩展事件，不能只依赖局后状态猜测版面。
  const isExpansionSpin = completesExpansion
    || (decodedFeatureState.mode === "EXPANSION" && !startsExpansion);
  const expanded = decodedEvents.find((event) => event.type === "grid.expanded");
  if (isExpansionSpin !== (expanded !== undefined)) {
    throw new ProtocolDecodeError(
      "Kong Quest results must carry one leading grid.expanded event",
    );
  }
  if (!isExpansionSpin && rows !== 3) {
    throw new ProtocolDecodeError("only Kong Quest results may use more than 3 rows");
  }
}

function protocolVersion(value: unknown): 1 {
  if (value !== 1) throw new ProtocolDecodeError("protocolVersion must equal 1");
  return 1;
}

function decodeSpinResult(
  message: Record<string, unknown>,
  onStage?: SpinResultProjectionStageObserver,
): SpinResult {
  onStage?.("projection-message-shape");
  exactKeys(message, [
    "type",
    "protocolVersion",
    "requestId",
    "sessionId",
    "roundId",
    "sequence",
    "betMinor",
    "chargedBetMinor",
    "balanceMinor",
    "totalWinMinor",
    "grid",
    "wins",
    "events",
    "featureState",
  ], "message");
  const betMinor = money(message.betMinor, "betMinor");

  onStage?.("projection-message-grid");
  const decodedGrid = grid(message.grid, "grid");

  onStage?.("projection-message-wins");
  if (!Array.isArray(message.wins) || message.wins.length > 10_000) {
    throw new ProtocolDecodeError("wins must be an array with at most 10000 entries");
  }
  const decodedWins = message.wins.map((value, index) => win(value, `wins[${index}]`, decodedGrid));

  onStage?.("projection-message-events");
  const decodedEvents = events(message.events, "events", decodedGrid);

  onStage?.("projection-message-feature");
  const decodedFeatureState = featureState(message.featureState, "featureState");
  const totalWinMinor = money(message.totalWinMinor, "totalWinMinor");

  onStage?.("projection-invariant-win-identities");
  validateWinIdentities(decodedWins);

  onStage?.("projection-invariant-award-total");
  validateVisibleAwardTotal(decodedWins, decodedEvents, totalWinMinor);

  onStage?.("projection-invariant-wheel");
  validateWheelAwardProjection(decodedEvents, decodedFeatureState, betMinor);

  onStage?.("projection-invariant-vault");
  validateVaultAwardProjection(decodedGrid, decodedEvents, decodedFeatureState, betMinor);

  onStage?.("projection-invariant-reels");
  validateResultReelProjection(decodedGrid, decodedEvents, decodedFeatureState);

  onStage?.("projection-message-output");
  return {
    type: "spin.result",
    protocolVersion: protocolVersion(message.protocolVersion),
    requestId: identifier(message.requestId, "requestId"),
    sessionId: identifier(message.sessionId, "sessionId"),
    roundId: identifier(message.roundId, "roundId"),
    sequence: positiveInteger(message.sequence, "sequence"),
    betMinor,
    chargedBetMinor: money(message.chargedBetMinor, "chargedBetMinor"),
    balanceMinor: money(message.balanceMinor, "balanceMinor"),
    totalWinMinor,
    grid: decodedGrid,
    wins: decodedWins,
    events: decodedEvents,
    featureState: decodedFeatureState,
  };
}

export function decodeServerMessage(
  input: string | unknown,
  onSpinResultStage?: SpinResultProjectionStageObserver,
): ServerMessage {
  let raw: unknown = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input) as unknown;
    } catch {
      throw new ProtocolDecodeError("message is not valid JSON");
    }
  }

  const message = record(raw, "message");
  const type = string(message.type, "type");

  switch (type) {
    case "session.opened": {
      exactKeys(message, [
        "type",
        "protocolVersion",
        "engineRulesVersion",
        "requestId",
        "sessionId",
        "balanceMinor",
        "betOptionsMinor",
        "defaultBetMinor",
        "featureState",
      ], "message");
      const options = message.betOptionsMinor;
      if (!Array.isArray(options) || options.length === 0 || options.length > 100) {
        throw new ProtocolDecodeError("betOptionsMinor must contain 1-100 entries");
      }
      const betOptionsMinor = options.map((value, index) => money(value, `betOptionsMinor[${index}]`));
      if (new Set(betOptionsMinor).size !== betOptionsMinor.length) {
        throw new ProtocolDecodeError("betOptionsMinor entries must be unique");
      }
      const defaultBetMinor = money(message.defaultBetMinor, "defaultBetMinor");
      if (!betOptionsMinor.includes(defaultBetMinor)) {
        throw new ProtocolDecodeError("defaultBetMinor must occur in betOptionsMinor");
      }
      if (message.engineRulesVersion !== ENGINE_RULES_VERSION) {
        throw new ProtocolDecodeError(
          `engineRulesVersion must equal ${ENGINE_RULES_VERSION}`,
        );
      }
      return {
        type,
        protocolVersion: protocolVersion(message.protocolVersion),
        engineRulesVersion: ENGINE_RULES_VERSION,
        requestId: identifier(message.requestId, "requestId"),
        sessionId: identifier(message.sessionId, "sessionId"),
        balanceMinor: money(message.balanceMinor, "balanceMinor"),
        betOptionsMinor,
        defaultBetMinor,
        featureState: featureState(message.featureState, "featureState"),
      };
    }
    case "spin.result":
      return decodeSpinResult(message, onSpinResultStage);
    case "error": {
      exactKeys(message, [
        "type",
        "protocolVersion",
        "requestId",
        "sessionId",
        "roundId",
        "code",
        "message",
        "retryable",
      ], "message");
      const decodedError: ServerMessage = {
        type,
        protocolVersion: protocolVersion(message.protocolVersion),
        requestId: optionalIdentifier(message.requestId, "requestId"),
        sessionId: optionalIdentifier(message.sessionId, "sessionId"),
        roundId: optionalIdentifier(message.roundId, "roundId"),
        code: identifier(message.code, "code"),
        message: boundedString(message.message, "message", 512),
        retryable: boolean(message.retryable, "retryable"),
      };
      return decodedError;
    }
    default:
      throw new ProtocolDecodeError(`unsupported message type ${type}`);
  }
}
