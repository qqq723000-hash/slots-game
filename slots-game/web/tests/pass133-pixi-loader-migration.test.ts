import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pixi = vi.hoisted(() => ({
  available: {} as Record<string, unknown>,
  install: vi.fn(),
  fromURL: vi.fn(),
  removeTextureFromCache: vi.fn(),
  removeBaseTextureFromCache: vi.fn(),
}));

vi.mock("pixi.js", () => ({
  BitmapFont: {
    available: pixi.available,
    install: pixi.install,
  },
  Texture: {
    fromURL: pixi.fromURL,
    removeFromCache: pixi.removeTextureFromCache,
  },
  BaseTexture: {
    removeFromCache: pixi.removeBaseTextureFromCache,
  },
}));

function fontResponse(ok = true) {
  const body = "<font><info face='PrimalRampage'/></font>";
  return new Response(body, {
    status: ok ? 200 : 503,
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
  });
}

function markFontInstalled(): void {
  pixi.install.mockImplementation(() => {
    pixi.available.PrimalRampage = {};
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const name of Object.keys(pixi.available)) delete pixi.available[name];
  vi.stubGlobal("document", {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pass 133 Pixi bitmap-font loader migration", () => {
  it("deduplicates a browser load and installs the captured BMFont through Pixi 6 APIs", async () => {
    let resolveFont!: (response: Response) => void;
    const pendingFont = new Promise<Response>((resolve) => { resolveFont = resolve; });
    const texture = {};
    vi.stubGlobal("fetch", vi.fn(() => pendingFont));
    pixi.fromURL.mockResolvedValue(texture);
    markFontInstalled();

    const { loadPrimalBitmapFont, PRIMAL_BITMAP_FONT_PAGE_URL } = await import(
      "../src/renderer/PrimalBitmapFont"
    );
    const first = loadPrimalBitmapFont();
    const second = loadPrimalBitmapFont();

    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
    resolveFont(fontResponse());

    await expect(first).resolves.toBe(true);
    expect(pixi.fromURL).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);
    expect(pixi.install).toHaveBeenCalledWith(
      "<font><info face='PrimalRampage'/></font>",
      { "PrimalRampage.png": texture },
      true,
    );
  });

  it("returns false for a failed descriptor and lets the next call retry", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(fontResponse(false))
      .mockResolvedValueOnce(fontResponse()));
    pixi.fromURL.mockResolvedValue({});
    markFontInstalled();

    const { loadPrimalBitmapFont } = await import("../src/renderer/PrimalBitmapFont");

    await expect(loadPrimalBitmapFont()).resolves.toBe(false);
    await expect(loadPrimalBitmapFont()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pixi.fromURL).toHaveBeenCalledOnce();
  });

  it("cleans a failed page texture out of Pixi caches so the shared-atlas load can retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fontResponse()));
    pixi.fromURL
      .mockRejectedValueOnce(new Error("page unavailable"))
      .mockResolvedValueOnce({});
    markFontInstalled();

    const { loadPrimalBitmapFont, PRIMAL_BITMAP_FONT_PAGE_URL } = await import(
      "../src/renderer/PrimalBitmapFont"
    );

    await expect(loadPrimalBitmapFont()).resolves.toBe(false);
    expect(pixi.removeTextureFromCache).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);
    expect(pixi.removeBaseTextureFromCache).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);
    await expect(loadPrimalBitmapFont()).resolves.toBe(true);
    expect(pixi.fromURL).toHaveBeenCalledTimes(2);
  });

  it("does not retain a production path to the deprecated Loader or silence its warning", async () => {
    const source = await import("../src/renderer/PrimalBitmapFont.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));

    expect(source).not.toContain("@pixi/loaders");
    expect(source).not.toMatch(/\bLoader\b/);
    expect(source).not.toContain("console.warn");
    expect(source).toContain("Texture.fromURL");
    expect(source).toContain("BitmapFont.install");
  });
});
