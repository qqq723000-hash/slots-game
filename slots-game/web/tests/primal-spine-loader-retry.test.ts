import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseTexture, Texture, utils } from "pixi.js";

vi.mock("@pixi-spine/base", () => ({
  TextureAtlas: class TextureAtlas {
    constructor(
      atlasText: string,
      loadPage: (page: string, complete: (baseTexture: unknown) => void) => void,
      completeAtlas: (atlas: unknown) => void,
    ) {
      const pages = atlasText.split("\n").filter(Boolean);
      let remaining = pages.length;
      for (const page of pages) {
        loadPage(page, () => {
          remaining -= 1;
          if (remaining === 0) completeAtlas(this);
        });
      }
    }
  },
}));

vi.mock("@pixi-spine/runtime-4.1", () => ({
  AtlasAttachmentLoader: class AtlasAttachmentLoader {
    constructor(readonly atlas: unknown) {}
  },
  SkeletonBinary: class SkeletonBinary {
    constructor(readonly loader: unknown) {}
    readSkeletonData(): unknown { return { retryableSpine: true }; }
  },
}));

import {
  loadPrimalSpineData,
  loadPrimalSpineDataFromVerifiedBinary,
} from "../src/renderer/spine/PrimalSpineAssets";

const atlasPages = [
  "spine_fps_level1.avif",
  "spine_fps_level1_2.avif",
] as const;
const pageUrls = atlasPages.map((page) => (
  `/assets/primal-runtime/spine/spine_fps/${page}`
));
const uiAtlasPages = ["spine_ui_level1.avif", "spine_ui_level1_2.avif"] as const;
const uiPageUrls = uiAtlasPages.map((page) => (
  `/assets/primal-runtime/spine/spine_ui/${page}`
));

function cacheAttemptTexture(url: string): Texture {
  const baseTexture = new BaseTexture();
  const texture = new Texture(baseTexture);
  baseTexture.cacheId = url;
  BaseTexture.addToCache(baseTexture, url);
  Texture.addToCache(texture, url);
  return texture;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const url of [...pageUrls, ...uiPageUrls]) {
    const texture = Texture.removeFromCache(url);
    texture?.destroy(true);
    BaseTexture.removeFromCache(url)?.destroy();
  }
});

describe("Primal Spine page retry", () => {
  it("parses verified BigWin bytes without requesting the skeleton URL", async () => {
    const atlasText = uiAtlasPages.join("\n");
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toMatch(/spine_ui\.atlas$/u);
      return new Response(atlasText, {
        headers: { "content-length": String(atlasText.length) },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const fromUrl = vi.spyOn(Texture, "fromURL").mockImplementation((url) => (
      Promise.resolve(utils.TextureCache[String(url)] ?? cacheAttemptTexture(String(url)))
    ));

    await expect(loadPrimalSpineDataFromVerifiedBinary(
      "bigWin",
      Uint8Array.of(1, 2, 3),
      "desktop",
    )).resolves.toEqual({ retryableSpine: true });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/BigWin.skel"))).toBe(false);
    expect(fromUrl.mock.calls.map(([url]) => String(url))).toEqual(uiPageUrls);
  });

  it("evicts only the rejected page attempt and lets the next atlas load succeed", async () => {
    const atlasText = atlasPages.join("\n");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith(".atlas")) {
        return Promise.resolve(new Response(atlasText, {
          headers: { "content-length": String(atlasText.length) },
        }));
      }
      const skeleton = new Uint8Array([1]);
      return Promise.resolve(new Response(skeleton, {
        headers: { "content-length": String(skeleton.byteLength) },
      }));
    }));

    let firstPageAttempt: Texture | null = null;
    let rejectFirstPage = true;
    const fromUrl = vi.spyOn(Texture, "fromURL").mockImplementation((url) => {
      const pageUrl = String(url);
      const cached = utils.TextureCache[pageUrl] ?? cacheAttemptTexture(pageUrl);
      if (rejectFirstPage) {
        rejectFirstPage = false;
        firstPageAttempt = cached;
        return Promise.reject(new Error("transient Spine page failure"));
      }
      return Promise.resolve(cached);
    });

    await expect(loadPrimalSpineData("featurePreview", "desktop"))
      .rejects.toThrow("transient Spine page failure");
    expect(firstPageAttempt).not.toBeNull();
    expect(utils.TextureCache[pageUrls[0]!]).toBeUndefined();
    expect(utils.BaseTextureCache[pageUrls[0]!]).toBeUndefined();

    await expect(loadPrimalSpineData("featurePreview", "desktop"))
      .resolves.toEqual({ retryableSpine: true });
    expect(fromUrl).toHaveBeenCalledTimes(4);
    expect(utils.TextureCache[pageUrls[0]!]).not.toBe(firstPageAttempt);
  });
});
