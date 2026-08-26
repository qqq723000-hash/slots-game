import { describe, expect, it, vi } from "vitest";

import {
  OPERATOR_SHELL_HOST_MESSAGE_TYPE,
  OPERATOR_SHELL_HOST_MESSAGE_VERSION,
  OPERATOR_SHELL_REQUEST_EVENT,
  requestOperatorShellAction,
  validateOperatorShellRequest,
} from "../src/app/operatorShellRequest";

class TestCustomEvent<T> {
  readonly detail: T;

  constructor(
    readonly type: string,
    init: { readonly detail: T },
  ) {
    this.detail = init.detail;
  }
}

describe("operator shell request contract", () => {
  it.each(["home", "exit"] as const)("allowlists the voluntary %s request", (action) => {
    const request = validateOperatorShellRequest({ action });

    expect(request).toEqual({ action });
    expect(Object.isFrozen(request)).toBe(true);
  });

  it.each([
    null,
    "exit",
    {},
    { action: "close" },
    { action: "exit", reason: "fatal wallet error" },
    { action: "home", url: "https://untrusted.example" },
    Object.assign(Object.create({ secret: "Bearer inherited" }), { action: "exit" }),
  ])("rejects an open or invalid runtime payload", (payload) => {
    expect(validateOperatorShellRequest(payload)).toBeNull();
  });

  it("emits the same-page event and exact-origin framed message with only allowlisted data", () => {
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const close = vi.fn();
    const assign = vi.fn();
    const windowValue = {
      dispatchEvent,
      parent: { postMessage },
      close,
      location: { assign },
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      requestOperatorShellAction(windowValue, { action: "exit" }, "https://operator.example");

      expect(dispatchEvent).toHaveBeenCalledOnce();
      expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
        type: OPERATOR_SHELL_REQUEST_EVENT,
        detail: { action: "exit" },
      });
      expect(Object.isFrozen(dispatchEvent.mock.calls[0]?.[0].detail)).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        type: OPERATOR_SHELL_HOST_MESSAGE_TYPE,
        version: OPERATOR_SHELL_HOST_MESSAGE_VERSION,
        action: "exit",
      }, "https://operator.example");
      expect(JSON.stringify(postMessage.mock.calls[0]?.[0])).not.toMatch(
        /error|message|reason|token|secret|url/i,
      );
      expect(close).not.toHaveBeenCalled();
      expect(assign).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps same-page requests but never posts for invalid origins or a top-level window", () => {
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const framedWindow = {
      dispatchEvent,
      parent: { postMessage },
    } as unknown as Window;
    const topWindow = { dispatchEvent } as unknown as Window & { parent: Window };
    Object.defineProperty(topWindow, "parent", { value: topWindow });
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      for (const origin of [
        "*",
        "http://operator.example",
        "https://operator.example/",
        "https://operator.example/path",
        "https://user@operator.example",
      ]) {
        requestOperatorShellAction(framedWindow, { action: "home" }, origin);
      }
      requestOperatorShellAction(topWindow, { action: "home" }, "https://operator.example");

      expect(dispatchEvent).toHaveBeenCalledTimes(6);
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects diagnostic extras before either channel can observe them", () => {
    const dispatchEvent = vi.fn();
    const postMessage = vi.fn();
    const windowValue = {
      dispatchEvent,
      parent: { postMessage },
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      requestOperatorShellAction(windowValue, {
        action: "exit",
        error: "wallet failed with Bearer secret",
      }, "https://operator.example");

      expect(dispatchEvent).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not throw or infer success when either notification channel fails", () => {
    const postMessage = vi.fn(() => { throw new Error("parent unavailable"); });
    const windowValue = {
      dispatchEvent: vi.fn(() => { throw new Error("listener unavailable"); }),
      parent: { postMessage },
    } as unknown as Window;
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    try {
      expect(requestOperatorShellAction(
        windowValue,
        { action: "exit" },
        "https://operator.example",
      )).toBeUndefined();
      expect(postMessage).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
