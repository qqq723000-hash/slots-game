import type { PrimalRuntimeAssetChannel } from "./primalRuntimeAssets";

export type PrimalRuntimeMode = "auto" | "force" | "off";

export interface PrimalRuntimeCapabilities {
  readonly mode: PrimalRuntimeMode;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly coarsePointer: boolean;
  readonly deviceMemoryGb: number | null;
  readonly hardwareConcurrency: number | null;
  readonly maxTextureSize: number | null;
}

const REQUIRED_TEXTURE_SIZE = 4_096;
const DESKTOP_MEMORY_FLOOR_GB = 8;
const DESKTOP_VIEWPORT_FLOOR = 1_200;
const MOBILE_MEMORY_FLOOR_GB = 4;
const MOBILE_CONCURRENCY_FLOOR = 2;

export function shouldUseAuthoredPrimalSpine(
  capabilities: PrimalRuntimeCapabilities,
  channel: PrimalRuntimeAssetChannel = "desktop",
): boolean {
  if (capabilities.mode === "force") return true;
  if (capabilities.mode === "off") return false;
  if (capabilities.maxTextureSize !== null
    && capabilities.maxTextureSize < REQUIRED_TEXTURE_SIZE) return false;
  // 角色动作属于必需表现资产而非可选增强；桌面端与 Level2 手机图集都能放入
  // 4096 纹理页，因此 RAM/指针启发式不得静默把已制作 Spine 替换成位图。
  void channel;
  return true;
}

export function shouldUsePrimalAudioSprites(
  capabilities: PrimalRuntimeCapabilities,
  channel: PrimalRuntimeAssetChannel = "desktop",
): boolean {
  if (capabilities.mode === "force") return true;
  if (capabilities.mode === "off") return false;
  if (channel === "desktop"
    && capabilities.hardwareConcurrency !== null
    && capabilities.hardwareConcurrency <= 4
    && capabilities.deviceMemoryGb !== null
    && capabilities.deviceMemoryGb < DESKTOP_MEMORY_FLOOR_GB) return false;
  return channel === "mobile"
    ? hasMobileMemoryBudget(capabilities)
    : hasDesktopMemoryBudget(capabilities);
}

let cachedCapabilities: PrimalRuntimeCapabilities | null = null;

export function browserPrimalRuntimeCapabilities(): PrimalRuntimeCapabilities {
  cachedCapabilities ??= detectBrowserCapabilities();
  return cachedCapabilities;
}

export function browserAllowsAuthoredPrimalSpine(
  channel: PrimalRuntimeAssetChannel = "desktop",
): boolean {
  return shouldUseAuthoredPrimalSpine(browserPrimalRuntimeCapabilities(), channel);
}

export function browserAllowsPrimalAudioSprites(
  channel: PrimalRuntimeAssetChannel = "desktop",
): boolean {
  return shouldUsePrimalAudioSprites(browserPrimalRuntimeCapabilities(), channel);
}

function hasDesktopMemoryBudget(capabilities: PrimalRuntimeCapabilities): boolean {
  if (capabilities.deviceMemoryGb !== null
    && capabilities.deviceMemoryGb < DESKTOP_MEMORY_FLOOR_GB) return false;
  const longestViewportEdge = Math.max(
    capabilities.viewportWidth,
    capabilities.viewportHeight,
  );
  if (capabilities.coarsePointer && longestViewportEdge < DESKTOP_VIEWPORT_FLOOR) {
    return false;
  }
  return true;
}

function hasMobileMemoryBudget(capabilities: PrimalRuntimeCapabilities): boolean {
  if (capabilities.deviceMemoryGb !== null
    && capabilities.deviceMemoryGb < MOBILE_MEMORY_FLOOR_GB) return false;
  if (capabilities.hardwareConcurrency !== null
    && capabilities.hardwareConcurrency <= MOBILE_CONCURRENCY_FLOOR) return false;
  return true;
}

function detectBrowserCapabilities(): PrimalRuntimeCapabilities {
  const scope = globalThis as typeof globalThis & {
    innerWidth?: number;
    innerHeight?: number;
    matchMedia?: (query: string) => MediaQueryList;
    navigator?: Navigator & { deviceMemory?: number };
    document?: Document;
  };
  const mode = runtimeMode(import.meta.env.VITE_PRIMAL_RUNTIME_MODE);
  const navigator = scope.navigator;
  return {
    mode,
    viewportWidth: finiteOr(scope.innerWidth, 1_280),
    viewportHeight: finiteOr(scope.innerHeight, 720),
    coarsePointer: scope.matchMedia?.("(pointer: coarse)").matches ?? false,
    deviceMemoryGb: finiteOrNull(navigator?.deviceMemory),
    hardwareConcurrency: finiteOrNull(navigator?.hardwareConcurrency),
    maxTextureSize: detectMaxTextureSize(scope.document),
  };
}

function runtimeMode(value: string | undefined): PrimalRuntimeMode {
  return value === "force" || value === "off" ? value : "auto";
}

function detectMaxTextureSize(document: Document | undefined): number | null {
  if (!document) return null;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return null;
    const size = finiteOrNull(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return size;
  } catch {
    return null;
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
