// @ts-nocheck -- 此源码契约测试会刻意在 Vitest 的 Node 运行时中读取本地文件。 / English: @ts-nocheck -- This source contract test intentionally reads local files in Vitest's Node runtime.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PLAYER_FACING_ERROR_CODES,
  playerFacingErrorFor,
  safeCorrelationId,
} from "../src/app/playerFacingError";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("player-facing error contract", () => {
  it("converts server and runtime failures to stable copy without leaking raw text", () => {
    const rawServerMessage = "upstream rejected token=super-secret; internal host=wallet-01";
    const serverError = {
      type: "error" as const,
      protocolVersion: 1,
      requestId: "operator-request-7",
      code: "UPSTREAM_REJECTED",
      message: rawServerMessage,
      retryable: false,
    };

    const requestFailure = playerFacingErrorFor(serverError, "round-request");
    const resultFailure = playerFacingErrorFor(new Error(rawServerMessage), "round-result");

    expect(requestFailure).toEqual({
      code: PLAYER_FACING_ERROR_CODES.REQUEST_UNAVAILABLE,
      message: "This request could not be completed. Please try again.",
      correlationId: "operator-request-7",
    });
    expect(resultFailure).toEqual({
      code: PLAYER_FACING_ERROR_CODES.RESULT_UNAVAILABLE,
      message: "The game result could not be displayed. Please contact support if this continues.",
    });
    expect(JSON.stringify([requestFailure, resultFailure])).not.toContain(rawServerMessage);
  });

  it("keeps only schema-constrained correlation IDs for safe diagnostics", () => {
    expect(safeCorrelationId({ requestId: "support-42:round.7" })).toBe("support-42:round.7");
    expect(safeCorrelationId({ requestId: "token=should-not-pass" })).toBeUndefined();
    expect(safeCorrelationId({ requestId: "x".repeat(129) })).toBeUndefined();
  });

  it("keeps raw exception messages out of player error and launch-status call sites", () => {
    const appController = source("../src/app/AppController.ts");
    const main = source("../src/main.ts");

    expect(appController).toContain("playerFacingErrorFor");
    expect(appController).toContain("presentPlayerFacingError(publicError");
    expect(appController).not.toMatch(/(?:showError|setLaunchStatus)\(\s*(?:error|cause)(?:\?\.)?\.message\s*\)/);
    expect(appController).not.toMatch(/(?:showError|setLaunchStatus)\(\s*`[^`]*\$\{(?:error|cause)\.message\}/);
    expect(main).toContain('playerFacingErrorFor(error, "launch")');
    expect(main).toContain("status.textContent = publicError.message");
    expect(main).not.toMatch(/status\.textContent\s*=\s*error(?:\?|\.)/);
  });

  it("constructs and injects the configured gateway before the first paint wait", () => {
    const main = source("../src/main.ts");
    const rootValidation = main.indexOf('if (!root) throw new Error("Application root is missing")');
    const gatewayConstruction = main.indexOf("createConfiguredGameGateway({");
    const assemblyController = main.indexOf("new AbortController()");
    const monitorStart = main.indexOf("startStartupPerformanceMonitor(");
    const pixiMetricsSetup = main.indexOf("configurePixiTextMetricsReadbackCanvas(");
    const firstPaintWait = main.indexOf("void waitForPaintedFrame()");
    const controllerImport = main.indexOf('import("./app/AppController")');

    expect(gatewayConstruction).toBeGreaterThan(-1);
    expect(gatewayConstruction).toBeGreaterThan(rootValidation);
    expect(gatewayConstruction).toBeLessThan(assemblyController);
    expect(gatewayConstruction).toBeLessThan(monitorStart);
    expect(gatewayConstruction).toBeLessThan(pixiMetricsSetup);
    expect(gatewayConstruction).toBeLessThan(firstPaintWait);
    expect(gatewayConstruction).toBeLessThan(controllerImport);
    expect(main).toMatch(/\{\s*gateway:\s*(?:configuredGateway!?|launchGateway)\s*\}/);
    expect(main).toContain('playerFacingErrorFor(error, "initial-rgs-session")');
    expect(main).toContain("notifyOperatorSessionRequired(window, request, operatorHostOrigin)");
  });

  it("uses an exact-origin allowlisted bridge for cross-frame operator recovery", () => {
    const bridge = source("../src/app/operatorSessionBridge.ts");
    const configuredGateway = source("../src/protocol/configuredGateway.ts");
    const appController = source("../src/app/AppController.ts");

    expect(bridge).toContain("windowValue.parent.postMessage(message, targetOrigin)");
    expect(bridge).toContain("parseExactHttpsHostOrigin(configuredHostOrigin");
    expect(bridge).not.toMatch(/postMessage\([\s\S]*?,\s*["']\*["']\s*\)/);
    expect(configuredGateway).toContain("framed RGS requires VITE_RGS_HOST_ORIGIN");
    expect(appController).toMatch(/createConfiguredGameGateway\(\{[\s\S]*?isFramed:\s*isWindowFramed\(window\)/);
  });
});
