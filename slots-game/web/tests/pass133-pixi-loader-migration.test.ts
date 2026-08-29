import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capturedFontDescriptor from "../public/assets/primal-runtime/fonts/primal-rampage/PrimalRampage.fnt?raw";

const pixi = vi.hoisted(() => {
  const textureCache: Record<string, unknown> = {};
  const baseTextureCache: Record<string, unknown> = {};
  return {
    BitmapFontData: class BitmapFontData {
      info: unknown[] = [];
      common: unknown[] = [];
      page: unknown[] = [];
      char: unknown[] = [];
      kerning: unknown[] = [];
      distanceField: unknown[] = [];
    },
    available: {} as Record<string, unknown>,
    install: vi.fn(),
    fromURL: vi.fn(),
    textureCache,
    baseTextureCache,
    removeTextureFromCache: vi.fn((entry: string | { textureCacheIds?: string[] }) => {
      if (typeof entry === "string") {
        const removed = textureCache[entry];
        delete textureCache[entry];
        return removed;
      }
      for (const [key, value] of Object.entries(textureCache)) {
        if (value === entry) delete textureCache[key];
      }
      entry.textureCacheIds = [];
      return entry;
    }),
    removeBaseTextureFromCache: vi.fn((entry: string | { textureCacheIds?: string[] }) => {
      if (typeof entry === "string") {
        const removed = baseTextureCache[entry];
        delete baseTextureCache[entry];
        return removed;
      }
      for (const [key, value] of Object.entries(baseTextureCache)) {
        if (value === entry) delete baseTextureCache[key];
      }
      entry.textureCacheIds = [];
      return entry;
    }),
  };
});

vi.mock("pixi.js", () => ({
  BitmapFontData: pixi.BitmapFontData,
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
  utils: {
    TextureCache: pixi.textureCache,
    BaseTextureCache: pixi.baseTextureCache,
  },
}));

function cachedTexture(url: string) {
  const baseTexture = {
    cacheId: url,
    textureCacheIds: [url],
    destroy: vi.fn(),
  };
  const texture = {
    baseTexture,
    textureCacheIds: [url],
    destroy: vi.fn(),
  };
  pixi.textureCache[url] = texture;
  pixi.baseTextureCache[url] = baseTexture;
  return texture;
}

function fontResponse(ok = true) {
  const body = capturedFontDescriptor;
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
  for (const key of Object.keys(pixi.textureCache)) delete pixi.textureCache[key];
  for (const key of Object.keys(pixi.baseTextureCache)) delete pixi.baseTextureCache[key];
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

    expect(second).not.toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
    resolveFont(fontResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(pixi.fromURL).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);
    expect(pixi.install).toHaveBeenCalledOnce();
    const [fontData, textures, ownsTextures] = pixi.install.mock.calls[0]!;
    expect(fontData).toBeInstanceOf(pixi.BitmapFontData);
    expect(fontData).toMatchObject({
      info: [{ face: "PrimalRampage", size: 295 }],
      common: [{ lineHeight: 541 }],
      page: [{ id: 0, file: "PrimalRampage.png" }],
      char: expect.arrayContaining([
        expect.objectContaining({ id: 32, page: 0, xadvance: 125 }),
        expect.objectContaining({ id: 8364, page: 0, width: 179 }),
      ]),
      kerning: [],
      distanceField: [],
    });
    expect(fontData.char).toHaveLength(47);
    expect(textures).toEqual({ "PrimalRampage.png": texture });
    expect(ownsTextures).toBe(true);
  });

  it("rejects dynamic XML, unexpected glyphs and oversized descriptors before loading a page", async () => {
    const { parsePrimalBitmapFontDescriptor, PRIMAL_BITMAP_FONT_DESCRIPTOR_MAX_BYTES } = await import(
      "../src/renderer/PrimalBitmapFont"
    );

    expect(() => parsePrimalBitmapFontDescriptor(
      "<font><info face='PrimalRampage'/><script>dynamic</script></font>",
    )).toThrow("Invalid Primal bitmap font descriptor");
    expect(() => parsePrimalBitmapFontDescriptor(
      capturedFontDescriptor.replace("<char id='32'", "<char id='33'"),
    )).toThrow("Invalid Primal bitmap font descriptor");
    expect(() => parsePrimalBitmapFontDescriptor(
      "x".repeat(PRIMAL_BITMAP_FONT_DESCRIPTOR_MAX_BYTES + 1),
    )).toThrow("Invalid Primal bitmap font descriptor");
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
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fontResponse())));
    markFontInstalled();

    const { loadPrimalBitmapFont, PRIMAL_BITMAP_FONT_PAGE_URL } = await import(
      "../src/renderer/PrimalBitmapFont"
    );
    const failedTexture = cachedTexture(PRIMAL_BITMAP_FONT_PAGE_URL);
    pixi.fromURL
      .mockRejectedValueOnce(new Error("page unavailable"))
      .mockResolvedValueOnce({});

    await expect(loadPrimalBitmapFont()).resolves.toBe(false);
    expect(pixi.removeTextureFromCache).toHaveBeenCalledWith(failedTexture);
    expect(pixi.removeBaseTextureFromCache).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);
    expect(failedTexture.destroy).toHaveBeenCalledWith(false);
    await expect(loadPrimalBitmapFont()).resolves.toBe(true);
    expect(pixi.fromURL).toHaveBeenCalledTimes(2);
  });

  it("keeps a successful retry cached when the aborted generation resolves late", async () => {
    let resolveLateTexture!: (texture: ReturnType<typeof cachedTexture>) => void;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(fontResponse())));
    markFontInstalled();
    const abort = new AbortController();
    const reason = new Error("startup disposed");
    const { loadPrimalBitmapFont, PRIMAL_BITMAP_FONT_PAGE_URL } = await import(
      "../src/renderer/PrimalBitmapFont"
    );
    const generationA = cachedTexture(PRIMAL_BITMAP_FONT_PAGE_URL);
    const lateTexture = new Promise<typeof generationA>((resolve) => { resolveLateTexture = resolve; });
    const generationB = cachedTexture(PRIMAL_BITMAP_FONT_PAGE_URL);
    // A 必须在调用 fromURL 时成为 cache 当前值；B 只在立即重试实际发起时覆盖它。 / English: A must be cache current when fromURL is called; B only overwrites it when an immediate retry is actually initiated.
    pixi.textureCache[PRIMAL_BITMAP_FONT_PAGE_URL] = generationA;
    pixi.baseTextureCache[PRIMAL_BITMAP_FONT_PAGE_URL] = generationA.baseTexture;
    pixi.fromURL
      .mockImplementationOnce(() => lateTexture)
      .mockImplementationOnce(() => {
        pixi.textureCache[PRIMAL_BITMAP_FONT_PAGE_URL] = generationB;
        pixi.baseTextureCache[PRIMAL_BITMAP_FONT_PAGE_URL] = generationB.baseTexture;
        return Promise.resolve(generationB);
      });

    const loading = loadPrimalBitmapFont(abort.signal);
    await vi.waitFor(() => expect(pixi.fromURL).toHaveBeenCalledOnce());
    abort.abort(reason);

    await expect(loading).resolves.toBe(false);
    expect(pixi.install).not.toHaveBeenCalled();
    expect(pixi.removeTextureFromCache).toHaveBeenCalledWith(generationA);
    expect(pixi.removeBaseTextureFromCache).toHaveBeenCalledWith(PRIMAL_BITMAP_FONT_PAGE_URL);

    await expect(loadPrimalBitmapFont()).resolves.toBe(true);
    expect(pixi.textureCache[PRIMAL_BITMAP_FONT_PAGE_URL]).toBe(generationB);
    expect(pixi.baseTextureCache[PRIMAL_BITMAP_FONT_PAGE_URL]).toBe(generationB.baseTexture);
    expect(pixi.install).toHaveBeenCalledOnce();

    resolveLateTexture(generationA);
    await Promise.resolve();
    await Promise.resolve();
    expect(pixi.textureCache[PRIMAL_BITMAP_FONT_PAGE_URL]).toBe(generationB);
    expect(pixi.baseTextureCache[PRIMAL_BITMAP_FONT_PAGE_URL]).toBe(generationB.baseTexture);
    expect(generationB.destroy).not.toHaveBeenCalled();
    expect(generationB.baseTexture.destroy).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pixi.install).toHaveBeenCalledOnce();
  });

  it("does not cancel a shared load while another consumer is still active", async () => {
    let resolveFont!: (response: Response) => void;
    let underlyingSignal!: AbortSignal;
    const pendingFont = new Promise<Response>((resolve) => { resolveFont = resolve; });
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      underlyingSignal = init?.signal as AbortSignal;
      return pendingFont;
    }));
    pixi.fromURL.mockResolvedValue({});
    markFontInstalled();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const { loadPrimalBitmapFont } = await import("../src/renderer/PrimalBitmapFont");

    const first = loadPrimalBitmapFont(firstAbort.signal);
    const second = loadPrimalBitmapFont(secondAbort.signal);
    firstAbort.abort(new Error("first view disposed"));

    await expect(first).resolves.toBe(false);
    expect(underlyingSignal.aborted).toBe(false);
    resolveFont(fontResponse());
    await expect(second).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(pixi.install).toHaveBeenCalledOnce();
  });

  it("does not retain a production path to the deprecated Loader or silence its warning", async () => {
    const source = await import("../src/renderer/PrimalBitmapFont.ts?raw").then((module) => (
      (module as unknown as { default: string }).default
    ));

    expect(source).not.toContain("@pixi/loaders");
    expect(source).not.toMatch(/\bLoader\b/);
    expect(source).not.toContain("console.warn");
    expect(source).not.toMatch(/new\s+(?:globalThis\.)?DOMParser/u);
    expect(source).toContain("Texture.fromURL");
    expect(source).toContain("new BitmapFontData()");
    expect(source).toContain("BitmapFont.install");
  });
});
