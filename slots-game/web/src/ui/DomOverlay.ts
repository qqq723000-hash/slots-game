import type {
  FeatureEvent,
  FeatureState,
  FreeSpinsCompletedEvent,
  GameSnapshot,
  MoneyMinor,
  SessionOpened,
  SpinResult,
} from "../app/state/types";
import type { GamePhase } from "../app/state/GameStateMachine";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import type { GatewayStatus } from "../protocol/GameGateway";
import type { LaunchPhase } from "../startup/LaunchStateMachine";
import type { PreloadProgress } from "../startup/PreloadGate";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  MoneyDisplayBindingError,
  createMinorUnitFormatter,
  sameMoneyDisplayBinding,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";
import {
  PRIMAL_HELP_SECTIONS,
  PRIMAL_PRESENTATION_RULES,
  PRIMAL_WAY_WINS_COPY,
  bindPrimalPresentationRules,
  type PresentationRulesBindingResult,
} from "./presentationRules";

type SpinHandler = () => void;
type FastStopHandler = () => void;
type BetHandler = (betMinor: MoneyMinor) => void;
type SkipHandler = () => void;
type PreviewContinueHandler = () => void;
type SoundToggleHandler = () => void;
type FastPlayHandler = (enabled: boolean) => void;
export type GameMenuTab = "settings" | "paytable" | "rules";
export type UiPanelId = "bet" | "autoplay" | GameMenuTab;
export type UiPanelHandler = (panel: UiPanelId) => void;
/** @deprecated Use 四个捕获 `AutoPlayStopSettings` 的条件。 */
export type AutoPlayStopRule = "complete" | "win";

export type AutoPlayStopBoundary = "any-win" | "bonus" | "free-spins" | "jackpot";

export interface AutoPlayStopSettings {
  readonly anyWin: boolean;
  readonly bonus: boolean;
  readonly freeSpins: boolean;
  readonly jackpot: boolean;
}

export interface AutoPlayStopSettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 从捕获的桌面 `.471` 捆绑包中的 `AutoplaySettings.awake()` 和 `VideoSlotAutoplaySettings.awake()` 中恢复的不可变证据配置文件。
 * 这记录了源模型；它故意不是用户为此项目选择的本地运行时默认值。
 */
export const CAPTURED_AUTO_PLAY_STOP_SETTINGS: AutoPlayStopSettings = Object.freeze({
  anyWin: false,
  bonus: true,
  freeSpins: true,
  jackpot: true,
});

/** 用户请求的本地运行时配置文件：通过功能保留自动播放。 */
export const DEFAULT_AUTO_PLAY_STOP_SETTINGS: AutoPlayStopSettings = Object.freeze({
  anyWin: false,
  bonus: false,
  freeSpins: false,
  jackpot: false,
});

export const AUTO_PLAY_STOP_CONDITIONS = Object.freeze([
  { boundary: "any-win", setting: "anyWin", label: "On any win" },
  { boundary: "bonus", setting: "bonus", label: "If bonus game is won" },
  { boundary: "free-spins", setting: "freeSpins", label: "If free spins are won" },
  { boundary: "jackpot", setting: "jackpot", label: "If jackpot is won" },
] as const);

export function isAutoPlayStopBoundaryEnabled(
  settings: AutoPlayStopSettings,
  boundary: AutoPlayStopBoundary,
): boolean {
  switch (boundary) {
    case "any-win": return settings.anyWin;
    case "bonus": return settings.bonus;
    case "free-spins": return settings.freeSpins;
    case "jackpot": return settings.jackpot;
  }
}

export const AUTO_PLAY_STOP_SETTINGS_STORAGE_VERSION = 2;
export const AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY = "primal-rampage.autoplay-stop-settings.v2";

function freshDefaultAutoPlayStopSettings(): AutoPlayStopSettings {
  return { ...DEFAULT_AUTO_PLAY_STOP_SETTINGS };
}

function normalizeAutoPlayStopSettings(value: unknown): AutoPlayStopSettings {
  const source = value !== null && typeof value === "object"
    ? value as Partial<Record<keyof AutoPlayStopSettings, unknown>>
    : {};
  return {
    anyWin: typeof source.anyWin === "boolean" ? source.anyWin : DEFAULT_AUTO_PLAY_STOP_SETTINGS.anyWin,
    bonus: typeof source.bonus === "boolean" ? source.bonus : DEFAULT_AUTO_PLAY_STOP_SETTINGS.bonus,
    freeSpins: typeof source.freeSpins === "boolean"
      ? source.freeSpins
      : DEFAULT_AUTO_PLAY_STOP_SETTINGS.freeSpins,
    jackpot: typeof source.jackpot === "boolean" ? source.jackpot : DEFAULT_AUTO_PLAY_STOP_SETTINGS.jackpot,
  };
}

/**
 * 只有 v2 包络是当前的。旧版 v1、裸露、损坏和未来记录会回退到完全关闭运行时配置文件，因此旧的捕获默认记录不会意外停止新启动的自动播放会话。
 */
export function parseAutoPlayStopSettings(serialized: string | null): AutoPlayStopSettings {
  if (!serialized) return freshDefaultAutoPlayStopSettings();
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed === null || typeof parsed !== "object") return freshDefaultAutoPlayStopSettings();
    const envelope = parsed as { version?: unknown; settings?: unknown };
    if (envelope.version !== AUTO_PLAY_STOP_SETTINGS_STORAGE_VERSION) {
      return freshDefaultAutoPlayStopSettings();
    }
    return normalizeAutoPlayStopSettings(envelope.settings);
  } catch {
    return freshDefaultAutoPlayStopSettings();
  }
}

export function serializeAutoPlayStopSettings(settings: AutoPlayStopSettings): string {
  return JSON.stringify({
    version: AUTO_PLAY_STOP_SETTINGS_STORAGE_VERSION,
    settings: normalizeAutoPlayStopSettings(settings),
  });
}

function availableAutoPlayStopStorage(): AutoPlayStopSettingsStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadAutoPlayStopSettings(
  storage: AutoPlayStopSettingsStorage | null = availableAutoPlayStopStorage(),
): AutoPlayStopSettings {
  if (!storage) return freshDefaultAutoPlayStopSettings();
  try {
    return parseAutoPlayStopSettings(storage.getItem(AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY));
  } catch {
    return freshDefaultAutoPlayStopSettings();
  }
}

/** 当浏览器隐私/存储策略拒绝写入时返回 false。 */
export function persistAutoPlayStopSettings(
  settings: AutoPlayStopSettings,
  storage: AutoPlayStopSettingsStorage | null = availableAutoPlayStopStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUTO_PLAY_STOP_SETTINGS_STORAGE_KEY, serializeAutoPlayStopSettings(settings));
    return true;
  } catch {
    return false;
  }
}

function startupStageLabel(stage: string): string {
  switch (stage) {
    case "scene-mount": return "Preparing renderer";
    case "dom-readiness": return "Decoding interface";
    case "assets": return "Loading game resources";
    case "gpu-warmup": return "Warming graphics";
    case "complete": return "Ready";
    default: return "Awakening Korrak";
  }
}

/**
 * 可见控制面板的幂等仅表示生命周期。音频侦听器可能会失败，但不会阻止 DOM 面板更改状态。
 */
export class UiPanelLifecycle {
  private readonly visible = new Set<UiPanelId>();
  private openHandler: UiPanelHandler = () => undefined;
  private closeHandler: UiPanelHandler = () => undefined;

  onOpen(handler: UiPanelHandler): void {
    this.openHandler = handler;
  }

  onClose(handler: UiPanelHandler): void {
    this.closeHandler = handler;
  }

  setVisible(panel: UiPanelId, visible: boolean): boolean {
    if (this.visible.has(panel) === visible) return false;
    if (visible) this.visible.add(panel);
    else this.visible.delete(panel);
    try {
      (visible ? this.openHandler : this.closeHandler)(panel);
    } catch {
      // 面板状态权威；表现音频仅尽力而为。
    }
    return true;
  }
}

export const AUTO_PLAY_SPIN_COUNTS = [10, 20, 50, 75, 100] as const;
export const DEFAULT_AUTO_PLAY_SPINS = 50;
export const PAYTABLE_WILD_ENTRIES = [
  { label: "X100", asset: "10032.png" },
  { label: "X50", asset: "wild-x50.png" },
  { label: "X25", asset: "10033.png" },
  { label: "X10", asset: "10034.png" },
  { label: "X5", asset: "10035.png" },
  { label: "X3", asset: "10036.png" },
  { label: "X2", asset: "10037.png" },
  { label: "WILD", asset: "10038.png" },
] as const;

/** 获得三卷轴 Base Ways 奖励，相对于每路总投注额表示。 */
export const BASE_PAYTABLE_ENTRIES = [
  { symbol: "PRISM", label: "Q", multiplier: 0.1, asset: "10012.png" },
  { symbol: "ORBIT", label: "K", multiplier: 0.3, asset: "10013.png" },
  { symbol: "PULSE", label: "Helmet", multiplier: 0.8, asset: "10014.png" },
  { symbol: "NOVA", label: "Radio", multiplier: 1, asset: "10015.png" },
  { symbol: "TANK", label: "Tank", multiplier: 1.5, asset: "10016.png" },
  { symbol: "CIRCUIT", label: "Jet", multiplier: 2, asset: "10017.png" },
] as const;

export interface AutoPlayRunState {
  readonly active: boolean;
  readonly remaining: number;
}

export interface AutoPlayAdvance {
  readonly dispatchSpin: boolean;
  readonly state: AutoPlayRunState;
}

interface PendingPaidAutoplaySpin {
  readonly generation: number;
  readonly previous: AutoPlayRunState;
}

interface ArmedAutoPlayStopRound {
  readonly sequence: number;
  readonly anyWinEligible: boolean;
  readonly settings: AutoPlayStopSettings;
  readonly reached: Set<AutoPlayStopBoundary>;
  stopRequested: boolean;
}

/** 捕获 VideoSlotAutoplayController `continueDelay`：十个 24fps 刻度。 */
export const PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS = 10 * (1_000 / 24);
/** 捕获 VideoSlotAutoplayController `bonusDelay`：四十个 24fps 刻度。 */
export const PRIMAL_AUTOPLAY_BONUS_DELAY_MS = 40 * (1_000 / 24);

export interface PrimarySpinControlPresentation {
  readonly dataMode: SpinControlPresentation["dataMode"];
  readonly action: SpinControlAction | "autoplay-stop";
  readonly visualToken: SpinControlPresentation["visualToken"] | "autoplay-stop";
  readonly ariaLabel: string;
  readonly text: SpinControlPresentation["text"];
  readonly disabled: boolean;
  /** 自动播放外为空；渲染在 10004.svg 的黑色中心板上。 */
  readonly remainingText: string;
}

/**
 * 即使外部 Base 自动播放会话保持活动状态，这些模式也属于创作功能。功能操作绝不能被自动停止操作替代。
 */
export function isAutoplayFeatureOwnedSpinMode(mode: SpinMode): boolean {
  return mode === "feature-continue"
    || mode === "free-spin-summary-continue"
    || mode === "cap-continue"
    || mode === "wheel-popup-continue"
    || mode === "wheel-ready"
    || mode === "wheel-summary-continue"
    || mode === "wheel-fast-stop"
    || mode === "wheel-landing-continue"
    || mode === "wheel-none";
}

/** 捕获的自动游戏控制器前进的非投注功能输入。 */
export function autoplayFeatureInputDelay(mode: SpinMode): number | null {
  if (mode === "wheel-ready") return PRIMAL_AUTOPLAY_BONUS_DELAY_MS;
  if (mode === "feature-continue"
    || mode === "free-spin-summary-continue"
    || mode === "cap-continue") {
    return PRIMAL_AUTOPLAY_CONTINUE_DELAY_MS;
  }
  // Wheel 弹出窗口和摘要拥有捕获的 2500/3000ms 超时。手动 Continue 仍然可以提前释放它们而不结束自动播放运行。
  return null;
}

/**
 * 将一张已接受的外部 Base ROUNDSTART 提交至出示计数器。功能输入和拒绝的请求永远不会调用此帮助程序。
 */
export function advanceAutoPlay(
  state: AutoPlayRunState,
  ready: boolean,
): AutoPlayAdvance {
  if (!state.active || !ready || state.remaining <= 0) {
    return { dispatchSpin: false, state };
  }
  const remaining = state.remaining - 1;
  return {
    dispatchSpin: true,
    state: { active: remaining > 0, remaining },
  };
}

/**
 * 原始客户端在自动播放期间替换（而不是徽章）其主要绿色 Spin 按钮。  将此视觉/输入投影与现有的自旋模式状态机分开：它永远不会确定结果。
 */
export function primarySpinControlPresentation(
  mode: SpinMode,
  canSpin: boolean,
  autoplay: AutoPlayRunState,
): PrimarySpinControlPresentation {
  const regular = spinControlPresentation(mode, canSpin);
  if (!autoplay.active || isAutoplayFeatureOwnedSpinMode(mode)) {
    return { ...regular, remainingText: "" };
  }

  const remaining = Math.max(0, autoplay.remaining);
  return {
    ...regular,
    action: "autoplay-stop",
    visualToken: "autoplay-stop",
    ariaLabel: `Stop autoplay. ${remaining} spins remaining.`,
    // 常规文本在视觉上被橙色复合材料隐藏，但如果 CSS 尚未到达，则仍可作为明智的回退路径文本。
    text: regular.text,
    disabled: false,
    remainingText: String(remaining),
  };
}

export type SpinMode =
  | "ready"
  | "waiting"
  | "fast-stop"
  | "big-win-skip"
  | "normal-win-skip"
  | "feature-continue"
  | "free-spin-summary-continue"
  | "cap-continue"
  | "wheel-popup-continue"
  | "wheel-ready"
  | "wheel-summary-continue"
  | "wheel-fast-stop"
  | "wheel-landing-continue"
  | "wheel-none";

/** 为仅 Wheel 的 Spin 控制效果捕获光辉精灵相位。 */
export type WheelHyperspinPhase = "none" | "appear" | "loop" | "disappear";

export interface WheelHyperspinSpritePosition {
  readonly xPercent: number;
  readonly yPercent: number;
}

export interface WheelHyperspinFrameState {
  readonly phase: WheelHyperspinPhase;
  readonly frame: number;
}

/** 捕获的 Radiance 包中的模块 4159 将这个精灵推进到 24fps。 */
export const WHEEL_HYPERSPIN_FRAME_MS = 1_000 / 24;

const WHEEL_HYPERSPIN_COLUMNS = Object.freeze([
  0, 14.28, 28.57, 42.85, 57.14, 71.42, 85.71, 100,
] as const);

function boundedHyperspinFrame(frame: number, count: number): number {
  return Math.min(count - 1, Math.max(0, Math.floor(frame)));
}

/** 来自官方 HyperSpin CSS 模块的精确 8×6 精灵表坐标。 */
export function wheelHyperspinSpritePosition(
  phase: Exclude<WheelHyperspinPhase, "none">,
  frame: number,
): WheelHyperspinSpritePosition {
  if (phase === "appear") {
    const index = boundedHyperspinFrame(frame, 16);
    return {
      xPercent: WHEEL_HYPERSPIN_COLUMNS[index % 8] ?? 0,
      yPercent: index < 8 ? 0 : 20,
    };
  }
  if (phase === "loop") {
    const index = boundedHyperspinFrame(frame, 16);
    if (index < 2) {
      return { xPercent: WHEEL_HYPERSPIN_COLUMNS[index + 6] ?? 0, yPercent: 60 };
    }
    if (index < 10) {
      return { xPercent: WHEEL_HYPERSPIN_COLUMNS[index - 2] ?? 0, yPercent: 80 };
    }
    return { xPercent: WHEEL_HYPERSPIN_COLUMNS[index - 10] ?? 0, yPercent: 100 };
  }

  const index = boundedHyperspinFrame(frame, 14);
  return {
    xPercent: WHEEL_HYPERSPIN_COLUMNS[index % 8] ?? 0,
    yPercent: index < 8 ? 40 : 60,
  };
}

/** 一个官方 24fps 过渡；离开就绪状态首先完成活动通道。 */
export function nextWheelHyperspinFrame(
  state: Readonly<WheelHyperspinFrameState>,
  hideRequested: boolean,
): WheelHyperspinFrameState {
  if (state.phase === "none") return state;
  const length = state.phase === "disappear" ? 14 : 16;
  if (state.frame < length - 1) return { phase: state.phase, frame: state.frame + 1 };
  if (state.phase === "disappear") return { phase: "none", frame: 0 };
  if (hideRequested) return { phase: "disappear", frame: 0 };
  return { phase: "loop", frame: 0 };
}

/**
 * DOM相当于官方Radiance模块4159。游戏渲染器拥有Wheel；这个仅控制的精灵永远不会进入 Pixi 的过滤帧缓冲区。
 */
class WheelHyperspinEffect {
  private phase: WheelHyperspinPhase = "none";
  private frame = 0;
  private hideRequested = false;
  /** 镜像 React 当前的 `visible` 属性跨越待处理的消失通道。 */
  private visibleRequested = false;
  private frameHandle: number | null = null;
  private lastFrameAt = 0;

  constructor(private readonly element: HTMLElement) {
    this.paint();
  }

  setVisible(visible: boolean): void {
    this.visibleRequested = visible;
    if (visible) {
      // 捕获的React组件仅从`none`开始一个新的pass。
      if (this.phase !== "none") return;
      this.beginAppear();
      return;
    }
    if (this.phase !== "none") this.hideRequested = true;
  }

  destroy(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.phase = "none";
    this.frame = 0;
    this.visibleRequested = false;
    this.paint();
  }

  private readonly tick = (now: number): void => {
    this.frameHandle = null;
    if (this.phase === "none") return;
    if (this.lastFrameAt === 0 || now - this.lastFrameAt >= WHEEL_HYPERSPIN_FRAME_MS) {
      this.lastFrameAt = now;
      const next = nextWheelHyperspinFrame(
        { phase: this.phase, frame: this.frame },
        this.hideRequested,
      );
      this.phase = next.phase;
      this.frame = next.frame;
      this.paint();
    }
    if (this.phase === "none" && this.visibleRequested) {
      // 如果 Wheel Ready 在旧效果消失时返回，React 首先让 `disappear` 完成，然后开始新的 `appear` 传递。
      this.beginAppear();
    } else if (this.phase !== "none") {
      this.requestFrame();
    }
  };

  private beginAppear(): void {
    this.phase = "appear";
    this.frame = 0;
    this.hideRequested = false;
    this.lastFrameAt = 0;
    this.paint();
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.frameHandle === null) this.frameHandle = requestAnimationFrame(this.tick);
  }

  private paint(): void {
    const phase = this.phase;
    this.element.hidden = phase === "none";
    this.element.dataset.phase = phase;
    this.element.dataset.frame = String(this.frame);
    if (phase === "none") {
      this.element.style.removeProperty("background-position");
      return;
    }
    const position = wheelHyperspinSpritePosition(phase, this.frame);
    this.element.style.backgroundPosition = `${position.xPercent}% ${position.yPercent}%`;
  }
}

export type SpinControlAction =
  | "spin"
  | "fast-stop"
  | "continue"
  | "wheel-spin"
  | "wheel-quick-stop"
  | "none";

export interface SpinControlPresentation {
  readonly dataMode: "ready" | "continue" | "waiting" | "none";
  readonly action: SpinControlAction;
  readonly visualToken: "spin" | "continue" | "disabled-spin" | "none";
  readonly ariaLabel: string;
  readonly text: "Spin" | "Stop" | "Continue";
  readonly disabled: boolean;
}

/** 保持官方视觉令牌独立于当前输入门。 */
export function spinControlPresentation(
  mode: SpinMode,
  canSpin: boolean,
): SpinControlPresentation {
  switch (mode) {
    case "ready":
      return {
        dataMode: "ready",
        action: "spin",
        visualToken: "spin",
        ariaLabel: "Spin reels",
        text: "Spin",
        disabled: !canSpin,
      };
    case "waiting":
      return {
        dataMode: "waiting",
        action: "none",
        visualToken: "disabled-spin",
        ariaLabel: "Spin unavailable",
        text: "Spin",
        disabled: true,
      };
    case "fast-stop":
      return {
        dataMode: "continue",
        action: "fast-stop",
        visualToken: "continue",
        ariaLabel: "Stop reel animation",
        text: "Stop",
        disabled: false,
      };
    case "big-win-skip":
      return {
        dataMode: "continue",
        action: "fast-stop",
        visualToken: "continue",
        ariaLabel: "Advance Big Win presentation",
        text: "Continue",
        disabled: false,
      };
    case "normal-win-skip":
      return {
        dataMode: "continue",
        action: "fast-stop",
        visualToken: "continue",
        ariaLabel: "Continue win presentation",
        text: "Continue",
        disabled: false,
      };
    case "feature-continue":
      // GameFreespinView 与 CONTINUE_SPIN 一起等待：该按钮仍然看起来像绿色 Spin（双箭头 + 空闲光环），但其单击会消耗介绍门，
      // 而不是提交新的下注回合。
      return {
        dataMode: "ready",
        action: "continue",
        visualToken: "spin",
        ariaLabel: "Start Free Spins",
        text: "Spin",
        disabled: false,
      };
    case "free-spin-summary-continue":
      return {
        dataMode: "continue",
        action: "continue",
        visualToken: "continue",
        ariaLabel: "Continue Free Spins summary",
        text: "Continue",
        disabled: false,
      };
    case "cap-continue":
      return {
        dataMode: "continue",
        action: "continue",
        visualToken: "continue",
        ariaLabel: "Continue after Free Spin limit notice",
        text: "Continue",
        disabled: false,
      };
    case "wheel-popup-continue":
      return {
        dataMode: "continue",
        action: "continue",
        visualToken: "continue",
        ariaLabel: "Continue to Primal Wheel",
        text: "Continue",
        disabled: false,
      };
    case "wheel-ready":
      return {
        dataMode: "ready",
        action: "wheel-spin",
        visualToken: "spin",
        ariaLabel: "Spin Primal Wheel",
        text: "Spin",
        disabled: false,
      };
    case "wheel-summary-continue":
      return {
        dataMode: "continue",
        action: "continue",
        visualToken: "continue",
        ariaLabel: "Continue Wheel bonus summary",
        text: "Continue",
        disabled: false,
      };
    case "wheel-fast-stop":
      return {
        dataMode: "continue",
        action: "wheel-quick-stop",
        visualToken: "continue",
        ariaLabel: "Stop Primal Wheel",
        text: "Continue",
        disabled: false,
      };
    case "wheel-landing-continue":
      return {
        dataMode: "continue",
        action: "none",
        visualToken: "continue",
        ariaLabel: "Primal Wheel result",
        text: "Continue",
        disabled: true,
      };
    case "wheel-none":
      return {
        dataMode: "none",
        action: "none",
        visualToken: "none",
        ariaLabel: "Primal Wheel controls unavailable",
        text: "Continue",
        disabled: true,
      };
  }
}
const FEATURE_PREVIEW_PREFERENCE_KEY = "primal-rampage.feature-preview.dismissed.v1";
const PRIMAL_REFERENCE_ROOT = publicAssetUrl("assets/primal-reference");
const POWERED_BY_GM_GO = publicAssetUrl("assets/brand/powered-by-gm-go.png");
const STATUSBAR_GM_GO = publicAssetUrl("assets/brand/statusbar-gm-go.png");

function officialHelpArtworkMarkup(
  artwork: readonly { readonly asset: string; readonly alt: string }[],
): string {
  if (artwork.length === 0) return "";
  return `
    <div class="official-help__artwork" aria-label="Feature artwork">
      ${artwork.map(({ asset, alt }) => `
        <img src="${PRIMAL_REFERENCE_ROOT}/${asset}" alt="${alt}" />
      `).join("")}
    </div>
  `;
}

function officialHelpSectionsMarkup(): string {
  const features = PRIMAL_HELP_SECTIONS.map((section) => `
    <article
      class="official-help__section official-help__section--${section.id}"
      data-help-section="${section.id}"
      aria-labelledby="official-help-${section.id}"
    >
      <h4 id="official-help-${section.id}">${section.title}</h4>
      ${section.id === "wild" ? `
        <div class="wild-paytable" aria-label="Wild multiplier artwork">
          ${PAYTABLE_WILD_ENTRIES.map(({ label, asset }) => `
            <figure class="wild-paytable__item">
              <img src="${PRIMAL_REFERENCE_ROOT}/${asset}" alt="${label} wild symbol" />
              <figcaption>${label}</figcaption>
            </figure>
          `).join("")}
        </div>
      ` : officialHelpArtworkMarkup(section.artwork)}
      <div class="official-help__copy">
        ${section.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}
      </div>
    </article>
  `).join("");

  return `
    ${features}
    <section
      class="base-paytable official-help__section official-help__section--paying-symbols"
      data-help-section="paying-symbols"
      aria-labelledby="base-paytable-title"
    >
      <h4 id="base-paytable-title">PAYING SYMBOLS</h4>
      <div class="base-paytable__grid">
        ${BASE_PAYTABLE_ENTRIES.map(({ label, multiplier, asset }) => `
          <figure class="base-paytable__item">
            <img src="${PRIMAL_REFERENCE_ROOT}/${asset}" alt="${label} symbol" />
            <figcaption><strong>${label}</strong><span>${multiplier}× total bet</span></figcaption>
          </figure>
        `).join("")}
      </div>
    </section>
    <article
      class="official-help__section official-help__section--way-wins"
      data-help-section="way-wins"
      aria-labelledby="official-help-way-wins"
    >
      <h4 id="official-help-way-wins">WAY WINS</h4>
      <div class="official-help__copy"><p>${PRIMAL_WAY_WINS_COPY}</p></div>
    </article>
  `;
}

/**
 * 将抓取到的原版 1600×900 闪光灯坐标按 0.8 比例投影到本项目 1280×720 舞台。
 */
export const PRIMAL_DESKTOP_UI_GEOMETRY = Object.freeze({
  stageScale: 0.8,
  statusbar: Object.freeze({
    sourceHeight: 30,
    height: 24,
    sourceFontSize: 18,
    fontSize: 14.4,
    gameNameSourceFontSize: 16,
    gameNameFontSize: 8,
    atlasWidth: 1_865,
    atlasHeight: 60,
  }),
  infoLine: Object.freeze({
    sourceCenterX: 808,
    sourceCenterY: 772.95,
    centerX: 646.4,
    centerY: 618.36,
    sourceWidth: 650,
    width: 520,
    sourceHeight: 40,
    height: 32,
    sourceFontSize: 30,
    fontSize: 24,
    fontFamily: "Primal Roboto Condensed",
    fontWeight: 700,
    sourceStroke: 5,
    stroke: 4,
  }),
});

const JACKPOT_TIERS = [
  { name: "GRAND", multiplier: 1_000n },
  { name: "MEGA", multiplier: 250n },
  { name: "MAJOR", multiplier: 75n },
  { name: "MINOR", multiplier: 30n },
  { name: "MINI", multiplier: 10n },
] as const;

export interface SoundControlPresentation {
  readonly state: "on" | "muted" | "unavailable";
  readonly ariaLabel: string;
  readonly ariaPressed: "true" | "false";
  readonly title: string;
  readonly disabled: boolean;
}

export function soundControlPresentation(
  muted: boolean,
  available = true,
): SoundControlPresentation {
  if (!available) {
    return {
      state: "unavailable",
      ariaLabel: "Sound unavailable",
      ariaPressed: "false",
      title: "Sound unavailable",
      disabled: true,
    };
  }
  return {
    state: muted ? "muted" : "on",
    // 切换按钮的无障碍名称保持稳定，当前状态只通过咏叹调压表达。
    ariaLabel: "Mute sound",
    ariaPressed: muted ? "true" : "false",
    title: muted ? "Sound muted" : "Sound on",
    disabled: false,
  };
}

export function spinModeDisabled(mode: SpinMode, canSpin: boolean): boolean {
  return spinControlPresentation(mode, canSpin).disabled;
}

/** 免费旋转显示累计 WIN；基础游戏只显示当前轮次中奖额。 */
export function visibleWinMinorForResult(result: Pick<SpinResult, "totalWinMinor" | "events" | "featureState">): MoneyMinor {
  if (result.featureState.mode !== "BASE" && result.featureState.freeSpinsWinMinor !== undefined) {
    return result.featureState.freeSpinsWinMinor;
  }
  const completion = result.events.find((event) => event.type === "free_spins.completed");
  return completion?.type === "free_spins.completed"
    ? completion.cumulativeWinMinor
    : result.totalWinMinor;
}

export interface RoundStatePresentation {
  readonly visualText: string;
  readonly visualSecondaryText?: string;
  readonly accessibleText: string;
  readonly variant?: "win-counting" | "win-settled" | "wheel-bonus";
}

/** 精确的 Base 自旋文本池和来自 Primal 的 GameInfoController 的订单。 */
export const PRIMAL_BASE_SPIN_MESSAGES = Object.freeze([
  "Good luck!",
  "Wild can land on reel 2.",
  "Vault Bonus can land on reel 2.",
  "Rage Symbols can land on any reel in the Base Game.",
  "Land 3 Rage Symbols to trigger the Primal Wheel!",
  "Kong Quest can only trigger from the Primal Wheel!",
  "King Spin can only trigger from the Primal Wheel!",
  "The Ape unlocks the Vault Bonus!",
] as const);

export interface PrimalSpinMessageSelection {
  readonly index: number;
  readonly text: (typeof PRIMAL_BASE_SPIN_MESSAGES)[number];
}

/** 第一个自旋是索引 0；以后的旋转是随机的，不会立即重复。 */
export function selectPrimalBaseSpinMessage(
  previousIndex: number,
  random = Math.random(),
): PrimalSpinMessageSelection {
  const prior = Number.isInteger(previousIndex)
    && previousIndex >= 0
    && previousIndex < PRIMAL_BASE_SPIN_MESSAGES.length
    ? previousIndex
    : -1;
  const normalized = Number.isFinite(random) ? Math.min(0.999_999, Math.max(0, random)) : 0;
  let index = prior === -1
    ? 0
    : Math.floor(normalized * PRIMAL_BASE_SPIN_MESSAGES.length);
  if (index === prior && PRIMAL_BASE_SPIN_MESSAGES.length > 1) {
    index = (index + 1) % PRIMAL_BASE_SPIN_MESSAGES.length;
  }
  return Object.freeze({ index, text: PRIMAL_BASE_SPIN_MESSAGES[index]! });
}

export type OrdinaryWinInformationState = "counting" | "settled";

/**
 * 将一个权威的平赢对抗值投射到中央信息线上。需要有一个正的最终总分，因此零/无胜回合永远无法制作庆祝副本。
 */
export function ordinaryWinInformationPresentation(
  state: OrdinaryWinInformationState,
  currentMinor: MoneyMinor,
  totalMinor: MoneyMinor,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): RoundStatePresentation | null {
  if (!/^(0|[1-9]\d*)$/.test(currentMinor) || !/^[1-9]\d*$/.test(totalMinor)) return null;
  if (BigInt(currentMinor) > BigInt(totalMinor)) return null;
  const visibleMinor = state === "settled" ? totalMinor : currentMinor;
  const amount = formatter.format(visibleMinor);
  if (state === "counting") {
    return {
      visualText: `WIN: ${amount}`,
      accessibleText: `WIN: ${amount}`,
      variant: "win-counting",
    };
  }
  return {
    visualText: `WIN: ${amount}`,
    visualSecondaryText: "Congratulations!",
    accessibleText: `WIN: ${amount}. Congratulations!`,
    variant: "win-settled",
  };
}

/** `IDS_MSG_CONGRATULATIONS` 位于活动的 Primal Big Win 信息线上。 */
export function bigWinCongratulationsPresentation(): RoundStatePresentation {
  return {
    visualText: "Congratulations!",
    accessibleText: "Congratulations!",
  };
}

/**
 * Master-win信息线使用完整的权威回合总数。它独立于仅 Wheel B 层板和页脚 WIN。
 */
export function wheelBonusRoundSummaryPresentation(
  totalWinMinor: MoneyMinor,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): RoundStatePresentation {
  const total = formatter.format(totalWinMinor);
  return {
    visualText: `WIN: ${total}`,
    visualSecondaryText: "Congratulations!",
    accessibleText: `WIN: ${total}. Congratulations!`,
    variant: "wheel-bonus",
  };
}

/** 主信息行显示官方无摘要 Free Spins 结果副本。 */
export function freeSpinConclusionPresentation(
  cumulativeWinMinor: MoneyMinor,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): RoundStatePresentation {
  const hasWin = /^(0|[1-9]\d*)$/.test(cumulativeWinMinor)
    && BigInt(cumulativeWinMinor) > 0n;
  return {
    visualText: hasWin
      ? "FREE SPINS CONCLUDED"
      : "NO WIN, FREE SPINS CONCLUDED",
    accessibleText: hasWin
      ? `Free Spins concluded. ${formatter.format(cumulativeWinMinor)} won.`
      : "No win. Free Spins concluded.",
  };
}

/** Base 阶段回退；明确的中奖/奖金所有者可以取代此预测。 */
export function roundStatePresentation(
  phase: GamePhase,
  featureState?: FeatureState,
  activeSpinMessage: (typeof PRIMAL_BASE_SPIN_MESSAGES)[number] = PRIMAL_BASE_SPIN_MESSAGES[0],
): RoundStatePresentation {
  const freeSpins = featureState?.freeSpinsRemaining ?? 0;
  const accessible: Record<GamePhase, string> = {
    booting: "Initializing. Preparing renderer.",
    connecting: "Connecting to the game server.",
    ready: freeSpins > 0
      ? `Ready. ${freeSpins} free spins remaining.`
      : "Ready. Press spin to begin.",
    requesting: "Waiting for the server outcome.",
    presenting: "Presenting the server result.",
    recovering: "Reconnecting and restoring the pending round.",
    failed: "Game unavailable. Please try again or follow your operator's session instructions.",
  };
  return {
    visualText: phase === "ready"
      ? "PRESS SPIN TO BEGIN"
      : phase === "failed"
        ? "SESSION UNAVAILABLE"
      : phase === "requesting" || phase === "presenting"
        ? activeSpinMessage
        : "",
    accessibleText: accessible[phase],
  };
}

/** 奖池金额是权威投注的显示预测。 */
export function jackpotValuesForBet(betMinor: MoneyMinor): MoneyMinor[] {
  if (!/^(0|[1-9]\d*)$/.test(betMinor)) return JACKPOT_TIERS.map(() => "0");
  const wager = BigInt(betMinor);
  return JACKPOT_TIERS.map(({ multiplier }) => (wager * multiplier).toString());
}

/** 下注弹出窗口故意仅公开所选值及其邻居。 */
export function betTickerWindow(
  options: readonly MoneyMinor[],
  selected: MoneyMinor,
): MoneyMinor[] {
  const selectedIndex = options.indexOf(selected);
  if (selectedIndex < 0) return [];
  return options.slice(Math.max(0, selectedIndex - 1), selectedIndex + 2);
}

function eventTitle(
  event: FeatureEvent,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): string {
  switch (event.type) {
    case "surge.collected":
      if (event.guaranteed) return `Core lock · ${event.count}/3 · wheel guaranteed`;
      return event.triggered
        ? `Core lock · ${event.count}/3 · wheel ready`
        : `Core absorbed · ${event.count}/3`;
    case "rage.transformed":
      return `Rage cascade · +${event.count}`;
    case "wheel.started":
      return "Primal Wheel";
    case "wheel.awarded":
      return `Wheel · ${event.outcome}`;
    case "free_spins.started":
      return `${event.mode} · ${event.awarded} free spins`;
    case "grid.expanded":
      return `Grid expanded · ${event.rows} rows / ${event.ways} ways`;
    case "vault.awarded":
      return `Vault unlocked · ×${event.multiplier}`;
    case "free_spin.awarded":
      return `Extra free spins · +${event.count}`;
    case "vault.upgraded":
      return `Vault upgraded · ×${event.toMultiplier}`;
    case "vaults.landed":
      return `${event.count} vault${event.count === 1 ? "" : "s"} landed`;
    case "vaults.locked":
      return "Vaults remain locked";
    case "vaults.unlock.started":
      return "Vault unlock started";
    case "vault.unlocked":
      return `Vault revealed · ${event.prize}`;
    case "vaults.unlock.completed":
      return "Vault unlock complete";
    case "vaults.upgrade.started":
      return `King upgrade · step ${event.step}`;
    case "free_spin.cap_reached":
      return "Free Spin limit reached";
    case "free_spins.completed":
      return `${event.mode} complete · ${formatter.format(event.cumulativeWinMinor)} won`;
  }
}

export class DomOverlay {
  private readonly panelLifecycle = new UiPanelLifecycle();
  private readonly host: HTMLElement;
  private readonly balance: HTMLElement;
  private readonly bet: HTMLSelectElement;
  private readonly betStatus: HTMLElement;
  private readonly lastWin: HTMLElement;
  private readonly betTrigger: HTMLButtonElement;
  private readonly betTriggerValue: HTMLElement;
  private readonly betPopup: HTMLElement;
  private readonly betScrim: HTMLElement;
  private readonly betChoices: HTMLElement;
  private readonly betDecrease: HTMLButtonElement;
  private readonly betIncrease: HTMLButtonElement;
  private readonly betClose: HTMLButtonElement;
  private readonly messageTitle: HTMLElement;
  private readonly messageSubtitle: HTMLElement;
  private readonly messageDetail: HTMLElement;
  private readonly roundState: HTMLElement;
  private readonly spin: HTMLButtonElement;
  private readonly spinText: HTMLElement;
  private readonly spinAutoplayCount: HTMLElement;
  private readonly wheelHyperspinEffect: WheelHyperspinEffect;
  private readonly connection: HTMLElement;
  private readonly connectionLabel: HTMLElement;
  private readonly feature: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly brand: HTMLElement;
  private readonly statusPanel: HTMLElement;
  private readonly energyLadder: HTMLElement;
  private readonly spinDock: HTMLElement;
  private readonly toolStrip: HTMLElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly autoplayButton: HTMLButtonElement;
  private readonly paytableButton: HTMLButtonElement;
  private readonly sound: HTMLButtonElement;
  private readonly gameMenu: HTMLElement;
  private readonly gameMenuClose: HTMLButtonElement;
  private readonly gameMenuTabs: readonly HTMLButtonElement[];
  private readonly gameMenuPanels: readonly HTMLElement[];
  private readonly settingSwitches: readonly HTMLButtonElement[];
  private readonly settingsSoundSwitch: HTMLButtonElement;
  private readonly autoplayScrim: HTMLElement;
  private readonly autoplayModal: HTMLElement;
  private readonly autoplayClose: HTMLButtonElement;
  private readonly autoplayOptions: HTMLElement;
  private readonly autoplayStopToggle: HTMLButtonElement;
  private readonly autoplayStopConditions: HTMLElement;
  private readonly autoplayStopInputs: readonly HTMLInputElement[];
  private readonly autoplayStatus: HTMLElement;
  private readonly autoplayAction: HTMLButtonElement;
  private readonly skip: HTMLButtonElement;
  private readonly featurePreview: HTMLElement;
  private readonly featurePreviewCanvas: HTMLElement;
  private readonly previewContinue: HTMLButtonElement;
  private readonly previewSound: HTMLButtonElement;
  private readonly previewOptOut: HTMLInputElement;
  private readonly loading: HTMLElement;
  private readonly loadingBar: HTMLElement;
  private readonly loadingStatus: HTMLElement;
  private readonly loadingValue: HTMLElement;
  private readonly hudElements: readonly HTMLElement[];
  /** 交互式 HUD 区域在打开的对话框后面必须不可用。 */
  private readonly modalBackground: readonly HTMLElement[];
  /** 与当前 sessionId 一起锁定；同一会话不得热切换金额解释。 */
  private moneySessionId: string | null = null;
  private moneyFormatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER;
  /** 首次观察到的玩法表现绑定保持冻结；同会话任何字段漂移都会关闭固定文案。 */
  private presentationRulesBinding: Readonly<PresentationRulesBindingResult> | null = null;
  private betOptions: MoneyMinor[] = [];
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private winCounterAnimation: {
    handle: number | null;
    resolve: () => void;
    totalMinor: MoneyMinor;
  } | null = null;
  private restoreSpinFocus = false;
  private canSpin = false;
  private canChangeBet = false;
  private hudInteractive = false;
  private spinMode: SpinMode = "waiting";
  private activeMenuTab: GameMenuTab = "settings";
  private autoplayCount = DEFAULT_AUTO_PLAY_SPINS;
  private autoplayRemaining = 0;
  private autoplayActive = false;
  /**
   * 一次可能会发出一个付费 Base 请求。  计数器立即投影到 ROUNDSTART，但在权威结果通过 AppController 验证之前保持可逆。
   */
  private autoplayRunGeneration = 0;
  private pendingPaidAutoplaySpin: PendingPaidAutoplaySpin | null = null;
  private autoplayStopSettings = loadAutoPlayStopSettings();
  private armedAutoplayStopRound: ArmedAutoPlayStopRound | null = null;
  private autoplayStopSessionId = "";
  private completedAutoplayStopSequence = -1;
  private stoppedAutoplayStopSequence: number | null = null;
  /** EXPANSION/OVERDRIVE 中为 False，因此它们的服务器驱动调度程序是唯一的。 */
  private autoplayPaidSpinEligible = false;
  private autoplayTimer: ReturnType<typeof setTimeout> | null = null;
  private menuReturnFocus: HTMLElement | null = null;
  private autoplayReturnFocus: HTMLElement | null = null;
  private betReturnFocus: HTMLElement | null = null;
  private fastPlay = false;
  private autoAdjustBet = true;
  private spacebarToSpin = false;
  private featurePreviewEnabled = false;
  private featurePreviewPending = false;
  private currentRoundPhase: GamePhase = "booting";
  private currentRoundFeatureState: FeatureState | undefined;
  private heldWheelBonusRoundState: RoundStatePresentation | null = null;
  private heldOrdinaryWinRoundState: RoundStatePresentation | null = null;
  private resultPresentationSuppressesSpinCopy = false;
  private lastSpinTextIndex = -1;
  private activeSpinMessage: (typeof PRIMAL_BASE_SPIN_MESSAGES)[number] = PRIMAL_BASE_SPIN_MESSAGES[0];
  private nextSpinMessageCaptureOverride: (typeof PRIMAL_BASE_SPIN_MESSAGES)[number] | null = null;
  private spinHandler: SpinHandler = () => undefined;
  private fastStopHandler: FastStopHandler = () => undefined;
  private betHandler: BetHandler = () => undefined;
  private skipHandler: SkipHandler = () => undefined;
  private previewContinueHandler: PreviewContinueHandler = () => undefined;
  private soundToggleHandler: SoundToggleHandler = () => undefined;
  private fastPlayHandler: FastPlayHandler = () => undefined;

  constructor(host: HTMLElement) {
    this.host = host;
    host.innerHTML = `
      <div class="launch-loading" data-role="launch-loading" aria-live="polite">
        <div class="launch-loading__mark" aria-hidden="true">
          <img src="${POWERED_BY_GM_GO}" alt="" />
        </div>
        <span class="launch-loading__brand">Powered by G'm GO</span>
        <span class="launch-loading__status" data-role="loading-status">Loading game resources</span>
        <div class="launch-loading__track"><b data-role="loading-bar"></b></div>
        <span class="launch-loading__value" data-role="loading-value">0%</span>
      </div>

      <section
        class="feature-preview"
        data-role="feature-preview"
        data-visible="false"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feature-preview-title"
        aria-hidden="true"
      >
        <div class="feature-preview__city" aria-hidden="true"></div>
        <div class="feature-preview__shade" aria-hidden="true"></div>
        <div class="feature-preview__authored" data-role="preview-authored" aria-hidden="true"></div>
        <img
          class="feature-preview__logo"
          src="${PRIMAL_REFERENCE_ROOT}/primal-rampage-logo.png"
          alt="Primal Rampage"
        />
        <div class="feature-preview__content">
          <h1 id="feature-preview-title">Primal Rampage features</h1>
          <div class="feature-preview__features">
            <article class="feature-card feature-card--wheel">
              <strong class="feature-card__title" data-title="Primal Wheel"><span>Primal Wheel</span></strong>
              <div class="feature-card__art">
                <img src="${PRIMAL_REFERENCE_ROOT}/10026.png" alt="Primal Wheel" />
              </div>
              <div class="feature-card__copy">
                <span>Spin the wheel and win<br />big!</span>
              </div>
            </article>
            <i class="feature-preview__divider" aria-hidden="true"></i>
            <article class="feature-card feature-card--reels">
              <strong class="feature-card__title" data-title="Expanding Reels"><span>Expanding Reels</span></strong>
              <div class="feature-card__art">
                <img src="${PRIMAL_REFERENCE_ROOT}/10025.png" alt="Expanded slot reels" />
              </div>
              <div class="feature-card__copy">
                <span>Conquer the reels in<br />Expanding Free Spins!</span>
              </div>
            </article>
          </div>
          <button class="feature-preview__continue" data-role="preview-continue" type="button">
            <span>Continue</span>
          </button>
          <label class="feature-preview__opt-out">
            <input data-role="preview-opt-out" type="checkbox" />
            <i aria-hidden="true"></i>
            <span>Don't show again</span>
          </label>
          <button
            class="feature-preview__sound"
            data-role="preview-sound"
            type="button"
            aria-label="Mute sound"
            aria-pressed="false"
          ><img src="${PRIMAL_REFERENCE_ROOT}/10009.svg" alt="" aria-hidden="true" /></button>
          <img
            class="launcher-powered-by"
            src="${POWERED_BY_GM_GO}"
            alt="Powered by G'm GO"
            role="img"
            aria-label="Powered by G'm GO"
          />
        </div>
      </section>

      <!-- 保留为空操作的 HUD 显示挂点；基础游戏的可见标志由 Pixi 合成中的
           logo_game Spine 视图负责渲染。 -->
      <div class="brand" hidden aria-hidden="true"></div>

      <div class="connection" data-tone="connecting" aria-live="polite">
        <span class="connection__light" aria-hidden="true"></span>
        <span data-role="connection-label">Linking</span>
      </div>
      <!-- 语义化功能播报仍供辅助技术读取；参考实现会在预设的画布 HUD 中渲染此状态，
           因此不再重复显示诊断标签。 -->
      <div class="feature-pill visually-hidden" data-visible="false" data-role="feature" aria-live="polite"></div>
      <div class="toast" data-visible="false" data-role="toast" role="alert"></div>

      <aside class="jackpot-tower" data-role="jackpot-tower" aria-label="Primal Wheel prize pools">
        <span class="jackpot-tower__caption">Primal prizes</span>
        <ol class="jackpot-tower__levels">
          ${JACKPOT_TIERS.map(({ name }) => `
            <li data-tier="${name.toLowerCase()}">
              <span>${name}</span>
              <strong data-role="jackpot-value">—</strong>
            </li>
          `).join("")}
        </ol>
      </aside>

      <button class="intro-skip" data-role="intro-skip" type="button" hidden>
        Skip intro <span>Esc</span>
      </button>

      <div class="round-state" data-visible="false" aria-live="polite">
        <span class="round-state__title" data-role="message-title" aria-hidden="true"></span>
        <span class="round-state__subtitle" data-role="message-subtitle" aria-hidden="true"></span>
        <span class="round-state__detail" data-role="message-detail">Initializing. Preparing renderer.</span>
      </div>

      <section
        class="game-menu"
        data-role="game-menu"
        data-open="false"
        data-presentation-rules-status="missing-binding"
        data-presentation-rules-version="${PRIMAL_PRESENTATION_RULES.version}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-menu-title"
        aria-hidden="true"
      >
        <h2 id="game-menu-title" class="visually-hidden">Game menu</h2>
        <nav class="game-menu__tabs" role="tablist" aria-label="Game menu sections">
          <button
            class="game-menu__tab is-active"
            data-menu-tab="settings"
            type="button"
            role="tab"
            aria-selected="true"
            aria-controls="game-menu-settings"
          >Settings</button>
          <button
            class="game-menu__tab"
            data-menu-tab="paytable"
            type="button"
            role="tab"
            aria-selected="false"
            aria-controls="game-menu-paytable"
            tabindex="-1"
          >Paytable</button>
          <button
            class="game-menu__tab"
            data-menu-tab="rules"
            type="button"
            role="tab"
            aria-selected="false"
            aria-controls="game-menu-rules"
            tabindex="-1"
          >Game rules</button>
        </nav>
        <button class="game-menu__close" data-role="game-menu-close" type="button" aria-label="Close game menu">×</button>
        <div class="game-menu__content">
          <section
            class="game-menu__panel"
            id="game-menu-settings"
            data-menu-panel="settings"
            role="tabpanel"
            aria-label="Settings"
          >
            <p class="game-menu__eyebrow">Game play</p>
            <h3>Settings</h3>
            <div class="settings-list">
              <button class="setting-row" data-setting="fast-play" type="button" role="switch" aria-checked="false">
                <svg class="setting-row__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13.5 2 4.5 13.5h7L10.5 22l9-12h-7L13.5 2Z" /></svg>
                <span><strong>Fast play</strong><small>Use shorter pauses between presentation-only auto spins.</small></span><i aria-hidden="true"></i>
              </button>
              <button class="setting-row" data-setting="auto-adjust-bet" type="button" role="switch" aria-checked="true">
                <svg class="setting-row__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><ellipse cx="9" cy="6" rx="5.5" ry="2.5" /><path d="M3.5 6v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V6M3.5 10v4c0 1.4 2.5 2.5 5.5 2.5 1.1 0 2.1-.1 3-.4M18.5 13v7M15 16.5h7" /></svg>
                <span><strong>Auto adjust bet</strong><small>Local preference only; server-supplied bet options stay authoritative.</small></span><i aria-hidden="true"></i>
              </button>
              <button class="setting-row" data-setting="spacebar" type="button" role="switch" aria-checked="false">
                <svg class="setting-row__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.2 5.8A8 8 0 0 1 19.5 10M19.5 10V5.5M19.5 10H15M17.8 18.2A8 8 0 0 1 4.5 14M4.5 14v4.5M4.5 14H9" /></svg>
                <span><strong>Spacebar to spin</strong><small>Press Space while the base game is ready.</small></span><i aria-hidden="true"></i>
              </button>
              <p class="settings-audio-label">Audio</p>
              <button class="setting-row" data-setting="sound" data-role="settings-sound" type="button" role="switch" aria-checked="true">
                <svg class="setting-row__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 10v4h4l5 4V6l-5 4H4Z" /><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></svg>
                <span><strong>Sound</strong><small>Use the same audio state as the bottom sound control.</small></span><i aria-hidden="true"></i>
              </button>
            </div>
          </section>
          <section
            class="game-menu__panel"
            id="game-menu-paytable"
            data-menu-panel="paytable"
            role="tabpanel"
            aria-label="Paytable"
            hidden
          >
            <p class="game-menu__eyebrow">Official feature guide</p>
            <h3>Primal Rampage</h3>
            <div
              class="official-help"
              data-role="presentation-rules-content"
              data-presentation-rules-version="${PRIMAL_PRESENTATION_RULES.version}"
              hidden
            >
              ${officialHelpSectionsMarkup()}
              <p class="presentation-rules-meta">
                ${PRIMAL_PRESENTATION_RULES.version} · exact session definition binding required
              </p>
            </div>
            <div class="presentation-rules-unavailable" data-role="presentation-rules-unavailable">
              <strong>Feature guide unavailable</strong>
              <p>This fixed guide is shown only for a session definition explicitly approved by this client build.</p>
            </div>
          </section>
          <section
            class="game-menu__panel"
            id="game-menu-rules"
            data-menu-panel="rules"
            role="tabpanel"
            aria-label="Game rules"
            hidden
          >
            <p class="game-menu__eyebrow">Session-bound presentation</p>
            <h3>Game rules</h3>
            <div class="rules-card" data-role="presentation-rules-summary" hidden>
              <p>Round outcomes, balances, available bets and feature events are supplied by the authoritative RGS and validated before presentation.</p>
              <p>This feature guide is fixed to ${PRIMAL_PRESENTATION_RULES.version} and is enabled only when the game, definition version and complete SHA-256 identity match its explicit allow-list.</p>
              <p>A changed mathematical definition requires a reviewed presentationRules revision; this client never assumes that another definition is compatible.</p>
              <p>Use Spin to request a round. The menu presents rules but never creates or changes an outcome.</p>
            </div>
            <div class="rules-card presentation-rules-unavailable" data-role="presentation-rules-unavailable-rules">
              <strong>Game rules unavailable</strong>
              <p>The current session has not matched this client build's fixed presentationRules identity.</p>
            </div>
          </section>
        </div>
      </section>

      <style data-role="autoplay-stop-condition-style">
        .autoplay-modal .autoplay-stop-rule {
          display: grid;
          gap: 0;
          margin-top: 30px;
          color: #fff;
          font-size: 12.8px;
          font-weight: 400;
          letter-spacing: 0;
          text-transform: none;
        }
        .autoplay-modal .autoplay-stop-toggle {
          display: flex;
          width: 100%;
          min-height: 25.6px;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 0;
          border: 0;
          color: inherit;
          background: transparent;
          cursor: pointer;
          font: inherit;
          text-align: left;
        }
        .autoplay-modal .autoplay-stop-toggle__chevron {
          position: relative;
          width: 25.6px;
          height: 25.6px;
          flex: 0 0 25.6px;
          border-radius: 5px;
          background: #292a2a;
        }
        .autoplay-modal .autoplay-stop-toggle__chevron::after {
          position: absolute;
          left: 50%;
          top: 47%;
          width: 7px;
          height: 7px;
          content: "";
          transform: translate(-50%, -65%) rotate(45deg);
          border-right: 1.6px solid #fff;
          border-bottom: 1.6px solid #fff;
          transition: transform 150ms ease;
        }
        .autoplay-modal .autoplay-stop-toggle[aria-expanded="true"] .autoplay-stop-toggle__chevron::after {
          transform: translate(-50%, -20%) rotate(225deg);
        }
        .autoplay-modal .autoplay-stop-toggle:focus-visible {
          outline: 2px solid #c9a46f;
          outline-offset: 3px;
          border-radius: 4px;
        }
        .autoplay-modal .autoplay-stop-conditions {
          display: grid;
          gap: 1px;
          margin-top: 8px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.08);
        }
        .autoplay-modal .autoplay-stop-conditions[hidden] { display: none; }
        .autoplay-modal .autoplay-stop-condition {
          display: flex;
          min-height: 34px;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 0 10px;
          color: rgba(255, 255, 255, 0.88);
          background: #171919;
          cursor: pointer;
          font-size: 11.2px;
          line-height: 1.2;
        }
        .autoplay-modal .autoplay-stop-condition:hover { background: #202222; }
        .autoplay-modal .autoplay-stop-condition input {
          width: 18px;
          height: 18px;
          flex: 0 0 18px;
          margin: 0;
          appearance: none;
          border: 1px solid rgba(255, 255, 255, 0.38);
          border-radius: 3px;
          background: #292a2a;
          cursor: pointer;
        }
        .autoplay-modal .autoplay-stop-condition input:checked {
          border-color: #c9a46f;
          background-color: #c9a46f;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m3.2 8.2 3 3.1 6.7-7' fill='none' stroke='%23070808' stroke-width='2.1' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
          background-position: center;
          background-repeat: no-repeat;
          background-size: 13px 13px;
        }
        .autoplay-modal .autoplay-stop-condition input:focus-visible {
          outline: 2px solid #fff;
          outline-offset: 2px;
        }
        .autoplay-modal .autoplay-stop-toggle:disabled,
        .autoplay-modal .autoplay-stop-condition:has(input:disabled) {
          cursor: not-allowed;
          opacity: 0.48;
        }
        .autoplay-modal[data-stop-expanded="true"] {
          top: calc(79.4% - 69px);
        }
      </style>
      <div class="compact-modal-scrim" data-role="autoplay-scrim" data-open="false" aria-hidden="true"></div>
      <section
        class="compact-modal autoplay-modal"
        data-role="autoplay-modal"
        data-open="false"
        role="dialog"
        aria-modal="true"
        aria-labelledby="autoplay-title"
        aria-hidden="true"
      >
        <header class="compact-modal__head">
          <div><small>Spin control</small><h2 id="autoplay-title">Auto Play</h2></div>
          <button data-role="autoplay-close" type="button" aria-label="Close autoplay panel">×</button>
        </header>
        <div class="autoplay-options" data-role="autoplay-options" role="radiogroup" aria-label="Number of auto spins">
          ${AUTO_PLAY_SPIN_COUNTS.map((count) => `
            <button
              class="autoplay-option${count === DEFAULT_AUTO_PLAY_SPINS ? " is-selected" : ""}"
              type="button"
              role="radio"
              data-autoplay-count="${count}"
              aria-checked="${count === DEFAULT_AUTO_PLAY_SPINS}"
              aria-label="${count} auto spins"
              tabindex="${count === DEFAULT_AUTO_PLAY_SPINS ? 0 : -1}"
            >${count}</button>
          `).join("")}
        </div>
        <div class="autoplay-stop-rule" data-role="autoplay-stop-rule">
          <button
            class="autoplay-stop-toggle"
            data-role="autoplay-stop-toggle"
            type="button"
            aria-expanded="false"
            aria-controls="autoplay-stop-conditions"
          >
            <span>Stop autoplay</span>
            <i class="autoplay-stop-toggle__chevron" aria-hidden="true"></i>
          </button>
          <div
            class="autoplay-stop-conditions"
            id="autoplay-stop-conditions"
            data-role="autoplay-stop-conditions"
            role="group"
            aria-label="Stop autoplay conditions"
            hidden
          >
            ${AUTO_PLAY_STOP_CONDITIONS.map(({ boundary, setting, label }) => `
              <label class="autoplay-stop-condition">
                <span>${label}</span>
                <input
                  type="checkbox"
                  data-autoplay-stop-boundary="${boundary}"
                  aria-label="${label}"
                  ${this.autoplayStopSettings[setting] ? "checked" : ""}
                />
              </label>
            `).join("")}
          </div>
        </div>
        <p class="autoplay-modal__status" data-role="autoplay-status" aria-live="polite">50 spins selected</p>
        <button class="compact-modal__action" data-role="autoplay-action" type="button">Start</button>
      </section>

      <div class="bet-scrim" data-role="bet-scrim" data-open="false" aria-hidden="true"></div>
      <section
        class="bet-popover"
        data-role="bet-popup"
        data-open="false"
        role="dialog"
        aria-modal="true"
        aria-label="Select total bet"
        aria-hidden="true"
      >
        <div class="bet-popover__head">
          <span><small>Wager control</small>Bet</span>
          <button class="bet-popover__close" data-role="bet-close" type="button" aria-label="Close bet selector">×</button>
        </div>
        <div class="bet-stepper">
          <button class="bet-stepper__button" data-role="bet-decrease" type="button" aria-label="Previous bet">−</button>
          <div class="bet-choices" data-role="bet-choices" role="radiogroup" aria-label="Select total bet"></div>
          <button class="bet-stepper__button" data-role="bet-increase" type="button" aria-label="Next bet">+</button>
        </div>
        <span class="bet-popover__note">Available wagers supplied by the game server</span>
      </section>

      <nav class="utility-dock" data-role="tool-strip" aria-label="Game controls">
        <button
          class="utility-button utility-button--settings"
          data-role="settings"
          type="button"
          aria-label="Open settings"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-controls="game-menu-settings"
          title="Settings"
        >
          <span class="utility-button__hit-area" aria-hidden="true"></span>
          <img class="utility-button__asset" src="${PRIMAL_REFERENCE_ROOT}/10005.svg" alt="" aria-hidden="true" />
        </button>
        <button
          class="utility-button utility-button--auto"
          data-role="autoplay"
          type="button"
          aria-label="Open autoplay"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-controls="autoplay-panel"
          title="Auto play"
        >
          <span class="utility-button__hit-area" aria-hidden="true"></span>
          <img class="utility-button__asset" src="${PRIMAL_REFERENCE_ROOT}/10006.svg" alt="" aria-hidden="true" />
        </button>
        <button
          class="bet-trigger"
          data-role="bet-trigger"
          type="button"
          disabled
          aria-label="Change total bet"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-controls="bet-selector"
        >
          <span class="utility-button__hit-area" aria-hidden="true"></span>
          <img class="bet-trigger__icon" src="${PRIMAL_REFERENCE_ROOT}/10007.svg" alt="" aria-hidden="true" />
          <span>Total bet</span>
          <strong data-role="bet-trigger-value">—</strong>
          <i aria-hidden="true"></i>
        </button>
        <select class="bet-control--native" data-role="bet" aria-hidden="true" tabindex="-1" disabled>
          <option value="">—</option>
        </select>
        <button
          class="utility-button utility-button--paytable"
          data-role="paytable"
          type="button"
          aria-label="Open paytable"
          aria-haspopup="dialog"
          aria-expanded="false"
          aria-controls="game-menu-paytable"
          title="Paytable"
        >
          <span class="utility-button__hit-area" aria-hidden="true"></span>
          <img class="utility-button__asset" src="${PRIMAL_REFERENCE_ROOT}/10008.svg" alt="" aria-hidden="true" />
        </button>
        <button
          class="utility-button utility-button--sound"
          data-role="sound"
          data-sound-state="on"
          type="button"
          aria-label="Mute sound"
          aria-pressed="false"
          title="Sound on"
        >
          <span class="utility-button__hit-area" aria-hidden="true"></span>
          <img class="utility-button__asset" src="${PRIMAL_REFERENCE_ROOT}/10009.svg" alt="" aria-hidden="true" />
        </button>
      </nav>

      <section
        class="status-panel"
        data-zero-win="true"
        data-game-name-visible="false"
        aria-label="Round values"
      >
        <img
          class="status-panel__provider"
          src="${STATUSBAR_GM_GO}"
          alt="G'm GO"
          draggable="false"
        />
        <div class="status-metric status-metric--balance">
          <span>Balance:</span>
          <strong data-role="balance">—</strong>
        </div>
        <div class="status-metric status-metric--bet">
          <span>Bet:</span>
          <strong data-role="bet-status">—</strong>
        </div>
        <div class="status-metric status-metric--win">
          <span>Win:</span>
          <strong data-role="last-win" data-zero="true">0.00</strong>
        </div>
        <span class="status-panel__game">Primal Rampage</span>
      </section>

      <div class="spin-dock" data-role="spin-dock">
        <span
          class="spin-hyperspin-effect"
          data-role="wheel-hyperspin-effect"
          data-phase="none"
          data-frame="0"
          aria-hidden="true"
          hidden
        ></span>
        <button class="spin-button" data-role="spin" data-mode="waiting" data-action="none" data-visual-token="disabled-spin" type="button" disabled aria-label="Spin unavailable">
          <span class="spin-button__hit-area" aria-hidden="true"></span>
          <span class="spin-button__halo" aria-hidden="true">
            <img src="${PRIMAL_REFERENCE_ROOT}/10002.svg" alt="" />
          </span>
          <img class="spin-button__arrows" src="${PRIMAL_REFERENCE_ROOT}/10001.svg" alt="" aria-hidden="true" />
          <img class="spin-button__disabled" src="${PRIMAL_REFERENCE_ROOT}/spin-button-disabled.svg" alt="" aria-hidden="true" />
          <img class="spin-button__continue" src="${PRIMAL_REFERENCE_ROOT}/10003.svg" alt="" aria-hidden="true" />
          <img class="spin-button__autoplay-stop" data-role="spin-autoplay-stop" src="${PRIMAL_REFERENCE_ROOT}/10004.svg" alt="" aria-hidden="true" />
          <span class="spin-button__autoplay-count" data-role="spin-autoplay-count" aria-hidden="true"></span>
          <span class="spin-button__text" data-role="spin-text">Spin</span>
        </button>
      </div>
    `;

    this.balance = this.require(host, "balance");
    this.bet = this.require(host, "bet") as HTMLSelectElement;
    this.betStatus = this.require(host, "bet-status");
    this.lastWin = this.require(host, "last-win");
    this.betTrigger = this.require(host, "bet-trigger") as HTMLButtonElement;
    this.betTriggerValue = this.require(host, "bet-trigger-value");
    this.betPopup = this.require(host, "bet-popup");
    this.betPopup.id = "bet-selector";
    this.betPopup.inert = true;
    this.betScrim = this.require(host, "bet-scrim");
    this.betChoices = this.require(host, "bet-choices");
    this.betDecrease = this.require(host, "bet-decrease") as HTMLButtonElement;
    this.betIncrease = this.require(host, "bet-increase") as HTMLButtonElement;
    this.betClose = this.require(host, "bet-close") as HTMLButtonElement;
    this.messageTitle = this.require(host, "message-title");
    this.messageSubtitle = this.require(host, "message-subtitle");
    this.messageDetail = this.require(host, "message-detail");
    this.roundState = host.querySelector(".round-state") as HTMLElement;
    this.spin = this.require(host, "spin") as HTMLButtonElement;
    this.spinText = this.require(host, "spin-text");
    this.spinAutoplayCount = this.require(host, "spin-autoplay-count");
    this.wheelHyperspinEffect = new WheelHyperspinEffect(
      this.require(host, "wheel-hyperspin-effect"),
    );
    this.connection = host.querySelector(".connection") as HTMLElement;
    this.connectionLabel = this.require(host, "connection-label");
    this.feature = this.require(host, "feature");
    this.toast = this.require(host, "toast");
    this.brand = host.querySelector(".brand") as HTMLElement;
    this.statusPanel = host.querySelector(".status-panel") as HTMLElement;
    this.energyLadder = this.require(host, "jackpot-tower");
    this.spinDock = this.require(host, "spin-dock");
    this.toolStrip = this.require(host, "tool-strip");
    this.settingsButton = this.require(host, "settings") as HTMLButtonElement;
    this.autoplayButton = this.require(host, "autoplay") as HTMLButtonElement;
    this.paytableButton = this.require(host, "paytable") as HTMLButtonElement;
    this.sound = this.require(host, "sound") as HTMLButtonElement;
    this.gameMenu = this.require(host, "game-menu");
    this.gameMenuClose = this.require(host, "game-menu-close") as HTMLButtonElement;
    this.gameMenuTabs = [...host.querySelectorAll<HTMLButtonElement>("[data-menu-tab]")];
    this.gameMenuPanels = [...host.querySelectorAll<HTMLElement>("[data-menu-panel]")];
    this.settingSwitches = [...host.querySelectorAll<HTMLButtonElement>("[data-setting]")];
    this.settingsSoundSwitch = this.require(host, "settings-sound") as HTMLButtonElement;
    this.autoplayScrim = this.require(host, "autoplay-scrim");
    this.autoplayModal = this.require(host, "autoplay-modal");
    this.autoplayModal.id = "autoplay-panel";
    this.autoplayClose = this.require(host, "autoplay-close") as HTMLButtonElement;
    this.autoplayOptions = this.require(host, "autoplay-options");
    this.autoplayStopToggle = this.require(host, "autoplay-stop-toggle") as HTMLButtonElement;
    this.autoplayStopConditions = this.require(host, "autoplay-stop-conditions");
    this.autoplayStopInputs = [
      ...this.autoplayStopConditions.querySelectorAll<HTMLInputElement>("[data-autoplay-stop-boundary]"),
    ];
    this.autoplayStatus = this.require(host, "autoplay-status");
    this.autoplayAction = this.require(host, "autoplay-action") as HTMLButtonElement;
    this.skip = this.require(host, "intro-skip") as HTMLButtonElement;
    this.featurePreview = this.require(host, "feature-preview");
    this.featurePreviewCanvas = this.require(host, "preview-authored");
    this.previewContinue = this.require(host, "preview-continue") as HTMLButtonElement;
    this.previewSound = this.require(host, "preview-sound") as HTMLButtonElement;
    this.previewOptOut = this.require(host, "preview-opt-out") as HTMLInputElement;
    this.featurePreview.inert = true;
    this.gameMenu.inert = true;
    this.autoplayModal.inert = true;
    this.syncAutoplayStopSettings();
    this.setAutoplayStopConditionsOpen(false);
    this.syncFeaturePreviewContinue();
    this.loading = this.require(host, "launch-loading");
    this.loadingBar = this.require(host, "loading-bar");
    this.loadingStatus = this.require(host, "loading-status");
    this.loadingValue = this.require(host, "loading-value");
    this.hudElements = [
      this.brand,
      this.connection,
      this.feature,
      this.toast,
      this.energyLadder,
      this.roundState,
      this.statusPanel,
      this.spinDock,
      this.toolStrip,
    ];
    this.modalBackground = [
      this.statusPanel,
      this.spinDock,
      this.toolStrip,
    ];
    this.statusPanel.tabIndex = -1;

    this.spin.addEventListener("click", () => this.handlePrimarySpinAction());
    this.bet.addEventListener("change", () => {
      this.syncBetChoices();
      this.betHandler(this.bet.value);
    });
    this.betTrigger.addEventListener("click", () => this.setBetPopupOpen(true));
    this.betClose.addEventListener("click", () => this.setBetPopupOpen(false));
    this.betScrim.addEventListener("click", () => this.setBetPopupOpen(false));
    this.betDecrease.addEventListener("click", () => this.stepBet(-1));
    this.betIncrease.addEventListener("click", () => this.stepBet(1));
    this.betChoices.addEventListener("click", (event) => {
      const choice = (event.target as HTMLElement).closest<HTMLButtonElement>(".bet-choice");
      if (!choice || choice.disabled || !choice.dataset.value) return;
      this.selectBet(choice.dataset.value, true);
    });
    this.betChoices.addEventListener("keydown", this.handleBetChoiceKeyDown);
    this.settingsButton.addEventListener("click", () => this.setGameMenuOpen(true, "settings"));
    this.paytableButton.addEventListener("click", () => this.setGameMenuOpen(true, "paytable"));
    this.gameMenuClose.addEventListener("click", () => this.setGameMenuOpen(false));
    this.gameMenu.addEventListener("click", this.handleGameMenuClick);
    this.gameMenu.addEventListener("keydown", this.handleGameMenuKeyDown);
    this.autoplayButton.addEventListener("click", () => this.setAutoplayModalOpen(true));
    this.autoplayClose.addEventListener("click", () => this.setAutoplayModalOpen(false));
    this.autoplayScrim.addEventListener("click", () => this.setAutoplayModalOpen(false));
    this.autoplayOptions.addEventListener("click", this.handleAutoplayOptionClick);
    this.autoplayOptions.addEventListener("keydown", this.handleAutoplayOptionKeyDown);
    this.autoplayStopToggle.addEventListener("click", this.handleAutoplayStopToggle);
    this.autoplayStopConditions.addEventListener("change", this.handleAutoplayStopConditionChange);
    this.autoplayAction.addEventListener("click", () => {
      if (this.autoplayActive) this.stopAutoplay(true);
      else this.startAutoplay();
    });
    this.sound.addEventListener("click", () => this.soundToggleHandler());
    this.previewSound.addEventListener("click", () => this.soundToggleHandler());
    this.skip.addEventListener("click", () => {
      this.restoreSpinFocus = document.activeElement === this.skip;
      this.skipHandler();
    });
    this.previewContinue.addEventListener("click", () => {
      if (this.featurePreview.dataset.visible !== "true") return;
      if (this.previewContinue.disabled) return;
      if (this.previewOptOut.checked) {
        try {
          localStorage.setItem(FEATURE_PREVIEW_PREFERENCE_KEY, "1");
        } catch {
          // 存储限制永远不会阻止启动。
        }
      }
      this.previewContinueHandler();
    });
    document.addEventListener("keydown", this.handleKeyDown);
    this.setHudReveal(0);
  }

  onSpin(handler: SpinHandler): void {
    this.spinHandler = handler;
  }

  /** 可选展示挂钩；权威结算仍然在DOM HUD之外。 */
  onFastStop(handler: FastStopHandler): void {
    this.fastStopHandler = handler;
  }

  onBet(handler: BetHandler): void {
    this.betHandler = handler;
  }

  onSkip(handler: SkipHandler): void {
    this.skipHandler = handler;
  }

  onPreviewContinue(handler: PreviewContinueHandler): void {
    this.previewContinueHandler = handler;
  }

  onSoundToggle(handler: SoundToggleHandler): void {
    this.soundToggleHandler = handler;
  }

  onFastPlayChange(handler: FastPlayHandler): void {
    this.fastPlayHandler = handler;
  }

  onPanelOpen(handler: UiPanelHandler): void {
    this.panelLifecycle.onOpen(handler);
  }

  onPanelClose(handler: UiPanelHandler): void {
    this.panelLifecycle.onClose(handler);
  }

  setSoundState(muted: boolean, available = true): void {
    const presentation = soundControlPresentation(muted, available);
    for (const control of [this.sound, this.previewSound]) {
      control.dataset.soundState = presentation.state;
      control.setAttribute("aria-label", presentation.ariaLabel);
      control.setAttribute("aria-pressed", presentation.ariaPressed);
      control.title = presentation.title;
      control.disabled = presentation.disabled;
    }
    this.settingsSoundSwitch.setAttribute("aria-checked", String(available && !muted));
    this.settingsSoundSwitch.disabled = !available;
    this.settingsSoundSwitch.dataset.state = presentation.state;
  }

  isFeaturePreviewDismissed(): boolean {
    try {
      return localStorage.getItem(FEATURE_PREVIEW_PREFERENCE_KEY) === "1";
    } catch {
      return false;
    }
  }

  getAutoplayStopSettings(): AutoPlayStopSettings {
    return { ...this.autoplayStopSettings };
  }

  /** 更新四个捕获的复选框；浏览器持久性是尽力而为的。 */
  setAutoplayStopSettings(settings: AutoPlayStopSettings, persist = true): void {
    this.autoplayStopSettings = normalizeAutoPlayStopSettings(settings);
    this.syncAutoplayStopSettings();
    if (persist) persistAutoPlayStopSettings(this.autoplayStopSettings);
  }

  /**
   * 在结果解码期间不间断地提供一个权威结果。返回的服务器序列是同一轮稍后的表示边界使用的幂等性令牌。
   */
  armAutoplayStopRound(result: SpinResult): number {
    if (this.autoplayStopSessionId !== result.sessionId) {
      this.resetAutoplayStopSession(result.sessionId);
    }
    const sequence = result.sequence;
    if (this.armedAutoplayStopRound?.sequence === sequence) return sequence;
    if (sequence <= this.completedAutoplayStopSequence) return sequence;
    this.armedAutoplayStopRound = {
      sequence,
      anyWinEligible: /^(0|[1-9]\d*)$/.test(result.totalWinMinor)
        && BigInt(result.totalWinMinor) > 0n,
      settings: { ...this.autoplayStopSettings },
      reached: new Set<AutoPlayStopBoundary>(),
      stopRequested: false,
    };
    this.stoppedAutoplayStopSequence = null;
    return sequence;
  }

  /**
   * 仅一次到达预设的停止边界。过时的序列无法停止较新的自动游戏运行，并且 `any-win` 会被忽略以获得零胜结果。
   */
  reachAutoplayStopBoundary(sequence: number, boundary: AutoPlayStopBoundary): boolean {
    const round = this.armedAutoplayStopRound;
    if (!round || round.sequence !== sequence) {
      return this.stoppedAutoplayStopSequence === sequence;
    }
    if (boundary === "any-win" && !round.anyWinEligible) return false;
    if (round.reached.has(boundary)) return round.stopRequested;
    round.reached.add(boundary);
    // 多个官方条件可以描述相同的结果（例如，INSTANT Wheel 奖励同时是奖金、累积奖金和中奖）。第一个匹配边界拥有一站；随后的边界仍然可观察，但无法再次调用停止路径。
    if (round.stopRequested) return true;
    if (!isAutoPlayStopBoundaryEnabled(round.settings, boundary)) {
      return round.stopRequested;
    }
    round.stopRequested = true;
    this.stoppedAutoplayStopSequence = sequence;
    if (this.autoplayActive) this.stopAutoplay(false);
    return true;
  }

  /**
   * 退役武装令牌。作为安全网，未达到的正赢令牌在此评估为 `any-win`；正常的编排在 Win Start 时就达到了。
   */
  completeAutoplayStopRound(sequence = this.armedAutoplayStopRound?.sequence): boolean {
    if (sequence === undefined) return false;
    const round = this.armedAutoplayStopRound;
    if (!round || round.sequence !== sequence) {
      return this.stoppedAutoplayStopSequence === sequence;
    }
    if (round.anyWinEligible && !round.reached.has("any-win")) {
      this.reachAutoplayStopBoundary(sequence, "any-win");
    }
    const stopped = round.stopRequested;
    this.completedAutoplayStopSequence = Math.max(this.completedAutoplayStopSequence, sequence);
    this.armedAutoplayStopRound = null;
    return stopped;
  }

  /**
   * 仅拥有主控件的呈现状态。当解码的服务器结果呈现动画时，`fast-stop` 保持启用状态；它永远不会更改结果本身，并将取消委托给注册的处理程序。
   */
  setSpinMode(mode: SpinMode): void {
    this.spinMode = mode;
    this.syncWheelHyperspinEffect();
    this.syncAutoplayControl();
    this.queueAutoplaySpin();
  }

  /** AppController对于`ready`是否意味着付费Base旋转具有权威性。 */
  setAutoplayPaidSpinEligible(eligible: boolean): void {
    if (this.autoplayPaidSpinEligible === eligible) return;
    this.autoplayPaidSpinEligible = eligible;
    if (!eligible && this.spinMode === "ready") this.clearAutoplayTimer();
    this.queueAutoplaySpin();
  }

  /** 仅在网关接受外部付费 Base 轮后才提交。 */
  commitAcceptedPaidAutoplaySpin(): void {
    // 网关/卷轴护罩仅允许一轮进行中付费。将重复提交视为相同的 ROUNDSTART 而不是花费两次。
    if (this.pendingPaidAutoplaySpin != null) return;
    const previous: AutoPlayRunState = {
      active: this.autoplayActive,
      remaining: this.autoplayRemaining,
    };
    const advance = advanceAutoPlay({
      active: previous.active,
      remaining: previous.remaining,
    }, true);
    if (!advance.dispatchSpin) return;
    this.pendingPaidAutoplaySpin = {
      generation: this.autoplayRunGeneration,
      previous,
    };
    this.autoplayActive = advance.state.active;
    this.autoplayRemaining = advance.state.remaining;
    this.syncAutoplayControl();
  }

  /** 结果验证后，使可见的 ROUNDSTART 减量永久化。 */
  finalizeAcceptedPaidAutoplaySpin(): boolean {
    if (this.pendingPaidAutoplaySpin == null) return false;
    this.pendingPaidAutoplaySpin = null;
    return true;
  }

  /**
   * 将被拒绝/格式错误的已派奖 Base ROUNDSTART 恢复一次。用户停止会更改生成并清除预留，因此故障恢复永远不会意外地重新启动播放器取消的运行。
   */
  rollbackAcceptedPaidAutoplaySpin(): boolean {
    const pending = this.pendingPaidAutoplaySpin;
    this.pendingPaidAutoplaySpin = null;
    if (pending == null || pending.generation !== this.autoplayRunGeneration) return false;
    this.autoplayActive = pending.previous.active;
    this.autoplayRemaining = pending.previous.remaining;
    this.syncAutoplayControl();
    return true;
  }

  /** 向后兼容的视觉速记，适用于仅需要两种状态的调用者。 */
  setFastStopMode(active: boolean): void {
    this.setSpinMode(active ? "fast-stop" : (this.canSpin ? "ready" : "waiting"));
  }

  /**
   * 捕获的桌面启动序列在内部仍然是可跳过的，但它不会公开可见的“跳过介绍/退出”功能。  在此保持选择加入，以便将来明确预设的过渡可以请求过渡，而不会使常规游戏启动偏离参考。
   */
  setLaunchPhase(phase: LaunchPhase, canSkip = false): void {
    this.host.dataset.launch = phase;
    const loadingVisible = phase === "boot" || phase === "preloading";
    const hudAccessible = phase === "waiting-session" || phase === "ready" || phase === "failed";
    this.hudInteractive = hudAccessible;
    this.loading.dataset.visible = loadingVisible ? "true" : "false";
    this.loading.setAttribute("aria-hidden", String(!loadingVisible));
    for (const element of this.hudElements) {
      if (hudAccessible) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", "true");
    }
    if (!hudAccessible) {
      this.setBetPopupOpen(false, false);
      this.setAutoplayModalOpen(false, false);
      this.setGameMenuOpen(false, this.activeMenuTab, false);
      this.stopAutoplay(false);
    }
    this.syncModalBackgroundInert();
    const skipHadFocus = document.activeElement === this.skip;
    this.skip.hidden = !canSkip;
    if (skipHadFocus && !canSkip) {
      this.restoreSpinFocus = true;
      this.statusPanel.focus();
    }
    if (phase === "boot" || phase === "preloading") this.setHudReveal(0);
  }

  /**
   * 将一个实时加载表面传输给视口空间所有者。在响应式布局开始之前，渲染器框架固定在 1280x720，因此其内部的加载器将在第一个移动框架上离开屏幕。
   */
  mountLaunchLoading(host: HTMLElement): void {
    if (this.loading.parentElement === host && host.childElementCount === 1) return;
    host.replaceChildren(this.loading);
  }

  setLoadProgress(completed: number, total: number): void {
    const progress = total === 0 ? 1 : Math.max(0, Math.min(1, completed / total));
    const percentage = Math.round(progress * 100);
    this.loadingBar.style.transform = `scaleX(${progress})`;
    this.loadingValue.textContent = `${percentage}%`;
  }

  setStartupProgress(event: Readonly<PreloadProgress>): void {
    const progress = Math.max(0, Math.min(1, event.progress));
    const percentage = event.status === "complete"
      ? 100
      : Math.min(99, Math.round(progress * 100));
    this.loadingBar.style.transform = `scaleX(${progress})`;
    this.loadingValue.textContent = `${percentage}%`;
    this.loadingStatus.textContent = startupStageLabel(event.stage);
    this.loading.dataset.stage = event.stage;
    if (event.taskName) this.loading.dataset.task = event.taskName;
    else delete this.loading.dataset.task;
    this.host.dataset.launchStage = event.stage;
    this.host.dataset.launchProgress = progress.toFixed(6);
  }

  setFeaturePreviewVisible(visible: boolean): void {
    this.featurePreview.dataset.visible = String(visible);
    this.featurePreview.setAttribute("aria-hidden", String(!visible));
    this.featurePreview.inert = !visible;
    this.syncModalBackgroundInert();
    if (visible) queueMicrotask(() => this.previewContinue.focus());
    else if (document.activeElement === this.previewContinue) this.previewContinue.blur();
  }

  setFeaturePreviewPending(pending: boolean): void {
    this.featurePreviewPending = pending;
    this.previewContinue.setAttribute("aria-busy", String(pending));
    this.featurePreview.dataset.pending = String(pending);
    this.syncFeaturePreviewContinue();
  }

  /** 会话就绪和瞬时 Continue 工作是独立的门。 */
  setFeaturePreviewEnabled(enabled: boolean): void {
    this.featurePreviewEnabled = enabled;
    this.syncFeaturePreviewContinue();
  }

  getFeaturePreviewCanvasHost(): HTMLElement {
    return this.featurePreviewCanvas;
  }

  setFeaturePreviewAuthored(active: boolean): void {
    this.featurePreview.dataset.authored = String(active);
  }

  setHudReveal(progress: number): void {
    const value = Math.max(0, Math.min(1, progress));
    const soft = value * value * (3 - 2 * value);
    this.brand.style.opacity = String(soft);
    this.brand.style.setProperty("--launch-shift-y", `${(1 - soft) * -15}px`);
    this.connection.style.opacity = String(soft);
    this.connection.style.setProperty("--launch-shift-y", `${(1 - soft) * -15}px`);
    this.statusPanel.style.opacity = String(soft);
    this.statusPanel.style.setProperty("--launch-shift-y", `${(1 - soft) * 24}px`);
    this.energyLadder.style.opacity = String(soft);
    this.energyLadder.style.setProperty("--launch-shift-x", `${(1 - soft) * -30}px`);
    this.spinDock.style.opacity = String(soft);
    this.spinDock.style.setProperty("--launch-shift-x", "0px");
    this.toolStrip.style.opacity = String(soft);
    this.toolStrip.style.setProperty("--launch-shift-y", `${(1 - soft) * 28}px`);
    this.roundState.style.opacity = String(soft);
    this.roundState.style.setProperty("--launch-shift-y", `${(1 - soft) * 18}px`);
  }

  private activeMoneyFormatter(): MinorUnitFormatter {
    // 部分纯表现单元测试通过 Object.create 构造原型夹具；该回退只服务于尚未绑定会话的壳。
    return this.moneyFormatter ?? DEFAULT_MINOR_UNIT_FORMATTER;
  }

  private publishMoneyBinding(formatter: MinorUnitFormatter): void {
    if (!this.statusPanel?.dataset) return;
    this.statusPanel.dataset.currency = formatter.currency;
    this.statusPanel.dataset.currencyExponent = String(formatter.currencyExponent);
  }

  private bindSessionPresentationRules(session: SessionOpened): void {
    this.presentationRulesBinding = bindPrimalPresentationRules(
      this.presentationRulesBinding ?? null,
      session,
    );
    const menu = (this as unknown as { gameMenu?: HTMLElement }).gameMenu;
    if (!menu || typeof menu.querySelector !== "function") return;

    const bound = this.presentationRulesBinding.status === "bound";
    const setHidden = (role: string, hidden: boolean): void => {
      const element = menu.querySelector<HTMLElement>(`[data-role="${role}"]`);
      if (element) element.hidden = hidden;
    };
    setHidden("presentation-rules-content", !bound);
    setHidden("presentation-rules-summary", !bound);
    setHidden("presentation-rules-unavailable", bound);
    setHidden("presentation-rules-unavailable-rules", bound);
    menu.dataset.presentationRulesStatus = this.presentationRulesBinding.status;
    menu.dataset.presentationRulesVersion = PRIMAL_PRESENTATION_RULES.version;
  }

  private bindSessionMoneyFormatter(session: SessionOpened): void {
    const next = createMinorUnitFormatter(session);
    const currentSessionId = this.moneySessionId;
    if (typeof currentSessionId === "string"
      && currentSessionId === session.sessionId
      && !sameMoneyDisplayBinding(this.activeMoneyFormatter(), next)) {
      // 先抛错、后写入：任何调用者即使捕获异常，也看不到半更新的 Balance/Bet/Win。
      throw new MoneyDisplayBindingError("session money display binding changed");
    }
    this.moneySessionId = session.sessionId;
    this.moneyFormatter = next;
    this.publishMoneyBinding(next);
  }

  private assertSnapshotMoneyBinding(snapshot: GameSnapshot): void {
    const next = createMinorUnitFormatter(snapshot);
    if (typeof this.moneySessionId !== "string") {
      this.moneyFormatter = next;
      this.publishMoneyBinding(next);
      return;
    }
    if (!sameMoneyDisplayBinding(this.activeMoneyFormatter(), next)) {
      throw new MoneyDisplayBindingError("snapshot money display binding does not match its session");
    }
  }

  applySession(session: SessionOpened): void {
    this.bindSessionMoneyFormatter(session);
    this.bindSessionPresentationRules(session);
    const formatter = this.activeMoneyFormatter();
    if (this.autoplayStopSessionId !== session.sessionId) {
      this.resetAutoplayStopSession(session.sessionId);
    }
    this.balance.textContent = formatter.format(session.balanceMinor, false);
    this.bet.replaceChildren(...session.betOptionsMinor.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = formatter.format(value);
      option.selected = value === session.defaultBetMinor;
      return option;
    }));
    this.renderBetChoices(session.betOptionsMinor);
    this.syncBetChoices();
    this.showFeatureState(session.featureState);
  }

  applySnapshot(snapshot: GameSnapshot): void {
    this.assertSnapshotMoneyBinding(snapshot);
    this.balance.textContent = this.activeMoneyFormatter().format(snapshot.balanceMinor, false);
    this.setLastWin(snapshot.lastWinMinor);
    this.bet.value = snapshot.selectedBetMinor;
    this.syncBetChoices();
    this.showFeatureState(snapshot.featureState);
  }

  applyResult(result: SpinResult): void {
    this.armAutoplayStopRound(result);
    this.cancelWinCounter();
    this.balance.textContent = this.activeMoneyFormatter().format(result.balanceMinor, false);
    this.setLastWin(visibleWinMinorForResult(result));
    this.showFeatureState(result.featureState);
  }

  resetWinCounter(amountMinor: MoneyMinor = "0"): void {
    this.cancelWinCounter();
    this.heldOrdinaryWinRoundState = null;
    this.resultPresentationSuppressesSpinCopy = false;
    this.setLastWin(amountMinor);
  }

  /** 由权威总时钟和原始时钟驱动的线性整数计数。 */
  presentWinCounter(
    totalMinor: MoneyMinor,
    durationMs: number,
    startMinor: MoneyMinor = "0",
  ): Promise<void> {
    this.cancelWinCounter();
    if (!/^(0|[1-9]\d*)$/.test(totalMinor) || !/^(0|[1-9]\d*)$/.test(startMinor)) {
      return Promise.resolve();
    }
    const total = BigInt(totalMinor);
    const requestedStart = BigInt(startMinor);
    const start = requestedStart <= total ? requestedStart : 0n;
    if (!(durationMs > 0) || !Number.isFinite(durationMs) || total === 0n) {
      this.setLastWin(totalMinor);
      if (total > 0n) this.publishOrdinaryWinInformation("settled", totalMinor, totalMinor);
      return Promise.resolve();
    }

    const startedAt = performance.now();
    this.setLastWin(start.toString());
    this.publishOrdinaryWinInformation("counting", start.toString(), totalMinor);
    return new Promise<void>((resolve) => {
      const animation = { handle: null as number | null, resolve, totalMinor };
      const finish = (): void => {
        if (this.winCounterAnimation !== animation) return;
        this.winCounterAnimation = null;
        this.setLastWin(totalMinor);
        this.publishOrdinaryWinInformation("settled", totalMinor, totalMinor);
        resolve();
      };
      const tick = (time: number): void => {
        if (this.winCounterAnimation !== animation) return;
        const elapsed = Math.max(0, time - startedAt);
        const millionths = Math.min(1_000_000, Math.floor(elapsed / durationMs * 1_000_000));
        const value = start + (total - start) * BigInt(millionths) / 1_000_000n;
        this.setLastWin(value.toString());
        this.publishOrdinaryWinInformation("counting", value.toString(), totalMinor);
        if (millionths >= 1_000_000) {
          finish();
          return;
        }
        animation.handle = requestAnimationFrame(tick);
      };
      this.winCounterAnimation = animation;
      animation.handle = requestAnimationFrame(tick);
    });
  }

  /** 完成可见计数器一次而不改变结算。 */
  finishWinCounter(): boolean {
    const animation = this.winCounterAnimation;
    if (!animation) return false;
    this.winCounterAnimation = null;
    if (animation.handle !== null) cancelAnimationFrame(animation.handle);
    this.setLastWin(animation.totalMinor);
    this.publishOrdinaryWinInformation(
      "settled",
      animation.totalMinor,
      animation.totalMinor,
    );
    animation.resolve();
    return true;
  }

  private setLastWin(amountMinor: MoneyMinor): void {
    const formatted = this.activeMoneyFormatter().format(amountMinor, false);
    const zero = amountMinor === "0";
    this.lastWin.textContent = formatted;
    if (this.lastWin.dataset) {
      this.lastWin.dataset.zero = String(zero);
    }
    if (this.statusPanel?.dataset) {
      this.statusPanel.dataset.zeroWin = String(zero);
    }
    this.syncStatusGameNameProjection();
  }

  /**
   * 小 GameName 是一个已解决的 Base 空闲对象，而不是通用的零中奖回退路径对象。卷轴行程、Wheel/Rage 表现和活动 Free Spins 隐藏数值，
   * 但仅保留右对齐的 `Win:` 标签。
   */
  private syncStatusGameNameProjection(): void {
    if (!this.statusPanel?.dataset) return;
    const baseIdle = this.currentRoundPhase === "ready"
      && (this.currentRoundFeatureState === undefined
        || (this.currentRoundFeatureState.mode === "BASE"
          && this.currentRoundFeatureState.freeSpinsRemaining === 0));
    this.statusPanel.dataset.gameNameVisible = String(
      this.statusPanel.dataset.zeroWin === "true" && baseIdle,
    );
  }

  /** 卷轴已定；零胜回合消除了瞬态旋转消息。 */
  beginResultPresentation(hasOrdinaryWin: boolean): void {
    this.resultPresentationSuppressesSpinCopy = !hasOrdinaryWin;
    if (hasOrdinaryWin || this.heldWheelBonusRoundState || this.heldOrdinaryWinRoundState) return;
    this.applyRoundState({
      visualText: "",
      accessibleText: "Presenting the server result.",
    });
  }

  /** 仅清除官方功能激活边界处的瞬态 Base 轮播。 */
  clearTransientSpinMessage(): void {
    if (this.currentRoundPhase !== "presenting") return;
    this.resultPresentationSuppressesSpinCopy = true;
    this.applyCurrentRoundState();
  }

  /** 取消/拆解缝仅适用于普通中奖者。 */
  clearOrdinaryWinInformation(): void {
    this.cancelWinCounter();
    this.heldOrdinaryWinRoundState = null;
    this.resultPresentationSuppressesSpinCopy = this.currentRoundPhase === "presenting";
    this.applyCurrentRoundState();
  }

  setPhase(phase: GamePhase, featureState?: FeatureState): void {
    if (phase === "requesting" && this.currentRoundPhase !== "requesting") {
      const override = this.nextSpinMessageCaptureOverride;
      if (override) {
        this.activeSpinMessage = override;
        this.lastSpinTextIndex = PRIMAL_BASE_SPIN_MESSAGES.indexOf(override);
        this.nextSpinMessageCaptureOverride = null;
      } else {
        const selection = selectPrimalBaseSpinMessage(
          Number.isInteger(this.lastSpinTextIndex) ? this.lastSpinTextIndex : -1,
          Math.random(),
        );
        this.lastSpinTextIndex = selection.index;
        this.activeSpinMessage = selection.text;
      }
    }
    this.currentRoundPhase = phase;
    this.currentRoundFeatureState = featureState;
    this.syncStatusGameNameProjection();
    if (phase === "requesting" || phase === "recovering" || phase === "failed") {
      this.heldWheelBonusRoundState = null;
      this.heldOrdinaryWinRoundState = null;
      this.resultPresentationSuppressesSpinCopy = false;
    }
    if (phase === "ready") this.resultPresentationSuppressesSpinCopy = false;
    this.applyCurrentRoundState();
  }

  /** 一次性浏览器设备调节；生产从不设置覆盖。 */
  prepareSpinMessageCapture(message: string): boolean {
    if (!(PRIMAL_BASE_SPIN_MESSAGES as readonly string[]).includes(message)) return false;
    this.nextSpinMessageCaptureOverride = message as (typeof PRIMAL_BASE_SPIN_MESSAGES)[number];
    return true;
  }

  /** 通过以下就绪刷新保存返回的网格主赢副本。 */
  showWheelBonusRoundSummary(totalWinMinor: MoneyMinor): void {
    this.heldOrdinaryWinRoundState = null;
    this.heldWheelBonusRoundState = wheelBonusRoundSummaryPresentation(
      totalWinMinor,
      this.activeMoneyFormatter(),
    );
    this.applyRoundState(this.heldWheelBonusRoundState);
  }

  /** 正常请求之外的取消/失败路径使用显式拆卸。 */
  clearWheelBonusRoundSummary(): void {
    this.heldWheelBonusRoundState = null;
    this.applyCurrentRoundState();
  }

  /** 替换就绪提示，直到下一轮状态转换。 */
  showFreeSpinConclusion(cumulativeWinMinor: MoneyMinor): void {
    this.heldOrdinaryWinRoundState = null;
    this.applyRoundState(freeSpinConclusionPresentation(
      cumulativeWinMinor,
      this.activeMoneyFormatter(),
    ));
  }

  /** 在 Base 退出之前将活动区域与接受的终端事件对齐。 */
  showFreeSpinsCompletedState(event: Readonly<FreeSpinsCompletedEvent>): void {
    this.feature.dataset.mode = event.mode.toLowerCase();
    this.feature.textContent = [
      event.mode,
      `${event.awarded}/${event.awarded} complete`,
      "0 remaining",
      `${this.activeMoneyFormatter().format(event.cumulativeWinMinor)} won`,
    ].join(" · ");
    this.feature.dataset.visible = "true";
  }

  /** 显示本地化的 Big Win 信息事件，而不更改输入准备情况。 */
  showBigWinCongratulations(): void {
    this.heldOrdinaryWinRoundState = null;
    this.applyRoundState(bigWinCongratulationsPresentation());
  }

  setControls(canSpin: boolean, canChangeBet: boolean): void {
    this.canSpin = canSpin;
    this.canChangeBet = canChangeBet;
    this.bet.disabled = !canChangeBet;
    this.betTrigger.disabled = !canChangeBet;
    if (!canChangeBet) this.setBetPopupOpen(false, false);
    this.syncSpinControl();
    this.syncAutoplayControl();
    this.syncBetChoices();
    this.queueAutoplaySpin();
    if (canSpin && this.restoreSpinFocus && document.activeElement === this.statusPanel) {
      this.restoreSpinFocus = false;
      this.spin.focus();
    }
  }

  setLaunchStatus(phase: LaunchPhase): void {
    const accessible: Record<LaunchPhase, string> = {
      boot: "Initializing. Preparing the renderer.",
      preloading: "Loading critical presentation resources.",
      intro: "Opening sequence. Controls unlock when the intro completes.",
      "waiting-session": "Waiting for the game server.",
      ready: "Ready. Press spin to begin.",
      failed: "Launch unavailable. Please try again or follow your operator's session instructions.",
    };
    this.applyRoundState({
      visualText: phase === "ready"
        ? "PRESS SPIN TO BEGIN"
        : phase === "failed"
          ? "SESSION UNAVAILABLE"
          : "",
      accessibleText: accessible[phase],
    });
  }

  setConnection(status: GatewayStatus): void {
    const labels: Record<GatewayStatus, string> = {
      idle: "Offline",
      connecting: "Linking",
      online: "Server online",
      recovering: "Reconnecting",
      offline: "Offline",
    };
    this.connection.dataset.tone = status === "online" ? "online" : status === "offline" ? "offline" : "connecting";
    this.connectionLabel.textContent = labels[status];
  }

  async announceEvent(event: FeatureEvent, durationMs = 620): Promise<void> {
    this.feature.textContent = eventTitle(event, this.activeMoneyFormatter());
    this.feature.dataset.visible = "true";
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    this.feature.dataset.visible = "false";
    await new Promise((resolve) => setTimeout(resolve, 160));
  }

  showError(message: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.dataset.visible = "true";
    this.toastTimer = setTimeout(() => {
      this.toast.dataset.visible = "false";
    }, 4_000);
  }

  destroy(): void {
    this.cancelWinCounter();
    this.clearAutoplayTimer();
    this.wheelHyperspinEffect.destroy();
    document.removeEventListener("keydown", this.handleKeyDown);
    this.betChoices.removeEventListener("keydown", this.handleBetChoiceKeyDown);
    this.gameMenu.removeEventListener("click", this.handleGameMenuClick);
    this.gameMenu.removeEventListener("keydown", this.handleGameMenuKeyDown);
    this.autoplayOptions.removeEventListener("click", this.handleAutoplayOptionClick);
    this.autoplayOptions.removeEventListener("keydown", this.handleAutoplayOptionKeyDown);
    this.autoplayStopToggle.removeEventListener("click", this.handleAutoplayStopToggle);
    this.autoplayStopConditions.removeEventListener("change", this.handleAutoplayStopConditionChange);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  private applyRoundState(presentation: RoundStatePresentation): void {
    this.messageTitle.textContent = presentation.visualText;
    this.messageSubtitle.textContent = presentation.visualSecondaryText ?? "";
    this.messageDetail.textContent = presentation.accessibleText;
    this.roundState.dataset.visible = String(
      presentation.visualText.length > 0
      || (presentation.visualSecondaryText?.length ?? 0) > 0,
    );
    if (presentation.variant) this.roundState.dataset.variant = presentation.variant;
    else delete this.roundState.dataset.variant;
  }

  private applyCurrentRoundState(): void {
    const fallback = this.currentRoundPhase === "presenting"
      && this.resultPresentationSuppressesSpinCopy
      ? { visualText: "", accessibleText: "Presenting the server result." }
      : roundStatePresentation(
          this.currentRoundPhase,
          this.currentRoundFeatureState,
          this.activeSpinMessage ?? PRIMAL_BASE_SPIN_MESSAGES[0],
        );
    this.applyRoundState(
      this.heldWheelBonusRoundState ?? this.heldOrdinaryWinRoundState ?? fallback,
    );
  }

  private publishOrdinaryWinInformation(
    state: OrdinaryWinInformationState,
    currentMinor: MoneyMinor,
    totalMinor: MoneyMinor,
  ): void {
    const presentation = ordinaryWinInformationPresentation(
      state,
      currentMinor,
      totalMinor,
      this.activeMoneyFormatter(),
    );
    if (!presentation) return;
    this.heldOrdinaryWinRoundState = presentation;
    this.resultPresentationSuppressesSpinCopy = true;
    // Wheel B层是更高优先级的所有者，不能被后期的普通计数器帧取代。
    if (!this.heldWheelBonusRoundState) this.applyRoundState(presentation);
  }

  private cancelWinCounter(): void {
    const animation = this.winCounterAnimation;
    if (!animation) return;
    this.winCounterAnimation = null;
    if (animation.handle !== null) cancelAnimationFrame(animation.handle);
    animation.resolve();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const dialog = this.activeDialog();
    if (dialog && event.key === "Tab") {
      this.trapDialogFocus(event, dialog);
      return;
    }
    if ((event.key === " " || event.key === "Spacebar") && this.spacebarToSpin
      && !this.anyControlPanelOpen() && this.featurePreview.dataset.visible !== "true"
      && ((this.canSpin && this.spinMode === "ready") || this.spinMode === "big-win-skip"
        || this.spinMode === "normal-win-skip")
      && !this.isTypingTarget(event.target)) {
      event.preventDefault();
      // 持有的密钥不得级联通过每个 Big Win 检查点。每个预设的片段都需要重新按下，匹配指针输入。
      if (event.repeat) return;
      if (this.spinMode === "big-win-skip" || this.spinMode === "normal-win-skip") {
        this.fastStopHandler();
      }
      else this.spinHandler();
      return;
    }
    if (event.key !== "Escape") return;
    if (this.gameMenu.dataset.open === "true") {
      event.preventDefault();
      this.setGameMenuOpen(false);
      return;
    }
    if (this.autoplayModal.dataset.open === "true") {
      event.preventDefault();
      this.setAutoplayModalOpen(false);
      return;
    }
    if (this.betPopup.dataset.open === "true") {
      event.preventDefault();
      this.setBetPopupOpen(false);
      return;
    }
    if (!this.skip.hidden) this.skipHandler();
  };

  private readonly handleGameMenuClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLButtonElement>("[data-menu-tab]");
    if (tab?.dataset.menuTab) {
      this.selectGameMenuTab(tab.dataset.menuTab as GameMenuTab);
      return;
    }
    const setting = target.closest<HTMLButtonElement>("[data-setting]");
    if (!setting || setting.disabled) return;
    switch (setting.dataset.setting) {
      case "fast-play":
        this.fastPlay = !this.fastPlay;
        setting.setAttribute("aria-checked", String(this.fastPlay));
        this.fastPlayHandler(this.fastPlay);
        break;
      case "auto-adjust-bet":
        this.autoAdjustBet = !this.autoAdjustBet;
        setting.setAttribute("aria-checked", String(this.autoAdjustBet));
        break;
      case "spacebar":
        this.spacebarToSpin = !this.spacebarToSpin;
        setting.setAttribute("aria-checked", String(this.spacebarToSpin));
        break;
      case "sound":
        this.soundToggleHandler();
        break;
    }
  };

  private readonly handleGameMenuKeyDown = (event: KeyboardEvent): void => {
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-menu-tab]");
    if (!tab || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const currentIndex = this.gameMenuTabs.indexOf(tab);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + this.gameMenuTabs.length) % this.gameMenuTabs.length;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % this.gameMenuTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = this.gameMenuTabs.length - 1;
    const nextTab = this.gameMenuTabs[nextIndex];
    if (!nextTab?.dataset.menuTab) return;
    event.preventDefault();
    this.selectGameMenuTab(nextTab.dataset.menuTab as GameMenuTab, true);
  };

  private readonly handleAutoplayOptionClick = (event: MouseEvent): void => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-autoplay-count]");
    if (!option || option.disabled) return;
    this.selectAutoplayCount(Number(option.dataset.autoplayCount), true);
  };

  private readonly handleAutoplayOptionKeyDown = (event: KeyboardEvent): void => {
    const option = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-autoplay-count]");
    if (!option || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const options = [...this.autoplayOptions.querySelectorAll<HTMLButtonElement>("[data-autoplay-count]")];
    const currentIndex = options.indexOf(option);
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === "ArrowRight") nextIndex = Math.min(options.length - 1, currentIndex + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    const next = options[nextIndex];
    if (!next) return;
    event.preventDefault();
    this.selectAutoplayCount(Number(next.dataset.autoplayCount), true);
  };

  private readonly handleAutoplayStopToggle = (): void => {
    if (this.autoplayStopToggle.disabled) return;
    this.setAutoplayStopConditionsOpen(
      this.autoplayStopToggle.getAttribute("aria-expanded") !== "true",
    );
  };

  private readonly handleAutoplayStopConditionChange = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.disabled) return;
    const condition = AUTO_PLAY_STOP_CONDITIONS.find(
      ({ boundary }) => boundary === input.dataset.autoplayStopBoundary,
    );
    if (!condition) return;
    this.setAutoplayStopSettings({
      ...this.autoplayStopSettings,
      [condition.setting]: input.checked,
    });
  };

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(target.tagName);
  }

  private anyControlPanelOpen(): boolean {
    return this.gameMenu.dataset.open === "true"
      || this.autoplayModal.dataset.open === "true"
      || this.betPopup.dataset.open === "true";
  }

  private activeDialog(): HTMLElement | null {
    if (this.featurePreview.dataset.visible === "true") return this.featurePreview;
    if (this.gameMenu.dataset.open === "true") return this.gameMenu;
    if (this.autoplayModal.dataset.open === "true") return this.autoplayModal;
    if (this.betPopup.dataset.open === "true") return this.betPopup;
    return null;
  }

  private syncModalBackgroundInert(): void {
    const inert = !this.hudInteractive || this.activeDialog() !== null;
    // 仅原型单元线束可以有意省略组装的 DOM。
    for (const element of this.modalBackground ?? []) element.inert = inert;
  }

  private trapDialogFocus(event: KeyboardEvent, dialog: HTMLElement): void {
    const focusable = this.dialogFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (!dialog.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private dialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
    const candidates = dialog.querySelectorAll<HTMLElement>([
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      '[contenteditable="true"]',
      "[tabindex]",
    ].join(", "));
    return [...candidates].filter((element) => this.isDialogFocusable(element, dialog));
  }

  private isDialogFocusable(element: HTMLElement, dialog: HTMLElement): boolean {
    if (element.tabIndex < 0 || element.matches(":disabled")) return false;
    for (let current: HTMLElement | null = element; current && current !== dialog; current = current.parentElement) {
      if (current.hidden || current.inert || current.getAttribute("aria-hidden") === "true") return false;
    }
    return !dialog.hidden && !dialog.inert && dialog.getAttribute("aria-hidden") !== "true";
  }

  private captureDialogOpener(fallback: HTMLElement): HTMLElement {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected
      && !this.activeDialog()?.contains(active)) return active;
    return fallback;
  }

  private restoreDialogFocus(opener: HTMLElement | null, restoreFocus: boolean): void {
    if (restoreFocus && opener?.isConnected && !opener.inert) opener.focus();
  }

  private selectGameMenuTab(tab: GameMenuTab, focus = false): void {
    const previousTab = this.activeMenuTab;
    const changed = previousTab !== tab;
    const menuOpen = this.gameMenu.dataset.open === "true";
    this.activeMenuTab = tab;
    for (const control of this.gameMenuTabs) {
      const selected = control.dataset.menuTab === tab;
      control.classList.toggle("is-active", selected);
      control.setAttribute("aria-selected", String(selected));
      control.tabIndex = selected ? 0 : -1;
      if (selected && focus) control.focus();
    }
    for (const panel of this.gameMenuPanels) {
      const selected = panel.dataset.menuPanel === tab;
      panel.hidden = !selected;
      panel.inert = !selected;
    }
    if (menuOpen && changed) {
      this.panelLifecycle.setVisible(previousTab, false);
      this.panelLifecycle.setVisible(tab, true);
    }
  }

  private setGameMenuOpen(open: boolean, tab = this.activeMenuTab, restoreFocus = true): void {
    const wasOpen = this.gameMenu.dataset.open === "true";
    const closingTab = this.activeMenuTab;
    if (open) {
      if (!wasOpen) {
        this.menuReturnFocus = this.captureDialogOpener(
          tab === "paytable" ? this.paytableButton : this.settingsButton,
        );
      }
      this.setBetPopupOpen(false, false);
      this.setAutoplayModalOpen(false, false);
      this.clearAutoplayTimer();
      this.selectGameMenuTab(tab);
    }
    this.gameMenu.dataset.open = String(open);
    this.gameMenu.setAttribute("aria-hidden", String(!open));
    this.gameMenu.inert = !open;
    this.settingsButton.setAttribute("aria-expanded", String(open && tab === "settings"));
    this.paytableButton.setAttribute("aria-expanded", String(open && tab === "paytable"));
    this.syncModalBackgroundInert();
    if (open) {
      if (!wasOpen) this.panelLifecycle.setVisible(tab, true);
      queueMicrotask(() => this.gameMenuTabs.find((control) => control.dataset.menuTab === tab)?.focus());
      return;
    }
    if (wasOpen) this.panelLifecycle.setVisible(closingTab, false);
    this.restoreDialogFocus(this.menuReturnFocus, restoreFocus);
    this.menuReturnFocus = null;
    this.queueAutoplaySpin();
  }

  private selectAutoplayCount(count: number, focus = false): void {
    if (!AUTO_PLAY_SPIN_COUNTS.some((option) => option === count)) return;
    this.autoplayCount = count;
    for (const option of this.autoplayOptions.querySelectorAll<HTMLButtonElement>("[data-autoplay-count]")) {
      const selected = Number(option.dataset.autoplayCount) === count;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-checked", String(selected));
      option.tabIndex = selected ? 0 : -1;
      if (selected && focus) option.focus();
    }
    this.syncAutoplayControl();
  }

  private syncAutoplayStopSettings(): void {
    for (const input of this.autoplayStopInputs) {
      const condition = AUTO_PLAY_STOP_CONDITIONS.find(
        ({ boundary }) => boundary === input.dataset.autoplayStopBoundary,
      );
      if (condition) input.checked = this.autoplayStopSettings[condition.setting];
    }
  }

  private setAutoplayStopConditionsOpen(open: boolean): void {
    this.autoplayStopToggle.setAttribute("aria-expanded", String(open));
    this.autoplayStopConditions.hidden = !open;
    this.autoplayModal.dataset.stopExpanded = String(open);
  }

  private resetAutoplayStopSession(sessionId: string): void {
    this.autoplayStopSessionId = sessionId;
    this.armedAutoplayStopRound = null;
    this.completedAutoplayStopSequence = -1;
    this.stoppedAutoplayStopSequence = null;
  }

  private setAutoplayModalOpen(open: boolean, restoreFocus = true): void {
    const wasOpen = this.autoplayModal.dataset.open === "true";
    if (open) {
      if (!wasOpen) this.autoplayReturnFocus = this.captureDialogOpener(this.autoplayButton);
      this.setBetPopupOpen(false, false);
      this.setGameMenuOpen(false, this.activeMenuTab, false);
      this.clearAutoplayTimer();
    } else {
      this.setAutoplayStopConditionsOpen(false);
    }
    this.autoplayModal.dataset.open = String(open);
    this.autoplayScrim.dataset.open = String(open);
    this.autoplayModal.setAttribute("aria-hidden", String(!open));
    this.autoplayScrim.setAttribute("aria-hidden", String(!open));
    this.autoplayModal.inert = !open;
    this.autoplayButton.setAttribute("aria-expanded", String(open));
    this.syncAutoplayControl();
    this.syncModalBackgroundInert();
    if (wasOpen !== open) this.panelLifecycle.setVisible("autoplay", open);
    if (open) {
      queueMicrotask(() => {
        if (this.autoplayActive) this.autoplayAction.focus();
        else this.autoplayOptions.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      });
      return;
    }
    this.restoreDialogFocus(this.autoplayReturnFocus, restoreFocus);
    this.autoplayReturnFocus = null;
    this.queueAutoplaySpin();
  }

  private startAutoplay(): void {
    if (!this.canSpin || this.spinMode !== "ready" || this.autoplayCount <= 0) return;
    this.autoplayRunGeneration += 1;
    this.pendingPaidAutoplaySpin = null;
    this.autoplayActive = true;
    this.autoplayRemaining = this.autoplayCount;
    this.syncAutoplayControl();
    this.setAutoplayModalOpen(false);
    this.queueAutoplaySpin();
  }

  private stopAutoplay(restoreFocus: boolean): void {
    this.clearAutoplayTimer();
    this.autoplayRunGeneration += 1;
    this.pendingPaidAutoplaySpin = null;
    this.autoplayActive = false;
    this.autoplayRemaining = 0;
    this.syncAutoplayControl();
    if (this.autoplayModal.dataset.open === "true") this.setAutoplayModalOpen(false, restoreFocus);
  }

  private syncAutoplayControl(): void {
    const active = this.autoplayActive;
    this.autoplayButton.dataset.active = String(active);
    // 原始计数器属于橙色主停止组合，而不是小自动实用程序图标。
    this.autoplayButton.dataset.remaining = "";
    this.autoplayButton.setAttribute("aria-label", active
      ? `Autoplay active, ${this.autoplayRemaining} spins remaining`
      : "Open autoplay");
    this.autoplayButton.title = active ? `Autoplay · ${this.autoplayRemaining} remaining` : "Auto play";
    this.autoplayAction.textContent = active ? "Stop autoplay" : "Start";
    this.autoplayAction.disabled = !active && (!this.canSpin || this.spinMode !== "ready");
    this.autoplayStatus.textContent = active
      ? `Autoplay active · ${this.autoplayRemaining} spins remaining`
      : `${this.autoplayCount} spins selected`;
    this.autoplayStopToggle.disabled = active;
    for (const input of this.autoplayStopInputs) input.disabled = active;
    for (const option of this.autoplayOptions.querySelectorAll<HTMLButtonElement>("[data-autoplay-count]")) {
      option.disabled = active;
    }
    this.syncSpinControl();
  }

  private queueAutoplaySpin(): void {
    if (!this.autoplayActive || this.autoplayTimer !== null || this.anyControlPanelOpen()) return;
    const featureInputDelay = autoplayFeatureInputDelay(this.spinMode);
    if (featureInputDelay !== null) {
      const expectedMode = this.spinMode;
      this.autoplayTimer = setTimeout(() => {
        this.autoplayTimer = null;
        if (!this.autoplayActive || this.spinMode !== expectedMode
          || this.anyControlPanelOpen()) return;
        const input = spinControlPresentation(this.spinMode, this.canSpin);
        if (input.disabled || (input.action !== "continue" && input.action !== "wheel-spin")) return;
        this.spinHandler();
      }, featureInputDelay);
      return;
    }
    if (!this.autoplayPaidSpinEligible || !this.canSpin || this.spinMode !== "ready") return;
    this.autoplayTimer = setTimeout(() => {
      this.autoplayTimer = null;
      if (!this.autoplayActive || !this.autoplayPaidSpinEligible
        || !this.canSpin || this.spinMode !== "ready" || this.anyControlPanelOpen()) return;
      this.spinHandler();
    }, this.fastPlay ? 80 : 420);
  }

  /**
   * 功能控件暂时拥有共享主按钮。手动输入可推进该功能，而不会终止保留的外部自动播放会话；普通的 Base 状态保留显式的自动停止语义。
   */
  private handlePrimarySpinAction(): void {
    if (this.autoplayActive && isAutoplayFeatureOwnedSpinMode(this.spinMode)) {
      this.clearAutoplayTimer();
      const action = spinControlPresentation(this.spinMode, this.canSpin).action;
      if (action === "wheel-quick-stop") this.fastStopHandler();
      else if (action === "continue" || action === "wheel-spin") this.spinHandler();
      return;
    }
    // 在捕获的客户端中，橙色计数复合材料专门是在预设的 Continue 门之外的自动播放停止控件。
    if (this.autoplayActive) {
      this.stopAutoplay(false);
      return;
    }
    const action = spinControlPresentation(this.spinMode, this.canSpin).action;
    if (action === "fast-stop" || action === "wheel-quick-stop") {
      this.fastStopHandler();
    } else if (action === "spin" || action === "continue" || action === "wheel-spin") {
      this.spinHandler();
    }
  }

  private clearAutoplayTimer(): void {
    if (this.autoplayTimer === null) return;
    clearTimeout(this.autoplayTimer);
    this.autoplayTimer = null;
  }

  private readonly handleBetChoiceKeyDown = (event: KeyboardEvent): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const focusedValue = (document.activeElement as HTMLElement | null)?.dataset.value;
    let nextIndex = this.betOptions.indexOf(focusedValue ?? this.bet.value);
    if (nextIndex < 0) nextIndex = this.betOptions.indexOf(this.bet.value);
    if (nextIndex < 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = Math.max(0, nextIndex - 1);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = Math.min(this.betOptions.length - 1, nextIndex + 1);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = this.betOptions.length - 1;
    event.preventDefault();
    const value = this.betOptions[nextIndex];
    if (value !== undefined) this.selectBet(value, true);
  };

  private renderBetChoices(options: readonly MoneyMinor[]): void {
    this.betOptions = [...options];
    this.renderBetTicker();
  }

  private renderBetTicker(): void {
    const visibleOptions = betTickerWindow(this.betOptions, this.bet.value);
    this.betChoices.replaceChildren(...visibleOptions.map((value) => {
      const choice = document.createElement("button");
      const selected = value === this.bet.value;
      choice.type = "button";
      choice.className = "bet-choice";
      choice.classList.toggle("is-selected", selected);
      choice.dataset.value = value;
      choice.textContent = this.activeMoneyFormatter().format(value);
      choice.disabled = !this.canChangeBet;
      choice.setAttribute("role", "radio");
      choice.setAttribute("aria-label", `Bet ${this.activeMoneyFormatter().format(value)}`);
      choice.setAttribute("aria-checked", String(selected));
      choice.tabIndex = selected ? 0 : -1;
      return choice;
    }));
  }

  private selectBet(value: MoneyMinor, restoreChoiceFocus = false): void {
    if (!this.canChangeBet || !this.betOptions.includes(value)) return;
    this.bet.value = value;
    this.syncBetChoices();
    this.betHandler(value);
    if (restoreChoiceFocus) queueMicrotask(() => this.focusSelectedBetChoice());
  }

  private stepBet(direction: -1 | 1): void {
    const currentIndex = this.betOptions.indexOf(this.bet.value);
    if (currentIndex < 0) return;
    const value = this.betOptions[currentIndex + direction];
    if (value !== undefined) this.selectBet(value, true);
  }

  private syncBetChoices(): void {
    const formatted = this.bet.value
      ? this.activeMoneyFormatter().format(this.bet.value)
      : "—";
    this.betTriggerValue.textContent = formatted;
    this.betTrigger.setAttribute("aria-label", `Total bet ${formatted}`);
    this.betStatus.textContent = this.bet.value
      ? this.activeMoneyFormatter().format(this.bet.value, false)
      : "—";
    this.renderBetTicker();
    const selectedIndex = this.betOptions.indexOf(this.bet.value);
    this.betDecrease.disabled = !this.canChangeBet || selectedIndex <= 0;
    this.betIncrease.disabled = !this.canChangeBet || selectedIndex < 0 || selectedIndex >= this.betOptions.length - 1;
    const jackpotValues = jackpotValuesForBet(this.bet.value || "0");
    this.host.querySelectorAll<HTMLElement>('[data-role="jackpot-value"]').forEach((element, index) => {
      const value = jackpotValues[index];
      element.textContent = value === undefined
        ? "—"
        : this.activeMoneyFormatter().format(value);
    });
  }

  private focusSelectedBetChoice(): void {
    this.betChoices.querySelector<HTMLButtonElement>('.bet-choice[aria-checked="true"]')?.focus();
  }

  private setBetPopupOpen(open: boolean, restoreFocus = true): void {
    const wasOpen = this.betPopup.dataset.open === "true";
    const shouldOpen = open && this.canChangeBet;
    if (shouldOpen) {
      if (!wasOpen) this.betReturnFocus = this.captureDialogOpener(this.betTrigger);
      this.setAutoplayModalOpen(false, false);
      this.setGameMenuOpen(false, this.activeMenuTab, false);
      this.clearAutoplayTimer();
    }
    this.betPopup.dataset.open = String(shouldOpen);
    this.betScrim.dataset.open = String(shouldOpen);
    this.betPopup.setAttribute("aria-hidden", String(!shouldOpen));
    this.betScrim.setAttribute("aria-hidden", String(!shouldOpen));
    this.betPopup.inert = !shouldOpen;
    this.betTrigger.setAttribute("aria-expanded", String(shouldOpen));
    this.syncModalBackgroundInert();
    if (wasOpen !== shouldOpen) this.panelLifecycle.setVisible("bet", shouldOpen);
    if (shouldOpen) queueMicrotask(() => this.focusSelectedBetChoice());
    else {
      this.restoreDialogFocus(this.betReturnFocus, restoreFocus);
      this.betReturnFocus = null;
      this.queueAutoplaySpin();
    }
  }

  private syncSpinControl(): void {
    const presentation = primarySpinControlPresentation(
      this.spinMode,
      this.canSpin,
      { active: this.autoplayActive, remaining: this.autoplayRemaining },
    );
    this.spin.disabled = presentation.disabled;
    this.spin.dataset.mode = presentation.dataMode;
    this.spin.dataset.action = presentation.action;
    this.spin.dataset.visualToken = presentation.visualToken;
    this.spin.dataset.autoplayActive = String(this.autoplayActive);
    this.spin.dataset.autoplayRemaining = presentation.remainingText;
    this.spinText.textContent = presentation.text;
    this.spinAutoplayCount.textContent = presentation.remainingText;
    this.spin.setAttribute("aria-label", presentation.ariaLabel);
  }

  /** 当Wheel等待Spin时，官方的DOM效果完全可见。 */
  private syncWheelHyperspinEffect(): void {
    this.wheelHyperspinEffect?.setVisible(this.spinMode === "wheel-ready");
  }

  private syncFeaturePreviewContinue(): void {
    this.previewContinue.disabled = !this.featurePreviewEnabled || this.featurePreviewPending;
  }

  private showFeatureState(state: FeatureState): void {
    if (state.mode === "BASE" && state.freeSpinsRemaining === 0) {
      this.feature.textContent = "";
      this.feature.dataset.visible = "false";
      delete this.feature.dataset.mode;
      return;
    }
    const played = state.freeSpinsPlayed ?? 0;
    const total = played + state.freeSpinsRemaining;
    this.feature.dataset.mode = state.mode.toLowerCase();
    const win = state.freeSpinsWinMinor === undefined
      ? ""
      : ` · ${this.activeMoneyFormatter().format(state.freeSpinsWinMinor)} won`;
    this.feature.textContent = `${state.mode} · ${played}/${total} complete · ${state.freeSpinsRemaining} remaining${win}`;
    this.feature.dataset.visible = "true";
  }

  private require(host: HTMLElement, role: string): HTMLElement {
    const element = host.querySelector(`[data-role="${role}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing UI element ${role}`);
    return element;
  }
}
