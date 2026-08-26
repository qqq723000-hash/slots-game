import { describe, expect, it } from "vitest";
import { featureEventRoute } from "../src/app/featureEventRouting";
import type { FeatureEvent } from "../src/app/state/types";

const vault = [{ reel: 1, row: 1 }] as const;

const allEvents: readonly FeatureEvent[] = [
  { type: "grid.expanded", rows: 6, ways: 216 },
  {
    type: "surge.collected", count: 1, cells: [{ reel: 2, row: 2 }],
    triggered: true, guaranteed: false, level: 1, total: 1,
  },
  {
    type: "rage.transformed", count: 2,
    cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }], level: 1, total: 1,
  },
  { type: "wheel.started" },
  { type: "wheel.awarded", outcome: "EXPANSION" },
  { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
  { type: "vaults.landed", count: 1, cells: vault },
  { type: "vaults.locked", count: 1, cells: vault },
  { type: "vaults.unlock.started", count: 1, cells: vault },
  { type: "vault.unlocked", reel: 1, row: 1, prize: "MINI", multiplier: 10 },
  { type: "vaults.unlock.completed", count: 1, cells: vault },
  { type: "vaults.upgrade.started", count: 1, step: 1 },
  {
    type: "vault.upgraded", reel: 1, row: 1,
    fromMultiplier: 10, toMultiplier: 20, prize: "MINI_2X", step: 1,
  },
  { type: "vault.awarded", reel: 1, row: 1, multiplier: 20, amountMinor: "2000" },
  { type: "free_spin.awarded", count: 1, reel: 1, row: 1 },
  { type: "free_spin.cap_reached", reel: 1, row: 1 },
  { type: "win_cap.reached", multiplier: 2_500, cumulativeWinMinor: "250000" },
  { type: "free_spins.completed", mode: "EXPANSION", awarded: 9, cumulativeWinMinor: "12500" },
];

describe("authoritative feature event routing", () => {
  it("safely consumes every strict event in exactly one route", () => {
    expect(allEvents.map((event) => [event.type, featureEventRoute(event).visual])).toEqual([
      ["grid.expanded", "none"],
      ["surge.collected", "collect"],
      ["rage.transformed", "rage-transform"],
      ["wheel.started", "none"],
      ["wheel.awarded", "wheel"],
      ["free_spins.started", "free-spin-intro"],
      ["vaults.landed", "none"],
      ["vaults.locked", "none"],
      ["vaults.unlock.started", "vault-group"],
      ["vault.unlocked", "vault-reveal"],
      ["vaults.unlock.completed", "none"],
      ["vaults.upgrade.started", "vault-group"],
      ["vault.upgraded", "vault-award"],
      ["vault.awarded", "vault-award"],
      ["free_spin.awarded", "extra-spin"],
      ["free_spin.cap_reached", "free-spin-cap"],
      ["win_cap.reached", "none"],
      ["free_spins.completed", "free-spin-summary"],
    ]);
  });

  it("presents expansion once before reels and never restarts it afterward", () => {
    const route = featureEventRoute(allEvents[0]!);
    expect(route).toMatchObject({
      beforeReels: true,
      visual: "none",
      environment: true,
    });
  });

  it("splits wheel start from landing without duplicate visual or environment triggers", () => {
    const started = featureEventRoute({ type: "wheel.started" });
    const awarded = featureEventRoute({
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "GRAND",
      multiplier: 1_000,
      amountMinor: "100000",
    });
    expect(started).toMatchObject({ visual: "none", environment: true, audio: true, announce: false });
    expect(awarded).toMatchObject({ visual: "wheel", environment: true, audio: true });
  });

  it("assigns Vault group reactions and cell awards to different owners", () => {
    expect(featureEventRoute({
      type: "vaults.locked", count: 1, cells: vault,
    })).toMatchObject({ visual: "none", announce: false });
    expect(featureEventRoute({
      type: "vaults.unlock.started", count: 1, cells: vault,
    })).toMatchObject({ visual: "vault-group", environment: true, audio: true });
    expect(featureEventRoute({
      type: "vault.awarded", reel: 1, row: 1, multiplier: 10, amountMinor: "1000",
    })).toMatchObject({
      visual: "vault-award", environment: true, audio: false, announce: false,
    });
    expect(featureEventRoute({
      type: "vaults.upgrade.started", count: 1, step: 1,
    })).toMatchObject({ visual: "vault-group", environment: true, audio: true, announce: false });
    expect(featureEventRoute({
      type: "vaults.unlock.completed", count: 1, cells: vault,
    })).toMatchObject({ visual: "none", environment: true, announce: false });
  });

  it("does not add a DOM announcement barrier after an authored Rage trigger", () => {
    expect(featureEventRoute({
      type: "surge.collected",
      count: 3,
      cells: [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
      triggered: true,
      guaranteed: true,
      level: 1,
      total: 0,
    })).toMatchObject({ visual: "collect", announce: false });
    expect(featureEventRoute({
      type: "surge.collected",
      count: 1,
      cells: [{ reel: 0, row: 0 }],
      triggered: false,
      guaranteed: false,
      level: 1,
      total: 1,
    })).toMatchObject({ visual: "collect", announce: true });
  });

  it("starts the Free Spins outro before presenting the terminal summary", () => {
    expect(featureEventRoute({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "9900",
    })).toMatchObject({ visual: "free-spin-summary", audio: true, announce: false });
  });

  it("routes extra-spin batches and CAPLIMIT without duplicate generic bridges", () => {
    expect(featureEventRoute({ type: "free_spin.awarded", count: 2, reel: 1, row: 1 }))
      .toMatchObject({ visual: "extra-spin", audio: false, environment: false, announce: false });
    expect(featureEventRoute({ type: "free_spin.cap_reached", reel: 1, row: 1 }))
      .toMatchObject({ visual: "free-spin-cap", audio: false, environment: false, announce: false });
  });

  it("observes the economic win-cap boundary without inventing a player-facing effect", () => {
    expect(featureEventRoute({
      type: "win_cap.reached",
      multiplier: 2_500,
      cumulativeWinMinor: "250000",
    })).toEqual({
      visual: "none",
      beforeReels: false,
      environment: false,
      audio: false,
      announce: false,
    });
  });
});
