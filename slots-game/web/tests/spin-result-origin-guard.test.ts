import { describe, expect, it } from "vitest";
import type { FeatureState, GridCell, SpinResult } from "../src/app/state/types";
import {
  SpinResultOriginError,
  validateSpinResultAgainstOrigin,
} from "../src/protocol/spinResultOriginGuard";

const BASE_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};

const THREE_ROWS: GridCell[][] = [
  [{ symbol: "PRISM" }, { symbol: "PULSE" }, { symbol: "PRISM" }],
  [{ symbol: "ORBIT" }, { symbol: "NOVA" }, { symbol: "ORBIT" }],
  [{ symbol: "CIRCUIT" }, { symbol: "TANK" }, { symbol: "CIRCUIT" }],
];

const RAGE_CELLS = [
  { reel: 0, row: 2 },
  { reel: 1, row: 2 },
  { reel: 2, row: 2 },
] as const;

const GUARANTEED_RAGE_GRID: GridCell[][] = THREE_ROWS.map((reel, reelIndex) => (
  reel.map((cell, rowIndex) => (
    rowIndex === 2 ? { symbol: "SURGE" as const } : cell
  ))
));

const GUARANTEED_RAGE_COLLECTION = {
  type: "surge.collected" as const,
  count: 3,
  cells: RAGE_CELLS,
  triggered: true,
  guaranteed: true,
  level: 1,
  total: 0,
};

function freeSpinVaultGrid(row = 1): GridCell[][] {
  return THREE_ROWS.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
    reelIndex === 1 && rowIndex === row
      ? { symbol: "VAULT" as const, prize: "FREE_SPIN" }
      : cell
  )));
}

function kongFreeSpinVaultEvents(row = 1) {
  const cells = [{ reel: 1, row }] as const;
  return [
    { type: "grid.expanded" as const, rows: 3, ways: 27 },
    { type: "vaults.landed" as const, count: 1, cells },
    { type: "vaults.unlock.started" as const, count: 1, cells },
    { type: "vault.unlocked" as const, reel: 1, row, prize: "FREE_SPIN" },
    { type: "free_spin.awarded" as const, count: 1, reel: 1, row },
    { type: "vaults.unlock.completed" as const, count: 1, cells },
  ];
}

function featureState(
  mode: "EXPANSION" | "OVERDRIVE",
  remaining: number,
  played: number,
  win = "0",
): FeatureState {
  return {
    mode,
    freeSpinsRemaining: remaining,
    freeSpinsPlayed: played,
    baseBetMinor: "100",
    freeSpinsWinMinor: win,
    rageLevel: 1,
    rageCollected: 0,
  };
}

function spinResult(overrides: Partial<SpinResult> = {}): SpinResult {
  return {
    type: "spin.result",
    protocolVersion: 1,
    requestId: "request-1",
    sessionId: "session-1",
    roundId: "round-1",
    sequence: 1,
    betMinor: "100",
    chargedBetMinor: "0",
    balanceMinor: "100000",
    totalWinMinor: "0",
    grid: THREE_ROWS,
    wins: [],
    events: [],
    featureState: BASE_FEATURE,
    ...overrides,
  };
}

describe("validateSpinResultAgainstOrigin", () => {
  it("binds a Base result's charged amount to its submitted bet", () => {
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "100",
    }))).not.toThrow();
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "0",
    }))).toThrow(/charge exactly their submitted bet/);
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "200",
    }))).toThrow(/charge exactly their submitted bet/);
  });

  it("accepts only the captured eight-spin projection at a Base feature start", () => {
    const valid = spinResult({
      chargedBetMinor: "100",
      grid: GUARANTEED_RAGE_GRID,
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        { type: "wheel.awarded", outcome: "EXPANSION" },
        { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      ],
      featureState: featureState("EXPANSION", 8, 0),
    });
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, valid)).not.toThrow();

    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        { type: "wheel.awarded", outcome: "EXPANSION" },
        { type: "free_spins.started", mode: "EXPANSION", awarded: 7 },
      ],
      featureState: featureState("EXPANSION", 7, 0),
    })).toThrow(/exactly 8/);

    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      grid: THREE_ROWS,
      events: [{ type: "free_spins.started", mode: "EXPANSION", awarded: 8 }],
    })).toThrow(/without settled Rage|matching Primal Wheel/);
  });

  it("validates canonical INSTANT awards against the submitted bet and BASE projection", () => {
    const valid = spinResult({
      chargedBetMinor: "100",
      totalWinMinor: "1000",
      grid: GUARANTEED_RAGE_GRID,
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
          multiplier: 10, amountMinor: "1000",
        },
      ],
    });
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, valid)).not.toThrow();

    for (const award of [
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 30, amountMinor: "3000",
      },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10, amountMinor: "999",
      },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "UNKNOWN",
        multiplier: 10, amountMinor: "1000",
      },
      {
        type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
        multiplier: 10,
      },
    ]) {
      expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
        ...valid,
        events: [GUARANTEED_RAGE_COLLECTION, { type: "wheel.started" }, award],
      } as unknown as SpinResult)).toThrow(SpinResultOriginError);
    }

    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      events: [
        ...valid.events,
        { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
      ],
    })).toThrow(/INSTANT must not start/);
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      featureState: featureState("OVERDRIVE", 8, 0),
    })).toThrow(/next feature state as BASE/);
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      betMinor: "9223372036854775807",
      chargedBetMinor: "9223372036854775807",
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
          multiplier: 1_000, amountMinor: "9223372036854775807",
        },
      ],
    })).toThrow(/exceeds the signed-int64/);
  });

  it("rejects malformed feature Wheel aliases, money fields, and non-adjacent starts", () => {
    const valid = spinResult({
      chargedBetMinor: "100",
      grid: GUARANTEED_RAGE_GRID,
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
        { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
      ],
      featureState: featureState("OVERDRIVE", 8, 0),
    });
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, valid)).not.toThrow();

    for (const award of [
      { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KONG_QUEST" },
      { type: "wheel.awarded", outcome: "OVERDRIVE", multiplier: 10 },
      { type: "wheel.awarded", outcome: "OVERDRIVE", amountMinor: "1000" },
      { type: "wheel.awarded", outcome: "MYSTERY" },
    ]) {
      expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
        ...valid,
        events: [
          GUARANTEED_RAGE_COLLECTION,
          { type: "wheel.started" },
          award,
          { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
        ],
      } as unknown as SpinResult)).toThrow(SpinResultOriginError);
    }

    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, {
      ...valid,
      events: [
        GUARANTEED_RAGE_COLLECTION,
        { type: "wheel.started" },
        { type: "wheel.awarded", outcome: "OVERDRIVE" },
        { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 1 }] },
        { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
      ],
    })).toThrow(SpinResultOriginError);
  });

  it("requires a leading expansion event even on a three-row Kong result", () => {
    const origin = featureState("EXPANSION", 3, 5, "100");
    const valid = spinResult({
      totalWinMinor: "25",
      events: [{ type: "grid.expanded", rows: 3, ways: 27 }],
      featureState: featureState("EXPANSION", 2, 6, "125"),
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();

    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [],
    })).toThrow(/requires a leading/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [{ type: "grid.expanded", rows: 3, ways: 64 }],
    })).toThrow(/uniquely match/);
  });

  it("rejects expanded rows or semantics outside a Kong-origin round", () => {
    const fourRows = THREE_ROWS.map((reel) => [...reel, { symbol: "PRISM" as const }]);
    expect(() => validateSpinResultAgainstOrigin(featureState("OVERDRIVE", 3, 5), spinResult({
      grid: fourRows,
      events: [{ type: "grid.expanded", rows: 4, ways: 64 }],
      featureState: featureState("OVERDRIVE", 2, 6),
    }))).toThrow(/Only a Kong Quest origin/);
  });

  it("conserves Kong retrigger counters and cumulative win", () => {
    const origin = featureState("EXPANSION", 5, 3, "100");
    const valid = spinResult({
      totalWinMinor: "25",
      grid: freeSpinVaultGrid(),
      events: kongFreeSpinVaultEvents(),
      featureState: featureState("EXPANSION", 5, 4, "125"),
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();

    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      featureState: featureState("EXPANSION", 4, 4, "125"),
    })).toThrow(/counter or win conservation/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      featureState: featureState("EXPANSION", 5, 4, "124"),
    })).toThrow(/counter or win conservation/);
  });

  it("accepts terminal conservation only with the final matching completion", () => {
    const origin = featureState("EXPANSION", 1, 7, "100");
    const valid = spinResult({
      totalWinMinor: "25",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        {
          type: "free_spins.completed",
          mode: "EXPANSION",
          awarded: 8,
          cumulativeWinMinor: "125",
        },
      ],
      featureState: BASE_FEATURE,
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();

    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: valid.events.map((event) => event.type === "free_spins.completed"
        ? { ...event, awarded: 9 }
        : event),
    })).toThrow(/completion conservation/);
  });

  it("rejects extra-spin awards in King Spin and any charged Free Spin", () => {
    const origin = featureState("OVERDRIVE", 2, 6);
    const next = featureState("OVERDRIVE", 1, 7);
    expect(() => validateSpinResultAgainstOrigin(origin, spinResult({
      grid: freeSpinVaultGrid(),
      events: kongFreeSpinVaultEvents().slice(1),
      featureState: next,
    }))).toThrow(/outside Kong Quest/);
    expect(() => validateSpinResultAgainstOrigin(origin, spinResult({
      chargedBetMinor: "100",
      featureState: next,
    }))).toThrow(/must be uncharged/);
  });

  it("rejects CAP in King Spin and upgrades in Kong Quest", () => {
    const kingOrigin = featureState("OVERDRIVE", 2, 6);
    const kingCells = [{ reel: 1, row: 1 }] as const;
    expect(() => validateSpinResultAgainstOrigin(kingOrigin, spinResult({
      grid: freeSpinVaultGrid(),
      events: [
        { type: "vaults.landed", count: 1, cells: kingCells },
        { type: "vaults.unlock.started", count: 1, cells: kingCells },
        { type: "vault.unlocked", reel: 1, row: 1, prize: "FREE_SPIN" },
        { type: "free_spin.cap_reached", reel: 1, row: 1 },
        { type: "vaults.unlock.completed", count: 1, cells: kingCells },
      ],
      featureState: featureState("OVERDRIVE", 1, 7),
    }))).toThrow(/outside Kong Quest/);

    const kongOrigin = featureState("EXPANSION", 2, 6);
    const payableGrid = THREE_ROWS.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 1 && rowIndex === 1
        ? { symbol: "VAULT" as const, prize: "MINI_2X", multiplier: 20 }
        : cell
    )));
    expect(() => validateSpinResultAgainstOrigin(kongOrigin, spinResult({
      grid: payableGrid,
      totalWinMinor: "2000",
      events: [
        { type: "grid.expanded", rows: 3, ways: 27 },
        { type: "vaults.landed", count: 1, cells: kingCells },
        { type: "vaults.unlock.started", count: 1, cells: kingCells },
        { type: "vault.unlocked", reel: 1, row: 1, prize: "MINI", multiplier: 10 },
        { type: "vaults.unlock.completed", count: 1, cells: kingCells },
        { type: "vaults.upgrade.started", count: 1, step: 1 },
        {
          type: "vault.upgraded", reel: 1, row: 1, step: 1,
          fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X",
        },
        {
          type: "vault.awarded", reel: 1, row: 1,
          prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
        },
      ],
      featureState: featureState("EXPANSION", 1, 7, "2000"),
    }))).toThrow(/outside King Spin/);
  });

  it("validates every King Spin step, chain edge, final award, and settled Vault", () => {
    const origin = featureState("OVERDRIVE", 2, 6);
    const cells = [{ reel: 1, row: 1 }] as const;
    const grid = THREE_ROWS.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 1 && rowIndex === 1
        ? { symbol: "VAULT" as const, prize: "MINI_2X", multiplier: 20 }
        : cell
    )));
    const events: SpinResult["events"] = [
      { type: "vaults.landed", count: 1, cells },
      { type: "vaults.unlock.started", count: 1, cells },
      { type: "vault.unlocked", reel: 1, row: 1, prize: "MINI", multiplier: 10 },
      { type: "vaults.unlock.completed", count: 1, cells },
      { type: "vaults.upgrade.started", count: 1, step: 1 },
      {
        type: "vault.upgraded", reel: 1, row: 1, step: 1,
        fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X",
      },
      {
        type: "vault.awarded", reel: 1, row: 1,
        prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
      },
    ];
    const valid = spinResult({
      grid,
      totalWinMinor: "2000",
      events,
      featureState: featureState("OVERDRIVE", 1, 7, "2000"),
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();

    const replaceEvent = (index: number, event: SpinResult["events"][number]): SpinResult => ({
      ...valid,
      events: valid.events.map((candidate, candidateIndex) => (
        candidateIndex === index ? event : candidate
      )),
    });
    expect(() => validateSpinResultAgainstOrigin(origin, replaceEvent(4, {
      type: "vaults.upgrade.started", count: 1, step: 2,
    }))).toThrow(/steps are not contiguous/);
    expect(() => validateSpinResultAgainstOrigin(origin, replaceEvent(5, {
      type: "vault.upgraded", reel: 1, row: 1, step: 1,
      fromMultiplier: 9, toMultiplier: 20, prize: "MINI_2X",
    }))).toThrow(/discontinuous/);
    expect(() => validateSpinResultAgainstOrigin(origin, replaceEvent(6, {
      type: "vault.awarded", reel: 1, row: 1,
      prize: "MINI_2X", multiplier: 20, amountMinor: "1999",
    }))).toThrow(/chain, grid, or amount/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      grid: valid.grid.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
        reelIndex === 1 && rowIndex === 1
          ? { symbol: "VAULT" as const, prize: "MINI", multiplier: 10 }
          : cell
      ))),
    })).toThrow(/chain, grid, or amount/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [...valid.events, valid.events[6]!],
    })).toThrow(/Duplicate Vault award/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [
        ...valid.events.slice(0, 5),
        { type: "vaults.upgrade.started", count: 1, step: 1 },
        ...valid.events.slice(5),
      ],
    })).toThrow(/group count|steps are not contiguous/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [
        ...valid.events.slice(0, 4),
        { type: "vaults.upgrade.started", count: 2, step: 1 },
        valid.events[5]!,
        {
          type: "vault.upgraded", reel: 1, row: 1, step: 1,
          fromMultiplier: 20, toMultiplier: 30, prize: "MINOR",
        },
        valid.events[6]!,
      ],
    })).toThrow(/Duplicate Vault in one King Spin upgrade step/);
  });

  it("conserves an empty or non-triggering Base Rage meter", () => {
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "100",
      featureState: { ...BASE_FEATURE, rageCollected: 1 },
    }))).toThrow(/Empty Base spin changed/);

    const oneRageGrid = THREE_ROWS.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 0 && rowIndex === 2 ? { symbol: "SURGE" as const } : cell
    )));
    const origin: FeatureState = { ...BASE_FEATURE, rageLevel: 2, rageCollected: 4 };
    const collection = {
      type: "surge.collected" as const,
      count: 1,
      cells: [{ reel: 0, row: 2 }],
      triggered: false,
      guaranteed: false,
      level: 3,
      total: 5,
    };
    const valid = spinResult({
      chargedBetMinor: "100",
      grid: oneRageGrid,
      events: [collection],
      featureState: { ...BASE_FEATURE, rageLevel: 3, rageCollected: 5 },
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();
    for (const invalidCollection of [
      { ...collection, count: 2 },
      { ...collection, cells: [{ reel: 1, row: 2 }] },
      { ...collection, total: 4 },
      { ...collection, level: undefined },
      { ...collection, guaranteed: true },
    ]) {
      expect(() => validateSpinResultAgainstOrigin(origin, {
        ...valid,
        events: [invalidCollection] as SpinResult["events"],
      })).toThrow(SpinResultOriginError);
    }
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      featureState: { ...valid.featureState, rageCollected: 4 },
    })).toThrow(/credited PPS meter/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: [{ ...collection, triggered: true, level: 1, total: 0 }],
    })).toThrow(/ordered Wheel start and award|invalid transformation/);
  });

  it("requires a one/two-Rage trigger to transform exactly to three before the Wheel", () => {
    const grid = THREE_ROWS.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      rowIndex === 2 && reelIndex !== 1 ? { symbol: "SURGE" as const } : cell
    )));
    const origin: FeatureState = { ...BASE_FEATURE, rageLevel: 2, rageCollected: 4 };
    const collection = {
      type: "surge.collected" as const,
      count: 2,
      cells: [{ reel: 0, row: 2 }, { reel: 2, row: 2 }],
      triggered: true,
      guaranteed: false,
      level: 1,
      total: 0,
    };
    const transformation = {
      type: "rage.transformed" as const,
      count: 1,
      cells: [{ reel: 1, row: 0 }],
      level: 1,
      total: 0,
    };
    const valid = spinResult({
      chargedBetMinor: "100",
      grid,
      totalWinMinor: "1000",
      events: [
        collection,
        transformation,
        { type: "wheel.started" },
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
          multiplier: 10, amountMinor: "1000",
        },
      ],
      featureState: { ...BASE_FEATURE, rageLevel: 1, rageCollected: 0 },
    });
    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      featureState: { ...BASE_FEATURE, rageLevel: 3, rageCollected: 6 },
    })).toThrow(/did not reset the authoritative PPS meter/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: valid.events.map((event) => event.type === "rage.transformed"
        ? { ...event, count: 2 }
        : event),
    })).toThrow(/invalid transformation/);
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      events: valid.events.map((event) => event.type === "rage.transformed"
        ? { ...event, cells: [{ reel: 0, row: 2 }] }
        : event),
    })).toThrow(/invalid transformation/);
    for (const drift of [{ level: 2 }, { total: 1 }]) {
      expect(() => validateSpinResultAgainstOrigin(origin, {
        ...valid,
        events: valid.events.map((event) => event.type === "rage.transformed"
          ? { ...event, ...drift }
          : event),
      })).toThrow(/invalid transformation/);
    }
  });

  it("requires three settled Rage symbols to trigger the Wheel", () => {
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "100",
      grid: GUARANTEED_RAGE_GRID,
      events: [{ ...GUARANTEED_RAGE_COLLECTION, triggered: false }],
      featureState: BASE_FEATURE,
    }))).toThrow(/does not match the settled Rage set/);
  });

  it("preserves the request-origin PPS meter for a direct-three Wheel", () => {
    const origin: FeatureState = { ...BASE_FEATURE, rageLevel: 4, rageCollected: 30 };
    const collection = {
      ...GUARANTEED_RAGE_COLLECTION,
      level: 4,
      total: 30,
    };
    const valid = spinResult({
      chargedBetMinor: "100",
      grid: GUARANTEED_RAGE_GRID,
      totalWinMinor: "1000",
      events: [
        collection,
        { type: "wheel.started" },
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
          multiplier: 10, amountMinor: "1000",
        },
      ],
      featureState: origin,
    });

    expect(() => validateSpinResultAgainstOrigin(origin, valid)).not.toThrow();
    expect(() => validateSpinResultAgainstOrigin(origin, {
      ...valid,
      featureState: BASE_FEATURE,
    })).toThrow(/request-origin PPS meter/);
  });

  it("rejects more than three settled Rage symbols", () => {
    const grid = GUARANTEED_RAGE_GRID.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
      reelIndex === 0 && rowIndex === 1 ? { symbol: "SURGE" as const } : cell
    )));
    expect(() => validateSpinResultAgainstOrigin(BASE_FEATURE, spinResult({
      chargedBetMinor: "100",
      grid,
      events: [
        {
          ...GUARANTEED_RAGE_COLLECTION,
          count: 4,
          cells: [
            { reel: 0, row: 1 }, { reel: 0, row: 2 },
            { reel: 1, row: 2 }, { reel: 2, row: 2 },
          ],
        },
        { type: "wheel.started" },
        {
          type: "wheel.awarded", outcome: "INSTANT", prize: "MINI",
          multiplier: 10, amountMinor: "1000",
        },
      ],
      totalWinMinor: "1000",
    }))).toThrow(/more than three Rage symbols/);
  });
});
