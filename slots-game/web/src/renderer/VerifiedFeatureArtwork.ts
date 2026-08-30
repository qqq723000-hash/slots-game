import type { Texture } from "pixi.js";
import { PRIMAL_ASSETS } from "../assets/PrimalAssetManifest";
import type { PrimalRuntimeAssetChannel } from "../assets/primalRuntimeAssets";
import { publicAssetPathPrefix } from "../assets/publicAssetUrl";
import type {
  LoadedAssetPackage,
  LoadedAssetResource,
} from "../startup/StreamingAssetPackages";
import {
  loadPrimalSpineDataFromVerifiedBinary,
  primalSpineSkeletonUrl,
  type PrimalSpineKey,
} from "./spine/PrimalSpineAssets";
import type { SpineData } from "./spine/SpineAdapter";
import {
  disposePixiTextureAttempt,
  loadPixiTextureFromVerifiedBytes,
} from "./pixiTextureCleanup";

export type VerifiedFeatureArtworkKind = "free-spins" | "wheel";

export const FREE_SPIN_VERIFIED_SPINE_KEYS = Object.freeze([
  "freeSpinCounter",
  "freeSpinRetrigger",
  "freeSpinIntroKongQuest",
  "freeSpinIntroKingSpin",
  "freeSpinSummary",
] as const);

export const WHEEL_VERIFIED_SPINE_KEYS = Object.freeze([
  "wheel",
  "wheelHyperspin",
  "wheelPopupStart",
  "wheelSummaryFreespins",
  "wheelSummaryJackpot",
] as const);

export interface VerifiedFreeSpinArtwork {
  readonly kind: "free-spins";
  readonly channel: PrimalRuntimeAssetChannel;
  readonly spines: Readonly<Record<(typeof FREE_SPIN_VERIFIED_SPINE_KEYS)[number], SpineData>>;
}

export interface VerifiedWheelArtwork {
  readonly kind: "wheel";
  readonly channel: PrimalRuntimeAssetChannel;
  readonly spines: Readonly<Record<(typeof WHEEL_VERIFIED_SPINE_KEYS)[number], SpineData>>;
  readonly ownsTextures: boolean;
  /** 三张纹理均由唯一 blob attempt 创建，所有权转交给 FeatureEffects。 / English: All three textures were created by a unique blob attempt and ownership is transferred to FeatureEffects. */
  readonly textures: Readonly<{
    blue: Texture;
    red: Texture;
    dual: Texture;
  }>;
}

export type VerifiedFeatureArtwork = VerifiedFreeSpinArtwork | VerifiedWheelArtwork;

const WHEEL_TEXTURES = Object.freeze([
  Object.freeze({ key: "blue" as const, url: PRIMAL_ASSETS.features.wheelBlue }),
  Object.freeze({ key: "red" as const, url: PRIMAL_ASSETS.features.wheelRed }),
  Object.freeze({ key: "dual" as const, url: PRIMAL_ASSETS.features.wheelDual }),
]);

/**
 * 只接受目标 feature-on-demand 包。依赖包由外层事件租约保持，但不会在这里
 * 冒充目标包资源或重复解码。
 *
 * 英文 / English: Only target feature-on-demand packages are accepted. Dependent packages are held by the outer event lease, but are not impersonated as target package resources or decoded repeatedly.
 */
export async function verifiedFeatureArtworkFromPackage(
  loaded: LoadedAssetPackage,
  kind: VerifiedFeatureArtworkKind,
  signal?: AbortSignal,
): Promise<VerifiedFeatureArtwork> {
  const channel = verifiedFeaturePackageChannel(loaded, kind);
  throwIfFeatureArtworkAborted(signal);
  if (kind === "free-spins") {
    const spines = await parseVerifiedSpines(
      loaded,
      FREE_SPIN_VERIFIED_SPINE_KEYS,
      channel,
      signal,
    );
    throwIfFeatureArtworkAborted(signal);
    return Object.freeze({ kind, channel, spines });
  }

  const spines = await parseVerifiedSpines(
    loaded,
    WHEEL_VERIFIED_SPINE_KEYS,
    channel,
    signal,
  );
  const adopted: Partial<Record<(typeof WHEEL_TEXTURES)[number]["key"], Texture>> = {};
  try {
    // 顺序解码使失败回滚拥有完整、确定的旧代集合；每个底层 attempt 自身仍可取消。 / English: Sequential decoding enables rollback on failure to have a complete, deterministic set of old generations; each underlying attempt itself remains cancelable.
    for (const spec of WHEEL_TEXTURES) {
      throwIfFeatureArtworkAborted(signal);
      const resource = requiredVerifiedFeatureResource(loaded, spec.url, "binary");
      adopted[spec.key] = await loadPixiTextureFromVerifiedBytes(
        resource.bytes,
        "image/png",
        signal,
      );
    }
    throwIfFeatureArtworkAborted(signal);
    return Object.freeze({
      kind,
      channel,
      spines,
      ownsTextures: true,
      textures: Object.freeze({
        blue: adopted.blue!,
        red: adopted.red!,
        dual: adopted.dual!,
      }),
    });
  } catch (error) {
    for (const texture of Object.values(adopted)) {
      disposePixiTextureAttempt(texture ?? null);
    }
    throw error;
  }
}

export function disposeVerifiedWheelArtwork(
  artwork: VerifiedWheelArtwork | null | undefined,
): void {
  if (!artwork?.ownsTextures) return;
  const textures = Object.values(artwork.textures);
  for (const texture of textures) {
    disposePixiTextureAttempt(texture, textures.filter((candidate) => candidate !== texture));
  }
}

function verifiedFeaturePackageChannel(
  loaded: LoadedAssetPackage,
  kind: VerifiedFeatureArtworkKind,
): PrimalRuntimeAssetChannel {
  if (loaded.stage !== "feature-on-demand") {
    throw new Error("Invalid verified feature asset package");
  }
  if (loaded.id === `desktop-feature-${kind}`) return "desktop";
  if (loaded.id === `mobile-feature-${kind}`) return "mobile";
  throw new Error("Invalid verified feature asset package");
}

async function parseVerifiedSpines<const K extends readonly PrimalSpineKey[]>(
  loaded: LoadedAssetPackage,
  keys: K,
  channel: PrimalRuntimeAssetChannel,
  signal?: AbortSignal,
): Promise<Readonly<Record<K[number], SpineData>>> {
  const entries = await Promise.all(keys.map(async (key) => {
    const resource = requiredVerifiedFeatureResource(
      loaded,
      primalSpineSkeletonUrl(key),
      "binary",
    );
    const data = await loadPrimalSpineDataFromVerifiedBinary(
      key,
      resource.bytes,
      channel,
      signal,
    );
    return [key, data] as const;
  }));
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<K[number], SpineData>>;
}

function requiredVerifiedFeatureResource(
  loaded: LoadedAssetPackage,
  url: string,
  decoder: "binary",
): LoadedAssetResource {
  const expected = normalizedVerifiedFeatureAssetPath(url);
  const resource = [...loaded.resources.values()].find((candidate) => (
    // streaming manifest 保留 `/assets/...` 根相对键，实际请求才按 Vite BASE_URL 重基。 / English: The streaming manifest retains the `/assets/...` root relative key, and the actual request is based on Vite BASE_URL.
    normalizedVerifiedFeatureAssetPath(candidate.spec.url, "/") === expected
      && candidate.spec.decoder === decoder
  ));
  if (!resource || resource.bytes.byteLength !== resource.spec.bytes) {
    throw new Error("Verified feature asset package is incomplete");
  }
  return resource;
}

export function normalizedVerifiedFeatureAssetPath(
  value: string,
  baseUrl: string = import.meta.env.BASE_URL || "/",
): string {
  try {
    const parsed = new URL(value, "https://verified-assets.invalid");
    if (parsed.search || parsed.hash) throw new Error("query not allowed");
    const prefix = publicAssetPathPrefix(baseUrl);
    if (!parsed.pathname.startsWith(prefix)) throw new Error("asset path required");
    const key = parsed.pathname.slice(prefix.length);
    if (!key) throw new Error("asset file required");
    return key;
  } catch {
    throw new Error("Invalid verified feature asset path");
  }
}

function throwIfFeatureArtworkAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Verified feature artwork load was aborted");
  error.name = "AbortError";
  throw error;
}
