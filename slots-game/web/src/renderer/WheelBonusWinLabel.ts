import { Vector2 } from "@pixi-spine/base";
import { Container, Point, Text, type TextStyle } from "pixi.js";
import type { MoneyMinor } from "../app/state/types";
import {
  DEFAULT_MINOR_UNIT_FORMATTER,
  type MinorUnitFormatter,
} from "../protocol/moneyFormatter";
import type { ReelSetView } from "../reels/ReelSetView";
import { createSpineView, type Spine, type SpineData } from "./spine/SpineAdapter";
import { loadPrimalSpineSet } from "./spine/PrimalSpineAssets";
import {
  WIN_LABEL_TEXT_SLOTS,
  WinLabelAnimationController,
  winLabelGoldTextStyle,
  winLabelInfoTextStyle,
  winLabelValue,
  type WinLabelTextFacts,
  type WinLabelTextSlot,
} from "./WinCelebration";

const WIN_LABEL_SOURCE_WIDTH = 240;
const WIN_LABEL_SOURCE_HEIGHT = 160;
const CANONICAL_MONEY_MINOR = /^(0|[1-9]\d*)$/;

/** 捕获 GameMasterWinView 显示/保持姿势/隐藏合同。 */
export const WHEEL_BONUS_WIN_LABEL_TIMELINE_MS = Object.freeze({
  show: 333.333,
  hide: 333.333,
});

export type WheelBonusWinLabelState =
  | "hidden"
  | "showing"
  | "holding"
  | "hiding"
  | "destroyed";

/**
 * Pixi/Spine 视图使用的纯生命周期。 `holding` 故意不受限制：只有稍后的旋转、取消或渲染器拆卸可能会留下官方固定网格 BONUS 板。
 */
export class WheelBonusWinLabelLifecycle {
  private elapsedMs = 0;
  private speed = 1;
  private currentState: WheelBonusWinLabelState = "hidden";

  get state(): WheelBonusWinLabelState {
    return this.currentState;
  }

  show(reducedMotion = false): boolean {
    if (this.currentState === "destroyed") return false;
    this.speed = reducedMotion ? 4 : 1;
    this.elapsedMs = 0;
    this.currentState = "showing";
    return true;
  }

  hide(reducedMotion = false): boolean {
    if (this.currentState === "hidden" || this.currentState === "destroyed") return false;
    this.speed = reducedMotion ? 4 : 1;
    this.elapsedMs = 0;
    this.currentState = "hiding";
    return true;
  }

  advance(deltaMs: number): WheelBonusWinLabelState {
    if (this.currentState !== "showing" && this.currentState !== "hiding") {
      return this.currentState;
    }
    if (Number.isFinite(deltaMs) && deltaMs > 0) this.elapsedMs += deltaMs;
    const duration = (this.currentState === "showing"
      ? WHEEL_BONUS_WIN_LABEL_TIMELINE_MS.show
      : WHEEL_BONUS_WIN_LABEL_TIMELINE_MS.hide) / this.speed;
    if (this.elapsedMs + 0.000_1 < duration) return this.currentState;
    this.currentState = this.currentState === "showing" ? "holding" : "hidden";
    this.elapsedMs = 0;
    return this.currentState;
  }

  cancel(): void {
    if (this.currentState === "destroyed") return;
    this.elapsedMs = 0;
    this.currentState = "hidden";
  }

  destroy(): void {
    this.elapsedMs = 0;
    this.currentState = "destroyed";
  }
}

/** `paywaysWon === -1` 映射到捕获的客户端中的 IDS_PR_BONUSWON。 */
export function wheelBonusWinLabelText(
  amountMinor: MoneyMinor | undefined,
  formatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER,
): WinLabelTextFacts | null {
  if (amountMinor === undefined || !CANONICAL_MONEY_MINOR.test(amountMinor)) return null;
  return Object.freeze({
    winLabelValue: winLabelValue(amountMinor, formatter),
    winLabelInfo: "BONUS won!",
    winLabelMultiplier: null,
  });
}

interface BoundWinLabelField {
  readonly name: WinLabelTextSlot;
  readonly text: Text;
  readonly point: Vector2;
  readonly authoritative: boolean;
}

interface WinLabelTextAttachmentSource {
  getAttachment(): unknown | null;
  readonly data: { readonly index: number };
}

interface WinLabelTextSkeletonSource {
  getAttachment(slotIndex: number, attachmentName: string): unknown | null;
}

/**
 * winlabel 的文本槽故意没有设置附件。它们的几何体位于 `bounds` 下的默认皮肤中，与 Free Spins 介绍插槽完全相同。因此，
 * 需要 `slot.getAttachment()` 隐藏每个运行时字符串。
 */
export function resolveWheelBonusTextAttachment<T>(
  skeleton: WinLabelTextSkeletonSource,
  slot: WinLabelTextAttachmentSource,
): T | null {
  return (slot.getAttachment()
    ?? skeleton.getAttachment(slot.data.index, "bounds")) as T | null;
}

interface ActiveWheelBonusLabel {
  readonly group: Container;
  readonly spine: Spine;
  readonly animations: WinLabelAnimationController;
  readonly fields: readonly BoundWinLabelField[];
}

/**
 * 独立后Wheel主胜层。它重复使用捕获的 `Spine_winlabel` 及其三个运行时文本槽，而无需输入正常的支付线/方式数学或更改底部总赢计数器。
 */
export class WheelBonusWinLabel {
  readonly view = new Container();
  readonly lifecycle = new WheelBonusWinLabelLifecycle();
  private data: SpineData | null = null;
  private loadPromise: Promise<void> | null = null;
  private active: ActiveWheelBonusLabel | null = null;
  private generation = 0;
  private destroyed = false;
  private moneyFormatter: MinorUnitFormatter = DEFAULT_MINOR_UNIT_FORMATTER;

  constructor(
    private readonly hostLayer: Container,
    private readonly reels: ReelSetView,
  ) {
    this.hostLayer.addChild(this.view);
  }

  get artworkLoaded(): boolean {
    return this.data !== null;
  }

  setMoneyFormatter(formatter: MinorUnitFormatter): void {
    this.moneyFormatter = formatter;
  }

  loadArtwork(signal?: AbortSignal): Promise<void> {
    if (this.data) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    const attempt = loadPrimalSpineSet(["winLabel"] as const).then(({ winLabel }) => {
      if (this.destroyed || signal?.aborted) return;
      this.data = winLabel;
    });
    this.loadPromise = attempt;
    void attempt.catch(() => {
      if (this.loadPromise === attempt) this.loadPromise = null;
    });
    return attempt;
  }

  async show(amountMinor: MoneyMinor | undefined, reducedMotion = false): Promise<boolean> {
    const facts = wheelBonusWinLabelText(amountMinor, this.moneyFormatter);
    if (!facts || this.destroyed) return false;
    const generation = ++this.generation;
    this.lifecycle.cancel();
    this.releaseActive();
    try {
      await this.loadArtwork();
    } catch {
      return false;
    }
    if (this.destroyed || generation !== this.generation || !this.data) return false;

    const active = this.createActiveLabel(this.data, facts, reducedMotion);
    if (!active) return false;
    this.active = active;
    this.view.addChild(active.group);
    this.lifecycle.show(reducedMotion);
    return true;
  }

  /** 在下一次权威旋转时启动捕获的 333.333ms 隐藏。 */
  hide(reducedMotion = false): boolean {
    // 资产承诺尚未解决的节目也会失效。
    this.generation += 1;
    const active = this.active;
    if (!active || !this.lifecycle.hide(reducedMotion)) {
      this.lifecycle.cancel();
      this.releaseActive();
      return false;
    }
    active.spine.state.timeScale = reducedMotion ? 4 : 1;
    active.animations.hide();
    return true;
  }

  /** 取消回合后立即进行故障关闭拆解。 */
  cancel(): void {
    this.generation += 1;
    this.lifecycle.cancel();
    this.releaseActive();
  }

  update(deltaMs: number): void {
    const active = this.active;
    if (!active || this.destroyed) return;
    const safeDeltaMs = Math.min(64, Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0));
    active.spine.update(safeDeltaMs / 1_000);
    this.syncText(active);
    if (this.lifecycle.advance(safeDeltaMs) === "hidden") this.releaseActive();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.lifecycle.destroy();
    this.releaseActive();
    if (this.view.parent) this.view.parent.removeChild(this.view);
    this.view.destroy({ children: true });
  }

  private createActiveLabel(
    data: SpineData,
    facts: WinLabelTextFacts,
    reducedMotion: boolean,
  ): ActiveWheelBonusLabel | null {
    const cell = this.reels.getCellPresentationBounds({ reel: 0, row: 0 });
    if (!cell) return null;
    let group: Container | null = null;
    let spine: Spine | null = null;
    try {
      const bounds = this.reels.getPresentationBounds();
      const center = this.effectPoint(new Point(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      ));
      const topLeft = this.effectPoint(new Point(cell.left, cell.top));
      const bottomRight = this.effectPoint(new Point(cell.right, cell.bottom));
      group = new Container();
      group.position.copyFrom(center);
      group.scale.set(
        Math.abs(bottomRight.x - topLeft.x) / WIN_LABEL_SOURCE_WIDTH,
        Math.abs(bottomRight.y - topLeft.y) / WIN_LABEL_SOURCE_HEIGHT,
      );

      spine = createSpineView(data);
      if (!spine.state.hasAnimation("show") || !spine.state.hasAnimation("hide")) {
        spine.destroy({ children: true });
        return null;
      }
      spine.autoUpdate = false;
      spine.state.timeScale = reducedMotion ? 4 : 1;
      const animations = new WinLabelAnimationController(spine.state);
      animations.setHidden();
      spine.update(0);
      animations.show();
      if (spine.state.hasAnimation("loop")) {
        spine.state.addAnimation(0, "loop", true, 0);
      }

      const values: Readonly<Record<WinLabelTextSlot, string | null>> = {
        winLabelValue: facts.winLabelValue,
        winLabelInfo: facts.winLabelInfo,
        winLabelMultiplier: facts.winLabelMultiplier,
      };
      const fields = WIN_LABEL_TEXT_SLOTS.map((name): BoundWinLabelField => {
        const value = values[name];
        const style: TextStyle = name === "winLabelInfo"
          ? winLabelInfoTextStyle()
          : winLabelGoldTextStyle();
        const text = new Text(value ?? "", style);
        text.anchor.set(0.5);
        text.visible = false;
        return {
          name,
          text,
          point: new Vector2(),
          authoritative: value !== null && value.length > 0,
        };
      });
      group.addChild(spine, ...fields.map(({ text }) => text));
      const active = { group, spine, animations, fields };
      this.syncText(active);
      return active;
    } catch {
      if (group) group.destroy({ children: true });
      else spine?.destroy({ children: true });
      return null;
    }
  }

  private syncText(active: ActiveWheelBonusLabel): void {
    const skeleton = active.spine.skeleton;
    skeleton.updateWorldTransform();
    for (const field of active.fields) {
      if (!field.authoritative) {
        field.text.visible = false;
        continue;
      }
      const slot = skeleton.findSlot(field.name);
      if (!slot) {
        field.text.visible = false;
        continue;
      }
      const attachment = resolveWheelBonusTextAttachment<{
        worldVerticesLength?: number;
        computeWorldVertices?: (
          slotValue: typeof slot,
          start: number,
          count: number,
          worldVertices: number[],
          offset: number,
          stride: number,
        ) => void;
        vertices?: ArrayLike<number>;
      }>(skeleton, slot);
      if (!attachment) {
        field.text.visible = false;
        continue;
      }

      const vertices = attachment.vertices;
      let boundsWidth = Number.POSITIVE_INFINITY;
      let boundsHeight = Number.POSITIVE_INFINITY;
      if (vertices && vertices.length >= 2) {
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index + 1 < vertices.length; index += 2) {
          const x = vertices[index];
          const y = vertices[index + 1];
          if (x === undefined || y === undefined) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        if (Number.isFinite(minX) && Number.isFinite(minY)) {
          const worldVerticesLength = attachment.worldVerticesLength ?? 0;
          if (worldVerticesLength >= 2 && attachment.computeWorldVertices) {
            const worldVertices = new Array<number>(worldVerticesLength);
            attachment.computeWorldVertices(
              slot,
              0,
              worldVerticesLength,
              worldVertices,
              0,
              2,
            );
            let worldMinX = Number.POSITIVE_INFINITY;
            let worldMinY = Number.POSITIVE_INFINITY;
            let worldMaxX = Number.NEGATIVE_INFINITY;
            let worldMaxY = Number.NEGATIVE_INFINITY;
            for (let index = 0; index + 1 < worldVertices.length; index += 2) {
              const x = worldVertices[index];
              const y = worldVertices[index + 1];
              if (x === undefined || y === undefined) continue;
              worldMinX = Math.min(worldMinX, x);
              worldMaxX = Math.max(worldMaxX, x);
              worldMinY = Math.min(worldMinY, y);
              worldMaxY = Math.max(worldMaxY, y);
            }
            field.text.position.set(
              (worldMinX + worldMaxX) / 2,
              (worldMinY + worldMaxY) / 2,
            );
          } else {
            field.point.set((minX + maxX) / 2, (minY + maxY) / 2);
            slot.bone.localToWorld(field.point);
            field.text.position.set(field.point.x, field.point.y);
          }
          boundsWidth = Math.max(0, maxX - minX);
          boundsHeight = Math.max(0, maxY - minY);
        } else {
          field.text.position.set(slot.bone.worldX, slot.bone.worldY);
        }
      } else {
        field.text.position.set(slot.bone.worldX, slot.bone.worldY);
      }

      field.text.rotation = 0;
      field.text.scale.set(1);
      const fitScale = Math.min(
        1,
        boundsWidth / Math.max(0.000_1, field.text.width),
        boundsHeight / Math.max(0.000_1, field.text.height),
      );
      const { a, b, c, d } = slot.bone.matrix;
      const scaleX = Math.hypot(a, b);
      const scaleY = Math.hypot(c, d);
      field.text.rotation = Math.atan2(b, a);
      // Spine 的坐标桥反映区域附件的 Y。运行时 Pixi 文本必须保持大小，同时丢弃反射或现在可见的字形渲染颠倒。
      field.text.scale.set(fitScale * scaleX, fitScale * scaleY);
      field.text.alpha = slot.color.a * skeleton.color.a;
      field.text.visible = field.text.alpha > 0.001;
    }
  }

  private effectPoint(localPoint: Point): Point {
    return this.view.toLocal(this.reels.toGlobal(localPoint));
  }

  private releaseActive(): void {
    const active = this.active;
    this.active = null;
    if (!active) return;
    if (active.group.parent) active.group.parent.removeChild(active.group);
    active.group.destroy({ children: true });
  }
}
