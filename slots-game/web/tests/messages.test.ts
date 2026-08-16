import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestId, SecureRandomUnavailableError } from "../src/protocol/messages";

describe("request identifier generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses Web Crypto randomUUID when it is available", () => {
    const randomUUID = vi.fn(() => "123e4567-e89b-42d3-a456-426614174000");
    const getRandomValues = vi.fn();
    vi.stubGlobal("crypto", { randomUUID, getRandomValues });

    expect(createRequestId("round")).toBe("round-123e4567-e89b-42d3-a456-426614174000");
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it("uses getRandomValues to make an RFC 4122 v4 UUID when randomUUID is unavailable", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.set([
        0x00, 0x11, 0x22, 0x33,
        0x44, 0x55, 0x66, 0x77,
        0x18, 0x99, 0xaa, 0xbb,
        0xcc, 0xdd, 0xee, 0xff,
      ]);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(createRequestId("spin")).toBe("spin-00112233-4455-4677-9899-aabbccddeeff");
    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(getRandomValues.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    expect((getRandomValues.mock.calls[0]?.[0] as Uint8Array).byteLength).toBe(16);
  });

  it("fails closed when Web Crypto is unavailable and never falls back to clock or Math.random", () => {
    const dateNow = vi.spyOn(Date, "now");
    const mathRandom = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", undefined);

    expect(() => createRequestId("rgs")).toThrow(SecureRandomUnavailableError);
    expect(() => createRequestId("rgs")).toThrow("Web Crypto secure random generation is unavailable");
    expect(dateNow).not.toHaveBeenCalled();
    expect(mathRandom).not.toHaveBeenCalled();
  });
});
