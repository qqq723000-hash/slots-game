import { LOGICAL_HEIGHT, LOGICAL_WIDTH } from "./theme";

const AUTHORED_WIDTH = 1_200;
const AUTHORED_HEIGHT = 900;
const AUTHORED_TO_RENDERER_SCALE = LOGICAL_HEIGHT / AUTHORED_HEIGHT;
const RESPONSIVE_COMPOSITION_BASE_WIDTH = 1_100;
const MIN_RESPONSIVE_COMPOSITION_SCALE = 0.87;
const MAX_RESPONSIVE_COMPOSITION_SCALE = 1.05;

export const DESKTOP_UTILITY_VISIBLE_SIZE = 35;
export const DESKTOP_SPIN_VISIBLE_SIZE = 97;

const MOBILE_CONTROL_MAX_SIZE = 130;
const MOBILE_MAX_SHORT_EDGE = 600;
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
  readonly width: number;
  readonly height: number;
  readonly scale: number;
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
}

export interface ResponsiveChannelEnvironment {
  readonly search?: string;
  readonly coarsePointer?: boolean;
}

export interface ResponsiveLayoutRuntimeOptions {
  /**
   * 冻结发射器通道。运行时视口/指针更改会调整此合成的大小，但绝不能交换其已加载的资源系列。
   */
  readonly channel?: ResponsiveChannel;
}

export interface ResponsiveLayoutSnapshot {
  readonly channel: ResponsiveChannel;
  readonly handMode: MobileHandMode;
  readonly viewportRegion: ResponsiveRendererRegion;
  /** Pixi 内容可用的物理区域，不包括移动状态栏。 */
  readonly gameplayRegion: ResponsiveRendererRegion;
  /** 物理移动状态栏区域。桌面将其保持在零高度。 */
  readonly statusRegion: ResponsiveRendererRegion;
  /** 现有的固定表面投影。移动渲染器应调整大小为 gameplayRegion。 */
  readonly desktopFrame: ResponsiveFrameGeometry | null;
  readonly mobileProfile: MobileLayoutProfile | null;
  readonly fpsProfile: MobileFpsLayoutProfile | null;
  readonly mobileLayouts: MobileBaseLayout | null;
  readonly mobileTransforms: Readonly<Record<MobileBaseNode, ResponsiveNodeTransform>> | null;
  readonly fpsLayouts: MobileFpsLayout | null;
  readonly fpsTransforms: Readonly<Record<MobileFpsNode, ResponsiveNodeTransform>> | null;
}

const MOBILE_PORTRAIT_STATUS_HEIGHT_RATIO = 0.1;
const MOBILE_LANDSCAPE_STATUS_HEIGHT_RATIO = 3 / 64;

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

/**
 * 用于下一个渲染器/UI 集成通道的纯通道感知接口。
 *
 * Desktop 有意返回未更改的固定 1280x720 投影。移动设备返回物理游戏/状态区域以及已经解析的节点转换，因此消费者不需要复制捕获的布局数学。
 */
export function computeResponsiveLayoutSnapshot(
  viewportWidth: number,
  viewportHeight: number,
  options: ResponsiveLayoutSnapshotOptions = {},
): ResponsiveLayoutSnapshot {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const channel = options.channel ?? "desktop";
  const handMode = options.handMode ?? "right";
  const viewportRegion = Object.freeze({ left: 0, top: 0, width, height });

  if (channel === "desktop") {
    return Object.freeze({
      channel,
      handMode,
      viewportRegion,
      gameplayRegion: viewportRegion,
      statusRegion: Object.freeze({ left: 0, top: height, width, height: 0 }),
      desktopFrame: computeResponsiveFrameGeometry(width, height),
      mobileProfile: null,
      fpsProfile: null,
      mobileLayouts: null,
      mobileTransforms: null,
      fpsLayouts: null,
      fpsTransforms: null,
    });
  }

  const baseProfile = options.mobileProfile ?? mobileLayoutProfile(width, height);
  const fpsProfile = options.fpsProfile ?? mobileFpsLayoutProfile(width, height);
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
    viewportRegion,
    gameplayRegion,
    statusRegion,
    desktopFrame: null,
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
 * 将捕获的 1200×900 合成适合视口。
 *
 * 渲染器仍以 1280×720 分辨率创作。其 1200×900 源合成已在该表面内缩放至 80%，因此外框必须相对于传统的 16:9 包含配合进行放大。然后，
 * 视口在窄屏幕上对称地裁剪额外的渲染器宽度。
 */
export function computeResponsiveFrameGeometry(
  viewportWidth: number,
  viewportHeight: number,
): ResponsiveFrameGeometry {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const gameHeight = Math.min(height, width * (AUTHORED_HEIGHT / AUTHORED_WIDTH));
  const scale = gameHeight / (AUTHORED_HEIGHT * AUTHORED_TO_RENDERER_SCALE);
  const frameWidth = LOGICAL_WIDTH * scale;
  const x = (width - frameWidth) / 2;

  return {
    x,
    y: (height - gameHeight) / 2,
    width: frameWidth,
    height: gameHeight,
    scale,
    visibleInsetX: scale > 0 ? Math.max(0, -x / scale) : 0,
  };
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
): ResponsiveControlGeometry {
  const width = finiteDimension(viewportWidth);
  const height = finiteDimension(viewportHeight);
  const scale = Number.isFinite(frameScale) && frameScale > 0 ? frameScale : 0;
  const utilityVisiblePhysicalSize = DESKTOP_UTILITY_VISIBLE_SIZE * scale;
  const spinVisiblePhysicalSize = DESKTOP_SPIN_VISIBLE_SIZE * scale;
  const mobile = width > 0 && height > 0 && Math.min(width, height) <= MOBILE_MAX_SHORT_EDGE;

  let utilityHitPhysicalSize = utilityVisiblePhysicalSize;
  let spinHitPhysicalSize = spinVisiblePhysicalSize;
  if (mobile) {
    const utilityWrapper = width >= height
      ? Math.min(MOBILE_CONTROL_MAX_SIZE, width * MOBILE_UTILITY_LANDSCAPE_CQW)
      : Math.min(MOBILE_CONTROL_MAX_SIZE, height * MOBILE_UTILITY_PORTRAIT_CQH);
    utilityHitPhysicalSize = utilityWrapper * MOBILE_UTILITY_POINTER_SCALE;
    spinHitPhysicalSize = width * MOBILE_SPIN_CQW * MOBILE_SPIN_POINTER_SCALE;
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

export class ResponsiveLayout {
  private observer: ResizeObserver | null = null;
  private running = false;
  /**
   * 使 ResizeObserver/浏览器事件队列保留的回调无效。 `disconnect()` 可以防止将来的观察，但它无法撤销在拆卸之前已排队的回调。
   */
  private lifecycleGeneration = 0;
  private windowResizeHandler: (() => void) | null = null;
  private readonly channel: ResponsiveChannel;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly frame: HTMLElement,
    private readonly onLayout: (
      snapshot: ResponsiveLayoutSnapshot,
    ) => void = () => undefined,
    options: ResponsiveLayoutRuntimeOptions = {},
  ) {
    this.channel = options.channel ?? responsiveChannelFromEnvironment({
      search: globalThis.location?.search,
      coarsePointer: globalThis.matchMedia?.("(pointer: coarse)").matches ?? false,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.lifecycleGeneration;
    const applyIfCurrent = (): void => {
      if (!this.running || generation !== this.lifecycleGeneration) return;
      this.apply();
    };
    applyIfCurrent();
    // `onLayout` 是应用程序代码，可以在初始发布期间同步拆除该实例。
    if (!this.running || generation !== this.lifecycleGeneration) return;
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(applyIfCurrent);
      this.observer.observe(this.viewport);
    } else {
      this.windowResizeHandler = applyIfCurrent;
      window.addEventListener("resize", applyIfCurrent);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.lifecycleGeneration += 1;
    this.observer?.disconnect();
    this.observer = null;
    if (this.windowResizeHandler) {
      window.removeEventListener("resize", this.windowResizeHandler);
      this.windowResizeHandler = null;
    }
  }

  private readonly apply = (): void => {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;
    const snapshot = computeResponsiveLayoutSnapshot(
      width,
      height,
      { channel: this.channel },
    );
    const geometry = snapshot.desktopFrame;

    this.frame.dataset.channel = snapshot.channel;
    this.frame.dataset.handMode = snapshot.handMode;
    if (snapshot.mobileProfile) this.frame.dataset.mobileLayout = snapshot.mobileProfile;
    else delete this.frame.dataset.mobileLayout;
    if (snapshot.fpsProfile) this.frame.dataset.fpsLayout = snapshot.fpsProfile;
    else delete this.frame.dataset.fpsLayout;
    this.frame.style.setProperty("--gameplay-width", `${snapshot.gameplayRegion.width}px`);
    this.frame.style.setProperty("--gameplay-height", `${snapshot.gameplayRegion.height}px`);
    this.frame.style.setProperty("--status-height", `${snapshot.statusRegion.height}px`);
    this.applyMobileStatusVariables(snapshot);
    this.applyFeaturePreviewVariables(snapshot);

    if (geometry) {
      this.applyDesktopFrame(geometry);
    } else {
      this.applyMobileFrame(width, height);
    }

    // 捕获的游戏在纵向下仍可玩； DOM 中保留本地旋转提示符只是为了与现有 shell 兼容。
    this.viewport.dataset.orientationLock = "false";
    this.frame.inert = false;
    const prompt = this.viewport.querySelector<HTMLElement>(".orientation-lock");
    prompt?.setAttribute("aria-hidden", "true");
    this.onLayout(snapshot);
  };

  private applyDesktopFrame(geometry: ResponsiveFrameGeometry): void {
    this.frame.style.width = `${LOGICAL_WIDTH}px`;
    this.frame.style.height = `${LOGICAL_HEIGHT}px`;
    this.frame.style.setProperty("--visible-inset-x", `${geometry.visibleInsetX}px`);
    const controls = responsiveControlGeometry(
      this.viewport.clientWidth,
      this.viewport.clientHeight,
      geometry.scale,
    );
    this.frame.style.setProperty("--utility-hit-size", `${controls.utilityHitLogicalSize}px`);
    this.frame.style.setProperty("--spin-hit-size", `${controls.spinHitLogicalSize}px`);
    const styles = responsiveFrameStyles(geometry);
    this.frame.style.left = styles.left;
    this.frame.style.top = styles.top;
    this.frame.style.transformOrigin = styles.transformOrigin;
    this.frame.style.transform = styles.transform;
  }

  private applyMobileFrame(width: number, height: number): void {
    this.frame.style.width = `${Math.max(0, width)}px`;
    this.frame.style.height = `${Math.max(0, height)}px`;
    this.frame.style.setProperty("--visible-inset-x", "0px");
    const controls = responsiveControlGeometry(
      width,
      height,
      1,
    );
    this.frame.style.setProperty("--utility-hit-size", `${controls.utilityHitLogicalSize}px`);
    this.frame.style.setProperty("--spin-hit-size", `${controls.spinHitLogicalSize}px`);
    this.frame.style.left = "0px";
    this.frame.style.top = "0px";
    this.frame.style.transformOrigin = "top left";
    this.frame.style.transform = "none";
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
