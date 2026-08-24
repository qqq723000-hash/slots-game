import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";

const RESPONSIVE_COMPOSITION_BASE_WIDTH = 1_100;
const MIN_RESPONSIVE_COMPOSITION_SCALE = 0.87;
const MAX_RESPONSIVE_COMPOSITION_SCALE = 1.05;

export const DESKTOP_UTILITY_VISIBLE_SIZE = 35;
export const DESKTOP_SPIN_VISIBLE_SIZE = 97;

const MOBILE_CONTROL_MAX_SIZE = 130;
const MOBILE_CONTROL_INFER_SHORT_EDGE = 600;
const MOBILE_LAUNCHER_MAX_SHORT_EDGE = 768;
const MOBILE_UTILITY_PORTRAIT_CQH = 0.075;
const MOBILE_UTILITY_LANDSCAPE_CQW = 0.09;
const MOBILE_UTILITY_POINTER_SCALE = 0.8;
const MOBILE_SPIN_CQW = 0.12;
const MOBILE_SPIN_POINTER_SCALE = 0.85;
const FEATURE_PREVIEW_BASE_CONTENT_SCALE = 720 / 1_100;
const FEATURE_PREVIEW_UI_PHONE_EDGE = 390;
const FEATURE_PREVIEW_UI_TABLET_EDGE = 768;

export interface ResponsiveFrameGeometry {
  readonly x: number;
  readonly y: number;
  /** 经过唯一根缩放后占用的外层 CSS 宽度。 */
  readonly width: number;
  /** 经过唯一根缩放后占用的外层 CSS 高度。 */
  readonly height: number;
  readonly scale: number;
  readonly designWidth: number;
  readonly designHeight: number;
  /** Letterbox 从不裁切设计表面；保留该字段仅兼容现有官方节点投影。 */
  readonly visibleInsetX: number;
}

export interface ResponsiveFrameStyles {
  readonly left: string;
  readonly top: string;
  readonly transform: string;
  readonly transformOrigin: string;
}

export interface ResponsiveRendererRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ResponsiveMinBound {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ResponsiveNodeTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface ResponsiveControlGeometry {
  readonly utilityVisiblePhysicalSize: number;
  readonly utilityHitPhysicalSize: number;
  readonly utilityHitLogicalSize: number;
  readonly spinVisiblePhysicalSize: number;
  readonly spinHitPhysicalSize: number;
  readonly spinHitLogicalSize: number;
}

export type ResponsiveChannel = "desktop" | "mobile";
export type ResponsiveSurfaceProfile =
  | "desktop"
  | "phone-pt"
  | "phone-ls"
  | "tablet-pt"
  | "tablet-ls";
export type MobileLayoutProfile = "pt" | "iPad_pt" | "ls";
export type MobileFpsLayoutProfile = "pt" | "iPad_pt" | "iPad_ls" | "ls";
export type MobileHandMode = "left" | "right";

export type MobileBaseNode = "main" | "background" | "character" | "logo";
export type MobileFpsNode = "content" | "background" | "logo" | "blackOverlay";

export interface ResponsiveNodeLayout {
  readonly minBound: ResponsiveMinBound;
  readonly horizontalAlign: number;
  readonly verticalAlign: number;
}

export type MobileBaseLayout = Readonly<Record<MobileBaseNode, ResponsiveNodeLayout>>;
export type MobileFpsLayout = Readonly<Record<MobileFpsNode, ResponsiveNodeLayout>>;

export interface ResponsiveLayoutSnapshotOptions {
  /** 默认为桌面，因此现有启动器保持逐字节兼容。 */
  readonly channel?: ResponsiveChannel;
  /** 捕获的屏幕截图使用右手模式：左侧为实用控件，右侧为 Spin。 */
  readonly handMode?: MobileHandMode;
  /** 确定性测试/主机覆盖；省略使用官方的纵横比规则。 */
  readonly mobileProfile?: MobileLayoutProfile;
  /** Feature Preview 有一套单独的官方长宽比规则。 */
  readonly fpsProfile?: MobileFpsLayoutProfile;
  /** 确定性主机覆盖；只覆盖参考档位标签，绝不把连续设计域锁回预设尺寸。 */
  readonly surfaceProfile?: ResponsiveSurfaceProfile;
  /** 只控制 backing resolution，绝不进入逻辑几何。 */
  readonly pixelRatio?: number;
}

export interface ResponsiveChannelEnvironment {
  readonly search?: string;
  readonly coarsePointer?: boolean;
  readonly finePointer?: boolean;
  readonly touchPoints?: number;
}

export interface ResponsiveLayoutRuntimeOptions {
  /**
   * 显式布局通道覆盖，仅供确定性宿主/测试使用。省略时每次提交都会重新解析
   * 视口与输入能力；资源通道由 AppController 独立冻结，不能从这里推断。
   */
  readonly channel?: ResponsiveChannel;
  /** 确定性生命周期测试接缝；生产环境使用 requestAnimationFrame。 */
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface ResponsiveLayoutSnapshot {
  readonly channel: ResponsiveChannel;
  readonly handMode: MobileHandMode;
  readonly surfaceProfile: ResponsiveSurfaceProfile;
  /** 外层可用区域，单位为未缩放的浏览器 CSS 像素。 */
  readonly physicalViewportRegion: ResponsiveRendererRegion;
  /** Pixi、DOM 与点击区共用的固定设计坐标域。 */
  readonly viewportRegion: ResponsiveRendererRegion;
  /** Pixi 内容可用的设计区域，不包括移动状态栏。 */
  readonly gameplayRegion: ResponsiveRendererRegion;
  /** 设计坐标中的移动状态栏区域。桌面将其保持在零高度。 */
  readonly statusRegion: ResponsiveRendererRegion;
  /** 每个通道都只使用一次的等比根投影。 */
  readonly frame: ResponsiveFrameGeometry;
  /** 兼容桌面消费者；移动端使用 frame。 */
  readonly desktopFrame: ResponsiveFrameGeometry | null;
  readonly pixelRatio: number;
  readonly mobileProfile: MobileLayoutProfile | null;
  readonly fpsProfile: MobileFpsLayoutProfile | null;
  readonly mobileLayouts: MobileBaseLayout | null;
  readonly mobileTransforms: Readonly<Record<MobileBaseNode, ResponsiveNodeTransform>> | null;
  readonly fpsLayouts: MobileFpsLayout | null;
  readonly fpsTransforms: Readonly<Record<MobileFpsNode, ResponsiveNodeTransform>> | null;
}

const MOBILE_PORTRAIT_STATUS_HEIGHT_RATIO = 0.1;
const MOBILE_LANDSCAPE_STATUS_HEIGHT_RATIO = 3 / 64;
const TABLET_SHORT_EDGE_MIN = 600;

export interface ResponsiveDesignSurface {
  readonly width: number;
  readonly height: number;
}

interface ResponsiveReferenceSurface extends ResponsiveDesignSurface {
  readonly mobileProfile: MobileLayoutProfile | null;
}

export const RESPONSIVE_DESIGN_SURFACES: Readonly<
  Record<ResponsiveSurfaceProfile, ResponsiveReferenceSurface>
> = Object.freeze({
  desktop: Object.freeze({ width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, mobileProfile: null }),
  "phone-pt": Object.freeze({ width: 390, height: 844, mobileProfile: "pt" }),
  "phone-ls": Object.freeze({ width: 844, height: 390, mobileProfile: "ls" }),
  "tablet-pt": Object.freeze({ width: 633, height: 844, mobileProfile: "iPad_pt" }),
  "tablet-ls": Object.freeze({ width: 844, height: 633, mobileProfile: "ls" }),
});

/**
 * 捕获尺寸只标定逻辑长边，不构成设备白名单。常见手机、折叠屏和平板长宽比
 * 都连续映射；只有超出 9:22/22:9 的病态视口才钳制并由根投影留黑边。
 */
const MOBILE_DESIGN_LONG_EDGE = 844;
const MOBILE_MIN_DESIGN_ASPECT = 9 / 22;
const MOBILE_MAX_DESIGN_ASPECT = 22 / 9;

function nodeLayout(
  left: number,
  top: number,
  width: number,
  height: number,
  horizontalAlign = 0.5,
  verticalAlign = 0.5,
): ResponsiveNodeLayout {
  return Object.freeze({
    minBound: Object.freeze({ left, top, width, height }),
    horizontalAlign,
    verticalAlign,
  });
}

/** 从捕获的移动配置中提取精确的基础游戏节点合约。 */
export const MOBILE_BASE_LAYOUTS: Readonly<Record<MobileLayoutProfile, MobileBaseLayout>>
  = Object.freeze({
    pt: Object.freeze({
      main: nodeLayout(-550, -360, 1_100, 900),
      background: nodeLayout(-400, -700, 800, 800, 0.5, 0),
      character: nodeLayout(-375, -600, 750, 750, 0.5, 0),
      logo: nodeLayout(410, 0, 900, 100, 0.5, 0.75),
    }),
    iPad_pt: Object.freeze({
      main: nodeLayout(-550, -390, 1_100, 900),
      background: nodeLayout(-500, -650, 1_000, 1_000, 0.5, 0),
      character: nodeLayout(-550, -635, 1_100, 1_100, 0.5, 0),
      logo: nodeLayout(430, 0, 900, 100, 0.5, 0.75),
    }),
    ls: Object.freeze({
      main: nodeLayout(-600, -450, 1_200, 900),
      background: nodeLayout(-500, -600, 1_000, 1_000),
      character: nodeLayout(-500, -500, 1_000, 1_000),
      logo: nodeLayout(370, -120, 1_400, 1_000, 0, 0.5),
    }),
  });

/** 精确的 Feature Preview 合约； FPS 故意使用不同的断点。 */
export const MOBILE_FPS_LAYOUTS: Readonly<Record<MobileFpsLayoutProfile, MobileFpsLayout>>
  = Object.freeze({
    pt: Object.freeze({
      content: nodeLayout(-500, -450, 1_000, 900),
      background: nodeLayout(-400, -400, 800, 800),
      logo: nodeLayout(-400, -50, 800, 900),
      blackOverlay: nodeLayout(-500, -450, 1_000, 900),
    }),
    iPad_pt: Object.freeze({
      content: nodeLayout(-500, -450, 1_000, 900),
      background: nodeLayout(-575, -350, 1_150, 900),
      logo: nodeLayout(-500, 0, 1_000, 900),
      blackOverlay: nodeLayout(-575, -350, 1_150, 900),
    }),
    iPad_ls: Object.freeze({
      content: nodeLayout(-700, -400, 1_400, 900),
      background: nodeLayout(-600, -450, 1_200, 900),
      logo: nodeLayout(-600, 0, 1_200, 1_000),
      blackOverlay: nodeLayout(-600, -420, 1_200, 900),
    }),
    ls: Object.freeze({
      content: nodeLayout(-750, -550, 1_500, 1_100),
      background: nodeLayout(-750, -350, 1_500, 750),
      logo: nodeLayout(-600, -130, 1_200, 1_200),
      blackOverlay: nodeLayout(-750, -550, 1_500, 1_100),
    }),
  });

/** 来自 layout_mobile.json 的官方基础游戏配置文件路由。 */
export function mobileLayoutProfile(
  viewportWidth: number,
  viewportHeight: number,
): MobileLayoutProfile {
  const ratio = finiteAspectRatio(viewportWidth, viewportHeight);
  if (ratio < 0.74) return "pt";
  if (ratio <= 1) return "iPad_pt";
  return "ls";
}

/** 来自 layout_fps_mobile.json 的官方 Feature Preview 路由。 */
export function mobileFpsLayoutProfile(
  viewportWidth: number,
  viewportHeight: number,
): MobileFpsLayoutProfile {
  const ratio = finiteAspectRatio(viewportWidth, viewportHeight);
  if (ratio < 0.66) return "pt";
  if (ratio < 0.88) return "iPad_pt";
  if (ratio <= 1) return "iPad_ls";
  return "ls";
}

/** 资产通道保持冻结；该函数只在通道内部选择固定的设计表面。 */
export function responsiveSurfaceProfile(
  viewportWidth: number,
  viewportHeight: number,
  channel: ResponsiveChannel,
): ResponsiveSurfaceProfile {
  if (channel === "desktop") return "desktop";
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const portrait = height >= width;
  const tablet = Math.min(width, height) >= TABLET_SHORT_EDGE_MIN;
  if (portrait) return tablet ? "tablet-pt" : "phone-pt";
  return tablet ? "tablet-ls" : "phone-ls";
}

/**
 * 将物理长宽比连续转换为移动逻辑设计域。返回值只改变逻辑坐标密度，最终到
 * 物理视口仍由 `computeResponsiveFrameGeometry` 执行唯一一次等比根缩放。
 */
export function responsiveDesignSurface(
  viewportWidth: number,
  viewportHeight: number,
  channel: ResponsiveChannel,
): ResponsiveDesignSurface {
  if (channel === "desktop") {
    return Object.freeze({
      width: RESPONSIVE_DESIGN_SURFACES.desktop.width,
      height: RESPONSIVE_DESIGN_SURFACES.desktop.height,
    });
  }

  const physicalWidth = finiteDimension(viewportWidth);
  const physicalHeight = finiteDimension(viewportHeight);
  const rawAspect = physicalHeight > 0
    ? physicalWidth / physicalHeight
    : MOBILE_MAX_DESIGN_ASPECT;
  const aspect = Math.max(
    MOBILE_MIN_DESIGN_ASPECT,
    Math.min(MOBILE_MAX_DESIGN_ASPECT, rawAspect),
  );
  return aspect <= 1
    ? Object.freeze({ width: MOBILE_DESIGN_LONG_EDGE * aspect, height: MOBILE_DESIGN_LONG_EDGE })
    : Object.freeze({ width: MOBILE_DESIGN_LONG_EDGE, height: MOBILE_DESIGN_LONG_EDGE / aspect });
}

/**
 * 用于下一个渲染器/UI 集成通道的纯通道感知接口。
 *
 * Desktop 有意返回未更改的固定 1280x720 投影。移动设备按当前物理长宽比
 * 连续生成逻辑设计域及节点转换，因此消费者不需要复制捕获的布局数学。
 */
export function computeResponsiveLayoutSnapshot(
  viewportWidth: number,
  viewportHeight: number,
  options: ResponsiveLayoutSnapshotOptions = {},
): ResponsiveLayoutSnapshot {
  const physicalWidth = finiteDimension(viewportWidth);
  const physicalHeight = finiteDimension(viewportHeight);
  const channel = options.channel ?? "desktop";
  const handMode = options.handMode ?? "right";
  const requestedSurface = options.surfaceProfile;
  const surfaceProfile = requestedSurface
    && (channel === "desktop") === (requestedSurface === "desktop")
    ? requestedSurface
    : responsiveSurfaceProfile(physicalWidth, physicalHeight, channel);
  const surface = responsiveDesignSurface(physicalWidth, physicalHeight, channel);
  const width = surface.width;
  const height = surface.height;
  const physicalViewportRegion = Object.freeze({
    left: 0,
    top: 0,
    width: physicalWidth,
    height: physicalHeight,
  });
  const viewportRegion = Object.freeze({ left: 0, top: 0, width, height });
  const frame = computeResponsiveFrameGeometry(
    physicalWidth,
    physicalHeight,
    width,
    height,
  );
  const pixelRatio = finitePixelRatio(options.pixelRatio ?? globalThis.devicePixelRatio);

  if (channel === "desktop") {
    return Object.freeze({
      channel,
      handMode,
      surfaceProfile,
      physicalViewportRegion,
      viewportRegion,
      gameplayRegion: viewportRegion,
      statusRegion: Object.freeze({ left: 0, top: height, width, height: 0 }),
      frame,
      desktopFrame: frame,
      pixelRatio,
      mobileProfile: null,
      fpsProfile: null,
      mobileLayouts: null,
      mobileTransforms: null,
      fpsLayouts: null,
      fpsTransforms: null,
    });
  }

  // Profile 是按长宽比选择的内容规则，而不是固定画布。每次 resize 都重新路由。
  const baseProfile = options.mobileProfile
    ?? mobileLayoutProfile(physicalWidth, physicalHeight);
  const fpsProfile = options.fpsProfile
    ?? mobileFpsLayoutProfile(physicalWidth, physicalHeight);
  const statusHeight = Math.min(
    height,
    Math.round(height * (
      baseProfile === "ls"
        ? MOBILE_LANDSCAPE_STATUS_HEIGHT_RATIO
        : MOBILE_PORTRAIT_STATUS_HEIGHT_RATIO
    )),
  );
  const gameplayHeight = Math.max(0, height - statusHeight);
  const gameplayRegion = Object.freeze({
    left: 0,
    top: 0,
    width,
    height: gameplayHeight,
  });
  const statusRegion = Object.freeze({
    left: 0,
    top: gameplayHeight,
    width,
    height: statusHeight,
  });
  const mobileLayouts = MOBILE_BASE_LAYOUTS[baseProfile];
  const fpsLayouts = MOBILE_FPS_LAYOUTS[fpsProfile];

  return Object.freeze({
    channel,
    handMode,
    surfaceProfile,
    physicalViewportRegion,
    viewportRegion,
    gameplayRegion,
    statusRegion,
    frame,
    desktopFrame: null,
    pixelRatio,
    mobileProfile: baseProfile,
    fpsProfile,
    mobileLayouts,
    mobileTransforms: resolveNodeLayoutSet(gameplayRegion, mobileLayouts),
    fpsLayouts,
    // 预览位于游戏内状态栏之前，并占据捕获的客户端中的整个移动启动器表面。
    fpsTransforms: resolveNodeLayoutSet(viewportRegion, fpsLayouts),
  });
}

/** 显式启动器通道中奖；粗指针设备否则使用移动设备。 */
export function responsiveChannelFromEnvironment(
  environment: ResponsiveChannelEnvironment = {},
): ResponsiveChannel {
  const params = new URLSearchParams(environment.search ?? "");
  const explicit = params.get("channel")?.toLowerCase();
  if (explicit === "mobile" || explicit === "desktop") return explicit;
  return environment.coarsePointer ? "mobile" : "desktop";
}

/**
 * 解析当前构图通道。`layout=` 仍是最高优先级；官网移动启动器只提供
 * `channel=mobile`，因此在手机/平板尺寸范围内也把它作为移动构图的可靠提示。
 * 超出该范围的桌面窗口继续按输入能力选择，避免移动资产通道强制改写 PC 构图。
 */
export function responsiveLayoutChannel(
  viewportWidth: number,
  viewportHeight: number,
  environment: ResponsiveChannelEnvironment = {},
): ResponsiveChannel {
  const params = new URLSearchParams(environment.search ?? "");
  const explicit = params.get("layout")?.toLowerCase();
  if (explicit === "mobile" || explicit === "desktop") return explicit;

  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  if (width <= 0 || height <= 0) return "desktop";
  const compactLauncherSurface = Math.min(width, height) <= MOBILE_LAUNCHER_MAX_SHORT_EDGE
    && Math.max(width, height) <= 1_366;
  if (params.get("channel")?.toLowerCase() === "mobile" && compactLauncherSurface) {
    return "mobile";
  }
  if (environment.coarsePointer) return "mobile";
  // 触控笔记本通常同时暴露 maxTouchPoints 与精细主指针，仍应保持 PC 构图。
  if (environment.finePointer) return "desktop";
  const compactTouchDevice = Number.isFinite(environment.touchPoints)
    && (environment.touchPoints ?? 0) > 0
    && Math.min(width, height) <= 768
    && Math.max(width, height) <= 1_366;
  if (compactTouchDevice) return "mobile";
  return height >= width
    ? (width <= 600 ? "mobile" : "desktop")
    : (height <= 480 ? "mobile" : "desktop");
}

/** 将设计表面以一次等比 contain 缩放居中，绝不 cover、裁切或分别拉伸坐标轴。 */
export function computeResponsiveFrameGeometry(
  viewportWidth: number,
  viewportHeight: number,
  designWidth: number = LOGICAL_WIDTH,
  designHeight: number = LOGICAL_HEIGHT,
): ResponsiveFrameGeometry {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const canonicalWidth = finiteDimension(designWidth);
  const canonicalHeight = finiteDimension(designHeight);
  const scale = width > 0 && height > 0 && canonicalWidth > 0 && canonicalHeight > 0
    ? Math.min(width / canonicalWidth, height / canonicalHeight)
    : 0;
  const frameWidth = canonicalWidth * scale;
  const frameHeight = canonicalHeight * scale;
  const offsetX = (width - frameWidth) / 2;
  const offsetY = (height - frameHeight) / 2;

  return {
    x: Math.abs(offsetX) < 1e-9 ? 0 : offsetX,
    y: Math.abs(offsetY) < 1e-9 ? 0 : offsetY,
    width: frameWidth,
    height: frameHeight,
    scale,
    designWidth: canonicalWidth,
    designHeight: canonicalHeight,
    visibleInsetX: 0,
  };
}

/** 黑边返回 null；设计表面内的点统一映射到 Pixi/DOM 坐标。 */
export function responsiveDesignPoint(
  geometry: ResponsiveFrameGeometry,
  viewportX: number,
  viewportY: number,
): Readonly<{ x: number; y: number }> | null {
  if (!Number.isFinite(viewportX) || !Number.isFinite(viewportY)
    || !Number.isFinite(geometry.scale) || geometry.scale <= 0) return null;
  const x = (viewportX - geometry.x) / geometry.scale;
  const y = (viewportY - geometry.y) / geometry.scale;
  if (x < 0 || y < 0 || x > geometry.designWidth || y > geometry.designHeight) return null;
  return Object.freeze({ x, y });
}

export function responsiveFrameStyles(
  geometry: ResponsiveFrameGeometry,
): ResponsiveFrameStyles {
  return {
    left: `${geometry.x}px`,
    top: `${geometry.y}px`,
    transform: `scale(${geometry.scale})`,
    transformOrigin: "top left",
  };
}

export function responsiveCompositionScale(
  geometry: ResponsiveFrameGeometry,
): number {
  const visibleLogicalWidth = Math.max(
    0,
    LOGICAL_WIDTH - geometry.visibleInsetX * 2,
  );
  return Math.max(
    MIN_RESPONSIVE_COMPOSITION_SCALE,
    Math.min(
      MAX_RESPONSIVE_COMPOSITION_SCALE,
      visibleLogicalWidth / RESPONSIVE_COMPOSITION_BASE_WIDTH,
    ),
  );
}

/**
 * 返回固定 1280x720 渲染器在对称裁剪外框后仍然可见的部分。官方布局区域在该矩形内解析，而不是针对隐藏的渲染器翼。
 */
export function responsiveRendererRegion(
  visibleInsetX: number,
): ResponsiveRendererRegion {
  const inset = Math.min(
    LOGICAL_WIDTH / 2,
    Math.max(0, Number.isFinite(visibleInsetX) ? visibleInsetX : 0),
  );
  return {
    left: inset,
    top: 0,
    width: Math.max(0, LOGICAL_WIDTH - inset * 2),
    height: LOGICAL_HEIGHT,
  };
}

/** 捕获的布局引擎使用的精确 `minBound`/对齐投影。 */
export function resolveResponsiveMinBound(
  region: ResponsiveRendererRegion,
  minBound: ResponsiveMinBound,
  horizontalAlign = 0.5,
  verticalAlign = 0.5,
): ResponsiveNodeTransform {
  if (region.width <= 0 || region.height <= 0
    || minBound.width <= 0 || minBound.height <= 0) {
    return { x: region.left, y: region.top, scale: 0 };
  }

  const scale = Math.min(
    region.width / minBound.width,
    region.height / minBound.height,
  );
  return {
    x: region.left - minBound.left * scale
      + horizontalAlign * (region.width - minBound.width * scale),
    y: region.top - minBound.top * scale
      + verticalAlign * (region.height - minBound.height * scale),
    scale,
  };
}

/** 解析在 Pixi 调整大小之前由 ResponsiveLayout 写入的继承内联接口。 */
export function responsiveVisibleInset(value: string | null | undefined): number {
  const inset = Number.parseFloat(value ?? "");
  return Number.isFinite(inset) && inset > 0 ? inset : 0;
}

/**
 * 在预设的逻辑像素中保留可见的控制艺术，同时从捕获的 cqw/cqh 合约中投影透明的移动点击区域。
 */
export function responsiveControlGeometry(
  viewportWidth: number,
  viewportHeight: number,
  frameScale: number,
  mobileOverride?: boolean,
): ResponsiveControlGeometry {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const scale = Number.isFinite(frameScale) && frameScale > 0 ? frameScale : 0;
  const utilityVisiblePhysicalSize = DESKTOP_UTILITY_VISIBLE_SIZE * scale;
  const spinVisiblePhysicalSize = DESKTOP_SPIN_VISIBLE_SIZE * scale;
  const mobile = mobileOverride ?? (
    width > 0 && height > 0 && Math.min(width, height) < MOBILE_CONTROL_INFER_SHORT_EDGE
  );

  let utilityHitPhysicalSize = utilityVisiblePhysicalSize;
  let spinHitPhysicalSize = spinVisiblePhysicalSize;
  if (mobile) {
    const utilityWrapper = width >= height
      ? Math.min(MOBILE_CONTROL_MAX_SIZE, width * MOBILE_UTILITY_LANDSCAPE_CQW)
      : Math.min(MOBILE_CONTROL_MAX_SIZE, height * MOBILE_UTILITY_PORTRAIT_CQH);
    utilityHitPhysicalSize = Math.max(
      utilityVisiblePhysicalSize,
      utilityWrapper * MOBILE_UTILITY_POINTER_SCALE,
    );
    spinHitPhysicalSize = Math.max(
      spinVisiblePhysicalSize,
      width * MOBILE_SPIN_CQW * MOBILE_SPIN_POINTER_SCALE,
    );
  }

  return {
    utilityVisiblePhysicalSize,
    utilityHitPhysicalSize,
    utilityHitLogicalSize: scale > 0
      ? Math.max(DESKTOP_UTILITY_VISIBLE_SIZE, utilityHitPhysicalSize / scale)
      : DESKTOP_UTILITY_VISIBLE_SIZE,
    spinVisiblePhysicalSize,
    spinHitPhysicalSize,
    spinHitLogicalSize: scale > 0
      ? Math.max(DESKTOP_SPIN_VISIBLE_SIZE, spinHitPhysicalSize / scale)
      : DESKTOP_SPIN_VISIBLE_SIZE,
  };
}

function resolveNodeLayoutSet<K extends string>(
  region: ResponsiveRendererRegion,
  layouts: Readonly<Record<K, ResponsiveNodeLayout>>,
): Readonly<Record<K, ResponsiveNodeTransform>> {
  return Object.freeze(Object.fromEntries(
    (Object.entries(layouts) as [K, ResponsiveNodeLayout][]).map(([key, layout]) => [
      key,
      resolveResponsiveMinBound(
        region,
        layout.minBound,
        layout.horizontalAlign,
        layout.verticalAlign,
      ),
    ]),
  ) as Record<K, ResponsiveNodeTransform>);
}

function finiteAspectRatio(width: number, height: number): number {
  const safeWidth = finiteDimension(width);
  const safeHeight = finiteDimension(height);
  return safeHeight > 0 ? safeWidth / safeHeight : Number.POSITIVE_INFINITY;
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function finitePixelRatio(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export class ResponsiveLayout {
  private observer: ResizeObserver | null = null;
  private running = false;
  /**
   * 使 ResizeObserver/浏览器事件队列保留的回调无效。 `disconnect()` 可以防止将来的观察，但它无法撤销在拆卸之前已排队的回调。
   */
  private lifecycleGeneration = 0;
  private windowResizeHandler: (() => void) | null = null;
  private visualViewport: VisualViewport | null = null;
  private scheduledFrame: number | null = null;
  private lastCommitKey: string | null = null;
  private readonly channelOverride: ResponsiveChannel | null;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly onLayout: (
      snapshot: ResponsiveLayoutSnapshot,
    ) => void = () => undefined,
    options: ResponsiveLayoutRuntimeOptions = {},
  ) {
    this.channelOverride = options.channel ?? null;
    this.requestFrame = options.requestFrame ?? ((callback) => {
      if (typeof globalThis.requestAnimationFrame === "function") {
        return globalThis.requestAnimationFrame(callback);
      }
      return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
    });
    this.cancelFrame = options.cancelFrame ?? ((handle) => {
      if (typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(handle);
        return;
      }
      globalThis.clearTimeout(handle);
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastCommitKey = null;
    const generation = ++this.lifecycleGeneration;
    const applyNowIfCurrent = (): void => {
      if (!this.running || generation !== this.lifecycleGeneration) return;
      this.apply();
    };
    const scheduleIfCurrent = (): void => {
      if (!this.running || generation !== this.lifecycleGeneration
        || this.scheduledFrame !== null) return;
      this.scheduledFrame = this.requestFrame(() => {
        this.scheduledFrame = null;
        applyNowIfCurrent();
      });
    };
    applyNowIfCurrent();
    // `onLayout` 是应用程序代码，可以在初始发布期间同步拆除该实例。
    if (!this.running || generation !== this.lifecycleGeneration) return;
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(scheduleIfCurrent);
      this.observer.observe(this.viewport);
    }
    this.windowResizeHandler = scheduleIfCurrent;
    window.addEventListener("resize", scheduleIfCurrent);
    this.visualViewport = window.visualViewport ?? null;
    this.visualViewport?.addEventListener("resize", scheduleIfCurrent);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.lifecycleGeneration += 1;
    if (this.scheduledFrame !== null) {
      this.cancelFrame(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.visualViewport?.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
    this.visualViewport = null;
    this.lastCommitKey = null;
  }

  private readonly apply = (): void => {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    // DevTools 和旋转会短暂发布 0×N/N×0；保留上一稳定表面，不得压缩到 1×1。
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const snapshot = computeResponsiveLayoutSnapshot(
      width,
      height,
      {
        channel: this.channelOverride ?? responsiveLayoutChannel(width, height, {
          search: globalThis.location?.search,
          coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
          finePointer: globalThis.matchMedia?.("(pointer: fine)").matches ?? false,
          touchPoints: globalThis.navigator?.maxTouchPoints,
        }),
        pixelRatio: globalThis.devicePixelRatio,
      },
    );
    const geometry = snapshot.frame;
    const commitKey = [
      width,
      height,
      snapshot.surfaceProfile,
      snapshot.pixelRatio,
      geometry.scale,
    ].join(":");
    if (commitKey === this.lastCommitKey) return;
    this.lastCommitKey = commitKey;

    this.frame.dataset.channel = snapshot.channel;
    this.frame.dataset.handMode = snapshot.handMode;
    this.frame.dataset.surfaceProfile = snapshot.surfaceProfile;
    this.frame.dataset.designWidth = String(geometry.designWidth);
    this.frame.dataset.designHeight = String(geometry.designHeight);
    this.frame.dataset.frameScale = String(geometry.scale);
    this.frame.dataset.frameX = String(geometry.x);
    this.frame.dataset.frameY = String(geometry.y);
    if (snapshot.mobileProfile) this.frame.dataset.mobileLayout = snapshot.mobileProfile;
    else delete this.frame.dataset.mobileLayout;
    if (snapshot.fpsProfile) this.frame.dataset.fpsLayout = snapshot.fpsProfile;
    else delete this.frame.dataset.fpsLayout;
    this.frame.style.setProperty("--gameplay-width", `${snapshot.gameplayRegion.width}px`);
    this.frame.style.setProperty("--gameplay-height", `${snapshot.gameplayRegion.height}px`);
    this.frame.style.setProperty("--status-height", `${snapshot.statusRegion.height}px`);
    this.applyMobileStatusVariables(snapshot);
    this.applyFeaturePreviewVariables(snapshot);
    this.applyFrame(snapshot);

    // 捕获的游戏在纵向下仍可玩； DOM 中保留本地旋转提示符只是为了与现有 shell 兼容。
    const outerViewport = this.frame.closest?.<HTMLElement>('[data-role="viewport"]')
      ?? this.viewport;
    outerViewport.dataset.orientationLock = "false";
    this.frame.inert = false;
    const prompt = outerViewport.querySelector<HTMLElement>(".orientation-lock");
    prompt?.setAttribute("aria-hidden", "true");
    this.onLayout(snapshot);
  };

  private applyFrame(snapshot: ResponsiveLayoutSnapshot): void {
    const geometry = snapshot.frame;
    this.frame.style.width = `${geometry.designWidth}px`;
    this.frame.style.height = `${geometry.designHeight}px`;
    this.frame.style.setProperty("--design-width", `${geometry.designWidth}px`);
    this.frame.style.setProperty("--design-height", `${geometry.designHeight}px`);
    this.frame.style.setProperty("--frame-scale", `${geometry.scale}`);
    this.frame.style.setProperty("--visible-inset-x", "0px");
    const controls = responsiveControlGeometry(
      snapshot.physicalViewportRegion.width,
      snapshot.physicalViewportRegion.height,
      geometry.scale,
      snapshot.channel === "mobile",
    );
    this.frame.style.setProperty("--utility-hit-size", `${controls.utilityHitLogicalSize}px`);
    this.frame.style.setProperty("--spin-hit-size", `${controls.spinHitLogicalSize}px`);
    const styles = responsiveFrameStyles(geometry);
    this.frame.style.left = styles.left;
    this.frame.style.top = styles.top;
    this.frame.style.transformOrigin = styles.transformOrigin;
    this.frame.style.transform = styles.transform;
  }

  /**
   * 官方 Feature Preview 是 1280x720 预设的叠加层，由与其 Pixi Spine 内容相同的独立 FPS 最小绑定投影。
   * 将 DOM 标签保留在该转换上可以防止手机和平板电脑规则偏离，同时控件的大小仍保持与物理短边的距离。
   */
  private applyFeaturePreviewVariables(snapshot: ResponsiveLayoutSnapshot): void {
    const content = snapshot.fpsTransforms?.content;
    if (snapshot.channel !== "mobile" || !content) {
      for (const property of [
        "--fps-content-shift-x",
        "--fps-content-shift-y",
        "--fps-content-projection-scale",
        "--fps-ui-scale",
        "--fps-logo-top",
        "--fps-continue-bottom",
        "--fps-sound-size",
        "--fps-sound-edge",
        "--fps-powered-width",
        "--fps-powered-height",
        "--fps-optout-left",
        "--fps-small-font-size",
        "--fps-checkbox-size",
        "--fps-checkbox-atlas-width",
        "--fps-checkbox-atlas-height",
        "--fps-checkbox-atlas-x",
      ]) this.frame.style.removeProperty(property);
      return;
    }

    const shortEdge = Math.min(
      snapshot.viewportRegion.width,
      snapshot.viewportRegion.height,
    );
    const uiScale = Math.max(0.69, Math.min(
      1.4,
      0.69 + Math.max(0, shortEdge - FEATURE_PREVIEW_UI_PHONE_EDGE)
        * (0.71 / (FEATURE_PREVIEW_UI_TABLET_EDGE - FEATURE_PREVIEW_UI_PHONE_EDGE)),
    ));
    const checkboxSize = Math.max(16, Math.min(24, shortEdge * 0.031));
    const soundSize = Math.max(54, Math.min(102, shortEdge * 0.132));
    const soundEdge = Math.max(13, Math.min(27, shortEdge * 0.034));
    this.frame.style.setProperty("--fps-content-shift-x", `${content.x - 640}px`);
    this.frame.style.setProperty("--fps-content-shift-y", `${content.y - 360}px`);
    this.frame.style.setProperty(
      "--fps-content-projection-scale",
      `${content.scale / FEATURE_PREVIEW_BASE_CONTENT_SCALE}`,
    );
    this.frame.style.setProperty("--fps-ui-scale", `${uiScale}`);
    this.frame.style.setProperty("--fps-logo-top", `${12 * uiScale}px`);
    this.frame.style.setProperty("--fps-continue-bottom", `${72 * uiScale}px`);
    this.frame.style.setProperty("--fps-sound-size", `${soundSize}px`);
    this.frame.style.setProperty("--fps-sound-edge", `${soundEdge}px`);
    this.frame.style.setProperty(
      "--fps-powered-width",
      `${Math.max(84, Math.min(150, shortEdge * 0.195))}px`,
    );
    this.frame.style.setProperty(
      "--fps-powered-height",
      `${Math.max(32, Math.min(56.4, shortEdge * 0.0733))}px`,
    );
    this.frame.style.setProperty(
      "--fps-optout-left",
      `${snapshot.viewportRegion.width / 2 + 137 * uiScale}px`,
    );
    this.frame.style.setProperty(
      "--fps-small-font-size",
      `${Math.max(12, Math.min(19, shortEdge * 0.024))}px`,
    );
    this.frame.style.setProperty(
      "--fps-checkbox-size",
      `${checkboxSize}px`,
    );
    this.frame.style.setProperty("--fps-checkbox-atlas-width", `${checkboxSize * 40.04}px`);
    this.frame.style.setProperty("--fps-checkbox-atlas-height", `${checkboxSize * 2.24}px`);
    this.frame.style.setProperty("--fps-checkbox-atlas-x", `${-checkboxSize * 38.92}px`);
  }

  /** 从捕获的 18/36px 高度缩放紧凑型移动状态条。 */
  private applyMobileStatusVariables(snapshot: ResponsiveLayoutSnapshot): void {
    const height = snapshot.statusRegion.height;
    const properties = [
      "--mobile-status-font-size",
      "--mobile-status-game-font-size",
      "--mobile-status-provider-scale",
      "--mobile-status-balance-left",
      "--mobile-status-balance-min-width",
      "--mobile-status-bet-left",
      "--mobile-status-win-right",
      "--mobile-status-game-width",
      "--mobile-status-metric-padding",
      "--mobile-status-metric-radius",
    ] as const;
    if (snapshot.channel !== "mobile" || height <= 0) {
      for (const property of properties) this.frame.style.removeProperty(property);
      return;
    }
    this.frame.style.setProperty("--mobile-status-font-size", `${height * 0.67}px`);
    this.frame.style.setProperty("--mobile-status-game-font-size", `${height * 0.43}px`);
    this.frame.style.setProperty("--mobile-status-provider-scale", `${height / 25.7142857143}`);
    this.frame.style.setProperty("--mobile-status-balance-left", `${height * 3.05}px`);
    this.frame.style.setProperty("--mobile-status-balance-min-width", `${height * 6.05}px`);
    this.frame.style.setProperty("--mobile-status-bet-left", `${height * 9.4}px`);
    this.frame.style.setProperty("--mobile-status-win-right", `${height * 3.9}px`);
    this.frame.style.setProperty("--mobile-status-game-width", `${height * 3.3}px`);
    this.frame.style.setProperty("--mobile-status-metric-padding", `${height * 0.45}px`);
    this.frame.style.setProperty("--mobile-status-metric-radius", `${height * 0.09}px`);
  }
}
