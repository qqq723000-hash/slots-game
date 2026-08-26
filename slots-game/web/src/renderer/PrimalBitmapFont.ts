import { BitmapFont, BitmapFontData, Texture } from "pixi.js";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseText,
} from "../network/boundedResponse";
import {
  cachedPixiTextureAttempt,
  disposePixiTextureAttempt,
} from "./pixiTextureCleanup";

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
export const PRIMAL_BITMAP_FONT_DESCRIPTOR_MAX_BYTES = 8 * 1024;
export const PRIMAL_BITMAP_FONT_DECLARED_CHAR_COUNT = 46;
export const PRIMAL_BITMAP_FONT_GLYPH_COUNT = 47;

const PRIMAL_BITMAP_FONT_GLYPH_IDS = Object.freeze([
  32, 9, 36, 44, 45, 46,
  48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
  65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
  83, 84, 85, 86, 87, 88, 89, 90,
  107, 114, 163, 165, 8364,
]);
const PRIMAL_BITMAP_FONT_CHAR_PATTERN = /^<char id='([0-9]{1,7})' x='([0-9]{1,4})' y='([0-9]{1,4})' width='([0-9]{1,4})' height='([0-9]{1,4})' xoffset='(-?[0-9]{1,4})' yoffset='(-?[0-9]{1,4})' xadvance='(-?[0-9]{1,4})' letter='([^'<>]{0,2})'\/>$/u;

function invalidPrimalBitmapFontDescriptor(): never {
  throw new Error("Invalid Primal bitmap font descriptor");
}

function boundedFontInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) {
    return invalidPrimalBitmapFontDescriptor();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalidPrimalBitmapFontDescriptor();
  }
  return parsed;
}

/**
 * 只接受随当前发行版捕获的单页、无 kerning BMFont 窄语法。这里刻意不使用
 * DOMParser/XML 字符串入口，从而在 `require-trusted-types-for 'script'` 下保持无违规。
 */
export function parsePrimalBitmapFontDescriptor(descriptor: string): BitmapFontData {
  if (typeof descriptor !== "string"
    || descriptor.length === 0
    || descriptor.length > PRIMAL_BITMAP_FONT_DESCRIPTOR_MAX_BYTES
    || descriptor.includes("\r")
    || descriptor.includes("\0")) {
    return invalidPrimalBitmapFontDescriptor();
  }
  const normalized = descriptor.endsWith("\n") ? descriptor.slice(0, -1) : descriptor;
  const lines = normalized.split("\n");
  const expectedLineCount = 9 + PRIMAL_BITMAP_FONT_GLYPH_COUNT;
  if (lines.length !== expectedLineCount
    || lines[0] !== "<font>"
    || lines[1] !== `<info face='${PRIMAL_BITMAP_FONT_NAME}' size='${PRIMAL_BITMAP_FONT_SIZE}'/>`
    || lines[2] !== `<common lineHeight='${PRIMAL_BITMAP_FONT_LINE_HEIGHT}' base='${PRIMAL_BITMAP_FONT_BASE}' pages='1'/>`
    || lines[3] !== "<pages>"
    || lines[4] !== `<page id='0' file='${PRIMAL_BITMAP_FONT_PAGE_FILE}'/>`
    || lines[5] !== "</pages>"
    || lines[6] !== `<chars count='${PRIMAL_BITMAP_FONT_DECLARED_CHAR_COUNT}'>`
    || lines.at(-2) !== "</chars>"
    || lines.at(-1) !== "</font>") {
    return invalidPrimalBitmapFontDescriptor();
  }

  const data = new BitmapFontData();
  data.info.push({ face: PRIMAL_BITMAP_FONT_NAME, size: PRIMAL_BITMAP_FONT_SIZE });
  data.common.push({ lineHeight: PRIMAL_BITMAP_FONT_LINE_HEIGHT });
  data.page.push({ id: 0, file: PRIMAL_BITMAP_FONT_PAGE_FILE });
  const glyphLines = lines.slice(7, -2);
  if (glyphLines.length !== PRIMAL_BITMAP_FONT_GLYPH_COUNT) {
    return invalidPrimalBitmapFontDescriptor();
  }
  for (let index = 0; index < glyphLines.length; index += 1) {
    const match = PRIMAL_BITMAP_FONT_CHAR_PATTERN.exec(glyphLines[index]!);
    if (!match) return invalidPrimalBitmapFontDescriptor();
    const id = boundedFontInteger(match[1], 0, 0x10_FFFF);
    if (id !== PRIMAL_BITMAP_FONT_GLYPH_IDS[index]) {
      return invalidPrimalBitmapFontDescriptor();
    }
    const letter = match[9];
    const expectedLetter = id === 9 ? "" : String.fromCodePoint(id);
    if (letter !== expectedLetter) return invalidPrimalBitmapFontDescriptor();
    data.char.push({
      id,
      page: 0,
      x: boundedFontInteger(match[2], 0, 4_096),
      y: boundedFontInteger(match[3], 0, 4_096),
      width: boundedFontInteger(match[4], 0, 4_096),
      height: boundedFontInteger(match[5], 0, 4_096),
      xoffset: boundedFontInteger(match[6], -4_096, 4_096),
      yoffset: boundedFontInteger(match[7], -4_096, 4_096),
      xadvance: boundedFontInteger(match[8], -4_096, 4_096),
    });
  }
  return data;
}

interface PrimalBitmapFontLoadAttempt {
  readonly controller: AbortController;
  readonly promise: Promise<boolean>;
  readonly consumers: Set<symbol>;
}

let activeLoadAttempt: PrimalBitmapFontLoadAttempt | null = null;
let installedPageTexture: Texture | null = null;

export interface PrimalBitmapFontVerifiedInstallResult {
  readonly installed: boolean;
  /** true 表示 BitmapFont 已接管页面纹理；false 时调用者仍拥有它。 */
  readonly adoptedPageTexture: boolean;
}

/**
 * 用事件租约已验证的描述符与页面纹理安装字体，不再读取描述符/PNG URL。
 * 已存在字体时不会错误接管调用者的新纹理，供共享金币图集继续使用并自行释放。
 */
export function installPrimalBitmapFontFromVerifiedDescriptor(
  descriptor: string,
  pageTexture: Texture,
): PrimalBitmapFontVerifiedInstallResult {
  if (BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]) {
    return Object.freeze({ installed: true, adoptedPageTexture: false });
  }
  try {
    const fontData = parsePrimalBitmapFontDescriptor(descriptor);
    BitmapFont.install(fontData, {
      [PRIMAL_BITMAP_FONT_PAGE_FILE]: pageTexture,
    }, true);
    const installed = Boolean(BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]);
    if (installed) installedPageTexture = pageTexture;
    return Object.freeze({ installed, adoptedPageTexture: installed });
  } catch {
    const installed = Boolean(BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]);
    if (installed) installedPageTexture = pageTexture;
    return Object.freeze({ installed, adoptedPageTexture: installed });
  }
}

/** 加载并注册嵌入在捕获的主包中的确切 BMFont。 */
export function loadPrimalBitmapFont(signal?: AbortSignal): Promise<boolean> {
  if (BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]) return Promise.resolve(true);
  if (typeof document === "undefined") return Promise.resolve(false);
  if (signal?.aborted) return Promise.resolve(false);

  let attempt = activeLoadAttempt;
  if (!attempt) {
    const controller = new AbortController();
    const promise = loadAndInstallPrimalBitmapFont(controller.signal);
    attempt = { controller, promise, consumers: new Set() };
    activeLoadAttempt = attempt;
    const ownedAttempt = attempt;
    void promise.then(() => {
      if (activeLoadAttempt === ownedAttempt) activeLoadAttempt = null;
    });
  }
  return subscribeToPrimalBitmapFontLoad(attempt, signal);
}

function subscribeToPrimalBitmapFontLoad(
  attempt: PrimalBitmapFontLoadAttempt,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const consumer = Symbol("primal-bitmap-font-consumer");
  attempt.consumers.add(consumer);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (loaded: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      attempt.consumers.delete(consumer);
      resolve(loaded);
    };
    const onAbort = (): void => {
      finish(false);
      // 只有最后一个活跃订阅者离开才取消共享 attempt；先脱离全局槽位，使调用者
      // 在 abort 后立即重试时创建新代，而不会重新订阅已中止的 Promise。
      if (attempt.consumers.size === 0 && activeLoadAttempt === attempt) {
        activeLoadAttempt = null;
        attempt.controller.abort(primalBitmapFontAbortReason(signal!));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void attempt.promise.then(finish, () => finish(false));
  });
}

async function loadAndInstallPrimalBitmapFont(signal: AbortSignal): Promise<boolean> {
  let pageTexture: Texture | null = null;
  try {
    const response = await fetch(PRIMAL_BITMAP_FONT_URL, {
      credentials: "same-origin",
      signal,
    });
    if (!response.ok) {
      cancelNetworkResponse(response, new Error("Bitmap font descriptor request failed"));
      return false;
    }
    const descriptor = await readBoundedResponseText(response, {
      label: "Bitmap font descriptor",
      maxBytes: Math.min(
        NETWORK_RESPONSE_LIMITS.rendererTextBytes,
        PRIMAL_BITMAP_FONT_DESCRIPTOR_MAX_BYTES,
      ),
      signal,
    });
    const fontData = parsePrimalBitmapFontDescriptor(descriptor);
    pageTexture = await waitForPrimalBitmapFontPage(signal);
    if (signal.aborted) {
      disposePixiTextureAttempt(pageTexture, [installedPageTexture]);
      return false;
    }
    // `true` 保留 Pixi 6 BitmapFontLoader 所有权：卸载此 BMFont 会处置其页面纹理及其派生的字形纹理。
    BitmapFont.install(fontData, {
      [PRIMAL_BITMAP_FONT_PAGE_FILE]: pageTexture,
    }, true);
    const installed = Boolean(BitmapFont.available[PRIMAL_BITMAP_FONT_NAME]);
    if (installed) installedPageTexture = pageTexture;
    else disposePixiTextureAttempt(pageTexture, [installedPageTexture]);
    return installed;
  } catch {
    // waitForPrimalBitmapFontPage 已按 attempt 对象身份清理加载失败；此处再兜住
    // BitmapFont.install 同步抛错，并且绝不按 URL 触碰可能属于新代的页面。
    disposePixiTextureAttempt(pageTexture, [installedPageTexture]);
    return false;
  }
}

function waitForPrimalBitmapFontPage(signal: AbortSignal): Promise<Texture> {
  let attempt: Promise<Texture>;
  try {
    attempt = Texture.fromURL(PRIMAL_BITMAP_FONT_PAGE_URL);
  } catch (error) {
    // Texture.fromURL 会先同步登记 cache 再调用 resource.load；同步异常仍只清理
    // 这一刻捕获到的具体对象，调用者尚不可能启动下一代。
    disposePixiTextureAttempt(
      cachedPixiTextureAttempt(PRIMAL_BITMAP_FONT_PAGE_URL),
      [installedPageTexture],
    );
    throw error;
  }
  const attemptedTexture = cachedPixiTextureAttempt(PRIMAL_BITMAP_FONT_PAGE_URL);
  return new Promise<Texture>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const disposeAttempt = (resolvedTexture?: Texture): void => {
      disposePixiTextureAttempt(attemptedTexture, [installedPageTexture]);
      if (resolvedTexture && resolvedTexture !== attemptedTexture) {
        disposePixiTextureAttempt(resolvedTexture, [installedPageTexture]);
      }
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      disposeAttempt();
      reject(primalBitmapFontAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void attempt.then(
      (texture) => {
        if (settled) {
          // 底层传输不可取消；晚到完成只处置本 attempt 捕获/返回的对象，绝不按 URL
          // 驱逐同地址的新代缓存或已安装字体页面。
          disposeAttempt(texture);
          return;
        }
        settled = true;
        cleanup();
        if (signal.aborted) {
          disposeAttempt(texture);
          reject(primalBitmapFontAbortReason(signal));
          return;
        }
        resolve(texture);
      },
      (error: unknown) => {
        if (settled) {
          disposeAttempt();
          return;
        }
        settled = true;
        cleanup();
        disposeAttempt();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function primalBitmapFontAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Primal bitmap font load was aborted");
  error.name = "AbortError";
  return error;
}
