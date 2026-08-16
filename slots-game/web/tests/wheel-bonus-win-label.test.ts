import { describe, expect, it } from "vitest";
import {
  WHEEL_BONUS_WIN_LABEL_TIMELINE_MS,
  WheelBonusWinLabelLifecycle,
  resolveWheelBonusTextAttachment,
  wheelBonusWinLabelText,
} from "../src/renderer/WheelBonusWinLabel";

describe("post-Wheel BONUS winlabel", () => {
  it("binds only authoritative Wheel money to the captured master-win slots", () => {
    expect(wheelBonusWinLabelText("1000")).toEqual({
      winLabelValue: "10.00",
      winLabelInfo: "BONUS won!",
      winLabelMultiplier: null,
    });
    expect(wheelBonusWinLabelText(undefined)).toBeNull();
    expect(wheelBonusWinLabelText("01")).toBeNull();
    expect(wheelBonusWinLabelText("-1")).toBeNull();
  });

  it("keeps the Wheel award independent from the whole-round total", () => {
    const wheelAwardMinor = "3000";
    const wholeRoundTotalMinor = "3300";
    const layerB = wheelBonusWinLabelText(wheelAwardMinor);

    expect(layerB?.winLabelValue).toBe("30.00");
    expect(layerB?.winLabelValue)
      .not.toBe(wheelBonusWinLabelText(wholeRoundTotalMinor)?.winLabelValue);
  });

  it("resolves the default-skin bounds when winlabel text slots are attachmentless", () => {
    const bounds = { vertices: [-10, 5, 10, 5, 10, -5, -10, -5] };
    const getAttachment = () => bounds;
    expect(resolveWheelBonusTextAttachment(
      { getAttachment: (_slotIndex, name) => name === "bounds" ? bounds : null },
      { data: { index: 12 }, getAttachment: () => null },
    )).toBe(bounds);
    expect(resolveWheelBonusTextAttachment(
      { getAttachment: () => null },
      { data: { index: 12 }, getAttachment },
    )).toBe(bounds);
  });

  it("shows for 333.333ms, holds indefinitely, then hides on the next spin", () => {
    const lifecycle = new WheelBonusWinLabelLifecycle();
    expect(WHEEL_BONUS_WIN_LABEL_TIMELINE_MS).toEqual({
      show: 333.333,
      hide: 333.333,
    });
    expect(lifecycle.show()).toBe(true);
    expect(lifecycle.advance(333.332)).toBe("showing");
    expect(lifecycle.advance(0.001)).toBe("holding");
    expect(lifecycle.advance(60_000)).toBe("holding");
    expect(lifecycle.hide()).toBe(true);
    expect(lifecycle.advance(333.332)).toBe("hiding");
    expect(lifecycle.advance(0.001)).toBe("hidden");
  });

  it("tears the held plate down immediately on cancel or renderer destroy", () => {
    const lifecycle = new WheelBonusWinLabelLifecycle();
    lifecycle.show();
    lifecycle.advance(WHEEL_BONUS_WIN_LABEL_TIMELINE_MS.show);
    lifecycle.cancel();
    expect(lifecycle.state).toBe("hidden");
    lifecycle.show();
    lifecycle.destroy();
    expect(lifecycle.state).toBe("destroyed");
    expect(lifecycle.show()).toBe(false);
    expect(lifecycle.hide()).toBe(false);
  });
});
