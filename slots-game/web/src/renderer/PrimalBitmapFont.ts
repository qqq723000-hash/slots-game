import { BaseTexture, BitmapFont, Texture } from "pixi.js";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseText,
} from "../network/boundedResponse";

export const PRIMAL_BITMAP_FONT_NAME = "PrimalRampage";
export const PRIMAL_BITMAP_FONT_SIZE = 295;
export const PRIMAL_BITMAP_FONT_LINE_HEIGHT = 541;
export const PRIMAL_BITMAP_FONT_BASE = 296;
export const PRIMAL_BITMAP_FONT_DISPLAY_SIZE = 105;
export const PRIMAL_BITMAP_FONT_URL = publicAssetUrl(
  "assets/primal-runtime/fonts/primal-rampage/PrimalRampage.fnt",
);
export const PRIMAL_BITMAP_FONT_PAGE_FILE = "PrimalRampage.png";
export const PRIMAL_BITMAP_FONT_PAGE_URL = publicAssetUrl(
  "assets/primal-runtime/fonts/primal-rampage/PrimalRampage.png",
);

let loadPromise: Promise<boolean> | null = null;

/** 加载并注册嵌入在捕获的主包中的确切 BMFont。 */
export function loadPrimalBitmapFont(): Promise<boolean> {
  if (BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]) return Promise.resolve(true);
  if (loadPromise) return loadPromise;
  if (typeof document === "undefined") return Promise.resolve(false);

  const attempt = loadAndInstallPrimalBitmapFont();
  loadPromise = attempt;
  void attempt.then((loaded) => {
    if (!loaded && loadPromise === attempt) loadPromise = null;
  });
  return attempt;
}

async function loadAndInstallPrimalBitmapFont(): Promise<boolean> {
  let pageLoadStarted = false;
  try {
    const response = await fetch(PRIMAL_BITMAP_FONT_URL);
    if (!response.ok) {
      cancelNetworkResponse(response, new Error("Bitmap font descriptor request failed"));
      return false;
    }
    const descriptor = await readBoundedResponseText(response, {
      label: "Bitmap font descriptor",
      maxBytes: NETWORK_RESPONSE_LIMITS.rendererTextBytes,
    });
    pageLoadStarted = true;
    const pageTexture = await Texture.fromURL(PRIMAL_BITMAP_FONT_PAGE_URL);
    // `true` 保留 Pixi 6 BitmapFontLoader 所有权：卸载此 BMFont 会处置其页面纹理及其派生的字形纹理。
    BitmapFont.install(descriptor, {
      [PRIMAL_BITMAP_FONT_PAGE_FILE]: pageTexture,
    }, true);
    return Boolean(BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]);
  } catch {
    // Texture.fromURL 缓存被拒绝的图像资源。删除失败的共享页面，以便下一次 Big Win 预加载可以进行真正的重试。
    if (pageLoadStarted) clearFailedPrimalBitmapFontPage();
    return false;
  }
}

function clearFailedPrimalBitmapFontPage(): void {
  const cachedTexture = Texture.removeFromCache(PRIMAL_BITMAP_FONT_PAGE_URL);
  cachedTexture?.destroy(true);
  const cachedBaseTexture = BaseTexture.removeFromCache(PRIMAL_BITMAP_FONT_PAGE_URL);
  cachedBaseTexture?.destroy();
}
