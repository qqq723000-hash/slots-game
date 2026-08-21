// @ts-expect-error Vitest 在 Node 中运行；浏览器生产版 tsconfig 刻意省略 Node 全局类型。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FeatureEvent, FeatureState, SpinResult } from "../src/app/state/types";
import {
  AUTO_PLAY_STOP_CONDITIONS,
  AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY,
  AUTO_PLAY_STOP_SETTINGS_STORAGE_VERSION,
  AUTO_PLAY_SPIN_COUNTS,
  BASE_PAYTABLE_ENTRIES,
  CAPTURED_AUTO_PLAY_STOP_SETTINGS,
  DEFAULT_AUTO_PLAY_STOP_SETTINGS,
  DEFAULT_AUTO_PLAY_SPINS,
  DomOverlay,
  PAYTABLE_WILD_ENTRIES,
  PRIMAL_BASE_SPIN_MESSAGES,
  PRIMAL_AUTOPLAY_BONUS_DELAY_MS,
  PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS,
  PRIMAL_DESKTOP_UI_GEOMETRY,
  WHEEL_HYPERSPIN_FRAME_MS,
  advanceAutoPlay,
  autoplayFeatureInputDelay,
  betTickerWindow,
  bigWinCongratulationsPresentation,
  freeSpinConclusionPresentation,
  jackpotValuesForBet,
  isAutoplayFeatureOwnedSpinMode,
  ordinaryWinInformationPresentation,
  nextWheelHyperspinFrame,
  primarySpinControlPresentation,
  parseAutoPlayStopSettings,
  persistAutoPlayStopSettings,
  roundStatePresentation,
  selectPrimalBaseSpinMessage,
  serializeAutoPlayStopSettings,
  soundControlPresentation,
  spinControlPresentation,
  spinModeDisabled,
  visibleWinMinorForResult,
  wheelHyperspinSpritePosition,
  wheelBonusRoundSummaryPresentation,
  UiPanelLifecycle,
} from "../src/ui/DomOverlay";
import { PRIMAL_WAY_WINS_COPY } from "../src/ui/presentationRules";
import {
  MoneyDisplayBindingError,
  createMinorUnitFormatter,
  type MinorUnitFormatter,
} from "../src/protocol/moneyFormatter";

describe("session money display contract", () => {
  it.each([
    { exponent: 0, minor: "1234", grouped: "1,234", plain: "1234", small: "5" },
    { exponent: 2, minor: "123456", grouped: "1,234.56", plain: "1234.56", small: "0.05" },
    { exponent: 3, minor: "1234567", grouped: "1,234.567", plain: "1234.567", small: "0.005" },
  ])("formats integer minor units exactly for exponent=$exponent", ({
    exponent, minor, grouped, plain, small,
  }) => {
    const formatter = createMinorUnitFormatter({ currency: "EUR", currencyExponent: exponent });
    expect(formatter).toMatchObject({ currency: "EUR", currencyExponent: exponent });
    expect(formatter.format(minor)).toBe(grouped);
    expect(formatter.format(minor, false)).toBe(plain);
    expect(formatter.format("5")).toBe(small);
  });

  it.each([
    { exponent: 0, balance: "1234", bet: "5", win: "6789" },
    { exponent: 2, balance: "12.34", bet: "0.05", win: "67.89" },
    { exponent: 3, balance: "1.234", bet: "0.005", win: "6.789" },
  ])("uses exponent=$exponent consistently for Balance, Bet, and Win", ({
    exponent, balance: expectedBalance, bet: expectedBet, win: expectedWin,
  }) => {
    const formatter = createMinorUnitFormatter({ currency: "EUR", currencyExponent: exponent });
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const balance = { textContent: "" };
    const bet = { value: "5" };
    const betStatus = { textContent: "" };
    const betTriggerValue = { textContent: "" };
    const lastWin = { textContent: "", dataset: {} as Record<string, string> };
    const statusPanel = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      moneySessionId: "session-money",
      moneyFormatter: formatter,
      balance,
      bet,
      betStatus,
      betTriggerValue,
      betTrigger: { setAttribute: vi.fn() },
      lastWin,
      statusPanel,
      betOptions: ["5"],
      betDecrease: { disabled: false },
      betIncrease: { disabled: false },
      host: { querySelectorAll: () => [] },
      renderBetTicker: vi.fn(),
      showFeatureState: vi.fn(),
    });

    overlay.applySnapshot({
      currency: "EUR",
      currencyExponent: exponent,
      balanceMinor: "1234",
      selectedBetMinor: "5",
      betOptionsMinor: ["5"],
      featureState: { mode: "BASE", freeSpinsRemaining: 0, rageLevel: 1, rageCollected: 0 },
      lastWinMinor: "6789",
      currentGrid: [],
    });

    expect(balance.textContent).toBe(expectedBalance);
    expect(betStatus.textContent).toBe(expectedBet);
    expect(lastWin.textContent).toBe(expectedWin);
  });

  it("rejects a same-session binding drift before changing the active formatter", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const statusPanel = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, { statusPanel });
    const bind = (overlay as unknown as {
      bindSessionMoneyFormatter(session: {
        sessionId: string;
        currency: string;
        currencyExponent: number;
      }): void;
    }).bindSessionMoneyFormatter.bind(overlay);
    bind({ sessionId: "session-money", currency: "EUR", currencyExponent: 2 });

    expect(() => bind({
      sessionId: "session-money",
      currency: "EUR",
      currencyExponent: 3,
    })).toThrow(MoneyDisplayBindingError);
    expect((overlay as unknown as { moneyFormatter: MinorUnitFormatter }).moneyFormatter)
      .toMatchObject({ currency: "EUR", currencyExponent: 2 });
    expect(statusPanel.dataset).toEqual({ currency: "EUR", currencyExponent: "2" });
  });
});

function autoplayStopResult(
  sequence: number,
  totalWinMinor = "100",
  sessionId = "session-autoplay",
): SpinResult {
  return {
    type: "spin.result",
    protocolVersion: 1,
    requestId: `request-${sequence}`,
    sessionId,
    roundId: `round-${sequence}`,
    sequence,
    betMinor: "100",
    chargedBetMinor: "100",
    balanceMinor: "10000",
    totalWinMinor,
    grid: [],
    wins: [],
    events: [],
    featureState: {
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    },
  };
}

describe("Wheel HyperSpin DOM sprite", () => {
  it("uses the captured 8×6 Radiance sprite coordinates at 24fps", () => {
    expect(WHEEL_HYPERSPIN_FRAME_MS).toBeCloseTo(1_000 / 24, 10);

    expect(wheelHyperspinSpritePosition("appear", 0)).toEqual({ xPercent: 0, yPercent: 0 });
    expect(wheelHyperspinSpritePosition("appear", 7)).toEqual({ xPercent: 100, yPercent: 0 });
    expect(wheelHyperspinSpritePosition("appear", 8)).toEqual({ xPercent: 0, yPercent: 20 });
    expect(wheelHyperspinSpritePosition("appear", 15)).toEqual({ xPercent: 100, yPercent: 20 });

    expect(wheelHyperspinSpritePosition("loop", 0)).toEqual({ xPercent: 85.71, yPercent: 60 });
    expect(wheelHyperspinSpritePosition("loop", 1)).toEqual({ xPercent: 100, yPercent: 60 });
    expect(wheelHyperspinSpritePosition("loop", 2)).toEqual({ xPercent: 0, yPercent: 80 });
    expect(wheelHyperspinSpritePosition("loop", 9)).toEqual({ xPercent: 100, yPercent: 80 });
    expect(wheelHyperspinSpritePosition("loop", 10)).toEqual({ xPercent: 0, yPercent: 100 });
    expect(wheelHyperspinSpritePosition("loop", 15)).toEqual({ xPercent: 71.42, yPercent: 100 });

    expect(wheelHyperspinSpritePosition("disappear", 0)).toEqual({ xPercent: 0, yPercent: 40 });
    expect(wheelHyperspinSpritePosition("disappear", 7)).toEqual({ xPercent: 100, yPercent: 40 });
    expect(wheelHyperspinSpritePosition("disappear", 8)).toEqual({ xPercent: 0, yPercent: 60 });
    expect(wheelHyperspinSpritePosition("disappear", 13)).toEqual({ xPercent: 71.42, yPercent: 60 });
  });

  it("finishes the current ready pass before playing its captured disappear pass", () => {
    expect(nextWheelHyperspinFrame({ phase: "none", frame: 0 }, false))
      .toEqual({ phase: "none", frame: 0 });
    expect(nextWheelHyperspinFrame({ phase: "appear", frame: 14 }, true))
      .toEqual({ phase: "appear", frame: 15 });
    expect(nextWheelHyperspinFrame({ phase: "appear", frame: 15 }, false))
      .toEqual({ phase: "loop", frame: 0 });
    expect(nextWheelHyperspinFrame({ phase: "appear", frame: 15 }, true))
      .toEqual({ phase: "disappear", frame: 0 });
    expect(nextWheelHyperspinFrame({ phase: "loop", frame: 15 }, false))
      .toEqual({ phase: "loop", frame: 0 });
    expect(nextWheelHyperspinFrame({ phase: "loop", frame: 15 }, true))
      .toEqual({ phase: "disappear", frame: 0 });
    expect(nextWheelHyperspinFrame({ phase: "disappear", frame: 13 }, true))
      .toEqual({ phase: "none", frame: 0 });
  });

  it("layers the DOM sprite below the captured Wheel spin control", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    const spriteIndex = source.indexOf('data-role="wheel-hyperspin-effect"');
    const spinButtonIndex = source.indexOf('<button class="spin-button"');

    expect(spriteIndex).toBeGreaterThan(-1);
    expect(spinButtonIndex).toBeGreaterThan(spriteIndex);
    expect(css).toContain('background-size: 800% 600%');
    expect(css).toContain('transform: translateY(-1.5px) scale(2)');
  });
});

describe("Free Spins no-summary status", () => {
  it("uses the two captured concluded messages without creating a summary panel", () => {
    expect(freeSpinConclusionPresentation("0")).toEqual({
      visualText: "NO WIN, FREE SPINS CONCLUDED",
      accessibleText: "No win. Free Spins concluded.",
    });
    expect(freeSpinConclusionPresentation("100")).toEqual({
      visualText: "FREE SPINS CONCLUDED",
      accessibleText: "Free Spins concluded. 1.00 won.",
    });
  });
});

describe("Big Win information line", () => {
  it("projects IDS_MSG_CONGRATULATIONS and lets the next round state replace it", () => {
    expect(bigWinCongratulationsPresentation()).toEqual({
      visualText: "Congratulations!",
      accessibleText: "Congratulations!",
    });

    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const messageTitle = { textContent: "" };
    const messageSubtitle = { textContent: "" };
    const messageDetail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      messageTitle,
      messageSubtitle,
      messageDetail,
      roundState,
    });

    overlay.showBigWinCongratulations();
    expect(messageTitle.textContent).toBe("Congratulations!");
    expect(messageSubtitle.textContent).toBe("");
    expect(messageDetail.textContent).toBe("Congratulations!");
    expect(roundState.dataset.visible).toBe("true");

    overlay.setPhase("ready");
    expect(messageTitle.textContent).toBe("PRESS SPIN TO BEGIN");
    expect(messageDetail.textContent).toBe("Ready. Press spin to begin.");
  });
});

describe("post-Wheel master-win information line", () => {
  function createRoundStateHarness(): {
    overlay: DomOverlay;
    messageTitle: { textContent: string };
    messageSubtitle: { textContent: string };
    messageDetail: { textContent: string };
    roundState: { dataset: Record<string, string> };
  } {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const messageTitle = { textContent: "" };
    const messageSubtitle = { textContent: "" };
    const messageDetail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      messageTitle,
      messageSubtitle,
      messageDetail,
      roundState,
      currentRoundPhase: "booting",
      currentRoundFeatureState: undefined,
      heldWheelBonusRoundState: null,
      heldOrdinaryWinRoundState: null,
      resultPresentationSuppressesSpinCopy: false,
    });
    return { overlay, messageTitle, messageSubtitle, messageDetail, roundState };
  }

  it("formats the authoritative whole-round total and exposes both visible lines", () => {
    expect(wheelBonusRoundSummaryPresentation("1200")).toEqual({
      visualText: "WIN: 12.00",
      visualSecondaryText: "Congratulations!",
      accessibleText: "WIN: 12.00. Congratulations!",
      variant: "wheel-bonus",
    });
    expect(wheelBonusRoundSummaryPresentation("123456").visualText)
      .toBe("WIN: 1,234.56");
  });

  it("holds through presenting-to-ready and clears on the next requesting refresh", () => {
    const {
      overlay, messageTitle, messageSubtitle, messageDetail, roundState,
    } = createRoundStateHarness();

    overlay.setPhase("presenting");
    overlay.showWheelBonusRoundSummary("1200");
    overlay.setPhase("ready");

    expect(messageTitle.textContent).toBe("WIN: 12.00");
    expect(messageSubtitle.textContent).toBe("Congratulations!");
    expect(messageDetail.textContent).toContain("WIN: 12.00");
    expect(messageDetail.textContent).toContain("Congratulations!");
    expect(roundState.dataset).toMatchObject({
      visible: "true",
      variant: "wheel-bonus",
    });

    overlay.setPhase("requesting");
    expect(messageTitle.textContent).toBe("Good luck!");
    expect(messageSubtitle.textContent).toBe("");
    expect(messageDetail.textContent).toBe("Waiting for the server outcome.");
    expect(roundState.dataset.visible).toBe("true");
    expect(roundState.dataset).not.toHaveProperty("variant");
  });

  it("clears on recovery and replaces stale win copy with the persistent failure title", () => {
    const { overlay, messageTitle, roundState } = createRoundStateHarness();

    overlay.setPhase("ready");
    overlay.showWheelBonusRoundSummary("1200");
    overlay.clearWheelBonusRoundSummary();
    expect(messageTitle.textContent).toBe("PRESS SPIN TO BEGIN");
    expect(roundState.dataset).not.toHaveProperty("variant");

    overlay.showWheelBonusRoundSummary("1200");
    overlay.setPhase("recovering");
    expect(messageTitle.textContent).toBe("");
    expect(roundState.dataset).not.toHaveProperty("variant");

    overlay.showWheelBonusRoundSummary("1200");
    overlay.setPhase("failed");
    expect(messageTitle.textContent).toBe("SESSION UNAVAILABLE");
    expect(roundState.dataset.visible).toBe("true");
    expect(roundState.dataset).not.toHaveProperty("variant");
  });
});

describe("feature preview readiness", () => {
  it("keeps Continue disabled until session readiness and pending are both clear", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const previewContinue = {
      disabled: false,
      setAttribute: vi.fn(),
    };
    const featurePreview = { dataset: { visible: "true" } };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      previewContinue,
      featurePreview,
      featurePreviewEnabled: false,
      featurePreviewPending: false,
    });

    overlay.setFeaturePreviewPending(false);
    expect(previewContinue.disabled).toBe(true);

    overlay.setFeaturePreviewEnabled(true);
    expect(previewContinue.disabled).toBe(false);

    overlay.setFeaturePreviewPending(true);
    expect(previewContinue.disabled).toBe(true);
    overlay.setFeaturePreviewEnabled(false);
    overlay.setFeaturePreviewPending(false);
    expect(previewContinue.disabled).toBe(true);

    overlay.setFeaturePreviewEnabled(true);
    expect(previewContinue.disabled).toBe(false);
    expect(previewContinue.setAttribute).toHaveBeenCalledWith("aria-busy", "false");
  });
});

describe("feature state live region", () => {
  it.each([
    ["0", "99900", "EXPANSION · 8/8 complete · 0 remaining · 0.00 won", "999.00", "0.00"],
    ["100", "100000", "EXPANSION · 8/8 complete · 0 remaining · 1.00 won", "1000.00", "1.00"],
  ])("projects accepted terminal cumulative %s, then lets Base clear it", (
    cumulativeWinMinor,
    balanceMinor,
    expectedText,
    expectedBalance,
    expectedWin,
  ) => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const feature = {
      textContent: "EXPANSION · 7/8 complete · 1 remaining",
      dataset: { visible: "true", mode: "expansion" } as Record<string, string>,
    };
    const balance = { textContent: "" };
    const lastWin = { textContent: "" };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      feature,
      balance,
      lastWin,
      autoplayActive: false,
      winCounterAnimation: null,
    });

    const completion = {
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor,
    } as const;
    overlay.showFreeSpinsCompletedState(completion);
    expect(feature.textContent).toBe(expectedText);
    expect(feature.dataset).toEqual({ visible: "true", mode: "expansion" });

    const baseResult: SpinResult = {
      type: "spin.result",
      protocolVersion: 1,
      requestId: "request-terminal",
      sessionId: "session-1",
      roundId: "round-terminal",
      sequence: 9,
      betMinor: "100",
      chargedBetMinor: "0",
      balanceMinor,
      totalWinMinor: "0",
      grid: [],
      wins: [],
      events: [completion],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    };
    overlay.applyResult(baseResult);
    expect(feature.textContent).toBe("");
    expect(feature.dataset).toEqual({ visible: "false" });
    expect(balance.textContent).toBe(expectedBalance);
    expect(lastWin.textContent).toBe(expectedWin);
  });

  it("clears text, visibility, and mode when Expansion returns to BASE", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const feature = {
      textContent: "",
      dataset: {} as Record<string, string>,
    };
    Object.assign(overlay as unknown as Record<string, unknown>, { feature });
    const showFeatureState = (overlay as unknown as {
      showFeatureState(state: {
        mode: "BASE" | "EXPANSION";
        freeSpinsRemaining: number;
        freeSpinsPlayed?: number;
        freeSpinsWinMinor?: string;
      }): void;
    }).showFeatureState.bind(overlay);

    showFeatureState({
      mode: "EXPANSION",
      freeSpinsRemaining: 5,
      freeSpinsPlayed: 3,
      freeSpinsWinMinor: "1250",
    });
    expect(feature.textContent).toContain("EXPANSION");
    expect(feature.dataset).toMatchObject({ visible: "true", mode: "expansion" });

    showFeatureState({ mode: "BASE", freeSpinsRemaining: 0 });
    expect(feature.textContent).toBe("");
    expect(feature.dataset.visible).toBe("false");
    expect(feature.dataset).not.toHaveProperty("mode");
  });
});

describe("game control configuration", () => {
  it("keeps the captured evidence profile separate from the all-off runtime default", () => {
    expect(AUTO_PLAY_STOP_CONDITIONS).toEqual([
      { boundary: "any-win", setting: "anyWin", label: "On any win" },
      { boundary: "bonus", setting: "bonus", label: "If bonus game is won" },
      { boundary: "free-spins", setting: "freeSpins", label: "If free spins are won" },
      { boundary: "jackpot", setting: "jackpot", label: "If jackpot is won" },
    ]);
    expect(CAPTURED_AUTO_PLAY_STOP_SETTINGS).toEqual({
      anyWin: false,
      bonus: true,
      freeSpins: true,
      jackpot: true,
    });
    expect(DEFAULT_AUTO_PLAY_STOP_SETTINGS).toEqual({
      anyWin: false,
      bonus: false,
      freeSpins: false,
      jackpot: false,
    });

    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    expect(source).not.toContain('<select data-role="autoplay-stop-rule"');
    expect(source).toContain('data-autoplay-stop-boundary="${boundary}"');
    for (const { label } of AUTO_PLAY_STOP_CONDITIONS) expect(source).toContain(label);
  });

  it("persists a v2 matrix and makes legacy v1 records fall back to the runtime default", () => {
    const settings = { anyWin: true, bonus: false, freeSpins: true, jackpot: false };
    const serialized = serializeAutoPlayStopSettings(settings);
    expect(AUTO_PLAY_STOP_SETTINGS_STORAGE_VERSION).toBe(2);
    expect(AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY).toBe(
      "primal-rampage.autoplay-stop-settings.v2",
    );
    expect(JSON.parse(serialized)).toEqual({ version: 2, settings });
    expect(parseAutoPlayStopSettings(serialized)).toEqual(settings);
    expect(parseAutoPlayStopSettings("not-json")).toEqual(DEFAULT_AUTO_PLAY_STOP_SETTINGS);
    expect(parseAutoPlayStopSettings(JSON.stringify({ version: 99, settings })))
      .toEqual(DEFAULT_AUTO_PLAY_STOP_SETTINGS);
    expect(parseAutoPlayStopSettings(JSON.stringify({ version: 1, settings: { anyWin: true } })))
      .toEqual(DEFAULT_AUTO_PLAY_STOP_SETTINGS);
    expect(parseAutoPlayStopSettings(JSON.stringify({ version: 2, settings: { anyWin: true } })))
      .toEqual({ ...DEFAULT_AUTO_PLAY_STOP_SETTINGS, anyWin: true });
    expect(parseAutoPlayStopSettings(JSON.stringify(settings)))
      .toEqual(DEFAULT_AUTO_PLAY_STOP_SETTINGS);

    const setItem = vi.fn();
    persistAutoPlayStopSettings(settings, { getItem: () => null, setItem });
    expect(setItem).toHaveBeenCalledWith(AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY, serialized);
    expect(() => persistAutoPlayStopSettings(settings, {
      getItem: () => null,
      setItem: () => { throw new Error("blocked"); },
    })).not.toThrow();
  });

  it("stops once at the first enabled boundary and rejects stale round callbacks", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayStopSettings: { anyWin: true, bonus: true, freeSpins: true, jackpot: true },
      autoplayStopSessionId: "",
      armedAutoplayStopRound: null,
      completedAutoplayStopSequence: -1,
      stoppedAutoplayStopSequence: null,
      autoplayActive: true,
      stopAutoplay,
    });

    overlay.armAutoplayStopRound(autoplayStopResult(10));
    expect(overlay.reachAutoplayStopBoundary(10, "any-win")).toBe(true);
    expect(overlay.reachAutoplayStopBoundary(10, "bonus")).toBe(true);
    expect(overlay.reachAutoplayStopBoundary(10, "jackpot")).toBe(true);
    expect(stopAutoplay).toHaveBeenCalledTimes(1);
    expect(overlay.completeAutoplayStopRound(10)).toBe(true);

    Object.assign(overlay as unknown as Record<string, unknown>, { autoplayActive: true });
    overlay.armAutoplayStopRound(autoplayStopResult(11));
    expect(overlay.reachAutoplayStopBoundary(10, "bonus")).toBe(false);
    expect(stopAutoplay).toHaveBeenCalledTimes(1);
    expect(overlay.reachAutoplayStopBoundary(11, "free-spins")).toBe(true);
    expect(stopAutoplay).toHaveBeenCalledTimes(2);
  });

  it("keeps disabled boundaries independent and never treats a zero result as any win", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayStopSettings: { anyWin: true, bonus: false, freeSpins: false, jackpot: false },
      autoplayStopSessionId: "",
      armedAutoplayStopRound: null,
      completedAutoplayStopSequence: -1,
      stoppedAutoplayStopSequence: null,
      autoplayActive: true,
      stopAutoplay,
    });

    overlay.armAutoplayStopRound(autoplayStopResult(20, "0"));
    expect(overlay.reachAutoplayStopBoundary(20, "any-win")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(20, "bonus")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(20, "free-spins")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(20, "jackpot")).toBe(false);
    expect(overlay.completeAutoplayStopRound(20)).toBe(false);
    expect(stopAutoplay).not.toHaveBeenCalled();

    overlay.armAutoplayStopRound(autoplayStopResult(21, "1"));
    // 如果装饰性演出失败导致跳过 Win Start，回合完成时仍会计算已经生效的
    // 权威正向结果。
    expect(overlay.completeAutoplayStopRound(21)).toBe(true);
    expect(stopAutoplay).toHaveBeenCalledOnce();
  });

  it("does not stop at any feature or win boundary with the all-off runtime default", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayStopSettings: { ...DEFAULT_AUTO_PLAY_STOP_SETTINGS },
      autoplayStopSessionId: "",
      armedAutoplayStopRound: null,
      completedAutoplayStopSequence: -1,
      stoppedAutoplayStopSequence: null,
      autoplayActive: true,
      stopAutoplay,
    });

    overlay.armAutoplayStopRound(autoplayStopResult(22, "100"));
    expect(overlay.reachAutoplayStopBoundary(22, "any-win")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(22, "bonus")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(22, "free-spins")).toBe(false);
    expect(overlay.reachAutoplayStopBoundary(22, "jackpot")).toBe(false);
    expect(overlay.completeAutoplayStopRound(22)).toBe(false);
    expect(stopAutoplay).not.toHaveBeenCalled();
  });

  it("uses the captured autoplay choices with 50 selected initially", () => {
    expect(AUTO_PLAY_SPIN_COUNTS).toEqual([10, 20, 50, 75, 100]);
    expect(DEFAULT_AUTO_PLAY_SPINS).toBe(50);
  });

  it("advances only while ready and ends after the final delegated spin", () => {
    expect(advanceAutoPlay({ active: true, remaining: 2 }, false)).toEqual({
      dispatchSpin: false,
      state: { active: true, remaining: 2 },
    });
    expect(advanceAutoPlay({ active: true, remaining: 2 }, true)).toEqual({
      dispatchSpin: true,
      state: { active: true, remaining: 1 },
    });
    expect(advanceAutoPlay({ active: true, remaining: 1 }, true)).toEqual({
      dispatchSpin: true,
      state: { active: false, remaining: 0 },
    });
  });

  it("commits the counter only after an accepted paid Base round", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const syncAutoplayControl = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      autoplayRemaining: 3,
      syncAutoplayControl,
    });

    overlay.commitAcceptedPaidAutoplaySpin();

    expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(true);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(2);
    expect(syncAutoplayControl).toHaveBeenCalledTimes(1);
  });

  it("round-trips the 100-spin reservation until an authoritative result finalizes it", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const syncAutoplayControl = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      autoplayRemaining: 100,
      autoplayRunGeneration: 4,
      pendingPaidAutoplaySpin: null,
      syncAutoplayControl,
    });

    overlay.commitAcceptedPaidAutoplaySpin();
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(99);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(true);
    expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(true);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(100);

    overlay.commitAcceptedPaidAutoplaySpin();
    expect(overlay.finalizeAcceptedPaidAutoplaySpin()).toBe(true);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(false);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(99);
    expect(syncAutoplayControl).toHaveBeenCalledTimes(3);
  });

  it("restores the final 1-to-0 reservation but never revives a manually stopped run", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const syncAutoplayControl = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      autoplayRemaining: 1,
      autoplayRunGeneration: 9,
      pendingPaidAutoplaySpin: null,
      autoplayTimer: null,
      autoplayModal: { dataset: { open: "false" } },
      syncAutoplayControl,
    });

    overlay.commitAcceptedPaidAutoplaySpin();
    expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(false);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(0);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(true);
    expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(true);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(1);

    overlay.commitAcceptedPaidAutoplaySpin();
    (overlay as unknown as { stopAutoplay(restoreFocus: boolean): void }).stopAutoplay(false);
    expect(overlay.rollbackAcceptedPaidAutoplaySpin()).toBe(false);
    expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(false);
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(0);
  });

  it("releases the Free Spins Continue gate during Auto Play without spending its remaining count", () => {
    vi.useFakeTimers();
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      const spinHandler = vi.fn();
      Object.assign(overlay as unknown as Record<string, unknown>, {
        autoplayActive: true,
        autoplayRemaining: 49,
        autoplayTimer: null,
        canSpin: false,
        spinMode: "feature-continue",
        fastPlay: false,
        spinHandler,
        gameMenu: { dataset: { open: "false" } },
        autoplayModal: { dataset: { open: "false" } },
        betPopup: { dataset: { open: "false" } },
      });

      (overlay as unknown as { queueAutoplaySpin(): void }).queueAutoplaySpin();
      vi.advanceTimersByTime(PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS - 1);
      expect(spinHandler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(spinHandler).toHaveBeenCalledTimes(1);
      expect((overlay as unknown as Record<string, unknown>).autoplayActive).toBe(true);
      expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a manual Free Spins Continue consume the gate without stopping Auto Play", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const clearAutoplayTimer = vi.fn();
    const spinHandler = vi.fn();
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      autoplayRemaining: 49,
      spinMode: "feature-continue",
      clearAutoplayTimer,
      spinHandler,
      stopAutoplay,
    });

    (overlay as unknown as { handlePrimarySpinAction(): void }).handlePrimarySpinAction();

    expect(clearAutoplayTimer).toHaveBeenCalledTimes(1);
    expect(spinHandler).toHaveBeenCalledTimes(1);
    expect(stopAutoplay).not.toHaveBeenCalled();
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
  });

  it("does not release a stale Auto Play Free Spins gate after the state changes", () => {
    vi.useFakeTimers();
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      const spinHandler = vi.fn();
      Object.assign(overlay as unknown as Record<string, unknown>, {
        autoplayActive: true,
        autoplayRemaining: 49,
        autoplayTimer: null,
        canSpin: false,
        spinMode: "feature-continue",
        fastPlay: false,
        spinHandler,
        gameMenu: { dataset: { open: "false" } },
        autoplayModal: { dataset: { open: "false" } },
        betPopup: { dataset: { open: "false" } },
      });

      (overlay as unknown as { queueAutoplaySpin(): void }).queueAutoplaySpin();
      (overlay as unknown as Record<string, unknown>).spinMode = "waiting";
      vi.advanceTimersByTime(PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS);

      expect(spinHandler).not.toHaveBeenCalled();
      expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the captured forty-tick delay for retained Auto Play at Wheel Ready", () => {
    vi.useFakeTimers();
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      const spinHandler = vi.fn();
      Object.assign(overlay as unknown as Record<string, unknown>, {
        autoplayActive: true,
        autoplayRemaining: 49,
        autoplayTimer: null,
        canSpin: false,
        spinMode: "wheel-ready",
        spinHandler,
        gameMenu: { dataset: { open: "false" } },
        autoplayModal: { dataset: { open: "false" } },
        betPopup: { dataset: { open: "false" } },
      });

      (overlay as unknown as { queueAutoplaySpin(): void }).queueAutoplaySpin();
      vi.advanceTimersByTime(PRIMAL_AUTOPLAY_BONUS_DELAY_MS - 1);
      expect(spinHandler).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(spinHandler).toHaveBeenCalledTimes(1);
      expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets the paid Auto Play timer race the Free Spin scheduler", () => {
    vi.useFakeTimers();
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      const spinHandler = vi.fn();
      Object.assign(overlay as unknown as Record<string, unknown>, {
        autoplayActive: true,
        autoplayRemaining: 49,
        autoplayPaidSpinEligible: false,
        autoplayTimer: null,
        canSpin: true,
        spinMode: "ready",
        fastPlay: true,
        spinHandler,
        gameMenu: { dataset: { open: "false" } },
        autoplayModal: { dataset: { open: "false" } },
        betPopup: { dataset: { open: "false" } },
      });

      (overlay as unknown as { queueAutoplaySpin(): void }).queueAutoplaySpin();
      vi.advanceTimersByTime(1_000);

      expect(spinHandler).not.toHaveBeenCalled();
      expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives retained Auto Play feature inputs to the Wheel instead of Stop", () => {
    expect(isAutoplayFeatureOwnedSpinMode("wheel-ready")).toBe(true);
    expect(isAutoplayFeatureOwnedSpinMode("wheel-summary-continue")).toBe(true);
    expect(isAutoplayFeatureOwnedSpinMode("ready")).toBe(false);
    expect(autoplayFeatureInputDelay("feature-continue")).toBe(PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS);
    expect(autoplayFeatureInputDelay("wheel-ready")).toBe(PRIMAL_AUTOPLAY_BONUS_DELAY_MS);
    expect(autoplayFeatureInputDelay("wheel-summary-continue")).toBeNull();

    expect(primarySpinControlPresentation("wheel-ready", false, {
      active: true,
      remaining: 49,
    })).toEqual({
      dataMode: "ready",
      action: "wheel-spin",
      visualToken: "spin",
      ariaLabel: "Spin Primal Wheel",
      text: "Spin",
      disabled: false,
      remainingText: "",
    });

    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const clearAutoplayTimer = vi.fn();
    const spinHandler = vi.fn();
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      autoplayRemaining: 49,
      canSpin: false,
      spinMode: "wheel-ready",
      clearAutoplayTimer,
      spinHandler,
      stopAutoplay,
    });

    (overlay as unknown as { handlePrimarySpinAction(): void }).handlePrimarySpinAction();

    expect(clearAutoplayTimer).toHaveBeenCalledTimes(1);
    expect(spinHandler).toHaveBeenCalledTimes(1);
    expect(stopAutoplay).not.toHaveBeenCalled();
    expect((overlay as unknown as Record<string, unknown>).autoplayRemaining).toBe(49);
  });

  it("keeps the orange active Auto Play control as a stop outside its Free Spins Continue gate", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const stopAutoplay = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: true,
      spinMode: "ready",
      stopAutoplay,
    });

    (overlay as unknown as { handlePrimarySpinAction(): void }).handlePrimarySpinAction();

    expect(stopAutoplay).toHaveBeenCalledWith(false);
  });

  it("replaces the primary spinner with the official Auto Play stop/count composite", () => {
    expect(primarySpinControlPresentation("ready", true, {
      active: false,
      remaining: 0,
    })).toEqual({
      dataMode: "ready",
      action: "spin",
      visualToken: "spin",
      ariaLabel: "Spin reels",
      text: "Spin",
      disabled: false,
      remainingText: "",
    });

    // 官方首次激活画面的捕获值为 99：所选次数在 ROUNDSTART 时递减，
    // 而不是在打开 Auto Play 模态框时递减。
    expect(primarySpinControlPresentation("fast-stop", false, {
      active: true,
      remaining: 99,
    })).toEqual({
      dataMode: "continue",
      action: "autoplay-stop",
      visualToken: "autoplay-stop",
      ariaLabel: "Stop autoplay. 99 spins remaining.",
      text: "Stop",
      disabled: false,
      remainingText: "99",
    });
  });

  it("projects an active count onto the primary button and restores the normal gate when stopped", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const spin = {
      disabled: true,
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
    };
    const spinText = { textContent: "" };
    const spinAutoplayCount = { textContent: "" };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      spin,
      spinText,
      spinAutoplayCount,
      spinMode: "fast-stop",
      canSpin: false,
      autoplayActive: true,
      autoplayRemaining: 99,
    });
    const syncSpinControl = (overlay as unknown as { syncSpinControl(): void }).syncSpinControl.bind(overlay);

    syncSpinControl();
    expect(spin).toMatchObject({ disabled: false });
    expect(spin.dataset).toMatchObject({
      mode: "continue",
      action: "autoplay-stop",
      visualToken: "autoplay-stop",
      autoplayActive: "true",
      autoplayRemaining: "99",
    });
    expect(spinAutoplayCount.textContent).toBe("99");
    expect(spin.setAttribute).toHaveBeenLastCalledWith("aria-label", "Stop autoplay. 99 spins remaining.");

    Object.assign(overlay as unknown as Record<string, unknown>, {
      autoplayActive: false,
      autoplayRemaining: 0,
    });
    syncSpinControl();
    expect(spin).toMatchObject({ disabled: false });
    expect(spin.dataset).toMatchObject({
      action: "fast-stop",
      visualToken: "continue",
      autoplayActive: "false",
      autoplayRemaining: "",
    });
    expect(spinAutoplayCount.textContent).toBe("");
  });

  it("mounts the captured orange asset on the primary control and removes the obsolete utility badge", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    const pass59 = css.slice(css.indexOf(
      '.game-frame[data-channel="desktop"] .spin-button__autoplay-stop,',
    ));

    expect(source).toContain('class="spin-button__autoplay-stop" data-role="spin-autoplay-stop"');
    expect(source).toContain('src="${PRIMAL_REFERENCE_ROOT}/10004.svg"');
    expect(source).toContain('data-role="spin-autoplay-count"');
    expect(source).toContain('this.autoplayButton.dataset.remaining = "";');
    expect(source).toMatch(/if \(this\.autoplayActive\) \{[\s\S]*?this\.stopAutoplay\(false\);[\s\S]*?return;/);
    expect(pass59).toContain('width: 27.2px;');
    expect(pass59).toContain('font-size: 17.2px;');
    expect(pass59).toMatch(/\.spin-button\[data-visual-token="autoplay-stop"\] \.spin-button__autoplay-stop\s*\{\s*display: block;/);
    expect(pass59).toMatch(/\.utility-button--auto\[data-active="true"\]::before\s*\{\s*display: none;/);
  });

  it("lists every supplied Wild multiplier without inventing artwork", () => {
    expect(PAYTABLE_WILD_ENTRIES.map(({ label }) => label)).toEqual([
      "X100", "X50", "X25", "X10", "X5", "X3", "X2", "WILD",
    ]);
    expect(new Set(PAYTABLE_WILD_ENTRIES.map(({ asset }) => asset)).size).toBe(8);
  });

  it("publishes the captured Base Ways paytable in ascending award order", () => {
    expect(BASE_PAYTABLE_ENTRIES.map(({ symbol, label, multiplier }) => ({
      symbol, label, multiplier,
    }))).toEqual([
      { symbol: "PRISM", label: "Q", multiplier: 0.1 },
      { symbol: "ORBIT", label: "K", multiplier: 0.3 },
      { symbol: "PULSE", label: "Helmet", multiplier: 0.8 },
      { symbol: "NOVA", label: "Radio", multiplier: 1 },
      { symbol: "TANK", label: "Tank", multiplier: 1.5 },
      { symbol: "CIRCUIT", label: "Jet", multiplier: 2 },
    ]);
  });

  it("uses the exact official Way Wins description instead of a derived payline claim", () => {
    expect(PRIMAL_WAY_WINS_COPY).toBe(
      "Way Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols.",
    );
  });
});

describe("captured desktop HUD geometry", () => {
  it("describes the final 24px footer and authored info-line projection", () => {
    const { stageScale, statusbar, infoLine } = PRIMAL_DESKTOP_UI_GEOMETRY;

    expect(stageScale).toBe(0.8);
    expect(statusbar.height).toBe(24);
    expect(statusbar.fontSize).toBe(14.4);
    expect(statusbar.gameNameFontSize).toBe(8);
    expect(statusbar.atlasWidth).toBe(1_865);
    expect(statusbar.atlasHeight).toBe(60);

    expect(infoLine.centerX).toBeCloseTo(infoLine.sourceCenterX * stageScale, 10);
    expect(infoLine.centerY).toBeCloseTo(infoLine.sourceCenterY * stageScale, 10);
    expect(infoLine.width).toBe(infoLine.sourceWidth * stageScale);
    expect(infoLine.height).toBe(infoLine.sourceHeight * stageScale);
    expect(infoLine.fontSize).toBe(infoLine.sourceFontSize * stageScale);
    expect(infoLine.fontFamily).toBe("Primal Roboto Condensed");
    expect(infoLine.fontWeight).toBe(700);
    expect(infoLine.stroke).toBe(infoLine.sourceStroke * stageScale);
  });

  it("keeps final prompt/control typography, shared utility capsule, and transparent hit seams", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    const finalCascade = css.slice(css.indexOf("/* 最终级联：捕获的状态栏"));
    const pass18 = css.slice(css.indexOf(".utility-dock {\n  bottom: 25px;"));
    const dockRule = pass18.match(/\.utility-dock\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const childRule = pass18.match(/\.utility-button,\s*\.bet-trigger\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    const assetRule = pass18.match(
      /\.utility-button__asset,[\s\S]*?\.bet-trigger__icon\s*\{([\s\S]*?)\}/,
    )?.[1] ?? "";
    const px = (rule: string, property: string): number => {
      const value = rule.match(new RegExp(`(?:^|\\n)\\s*${property}:\\s*([0-9.]+)px;`))?.[1];
      if (value === undefined) throw new Error(`Missing ${property} in CSS rule`);
      return Number(value);
    };

    expect(finalCascade).toContain('font-family: "Primal Roboto Condensed", "Arial Narrow", sans-serif;');
    expect(finalCascade).toContain("font-size: 24px;");
    expect(finalCascade).toContain("-webkit-text-stroke: 4px #000;");
    expect(finalCascade).toContain('.round-state[data-variant="wheel-bonus"]');
    expect(finalCascade).toContain("top: 597px;");
    expect(finalCascade).toContain("font-size: 18px;");
    expect(finalCascade).toContain("line-height: 22px;");
    expect(finalCascade).toContain("font-size: 14px;");
    expect(finalCascade).toContain("line-height: 16px;");
    expect(finalCascade).toContain("width: 97px;");
    expect(finalCascade).toContain("height: 97px;");
    expect(dockRule).toContain("width: 227px;");
    expect(dockRule).toContain("height: 43px;");
    expect(dockRule).toContain("bottom: 25px;");
    expect(dockRule).toContain("gap: 9px;");
    expect(dockRule).toContain("padding: 4px 8px;");
    expect(dockRule).toContain("border-radius: 999px;");
    expect(dockRule).toMatch(/background:\s*rgba\([^;]+\);/);
    expect(dockRule).not.toContain("background: transparent;");

    expect(childRule).toContain("width: 35px;");
    expect(childRule).toContain("height: 35px;");
    expect(childRule).toContain("flex: 0 0 35px;");
    expect(childRule).toContain("border: 0;");
    expect(childRule).toContain("background: transparent;");
    expect(childRule).toContain("box-shadow: none;");
    expect(childRule).toContain("backdrop-filter: none;");
    expect(assetRule).toContain("filter: none;");
    expect(pass18).toMatch(/\.utility-button::after\s*\{\s*display: none;/);
    expect(pass18).toMatch(/\.utility-button:not\(:disabled\):hover,[\s\S]*?box-shadow: none;/);

    const dockWidth = px(dockRule, "width");
    const dockHeight = px(dockRule, "height");
    const dockBottom = px(dockRule, "bottom");
    const gap = px(dockRule, "gap");
    const childWidth = px(childRule, "width");
    const horizontalPadding = 8;
    const verticalPadding = 4;
    expect(horizontalPadding * 2 + childWidth * 5 + gap * 4).toBe(dockWidth);
    expect(verticalPadding * 2 + px(childRule, "height")).toBe(dockHeight);

    const dockLeft = (1_280 - dockWidth) / 2;
    const centers = Array.from({ length: 5 }, (_, index) => (
      dockLeft + horizontalPadding + childWidth / 2 + index * (childWidth + gap)
    ));
    expect(centers).toEqual([552, 596, 640, 684, 728]);
    expect(720 - dockBottom - dockHeight).toBe(652);
    expect(720 - dockBottom - dockHeight / 2).toBe(673.5);

    expect(finalCascade).toContain("width: var(--utility-hit-size, 35px);");
    expect(finalCascade).toContain(
      "--utility-hit-trim: max(0px, calc((var(--utility-hit-size, 35px) - 44px) / 2));",
    );
    expect(finalCascade).toContain(
      "clip-path: inset(0 var(--utility-hit-trim) 0 var(--utility-hit-trim));",
    );
    expect(finalCascade).toMatch(
      /\.utility-button--settings > \.utility-button__hit-area\s*\{\s*clip-path: inset\(0 var\(--utility-hit-trim\) 0 0\);/,
    );
    expect(finalCascade).toMatch(
      /\.utility-button--sound > \.utility-button__hit-area\s*\{\s*clip-path: inset\(0 0 0 var\(--utility-hit-trim\)\);/,
    );
    expect(finalCascade).toContain("width: var(--spin-hit-size, 97px);");
    expect(finalCascade).toMatch(
      /(?:^|\n)\.status-metric--win\s*\{[^}]*\bright:\s*34px;/,
    );
    expect(finalCascade).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel\[data-zero-win="true"\] \.status-metric--win\s*\{\s*right: 34px;/,
    );
    expect(finalCascade).toMatch(
      /\.status-panel\[data-game-name-visible="true"\] \.status-panel__game\s*\{\s*display: block;/,
    );
    expect(finalCascade).toMatch(
      /\.game-frame:not\(\[data-channel="mobile"\]\) \.status-panel\[data-game-name-visible="true"\] \.status-metric--win\s*\{\s*right: 66px;/,
    );
    expect(finalCascade).toMatch(
      /\.game-frame\[data-channel="mobile"\]\[data-mobile-layout="ls"\] \.status-metric--win\s*\{[^}]*right:\s*var\(--mobile-status-win-right, 8\.5%\);/,
    );
    expect(finalCascade).toMatch(
      /\.game-frame\[data-channel="mobile"\]:not\(\[data-mobile-layout="ls"\]\) \.status-metric--win\s*\{[^}]*right:\s*max\(env\(safe-area-inset-right, 0px\), 12px\);/,
    );
    expect(finalCascade).not.toMatch(
      /\.status-panel\[data-zero-win="true"\] \.status-panel__game/,
    );
    const statusMarkup = source.match(
      /<section\s+class="status-panel"[\s\S]*?<\/section>/,
    )?.[0] ?? "";
    expect(statusMarkup.match(/status-panel__provider/g)).toHaveLength(1);
    expect(statusMarkup).toContain('src="${STATUSBAR_GM_GO}"');
    expect(statusMarkup).toContain('alt="G\'m GO"');
    expect(statusMarkup).toContain('data-game-name-visible="false"');
    expect(statusMarkup).toContain('class="status-panel__game">Primal Rampage</span>');
    expect(source.match(/class="utility-button__hit-area"/g)).toHaveLength(5);
    expect(source.match(/class="spin-button__hit-area"/g)).toHaveLength(1);

    const utilityMarkup = source.match(
      /<nav class="utility-dock"[\s\S]*?<\/nav>/,
    )?.[0] ?? "";
    expect([
      ...utilityMarkup.matchAll(/<(?:button|select)\b[^>]*data-role="([^"]+)"/g),
    ].map((match) => match[1])).toEqual([
      "settings",
      "autoplay",
      "bet-trigger",
      "bet",
      "paytable",
      "sound",
    ]);

    // 可见中心点保持捕获到的 44px 间距。移动端直径超过该间距时，CSS 中点裁剪
    // 会生成五条互不相交的 Voronoi 条带，同时保留完整的外侧触达范围。
    for (const utilityHitLogicalSize of [35, 124.6523076923, 112.1870769231]) {
      const trim = Math.max(0, (utilityHitLogicalSize - 44) / 2);
      const regions = centers.map((center, index) => ({
        left: center - utilityHitLogicalSize / 2 + (index === 0 ? 0 : trim),
        right: center + utilityHitLogicalSize / 2 - (index === 4 ? 0 : trim),
        center,
      }));
      for (const region of regions) {
        expect(region.left).toBeLessThanOrEqual(region.center);
        expect(region.right).toBeGreaterThanOrEqual(region.center);
      }
      for (let index = 1; index < regions.length; index += 1) {
        expect(regions[index - 1]?.right).toBeLessThanOrEqual(regions[index]?.left ?? 0);
      }
    }
  });
});

describe("original round-state call to action", () => {
  it("shows only PRESS SPIN TO BEGIN while ready", () => {
    expect(roundStatePresentation("ready")).toEqual({
      visualText: "PRESS SPIN TO BEGIN",
      accessibleText: "Ready. Press spin to begin.",
    });
    expect(roundStatePresentation("ready", {
      mode: "EXPANSION",
      freeSpinsRemaining: 4,
      rageLevel: 0,
      rageCollected: 0,
    })).toEqual({
      visualText: "PRESS SPIN TO BEGIN",
      accessibleText: "Ready. 4 free spins remaining.",
    });
  });

  it("keeps Good luck visible through request/result receipt and a failed state persistent", () => {
    expect(roundStatePresentation("requesting").visualText).toBe("Good luck!");
    expect(roundStatePresentation("presenting").visualText).toBe("Good luck!");
    for (const phase of [
      "booting", "connecting", "recovering",
    ] as const) {
      const presentation = roundStatePresentation(phase);
      expect(presentation.visualText).toBe("");
      expect(presentation.accessibleText.length).toBeGreaterThan(0);
    }
    expect(roundStatePresentation("failed")).toEqual({
      visualText: "SESSION UNAVAILABLE",
      accessibleText: "Game unavailable. Please try again or follow your operator's session instructions.",
    });
  });

  it("keeps failed launch status visible after its transient error toast has gone", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const messageTitle = { textContent: "" };
    const messageSubtitle = { textContent: "" };
    const messageDetail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    Object.assign(overlay, { messageTitle, messageSubtitle, messageDetail, roundState });

    overlay.setLaunchStatus("failed");

    expect(messageTitle.textContent).toBe("SESSION UNAVAILABLE");
    expect(messageDetail.textContent)
      .toBe("Launch unavailable. Please try again or follow your operator's session instructions.");
    expect(roundState.dataset.visible).toBe("true");
  });

  it("uses the exact non-repeating original Base spin-text carousel", () => {
    expect(PRIMAL_BASE_SPIN_MESSAGES).toEqual([
      "Good luck!",
      "Wild can land on reel 2.",
      "Vault Bonus can land on reel 2.",
      "Rage Symbols can land on any reel in the Base Game.",
      "Land 3 Rage Symbols to trigger the Primal Wheel!",
      "Kong Quest can only trigger from the Primal Wheel!",
      "King Spin can only trigger from the Primal Wheel!",
      "The Ape unlocks the Vault Bonus!",
    ]);
    expect(selectPrimalBaseSpinMessage(-1, 0.99)).toEqual({ index: 0, text: "Good luck!" });
    expect(selectPrimalBaseSpinMessage(0, 0)).toEqual({
      index: 1,
      text: "Wild can land on reel 2.",
    });
    expect(selectPrimalBaseSpinMessage(6, 0.999_999)).toEqual({
      index: 7,
      text: "The Ape unlocks the Vault Bonus!",
    });
  });

  it("supports a one-shot allow-listed capture message without changing the pool", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const messageTitle = { textContent: "" };
    const messageSubtitle = { textContent: "" };
    const messageDetail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      messageTitle,
      messageSubtitle,
      messageDetail,
      roundState,
      currentRoundPhase: "ready",
      currentRoundFeatureState: undefined,
      heldWheelBonusRoundState: null,
      heldOrdinaryWinRoundState: null,
      resultPresentationSuppressesSpinCopy: false,
      lastSpinTextIndex: -1,
      activeSpinMessage: "Good luck!",
      nextSpinMessageCaptureOverride: null,
    });

    expect(overlay.prepareSpinMessageCapture("not-authorized")).toBe(false);
    expect(overlay.prepareSpinMessageCapture("The Ape unlocks the Vault Bonus!")).toBe(true);
    overlay.setPhase("requesting");
    expect(messageTitle.textContent).toBe("The Ape unlocks the Vault Bonus!");
    overlay.setPhase("presenting");
    expect(messageTitle.textContent).toBe("The Ape unlocks the Vault Bonus!");
    overlay.clearTransientSpinMessage();
    expect(messageTitle.textContent).toBe("");
    expect(roundState.dataset.visible).toBe("false");
  });
});

describe("ordinary-win information-line state machine", () => {
  function createHarness(): {
    overlay: DomOverlay;
    title: { textContent: string };
    subtitle: { textContent: string };
    detail: { textContent: string };
    roundState: { dataset: Record<string, string> };
    lastWin: { textContent: string; dataset: Record<string, string> };
    statusPanel: { dataset: Record<string, string> };
  } {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const title = { textContent: "" };
    const subtitle = { textContent: "" };
    const detail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    const lastWin = { textContent: "", dataset: {} as Record<string, string> };
    const statusPanel = {
      dataset: { zeroWin: "true", gameNameVisible: "false" } as Record<string, string>,
    };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      messageTitle: title,
      messageSubtitle: subtitle,
      messageDetail: detail,
      roundState,
      lastWin,
      statusPanel,
      currentRoundPhase: "ready",
      currentRoundFeatureState: undefined,
      heldWheelBonusRoundState: null,
      heldOrdinaryWinRoundState: null,
      resultPresentationSuppressesSpinCopy: false,
      winCounterAnimation: null,
    });
    return { overlay, title, subtitle, detail, roundState, lastWin, statusPanel };
  }

  it("shows the separate GameName only for a settled zero-win Base ready state", () => {
    const { overlay, lastWin, statusPanel } = createHarness();
    const baseIdle: FeatureState = {
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    };
    overlay.setPhase("ready", baseIdle);
    overlay.resetWinCounter("0");
    expect(lastWin).toEqual({ textContent: "0.00", dataset: { zero: "true" } });
    expect(statusPanel.dataset).toEqual({ zeroWin: "true", gameNameVisible: "true" });

    overlay.resetWinCounter("125");
    expect(lastWin).toEqual({ textContent: "1.25", dataset: { zero: "false" } });
    expect(statusPanel.dataset).toEqual({ zeroWin: "false", gameNameVisible: "false" });

    overlay.resetWinCounter("0");
    expect(lastWin).toEqual({ textContent: "0.00", dataset: { zero: "true" } });
    expect(statusPanel.dataset).toEqual({ zeroWin: "true", gameNameVisible: "true" });

    for (const phase of ["requesting", "presenting", "recovering", "failed"] as const) {
      overlay.setPhase(phase, baseIdle);
      expect(statusPanel.dataset.gameNameVisible).toBe("false");
    }

    for (const mode of ["EXPANSION", "OVERDRIVE"] as const) {
      overlay.setPhase("ready", { ...baseIdle, mode, freeSpinsRemaining: 3 });
      expect(statusPanel.dataset.gameNameVisible).toBe("false");
    }

    overlay.setPhase("ready", { ...baseIdle, freeSpinsRemaining: 1 });
    expect(statusPanel.dataset.gameNameVisible).toBe("false");

    overlay.setPhase("ready", baseIdle);
    expect(statusPanel.dataset.gameNameVisible).toBe("true");
  });

  it("projects counting/settled copy only for a positive authoritative total", () => {
    expect(ordinaryWinInformationPresentation("counting", "219", "240")).toEqual({
      visualText: "WIN: 2.19",
      accessibleText: "WIN: 2.19",
      variant: "win-counting",
    });
    expect(ordinaryWinInformationPresentation("settled", "219", "240")).toEqual({
      visualText: "WIN: 2.40",
      visualSecondaryText: "Congratulations!",
      accessibleText: "WIN: 2.40. Congratulations!",
      variant: "win-settled",
    });
    expect(ordinaryWinInformationPresentation("settled", "0", "0")).toBeNull();
    expect(ordinaryWinInformationPresentation("counting", "241", "240")).toBeNull();
    expect(ordinaryWinInformationPresentation("counting", "2.19", "240")).toBeNull();
  });

  it("counts a late first RAF from the synchronous call clock and settles at call time plus duration", async () => {
    let callback: FrameRequestCallback | null = null;
    let handle = 0;
    const callTime = 10_000;
    const now = vi.fn(() => callTime);
    vi.stubGlobal("performance", { now });
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => {
      callback = next;
      handle += 1;
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      const { overlay, title, subtitle, roundState, lastWin } = createHarness();
      const presentation = overlay.presentWinCounter("240", 1_000, "0");
      expect(now).toHaveBeenCalledTimes(1);
      expect(title.textContent).toBe("WIN: 0.00");
      expect(lastWin.textContent).toBe("0.00");
      expect(roundState.dataset.variant).toBe("win-counting");

      const runFrame = (time: number): void => {
        const frame = callback;
        callback = null;
        if (!frame) throw new Error("Expected a pending counter frame");
        frame(time);
      };
      runFrame(callTime + 250);
      expect(title.textContent).toBe("WIN: 0.60");
      expect(lastWin.textContent).toBe("0.60");

      runFrame(callTime + 500);
      expect(title.textContent).toBe("WIN: 1.20");
      expect(lastWin.textContent).toBe("1.20");
      expect(subtitle.textContent).toBe("");

      runFrame(callTime + 1_000);
      await presentation;
      expect(title.textContent).toBe("WIN: 2.40");
      expect(lastWin.textContent).toBe("2.40");
      expect(subtitle.textContent).toBe("Congratulations!");
      expect(roundState.dataset.variant).toBe("win-settled");

      overlay.setPhase("ready");
      expect(title.textContent).toBe("WIN: 2.40");
      overlay.setPhase("requesting");
      expect(title.textContent).toBe("Good luck!");
      expect(roundState.dataset).not.toHaveProperty("variant");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears Good luck at a settled zero-win result and never overwrites Wheel ownership", () => {
    const { overlay, title, roundState } = createHarness();
    overlay.setPhase("requesting");
    overlay.setPhase("presenting");
    expect(title.textContent).toBe("Good luck!");
    overlay.beginResultPresentation(false);
    expect(title.textContent).toBe("");
    expect(roundState.dataset.visible).toBe("false");

    overlay.showWheelBonusRoundSummary("1200");
    void overlay.presentWinCounter("240", 0, "0");
    expect(title.textContent).toBe("WIN: 12.00");
    expect(roundState.dataset.variant).toBe("wheel-bonus");
  });

  it("ships distinct counting and settled CSS variants", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toContain('.round-state[data-variant="win-counting"]');
    expect(css).toContain('.round-state[data-variant="win-settled"]');
    expect(css).toMatch(/\.round-state__title\s*\{[^}]*text-transform:\s*none;/s);
  });
});

describe("compact bet ticker", () => {
  const options = ["100", "200", "500", "1000", "2000"] as const;

  it("shows only the selected wager and its immediate neighbours", () => {
    expect(betTickerWindow(options, "500")).toEqual(["200", "500", "1000"]);
  });

  it("does not invent wraparound values at either boundary", () => {
    expect(betTickerWindow(options, "100")).toEqual(["100", "200"]);
    expect(betTickerWindow(options, "2000")).toEqual(["1000", "2000"]);
  });

  it("renders no choice for a value outside the server option list", () => {
    expect(betTickerWindow(options, "300")).toEqual([]);
  });
});

describe("wager-scaled prize pools", () => {
  it("scales every displayed tier from integer minor units", () => {
    expect(jackpotValuesForBet("100")).toEqual([
      "100000", "25000", "7500", "3000", "1000",
    ]);
    expect(jackpotValuesForBet("250")).toEqual([
      "250000", "62500", "18750", "7500", "2500",
    ]);
  });

  it("fails closed for non-canonical monetary input", () => {
    expect(jackpotValuesForBet("1.00")).toEqual(["0", "0", "0", "0", "0"]);
    expect(jackpotValuesForBet("-100")).toEqual(["0", "0", "0", "0", "0"]);
  });
});

describe("primary spin control modes", () => {
  it("gates ready and waiting states but keeps fast-stop actionable", () => {
    expect(spinModeDisabled("ready", true)).toBe(false);
    expect(spinModeDisabled("ready", false)).toBe(true);
    expect(spinModeDisabled("waiting", true)).toBe(true);
    expect(spinModeDisabled("fast-stop", false)).toBe(false);
    expect(spinModeDisabled("big-win-skip", false)).toBe(false);
    expect(spinModeDisabled("normal-win-skip", false)).toBe(false);
    expect(spinModeDisabled("feature-continue", false)).toBe(false);
    expect(spinModeDisabled("free-spin-summary-continue", false)).toBe(false);
    expect(spinModeDisabled("cap-continue", false)).toBe(false);
    expect(spinModeDisabled("wheel-popup-continue", false)).toBe(false);
    expect(spinModeDisabled("wheel-ready", false)).toBe(false);
    expect(spinModeDisabled("wheel-summary-continue", false)).toBe(false);
    expect(spinModeDisabled("wheel-fast-stop", false)).toBe(false);
    expect(spinModeDisabled("wheel-landing-continue", true)).toBe(true);
    expect(spinModeDisabled("wheel-none", true)).toBe(true);
  });

  it("projects official Wheel visual tokens independently from their actions", () => {
    expect(spinControlPresentation("wheel-popup-continue", false)).toMatchObject({
      dataMode: "continue",
      action: "continue",
      visualToken: "continue",
      ariaLabel: "Continue to Primal Wheel",
      disabled: false,
    });
    expect(spinControlPresentation("wheel-ready", false)).toMatchObject({
      dataMode: "ready",
      action: "wheel-spin",
      visualToken: "spin",
      ariaLabel: "Spin Primal Wheel",
      disabled: false,
    });
    expect(spinControlPresentation("wheel-fast-stop", false)).toMatchObject({
      dataMode: "continue",
      action: "wheel-quick-stop",
      visualToken: "continue",
      ariaLabel: "Stop Primal Wheel",
      disabled: false,
    });
    expect(spinControlPresentation("wheel-landing-continue", true)).toMatchObject({
      dataMode: "continue",
      action: "none",
      visualToken: "continue",
      ariaLabel: "Primal Wheel result",
      disabled: true,
    });
    expect(spinControlPresentation("wheel-none", true)).toMatchObject({
      dataMode: "none",
      action: "none",
      visualToken: "none",
      disabled: true,
    });
    expect(spinControlPresentation("wheel-summary-continue", false)).toMatchObject({
      dataMode: "continue",
      action: "continue",
      visualToken: "continue",
      ariaLabel: "Continue Wheel bonus summary",
      disabled: false,
    });
  });

  it("keeps the Free Spins intro action as Continue while rendering the authored Spin control", () => {
    expect(spinControlPresentation("feature-continue", false)).toMatchObject({
      dataMode: "ready",
      action: "continue",
      visualToken: "spin",
      ariaLabel: "Start Free Spins",
      text: "Spin",
      disabled: false,
    });
    // 终局 Free Spins 摘要使用另一个原始 CONTINUE 门控。
    expect(spinControlPresentation("free-spin-summary-continue", false)).toMatchObject({
      dataMode: "continue",
      action: "continue",
      visualToken: "continue",
    });
  });

  it("routes the Wheel summary CONTINUE through Spin with a dedicated accessible name", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");

    expect(source).toContain('case "wheel-summary-continue"');
    expect(source).toContain('"Continue Wheel bonus summary"');
  });

  it("exposes dedicated popup and Free Spins summary CONTINUE modes", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");

    expect(source).toContain('case "wheel-popup-continue"');
    expect(source).toContain('case "free-spin-summary-continue"');
    expect(source).toContain('"Continue to Primal Wheel"');
    expect(source).toContain('"Continue Free Spins summary"');
  });

  it("keeps Big Win input on the Spin control and ignores held-key repeats", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");

    expect(source).toContain('case "big-win-skip"');
    expect(source).toContain('"Advance Big Win presentation"');
    expect(source).toMatch(/if \(event\.repeat\) return;[\s\S]+big-win-skip[\s\S]+fastStopHandler/);
  });

  it("keeps normal-win Continue actionable and finalizes the visible amount once", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const resolve = vi.fn();
    const lastWin = { textContent: "0.42" };
    const messageTitle = { textContent: "" };
    const messageSubtitle = { textContent: "" };
    const messageDetail = { textContent: "" };
    const roundState = { dataset: {} as Record<string, string> };
    Object.assign(overlay as unknown as Record<string, unknown>, {
      lastWin,
      messageTitle,
      messageSubtitle,
      messageDetail,
      roundState,
      heldWheelBonusRoundState: null,
      heldOrdinaryWinRoundState: null,
      winCounterAnimation: { handle: null, resolve, totalMinor: "1234" },
    });

    expect(overlay.finishWinCounter()).toBe(true);
    expect(lastWin.textContent).toBe("12.34");
    expect(messageTitle.textContent).toBe("WIN: 12.34");
    expect(messageSubtitle.textContent).toBe("Congratulations!");
    expect(roundState.dataset.variant).toBe("win-settled");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(overlay.finishWinCounter()).toBe(false);
  });
});

describe("authoritative WIN display", () => {
  it("uses cumulative Free Spins win and completion total instead of the last spin", () => {
    const base = {
      totalWinMinor: "150",
      events: [] as FeatureEvent[],
      featureState: {
        mode: "EXPANSION" as const,
        freeSpinsRemaining: 3,
        freeSpinsPlayed: 5,
        freeSpinsWinMinor: "1050",
        rageLevel: 1,
        rageCollected: 0,
      },
    };
    expect(visibleWinMinorForResult(base)).toBe("1050");
    expect(visibleWinMinorForResult({
      ...base,
      featureState: { ...base.featureState, mode: "BASE", freeSpinsRemaining: 0 },
      events: [{
        type: "free_spins.completed",
        mode: "EXPANSION",
        awarded: 8,
        cumulativeWinMinor: "2300",
      }],
    })).toBe("2300");
  });
});

describe("sound toggle accessibility", () => {
  it("uses a stable toggle name and exposes mute with aria-pressed", () => {
    expect(soundControlPresentation(false)).toEqual({
      state: "on",
      ariaLabel: "Mute sound",
      ariaPressed: "false",
      title: "Sound on",
      disabled: false,
    });
    expect(soundControlPresentation(true)).toEqual({
      state: "muted",
      ariaLabel: "Mute sound",
      ariaPressed: "true",
      title: "Sound muted",
      disabled: false,
    });
  });

  it("has an explicit unavailable fallback", () => {
    expect(soundControlPresentation(false, false)).toEqual({
      state: "unavailable",
      ariaLabel: "Sound unavailable",
      ariaPressed: "false",
      title: "Sound unavailable",
      disabled: true,
    });
  });
});

describe("UI panel sound lifecycle", () => {
  it("emits exactly once per real visibility transition, including panel switches", () => {
    const opened = vi.fn();
    const closed = vi.fn();
    const lifecycle = new UiPanelLifecycle();
    lifecycle.onOpen(opened);
    lifecycle.onClose(closed);

    expect(lifecycle.setVisible("bet", true)).toBe(true);
    expect(lifecycle.setVisible("bet", true)).toBe(false);
    expect(lifecycle.setVisible("bet", false)).toBe(true);
    expect(lifecycle.setVisible("bet", false)).toBe(false);

    lifecycle.setVisible("settings", true);
    lifecycle.setVisible("settings", false);
    lifecycle.setVisible("paytable", true);
    lifecycle.setVisible("paytable", false);
    lifecycle.setVisible("rules", true);
    lifecycle.setVisible("rules", false);
    lifecycle.setVisible("autoplay", true);
    lifecycle.setVisible("autoplay", false);

    expect(opened.mock.calls.map(([panel]) => panel)).toEqual([
      "bet", "settings", "paytable", "rules", "autoplay",
    ]);
    expect(closed.mock.calls.map(([panel]) => panel)).toEqual([
      "bet", "settings", "paytable", "rules", "autoplay",
    ]);
  });

  it("wires buttons, scrims, Escape, and menu-tab switches through idempotent setters", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");

    expect(source).toContain('this.betClose.addEventListener("click", () => this.setBetPopupOpen(false))');
    expect(source).toContain('this.betScrim.addEventListener("click", () => this.setBetPopupOpen(false))');
    expect(source).toContain('this.autoplayClose.addEventListener("click", () => this.setAutoplayModalOpen(false))');
    expect(source).toContain('this.autoplayScrim.addEventListener("click", () => this.setAutoplayModalOpen(false))');
    expect(source).toContain('this.gameMenuClose.addEventListener("click", () => this.setGameMenuOpen(false))');
    expect(source).toMatch(/event\.key !== "Escape"[\s\S]+setGameMenuOpen\(false\)[\s\S]+setAutoplayModalOpen\(false\)[\s\S]+setBetPopupOpen\(false\)/);
    expect(source).toContain("this.panelLifecycle.setVisible(previousTab, false)");
    expect(source).toContain("this.panelLifecycle.setVisible(tab, true)");
  });

  it("keeps semantic feature announcements off the authored visual surface", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");

    expect(source).toContain('class="feature-pill visually-hidden"');
    expect(source).toContain('data-role="feature" aria-live="polite"');
  });
});

describe("dialog accessibility", () => {
  it("keeps the interactive HUD inert whenever launch is locked or a dialog is open", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const statusPanel = { inert: false } as unknown as HTMLElement;
    const spinDock = { inert: false } as unknown as HTMLElement;
    const toolStrip = { inert: false } as unknown as HTMLElement;
    const featurePreview = { dataset: { visible: "false" } } as unknown as HTMLElement;
    const gameMenu = { dataset: { open: "false" } } as unknown as HTMLElement;
    const autoplayModal = { dataset: { open: "false" } } as unknown as HTMLElement;
    const betPopup = { dataset: { open: "false" } } as unknown as HTMLElement;
    Object.assign(overlay as unknown as Record<string, unknown>, {
      hudInteractive: true,
      modalBackground: [statusPanel, spinDock, toolStrip],
      featurePreview,
      gameMenu,
      autoplayModal,
      betPopup,
    });
    const harness = overlay as unknown as {
      syncModalBackgroundInert(): void;
    };

    harness.syncModalBackgroundInert();
    expect([statusPanel.inert, spinDock.inert, toolStrip.inert]).toEqual([false, false, false]);

    betPopup.dataset.open = "true";
    harness.syncModalBackgroundInert();
    expect([statusPanel.inert, spinDock.inert, toolStrip.inert]).toEqual([true, true, true]);

    betPopup.dataset.open = "false";
    Object.assign(overlay as unknown as Record<string, unknown>, { hudInteractive: false });
    harness.syncModalBackgroundInert();
    expect([statusPanel.inert, spinDock.inert, toolStrip.inert]).toEqual([true, true, true]);
  });

  it("loops Tab focus in the active dialog and restores its opener", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const firstFocus = vi.fn();
    const lastFocus = vi.fn();
    const first = {
      tabIndex: 0,
      hidden: false,
      inert: false,
      parentElement: null,
      getAttribute: () => null,
      matches: () => false,
      focus: firstFocus,
    } as unknown as HTMLElement;
    const last = {
      tabIndex: 0,
      hidden: false,
      inert: false,
      parentElement: null,
      getAttribute: () => null,
      matches: () => false,
      focus: lastFocus,
    } as unknown as HTMLElement;
    const dialog = {
      hidden: false,
      inert: false,
      getAttribute: () => null,
      querySelectorAll: () => [first, last],
      contains: (candidate: unknown) => candidate === first || candidate === last,
    } as unknown as HTMLElement;
    const documentStub = { activeElement: last };
    vi.stubGlobal("document", documentStub);
    const harness = overlay as unknown as {
      trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement): void;
      restoreDialogFocus(opener: HTMLElement | null, restoreFocus: boolean): void;
    };
    try {
      const forward = { shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
      harness.trapDialogFocus(forward, dialog);
      expect(forward.preventDefault).toHaveBeenCalledOnce();
      expect(firstFocus).toHaveBeenCalledOnce();

      documentStub.activeElement = first;
      const backward = { shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent;
      harness.trapDialogFocus(backward, dialog);
      expect(backward.preventDefault).toHaveBeenCalledOnce();
      expect(lastFocus).toHaveBeenCalledOnce();

      const openerFocus = vi.fn();
      const opener = { isConnected: true, inert: false, focus: openerFocus } as unknown as HTMLElement;
      harness.restoreDialogFocus(opener, true);
      expect(openerFocus).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("wires modal isolation and preserves a high-contrast bet-dialog focus indicator", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

    expect(source).toContain("this.syncModalBackgroundInert();");
    expect(source).toMatch(/const dialog = this\.activeDialog\(\);[\s\S]+event\.key === "Tab"/);
    expect(source).toContain("this.restoreDialogFocus(this.menuReturnFocus, restoreFocus);");
    expect(source).toContain("this.restoreDialogFocus(this.autoplayReturnFocus, restoreFocus);");
    expect(source).toContain("this.restoreDialogFocus(this.betReturnFocus, restoreFocus);");
    expect(css).toMatch(/\.compact-modal__head button \{[\s\S]*width: 44px;[\s\S]*height: 44px;/);
    expect(css).toMatch(/\.bet-popover__close \{[\s\S]*width: 44px;[\s\S]*height: 44px;/);
    expect(css).toMatch(/\.bet-popover \.bet-choice:focus-visible,[\s\S]*outline: 3px solid #fff;/);
  });
});
