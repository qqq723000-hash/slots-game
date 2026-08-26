import type {
  CellAddress,
  FeatureEvent,
  FeatureState,
  MoneyMinor,
  SpinResult,
  WheelAwardedEvent,
} from "../app/state/types";
import {
  PRIMAL_MAX_WIN_MULTIPLIER,
  WHEEL_INSTANT_MULTIPLIER_BY_TIER,
  type WheelJackpotTier,
} from "./protocolConstants";

export class SpinResultOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpinResultOriginError";
  }
}

const MONEY_PATTERN = /^(0|[1-9]\d*)$/;
const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const MAX_RAGE_COLLECTED = 1_000_000;

const VAULT_SEMANTIC_TYPES = new Set<FeatureEvent["type"]>([
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

function wheelAwardRecord(event: WheelAwardedEvent): Readonly<Record<string, unknown>> {
  return event as unknown as Readonly<Record<string, unknown>>;
}

function isWheelJackpotTier(value: unknown): value is WheelJackpotTier {
  return typeof value === "string"
    && Object.hasOwn(WHEEL_INSTANT_MULTIPLIER_BY_TIER, value);
}

function isCanonicalMoney(value: unknown): value is MoneyMinor {
  return typeof value === "string"
    && MONEY_PATTERN.test(value)
    && value.length <= 19
    && BigInt(value) <= MAX_SIGNED_INT64;
}

function validateInstantWheelAward(
  event: WheelAwardedEvent,
  betMinor: MoneyMinor,
  capped: boolean,
): void {
  const raw = wheelAwardRecord(event);
  const prize = raw.prize;
  if (!isWheelJackpotTier(prize)) {
    throw new SpinResultOriginError("INSTANT requires a canonical Jackpot tier");
  }
  const multiplier = WHEEL_INSTANT_MULTIPLIER_BY_TIER[prize];
  if (raw.multiplier !== multiplier) {
    throw new SpinResultOriginError(
      `INSTANT ${prize} requires the canonical ×${multiplier} multiplier`,
    );
  }
  if (!isCanonicalMoney(raw.amountMinor)) {
    throw new SpinResultOriginError("INSTANT requires a canonical signed-int64 amountMinor");
  }
  const expectedAmount = BigInt(betMinor) * BigInt(multiplier);
  if (expectedAmount > MAX_SIGNED_INT64) {
    throw new SpinResultOriginError("INSTANT amount exceeds the signed-int64 money domain");
  }
  if (BigInt(raw.amountMinor) > expectedAmount
    || (!capped && BigInt(raw.amountMinor) !== expectedAmount)) {
    throw new SpinResultOriginError(
      "INSTANT amountMinor must equal its nominal award unless win-capped",
    );
  }
}

function validateWinCapAgainstOrigin(
  origin: Readonly<FeatureState>,
  result: Readonly<SpinResult>,
): void {
  const capEvents = eventsOfType(result.events, "win_cap.reached");
  if (capEvents.length > 1) {
    throw new SpinResultOriginError("Result must not contain duplicate win_cap.reached events");
  }
  const expectedCap = BigInt(result.betMinor) * BigInt(PRIMAL_MAX_WIN_MULTIPLIER);
  if (expectedCap > MAX_SIGNED_INT64) {
    throw new SpinResultOriginError("Whole-game win cap exceeds the signed-int64 money domain");
  }
  const prior = origin.mode === "BASE" ? 0n : BigInt(origin.freeSpinsWinMinor ?? "-1");
  if (prior < 0n || prior > expectedCap) {
    throw new SpinResultOriginError("Origin feature win is outside the whole-game cap");
  }
  const cycleWin = prior + BigInt(result.totalWinMinor);
  if (cycleWin > expectedCap) {
    throw new SpinResultOriginError("Settled whole-game win exceeds the definition cap");
  }
  const capEvent = capEvents[0];
  const hasClippedWays = result.wins.some((win) => (
    BigInt(win.amountMinor) < BigInt(win.nominalAmountMinor)
  ));
  if (!capEvent) {
    if (cycleWin === expectedCap && (BigInt(result.totalWinMinor) > 0n || hasClippedWays)) {
      throw new SpinResultOriginError("A reached whole-game cap requires win_cap.reached");
    }
    return;
  }
  const hasNominalAward = result.wins.some((win) => BigInt(win.nominalAmountMinor) > 0n)
    || result.events.some((event) => (
      (event.type === "wheel.awarded" && event.outcome === "INSTANT")
      || event.type === "vault.awarded"
    ));
  if (!hasNominalAward) {
    throw new SpinResultOriginError(
      "win_cap.reached requires a positive mathematical award in this result",
    );
  }
  if (capEvent.multiplier !== PRIMAL_MAX_WIN_MULTIPLIER
    || BigInt(capEvent.cumulativeWinMinor) !== expectedCap
    || cycleWin !== expectedCap) {
    throw new SpinResultOriginError("win_cap.reached does not match the whole-game cap facts");
  }
}

function validateFeatureWheelAward(event: WheelAwardedEvent): void {
  const raw = wheelAwardRecord(event);
  if (Object.hasOwn(raw, "multiplier") || Object.hasOwn(raw, "amountMinor")) {
    throw new SpinResultOriginError(
      "Feature Wheel outcomes must not contain multiplier or amountMinor",
    );
  }
  const expectedPrize = event.outcome === "EXPANSION" ? "KONG_QUEST" : "KING_SPIN";
  if (Object.hasOwn(raw, "prize") && raw.prize !== expectedPrize) {
    throw new SpinResultOriginError(
      `${event.outcome} prize must be ${expectedPrize}`,
    );
  }
}

function addMoney(left: MoneyMinor | undefined, right: MoneyMinor): MoneyMinor {
  return (BigInt(left ?? "0") + BigInt(right)).toString();
}

function eventOfType<T extends FeatureEvent["type"]>(
  events: readonly FeatureEvent[],
  type: T,
): Extract<FeatureEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<FeatureEvent, { type: T }> => (
    event.type === type
  ));
}

function eventsOfType<T extends FeatureEvent["type"]>(
  events: readonly FeatureEvent[],
  type: T,
): Extract<FeatureEvent, { type: T }>[] {
  return events.filter((event): event is Extract<FeatureEvent, { type: T }> => (
    event.type === type
  ));
}

function positionKey(position: Readonly<CellAddress>): string {
  return `${position.reel}:${position.row}`;
}

function positionsForSymbol(
  result: Readonly<Pick<SpinResult, "grid">>,
  symbol: "VAULT" | "SURGE",
): Readonly<CellAddress>[] {
  const positions: CellAddress[] = [];
  result.grid.forEach((reel, reelIndex) => {
    reel.forEach((cell, rowIndex) => {
      if (cell.symbol === symbol) positions.push({ reel: reelIndex, row: rowIndex });
    });
  });
  return positions;
}

function samePositions(
  actual: readonly Readonly<CellAddress>[],
  expected: readonly Readonly<CellAddress>[],
): boolean {
  return actual.length === expected.length && actual.every((position, index) => (
    position.reel === expected[index]?.reel && position.row === expected[index]?.row
  ));
}

function eventPosition(event: FeatureEvent): Readonly<CellAddress> | null {
  const raw = event as unknown as Readonly<Record<string, unknown>>;
  return Number.isSafeInteger(raw.reel) && Number.isSafeInteger(raw.row)
    ? { reel: raw.reel as number, row: raw.row as number }
    : null;
}

function vaultPrizeName(multiplier: number, kingSpin: boolean): string | null {
  if (!Number.isSafeInteger(multiplier) || multiplier <= 0) return null;
  if (kingSpin) {
    const doubled: Readonly<Record<number, string>> = {
      20: "MINI_2X",
      60: "MINOR_2X",
      150: "MAJOR_2X",
      500: "MEGA_2X",
    };
    if (doubled[multiplier]) return doubled[multiplier];
  }
  if (multiplier >= 1 && multiplier <= 9) return `X${multiplier}`;
  const fixed: Readonly<Record<number, string>> = {
    10: "MINI",
    30: "MINOR",
    75: "MAJOR",
    250: "MEGA",
    1_000: "GRAND",
  };
  return fixed[multiplier] ?? null;
}

function expectedVaultAmount(betMinor: MoneyMinor, multiplier: number): bigint {
  const amount = BigInt(betMinor) * BigInt(multiplier);
  if (amount > MAX_SIGNED_INT64) {
    throw new SpinResultOriginError("Vault award exceeds the signed-int64 money domain");
  }
  return amount;
}

function assertVaultGroup(
  event: Extract<FeatureEvent, { type: "vaults.landed" | "vaults.locked" | "vaults.unlock.started" | "vaults.unlock.completed" }>,
  positions: readonly Readonly<CellAddress>[],
): void {
  if (event.count !== positions.length || !samePositions(event.cells, positions)) {
    throw new SpinResultOriginError(
      `${event.type} must match every settled Vault exactly once and in reel order`,
    );
  }
}

/** 针对提交模式镜像 validateVaultEvents/validateKingSpinVaultEvents。 */
export function validateVaultEventsAgainstOrigin(
  origin: Readonly<FeatureState>,
  result: Readonly<Pick<SpinResult, "grid" | "events" | "betMinor">>,
): void {
  const winCapped = result.events.some((event) => event.type === "win_cap.reached");
  const positions = positionsForSymbol(result, "VAULT");
  const positionKeys = new Set(positions.map(positionKey));
  const semanticEvents = result.events.filter((event) => VAULT_SEMANTIC_TYPES.has(event.type));
  if (positions.length === 0) {
    if (semanticEvents.length > 0) {
      throw new SpinResultOriginError("Vault event exists without a settled Vault");
    }
    return;
  }

  const landedEvents = eventsOfType(result.events, "vaults.landed");
  if (landedEvents.length !== 1) {
    throw new SpinResultOriginError("Settled Vaults require exactly one vaults.landed event");
  }
  const landed = landedEvents[0]!;
  const landedIndex = result.events.indexOf(landed);
  const expectedLandedIndex = origin.mode === "EXPANSION" ? 1 : 0;
  if (landedIndex !== expectedLandedIndex) {
    throw new SpinResultOriginError("vaults.landed is not at the mode-owned event boundary");
  }
  assertVaultGroup(landed, positions);

  const lockedEvents = eventsOfType(result.events, "vaults.locked");
  const unlockStartedEvents = eventsOfType(result.events, "vaults.unlock.started");
  const unlockCompletedEvents = eventsOfType(result.events, "vaults.unlock.completed");
  if (lockedEvents.length === 1) {
    const locked = lockedEvents[0]!;
    if (origin.mode === "OVERDRIVE"
      || result.events.indexOf(locked) !== landedIndex + 1
      || unlockStartedEvents.length !== 0
      || unlockCompletedEvents.length !== 0
      || semanticEvents.length !== 2) {
      throw new SpinResultOriginError("Invalid locked Vault branch for the submitted mode");
    }
    assertVaultGroup(locked, positions);
    for (const position of positions) {
      const cell = result.grid[position.reel]?.[position.row];
      if (!cell || cell.multiplier !== undefined || cell.prize !== undefined) {
        throw new SpinResultOriginError("Locked Vault cannot expose a settled reward");
      }
    }
    return;
  }
  if (lockedEvents.length !== 0
    || unlockStartedEvents.length !== 1
    || unlockCompletedEvents.length !== 1) {
    throw new SpinResultOriginError("Invalid Vault unlock boundaries");
  }

  const unlockStarted = unlockStartedEvents[0]!;
  const unlockCompleted = unlockCompletedEvents[0]!;
  const unlockStartedIndex = result.events.indexOf(unlockStarted);
  const unlockCompletedIndex = result.events.indexOf(unlockCompleted);
  if (unlockStartedIndex !== landedIndex + 1 || unlockCompletedIndex <= unlockStartedIndex) {
    throw new SpinResultOriginError("Vault unlock boundaries are out of order");
  }
  assertVaultGroup(unlockStarted, positions);
  assertVaultGroup(unlockCompleted, positions);

  type Reveal = Extract<FeatureEvent, { type: "vault.unlocked" }>;
  type Award = Extract<FeatureEvent, { type: "vault.awarded" }>;
  type FinalFreeResult = Extract<FeatureEvent, {
    type: "free_spin.awarded" | "free_spin.cap_reached";
  }>;
  const reveals = new Map<string, Reveal>();
  const awards = new Map<string, Award>();
  const freeResults = new Map<string, FinalFreeResult>();

  result.events.forEach((event, index) => {
    if (event.type === "vault.unlocked") {
      const position = eventPosition(event);
      const key = position ? positionKey(position) : "";
      if (index <= unlockStartedIndex || index >= unlockCompletedIndex
        || !positionKeys.has(key) || typeof event.prize !== "string" || event.prize.length === 0) {
        throw new SpinResultOriginError("Invalid vault.unlocked event");
      }
      if (reveals.has(key)) throw new SpinResultOriginError("Duplicate Vault reveal");
      reveals.set(key, event);
      return;
    }
    if (event.type === "vault.awarded") {
      const position = eventPosition(event);
      const key = position ? positionKey(position) : "";
      if (!positionKeys.has(key)
        || !Number.isSafeInteger(event.multiplier) || event.multiplier <= 0
        || !isCanonicalMoney(event.amountMinor)
        || (!winCapped && BigInt(event.amountMinor) <= 0n)
        || typeof event.prize !== "string" || event.prize.length === 0
        || (origin.mode !== "OVERDRIVE"
          && (index <= unlockStartedIndex || index >= unlockCompletedIndex))
        || (origin.mode === "OVERDRIVE" && index <= unlockCompletedIndex)) {
        throw new SpinResultOriginError("Invalid vault.awarded event");
      }
      if (awards.has(key)) throw new SpinResultOriginError("Duplicate Vault award");
      awards.set(key, event);
      return;
    }
    if (event.type === "free_spin.awarded" || event.type === "free_spin.cap_reached") {
      const position = eventPosition(event);
      const key = position ? positionKey(position) : "";
      if (origin.mode !== "EXPANSION" || !positionKeys.has(key)
        || index <= unlockStartedIndex || index >= unlockCompletedIndex) {
        throw new SpinResultOriginError("Vault Free Spin result is outside Kong Quest");
      }
      if (event.type === "free_spin.awarded" && event.count !== 1) {
        throw new SpinResultOriginError("Vault Free Spin award count must be one");
      }
      if (freeResults.has(key)) {
        throw new SpinResultOriginError("Duplicate Vault Free Spin result");
      }
      freeResults.set(key, event);
      return;
    }
    if (event.type === "vault.upgraded" || event.type === "vaults.upgrade.started") {
      if (origin.mode !== "OVERDRIVE" || index <= unlockCompletedIndex) {
        throw new SpinResultOriginError("Vault upgrade is outside King Spin");
      }
    }
  });
  if (reveals.size !== positions.length) {
    throw new SpinResultOriginError("Every unlocked Vault must have exactly one reveal");
  }

  if (origin.mode === "OVERDRIVE") {
    if (freeResults.size !== 0 || awards.size !== positions.length) {
      throw new SpinResultOriginError("Every King Spin Vault requires one monetary final award");
    }
    const currentMultiplier = new Map<string, number>();
    const currentPrize = new Map<string, string>();
    for (const position of positions) {
      const key = positionKey(position);
      const reveal = reveals.get(key)!;
      if (reveal.multiplier === undefined
        || reveal.prize !== vaultPrizeName(reveal.multiplier, true)) {
        throw new SpinResultOriginError("Invalid initial King Spin Vault reveal");
      }
      currentMultiplier.set(key, reveal.multiplier);
      currentPrize.set(key, reveal.prize);
    }

    const firstAwardIndex = result.events.findIndex((event) => event.type === "vault.awarded");
    if (firstAwardIndex <= unlockCompletedIndex) {
      throw new SpinResultOriginError("King Spin Vault awards must follow unlock and upgrades");
    }
    let lastAwardIndex = firstAwardIndex;
    for (let index = firstAwardIndex + 1; index < result.events.length; index += 1) {
      if (result.events[index]?.type === "vault.awarded") lastAwardIndex = index;
    }
    const winCapIndex = result.events.findIndex((event) => event.type === "win_cap.reached");
    const completionIndex = result.events.findIndex((event) => event.type === "free_spins.completed");
    if (winCapIndex >= 0 && (
      winCapIndex !== lastAwardIndex + 1
      || (winCapIndex !== result.events.length - 1
        && !(completionIndex === result.events.length - 1
          && winCapIndex === completionIndex - 1))
    )) {
      throw new SpinResultOriginError(
        "King Spin win_cap.reached must immediately follow the final Vault award and terminate the result before completion",
      );
    }
    for (let index = firstAwardIndex; index < result.events.length; index += 1) {
      const event = result.events[index];
      if (event?.type !== "vault.awarded"
        && event?.type !== "win_cap.reached"
        && event?.type !== "free_spins.completed") {
        throw new SpinResultOriginError("King Spin final awards must be contiguous");
      }
    }

    let expectedStep = 1;
    let activeStep = 0;
    let activeCount = 0;
    let seenInStep = new Set<string>();
    const finishStep = (): void => {
      if (activeStep !== 0 && activeCount !== seenInStep.size) {
        throw new SpinResultOriginError("King Spin upgrade group count is incorrect");
      }
    };
    for (let index = unlockCompletedIndex + 1; index < firstAwardIndex; index += 1) {
      const event = result.events[index];
      if (event?.type === "vaults.upgrade.started") {
        finishStep();
        if (event.step !== expectedStep || event.count <= 0) {
          throw new SpinResultOriginError("King Spin upgrade steps are not contiguous");
        }
        activeStep = event.step;
        activeCount = event.count;
        expectedStep += 1;
        seenInStep = new Set<string>();
        continue;
      }
      if (event?.type === "vault.upgraded") {
        const position = eventPosition(event);
        const key = position ? positionKey(position) : "";
        if (activeStep === 0 || event.step !== activeStep || !positionKeys.has(key)
          || event.fromMultiplier !== currentMultiplier.get(key)
          || event.toMultiplier <= event.fromMultiplier
          || event.prize !== vaultPrizeName(event.toMultiplier, true)) {
          throw new SpinResultOriginError("Invalid or discontinuous King Spin Vault upgrade");
        }
        if (seenInStep.has(key)) {
          throw new SpinResultOriginError("Duplicate Vault in one King Spin upgrade step");
        }
        seenInStep.add(key);
        currentMultiplier.set(key, event.toMultiplier);
        currentPrize.set(key, event.prize);
        continue;
      }
      throw new SpinResultOriginError("Unrelated event interrupts King Spin upgrades");
    }
    finishStep();

    for (const position of positions) {
      const key = positionKey(position);
      const award = awards.get(key)!;
      const cell = result.grid[position.reel]?.[position.row];
      const amount = expectedVaultAmount(result.betMinor, award.multiplier);
      if (award.multiplier !== currentMultiplier.get(key)
        || award.prize !== currentPrize.get(key)
        || BigInt(award.amountMinor) > amount
        || (!winCapped && BigInt(award.amountMinor) !== amount)
        || cell?.multiplier !== award.multiplier
        || cell.prize !== award.prize) {
        throw new SpinResultOriginError(
          "Final King Spin Vault award does not match its upgrade chain, grid, or amount",
        );
      }
    }
    return;
  }

  for (const position of positions) {
    const key = positionKey(position);
    const reveal = reveals.get(key)!;
    const award = awards.get(key);
    const freeResult = freeResults.get(key);
    const cell = result.grid[position.reel]?.[position.row];
    if ((award === undefined) === (freeResult === undefined)) {
      throw new SpinResultOriginError("Every revealed Vault needs exactly one final result");
    }
    if (award) {
      const amount = expectedVaultAmount(result.betMinor, award.multiplier);
      if (reveal.prize !== award.prize
        || reveal.multiplier !== award.multiplier
        || award.prize !== vaultPrizeName(award.multiplier, false)
        || BigInt(award.amountMinor) > amount
        || (!winCapped && BigInt(award.amountMinor) !== amount)
        || cell?.multiplier !== award.multiplier
        || cell.prize !== award.prize) {
        throw new SpinResultOriginError("Vault reveal, final grid, and payable award disagree");
      }
    } else if (reveal.prize !== "FREE_SPIN" || reveal.multiplier !== undefined
      || cell?.prize !== "FREE_SPIN" || cell.multiplier !== undefined) {
      throw new SpinResultOriginError("Invalid FREE_SPIN Vault reveal or settled grid");
    }
  }
  for (let index = unlockStartedIndex + 1; index < unlockCompletedIndex; index += 1) {
    const event = result.events[index];
    if (event?.type !== "vault.unlocked" && event?.type !== "vault.awarded"
      && event?.type !== "free_spin.awarded" && event?.type !== "free_spin.cap_reached") {
      throw new SpinResultOriginError("Unrelated event interrupts the Vault unlock sequence");
    }
  }
}

/** 镜像服务端所有的 Base Rage/PPS 计量条与 Wheel 触发守恒规则。 */
function validateRageEventsAgainstOrigin(
  origin: Readonly<FeatureState>,
  result: Readonly<SpinResult>,
): void {
  const positions = positionsForSymbol(result, "SURGE");
  const collections = eventsOfType(result.events, "surge.collected");
  const transformations = eventsOfType(result.events, "rage.transformed");
  const wheelStarted = eventsOfType(result.events, "wheel.started");
  const wheelAwarded = eventsOfType(result.events, "wheel.awarded");
  const freeSpinsStarted = eventsOfType(result.events, "free_spins.started");
  const rageEventCount = collections.length + transformations.length
    + wheelStarted.length + wheelAwarded.length + freeSpinsStarted.length;

  if (origin.mode !== "BASE") {
    if (positions.length > 0 || rageEventCount > 0) {
      throw new SpinResultOriginError("Rage symbols and Wheel transitions are Base-only");
    }
    return;
  }
  if (positions.length === 0) {
    if (rageEventCount > 0) {
      throw new SpinResultOriginError("Rage or Wheel event exists without settled Rage");
    }
    if (result.featureState.rageCollected !== origin.rageCollected
      || result.featureState.rageLevel !== origin.rageLevel) {
      throw new SpinResultOriginError("Empty Base spin changed the Rage meter");
    }
    return;
  }
  if (positions.length > 3) {
    throw new SpinResultOriginError("Base result cannot settle more than three Rage symbols");
  }
  if (collections.length !== 1) {
    throw new SpinResultOriginError("Settled Rage requires exactly one surge.collected event");
  }
  const collection = collections[0]!;
  const creditedTotal = positions.length === 3
    ? origin.rageCollected
    : origin.rageCollected + positions.length;
  if (creditedTotal > MAX_RAGE_COLLECTED) {
    throw new SpinResultOriginError("Rage meter exceeds the protocol limit");
  }
  const resetsPps = collection.triggered && !collection.guaranteed;
  const expectedEventTotal = resetsPps ? 0 : creditedTotal;
  if (collection.count !== positions.length
    || !samePositions(collection.cells, positions)
    || collection.guaranteed !== (positions.length === 3)
    || (positions.length === 3 && !collection.triggered)
    || collection.total !== expectedEventTotal
    || (resetsPps && collection.level !== 1)
    || collection.level < 1) {
    throw new SpinResultOriginError("surge.collected does not match the settled Rage set");
  }
  if (positions.length === 3 && collection.level !== origin.rageLevel) {
    throw new SpinResultOriginError("Guaranteed Rage trigger changed the persistent PPS level");
  }
  if (!collection.triggered) {
    if (result.featureState.rageCollected !== creditedTotal
      || result.featureState.rageLevel !== collection.level) {
      throw new SpinResultOriginError(
        "Non-triggering Rage result did not preserve the credited PPS meter",
      );
    }
    if (transformations.length + wheelStarted.length + wheelAwarded.length
      + freeSpinsStarted.length !== 0) {
      throw new SpinResultOriginError("Failed Rage collection changed the Wheel state");
    }
    return;
  }
  const collectionIndex = result.events.indexOf(collection);
  const wheelStartedIndex = result.events.indexOf(wheelStarted[0] as FeatureEvent);
  const wheelAwardedIndex = result.events.indexOf(wheelAwarded[0] as FeatureEvent);
  if (wheelStarted.length !== 1 || wheelAwarded.length !== 1
    || wheelStartedIndex <= collectionIndex || wheelAwardedIndex <= wheelStartedIndex) {
    throw new SpinResultOriginError("Triggered Rage requires an ordered Wheel start and award");
  }
  if (positions.length < 3) {
    if (collection.level !== 1 || collection.total !== 0
      || result.featureState.rageLevel !== 1
      || result.featureState.rageCollected !== 0) {
      throw new SpinResultOriginError(
        "One/two-Rage Wheel trigger did not reset the authoritative PPS meter",
      );
    }
    const transformed = transformations[0];
    const transformedIndex = result.events.indexOf(transformed as FeatureEvent);
    const settledKeys = new Set(positions.map(positionKey));
    const transformedKeys = new Set(transformed?.cells.map(positionKey));
    if (transformations.length !== 1 || !transformed
      || transformedIndex <= collectionIndex || transformedIndex >= wheelStartedIndex
      || transformed.count !== 3 - positions.length
      || transformed.cells.length !== transformed.count
      || transformed.level !== collection.level
      || transformed.total !== collection.total
      || transformedKeys.size !== transformed.cells.length
      || transformed.cells.some((position) => settledKeys.has(positionKey(position)))) {
      throw new SpinResultOriginError("One/two-Rage trigger has an invalid transformation");
    }
  } else if (transformations.length !== 0) {
    throw new SpinResultOriginError("Guaranteed Rage trigger must not transform extra symbols");
  } else if (result.featureState.rageLevel !== origin.rageLevel
    || result.featureState.rageCollected !== origin.rageCollected) {
    throw new SpinResultOriginError(
      "Guaranteed Rage trigger changed the request-origin PPS meter",
    );
  }
}

/**
 * 把解码结果绑定到实际提交请求的局前状态。v1 线上响应只投影下一状态，因此控制器侧必须补齐
 * 无状态 JSON 解码器无法证明的不变式。
 */
export function validateSpinResultAgainstOrigin(
  origin: Readonly<FeatureState>,
  result: Readonly<SpinResult>,
): void {
  if (origin.mode === "BASE" && result.chargedBetMinor !== result.betMinor) {
    throw new SpinResultOriginError(
      "Base spins must charge exactly their submitted bet",
    );
  }

  const rows = result.grid[0]?.length ?? 0;
  const expansion = eventOfType(result.events, "grid.expanded");
  const started = eventOfType(result.events, "free_spins.started");
  const completed = eventOfType(result.events, "free_spins.completed");
  const wheelStarted = eventOfType(result.events, "wheel.started");
  const wheelAwarded = eventOfType(result.events, "wheel.awarded");

  validateWinCapAgainstOrigin(origin, result);

  if (origin.mode === "EXPANSION") {
    if (rows < 3 || rows > 8 || result.events[0]?.type !== "grid.expanded" || !expansion) {
      throw new SpinResultOriginError(
        "Kong Quest origin requires a leading 3-8 row grid.expanded event",
      );
    }
    if (result.events.filter((event) => event.type === "grid.expanded").length !== 1
      || expansion.rows !== rows
      || expansion.ways !== rows ** 3) {
      throw new SpinResultOriginError(
        "Kong Quest grid.expanded must uniquely match the rendered rows and ways",
      );
    }
  } else if (rows !== 3 || expansion) {
    throw new SpinResultOriginError(
      "Only a Kong Quest origin may carry grid.expanded or a non-3-row grid",
    );
  }

  validateVaultEventsAgainstOrigin(origin, result);
  validateRageEventsAgainstOrigin(origin, result);

  if (origin.mode === "BASE") {
    if (completed || result.events.some((event) => (
      event.type === "free_spin.awarded" || event.type === "free_spin.cap_reached"
    ))) {
      throw new SpinResultOriginError("Base origin cannot complete or extend Free Spins");
    }
    if ((wheelStarted === undefined) !== (wheelAwarded === undefined)) {
      throw new SpinResultOriginError(
        "A Primal Wheel transition requires matching wheel.started and wheel.awarded events",
      );
    }
    if (!wheelAwarded) {
      if (started) {
        throw new SpinResultOriginError(
          "Free Spins start requires a matching Primal Wheel outcome",
        );
      }
      if (result.featureState.mode !== "BASE") {
        throw new SpinResultOriginError("A new feature state requires free_spins.started");
      }
      return;
    }

    if (wheelAwarded.outcome === "INSTANT") {
      if (started) {
        throw new SpinResultOriginError("INSTANT must not start Free Spins");
      }
      validateInstantWheelAward(
        wheelAwarded,
        result.betMinor,
        result.events.some((event) => event.type === "win_cap.reached"),
      );
      if (result.featureState.mode !== "BASE"
        || result.featureState.freeSpinsRemaining !== 0
        || (result.featureState.freeSpinsPlayed ?? 0) !== 0) {
        throw new SpinResultOriginError(
          "INSTANT must project the next feature state as BASE",
        );
      }
      return;
    }

    if (wheelAwarded.outcome !== "EXPANSION" && wheelAwarded.outcome !== "OVERDRIVE") {
      throw new SpinResultOriginError("Unknown Primal Wheel outcome");
    }
    validateFeatureWheelAward(wheelAwarded);
    const wheelAwardedIndex = result.events.indexOf(wheelAwarded);
    const startedIndex = result.events.indexOf(started as FeatureEvent);
    if (!started
      || startedIndex !== wheelAwardedIndex + 1
      || wheelAwarded.outcome !== started.mode) {
      throw new SpinResultOriginError(
        "Free Spins start must immediately follow its matching Primal Wheel outcome",
      );
    }
    if (started.awarded !== 8
      || result.featureState.mode !== started.mode
      || result.featureState.freeSpinsRemaining !== 8
      || result.featureState.freeSpinsPlayed !== 0
      || result.featureState.baseBetMinor !== result.betMinor
      || result.featureState.freeSpinsWinMinor !== result.totalWinMinor) {
      throw new SpinResultOriginError(
        "Free Spins start must project exactly 8 unplayed spins and carry this round's paid win at the locked bet",
      );
    }
    return;
  }

  if (started) {
    throw new SpinResultOriginError("An active Free Spins round cannot start another feature");
  }
  if (result.featureState.rageLevel !== origin.rageLevel
    || result.featureState.rageCollected !== origin.rageCollected) {
    throw new SpinResultOriginError("Free Spins cannot change the persistent Rage meter");
  }
  if (result.chargedBetMinor !== "0" || result.betMinor !== origin.baseBetMinor) {
    throw new SpinResultOriginError("Free Spins must be uncharged and retain their locked bet");
  }
  if (result.events.some((event) => (
    event.type === "surge.collected"
    || event.type === "rage.transformed"
    || event.type === "wheel.started"
    || event.type === "wheel.awarded"
  ))) {
    throw new SpinResultOriginError("Rage and Wheel events are Base-only");
  }

  const freeSpinAwards = result.events.filter((event) => event.type === "free_spin.awarded");
  if (origin.mode !== "EXPANSION" && freeSpinAwards.length > 0) {
    throw new SpinResultOriginError("Only Kong Quest can award extra Free Spins");
  }
  const awardCount = freeSpinAwards.reduce((total, event) => total + event.count, 0);
  if (freeSpinAwards.some((event) => event.count !== 1)) {
    throw new SpinResultOriginError("Each Kong Quest Vault must award exactly one Free Spin");
  }

  const originPlayed = origin.freeSpinsPlayed ?? 0;
  const originAwarded = origin.freeSpinsRemaining + originPlayed;
  const expectedRemaining = origin.freeSpinsRemaining - 1 + awardCount;
  const expectedAwarded = originAwarded + awardCount;
  const expectedWin = addMoney(origin.freeSpinsWinMinor, result.totalWinMinor);

  if (expectedRemaining > 0) {
    if (completed
      || result.featureState.mode !== origin.mode
      || result.featureState.freeSpinsRemaining !== expectedRemaining
      || result.featureState.freeSpinsPlayed !== originPlayed + 1
      || result.featureState.baseBetMinor !== origin.baseBetMinor
      || result.featureState.freeSpinsWinMinor !== expectedWin) {
      throw new SpinResultOriginError("Active Free Spins result violates counter or win conservation");
    }
    return;
  }

  if (expectedRemaining !== 0
    || result.featureState.mode !== "BASE"
    || !completed
    || result.events.at(-1) !== completed
    || completed.mode !== origin.mode
    || completed.awarded !== expectedAwarded
    || completed.cumulativeWinMinor !== expectedWin) {
    throw new SpinResultOriginError("Terminal Free Spins result violates completion conservation");
  }
}
