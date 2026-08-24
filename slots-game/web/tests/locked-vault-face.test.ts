import { describe, expect, it } from "vitest";
import {
  LOCKED_VAULT_FACES,
  lockedVaultFaceForOriginalServerId,
  type GridCell,
} from "../src/app/state/types";
import {
  ATTRACT_GRID_LOCKED_VAULT_CELLS,
  createAttractGrid,
} from "../src/presentation/attractGrid";
import { decodeServerMessage, ProtocolDecodeError } from "../src/protocol/decoder";
import { decodeRgsSpin, RgsProtocolError } from "../src/protocol/rgsDecoder";
import { reelCellStaysSharpDuringSpin } from "../src/reels/ReelView";
import {
  authoredCellVariantAnimation,
  authoredSymbolSpineKeyForCell,
  authoredSymbolSpineKeyForPresentation,
  authoredVaultFreeSpinActivation,
} from "../src/reels/SymbolView";

const PROTOCOL_GRID = [
  [{ symbol: "ORBIT" }, { symbol: "PULSE" }, { symbol: "TANK" }],
  [{ symbol: "NOVA" }, { symbol: "CIRCUIT" }, { symbol: "VAULT", lockedVaultFace: "x6" }],
  [{ symbol: "PRISM" }, { symbol: "NOVA" }, { symbol: "SURGE" }],
] as const;

function protocolResult(grid: unknown = PROTOCOL_GRID): Record<string, unknown> {
  return {
    type: "spin.result",
    protocolVersion: 1,
    requestId: "request-locked-vault",
    sessionId: "session-locked-vault",
    roundId: "round-locked-vault",
    sequence: 1,
    betMinor: "100",
    chargedBetMinor: "100",
    balanceMinor: "9900",
    totalWinMinor: "0",
    grid,
    wins: [],
    events: [],
    featureState: {
      mode: "BASE",
      freeSpinsRemaining: 0,
      freeSpinsPlayed: 0,
      rageLevel: 1,
      rageCollected: 0,
    },
  };
}

function rgsResponse(grid: unknown = PROTOCOL_GRID): Record<string, unknown> {
  return {
    requestId: "request-rgs-locked-vault",
    data: {
      operatorId: "operator-a",
      sessionId: "session-a",
      roundId: "round-a",
      gameId: "primal-rampage",
      definitionVersion: "definition-1",
      definitionHash: "a".repeat(64),
      currency: "EUR",
      roundKind: "BASE",
      serverTransactionId: "server-tx-a",
      walletTransactionId: "wallet-tx-a",
      startRevision: "0",
      endRevision: "1",
      sequence: "1",
      resultHash: "b".repeat(64),
      idleDisconnectAt: "2029-12-31T23:45:00Z",
      betMinor: "100",
      chargedBetMinor: "100",
      balanceMinor: "9900",
      totalWinMinor: "0",
      grid,
      wins: [],
      events: [],
      feature: {
        mode: "NONE",
        remaining: 0,
        awarded: 0,
        betMinor: "0",
        winMinor: "0",
        rageLevel: 1,
        rageCollected: 0,
      },
    },
  };
}

function gridWithTarget(target: Readonly<Record<string, unknown>>): unknown[][] {
  return PROTOCOL_GRID.map((reel, reelIndex) => reel.map((cell, rowIndex) => (
    reelIndex === 1 && rowIndex === 2 ? target : { ...cell }
  )));
}

describe("official locked Vault face contract", () => {
  it("maps every official locked server ID 17-31 to its Symbol8 pose", () => {
    expect(LOCKED_VAULT_FACES).toEqual([
      "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9",
      "mini", "minor", "major", "mega", "grand", "free_spin",
    ]);
    LOCKED_VAULT_FACES.forEach((face, index) => {
      expect(lockedVaultFaceForOriginalServerId(17 + index)).toBe(face);
      const cell: GridCell = { symbol: "VAULT", lockedVaultFace: face };
      expect(authoredSymbolSpineKeyForCell(cell)).toBe("symbol8");
      expect(authoredCellVariantAnimation(cell)).toBe(face);
      expect(reelCellStaysSharpDuringSpin(cell)).toBe(false);
    });
    for (const value of [16, 32, Number.NaN, 17.5]) {
      expect(lockedVaultFaceForOriginalServerId(value)).toBeNull();
    }
  });

  it("keeps the initial Grand and established unlock/Free-Spin bodies unchanged", () => {
    const attract = createAttractGrid();
    const grandAddress = ATTRACT_GRID_LOCKED_VAULT_CELLS[0]!;
    const grand = attract[grandAddress.reel]?.[grandAddress.row];
    expect(grand).toEqual({ symbol: "VAULT", prize: "GRAND", multiplier: 1_000 });
    expect(authoredSymbolSpineKeyForPresentation(grand!, true)).toBe("symbol8");
    expect(authoredCellVariantAnimation(grand!)).toBe("grand");

    const x2: GridCell = { symbol: "VAULT", prize: "X2", multiplier: 2 };
    expect(authoredSymbolSpineKeyForCell(x2)).toBe("symbol9");
    expect(authoredSymbolSpineKeyForPresentation(x2, true)).toBe("symbol8");
    expect(authoredCellVariantAnimation(x2)).toBe("x2");

    const freeSpin: GridCell = { symbol: "VAULT", prize: "FREE_SPIN" };
    expect(authoredSymbolSpineKeyForCell(freeSpin)).toBe("symbol9");
    expect(authoredCellVariantAnimation(freeSpin)).toBe("free_spin");
    expect(authoredVaultFreeSpinActivation(freeSpin)).toBe("feature_activation");
    expect(authoredCellVariantAnimation({ symbol: "VAULT" })).toBe("x1");
  });

  it("strictly decodes only isolated locked metadata on a VAULT", () => {
    const decoded = decodeServerMessage(protocolResult());
    if (decoded.type !== "spin.result") throw new Error("unexpected message");
    expect(decoded.grid[1]?.[2]).toEqual({ symbol: "VAULT", lockedVaultFace: "x6" });

    for (const target of [
      { symbol: "VAULT", lockedVaultFace: "x10" },
      { symbol: "TANK", lockedVaultFace: "x6" },
      { symbol: "VAULT", lockedVaultFace: "x6", multiplier: 6 },
      { symbol: "VAULT", lockedVaultFace: "x6", prize: "X6" },
    ]) {
      expect(() => decodeServerMessage(protocolResult(gridWithTarget(target))))
        .toThrow(ProtocolDecodeError);
    }
  });

  it("preserves the same strict contract through the RGS translation boundary", () => {
    const decoded = decodeRgsSpin(rgsResponse(), "request-rgs-locked-vault");
    expect(decoded.result.grid[1]?.[2]).toEqual({ symbol: "VAULT", lockedVaultFace: "x6" });

    for (const target of [
      { symbol: "VAULT", lockedVaultFace: "unknown" },
      { symbol: "NOVA", lockedVaultFace: "grand" },
      { symbol: "VAULT", lockedVaultFace: "grand", prize: "GRAND" },
    ]) {
      expect(() => decodeRgsSpin(
        rgsResponse(gridWithTarget(target)),
        "request-rgs-locked-vault",
      )).toThrow(RgsProtocolError);
    }
  });

  it("requires the exact canonical result hash on every committed RGS result", () => {
    const missing = rgsResponse();
    delete (missing.data as Record<string, unknown>).resultHash;
    expect(() => decodeRgsSpin(missing, "request-rgs-locked-vault"))
      .toThrow(RgsProtocolError);

    const malformed = rgsResponse();
    (malformed.data as Record<string, unknown>).resultHash = "B".repeat(64);
    expect(() => decodeRgsSpin(malformed, "request-rgs-locked-vault"))
      .toThrow(RgsProtocolError);
  });
});
