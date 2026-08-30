// @ts-nocheck -- 浏览器探针辅助函数必须保持为可由 CDP 注入的无依赖 JavaScript。 / English: @ts-nocheck -- Browser probe helper functions must remain dependency-free JavaScript that can be injected by CDP.
import { describe, expect, it } from "vitest";
import {
  BROWSER_TRANSACTION_PROBE_SOURCE,
  browserRuntimeDiagnosticSummary,
  classifyBrowserRuntimeFailure,
  recordBrowserRuntimeEvent,
} from "../scripts/production-browser-runtime-probe.mjs";

describe("production browser runtime diagnostics", () => {
  it.each([
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications.",
  ])("identifies a trusted ResizeObserver loop without exposing its message", (message) => {
    expect(classifyBrowserRuntimeFailure({
      kind: "window-error",
      errorName: "",
      errorPresent: false,
      isTrusted: true,
      message,
    })).toEqual({
      kind: "window-error",
      code: "RESIZE_OBSERVER_LOOP",
      severity: "fatal",
    });
  });

  it("does not trust a forged ResizeObserver message or publish a custom error name", () => {
    const secretMarker = "TOKEN_SHOULD_NEVER_APPEAR";
    const forged = classifyBrowserRuntimeFailure({
      kind: "window-error",
      errorName: secretMarker,
      errorPresent: false,
      isTrusted: false,
      message: "ResizeObserver loop completed with undelivered notifications.",
    });
    expect(forged).toEqual({
      kind: "window-error",
      code: "UNKNOWN_RUNTIME_ERROR",
      severity: "fatal",
    });
    expect(JSON.stringify(forged)).not.toContain(secretMarker);
  });

  it("maps known errors and non-Error rejections to fixed codes", () => {
    expect(classifyBrowserRuntimeFailure({
      kind: "window-error",
      errorName: "TypeError",
      errorPresent: true,
      isTrusted: true,
      message: "private detail",
    }).code).toBe("TYPE_ERROR");
    expect(classifyBrowserRuntimeFailure({
      kind: "unhandled-rejection",
      errorName: "",
      reasonPresent: false,
    }).code).toBe("NON_ERROR_REJECTION");
  });

  it("coalesces equal events, caps unique events and reports dropped entries", () => {
    const state = { events: [], droppedCount: 0 };
    const event = { kind: "window-error", code: "TYPE_ERROR", severity: "fatal" };
    recordBrowserRuntimeEvent(state, event, "mobile-matrix", 2);
    recordBrowserRuntimeEvent(state, event, "mobile-matrix", 2);
    recordBrowserRuntimeEvent(
      state,
      { kind: "probe-warning", code: "FEATURE_PREVIEW_STORAGE_UNAVAILABLE", severity: "warning" },
      "document-start",
      2,
    );
    recordBrowserRuntimeEvent(
      state,
      { kind: "window-error", code: "ERROR", severity: "fatal" },
      "transaction-active",
      2,
    );

    expect(browserRuntimeDiagnosticSummary(state)).toEqual({
      schema: 1,
      fatalCount: 2,
      warningCount: 1,
      droppedCount: 1,
      events: [
        {
          kind: "window-error",
          code: "TYPE_ERROR",
          phase: "mobile-matrix",
          severity: "fatal",
          count: 2,
        },
        {
          kind: "probe-warning",
          code: "FEATURE_PREVIEW_STORAGE_UNAVAILABLE",
          phase: "document-start",
          severity: "warning",
          count: 1,
        },
      ],
    });
  });

  it("embeds only fixed diagnostic fields in the document-start probe", () => {
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).toContain("runtimeDiagnostics");
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).toContain("RESIZE_OBSERVER_LOOP");
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).toContain("FEATURE_PREVIEW_STORAGE_UNAVAILABLE");
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).toContain('probe.setPhase("bootstrap")');
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).not.toContain("event.error.stack");
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).not.toContain("event.reason.message");
    expect(BROWSER_TRANSACTION_PROBE_SOURCE).not.toContain("filename");
  });
});
