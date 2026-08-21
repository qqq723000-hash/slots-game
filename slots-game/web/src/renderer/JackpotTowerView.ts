import { Vector2 } from "@pixi-spine/base";
import {
  Container,
  TEXT_GRADIENT,
  Text,
  TextStyle,
} from "pixi.js";
import type { MoneyMinor } from "../app/state/types";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";
import {
  resolveResponsiveMinBound,
  responsiveRendererRegion,
  type MobileHandMode,
  type MobileLayoutProfile,
  type ResponsiveMinBound,
  type ResponsiveNodeTransform,
  type ResponsiveRendererRegion,
} from "./ResponsiveLayout";
import {
  createSpineView,
  enforcePrimalRegionBlendModes,
  type Spine,
} from "./spine/SpineAdapter";
import {
  loadPrimalSpineSet,
  type PrimalSpineKey,
} from "./spine/PrimalSpineAssets";

export interface JackpotTierLayout {
  readonly key: Extract<PrimalSpineKey, `jackpot${string}`>;
  readonly tier: "grand" | "mega" | "major" | "minor" | "mini";
  readonly label: "GRAND" | "MEGA" | "MAJOR" | "MINOR" | "MINI";
  readonly multiplier: bigint;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly minBound: readonly [left: number, top: number, width: number, height: number];
  readonly titleWidth: number;
  readonly valueWidth: number;
}

/** 从 1280x720 的原始 1200x900 布局解析精确的桌面转换。 */
export const JACKPOT_TIER_LAYOUTS: readonly JackpotTierLayout[] = Object.freeze([
  { key: "jackpotGrand", tier: "grand", label: "GRAND", multiplier: 1_000n, x: 244, y: 280, scale: 0.8, minBound: [-135, -350, 1_260, 900], titleWidth: 166.81, valueWidth: 164.76 },
  { key: "jackpotMega", tier: "mega", label: "MEGA", multiplier: 250n, x: 244, y: 367.2, scale: 0.72, minBound: [-150, -510, 1_400, 1_000], titleWidth: 147.46, valueWidth: 164.76 },
  { key: "jackpotMajor", tier: "major", label: "MAJOR", multiplier: 75n, x: 244, y: 445.090909, scale: 720 / 1_100, minBound: [-165, -680, 1_540, 1_100], titleWidth: 166.81, valueWidth: 164.76 },
  { key: "jackpotMinor", tier: "minor", label: "MINOR", multiplier: 30n, x: 244, y: 516, scale: 0.6, minBound: [-180, -860, 1_680, 1_200], titleWidth: 147.94, valueWidth: 164.76 },
  { key: "jackpotMini", tier: "mini", label: "MINI", multiplier: 10n, x: 244, y: 581.538462, scale: 720 / 1_300, minBound: [-195, -1_050, 1_820, 1_300], titleWidth: 145.5, valueWidth: 164.76 },
]);

interface MobileJackpotNodeLayout {
  readonly minBound: ResponsiveMinBound;
  readonly horizontalAlign: number;
  readonly verticalAlign: number;
}

function mobileJackpotNode(
  left: number,
  top: number,
  width: number,
  height: number,
  horizontalAlign: number,
  verticalAlign: number,
): MobileJackpotNodeLayout {
  return Object.freeze({
    minBound: Object.freeze({ left, top, width, height }),
    horizontalAlign,
    verticalAlign,
  });
}

type MobileJackpotTierLayouts = Readonly<Record<JackpotTier, MobileJackpotNodeLayout>>;

const PT_JACKPOT_LAYOUT: MobileJackpotTierLayouts = Object.freeze({
  grand: mobileJackpotNode(-350, -70, 700, 100, 0.5, 0),
  mega: mobileJackpotNode(-115, -80, 800, 100, 0.5, 0),
  major: mobileJackpotNode(-680, -80, 800, 100, 0.5, 0),
  minor: mobileJackpotNode(-114, -220, 900, 100, 0.5, 0),
  mini: mobileJackpotNode(-779, -220, 900, 100, 0.5, 0),
});

const IPAD_PT_JACKPOT_LAYOUT: MobileJackpotTierLayouts = Object.freeze({
  grand: mobileJackpotNode(-400, -45, 800, 100, 0.5, 0.03),
  mega: mobileJackpotNode(-135, -50, 900, 100, 0.5, 0.03),
  major: mobileJackpotNode(-770, -50, 900, 100, 0.5, 0.03),
  minor: mobileJackpotNode(-138, -200, 1_000, 100, 0.5, 0.03),
  mini: mobileJackpotNode(-868, -200, 1_000, 100, 0.5, 0.03),
});

const LS_RIGHT_JACKPOT_LAYOUT: MobileJackpotTierLayouts = Object.freeze({
  grand: mobileJackpotNode(-235, -320, 1_260, 900, 0, 0.5),
  mega: mobileJackpotNode(-260, -480, 1_400, 1_000, 0, 0.5),
  major: mobileJackpotNode(-285, -650, 1_540, 1_100, 0, 0.5),
  minor: mobileJackpotNode(-310, -830, 1_680, 1_200, 0, 0.5),
  mini: mobileJackpotNode(-335, -1_020, 1_820, 1_300, 0, 0.5),
});

const LS_LEFT_JACKPOT_LAYOUT: MobileJackpotTierLayouts = Object.freeze({
  grand: mobileJackpotNode(-1_022, -320, 1_260, 900, 1, 0.5),
  mega: mobileJackpotNode(-1_136, -480, 1_400, 1_000, 1, 0.5),
  major: mobileJackpotNode(-1_248, -650, 1_540, 1_100, 1, 0.5),
  minor: mobileJackpotNode(-1_365, -830, 1_680, 1_200, 1, 0.5),
  mini: mobileJackpotNode(-1_480, -1_020, 1_820, 1_300, 1, 0.5),
});

export function jackpotTierMobileLayout(
  tier: JackpotTier,
  profile: MobileLayoutProfile,
  handMode: MobileHandMode,
  region: ResponsiveRendererRegion,
): ResponsiveNodeTransform {
  const layouts = profile === "pt"
    ? PT_JACKPOT_LAYOUT
    : profile === "iPad_pt"
      ? IPAD_PT_JACKPOT_LAYOUT
      : handMode === "right"
        ? LS_RIGHT_JACKPOT_LAYOUT
        : LS_LEFT_JACKPOT_LAYOUT;
  const layout = layouts[tier];
  const transform = resolveResponsiveMinBound(
    region,
    layout.minBound,
    layout.horizontalAlign,
    layout.verticalAlign,
  );
  return transform;
}

export interface JackpotTierMobileDisplayLayout extends ResponsiveNodeTransform {
  readonly scaleX: number;
  readonly scaleY: number;
}

/** 844x390 实机证据显示官方横屏父级只把大奖面板沿 X 轴扩展 12%，Y 轴仍保持 canonical minBound 投影。 */
export const JACKPOT_COMPACT_LANDSCAPE_SCALE_X = 1.12;

export function jackpotTierMobileDisplayLayout(
  tier: JackpotTier,
  profile: MobileLayoutProfile,
  handMode: MobileHandMode,
  region: ResponsiveRendererRegion,
): JackpotTierMobileDisplayLayout {
  const canonical = jackpotTierMobileLayout(tier, profile, handMode, region);
  const compactLandscape = profile === "ls"
    && region.height > 0
    && region.width / region.height >= 2;
  const scaleX = canonical.scale * (compactLandscape
    ? JACKPOT_COMPACT_LANDSCAPE_SCALE_X
    : 1);
  return Object.freeze({
    ...canonical,
    scaleX,
    scaleY: canonical.scale,
  });
}

export function jackpotTierResponsiveLayout(
  layout: JackpotTierLayout,
  visibleInsetX: number,
): ResponsiveNodeTransform {
  const [left, top, width, height] = layout.minBound;
  return resolveResponsiveMinBound(
    responsiveRendererRegion(visibleInsetX),
    { left, top, width, height },
  );
}

const SILVER_GRADIENT = [
  "#ffffff",
  "#727e9c",
  "#ffffff",
  "#9fa6be",
  "#94b1c3",
] as const;
const SILVER_STOPS = [0.33, 0.38, 0.75, 0.8, 1] as const;
const DARK_GRADIENT = [
  "#474747",
  "#505972",
  "#474747",
  "#717c9f",
  "#474747",
] as const;

export type JackpotTier = JackpotTierLayout["tier"];

export const JACKPOT_COLLECTION_REACTION_STEP_MS = 200;

/** Wheel/Vault事件携带的奖品标识符使用预设的等级名称。 */
export function jackpotTierFromAward(value: string | undefined): JackpotTier | null {
  if (value === undefined) return null;
  const match = /^(MINI|MINOR|MAJOR|MEGA|GRAND)(?:_2X)?$/i.exec(value.trim());
  return match?.[1]?.toLowerCase() as JackpotTier | undefined ?? null;
}

/** GameJackpotController 使用的确切的从下到上的顺序。 */
export function jackpotCollectionReactionPlan(): readonly Readonly<{
  tier: JackpotTier;
  atMs: number;
}>[] {
  return JACKPOT_TIER_LAYOUTS
    .slice()
    .reverse()
    .map(({ tier }, index) => ({
      tier,
      atMs: index * JACKPOT_COLLECTION_REACTION_STEP_MS,
    }));
}

interface JackpotPanel {
  readonly layout: JackpotTierLayout;
  readonly root: Container;
  /** 一个原创风格的 Spine 实体拥有每个预设的视觉插槽。 */
  readonly view: Spine;
  readonly title: Text;
  readonly value: Text;
  /** Y 反射主机放置在预设的标题/值槽容器内。 */
  readonly titleHost: Container;
  readonly valueHost: Container;
  readonly titlePoint: Vector2;
  readonly valuePoint: Vector2;
}

// 提供的原始骨架都使用这个精确的中心创作顺序：基本插槽 0–43 → 标题文本字段 44 → 火 FX 45 → 值文本字段 46 → 前景闪电/烟雾插槽 47+。
// 标题/值字段是 BoundingBox 附件，因此 Pixi-Spine 在每次更新后隐藏其容器。  我们在姿势更新后仅重新启用这两个容器，
// 并将本机 Pixi 文本放入其中，保留原始的 one-Spine 顺序。
const JACKPOT_TITLE_SLOT = 44;
const JACKPOT_VALUE_SLOT = 46;
export const JACKPOT_FONT_FAMILY = "KANIT_BOLD";
export const JACKPOT_FONT_DESCRIPTOR = `normal 48px "${JACKPOT_FONT_FAMILY}"`;
export const JACKPOT_AUTHORED_TIME_SCALE = 1;

async function waitForJackpotFont(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  if (signal?.aborted) return;
  await document.fonts.load(JACKPOT_FONT_DESCRIPTOR, "GRAND 1000.00");
}

function jackpotTextStyle(fontSize: number): TextStyle {
  return new TextStyle({
    align: "center",
    dropShadow: true,
    dropShadowAlpha: 10,
    dropShadowAngle: 1.57,
    dropShadowBlur: 0,
    dropShadowColor: "#1d2f2f",
    dropShadowDistance: 5,
    fill: [...SILVER_GRADIENT],
    fillGradientStops: [...SILVER_STOPS],
    fillGradientType: TEXT_GRADIENT.LINEAR_VERTICAL,
    // 官方字体 CSS 将其已经粗体的 WOFF 公开为 KANIT_BOLD 家族的专用字体 `normal`。
    // 在重命名的系列下请求 700 可以在错过匹配面孔的浏览器上合成第二个权重。
    fontFamily: `'${JACKPOT_FONT_FAMILY}', 'Primal Kanit', Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif`,
    fontSize,
    fontWeight: "normal",
    lineJoin: "miter",
    stroke: "#22140e",
    strokeThickness: 6,
  });
}

/** 格式化服务器投注预测，而不通过浮点数转换整数货币。 */
export function jackpotDisplayValue(
  betMinor: MoneyMinor,
  multiplier: bigint,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): string {
  if (!/^(0|[1-9]\d*)$/.test(betMinor)) return formatter.format("0", false);
  return formatter.format((BigInt(betMinor) * multiplier).toString(), false);
}

/**
 * 原来的五面板大奖塔。 Spine 拥有金属、乐队、奖牌和效果； Pixi 文本附加到预设的标题/值边界槽。
 */
export class JackpotTowerView extends Container {
  private readonly panels: JackpotPanel[] = [];
  private betMinor: MoneyMinor = "0";
  private moneyFormatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER;
  private loadPromise: Promise<void> | null = null;
  private reactionElapsedMs = 0;
  private reactionCursor = 0;
  private reactionPlan: ReturnType<typeof jackpotCollectionReactionPlan> = [];
  /** 镜像原始控制器的 `_panelHighlightOn` 复位保护。 */
  private panelHighlightOn = false;
  private visibleInsetX = 0;
  private mobileLayoutContext: Readonly<{
    profile: MobileLayoutProfile;
    handMode: MobileHandMode;
    region: ResponsiveRendererRegion;
  }> | null = null;
  private disposed = false;

  constructor() {
    super();
    this.alpha = 0;
    this.visible = false;
    this.interactive = false;
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const keys = JACKPOT_TIER_LAYOUTS.map(({ key }) => key);
    this.loadPromise = Promise.all([
      loadPrimalSpineSet(keys),
      waitForJackpotFont(signal),
    ]).then(([data]) => {
      if (this.disposed || signal?.aborted) return;
      for (const layout of JACKPOT_TIER_LAYOUTS) {
        const panel = new Container();
        const responsiveLayout = this.panelResponsiveDisplayLayout(layout);
        panel.position.set(responsiveLayout.x, responsiveLayout.y);
        panel.scale.set(responsiveLayout.scaleX, responsiveLayout.scaleY);

        const view = createSpineView(data[layout.key], {
          animation: "idle",
          loop: true,
          timeScale: JACKPOT_AUTHORED_TIME_SCALE,
        });
        view.autoUpdate = false;
        view.update(0);

        const title = new Text(layout.label, jackpotTextStyle(45));
        const value = new Text(
          jackpotDisplayValue(this.betMinor, layout.multiplier, this.moneyFormatter),
          jackpotTextStyle(48),
        );
        title.anchor.set(0.5);
        value.anchor.set(0.5);
        const titleHost = this.attachTextAtSlot(
          view,
          title,
          `${layout.tier}Title`,
          JACKPOT_TITLE_SLOT,
        );
        const valueHost = this.attachTextAtSlot(
          view,
          value,
          `${layout.tier}Value`,
          JACKPOT_VALUE_SLOT,
        );
        // 原始引擎将两个动态文本字段存储在预设的 Spine 实例中。这会自动保留标题→火→值→前景顺序，而不会出现重复的前景Spine。
        panel.addChild(view);
        this.addChild(panel);

        const jackpotPanel: JackpotPanel = {
          layout,
          root: panel,
          view,
          title,
          value,
          titleHost,
          valueHost,
          titlePoint: new Vector2(),
          valuePoint: new Vector2(),
        };
        this.panels.push(jackpotPanel);
        this.repairTextSlotContainers(jackpotPanel);
      }
      this.syncValues();
    }).catch((error: unknown) => {
      this.loadPromise = null;
      throw error;
    });
    return this.loadPromise;
  }

  setBet(betMinor: MoneyMinor): void {
    if (this.betMinor === betMinor) return;
    this.betMinor = betMinor;
    this.syncValues();
  }

  setMoneyFormatter(formatter: MinorUnitFormatter): void {
    this.moneyFormatter = formatter;
    this.syncValues();
  }

  setResponsiveLayout(visibleInsetX: number): void {
    this.mobileLayoutContext = null;
    this.visibleInsetX = Number.isFinite(visibleInsetX) ? Math.max(0, visibleInsetX) : 0;
    for (const panel of this.panels) {
      const layout = this.panelResponsiveDisplayLayout(panel.layout);
      panel.root.position.set(layout.x, layout.y);
      panel.root.scale.set(layout.scaleX, layout.scaleY);
    }
    this.syncTextAnchors();
  }

  setMobileLayout(
    profile: MobileLayoutProfile,
    handMode: MobileHandMode,
    region: ResponsiveRendererRegion,
  ): void {
    this.mobileLayoutContext = { profile, handMode, region: { ...region } };
    for (const panel of this.panels) {
      const layout = this.panelResponsiveDisplayLayout(panel.layout);
      panel.root.position.set(layout.x, layout.y);
      panel.root.scale.set(layout.scaleX, layout.scaleY);
    }
    this.syncTextAnchors();
  }

  setHudReveal(progress: number): void {
    const reveal = Math.max(0, Math.min(1, progress));
    this.alpha = reveal;
    this.visible = reveal > 0.001;
  }

  update(deltaMs: number): void {
    if (!this.visible || this.panels.length === 0) return;
    const wallClockDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
    const poseDeltaMs = Math.min(64, wallClockDeltaMs);
    const deltaSeconds = poseDeltaMs / 1_000;
    for (const panel of this.panels) this.updatePanelView(panel, deltaSeconds);
    // Spine 姿势可限幅以避免恢复后台标签页时发生大步跳帧；五档收集顺序属于墙钟语义，不能被同一限幅拖慢。
    this.advanceCollectionReaction(wallClockDeltaMs);
    this.syncTextAnchors();
  }

  /** 镜像 GameJackpotController.reactToCollection 的五个 200ms 步骤。 */
  reactToCollection(): void {
    if (this.panels.length === 0 || this.disposed) return;
    this.reactionPlan = jackpotCollectionReactionPlan();
    this.reactionElapsedMs = 0;
    this.reactionCursor = 0;
    this.advanceCollectionReaction(0);
  }

  /** 突出显示一项或多项服务器权威大奖。 */
  highlightAwards(tiers: readonly JackpotTier[]): void {
    const won = new Set(tiers);
    this.applyAwardHighlight(won, false);
  }

  /**
   * Kong Quest/King Spin 占据了五个累积奖金 IDs 之外的 Wheel 片。
   * 原始版本将其解决为 `win(-1)`：每个板块都会进入黑暗并等待稍后的 FREESPIN_START 重置，而不是突出显示一个层。
   */
  darkenAllPanels(): void {
    this.applyAwardHighlight(new Set(), true);
  }

  private applyAwardHighlight(
    won: ReadonlySet<JackpotTier>,
    allowNoWinner: boolean,
  ): void {
    if ((!allowNoWinner && won.size === 0) || this.disposed) return;
    this.panelHighlightOn = true;
    this.reactionPlan = [];
    this.reactionCursor = 0;
    for (const panel of this.panels) {
      const isWinner = won.has(panel.layout.tier);
      const { view } = panel;
      if (isWinner) {
        if (view.state.hasAnimation("win_shooting")) {
          this.replacePanelTrack(view, "win_shooting", false);
        }
        if (view.state.hasAnimation("loop")) {
          view.state.addAnimation(0, "loop", true, 0);
        }
      } else if (view.state.hasAnimation("darkness")) {
        this.replacePanelTrack(view, "darkness", false, 0.8);
      }
      this.applyTextPalette(panel, isWinner ? SILVER_GRADIENT : DARK_GRADIENT);
      this.updatePanelView(panel, 0);
    }
    this.syncTextAnchors();
  }

  highlightAward(value: string | undefined): void {
    const tier = jackpotTierFromAward(value);
    if (tier) this.highlightAwards([tier]);
  }

  /** Spin/Freespin/Wheel 开始使用捕获的表演剪辑恢复每个板块。 */
  resetPanelAnimations(): void {
    if (this.disposed || !this.panelHighlightOn) return;
    this.panelHighlightOn = false;
    this.reactionPlan = [];
    this.reactionCursor = 0;
    for (const panel of this.panels) {
      this.applyTextPalette(panel, SILVER_GRADIENT);
      const { view } = panel;
      if (!this.replacePanelTrack(view, "show", false, 0.8)) {
        this.replacePanelTrack(view, "idle", true);
      }
      this.updatePanelView(panel, 0);
    }
    this.syncTextAnchors();
  }

  /**
   * 镜像原始渲染器的 `playSpine` 替换边界：在安装下一个预设的动画之前将当前轨道混合到空姿势。 `clearTrack` 仅删除 Pixi-Spine 中的条目，
   * 并且可以在 `show` 夹子后面留下可见的未加密奖励 FX 附件。
   */
  private replacePanelTrack(
    view: Spine,
    animation: string,
    loop: boolean,
    mixDuration?: number,
  ): boolean {
    if (!view.state.hasAnimation(animation)) return false;
    view.state.setEmptyAnimation(0, 0.15);
    const entry = view.state.setAnimation(0, animation, loop);
    if (mixDuration !== undefined) entry.mixDuration = mixDuration;
    return true;
  }

  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    this.disposed = true;
    this.reactionPlan = [];
    super.destroy(options);
  }

  private syncValues(): void {
    for (const panel of this.panels) {
      panel.value.text = jackpotDisplayValue(
        this.betMinor,
        panel.layout.multiplier,
        this.moneyFormatter,
      );
    }
    this.syncTextAnchors();
  }

  private panelResponsiveLayout(layout: JackpotTierLayout): ResponsiveNodeTransform {
    const mobile = this.mobileLayoutContext;
    if (!mobile) return jackpotTierResponsiveLayout(layout, this.visibleInsetX);
    return jackpotTierMobileLayout(layout.tier, mobile.profile, mobile.handMode, mobile.region);
  }

  private panelResponsiveDisplayLayout(
    layout: JackpotTierLayout,
  ): JackpotTierMobileDisplayLayout {
    const mobile = this.mobileLayoutContext;
    if (mobile) {
      return jackpotTierMobileDisplayLayout(
        layout.tier,
        mobile.profile,
        mobile.handMode,
        mobile.region,
      );
    }
    const canonical = this.panelResponsiveLayout(layout);
    return Object.freeze({
      ...canonical,
      scaleX: canonical.scale,
      scaleY: canonical.scale,
    });
  }

  private syncTextAnchors(): void {
    for (const panel of this.panels) {
      this.syncTextAtSlot(
        panel,
        panel.title,
        panel.titleHost,
        `${panel.layout.tier}Title`,
        panel.titlePoint,
        panel.layout.titleWidth,
      );
      this.syncTextAtSlot(
        panel,
        panel.value,
        panel.valueHost,
        `${panel.layout.tier}Value`,
        panel.valuePoint,
        panel.layout.valueWidth,
      );
    }
  }

  private advanceCollectionReaction(deltaMs: number): void {
    if (this.reactionCursor >= this.reactionPlan.length) return;
    this.reactionElapsedMs += deltaMs;
    while (this.reactionCursor < this.reactionPlan.length) {
      const step = this.reactionPlan[this.reactionCursor];
      if (!step || step.atMs > this.reactionElapsedMs) break;
      const panel = this.panels.find(({ layout }) => layout.tier === step.tier);
      if (panel?.view.state.hasAnimation("trail_reaction")) {
        panel.view.state.setAnimation(0, "trail_reaction", false);
        this.updatePanelView(panel, 0);
      }
      this.reactionCursor += 1;
    }
  }

  private applyTextPalette(
    panel: JackpotPanel,
    colors: readonly string[],
  ): void {
    for (const text of [panel.title, panel.value]) {
      text.style.fill = [...colors];
      text.style.fillGradientStops = [...SILVER_STOPS];
    }
  }

  private updatePanelView(panel: JackpotPanel, deltaSeconds: number): void {
    panel.view.update(deltaSeconds);
    this.repairTextSlotContainers(panel);
  }

  private repairTextSlotContainers(panel: JackpotPanel): void {
    // 提供的累积奖金图集将附加的黑色零区域编码。 Pixi-Spine 在每次更新时重新应用插槽混合模式，因此在每个姿势或动画过渡后重新声明源材质。
    const { view } = panel;
    enforcePrimalRegionBlendModes(view);
    this.repairTextSlotContainer(view, `${panel.layout.tier}Title`, JACKPOT_TITLE_SLOT);
    this.repairTextSlotContainer(view, `${panel.layout.tier}Value`, JACKPOT_VALUE_SLOT);
  }

  /**
   * 时隙 44/46 是 BoundingBox 字段。 Pixi-Spine 故意隐藏这些通用插槽，因此每次更新后修复其本机插槽容器，以直接托管在其中的 Pixi 替换文本。
   */
  private repairTextSlotContainer(
    view: Spine,
    slotName: string,
    expectedSlotIndex: number,
  ): void {
    const slot = view.skeleton.findSlot(slotName);
    if (!slot || slot.data.index !== expectedSlotIndex) return;
    const slotContainer = view.slotContainers[slot.data.index];
    if (!slotContainer) return;
    const attachment = slot.getAttachment();
    slotContainer.transform.setFromMatrix(slot.bone.matrix);
    slotContainer.alpha = slot.color.a;
    slotContainer.visible = attachment !== null && slot.color.a > 0.001;
    // 清除或交换的占位符可以保留其旧的可渲染图集。文本必须是两个 BoundingBox 字段槽中的唯一内容。
    const renderedSlot = slot as typeof slot & {
      currentSprite?: { renderable: boolean };
      currentMesh?: { renderable: boolean };
    };
    if (renderedSlot.currentSprite) renderedSlot.currentSprite.renderable = false;
    if (renderedSlot.currentMesh) renderedSlot.currentMesh.renderable = false;
  }

  /** 在其预设的边界槽的中心附加一个直立的文本宿主。 */
  private attachTextAtSlot(
    view: Spine,
    text: Text,
    slotName: string,
    expectedSlotIndex: number,
  ): Container {
    const slot = view.skeleton.findSlot(slotName);
    const slotContainer = slot ? view.slotContainers[slot.data.index] : undefined;
    if (!slot || slot.data.index !== expectedSlotIndex || !slotContainer) {
      throw new Error(`Missing authored Jackpot text slot: ${slotName}`);
    }
    const host = new Container();
    // Spine 的骨骼矩阵是 Y 向上，而 Pixi 文本是 Y 向下。仅反映主机：其位置仍然是原始作者BoundingBox中心。
    host.scale.set(1, -1);
    host.addChild(text);
    slotContainer.addChild(host);
    return host;
  }

  private syncTextAtSlot(
    panel: JackpotPanel,
    text: Text,
    host: Container,
    slotName: string,
    point: Vector2,
    maxWidth: number,
  ): void {
    const slot = panel.view.skeleton.findSlot(slotName);
    if (!slot) return;
    this.fitText(text, maxWidth);
    // 宿主已经被活槽骨改造了。将其本地来源保留在作者BoundingBox中心；主机上的 Y 反射仅修正字形方向，不会改变原点。
    const attachment = slot.getAttachment() as { vertices?: ArrayLike<number> } | null;
    const vertices = attachment?.vertices;
    if (!vertices || vertices.length < 2) {
      host.position.set(0, 0);
    } else {
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;
      for (let index = 0; index + 1 < vertices.length; index += 2) {
        minX = Math.min(minX, vertices[index] ?? minX);
        maxX = Math.max(maxX, vertices[index] ?? maxX);
        minY = Math.min(minY, vertices[index + 1] ?? minY);
        maxY = Math.max(maxY, vertices[index + 1] ?? maxY);
      }
      point.set((minX + maxX) / 2, (minY + maxY) / 2);
      host.position.set(point.x, point.y);
    }
  }

  private fitText(text: Text, maxWidth: number): number {
    // 在应用此帧的实时 Spine 变换之前重置为拟合基线。当尾部从脉冲返回到空闲状态时，这一点至关重要。
    text.scale.set(1);
    text.rotation = 0;
    if (text.width > maxWidth) text.scale.x = maxWidth / text.width;
    return text.scale.x;
  }
}
