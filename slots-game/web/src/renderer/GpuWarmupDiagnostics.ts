export const GPU_WARMUP_TOP_SLOW_LIMIT = 8;
export const GPU_WARMUP_RESOURCE_LIMIT = 4;
export const GPU_WARMUP_PUBLIC_URL_LIMIT = 180;

const SAFE_LABEL = /^[A-Za-z][A-Za-z0-9-]{0,47}$/;

export interface GpuWarmupBaseTextureLike {
  readonly cacheId?: unknown;
  readonly textureCacheIds?: readonly unknown[];
  readonly realWidth?: unknown;
  readonly realHeight?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly resource?: Readonly<{
    readonly src?: unknown;
    readonly url?: unknown;
  }> | null;
}

export interface GpuWarmupResourceDiagnostic {
  readonly cacheId: string | null;
  readonly url: string | null;
  readonly width: number;
  readonly height: number;
  readonly estimatedRgbaBytes: number;
}

export interface GpuWarmupUploadDiagnostic {
  readonly group: string;
  readonly groupIndex: number;
  readonly targetType: string;
  readonly durationMs: number;
  readonly textureCount: number;
  readonly totalEstimatedRgbaBytes: number;
  readonly resources: readonly GpuWarmupResourceDiagnostic[];
}

export interface GpuWarmupDisplayObjectLike {
  readonly texture?: Readonly<{ readonly baseTexture?: GpuWarmupBaseTextureLike }>;
  readonly children?: readonly GpuWarmupDisplayObjectLike[];
  readonly parent?: unknown;
  readonly renderable?: boolean;
  readonly transform?: unknown | null;
}

export interface CreateGpuWarmupUploadDiagnosticOptions {
  readonly group: string;
  readonly groupIndex: number;
  readonly targetType: string;
  readonly durationMs: number;
  readonly baseTextures: readonly GpuWarmupBaseTextureLike[];
  readonly origin?: string | null;
}

/**
 * 确保 DOM 数据属性的诊断安全：只有来自当前源的 `/assets/` 路径能够幸存，而凭证/查询/哈希永远不会。
 */
export function sanitizeGpuWarmupPublicUrl(
  value: unknown,
  origin: string | null | undefined,
  maxLength = GPU_WARMUP_PUBLIC_URL_LIMIT,
): string | null {
  if (typeof value !== "string" || value.length === 0 || !origin) return null;
  try {
    const safeOrigin = new URL(origin).origin;
    const resolved = new URL(value, `${safeOrigin}/`);
    if (resolved.origin !== safeOrigin || !/^https?:$/.test(resolved.protocol)) return null;
    if (!resolved.pathname.startsWith("/assets/")) return null;
    const capacity = Math.max(1, Math.floor(maxLength));
    if (resolved.pathname.length <= capacity) return resolved.pathname;
    if (capacity === 1) return "…";
    return `${resolved.pathname.slice(0, capacity - 1)}…`;
  } catch {
    return null;
  }
}

/** 从 Pixi 元数据到有界公共数据的纯故障关闭投影。 */
export function createGpuWarmupUploadDiagnostic(
  options: CreateGpuWarmupUploadDiagnosticOptions,
): GpuWarmupUploadDiagnostic {
  const uniqueBaseTextures = [...new Set(options.baseTextures)];
  const allResources = uniqueBaseTextures.map((baseTexture) => (
    describeBaseTexture(baseTexture, options.origin)
  ));
  const resources = [...allResources]
    .sort(compareResources)
    .slice(0, GPU_WARMUP_RESOURCE_LIMIT);

  return Object.freeze({
    group: safeLabel(options.group, "unknown"),
    groupIndex: safeInteger(options.groupIndex),
    targetType: safeLabel(options.targetType, "DisplayObject"),
    durationMs: roundedMilliseconds(options.durationMs),
    textureCount: uniqueBaseTextures.length,
    totalEstimatedRgbaBytes: allResources.reduce(
      (total, resource) => safeByteSum(total, resource.estimatedRgbaBytes),
      0,
    ),
    resources: Object.freeze(resources),
  });
}

/** 仅保留 DOM 发布的确定性、有界最慢集。 */
export function retainSlowGpuWarmupUploads(
  previous: readonly GpuWarmupUploadDiagnostic[],
  next: GpuWarmupUploadDiagnostic,
  limit = GPU_WARMUP_TOP_SLOW_LIMIT,
): readonly GpuWarmupUploadDiagnostic[] {
  const capacity = Math.max(0, Math.floor(Number.isFinite(limit) ? limit : 0));
  if (capacity === 0) return Object.freeze([]);
  const targetKey = diagnosticTargetKey(next);
  const retained = previous.filter((entry) => diagnosticTargetKey(entry) !== targetKey);
  retained.push(next);
  retained.sort(compareUploads);
  return Object.freeze(retained.slice(0, capacity));
}

/** 收集独特的 BaseTextures，而不改变可见性或图形顺序。 */
export function collectGpuWarmupDiagnosticBaseTextures(
  root: GpuWarmupDisplayObjectLike,
): readonly GpuWarmupBaseTextureLike[] {
  const textures: GpuWarmupBaseTextureLike[] = [];
  const seen = new Set<GpuWarmupBaseTextureLike>();
  const visit = (view: GpuWarmupDisplayObjectLike): void => {
    if (view.renderable === false || view.transform === null) return;
    const baseTexture = view.texture?.baseTexture;
    if (baseTexture && !seen.has(baseTexture)) {
      seen.add(baseTexture);
      textures.push(baseTexture);
    }
    for (const candidate of (view as GpuWarmupDisplayObjectLike & {
      readonly _textures?: readonly Readonly<{
        readonly baseTexture?: GpuWarmupBaseTextureLike;
      }>[];
    })._textures ?? []) {
      const multipleBaseTexture = candidate.baseTexture;
      if (multipleBaseTexture && !seen.has(multipleBaseTexture)) {
        seen.add(multipleBaseTexture);
        textures.push(multipleBaseTexture);
      }
    }
    for (const child of view.children ?? []) {
      if (child.parent === view) visit(child);
    }
  };
  visit(root);
  return textures;
}

function describeBaseTexture(
  baseTexture: GpuWarmupBaseTextureLike,
  origin: string | null | undefined,
): GpuWarmupResourceDiagnostic {
  const width = safeDimension(baseTexture.realWidth ?? baseTexture.width);
  const height = safeDimension(baseTexture.realHeight ?? baseTexture.height);
  const publicCandidates = [
    baseTexture.resource?.src,
    baseTexture.resource?.url,
    ...(baseTexture.textureCacheIds ?? []),
    baseTexture.cacheId,
  ];
  const publicPaths = publicCandidates
    .map((candidate) => sanitizeGpuWarmupPublicUrl(candidate, origin))
    .filter((candidate): candidate is string => candidate !== null);
  const url = publicPaths[0] ?? null;
  const cacheId = [
    ...(baseTexture.textureCacheIds ?? []),
    baseTexture.cacheId,
  ].map((candidate) => (
    sanitizeGpuWarmupPublicUrl(candidate, origin) ?? sanitizeOpaqueCacheId(candidate)
  ))
    .find((candidate): candidate is string => candidate !== null) ?? url;
  return Object.freeze({
    cacheId,
    url,
    width,
    height,
    estimatedRgbaBytes: safeRgbaBytes(width, height),
  });
}

function sanitizeOpaqueCacheId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Pixi 生成的 IDs 对于区分 Canvas/文本纹理很有用，但类似路径、类似 URL、查询承载和无界值不能安全地发布到 DOM 中。
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(value) ? value : null;
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : fallback;
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function safeDimension(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function safeRgbaBytes(width: number, height: number): number {
  const bytes = width * height * 4;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : Number.MAX_SAFE_INTEGER;
}

function safeByteSum(total: number, next: number): number {
  const sum = total + next;
  return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}

function roundedMilliseconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000) / 1_000;
}

function compareResources(
  left: GpuWarmupResourceDiagnostic,
  right: GpuWarmupResourceDiagnostic,
): number {
  return right.estimatedRgbaBytes - left.estimatedRgbaBytes
    || (left.url ?? left.cacheId ?? "").localeCompare(right.url ?? right.cacheId ?? "");
}

function compareUploads(
  left: GpuWarmupUploadDiagnostic,
  right: GpuWarmupUploadDiagnostic,
): number {
  return right.durationMs - left.durationMs
    || left.group.localeCompare(right.group)
    || left.groupIndex - right.groupIndex
    || left.targetType.localeCompare(right.targetType);
}

function diagnosticTargetKey(diagnostic: GpuWarmupUploadDiagnostic): string {
  return `${diagnostic.group}:${diagnostic.groupIndex}:${diagnostic.targetType}`;
}
