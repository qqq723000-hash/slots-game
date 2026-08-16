import { describe, expect, it, vi } from "vitest";
import { RgsGateway, RgsGatewayConfigurationError } from "../src/protocol/RgsGateway";
import {
  createConfiguredGameGateway,
  optionalWindowSessionStorage,
} from "../src/protocol/configuredGateway";

const LAUNCH_CODE = `lc_${"q".repeat(43)}`;

function history() {
  return {
    state: { navigation: 1 },
    replaceState: vi.fn(),
  };
}

function writableSessionStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
}

describe("createConfiguredGameGateway", () => {
  it("fails closed when every production RGS input is absent", () => {
    const browserHistory = history();
    expect(() => createConfiguredGameGateway({
      env: {},
      pageUrl: "https://game.example/play#cabinet",
      history: browserHistory,
    })).toThrow(/requires all environment and fragment fields/);

    expect(browserHistory.replaceState).toHaveBeenCalledOnce();
  });

  it("selects HTTP only from a complete env/fragment handoff and scrubs RGS fragment values", () => {
    const browserHistory = history();
    const pageUrl = new URL("https://game.example/play?demo=1");
    pageUrl.hash = new URLSearchParams({
      view: "mobile",
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    }).toString();
    const gateway = createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "50,100,200",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl: pageUrl.toString(),
      history: browserHistory,
      sessionStorage: writableSessionStorage(),
      rgsDependencies: {
        fetch: vi.fn<typeof fetch>(),
        bindingFingerprint: async () => "a".repeat(64),
      },
    });

    expect(gateway).toBeInstanceOf(RgsGateway);
    expect(browserHistory.replaceState).toHaveBeenCalledTimes(1);
    const replacement = String(browserHistory.replaceState.mock.calls[0]?.[2]);
    expect(replacement).toContain("#view=mobile");
    expect(replacement).not.toContain("rgsLaunchCode");
    expect(replacement).not.toContain(LAUNCH_CODE);
    expect(replacement).not.toContain("rgsOperatorId");
    expect(replacement).not.toContain("rgsSessionId");
  });

  it("requires and retains an exact HTTPS operator origin for framed RGS", () => {
    const browserHistory = history();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;
    const gateway = createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
        VITE_RGS_HOST_ORIGIN: "https://operator.example",
      },
      pageUrl,
      history: browserHistory,
      isFramed: true,
      sessionStorage: writableSessionStorage(),
      rgsDependencies: { fetch: vi.fn<typeof fetch>() },
    });

    expect(gateway).toBeInstanceOf(RgsGateway);
    expect(gateway.operatorHostOrigin).toBe("https://operator.example");
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it.each([
    "*",
    "http://operator.example",
    "https://operator.example/",
    "https://operator.example/path",
    "https://operator.example?tenant=a",
    "https://user@operator.example",
  ])("fails closed before exchange for an invalid operator host origin: %s", (hostOrigin) => {
    const browserHistory = history();
    const fetchImplementation = vi.fn<typeof fetch>();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
        VITE_RGS_HOST_ORIGIN: hostOrigin,
      },
      pageUrl,
      history: browserHistory,
      isFramed: true,
      sessionStorage: writableSessionStorage(),
      rgsDependencies: { fetch: fetchImplementation },
    })).toThrow(/exact credential-free HTTPS origin/);

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("fails closed before exchange when framed RGS has no trusted operator origin", () => {
    const browserHistory = history();
    const fetchImplementation = vi.fn<typeof fetch>();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
      isFramed: true,
      sessionStorage: writableSessionStorage(),
      rgsDependencies: { fetch: fetchImplementation },
    })).toThrow(/framed RGS requires VITE_RGS_HOST_ORIGIN/);

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("treats a lone operator origin as partial RGS configuration instead of demo mode", () => {
    const browserHistory = history();

    expect(() => createConfiguredGameGateway({
      env: { VITE_RGS_HOST_ORIGIN: "https://operator.example" },
      pageUrl: "https://game.example/play",
      history: browserHistory,
    })).toThrow(/requires all environment and fragment fields/);
    expect(browserHistory.replaceState).toHaveBeenCalledOnce();
  });

  it("fails closed before exchange when production RGS has no recovery storage", () => {
    const browserHistory = history();
    const fetchImplementation = vi.fn<typeof fetch>();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
      sessionStorage: null,
      rgsDependencies: { fetch: fetchImplementation },
    })).toThrow(/writable recovery ledger storage/);

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("fails closed before exchange when sessionStorage cannot persist a probe", () => {
    const browserHistory = history();
    const fetchImplementation = vi.fn<typeof fetch>();
    const storage = writableSessionStorage();
    storage.setItem.mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
      sessionStorage: storage,
      rgsDependencies: { fetch: fetchImplementation },
    })).toThrow(/writable recovery ledger storage/);

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("treats an inaccessible window sessionStorage getter as unavailable", () => {
    const windowValue = Object.defineProperty({}, "sessionStorage", {
      get: () => { throw new DOMException("Blocked", "SecurityError"); },
    });

    expect(optionalWindowSessionStorage(windowValue as Window)).toBeNull();
  });

  it("fails closed instead of selecting an untrusted alternate transport", () => {
    const browserHistory = history();
    const pageUrl = `https://game.example/play#rgsLaunchCode=${LAUNCH_CODE}&rgsOperatorId=operator-a`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
    })).toThrow(RgsGatewayConfigurationError);

    expect(browserHistory.replaceState).toHaveBeenCalledTimes(1);
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("fails closed and scrubs credentials when build-time RGS configuration is partial", () => {
    const browserHistory = history();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: { VITE_RGS_BASE_URL: "https://rgs.example" },
      pageUrl,
      history: browserHistory,
    })).toThrow(/requires all environment and fragment fields/);
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("rejects duplicate or malformed fragment handoff fields without retaining the launch code", () => {
    const browserHistory = history();
    const pageUrl = `https://game.example/play#rgsLaunchCode=${LAUNCH_CODE}`
      + `&rgsLaunchCode=${LAUNCH_CODE}&rgsOperatorId=operator-a&rgsSessionId=session-a`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
    })).toThrow(/duplicate rgsLaunchCode/);
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });

  it("rejects non-canonical bet configuration after scrubbing the one-time handoff", () => {
    const browserHistory = history();
    const pageUrl = `https://game.example/play#${new URLSearchParams({
      rgsLaunchCode: LAUNCH_CODE,
      rgsOperatorId: "operator-a",
      rgsSessionId: "session-a",
    })}`;

    expect(() => createConfiguredGameGateway({
      env: {
        VITE_RGS_BASE_URL: "https://rgs.example",
        VITE_RGS_BET_OPTIONS_MINOR: "50, 100",
        VITE_RGS_DEFAULT_BET_MINOR: "100",
      },
      pageUrl,
      history: browserHistory,
    })).toThrow(/comma-separated canonical decimal list/);
    expect(String(browserHistory.replaceState.mock.calls[0]?.[2])).not.toContain(LAUNCH_CODE);
  });
});
