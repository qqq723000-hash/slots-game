import { describe, expect, it, vi } from "vitest";
import {
  BaseMusicPotStateMachine,
  type BaseMusicPotLevelChange,
} from "../src/audio/BaseMusicPotStateMachine";

function finishNoWinRound(machine: BaseMusicPotStateMachine, betMinor = "100"): void {
  machine.beginRound(betMinor);
  machine.recordNoWin();
  machine.endRound();
}

describe("captured base-music pot state machine", () => {
  it("uses the exact 1x/2x level thresholds and caps the pot at 5x wager", () => {
    const changes: BaseMusicPotLevelChange[] = [];
    const machine = new BaseMusicPotStateMachine({
      onLevelChange: (change) => changes.push(change),
    });

    machine.beginRound("100");
    machine.recordWin("199");
    expect(machine.snapshot()).toMatchObject({ potMinor: "199", level: 0 });
    expect(changes).toEqual([]);

    machine.recordWin("1");
    expect(machine.snapshot()).toMatchObject({ potMinor: "200", level: 1 });
    expect(changes).toEqual([{ previousLevel: 0, level: 1 }]);

    machine.recordWin("999999999999999999999999");
    expect(machine.potMinor).toBe("500");
    machine.endRound();
  });

  it("doubles no-win decay from 0.1 to 0.4 and resets it after a win", () => {
    const machine = new BaseMusicPotStateMachine();
    expect(machine.reduceRate).toBe("0.1");

    finishNoWinRound(machine);
    expect(machine.reduceRate).toBe("0.2");
    finishNoWinRound(machine);
    expect(machine.reduceRate).toBe("0.4");
    finishNoWinRound(machine);
    expect(machine.reduceRate).toBe("0.4");

    machine.beginRound("100");
    machine.recordWin("1");
    expect(machine.reduceRate).toBe("0.1");
    machine.endRound();
  });

  it("waits five seconds after a level change before exact 0.1x wager decay", () => {
    const changes: BaseMusicPotLevelChange[] = [];
    const machine = new BaseMusicPotStateMachine({
      onLevelChange: (change) => changes.push(change),
    });
    machine.beginRound("100");
    machine.recordWin("200");

    machine.tick(4_999);
    expect(machine.snapshot()).toMatchObject({
      potMinor: "200",
      level: 1,
      secondsSinceLastLevelChange: 4,
      pendingTickMs: 999,
    });
    machine.tick(1);
    expect(machine.snapshot()).toMatchObject({
      potMinor: "190",
      level: 0,
      secondsSinceLastLevelChange: 0,
      pendingTickMs: 0,
    });

    // 降至第 0 级会重新开始五秒的延迟停留。
    machine.tick(4_000);
    expect(machine.potMinor).toBe("190");
    machine.tick();
    expect(machine.potMinor).toBe("180");
    expect(changes).toEqual([
      { previousLevel: 0, level: 1 },
      { previousLevel: 1, level: 0 },
    ]);
    machine.endRound();
  });

  it("retains sub-minor decay exactly without floating-point money", () => {
    const machine = new BaseMusicPotStateMachine();
    machine.beginRound("3");
    machine.recordWin("6");
    machine.tick(5_000);
    expect(machine.potMinor).toBe("5.7");
    machine.endRound();
  });

  it("uses strict ROUNDEND idle timing and downgrades only after 30 seconds", () => {
    const onLevelChange = vi.fn();
    const machine = new BaseMusicPotStateMachine({ onLevelChange });
    machine.beginRound("100");
    machine.recordWin("500");
    machine.endRound();
    onLevelChange.mockClear();

    machine.tick(30_000);
    expect(machine.snapshot()).toMatchObject({
      level: 1,
      potMinor: "240",
      secondsSinceLastSpin: 30,
    });
    expect(onLevelChange).not.toHaveBeenCalled();

    machine.tick();
    expect(machine.snapshot()).toMatchObject({
      level: 0,
      potMinor: "100",
      secondsSinceLastSpin: 0,
      secondsSinceLastLevelChange: 1,
    });
    expect(onLevelChange).toHaveBeenCalledOnce();
    expect(onLevelChange).toHaveBeenCalledWith({ previousLevel: 1, level: 0 });
  });

  it("pauses ticks and level updates while docked, then resumes without catch-up", () => {
    const onLevelChange = vi.fn();
    const machine = new BaseMusicPotStateMachine({ onLevelChange });
    machine.dock();
    machine.beginRound("100");
    machine.recordWin("300");
    machine.endRound();
    machine.tick(60_000);

    expect(machine.snapshot()).toMatchObject({
      docked: true,
      potMinor: "300",
      level: 0,
      secondsSinceLastSpin: 0,
      secondsSinceLastLevelChange: 0,
      pendingTickMs: 0,
    });
    expect(onLevelChange).not.toHaveBeenCalled();

    machine.undock();
    machine.tick(4_000);
    expect(machine.snapshot()).toMatchObject({ potMinor: "300", level: 0 });
    machine.tick();
    expect(machine.snapshot()).toMatchObject({ potMinor: "290", level: 1 });
    expect(onLevelChange).toHaveBeenCalledWith({ previousLevel: 0, level: 1 });
  });

  it("keeps wagers and wins above Number.MAX_SAFE_INTEGER exact", () => {
    const bet = 90_071_992_547_409_931_234n;
    const machine = new BaseMusicPotStateMachine();
    machine.beginRound(bet.toString());
    machine.recordWin((bet * 2n).toString());
    expect(machine.snapshot()).toMatchObject({
      betMinor: bet.toString(),
      potMinor: (bet * 2n).toString(),
      level: 1,
    });
    machine.recordWin((bet * 10n).toString());
    expect(machine.potMinor).toBe((bet * 5n).toString());
    machine.endRound();
  });

  it("rejects malformed amounts and invalid round sequencing", () => {
    const machine = new BaseMusicPotStateMachine();
    expect(() => machine.beginRound("1.00")).toThrow(/decimal minor string/);
    expect(() => machine.beginRound("0")).toThrow(/greater than zero/);
    expect(() => machine.recordWin("1")).toThrow(/no open round/);
    expect(() => machine.endRound()).toThrow(/no open round/);

    machine.beginRound("100");
    expect(() => machine.beginRound("100")).toThrow(/already open/);
    expect(() => machine.recordWin("-1")).toThrow(/decimal minor string/);
    expect(() => machine.tick(Number.NaN)).toThrow(/finite non-negative/);
    machine.recordNoWin();
    machine.endRound();
  });
});
