import { describe, expect, it, vi } from "vitest";
import type { MinorUnitFormatter } from "../src/protocol/moneyFormatter";
import { createMinorUnitFormatter } from "../src/protocol/moneyFormatter";
import { PixiRenderer } from "../src/renderer/PixiRenderer";
import { BigWinView } from "../src/renderer/BigWinView";
import { jackpotDisplayValue } from "../src/renderer/JackpotTowerView";
import { freeSpinSummaryTextFields, wheelSummaryTextFields } from "../src/renderer/PrimalPanelText";
import { wheelBonusWinLabelText } from "../src/renderer/WheelBonusWinLabel";
import { winLabelValue } from "../src/renderer/WinCelebration";

describe("PixiRenderer session money binding", () => {
  it.each([
    { exponent: 0, value: "1234", expected: "1234" },
    { exponent: 3, value: "1234", expected: "1.234" },
  ])("atomically distributes exponent=$exponent to every money surface", ({
    exponent, value, expected,
  }) => {
    const received: MinorUnitFormatter[] = [];
    const owner = () => ({
      setMoneyFormatter: vi.fn((formatter: MinorUnitFormatter) => received.push(formatter)),
    });
    const jackpotTower = owner();
    const bigWin = owner();
    const winCelebration = owner();
    const wheelBonusWinLabel = owner();
    const featureEffects = owner();
    const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      jackpotTower,
      bigWin,
      winCelebration,
      wheelBonusWinLabel,
      featureEffects,
    });

    renderer.setMoneyDisplayBinding({ currency: "EUR", currencyExponent: exponent });

    expect(received).toHaveLength(5);
    expect(received.every((formatter) => formatter === received[0])).toBe(true);
    expect(received[0]?.format(value, false)).toBe(expected);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("uses the shared exponent in jackpot, win labels, feature panels, and Big Win", () => {
    const formatter = createMinorUnitFormatter({ currency: "EUR", currencyExponent: 3 });
    expect(jackpotDisplayValue("100", 10n, formatter)).toBe("1.000");
    expect(winLabelValue("1234", formatter)).toBe("1.234");
    expect(wheelBonusWinLabelText("1234", formatter)?.winLabelValue).toBe("1.234");
    expect(freeSpinSummaryTextFields({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "1234",
    }, formatter).find(({ name }) => name === "fsSummaryValue")?.text).toBe("1.234");
    expect(wheelSummaryTextFields({
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1234",
    }, false, formatter).find(({ name }) => name === "totalWinValue")?.text).toBe("1.234");

    const bigWin = new BigWinView();
    const amountText = {
      text: "",
      width: 100,
      height: 50,
      scale: { set: vi.fn() },
    };
    const harness = bigWin as unknown as {
      amountText: typeof amountText;
      setDisplayedAmount(amountMinor: bigint): void;
    };
    harness.amountText = amountText;
    bigWin.setMoneyFormatter(formatter);
    harness.setDisplayedAmount(1_234n);
    expect(amountText.text).toBe("1.234  ");
    bigWin.destroy({ children: true });
  });
});
