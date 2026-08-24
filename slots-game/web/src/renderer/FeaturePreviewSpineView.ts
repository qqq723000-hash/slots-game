import { BLEND_MODES, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import { createSpineView, type Spine } from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import type { ResponsiveLayoutSnapshot, ResponsiveNodeTransform } from "./ResponsiveLayout";

export const FEATURE_PREVIEW_ASSETS = Object.freeze({
  plate: publicAssetUrl("assets/primal-runtime/interface/feature_preview_texture0_level1.avif"),
  ui: publicAssetUrl("assets/primal-runtime/interface/fps_ui_texture0_level1.avif"),
});

export const FEATURE_PREVIEW_PLATE_REGION = Object.freeze({
  x: 0,
  y: 824,
  width: 640,
  height: 640,
  displaySize: 1_600,
});

export const FEATURE_PREVIEW_CONTENT_REGIONS = Object.freeze({
  vignette: Object.freeze({ x: 0, y: 0, width: 820, height: 820 }),
  divider: Object.freeze({ x: 824, y: 0, width: 8, height: 492 }),
  wheelPlaceholder: Object.freeze({ x: 644, y: 1_228, width: 352, height: 352 }),
  reelsPlaceholder: Object.freeze({ x: 644, y: 824, width: 316, height: 400 }),
});

export const FEATURE_PREVIEW_CONTENT_BOUNDS = Object.freeze({
  vignette: Object.freeze({ x: 305.527, y: -2.553, width: 668.946, height: 668.946 }),
  divider: Object.freeze({ x: 638.036, y: 168.284, width: 3.927, height: 402.545 }),
  wheelPlaceholder: Object.freeze({ x: 330.073, y: 188.902, width: 286.036, height: 286.036 }),
  reelsPlaceholder: Object.freeze({ x: 682.153, y: 179.215, width: 257.891, height: 324.655 }),
});

export const FEATURE_PREVIEW_PLAYBACK_MS = Object.freeze({
  placeholderFade: 700,
  contentPlaceholderHold: 1_000 / 30,
  contentPlaceholderFade: 3_000 / 30,
  show: 500,
  loop: 5_333.333,
  wheelLoop: 10_833.333,
});

export const FEATURE_PREVIEW_BACKGROUND_POSE = Object.freeze({
  // 捕获的预览将城市置于介绍过渡框架上，其中街道交通与预设的 1280x720 构图相匹配。
  backdropSeconds: 2.36,
  foregroundSeconds: 0,
} as const);

export const FEATURE_PREVIEW_BACKGROUND_TRANSFORM = Object.freeze({
  x: 626,
  y: 309,
  scale: 1.128,
});

export const FEATURE_PREVIEW_UI_ATLAS = Object.freeze({
  width: 1_144,
  height: 64,
  buttonWidth: 224,
  buttonHeight: 44,
  defaultX: 380,
  hoverX: 608,
  downX: 836,
  sweepWidth: 240,
  sweepHeight: 64,
  sweepDurationMs: 1_500,
  sweepHoldEndFrame: 8,
  sweepTravelEndFrame: 29,
  sweepTotalFrames: 45,
});

/**
 * 在将原始 1200x900 场景组合到 1280x720 游戏界面后，捕获的 Spine_fps 元素使用的精确桌面变换。
 */
export const FEATURE_PREVIEW_SPINE_TRANSFORM = Object.freeze({
  // fpContent 将 1500x1100 装入 1600x900：9/11。 1280x720 帧缓冲区又贡献了 0.8，最终的内容比例为 36/55。
  x: 655.709_091,
  y: 321.872_727,
  scale: 0.733_091,
});

/** 预设的功能预览回放托管在同一 Pixi 应用程序中。 */
export class FeaturePreviewSpineView {
  readonly view = new Container();
  private readonly backgroundHost = new Container();
  private readonly contentHost = new Container();
  private readonly blackOverlay = new Graphics();
  private spine: Spine | null = null;
  private backdrop: Spine | null = null;
  private foreground: Spine | null = null;
  private placeholder: Sprite | null = null;
  private contentPlaceholder: Container | null = null;
  private placeholderElapsedMs = 0;
  private contentPlaceholderElapsedMs = 0;
  private loadPromise: Promise<boolean> | null = null;
  private requestedVisible = false;
  private responsiveLayout: ResponsiveLayoutSnapshot | null = null;

  constructor() {
    this.view.visible = false;
  }

  get hasArtwork(): boolean {
    return this.spine !== null;
  }

  loadArtwork(signal?: AbortSignal): Promise<boolean> {
    if (this.spine) return Promise.resolve(true);
    if (this.loadPromise) return this.loadPromise;
    const attempt = Promise.all([
      loadPrimalSpineSet(["featurePreview", "background", "backgroundFront"] as const),
      Texture.fromURL(FEATURE_PREVIEW_ASSETS.plate),
    ]).then(([data, plateTexture]) => {
      if (signal?.aborted) return false;
      const backdrop = this.createFrozenIntroView(
        data.background,
        FEATURE_PREVIEW_BACKGROUND_POSE.backdropSeconds,
      );
      const foreground = this.createFrozenIntroView(
        data.backgroundFront,
        FEATURE_PREVIEW_BACKGROUND_POSE.foregroundSeconds,
      );
      const placeholderTexture = new Texture(
        plateTexture.baseTexture,
        new Rectangle(
          FEATURE_PREVIEW_PLATE_REGION.x,
          FEATURE_PREVIEW_PLATE_REGION.y,
          FEATURE_PREVIEW_PLATE_REGION.width,
          FEATURE_PREVIEW_PLATE_REGION.height,
        ),
      );
      const placeholder = new Sprite(placeholderTexture);
      placeholder.anchor.set(0.5);
      placeholder.position.set(640, 360);
      placeholder.width = FEATURE_PREVIEW_PLATE_REGION.displaySize;
      placeholder.height = FEATURE_PREVIEW_PLATE_REGION.displaySize;

      const vignette = this.createPlateSprite(
        plateTexture,
        FEATURE_PREVIEW_CONTENT_REGIONS.vignette,
        FEATURE_PREVIEW_CONTENT_BOUNDS.vignette,
      );
      const divider = this.createPlateSprite(
        plateTexture,
        FEATURE_PREVIEW_CONTENT_REGIONS.divider,
        FEATURE_PREVIEW_CONTENT_BOUNDS.divider,
      );
      const contentPlaceholder = new Container();
      contentPlaceholder.addChild(
        this.createPlateSprite(
          plateTexture,
          FEATURE_PREVIEW_CONTENT_REGIONS.wheelPlaceholder,
          FEATURE_PREVIEW_CONTENT_BOUNDS.wheelPlaceholder,
        ),
        this.createPlateSprite(
          plateTexture,
          FEATURE_PREVIEW_CONTENT_REGIONS.reelsPlaceholder,
          FEATURE_PREVIEW_CONTENT_BOUNDS.reelsPlaceholder,
        ),
      );

      this.drawBlackOverlay(1_280, 720);

      const spine = createSpineView(data.featurePreview);
      spine.autoUpdate = false;
      spine.position.set(FEATURE_PREVIEW_SPINE_TRANSFORM.x, FEATURE_PREVIEW_SPINE_TRANSFORM.y);
      spine.scale.set(FEATURE_PREVIEW_SPINE_TRANSFORM.scale);
      this.spine = spine;
      this.backdrop = backdrop;
      this.foreground = foreground;
      this.placeholder = placeholder;
      this.contentPlaceholder = contentPlaceholder;
      this.backgroundHost.addChild(backdrop, foreground);
      this.contentHost.addChild(
        placeholder,
        vignette,
        contentPlaceholder,
        spine,
        divider,
      );
      this.view.addChild(this.backgroundHost, this.blackOverlay, this.contentHost);
      this.applyResponsiveLayout();
      if (this.requestedVisible) this.startPlayback();
      return true;
    });
    this.loadPromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (!this.spine && this.loadPromise === attempt) this.loadPromise = null;
      },
    );
    return attempt;
  }

  setVisible(visible: boolean): void {
    this.requestedVisible = visible;
    this.view.visible = visible && this.spine !== null;
    if (this.view.visible) this.startPlayback();
  }

  setResponsiveLayout(snapshot: ResponsiveLayoutSnapshot): void {
    this.responsiveLayout = snapshot;
    this.applyResponsiveLayout();
  }

  update(deltaMs: number): void {
    if (!this.view.visible) return;
    const elapsedMs = Math.min(64, Math.max(0, deltaMs));
    this.spine?.update(elapsedMs / 1_000);
    if (this.placeholder?.visible) {
      this.placeholderElapsedMs += elapsedMs;
      this.placeholder.alpha = Math.max(
        0,
        1 - this.placeholderElapsedMs / FEATURE_PREVIEW_PLAYBACK_MS.placeholderFade,
      );
      if (this.placeholder.alpha === 0) this.placeholder.visible = false;
    }
    if (this.contentPlaceholder?.visible) {
      this.contentPlaceholderElapsedMs += elapsedMs;
      const fadeElapsed = Math.max(
        0,
        this.contentPlaceholderElapsedMs - FEATURE_PREVIEW_PLAYBACK_MS.contentPlaceholderHold,
      );
      this.contentPlaceholder.alpha = Math.max(
        0,
        1 - fadeElapsed / FEATURE_PREVIEW_PLAYBACK_MS.contentPlaceholderFade,
      );
      if (this.contentPlaceholder.alpha === 0) this.contentPlaceholder.visible = false;
    }
    this.enforceAuthoredAdditiveSlots();
  }

  private startPlayback(): void {
    const spine = this.spine;
    if (!spine) return;
    this.view.visible = true;
    this.freezeBackdrop(this.backdrop, FEATURE_PREVIEW_BACKGROUND_POSE.backdropSeconds);
    this.freezeBackdrop(this.foreground, FEATURE_PREVIEW_BACKGROUND_POSE.foregroundSeconds);
    this.placeholderElapsedMs = 0;
    this.contentPlaceholderElapsedMs = 0;
    if (this.placeholder) {
      this.placeholder.visible = true;
      this.placeholder.alpha = 1;
    }
    if (this.contentPlaceholder) {
      this.contentPlaceholder.visible = true;
      this.contentPlaceholder.alpha = 1;
    }
    spine.skeleton.setToSetupPose();
    spine.state.clearTracks();
    if (spine.state.hasAnimation("show")) {
      spine.state.setAnimation(0, "show", false);
      if (spine.state.hasAnimation("loop")) spine.state.addAnimation(0, "loop", true, 0);
    } else if (spine.state.hasAnimation("loop")) {
      spine.state.setAnimation(0, "loop", true);
    }
    if (spine.state.hasAnimation("loop_wheel")) {
      spine.state.setAnimation(1, "loop_wheel", true);
    }
    spine.update(0);
    this.enforceAuthoredAdditiveSlots();
  }

  private applyResponsiveLayout(): void {
    const snapshot = this.responsiveLayout;
    if (!snapshot || snapshot.channel === "desktop") {
      this.backgroundHost.pivot.set(0, 0);
      this.backgroundHost.position.set(0, 0);
      this.backgroundHost.scale.set(1);
      this.contentHost.pivot.set(0, 0);
      this.contentHost.position.set(0, 0);
      this.contentHost.scale.set(1);
      this.drawBlackOverlay(1_280, 720);
      return;
    }
    const transforms = snapshot.fpsTransforms;
    const profile = snapshot.fpsProfile;
    if (!transforms || !profile) return;

    // 身份主机对应于捕获的桌面 `ls` 根。移动版本会改变 minBound 比例和预设的内部宽度。
    this.projectHost(
      this.contentHost,
      transforms.content,
      { x: 640, y: 360, scale: 720 / 1_100 },
      1,
    );
    this.projectHost(
      this.backgroundHost,
      transforms.background,
      { x: 640, y: 300, scale: 1_280 / 1_500 },
      1,
    );
    this.drawBlackOverlay(snapshot.viewportRegion.width, snapshot.viewportRegion.height);
  }

  private projectHost(
    host: Container,
    target: ResponsiveNodeTransform,
    base: ResponsiveNodeTransform,
    adaptiveScale: number,
  ): void {
    host.pivot.set(base.x, base.y);
    host.position.set(target.x, target.y);
    host.scale.set(target.scale / base.scale * adaptiveScale);
  }

  private drawBlackOverlay(width: number, height: number): void {
    this.blackOverlay.clear();
    this.blackOverlay.beginFill(0x000000, 0.5).drawRect(0, 0, width, height).endFill();
  }

  private createFrozenIntroView(
    data: Parameters<typeof createSpineView>[0],
    timeSeconds: number,
  ): Spine {
    // 预览背景重复使用PR_background / PR_background_frnt，其`add/normal_*`图集名称是正常的全屏城市车牌。
    const view = createSpineView(data, { regionAdditiveFallback: false });
    view.autoUpdate = false;
    view.position.set(
      FEATURE_PREVIEW_BACKGROUND_TRANSFORM.x,
      FEATURE_PREVIEW_BACKGROUND_TRANSFORM.y,
    );
    view.scale.set(FEATURE_PREVIEW_BACKGROUND_TRANSFORM.scale);
    this.freezeBackdrop(view, timeSeconds);
    return view;
  }

  private createPlateSprite(
    plateTexture: Texture,
    region: Readonly<{ x: number; y: number; width: number; height: number }>,
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>,
  ): Sprite {
    const texture = new Texture(
      plateTexture.baseTexture,
      new Rectangle(region.x, region.y, region.width, region.height),
    );
    const sprite = new Sprite(texture);
    sprite.position.set(bounds.x, bounds.y);
    sprite.width = bounds.width;
    sprite.height = bounds.height;
    return sprite;
  }

  private freezeBackdrop(view: Spine | null, timeSeconds: number): void {
    if (!view) return;
    view.skeleton.setToSetupPose();
    view.state.clearTracks();
    if (view.state.hasAnimation("intro")) {
      const entry = view.state.setAnimation(0, "intro", false);
      entry.trackTime = Math.min(entry.animationEnd, Math.max(0, timeSeconds));
    }
    view.update(0);
    view.state.timeScale = 0;
  }

  /**
   * FPS 图集故意将发光/电动框架存储在不透明的 JPEG 页面上。它们仅通过Spine的附加时隙模式是透明的。
   * 遮罩插槽可以在交换其附件时短暂保留 Pixi 的默认 NORMAL 混合，这会将 JPEG 的黑色背景暴露为大矩形。每次 Spine 更新后重新断言实时可渲染对象上的混合，
   * 以便预设的黑色为零合成保持不变。
   */
  private enforceAuthoredAdditiveSlots(): void {
    const spine = this.spine;
    if (!spine) return;
    for (const slot of spine.skeleton.slots) {
      if (slot.data.blendMode !== BLEND_MODES.ADD) continue;
      slot.blendMode = BLEND_MODES.ADD;
      const renderSlot = slot as typeof slot & {
        currentSprite?: { blendMode: number };
        currentMesh?: { blendMode: number };
      };
      if (renderSlot.currentSprite) renderSlot.currentSprite.blendMode = BLEND_MODES.ADD;
      if (renderSlot.currentMesh) renderSlot.currentMesh.blendMode = BLEND_MODES.ADD;
    }
  }
}
