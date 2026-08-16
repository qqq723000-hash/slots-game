export type SurfaceDirection = "horizontal" | "vertical" | "mixed";
export type SurfaceTone = "bright" | "dark";
export type SurfaceEdge = "top" | "right" | "bottom" | "left";

export interface SurfaceSamplingOptions {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
  readonly direction?: SurfaceDirection;
}

export interface SurfaceStroke {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly width: number;
  readonly alpha: number;
  readonly tone: SurfaceTone;
}

export interface EdgeWearMark extends SurfaceStroke {
  readonly edge: SurfaceEdge;
  /** 暴露的明亮金属的标准化数量，从来都不是游戏价值。 */
  readonly exposure: number;
}

export interface ScratchMark extends SurfaceStroke {
  /** 装饰性凹槽深度用于选择第二个较暗的下描边。 */
  readonly depth: number;
}

const UINT32_RANGE = 4_294_967_296;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validateOptions(options: SurfaceSamplingOptions): void {
  if (!Number.isFinite(options.width) || options.width <= 0) {
    throw new RangeError("Surface width must be a positive finite number");
  }
  if (!Number.isFinite(options.height) || options.height <= 0) {
    throw new RangeError("Surface height must be a positive finite number");
  }
  if (!Number.isSafeInteger(options.count) || options.count < 0 || options.count > 2_048) {
    throw new RangeError("Surface sample count must be an integer between 0 and 2048");
  }
}

/**
 * 无状态 32 位哈希采样器。相同的种子/索引对在浏览器中是稳定的，并且不会消耗或改变全局随机状态。
 */
export function seededSurfaceValue(seed: number, index: number): number {
  const safeSeed = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const safeIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  let value = (safeSeed ^ Math.imul(safeIndex + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / UINT32_RANGE;
}

function sample(seed: number, mark: number, channel: number): number {
  return seededSurfaceValue(seed, mark * 11 + channel);
}

/** 短、低对比度的定向笔划适合拉丝金属表面。 */
export function sampleBrushedSteel(options: SurfaceSamplingOptions): readonly SurfaceStroke[] {
  validateOptions(options);
  const direction = options.direction ?? "horizontal";
  const primaryExtent = direction === "vertical" ? options.height : options.width;
  const minimumLength = Math.min(primaryExtent, Math.max(2, primaryExtent * 0.035));
  const maximumLength = Math.min(primaryExtent, Math.max(minimumLength, primaryExtent * 0.2));

  return Array.from({ length: options.count }, (_, index) => {
    const centerX = sample(options.seed, index, 0) * options.width;
    const centerY = sample(options.seed, index, 1) * options.height;
    const length = minimumLength + sample(options.seed, index, 2) * (maximumLength - minimumLength);
    const slope = (sample(options.seed, index, 3) - 0.5) * 0.07;
    const vertical = direction === "vertical"
      || (direction === "mixed" && sample(options.seed, index, 4) > 0.72);
    const halfX = vertical ? length * slope : length / 2;
    const halfY = vertical ? length / 2 : length * slope;
    return {
      x1: clamp(centerX - halfX, 0, options.width),
      y1: clamp(centerY - halfY, 0, options.height),
      x2: clamp(centerX + halfX, 0, options.width),
      y2: clamp(centerY + halfY, 0, options.height),
      width: 0.45 + sample(options.seed, index, 5) * 0.75,
      alpha: 0.028 + sample(options.seed, index, 6) * 0.082,
      tone: sample(options.seed, index, 7) > 0.58 ? "bright" : "dark",
    } satisfies SurfaceStroke;
  });
}

/**
 * 对短的暴露金属运行进行采样，这些运行保留在与其声明边缘相邻的窄带内。这样可以保持承重边缘的磨损，而不是在柜子表面均匀地散布明亮的噪音。
 */
export function sampleEdgeWear(
  options: SurfaceSamplingOptions,
  edgeBand = Math.max(1, Math.min(options.width, options.height) * 0.12),
): readonly EdgeWearMark[] {
  validateOptions(options);
  if (!Number.isFinite(edgeBand) || edgeBand <= 0) {
    throw new RangeError("Edge wear band must be a positive finite number");
  }
  const boundedBand = Math.min(edgeBand, options.width / 2, options.height / 2);
  const edges: readonly SurfaceEdge[] = ["top", "right", "bottom", "left"];

  return Array.from({ length: options.count }, (_, index) => {
    const edge = edges[Math.min(3, Math.floor(sample(options.seed, index, 0) * edges.length))] ?? "top";
    const horizontal = edge === "top" || edge === "bottom";
    const tangentExtent = horizontal ? options.width : options.height;
    const center = sample(options.seed, index, 1) * tangentExtent;
    const length = Math.min(
      tangentExtent,
      Math.max(3, tangentExtent * (0.025 + sample(options.seed, index, 2) * 0.085)),
    );
    const tangentA = clamp(center - length / 2, 0, tangentExtent);
    const tangentB = clamp(center + length / 2, 0, tangentExtent);
    const minimumInset = Math.min(0.35, boundedBand);
    const normalA = minimumInset + sample(options.seed, index, 3) * (boundedBand - minimumInset);
    const normalB = minimumInset + sample(options.seed, index, 4) * (boundedBand - minimumInset);
    const nearA = edge === "bottom" || edge === "right"
      ? (horizontal ? options.height : options.width) - normalA
      : normalA;
    const nearB = edge === "bottom" || edge === "right"
      ? (horizontal ? options.height : options.width) - normalB
      : normalB;

    return {
      edge,
      x1: horizontal ? tangentA : nearA,
      y1: horizontal ? nearA : tangentA,
      x2: horizontal ? tangentB : nearB,
      y2: horizontal ? nearB : tangentB,
      width: 0.7 + sample(options.seed, index, 5) * 1.15,
      alpha: 0.12 + sample(options.seed, index, 6) * 0.3,
      tone: "bright",
      exposure: 0.18 + sample(options.seed, index, 7) * 0.64,
    } satisfies EdgeWearMark;
  });
}

/** 具有主导方向但不重复位置的稀疏凹槽。 */
export function sampleScratches(options: SurfaceSamplingOptions): readonly ScratchMark[] {
  validateOptions(options);
  const direction = options.direction ?? "mixed";
  const maximumLength = Math.max(3, Math.min(options.width, options.height) * 0.28);
  const minimumLength = Math.min(maximumLength, Math.max(2, maximumLength * 0.2));

  return Array.from({ length: options.count }, (_, index) => {
    const centerX = sample(options.seed, index, 0) * options.width;
    const centerY = sample(options.seed, index, 1) * options.height;
    const length = minimumLength + sample(options.seed, index, 2) * (maximumLength - minimumLength);
    let angle: number;
    if (direction === "horizontal") angle = (sample(options.seed, index, 3) - 0.5) * 0.42;
    else if (direction === "vertical") angle = Math.PI / 2 + (sample(options.seed, index, 3) - 0.5) * 0.42;
    else angle = -0.88 + sample(options.seed, index, 3) * 1.76;
    const halfX = Math.cos(angle) * length / 2;
    const halfY = Math.sin(angle) * length / 2;
    const depth = 0.12 + sample(options.seed, index, 4) * 0.76;

    return {
      x1: clamp(centerX - halfX, 0, options.width),
      y1: clamp(centerY - halfY, 0, options.height),
      x2: clamp(centerX + halfX, 0, options.width),
      y2: clamp(centerY + halfY, 0, options.height),
      width: 0.45 + depth * 0.92,
      alpha: 0.045 + depth * 0.2,
      tone: sample(options.seed, index, 5) > 0.74 ? "bright" : "dark",
      depth,
    } satisfies ScratchMark;
  });
}
