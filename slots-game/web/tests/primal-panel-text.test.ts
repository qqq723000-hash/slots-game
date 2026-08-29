import { describe, expect, it } from "vitest";
import type { WheelAwardedEvent } from "../src/app/state/types";
import {
  PRIMAL_PANEL_LAYOUT,
  PRIMAL_PANEL_TEXT_SLOTS,
  centreOfVertices,
  fitSpineTextToBounds,
  formatPrimalPanelAmount,
  freeSpinIntroTextFields,
  freeSpinSummaryTextFields,
  readableSpineTextTransform,
  wheelSummaryTextFields,
} from "../src/renderer/PrimalPanelText";

describe("captured Primal panel text manifests", () => {
  it("uses the exact desktop contain transforms", () => {
    expect(PRIMAL_PANEL_LAYOUT.freeSpinIntro).toEqual({
      x: 640,
      y: 324,
      scale: 0.72,
      minBound: [-500, -450, 1_000, 1_000],
    });
    expect(PRIMAL_PANEL_LAYOUT.freeSpinSummary.scale).toBeCloseTo(0.6545454545, 10);
    expect(PRIMAL_PANEL_LAYOUT.freeSpinSummary.y).toBe(360 - 50 * (720 / 1_100));
    expect(PRIMAL_PANEL_LAYOUT.freeSpinSummary.minBound)
      .toEqual([-550, -500, 1_100, 1_100]);
    expect(PRIMAL_PANEL_LAYOUT.wheelSummary).toEqual({
      x: 640,
      y: 360,
      scale: 0.6,
      minBound: [-600, -600, 1_200, 1_200],
    });
  });

  it("retains the original intro slot, bone, size, and bounding geometry", () => {
    expect(PRIMAL_PANEL_TEXT_SLOTS.kongQuestIntro.map((field) => ({
      name: field.name,
      bone: field.bone,
      size: field.size,
      bounds: field.bounds,
    }))).toEqual([
      {
        name: "IDS_PR_KQ_FSINTRO1",
        bone: "_text_IDS_PR_KQ_FSINTRO1_size100",
        size: 100,
        bounds: [0.565, 1.285, 1_329.57, 202.05],
      },
      {
        name: "IDS_PR_KQ_FSINTRO2",
        bone: "_text_IDS_PR_KQ_FSINTRO2_size65",
        size: 65,
        bounds: [11.555, -0.89, 1_217.05, 178.36],
      },
      {
        name: "IDS_PR_KQ_FSINTRO3",
        bone: "_text_IDS_PR_KQ_FSINTRO3_size65",
        size: 65,
        bounds: [0.685, -0.095, 1_304.51, 129.87],
      },
      {
        name: "IDS_PR_KQ_FSINTRO4",
        bone: "_text_IDS_PR_KQ_FSINTRO4_size80",
        size: 80,
        bounds: [10.47, 17.865, 1_371.98, 232.63],
      },
    ]);
    expect(PRIMAL_PANEL_TEXT_SLOTS.kingSpinIntro.map(({ name, bone, size }) => ({
      name, bone, size,
    }))).toEqual([
      { name: "IDS_PR_KS_FSINTRO1", bone: "_text_IDS_PR_KS_FSINTRO1_size100", size: 100 },
      { name: "IDS_PR_KS_FSINTRO2", bone: "_text_IDS_PR_KS_FSINTRO2_size65", size: 65 },
      { name: "IDS_PR_KS_FSINTRO3", bone: "_text_IDS_PR_KS_FSINTRO3_size65", size: 65 },
      { name: "IDS_PR_KS_FSINTRO4", bone: "_text_IDS_PR_KS_FSINTRO4_size90", size: 90 },
    ]);
  });

  it("materializes the two original Free Spins intro scripts", () => {
    expect(freeSpinIntroTextFields({
      type: "free_spins.started", mode: "EXPANSION", awarded: 11,
    }).map(({ text }) => text)).toEqual([
      "8 FREE SPINS awarded!",
      "Reels can expand in KONG QUEST!",
      "Unlock FREE SPINS to retrigger!",
      "PRESS SPIN TO BEGIN",
    ]);
    expect(freeSpinIntroTextFields({
      type: "free_spins.started", mode: "OVERDRIVE", awarded: 12,
    }).map(({ text }) => text)).toEqual([
      "8 FREE SPINS awarded!",
      "All VAULT BONUS are unlocked in KING SPIN!",
      "All VAULT BONUS can upgrade up to GRAND!",
      "PRESS SPIN TO BEGIN",
    ]);
  });

  it("binds exact Free Spins and Wheel summary copy to the captured slots", () => {
    expect(freeSpinSummaryTextFields({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor: "12500",
    }).map(({ name, text }) => [name, text])).toEqual([
      ["fsSummaryCongrats", "CONGRATULATIONS!"],
      ["fsSummaryValue", "125.00"],
      ["fsSummaryTotal", "Total Win"],
    ]);

    expect(wheelSummaryTextFields({
      type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST",
    }, true).map(({ text }) => text)).toEqual([
      "CONGRATULATIONS!", "You’ve won the", "KONG QUEST",
    ]);
    expect(wheelSummaryTextFields({
      type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
      multiplier: 1_000, amountMinor: "250000",
    }, false).map(({ text }) => text)).toEqual([
      "CONGRATULATIONS!", "You’ve won the GRAND BONUS!", "Total Win", "2500.00",
    ]);
    expect(wheelSummaryTextFields({
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINI", multiplier: 10,
    } as unknown as WheelAwardedEvent, false).at(-1)?.text).toBe("");
  });
});

describe("Primal panel text geometry", () => {
  it("formats integer minor-unit strings without Number precision loss", () => {
    expect(formatPrimalPanelAmount("0")).toBe("0.00");
    expect(formatPrimalPanelAmount("7")).toBe("0.07");
    expect(formatPrimalPanelAmount("123456789012345678901")).toBe("1234567890123456789.01");
    expect(formatPrimalPanelAmount("-1")).toBe("0.00");
  });

  it("fits text within both authored dimensions and finds a vertex AABB centre", () => {
    expect(fitSpineTextToBounds(2_000, 100, [0, 0, 1_000, 200])).toBe(0.5);
    expect(fitSpineTextToBounds(500, 400, [0, 0, 1_000, 200])).toBe(0.5);
    expect(fitSpineTextToBounds(500, 100, [0, 0, 1_000, 200])).toBe(1);
    expect(centreOfVertices([-4, 8, 10, -6, 6, 2, 0, 4])).toEqual({ x: 3, y: 1 });
  });

  it("removes Spine's Y-axis reflection without losing authored tilt or scale", () => {
    const setup = readableSpineTextTransform({
      a: 1,
      b: 0,
      c: -9.282041333256964e-8,
      d: -1,
    });
    expect(setup.rotation).toBe(0);
    expect(setup.scaleX).toBe(1);
    expect(setup.scaleY).toBeCloseTo(1, 12);
    expect(setup.scaleY).toBeGreaterThan(0);

    // 在 `show` 动画期间从 wheel_summary_jackpot.skel 捕获。 / English: Captured from wheel_summary_jackpot.skel during `show` animation.
    const animated = readableSpineTextTransform({
      a: 0.806,
      b: 0.012,
      c: 0.012,
      d: -0.806,
    });
    expect(animated.rotation).toBeCloseTo(Math.atan2(0.012, 0.806), 12);
    expect(animated.scaleX).toBeCloseTo(Math.hypot(0.806, 0.012), 12);
    expect(animated.scaleY).toBeCloseTo(Math.hypot(0.012, -0.806), 12);
    expect(animated.scaleY).toBeGreaterThan(0);
  });
});
