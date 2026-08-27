import { TextureAtlas } from "@pixi-spine/base";
import { AtlasAttachmentLoader, SkeletonBinary } from "@pixi-spine/runtime-4.1";
import { Texture } from "pixi.js";
import { publicAssetUrl } from "../../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseArrayBuffer,
  readBoundedResponseText,
} from "../../network/boundedResponse";
import { browserAllowsAuthoredPrimalSpine } from "../../assets/primalRuntimePolicy";
import {
  activePrimalRuntimeAssetChannel,
  primalSpineTextureAtlasUrl,
  type PrimalRuntimeAssetChannel,
} from "../../assets/primalRuntimeAssets";
import type { SpineData } from "./SpineAdapter";
import {
  cachedPixiTextureAttempt,
  disposePixiTextureAttempt,
} from "../pixiTextureCleanup";

const ROOT = publicAssetUrl("assets/primal-runtime/spine");

export type PrimalSpineKey =
  | "background"
  | "backgroundFront"
  | "character"
  | "reelFrame"
  | "logoGame"
  | "logoIntro"
  | "featurePreview"
  | "anticipation"
  | "wheel"
  | "wheelHyperspin"
  | "trail"
  | "wheelPopupStart"
  | "wheelSummaryFreespins"
  | "wheelSummaryJackpot"
  | "freeSpinIntroKongQuest"
  | "freeSpinIntroKingSpin"
  | "freeSpinSummary"
  | "freeSpinCounter"
  | "freeSpinRetrigger"
  | "bigWin"
  | "symbol0"
  | "symbol1"
  | "symbol2"
  | "symbol3"
  | "symbol4"
  | "symbol5"
  | "symbol6"
  | "symbol7"
  | "symbol8"
  | "symbol9"
  | "symbolBlurredDummy"
  | "jackpotGrand"
  | "jackpotMega"
  | "jackpotMajor"
  | "jackpotMinor"
  | "jackpotMini"
  | "winBox"
  | "winLabel";

export interface PrimalSpineSpec {
  readonly group: "spine_background" | "spine_symbols" | "spine_ui" | "spine_fps";
  readonly skeleton: string;
  readonly idleAnimation: string;
}

/**
 * 从项目桌面资源包中提取的预设框架。应用程序仅消耗 Spine 数据和图集页面，不依赖任何外部专有 JavaScript 运行时。
 */
export const PRIMAL_SPINE_SPECS: Readonly<Record<PrimalSpineKey, PrimalSpineSpec>> = Object.freeze({
  background: Object.freeze({
    group: "spine_background",
    skeleton: "PR_background",
    idleAnimation: "bg_main_idle",
  }),
  backgroundFront: Object.freeze({
    group: "spine_background",
    skeleton: "PR_background_frnt",
    idleAnimation: "bg_main_idle",
  }),
  character: Object.freeze({
    group: "spine_symbols",
    skeleton: "character",
    idleAnimation: "idle",
  }),
  reelFrame: Object.freeze({
    group: "spine_symbols",
    skeleton: "reel_frame",
    idleAnimation: "stop",
  }),
  logoGame: Object.freeze({
    group: "spine_ui",
    skeleton: "logo_game",
    idleAnimation: "idle",
  }),
  logoIntro: Object.freeze({
    group: "spine_ui",
    skeleton: "logo_intro",
    idleAnimation: "intro_animation",
  }),
  featurePreview: Object.freeze({
    group: "spine_fps",
    skeleton: "fps",
    idleAnimation: "loop",
  }),
  anticipation: Object.freeze({
    group: "spine_ui",
    skeleton: "anticipation",
    idleAnimation: "hidden",
  }),
  wheel: Object.freeze({
    group: "spine_ui",
    skeleton: "wheel",
    idleAnimation: "idle",
  }),
  wheelHyperspin: Object.freeze({
    group: "spine_ui",
    skeleton: "wheel_hyperspin",
    idleAnimation: "hidden",
  }),
  trail: Object.freeze({
    group: "spine_ui",
    skeleton: "trail",
    idleAnimation: "hidden",
  }),
  wheelPopupStart: Object.freeze({
    group: "spine_ui",
    skeleton: "wheel_popup_start",
    idleAnimation: "hidden",
  }),
  wheelSummaryFreespins: Object.freeze({
    group: "spine_ui",
    skeleton: "wheel_summary_freespins",
    idleAnimation: "hidden",
  }),
  wheelSummaryJackpot: Object.freeze({
    group: "spine_ui",
    skeleton: "wheel_summary_jackpot",
    idleAnimation: "hidden",
  }),
  freeSpinIntroKongQuest: Object.freeze({
    group: "spine_ui",
    skeleton: "fs_intro_1",
    idleAnimation: "hidden",
  }),
  freeSpinIntroKingSpin: Object.freeze({
    group: "spine_ui",
    skeleton: "fs_intro_2",
    idleAnimation: "hidden",
  }),
  freeSpinSummary: Object.freeze({
    group: "spine_ui",
    skeleton: "fs_summary",
    idleAnimation: "hidden",
  }),
  freeSpinCounter: Object.freeze({
    group: "spine_ui",
    skeleton: "freespin_counter",
    idleAnimation: "hidden",
  }),
  freeSpinRetrigger: Object.freeze({
    group: "spine_ui",
    skeleton: "freespin_retrigger",
    idleAnimation: "hidden",
  }),
  bigWin: Object.freeze({
    group: "spine_ui",
    skeleton: "BigWin",
    idleAnimation: "hidden",
  }),
  symbol0: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol0",
    idleAnimation: "stop",
  }),
  symbol1: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol1",
    idleAnimation: "stop",
  }),
  symbol2: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol2",
    idleAnimation: "idle",
  }),
  symbol3: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol3",
    idleAnimation: "idle",
  }),
  symbol4: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol4",
    idleAnimation: "idle",
  }),
  symbol5: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol5",
    idleAnimation: "idle",
  }),
  symbol6: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol6",
    idleAnimation: "idle",
  }),
  symbol7: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol7",
    idleAnimation: "idle",
  }),
  symbol8: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol8",
    idleAnimation: "idle",
  }),
  symbol9: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol9",
    idleAnimation: "idle",
  }),
  symbolBlurredDummy: Object.freeze({
    group: "spine_symbols",
    skeleton: "Symbol_blurred_dummy",
    idleAnimation: "animation",
  }),
  jackpotGrand: Object.freeze({
    group: "spine_ui",
    skeleton: "grand_jackpot",
    idleAnimation: "idle",
  }),
  jackpotMega: Object.freeze({
    group: "spine_ui",
    skeleton: "mega_jackpot",
    idleAnimation: "idle",
  }),
  jackpotMajor: Object.freeze({
    group: "spine_ui",
    skeleton: "major_jackpot",
    idleAnimation: "idle",
  }),
  jackpotMinor: Object.freeze({
    group: "spine_ui",
    skeleton: "minor_jackpot",
    idleAnimation: "idle",
  }),
  jackpotMini: Object.freeze({
    group: "spine_ui",
    skeleton: "mini_jackpot",
    idleAnimation: "idle",
  }),
  winBox: Object.freeze({
    group: "spine_ui",
    skeleton: "winbox",
    idleAnimation: "hidden",
  }),
  winLabel: Object.freeze({
    group: "spine_ui",
    skeleton: "winlabel",
    idleAnimation: "hidden",
  }),
});

const dataPromises = new Map<string, Promise<SpineData>>();
const atlasPromises = new Map<string, Promise<TextureAtlas>>();
const PRIMAL_SPINE_ATLAS_PAGE_COUNTS: Readonly<Record<
PrimalRuntimeAssetChannel,
Readonly<Record<PrimalSpineSpec["group"], number>>
>> = Object.freeze({
  desktop: Object.freeze({
    spine_background: 2,
    spine_fps: 2,
    spine_symbols: 3,
    spine_ui: 2,
  }),
  mobile: Object.freeze({
    spine_background: 2,
    spine_fps: 2,
    spine_symbols: 2,
    spine_ui: 2,
  }),
});

export function primalSpineSkeletonUrl(key: PrimalSpineKey): string {
  const spec = PRIMAL_SPINE_SPECS[key];
  return `${ROOT}/${spec.group}/${spec.skeleton}.skel`;
}

export function primalSpineAtlasUrl(
  key: PrimalSpineKey,
  channel: PrimalRuntimeAssetChannel = activePrimalRuntimeAssetChannel(),
): string {
  const spec = PRIMAL_SPINE_SPECS[key];
  return primalSpineTextureAtlasUrl(spec.group, channel);
}

/**
 * pixi-spine 从 atlas 文本回调页面名。只允许当前固定资源族的有界 AVIF
 * basename，禁止绝对 URL、查询串、反斜杠和目录穿越进入 Texture.fromURL。
 */
export function resolvePrimalSpineAtlasPageUrl(
  group: PrimalSpineSpec["group"],
  channel: PrimalRuntimeAssetChannel,
  page: unknown,
): string {
  const level = channel === "mobile" ? 2 : 1;
  const prefix = `${group}_level${level}`;
  if (typeof page !== "string") {
    throw new Error("Invalid Primal Spine atlas page");
  }
  const pageCount = PRIMAL_SPINE_ATLAS_PAGE_COUNTS[channel][group];
  const reviewedPages = Array.from({ length: pageCount }, (_, index) => (
    index === 0 ? `${prefix}.avif` : `${prefix}_${index + 1}.avif`
  ));
  if (!reviewedPages.includes(page)) {
    throw new Error("Invalid Primal Spine atlas page");
  }
  const atlasUrl = primalSpineTextureAtlasUrl(group, channel);
  return `${atlasUrl.slice(0, atlasUrl.lastIndexOf("/") + 1)}${page}`;
}

export function loadPrimalSpineData(
  key: PrimalSpineKey,
  channel: PrimalRuntimeAssetChannel = activePrimalRuntimeAssetChannel(),
): Promise<SpineData> {
  if (!browserAllowsAuthoredPrimalSpine(channel)) {
    return Promise.reject(new Error("Authored Primal Spine assets are disabled for this device profile"));
  }
  const cacheKey = `${channel}:${key}`;
  const cached = dataPromises.get(cacheKey);
  if (cached) return cached;

  const spec = PRIMAL_SPINE_SPECS[key];
  const promise = Promise.all([
    loadAtlas(spec.group, channel),
    fetchBinary(primalSpineSkeletonUrl(key)),
  ]).then(([atlas, binary]) => {
    // pixi-spine 3.1 的通用中间件丢失了 Uint8Array 字节偏移量。使用固定的 4.1 运行时解析确切的响应缓冲区可以避免上游错误，
    // 并使提供的 Spine 4.1.24 文件可靠。
    const parser = new SkeletonBinary(new AtlasAttachmentLoader(atlas));
    return parser.readSkeletonData(new Uint8Array(binary.slice(0))) as SpineData;
  });

  dataPromises.set(cacheKey, promise);
  void promise.catch(() => {
    // 暂时性网络故障必须在稍后启动时保持可重试。
    if (dataPromises.get(cacheKey) === promise) dataPromises.delete(cacheKey);
  });
  return promise;
}

/**
 * 直接解析事件租约已验证的 skeleton 字节；共享 atlas 仍复用首启建立的
 * channel/group Promise，不会再次请求 BigWin.skel URL。
 */
export async function loadPrimalSpineDataFromVerifiedBinary(
  key: PrimalSpineKey,
  binary: Uint8Array,
  channel: PrimalRuntimeAssetChannel = activePrimalRuntimeAssetChannel(),
  signal?: AbortSignal,
): Promise<SpineData> {
  if (!browserAllowsAuthoredPrimalSpine(channel)) {
    throw new Error("Authored Primal Spine assets are disabled for this device profile");
  }
  throwIfPrimalSpineAborted(signal);
  const spec = PRIMAL_SPINE_SPECS[key];
  const atlas = await awaitPrimalSpineAbort(loadAtlas(spec.group, channel), signal);
  throwIfPrimalSpineAborted(signal);
  const parser = new SkeletonBinary(new AtlasAttachmentLoader(atlas));
  const data = parser.readSkeletonData(binary.slice()) as SpineData;
  throwIfPrimalSpineAborted(signal);
  return data;
}

export function loadPrimalSpineSet<const K extends readonly PrimalSpineKey[]>(
  keys: K,
  channel: PrimalRuntimeAssetChannel = activePrimalRuntimeAssetChannel(),
): Promise<{ readonly [P in K[number]]: SpineData }> {
  return Promise.all(keys.map(async (key) => [key, await loadPrimalSpineData(key, channel)] as const))
    .then((entries) => Object.fromEntries(entries) as { readonly [P in K[number]]: SpineData });
}

function loadAtlas(
  group: PrimalSpineSpec["group"],
  channel: PrimalRuntimeAssetChannel,
): Promise<TextureAtlas> {
  const cacheKey = `${channel}:${group}`;
  const cached = atlasPromises.get(cacheKey);
  if (cached) return cached;

  const atlasUrl = primalSpineTextureAtlasUrl(group, channel);
  const promise = fetchText(atlasUrl).then((atlasText) => new Promise<TextureAtlas>((resolve, reject) => {
    let textureError: unknown;
    new TextureAtlas(
      atlasText,
      (page, complete) => {
        let pageUrl: string | null = null;
        try {
          pageUrl = resolvePrimalSpineAtlasPageUrl(group, channel, page);
          const pageAttempt = Texture.fromURL(pageUrl);
          const attemptedTexture = cachedPixiTextureAttempt(pageUrl);
          void pageAttempt.then(
            (texture) => complete(texture.baseTexture),
            (error: unknown) => {
              // Pixi 6 会在 Promise 拒绝前把页面对象留在全局 cache；仅按本次
              // Texture.fromURL 同步捕获的对象身份驱逐，使下一次 atlas 加载可重试。
              disposePixiTextureAttempt(attemptedTexture);
              textureError ??= error;
              // 让 atlas 解析器在拒绝外部 Promise 之前正常终止，而不是让其回调链挂起。
              complete(Texture.EMPTY.baseTexture);
            },
          );
        } catch (error) {
          // 第三方解析器提供的页名或同步 Texture 错误都必须完成回调，避免解析悬挂。
          if (pageUrl) disposePixiTextureAttempt(cachedPixiTextureAttempt(pageUrl));
          textureError ??= error;
          complete(Texture.EMPTY.baseTexture);
        }
      },
      (atlas) => {
        if (textureError) {
          reject(asAssetError(atlasUrl, textureError));
          return;
        }
        resolve(atlas);
      },
    );
  }));

  atlasPromises.set(cacheKey, promise);
  void promise.catch(() => {
    if (atlasPromises.get(cacheKey) === promise) atlasPromises.delete(cacheKey);
  });
  return promise;
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to load ${url}: HTTP ${response.status}`);
    cancelNetworkResponse(response, error);
    throw error;
  }
  return readBoundedResponseArrayBuffer(response, {
    label: "Spine binary response",
    maxBytes: NETWORK_RESPONSE_LIMITS.spineBinaryBytes,
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Failed to load ${url}: HTTP ${response.status}`);
    cancelNetworkResponse(response, error);
    throw error;
  }
  return readBoundedResponseText(response, {
    label: "Spine atlas response",
    maxBytes: NETWORK_RESPONSE_LIMITS.rendererTextBytes,
  });
}

function asAssetError(url: string, error: unknown): Error {
  return error instanceof Error
    ? new Error(`Failed to load ${url}: ${error.message}`)
    : new Error(`Failed to load ${url}`);
}

function awaitPrimalSpineAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(primalSpineAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(primalSpineAbortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfPrimalSpineAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw primalSpineAbortReason(signal);
}

function primalSpineAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Primal Spine verified binary load was aborted");
  error.name = "AbortError";
  return error;
}
