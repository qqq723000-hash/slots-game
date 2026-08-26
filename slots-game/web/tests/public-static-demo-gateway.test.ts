import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionOpened, SpinResult } from "../src/app/state/types";
import { PublicStaticDemoGateway } from "../src/demo/PublicStaticDemoGateway";
import { decodeServerMessage } from "../src/protocol/decoder";
import { validateSpinResultAgainstOrigin } from "../src/protocol/spinResultOriginGuard";

describe("PublicStaticDemoGateway", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves a closed 23-round XTS showcase and loops deterministically", () => {
    const gateway = new PublicStaticDemoGateway();
    const sessions: SessionOpened[] = [];
    const results: SpinResult[] = [];
    const statuses: string[] = [];
    const errors: unknown[] = [];
    gateway.setCallbacks({
      onStatus: (status) => statuses.push(status),
      onSession: (session) => sessions.push(session),
      onSpinResult: (result) => results.push(result),
      onError: (error) => errors.push(error),
    });

    gateway.connect();
    vi.runOnlyPendingTimers();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      currency: "XTS",
      balanceMinor: "100000",
      betOptionsMinor: ["100"],
      defaultBetMinor: "100",
    });

    let origin = sessions[0]!.featureState;
    let balance = BigInt(sessions[0]!.balanceMinor);
    for (let index = 0; index < 24; index += 1) {
      expect(gateway.requestSpin(`public-demo-round-${index + 1}`, "100")).toBe(true);
      vi.runOnlyPendingTimers();
      const result = results[index]!;
      expect(decodeServerMessage(result)).toEqual(result);
      expect(() => validateSpinResultAgainstOrigin(origin, result)).not.toThrow();
      balance = balance - BigInt(result.chargedBetMinor) + BigInt(result.totalWinMinor);
      expect(result.balanceMinor).toBe(balance.toString());
      origin = result.featureState;
    }

    expect(results.map((result) => result.sequence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(results[23]?.grid).toEqual(results[0]?.grid);
    expect(results[23]?.wins).toEqual(results[0]?.wins);
    const eventTypes = results.flatMap((result) => result.events.map((event) => event.type));
    expect(eventTypes).toEqual(expect.arrayContaining([
      "surge.collected",
      "wheel.started",
      "wheel.awarded",
      "free_spins.started",
      "grid.expanded",
      "vault.unlocked",
      "vault.upgraded",
      "free_spins.completed",
    ]));
    expect(results.filter((result) => result.featureState.mode === "EXPANSION")).toHaveLength(8);
    expect(results.filter((result) => result.featureState.mode === "OVERDRIVE")).toHaveLength(8);
    expect(results[20]?.featureState).toMatchObject({ mode: "BASE", freeSpinsRemaining: 0 });
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(errors).toEqual([]);

    gateway.close();
    expect(statuses).toEqual(["connecting", "online", "offline"]);
  });

  it("rejects malformed identifiers and every non-demo bet", () => {
    const gateway = new PublicStaticDemoGateway();
    gateway.setCallbacks({
      onStatus: () => undefined,
      onSession: () => undefined,
      onSpinResult: () => undefined,
      onError: () => undefined,
    });
    gateway.connect();
    vi.runOnlyPendingTimers();

    expect(gateway.requestSpin("contains whitespace", "100")).toBe(false);
    expect(gateway.requestSpin("public-demo-round", "200")).toBe(false);
  });
});
