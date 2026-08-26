import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseTexture, Texture } from "pixi.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("symbol texture loader failure recovery", () => {
  it("evicts a rejected Pixi cache entry and allows a later explicit retry", async () => {
    const removeTexture = vi.spyOn(Texture, "removeFromCache");
    const removeBaseTexture = vi.spyOn(BaseTexture, "removeFromCache");
    const fromURL = vi.spyOn(Texture, "fromURL")
      .mockRejectedValueOnce(new Error("transient symbol texture failure"))
      .mockResolvedValue(Texture.EMPTY);
    const { loadedSymbolTextures, loadSymbolTextures } = await import("../src/reels/SymbolView");

    const first = loadSymbolTextures();
    await expect(first).rejects.toThrow("transient symbol texture failure");
    const callsAfterFailure = fromURL.mock.calls.length;

    const retry = loadSymbolTextures();
    expect(retry).not.toBe(first);
    await expect(retry).resolves.toBeUndefined();

    expect(fromURL.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(removeTexture).toHaveBeenCalledOnce();
    expect(removeBaseTexture).toHaveBeenCalledOnce();
    expect(loadedSymbolTextures().length).toBeGreaterThan(0);
  });

  it("does not partially publish textures that complete after a sibling fails", async () => {
    let resolveLate!: (texture: Texture) => void;
    const lateTexture = { destroy: vi.fn() } as unknown as Texture;
    const late = new Promise<Texture>((resolve) => { resolveLate = resolve; });
    let call = 0;
    vi.spyOn(Texture, "fromURL").mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error("early symbol failure"));
      if (call === 2) return late;
      return Promise.resolve(Texture.EMPTY);
    });
    vi.spyOn(Texture, "removeFromCache");
    vi.spyOn(BaseTexture, "removeFromCache");
    const { loadedSymbolTextures, loadSymbolTextures } = await import("../src/reels/SymbolView");

    await expect(loadSymbolTextures()).rejects.toThrow("early symbol failure");
    expect(loadedSymbolTextures()).toEqual([]);

    const retry = loadSymbolTextures();
    await expect(retry).resolves.toBeUndefined();
    const retryTextureCount = loadedSymbolTextures().length;
    expect(retryTextureCount).toBeGreaterThan(0);

    resolveLate(lateTexture);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadedSymbolTextures()).toHaveLength(retryTextureCount);
    expect(loadedSymbolTextures()).not.toContain(lateTexture);
  });
});
