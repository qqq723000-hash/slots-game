import { describe, expect, it } from "vitest";
import { decodeServerMessage, ProtocolDecodeError } from "../src/protocol/decoder";
import { ENGINE_RULES_VERSION } from "../src/protocol/messages";

const result = {
  type: "spin.result",
  protocolVersion: 1,
  requestId: "request-1",
  sessionId: "session-1",
  roundId: "round-1",
  sequence: 4,
  betMinor: "100",
  chargedBetMinor: "100",
  balanceMinor: "10125",
  totalWinMinor: "225",
  grid: [
    [{ symbol: "ORBIT" }, { symbol: "PULSE" }, { symbol: "TANK" }],
    [{ symbol: "ORBIT" }, { symbol: "WILD", multiplier: 2 }, { symbol: "VAULT" }],
    [{ symbol: "ORBIT" }, { symbol: "NOVA" }, { symbol: "SURGE" }],
  ],
  wins: [{
    id: "win-1",
    symbol: "ORBIT",
    amountMinor: "225",
    cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
  }],
  events: [],
  featureState: {
    mode: "BASE", freeSpinsRemaining: 0, freeSpinsPlayed: 0,
    rageLevel: 1, rageCollected: 0,
  },
};

const authoritativeWaysResult = {
  ...result,
  wins: [{
    id: "win-1",
    symbol: "ORBIT",
    ways: 2,
    amountMinor: "225",
    cells: [
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 1, row: 1 },
      { reel: 2, row: 0 },
    ],
    pathAwards: [
      {
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
        multiplier: 1,
        baseAmountMinor: "75",
        amountMinor: "75",
      },
      {
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 1 }, { reel: 2, row: 0 }],
        multiplier: 2,
        baseAmountMinor: "75",
        amountMinor: "150",
      },
    ],
  }],
};

describe("decodeServerMessage", () => {
  it("decodes an authoritative reel-major result", () => {
    const decoded = decodeServerMessage(JSON.stringify(result));
    expect(decoded.type).toBe("spin.result");
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.grid[1]?.[1]).toEqual({ symbol: "WILD", multiplier: 2 });
    expect(decoded.grid[0]?.[2]).toEqual({ symbol: "TANK" });
    expect(decoded.wins[0]?.cells[2]).toEqual({ reel: 2, row: 0 });
    expect(decoded.totalWinMinor).toBe("225");
    expect(decoded.sequence).toBe(4);
  });

  it("decodes server-resolved Ways paths while retaining legacy fixture compatibility", () => {
    const decoded = decodeServerMessage(authoritativeWaysResult);
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.wins[0]).toMatchObject({
      ways: 2,
      pathAwards: [
        { multiplier: 1, baseAmountMinor: "75", amountMinor: "75" },
        { multiplier: 2, baseAmountMinor: "75", amountMinor: "150" },
      ],
    });

    const legacy = decodeServerMessage(result);
    if (legacy.type !== "spin.result") throw new Error("unexpected message");
    expect(legacy.wins[0]).not.toHaveProperty("ways");
    expect(legacy.wins[0]).not.toHaveProperty("pathAwards");
  });

  it("accepts only a uniform modern record multiplier and keeps legacy presentation metadata", () => {
    const modernWin = authoritativeWaysResult.wins[0]!;
    const uniformPath = modernWin.pathAwards[1]!;
    const decoded = decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: uniformPath.amountMinor,
      wins: [{
        ...modernWin,
        ways: 1,
        amountMinor: uniformPath.amountMinor,
        multiplier: uniformPath.multiplier,
        cells: uniformPath.cells,
        pathAwards: [uniformPath],
      }],
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.wins[0]?.multiplier).toBe(2);

    const mixed = decodeServerMessage(authoritativeWaysResult);
    if (mixed.type !== "spin.result") throw new Error("unexpected message");
    expect(mixed.wins[0]).not.toHaveProperty("multiplier");

    expect(() => decodeServerMessage({
      ...authoritativeWaysResult,
      wins: [{ ...modernWin, multiplier: 2 }],
    })).toThrow(/uniform multiplier of every pathAward/);

    const legacy = decodeServerMessage({
      ...result,
      wins: [{ ...result.wins[0], multiplier: 5 }],
    });
    if (legacy.type !== "spin.result") throw new Error("unexpected message");
    expect(legacy.wins[0]?.multiplier).toBe(5);

    expect(() => decodeServerMessage({
      ...result,
      wins: [{ ...result.wins[0], multiplier: 0 }],
    })).toThrow(/multiplier must be an integer from 1/);
  });

  it("preserves and validates pre-multiplier path amounts with BigInt precision", () => {
    const base = "3007199254740993123";
    const doubled = (BigInt(base) * 2n).toString();
    const total = (BigInt(base) + BigInt(doubled)).toString();
    const modernWin = authoritativeWaysResult.wins[0]!;
    const decoded = decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: total,
      wins: [{
        ...modernWin,
        amountMinor: total,
        pathAwards: [
          { ...modernWin.pathAwards[0]!, baseAmountMinor: base, amountMinor: base },
          { ...modernWin.pathAwards[1]!, baseAmountMinor: base, amountMinor: doubled },
        ],
      }],
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.wins[0]?.pathAwards?.[1]?.baseAmountMinor).toBe(base);

    expect(() => decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: total,
      wins: [{
        ...modernWin,
        amountMinor: total,
        pathAwards: [
          { ...modernWin.pathAwards[0]!, baseAmountMinor: base, amountMinor: base },
          {
            ...modernWin.pathAwards[1]!,
            baseAmountMinor: (BigInt(doubled) + 1n).toString(),
            amountMinor: doubled,
          },
        ],
      }],
    })).toThrow(/baseAmountMinor is inconsistent/);
  });

  it("strictly validates every server-resolved Ways invariant", () => {
    const modernWin = authoritativeWaysResult.wins[0];
    if (!modernWin) throw new Error("missing fixture win");
    const expectRejected = (win: Record<string, unknown>, pattern: RegExp): void => {
      expect(() => decodeServerMessage({ ...authoritativeWaysResult, wins: [win] })).toThrow(pattern);
    };

    const { pathAwards: _paths, ...withoutPaths } = modernWin;
    expectRejected(withoutPaths, /ways.*pathAwards.*together/);
    expectRejected({ ...modernWin, ways: 513 }, /integer from 1 to 512/);
    expectRejected({ ...modernWin, ways: 3 }, /length must equal/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 0 ? { ...award, extra: true } : award
      )),
    }, /extra is not allowed/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 0
          ? { ...award, cells: [{ reel: 1, row: 0 }, { reel: 0, row: 0 }, { reel: 2, row: 0 }] }
          : award
      )),
    }, /ordered with one cell for each reel/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 0
          ? { ...award, cells: [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }] }
          : award
      )),
    }, /ORBIT or WILD/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 0
          ? { ...award, cells: [{ reel: 0, row: 8 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }] }
          : award
      )),
    }, /outside the grid/);
    expectRejected({
      ...modernWin,
      pathAwards: [modernWin.pathAwards[0], modernWin.pathAwards[0]],
    }, /duplicate paths/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 1 ? { ...award, multiplier: 1 } : award
      )),
    }, /multiplier must match/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 1 ? { ...award, amountMinor: "149" } : award
      )),
    }, /amounts must sum/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 1 ? { ...award, baseAmountMinor: "151" } : award
      )),
    }, /baseAmountMinor is inconsistent/);
    expectRejected({
      ...modernWin,
      pathAwards: modernWin.pathAwards.map((award, index) => (
        index === 0 ? { ...award, baseAmountMinor: "74" } : award
      )),
    }, /baseAmountMinor is inconsistent/);
    expectRejected({ ...modernWin, cells: modernWin.cells.slice(0, 3) }, /must equal the union/);
  });

  it("preserves authoritative unlocked-Vault prize and multiplier poses", () => {
    const decoded = decodeServerMessage({
      ...result,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "MINI_2X", multiplier: 20 }
          : cell
      ))),
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.grid[1]?.[2]).toEqual({
      symbol: "VAULT", prize: "MINI_2X", multiplier: 20,
    });
    expect(() => decodeServerMessage({
      ...result,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "not canonical" }
          : cell
      ))),
    })).toThrow(/prize/);
  });

  it("rejects WILD and VAULT symbols outside the middle reel", () => {
    for (const symbol of ["WILD", "VAULT"] as const) {
      for (const reelIndex of [0, 2]) {
        expect(() => decodeServerMessage({
          ...result,
          grid: result.grid.map((reel, currentReel) => reel.map((settledCell, rowIndex) => (
            currentReel === reelIndex && rowIndex === 1 ? { symbol } : settledCell
          ))),
        })).toThrow(new RegExp(`${symbol} is only allowed on reel 1`));
      }
    }
  });

  it("requires Vault events to address settled middle-reel Vault cells", () => {
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 0 }] }],
    })).toThrow(/must reference only settled VAULT cells/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "vault.awarded", reel: 1, row: 0, multiplier: 10, amountMinor: "1000" }],
    })).toThrow(/must reference a settled VAULT cell/);
  });

  it("decodes three legal middle-reel Vaults with matching mutations and final prizes", () => {
    const cells = [{ reel: 1, row: 0 }, { reel: 1, row: 1 }, { reel: 1, row: 2 }];
    const decoded = decodeServerMessage({
      ...result,
      grid: [
        [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "TANK" }],
        [
          { symbol: "VAULT", prize: "MINI_2X", multiplier: 20 },
          { symbol: "VAULT", prize: "MINOR", multiplier: 30 },
          { symbol: "VAULT", prize: "MAJOR", multiplier: 75 },
        ],
        [{ symbol: "ORBIT" }, { symbol: "NOVA" }, { symbol: "CIRCUIT" }],
      ],
      wins: [],
      events: [
        { type: "vaults.landed", count: 3, cells },
        { type: "vaults.unlock.started", count: 3, cells },
        { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
        { type: "vault.unlocked", reel: 1, row: 1, prize: "MINOR", multiplier: 30 },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "MAJOR", multiplier: 75 },
        { type: "vaults.unlock.completed", count: 3, cells },
        { type: "vaults.upgrade.started", count: 1, step: 1 },
        {
          type: "vault.upgraded", reel: 1, row: 0, fromMultiplier: 10,
          toMultiplier: 20, prize: "MINI_2X", step: 1,
        },
        {
          type: "vault.awarded", reel: 1, row: 0, prize: "MINI_2X",
          multiplier: 20, amountMinor: "2000",
        },
        {
          type: "vault.awarded", reel: 1, row: 1, prize: "MINOR",
          multiplier: 30, amountMinor: "3000",
        },
        {
          type: "vault.awarded", reel: 1, row: 2, prize: "MAJOR",
          multiplier: 75, amountMinor: "7500",
        },
      ],
      totalWinMinor: "12500",
      featureState: {
        mode: "OVERDRIVE", freeSpinsRemaining: 7, freeSpinsPlayed: 1,
        baseBetMinor: "100", freeSpinsWinMinor: "12500", rageLevel: 1, rageCollected: 0,
      },
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.grid[1]).toEqual([
      { symbol: "VAULT", prize: "MINI_2X", multiplier: 20 },
      { symbol: "VAULT", prize: "MINOR", multiplier: 30 },
      { symbol: "VAULT", prize: "MAJOR", multiplier: 75 },
    ]);
    expect(decoded.events.map(({ type }) => type)).toEqual([
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "vault.unlocked",
      "vault.unlocked",
      "vaults.unlock.completed",
      "vaults.upgrade.started",
      "vault.upgraded",
      "vault.awarded",
      "vault.awarded",
      "vault.awarded",
    ]);
  });

  it("rejects non-canonical money instead of converting it to a number", () => {
    expect(() => decodeServerMessage({ ...result, totalWinMinor: "01" })).toThrow(ProtocolDecodeError);
    expect(() => decodeServerMessage({ ...result, totalWinMinor: 1 })).toThrow(ProtocolDecodeError);
  });

  it("treats TANK as a first-class protocol symbol and rejects presentation-only aliases", () => {
    const tankGrid = result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      rowIndex === 0 || (reelIndex === 0 && rowIndex === 2) ? { symbol: "TANK" } : cell
    )));
    const tankResult = {
      ...result,
      grid: tankGrid,
      totalWinMinor: "18",
      wins: [{
        id: "tank-3",
        symbol: "TANK",
        amountMinor: "18",
        cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      }],
    };
    const decoded = decodeServerMessage(tankResult);
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.wins[0]?.symbol).toBe("TANK");

    expect(() => decodeServerMessage({
      ...result,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 0 && rowIndex === 2 ? { symbol: "CAMO_TANK_ART" } : cell
      ))),
    })).toThrow(/unsupported symbol CAMO_TANK_ART/);
  });

  it("rejects win coordinates outside the server grid", () => {
    const invalid = {
      ...result,
      wins: [{ ...result.wins[0], cells: [{ reel: 3, row: 0 }] }],
    };
    expect(() => decodeServerMessage(invalid)).toThrow(/outside the grid/);
  });

  it("decodes the complete authoritative base-game event sequence", () => {
    const canonicalEvents = [
      { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
      { type: "vault.awarded", reel: 1, row: 2, prize: "MINI", multiplier: 10, amountMinor: "1000" },
      { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
      {
        type: "surge.collected", count: 1, cells: [{ reel: 2, row: 2 }],
        triggered: true, guaranteed: false, level: 2, total: 4,
      },
      {
        type: "rage.transformed", count: 2,
        cells: [{ reel: 0, row: 1 }, { reel: 2, row: 1 }], level: 2, total: 4,
      },
      { type: "wheel.started" },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINOR",
        multiplier: 30, amountMinor: "3000",
      },
    ];
    const decoded = decodeServerMessage({
      ...result,
      totalWinMinor: "4225",
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "MINI", multiplier: 10 }
          : cell
      ))),
      events: canonicalEvents,
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.events).toEqual(canonicalEvents);
    expect(decoded.events.map((event) => event.type)).toEqual([
      "vaults.landed",
      "vaults.unlock.started",
      "vault.unlocked",
      "vault.awarded",
      "vaults.unlock.completed",
      "surge.collected",
      "rage.transformed",
      "wheel.started",
      "wheel.awarded",
    ]);

    expect(() => decodeServerMessage({
      ...result,
      totalWinMinor: "4225",
      events: canonicalEvents.map((event) => event.type === "wheel.awarded"
        ? { type: "wheel.awarded", outcome: "MYSTERY" }
        : event),
    })).toThrow(/outcome must be INSTANT, EXPANSION, or OVERDRIVE/);
    expect(() => decodeServerMessage({
      ...result,
      totalWinMinor: "4225",
      events: canonicalEvents.map((event) => event.type === "wheel.awarded"
        ? { type: "wheel.awarded", outcome: "EXPANSION", prize: "MINI" }
        : event),
    })).toThrow(/prize must be KONG_QUEST/);
  });

  it("accepts only canonical INSTANT tiers, multipliers, money, and BASE projection", () => {
    const wheelPrefix = [
      {
        type: "surge.collected", count: 1, cells: [{ reel: 2, row: 2 }],
        triggered: true, guaranteed: false, level: 1, total: 1,
      },
      {
        type: "rage.transformed", count: 2,
        cells: [{ reel: 0, row: 1 }, { reel: 2, row: 1 }], level: 1, total: 1,
      },
      { type: "wheel.started" },
    ];
    const instantResult = (award: Record<string, unknown>, totalWinMinor = "0") => ({
      ...result,
      wins: [],
      totalWinMinor,
      events: [...wheelPrefix, award],
      featureState: {
        mode: "BASE", freeSpinsRemaining: 0, freeSpinsPlayed: 0,
        rageLevel: 1, rageCollected: 0,
      },
    });
    const canonical = [
      ["MINI", 10, "1000"],
      ["MINOR", 30, "3000"],
      ["MAJOR", 75, "7500"],
      ["MEGA", 250, "25000"],
      ["GRAND", 1_000, "100000"],
    ] as const;

    for (const [prize, multiplier, amountMinor] of canonical) {
      const decoded = decodeServerMessage(instantResult({
        type: "wheel.awarded", outcome: "INSTANT", prize, multiplier, amountMinor,
      }, amountMinor));
      if (decoded.type !== "spin.result") throw new Error("unexpected message");
      expect(decoded.events.at(-1)).toEqual({
        type: "wheel.awarded", outcome: "INSTANT", prize, multiplier, amountMinor,
      });
    }

    for (const award of [
      { type: "wheel.awarded", outcome: "INSTANT", multiplier: 10, amountMinor: "1000" },
      { type: "wheel.awarded", outcome: "INSTANT", prize: "MINI", amountMinor: "1000" },
      { type: "wheel.awarded", outcome: "INSTANT", prize: "MINI", multiplier: 10 },
    ]) {
      expect(() => decodeServerMessage(instantResult(award)))
        .toThrow(ProtocolDecodeError);
    }
    expect(() => decodeServerMessage(instantResult({
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
      multiplier: 30, amountMinor: "3000",
    }, "3000"))).toThrow(/multiplier must equal 10 for MINI/);
    expect(() => decodeServerMessage(instantResult({
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
      multiplier: 10, amountMinor: "999",
    }, "999"))).toThrow(/amountMinor must equal betMinor multiplied by multiplier/);
    expect(() => decodeServerMessage(instantResult({
      type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
      multiplier: 10, amountMinor: "01000",
    }, "1000"))).toThrow(/signed-int64 minor-unit/);
    expect(() => decodeServerMessage({
      ...instantResult({
        type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
        multiplier: 1_000, amountMinor: "9223372036854775807",
      }, "9223372036854775807"),
      betMinor: "9223372036854775807",
    })).toThrow(/exceeds the signed-int64 money domain/);
    expect(() => decodeServerMessage({
      ...instantResult({
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10, amountMinor: "1000",
      }, "1000"),
      featureState: {
        mode: "OVERDRIVE", freeSpinsRemaining: 8, freeSpinsPlayed: 0,
        baseBetMinor: "100", freeSpinsWinMinor: "0", rageLevel: 1, rageCollected: 0,
      },
    })).toThrow(/next feature state as BASE/);
    expect(() => decodeServerMessage({
      ...instantResult({
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10, amountMinor: "1000",
      }, "1000"),
      events: [
        ...wheelPrefix,
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
          multiplier: 10, amountMinor: "1000",
        },
        { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      ],
    })).toThrow(/INSTANT must not start Free Spins/);
  });

  it("binds feature Wheel awards to their alias, adjacent start, and next state", () => {
    const wheelPrefix = [
      {
        type: "surge.collected", count: 1, cells: [{ reel: 2, row: 2 }],
        triggered: true, guaranteed: false, level: 1, total: 1,
      },
      {
        type: "rage.transformed", count: 2,
        cells: [{ reel: 0, row: 1 }, { reel: 2, row: 1 }], level: 1, total: 1,
      },
      { type: "wheel.started" },
    ];
    const featureResult = (
      award: Record<string, unknown>,
      mode: "EXPANSION" | "OVERDRIVE",
      between: readonly Record<string, unknown>[] = [],
    ) => ({
      ...result,
      wins: [],
      totalWinMinor: "0",
      events: [
        ...wheelPrefix,
        award,
        ...between,
        { type: "free_spins.started", mode, awarded: 8 },
      ],
      featureState: {
        mode, freeSpinsRemaining: 8, freeSpinsPlayed: 0,
        baseBetMinor: "100", freeSpinsWinMinor: "0", rageLevel: 1, rageCollected: 0,
      },
    });

    for (const [outcome, prize] of [
      ["EXPANSION", "KONG_QUEST"],
      ["OVERDRIVE", "KING_SPIN"],
    ] as const) {
      expect(() => decodeServerMessage(featureResult({
        type: "wheel.awarded", outcome,
      }, outcome))).not.toThrow();
      expect(() => decodeServerMessage(featureResult({
        type: "wheel.awarded", outcome, prize,
      }, outcome))).not.toThrow();
    }

    expect(() => decodeServerMessage(featureResult({
      type: "wheel.awarded", outcome: "EXPANSION", prize: "KING_SPIN",
    }, "EXPANSION"))).toThrow(/prize must be KONG_QUEST/);
    for (const moneyField of [
      { multiplier: 10 },
      { amountMinor: "1000" },
    ]) {
      expect(() => decodeServerMessage(featureResult({
        type: "wheel.awarded", outcome: "OVERDRIVE", ...moneyField,
      }, "OVERDRIVE"))).toThrow(/must not contain multiplier or amountMinor/);
    }
    expect(() => decodeServerMessage(featureResult({
      type: "wheel.awarded", outcome: "EXPANSION",
    }, "EXPANSION", [{
      type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }],
    }]))).toThrow(/must immediately follow wheel\.awarded/);
    expect(() => decodeServerMessage({
      ...featureResult({ type: "wheel.awarded", outcome: "EXPANSION" }, "EXPANSION"),
      events: [...wheelPrefix, { type: "wheel.awarded", outcome: "EXPANSION" }],
    })).toThrow(/require free_spins\.started/);
    expect(() => decodeServerMessage(featureResult({
      type: "wheel.awarded", outcome: "EXPANSION",
    }, "OVERDRIVE"))).toThrow(/wheel outcome must match/);
    expect(() => decodeServerMessage({
      ...featureResult({ type: "wheel.awarded", outcome: "OVERDRIVE" }, "OVERDRIVE"),
      featureState: {
        mode: "BASE", freeSpinsRemaining: 0, freeSpinsPlayed: 0,
        rageLevel: 1, rageCollected: 0,
      },
    })).toThrow(/project eight unplayed Free Spins/);
  });

  it("decodes active King feature state and complete Vault upgrades", () => {
    const events = [
      { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
      { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.upgrade.started", count: 1, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 2, fromMultiplier: 10,
        toMultiplier: 20, prize: "MINI_2X", step: 1,
      },
      { type: "vault.awarded", reel: 1, row: 2, prize: "MINI_2X", multiplier: 20, amountMinor: "2000" },
    ];
    const decoded = decodeServerMessage({
      ...result,
      totalWinMinor: "2225",
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "MINI_2X", multiplier: 20 }
          : cell
      ))),
      events,
      featureState: {
        mode: "OVERDRIVE",
        freeSpinsRemaining: 7,
        freeSpinsPlayed: 1,
        baseBetMinor: "100",
        freeSpinsWinMinor: "225",
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.featureState).toEqual({
      mode: "OVERDRIVE",
      freeSpinsRemaining: 7,
      freeSpinsPlayed: 1,
      baseBetMinor: "100",
      freeSpinsWinMinor: "225",
      rageLevel: 1,
      rageCollected: 0,
    });
    expect(decoded.events).toEqual(events);
  });

  it("rejects Vault mode, step-chain, amount, duplicate, and settled-grid drift", () => {
    const cells = [{ reel: 1, row: 2 }] as const;
    const settledKingGrid = result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 1 && rowIndex === 2
        ? { symbol: "VAULT" as const, prize: "MINI_2X", multiplier: 20 }
        : cell
    )));
    const kingEvents = [
      { type: "vaults.landed", count: 1, cells },
      { type: "vaults.unlock.started", count: 1, cells },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
      { type: "vaults.unlock.completed", count: 1, cells },
      { type: "vaults.upgrade.started", count: 1, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 2, fromMultiplier: 10,
        toMultiplier: 20, prize: "MINI_2X", step: 1,
      },
      {
        type: "vault.awarded", reel: 1, row: 2,
        prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
      },
    ];
    const kingMessage = {
      ...result,
      chargedBetMinor: "0",
      totalWinMinor: "2000",
      wins: [],
      grid: settledKingGrid,
      events: kingEvents,
      featureState: {
        mode: "OVERDRIVE", freeSpinsRemaining: 7, freeSpinsPlayed: 1,
        baseBetMinor: "100", freeSpinsWinMinor: "2000", rageLevel: 1, rageCollected: 0,
      },
    };
    expect(() => decodeServerMessage(kingMessage)).not.toThrow();

    expect(() => decodeServerMessage({
      ...kingMessage,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "FREE_SPIN" }
          : cell
      ))),
      totalWinMinor: "0",
      events: [
        { type: "vaults.landed", count: 1, cells },
        { type: "vaults.unlock.started", count: 1, cells },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
        { type: "free_spin.cap_reached", reel: 1, row: 2 },
        { type: "vaults.unlock.completed", count: 1, cells },
      ],
    })).toThrow(/outside Kong Quest/);

    expect(() => decodeServerMessage({
      ...kingMessage,
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        ...kingEvents,
      ],
      featureState: {
        ...kingMessage.featureState,
        mode: "EXPANSION",
      },
    })).toThrow(/outside King Spin/);

    expect(() => decodeServerMessage({
      ...kingMessage,
      events: [
        ...kingEvents.slice(0, 5),
        { type: "vaults.upgrade.started", count: 1, step: 1 },
        ...kingEvents.slice(5),
      ],
    })).toThrow(/group count|steps are not contiguous/);
    expect(() => decodeServerMessage({
      ...kingMessage,
      events: kingEvents.map((event) => event.type === "vault.upgraded"
        ? { ...event, fromMultiplier: 9 }
        : event),
    })).toThrow(/discontinuous/);
    expect(() => decodeServerMessage({
      ...kingMessage,
      totalWinMinor: "1999",
      events: kingEvents.map((event) => event.type === "vault.awarded"
        ? { ...event, amountMinor: "1999" }
        : event),
    })).toThrow(/chain, grid, or amount/);
    expect(() => decodeServerMessage({
      ...kingMessage,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2
          ? { symbol: "VAULT", prize: "MINI", multiplier: 10 }
          : cell
      ))),
    })).toThrow(/chain, grid, or amount/);
    expect(() => decodeServerMessage({
      ...kingMessage,
      totalWinMinor: "4000",
      events: [...kingEvents, kingEvents.at(-1)!],
    })).toThrow(/Duplicate Vault award/);
  });

  it("decodes expanded grids, Vault Free Spin outcomes, caps, and the terminal summary", () => {
    const expandedGrid = result.grid.map((reel) => [
      ...reel,
      { symbol: "PRISM" },
      { symbol: "PULSE" },
      { symbol: "TANK" },
    ]);
    const expanded = decodeServerMessage({
      ...result,
      grid: expandedGrid,
      events: [{ type: "grid.expanded", rows: 6, ways: 216 }],
      featureState: {
        mode: "EXPANSION",
        freeSpinsRemaining: 7,
        freeSpinsPlayed: 1,
        baseBetMinor: "100",
        freeSpinsWinMinor: "0",
        rageLevel: 1,
        rageCollected: 0,
      },
    });
    if (expanded.type !== "spin.result") throw new Error("unexpected message");
    expect(expanded.events[0]).toEqual({ type: "grid.expanded", rows: 6, ways: 216 });

    for (const terminalEvent of [
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
    ]) {
      const events = [
        { type: "grid.expanded", rows: 3, ways: 27 },
        { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
        terminalEvent,
        { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
      ];
      const decoded = decodeServerMessage({
        ...result,
        grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
          reelIndex === 1 && rowIndex === 2
            ? { symbol: "VAULT", prize: "FREE_SPIN" }
            : cell
        ))),
        events,
        featureState: {
          mode: "EXPANSION", freeSpinsRemaining: 7, freeSpinsPlayed: 1,
          baseBetMinor: "100", freeSpinsWinMinor: "225", rageLevel: 1, rageCollected: 0,
        },
      });
      if (decoded.type !== "spin.result") throw new Error("unexpected message");
      expect(decoded.events).toEqual(events);
    }

    const completed = decodeServerMessage({
      ...result,
      events: [{
        type: "free_spins.completed", mode: "OVERDRIVE",
        awarded: 8, cumulativeWinMinor: "12250",
      }],
    });
    if (completed.type !== "spin.result") throw new Error("unexpected message");
    expect(completed.events[0]).toEqual({
      type: "free_spins.completed", mode: "OVERDRIVE",
      awarded: 8, cumulativeWinMinor: "12250",
    });
  });

  it("requires the leading grid expansion on every Kong result and nowhere else", () => {
    const activeExpansion = {
      mode: "EXPANSION",
      freeSpinsRemaining: 7,
      freeSpinsPlayed: 1,
      baseBetMinor: "100",
      freeSpinsWinMinor: "0",
      rageLevel: 1,
      rageCollected: 0,
    };
    const fourRows = result.grid.map((reel) => [...reel, { symbol: "PRISM" }]);

    expect(() => decodeServerMessage({
      ...result,
      grid: fourRows,
      events: [],
      featureState: activeExpansion,
    })).toThrow(/must carry one leading grid\.expanded/);

    expect(() => decodeServerMessage({
      ...result,
      events: [],
      featureState: activeExpansion,
    })).toThrow(/must carry one leading grid\.expanded/);

    expect(() => decodeServerMessage({
      ...result,
      grid: fourRows,
      events: [{ type: "grid.expanded", rows: 4, ways: 64 }],
    })).toThrow(/must carry one leading grid\.expanded|only Kong Quest/);

    const nineRows = result.grid.map((reel) => [
      ...reel,
      ...Array.from({ length: 6 }, () => ({ symbol: "PRISM" })),
    ]);
    expect(() => decodeServerMessage({
      ...result,
      grid: nineRows,
      events: [{ type: "grid.expanded", rows: 9, ways: 729 }],
      featureState: activeExpansion,
    })).toThrow(/3-8 rows/);
  });

  it("returns an immutable surge trigger projection with its required PPS snapshot", () => {
    const sourceCells = [{ reel: 2, row: 2 }];
    const decoded = decodeServerMessage({
      ...result,
      events: [{
        type: "surge.collected",
        count: 1,
        cells: sourceCells,
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 1,
      }],
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    const event = decoded.events[0];
    if (event?.type !== "surge.collected") throw new Error("unexpected event");

    expect(event).toEqual({
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 2, row: 2 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    });
    expect(Object.isFrozen(decoded.events)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.cells)).toBe(true);
    expect(Object.isFrozen(event.cells[0])).toBe(true);

    sourceCells[0]!.row = 0;
    expect(event.cells[0]).toEqual({ reel: 2, row: 2 });
  });

  it("validates every surge coordinate against the settled grid", () => {
    const withTwoSurges = result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      (reelIndex === 1 && rowIndex === 2) || (reelIndex === 2 && rowIndex === 2)
        ? { symbol: "SURGE" }
        : cell
    )));
    const baseEvent = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 2, row: 2 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    };

    expect(() => decodeServerMessage({
      ...result,
      events: [{ ...baseEvent, cells: [{ reel: 3, row: 0 }] }],
    })).toThrow(/outside the grid/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{ ...baseEvent, cells: [{ reel: 0, row: 0 }] }],
    })).toThrow(/only settled SURGE cells/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{ ...baseEvent, count: 2, cells: [{ reel: 2, row: 2 }, { reel: 2, row: 2 }] }],
    })).toThrow(/duplicate addresses/);
    expect(() => decodeServerMessage({
      ...result,
      grid: withTwoSurges,
      events: [baseEvent],
    })).toThrow(/every settled SURGE cell exactly once/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{ ...baseEvent, count: 2 }],
    })).toThrow(/count must equal .*cells length/);
  });

  it("enforces probabilistic and guaranteed surge trigger semantics", () => {
    const guaranteedGrid = result.grid.map((reel) => reel.map((cell, rowIndex) => (
      rowIndex === 2 ? { symbol: "SURGE" } : cell
    )));
    const guaranteedEvent = {
      type: "surge.collected",
      count: 3,
      cells: [{ reel: 0, row: 2 }, { reel: 1, row: 2 }, { reel: 2, row: 2 }],
      triggered: true,
      guaranteed: true,
      level: 1,
      total: 0,
    };
    const wheelStarted = { type: "wheel.started" };
    const wheelEvent = { type: "wheel.awarded", outcome: "EXPANSION" };
    const freeSpinsStarted = { type: "free_spins.started", mode: "EXPANSION", awarded: 8 };
    const decoded = decodeServerMessage({
      ...result,
      grid: guaranteedGrid,
      events: [guaranteedEvent, wheelStarted, wheelEvent, freeSpinsStarted],
      featureState: {
        mode: "EXPANSION", freeSpinsRemaining: 8, freeSpinsPlayed: 0,
        baseBetMinor: "100", freeSpinsWinMinor: "0", rageLevel: 1, rageCollected: 0,
      },
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.events[0]).toEqual(guaranteedEvent);

    expect(() => decodeServerMessage({
      ...result,
      grid: guaranteedGrid,
      events: [{ ...guaranteedEvent, triggered: false }],
    })).toThrow(/triggered must be true/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{
        type: "surge.collected", count: 1,
        cells: [{ reel: 2, row: 2 }], triggered: true, guaranteed: true,
        level: 1, total: 1,
      }],
    })).toThrow(/guaranteed must be true exactly/);

    const fourRageGrid = guaranteedGrid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 0 && rowIndex === 1 ? { symbol: "SURGE" } : cell
    )));
    expect(() => decodeServerMessage({
      ...result,
      grid: fourRageGrid,
      events: [{
        ...guaranteedEvent,
        count: 4,
        cells: [
          { reel: 0, row: 1 }, { reel: 0, row: 2 },
          { reel: 1, row: 2 }, { reel: 2, row: 2 },
        ],
      }, wheelStarted, wheelEvent, freeSpinsStarted],
      featureState: {
        mode: "EXPANSION", freeSpinsRemaining: 8, freeSpinsPlayed: 0,
        baseBetMinor: "100", freeSpinsWinMinor: "0", rageLevel: 1, rageCollected: 0,
      },
    })).toThrow(/count must be an integer from 1 to 3/);
  });

  it("requires the explicit trigger flag to match a following wheel event", () => {
    const surge = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 2, row: 2 }],
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 1,
    };
    const transformed = {
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 0, row: 1 }, { reel: 2, row: 1 }],
      level: 1,
      total: 1,
    };
    const started = { type: "wheel.started" };
    const wheel = { type: "wheel.awarded", outcome: "EXPANSION" };
    const freeSpins = { type: "free_spins.started", mode: "EXPANSION", awarded: 8 };
    const decoded = decodeServerMessage({
      ...result,
      events: [surge, transformed, started, wheel, freeSpins],
      featureState: {
        mode: "EXPANSION", freeSpinsRemaining: 8, freeSpinsPlayed: 0,
        baseBetMinor: "100", freeSpinsWinMinor: "0", rageLevel: 1, rageCollected: 0,
      },
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.events.map((event) => event.type)).toEqual([
      "surge.collected", "rage.transformed", "wheel.started", "wheel.awarded", "free_spins.started",
    ]);

    expect(() => decodeServerMessage({ ...result, events: [surge] }))
      .toThrow(/triggered must match wheel event presence/);
    expect(() => decodeServerMessage({ ...result, events: [wheel, surge] }))
      .toThrow(/wheel\.started and wheel\.awarded must occur together/);
    expect(() => decodeServerMessage({ ...result, events: [started, wheel, surge, transformed] }))
      .toThrow(/surge\.collected must precede wheel\.started/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{ ...surge, triggered: false }, transformed, started, wheel],
    })).toThrow(/triggered must match wheel event presence/);
  });

  it("decodes a zero-total PPS RESET transformation and rejects negative totals", () => {
    const surge = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 2, row: 2 }],
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 0,
    };
    const transformed = {
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
      level: 1,
      total: 0,
    };
    const suffix = [
      { type: "wheel.started" },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10, amountMinor: "1000",
      },
    ];
    const candidate = {
      ...result,
      wins: [],
      totalWinMinor: "1000",
      events: [surge, transformed, ...suffix],
      featureState: {
        mode: "BASE", freeSpinsRemaining: 0, freeSpinsPlayed: 0,
        rageLevel: 1, rageCollected: 0,
      },
    };

    const decoded = decodeServerMessage(candidate);
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.events[1]).toMatchObject({ type: "rage.transformed", level: 1, total: 0 });

    expect(() => decodeServerMessage({
      ...candidate,
      events: [surge, { ...transformed, total: -1 }, ...suffix],
    })).toThrow(/events\[1\]\.total must be an integer from 0 to 1000000/);
  });

  it("requires both Rage PPS snapshots and rejects transformation state drift", () => {
    const surge = {
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 2, row: 2 }],
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 1,
    };
    const transformed = {
      type: "rage.transformed",
      count: 2,
      cells: [{ reel: 0, row: 1 }, { reel: 1, row: 1 }],
      level: 1,
      total: 1,
    };
    const suffix = [
      { type: "wheel.started" },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10, amountMinor: "1000",
      },
    ];
    const candidate = {
      ...result,
      wins: [],
      totalWinMinor: "1000",
      events: [surge, transformed, ...suffix],
      featureState: {
        mode: "BASE", freeSpinsRemaining: 0, freeSpinsPlayed: 0,
        rageLevel: 1, rageCollected: 1,
      },
    };
    expect(() => decodeServerMessage(candidate)).not.toThrow();

    const { level: _surgeLevel, ...surgeWithoutLevel } = surge;
    expect(() => decodeServerMessage({
      ...candidate,
      events: [surgeWithoutLevel, transformed, ...suffix],
    })).toThrow(/\.level must be a finite number/);

    const { total: _transformedTotal, ...transformedWithoutTotal } = transformed;
    expect(() => decodeServerMessage({
      ...candidate,
      events: [surge, transformedWithoutTotal, ...suffix],
    })).toThrow(/\.total must be a finite number/);

    for (const drift of [{ level: 2 }, { total: 2 }]) {
      expect(() => decodeServerMessage({
        ...candidate,
        events: [surge, { ...transformed, ...drift }, ...suffix],
      })).toThrow(/rage\.transformed must complete/);
    }
  });

  it("rejects reordered or incomplete authoritative feature transitions", () => {
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "wheel.started" }],
    })).toThrow(/wheel\.started and wheel\.awarded must occur together/);

    const landed = { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] };
    const started = { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] };
    const completed = { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] };
    expect(() => decodeServerMessage({
      ...result,
      events: [landed, completed, started],
    })).toThrow(/unlock start\/completion events must be an ordered pair/);

    expect(() => decodeServerMessage({
      ...result,
      events: [
        landed,
        started,
        { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
        completed,
        {
          type: "vault.upgraded", reel: 1, row: 2, fromMultiplier: 10,
          toMultiplier: 20, prize: "MINI_2X", step: 1,
        },
      ],
    })).toThrow(/matching upgrade start/);

    expect(() => decodeServerMessage({
      ...result,
      events: [
        { type: "free_spins.completed", mode: "EXPANSION", awarded: 8, cumulativeWinMinor: "100" },
        { type: "grid.expanded", rows: 3, ways: 27 },
      ],
    })).toThrow(/grid\.expanded must be first|free_spins\.completed must be the final event/);
  });

  it("rejects unknown and structurally extended feature events", () => {
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "future.event", payload: "unsafe" }],
    })).toThrow(/unsupported feature event/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{
        type: "surge.collected", count: 1,
        cells: [{ reel: 2, row: 2 }], triggered: false, guaranteed: false,
        level: 1, total: 1,
        unexpected: true,
      }],
    })).toThrow(/is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{
        type: "wheel.awarded", outcome: "MINOR",
        cells: [{ reel: 2, row: 2 }], triggered: false, guaranteed: false,
      }],
    })).toThrow(/is not allowed/);
  });

  it("rejects malformed fields inside known feature events", () => {
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "free_spins.started", mode: "BASE", awarded: 8 }],
    })).toThrow(/EXPANSION or OVERDRIVE/);
    for (const awarded of [7, 9, 11]) {
      expect(() => decodeServerMessage({
        ...result,
        events: [{ type: "free_spins.started", mode: "EXPANSION", awarded }],
      })).toThrow(/must equal the captured initial 8/);
    }
    expect(() => decodeServerMessage({
      ...result,
      events: [{ type: "vault.awarded", reel: 1, row: 2, multiplier: 1.5, amountMinor: "100" }],
    })).toThrow(/must be an integer/);
    expect(() => decodeServerMessage({
      ...result,
      events: [{
        type: "surge.collected", count: 1,
        cells: [{ reel: 2, row: 2 }], guaranteed: false,
        level: 1, total: 1,
      }],
    })).toThrow(/triggered must be boolean/);
  });

  it("accounts visible wins plus only monetary wheel and Vault events using BigInt", () => {
    const vaultEvents = [
      { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vaults.unlock.started", count: 1, cells: [{ reel: 1, row: 2 }] },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
      { type: "vault.awarded", reel: 1, row: 2, prize: "MINI", multiplier: 10, amountMinor: "1000" },
      { type: "vaults.unlock.completed", count: 1, cells: [{ reel: 1, row: 2 }] },
    ];
    const settledVaultGrid = result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 1 && rowIndex === 2
        ? { symbol: "VAULT" as const, prize: "MINI", multiplier: 10 }
        : cell
    )));
    const decoded = decodeServerMessage({
      ...result, grid: settledVaultGrid, totalWinMinor: "1225", events: vaultEvents,
    });
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.totalWinMinor).toBe("1225");

    expect(() => decodeServerMessage({
      ...result, grid: settledVaultGrid, totalWinMinor: "225", events: vaultEvents,
    }))
      .toThrow(/sum of visible win and monetary event awards/);

    const huge = "9007199254740993";
    const hugeResult = decodeServerMessage({
      ...result,
      totalWinMinor: huge,
      wins: [{ ...result.wins[0], amountMinor: huge }],
    });
    if (hugeResult.type !== "spin.result") throw new Error("unexpected message");
    expect(hugeResult.totalWinMinor).toBe(huge);

    const aboveSignedInt64 = "9223372036854775808";
    expect(() => decodeServerMessage({
      ...result,
      totalWinMinor: aboveSignedInt64,
      wins: [{ ...result.wins[0], amountMinor: aboveSignedInt64 }],
    })).toThrow(/signed-int64/);
  });

  it("rejects duplicate win ids and semantic Ways paths across records", () => {
    const modernWin = authoritativeWaysResult.wins[0];
    if (!modernWin) throw new Error("missing fixture win");

    expect(() => decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: "450",
      wins: [modernWin, { ...modernWin }],
    })).toThrow(/duplicate ids/);

    expect(() => decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: "450",
      wins: [
        modernWin,
        { ...modernWin, id: "win-2", pathAwards: [...modernWin.pathAwards].reverse() },
      ],
    })).toThrow(/duplicate semantic path sets/);

    const firstPath = modernWin.pathAwards[0];
    if (!firstPath) throw new Error("missing fixture path");
    expect(() => decodeServerMessage({
      ...authoritativeWaysResult,
      totalWinMinor: "300",
      wins: [modernWin, {
        ...modernWin,
        id: "win-2",
        ways: 1,
        amountMinor: "75",
        cells: firstPath.cells,
        pathAwards: [firstPath],
      }],
    })).toThrow(/reuse a path from another win/);
  });

  it("accepts a zero-value path when its positive aggregate remains authoritative", () => {
    const zeroPath = {
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 2 }, { reel: 2, row: 0 }],
      multiplier: 1,
      baseAmountMinor: "0",
      amountMinor: "0",
    };
    const zeroPathResult = {
      ...authoritativeWaysResult,
      grid: authoritativeWaysResult.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 2 ? { symbol: "WILD", multiplier: 1 } : cell
      ))),
      wins: [{
        ...authoritativeWaysResult.wins[0],
        ways: 3,
        cells: [
          ...authoritativeWaysResult.wins[0]!.cells,
          { reel: 1, row: 2 },
        ],
        pathAwards: [
          ...authoritativeWaysResult.wins[0]!.pathAwards,
          zeroPath,
        ],
      }],
    };
    const decoded = decodeServerMessage(zeroPathResult);
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.wins[0]?.pathAwards?.[2]?.amountMinor).toBe("0");

    const { baseAmountMinor: _baseAmountMinor, ...withoutBaseAmount } = zeroPath;
    expect(() => decodeServerMessage({
      ...zeroPathResult,
      wins: [{
        ...zeroPathResult.wins[0],
        pathAwards: [
          ...authoritativeWaysResult.wins[0]!.pathAwards,
          withoutBaseAmount,
        ],
      }],
    })).toThrow(/baseAmountMinor/);
  });

  it("requires every authoritative spin projection field", () => {
    const { chargedBetMinor: _chargedBetMinor, ...withoutChargedBet } = result;
    const { events: _events, ...withoutEvents } = result;
    const { featureState: _featureState, ...withoutFeatureState } = result;
    expect(() => decodeServerMessage(withoutChargedBet)).toThrow(/chargedBetMinor/);
    expect(() => decodeServerMessage(withoutEvents)).toThrow(/events/);
    expect(() => decodeServerMessage(withoutFeatureState)).toThrow(/featureState/);
  });

  it("rejects extra keys at every nested protocol boundary", () => {
    expect(() => decodeServerMessage({ ...result, extra: true })).toThrow(/message.extra is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      reelPresentation: { stripSet: {}, stops: [] },
    })).toThrow(/message.reelPresentation is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      grid: result.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 0 && rowIndex === 0 ? { ...cell, extra: true } : cell
      ))),
    })).toThrow(/grid\[0\]\[0\]\.extra is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      wins: [{ ...result.wins[0], extra: true }],
    })).toThrow(/wins\[0\]\.extra is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      wins: [{
        ...result.wins[0],
        cells: [{ reel: 0, row: 0, extra: true }],
      }],
    })).toThrow(/wins\[0\]\.cells\[0\]\.extra is not allowed/);
    expect(() => decodeServerMessage({
      ...result,
      featureState: { ...result.featureState, extra: true },
    })).toThrow(/featureState.extra is not allowed/);
  });

  it("keeps protocol v2 outside the strict v1 decoder until a decoder is implemented", () => {
    expect(() => decodeServerMessage({ ...result, protocolVersion: 2 }))
      .toThrow(/protocolVersion must equal 1/);
  });

  it("enforces identifiers and required error fields", () => {
    expect(() => decodeServerMessage({ ...result, requestId: "bad id" })).toThrow(/protocol identifier/);
    expect(() => decodeServerMessage({
      type: "error",
      protocolVersion: 1,
      code: "ROUND_CONFLICT",
      message: "conflict",
    })).toThrow(/retryable/);
    expect(() => decodeServerMessage({
      type: "error",
      protocolVersion: 1,
      code: "ROUND_CONFLICT",
      message: "conflict",
      retryable: false,
      extra: true,
    })).toThrow(/message.extra is not allowed/);
  });

  it("enforces schema collection and message limits", () => {
    const opened = {
      type: "session.opened",
      protocolVersion: 1,
      engineRulesVersion: ENGINE_RULES_VERSION,
      requestId: "request-2",
      sessionId: "session-1",
      balanceMinor: "10000",
      betOptionsMinor: ["100", "100"],
      defaultBetMinor: "100",
      featureState: { mode: "BASE", freeSpinsRemaining: 0 },
    };
    expect(() => decodeServerMessage(opened)).toThrow(/must be unique/);
    expect(() => decodeServerMessage({
      ...opened,
      betOptionsMinor: ["100"],
      engineRulesVersion: "slots-game-ways3-features-v3",
    })).toThrow(/engineRulesVersion must equal/);
    const { engineRulesVersion: _engineRulesVersion, ...openedWithoutEngineRules } = opened;
    expect(() => decodeServerMessage({
      ...openedWithoutEngineRules,
      betOptionsMinor: ["100"],
    })).toThrow(/engineRulesVersion must equal/);
    expect(() => decodeServerMessage({
      type: "error",
      protocolVersion: 1,
      code: "ERROR",
      message: "x".repeat(513),
      retryable: false,
    })).toThrow(/at most 512/);
    expect(() => decodeServerMessage({
      ...result,
      wins: [{
        ...result.wins[0],
        cells: Array.from({ length: 257 }, () => ({ reel: 0, row: 0 })),
      }],
    })).toThrow(/1-256 entries/);
  });
});
