import { describe, expect, it } from "vitest";
import {
  browserTraceHeaders,
  createBrowserTraceParent,
} from "../src/protocol/browserTraceContext";

describe("browser Trace Context", () => {
  it("generates a lowercase W3C Level 2 random trace parent without persistent identity", () => {
    const traceParent = createBrowserTraceParent((target) => {
      target.forEach((_value, index) => { target[index] = index + 1; });
    });
    expect(traceParent).toBe(
      "00-0102030405060708090a0b0c0d0e0f10-1112131415161718-02",
    );
  });

  it("fails open when CSPRNG throws or returns an invalid all-zero identifier", () => {
    expect(createBrowserTraceParent(() => { throw new Error("fixture entropy failure"); })).toBeNull();
    expect(createBrowserTraceParent(() => undefined)).toBeNull();
  });

  it("exposes only the traceparent header and never tracestate or baggage", () => {
    const headers = browserTraceHeaders();
    if (Object.keys(headers).length === 0) return;
    expect(Object.keys(headers)).toEqual(["traceparent"]);
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-02$/);
  });
});
