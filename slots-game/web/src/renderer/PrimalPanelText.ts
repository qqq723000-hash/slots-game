import { Vector2 } from "@pixi-spine/base";
import {
  Container,
  Text,
  TextStyle,
  type ITextStyle,
} from "pixi.js";
import type {
  FreeSpinsCompletedEvent,
  FreeSpinsStartedEvent,
  MoneyMinor,
  WheelAwardedEvent,
} from "../app/state/types";
import type { Spine } from "./spine/SpineAdapter";

export type SpineTextBounds = readonly [x: number, y: number, width: number, height: number];

export interface AuthoredPanelLayout {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly minBound: SpineTextBounds;
}

/** 从 layout_desktop.json 恢复的桌面包含布局转换。 */
export const PRIMAL_PANEL_LAYOUT = Object.freeze({
  freeSpinIntro: Object.freeze({
    x: 640,
    y: 324,
    scale: 720 / 1_000,
    minBound: Object.freeze([-500, -450, 1_000, 1_000] as const),
  }),
  freeSpinSummary: Object.freeze({
    x: 640,
    y: 360 - 50 * (720 / 1_100),
    scale: 720 / 1_100,
    minBound: Object.freeze([-550, -500, 1_100, 1_100] as const),
  }),
  wheelSummary: Object.freeze({
    x: 640,
    y: 360,
    scale: 720 / 1_200,
    minBound: Object.freeze([-600, -600, 1_200, 1_200] as const),
  }),
} satisfies Record<string, AuthoredPanelLayout>);

export type PrimalPanelTextStyle =
  | "counter"
  | "description"
  | "flame"
  | "silver"
  | "silver-thick";

export interface PrimalPanelTextField {
  readonly name: string;
  readonly bone: string;
  readonly size: number;
  readonly bounds: SpineTextBounds;
  readonly text: string;
  readonly style: PrimalPanelTextStyle;
  /** 介绍文本槽没有附件；他们的动画老虎机阿尔法是权威的。 */
  readonly attachmentRequired: boolean;
  readonly wrap: boolean;
}

interface PrimalPanelTextFieldTemplate extends Omit<PrimalPanelTextField, "text"> {}

const field = (
  value: PrimalPanelTextFieldTemplate,
): Readonly<PrimalPanelTextFieldTemplate> => Object.freeze({
  ...value,
  bounds: Object.freeze([...value.bounds]) as unknown as SpineTextBounds,
});

export const PRIMAL_PANEL_TEXT_SLOTS = Object.freeze({
  kongQuestIntro: Object.freeze([
    field({
      name: "IDS_PR_KQ_FSINTRO1",
      bone: "_text_IDS_PR_KQ_FSINTRO1_size100",
      size: 100,
      bounds: [0.565, 1.285, 1_329.57, 202.05],
      style: "counter",
      attachmentRequired: false,
      wrap: false,
    }),
    field({
      name: "IDS_PR_KQ_FSINTRO2",
      bone: "_text_IDS_PR_KQ_FSINTRO2_size65",
      size: 65,
      bounds: [11.555, -0.89, 1_217.05, 178.36],
      style: "description",
      attachmentRequired: false,
      wrap: true,
    }),
    field({
      name: "IDS_PR_KQ_FSINTRO3",
      bone: "_text_IDS_PR_KQ_FSINTRO3_size65",
      size: 65,
      bounds: [0.685, -0.095, 1_304.51, 129.87],
      style: "description",
      attachmentRequired: false,
      wrap: true,
    }),
    field({
      name: "IDS_PR_KQ_FSINTRO4",
      bone: "_text_IDS_PR_KQ_FSINTRO4_size80",
      size: 80,
      bounds: [10.47, 17.865, 1_371.98, 232.63],
      style: "counter",
      attachmentRequired: false,
      wrap: false,
    }),
  ]),
  kingSpinIntro: Object.freeze([
    field({
      name: "IDS_PR_KS_FSINTRO1",
      bone: "_text_IDS_PR_KS_FSINTRO1_size100",
      size: 100,
      bounds: [14.355, -3.39, 1_339.49, 207.1],
      style: "counter",
      attachmentRequired: false,
      wrap: false,
    }),
    field({
      name: "IDS_PR_KS_FSINTRO2",
      bone: "_text_IDS_PR_KS_FSINTRO2_size65",
      size: 65,
      bounds: [5.65, 0.19, 1_081.22, 150.04],
      style: "description",
      attachmentRequired: false,
      wrap: true,
    }),
    field({
      name: "IDS_PR_KS_FSINTRO3",
      bone: "_text_IDS_PR_KS_FSINTRO3_size65",
      size: 65,
      bounds: [-7.03, 7.635, 1_120.24, 161.33],
      style: "description",
      attachmentRequired: false,
      wrap: true,
    }),
    field({
      name: "IDS_PR_KS_FSINTRO4",
      bone: "_text_IDS_PR_KS_FSINTRO4_size90",
      size: 90,
      bounds: [12.965, -27.02, 1_380.03, 218.28],
      style: "counter",
      attachmentRequired: false,
      wrap: false,
    }),
  ]),
  freeSpinSummary: Object.freeze([
    field({
      name: "fsSummaryCongrats",
      bone: "congrats",
      size: 60,
      bounds: [-1.89, -50.48, 740.32, 113.78],
      style: "flame",
      attachmentRequired: true,
      wrap: false,
    }),
    field({
      name: "fsSummaryValue",
      bone: "reward",
      size: 90,
      bounds: [-10.47, 0.33, 815.28, 132.56],
      style: "flame",
      attachmentRequired: true,
      wrap: false,
    }),
    field({
      name: "fsSummaryTotal",
      bone: "normal/summary_panel/you won",
      size: 60,
      bounds: [-4.64, 20.465, 568, 133.95],
      style: "silver-thick",
      attachmentRequired: true,
      wrap: false,
    }),
  ]),
  wheelSummaryFreeSpins: Object.freeze([
    field({
      name: "congratulations",
      bone: "top",
      size: 100,
      bounds: [-0.72, -190.045, 1_100.38, 100.23],
      style: "silver",
      attachmentRequired: true,
      wrap: false,
    }),
    field({
      name: "primalWheelBonusWin",
      bone: "top",
      size: 80,
      bounds: [-0.72, -54.885, 1_100.38, 152.77],
      style: "silver",
      attachmentRequired: true,
      wrap: true,
    }),
    field({
      name: "freespins",
      bone: "bottom",
      size: 220,
      bounds: [-0.72, 117.3, 1_100.38, 224.64],
      style: "silver",
      attachmentRequired: true,
      wrap: false,
    }),
  ]),
  wheelSummaryJackpot: Object.freeze([
    field({
      name: "congratulations",
      bone: "top",
      size: 100,
      bounds: [-0.72, -190.045, 1_100.38, 100.23],
      style: "silver",
      attachmentRequired: true,
      wrap: false,
    }),
    field({
      name: "primalWheelBonusWin",
      bone: "top",
      size: 80,
      bounds: [-0.72, -54.885, 1_100.38, 152.77],
      style: "silver",
      attachmentRequired: true,
      wrap: true,
    }),
    field({
      name: "totalWin",
      bone: "bottom",
      size: 120,
      bounds: [-0.72, 58.935, 1_100.38, 107.91],
      style: "silver",
      attachmentRequired: true,
      wrap: false,
    }),
    field({
      name: "totalWinValue",
      bone: "bottom",
      size: 120,
      bounds: [-0.72, 170.57, 1_100.38, 110.02],
      style: "silver",
      attachmentRequired: true,
      wrap: false,
    }),
  ]),
});

export function freeSpinIntroTextFields(
  event: FreeSpinsStartedEvent,
): readonly PrimalPanelTextField[] {
  const kingSpin = event.mode === "OVERDRIVE";
  const templates = kingSpin
    ? PRIMAL_PANEL_TEXT_SLOTS.kingSpinIntro
    : PRIMAL_PANEL_TEXT_SLOTS.kongQuestIntro;
  const values = kingSpin
    ? [
      // 捕获的King Spin配置将此字段与固定的`8`绑定；服务器事件仍然拥有功能状态和剩余旋转计数。
      "8 FREE SPINS awarded!",
      "All VAULT BONUS are unlocked in KING SPIN!",
      "All VAULT BONUS can upgrade up to GRAND!",
      "PRESS SPIN TO BEGIN",
    ]
    : [
      // 两个捕获的桌面介绍实体都将此区域设置参数绑定到 8。
      "8 FREE SPINS awarded!",
      "Reels can expand in KONG QUEST!",
      "Unlock FREE SPINS to retrigger!",
      "PRESS SPIN TO BEGIN",
    ];
  return materializeFields(templates, values);
}

export function freeSpinSummaryTextFields(
  event: FreeSpinsCompletedEvent,
): readonly PrimalPanelTextField[] {
  return materializeFields(PRIMAL_PANEL_TEXT_SLOTS.freeSpinSummary, [
    "CONGRATULATIONS!",
    formatPrimalPanelAmount(event.cumulativeWinMinor),
    "Total Win",
  ]);
}

export function wheelSummaryTextFields(
  event: WheelAwardedEvent,
  freeSpins: boolean,
): readonly PrimalPanelTextField[] {
  const prize = wheelPrizeLabel(event);
  if (freeSpins) {
    return materializeFields(PRIMAL_PANEL_TEXT_SLOTS.wheelSummaryFreeSpins, [
      "CONGRATULATIONS!",
      "You’ve won the",
      prize,
    ]);
  }
  // GamePrimalWheelBonusFeature 在此绑定 `_totalCoins`。乘数是一个不同的服务器事实，当权威金额不存在时，决不能将乘数提升到钱槽中。
  const value = event.amountMinor !== undefined
    ? formatPrimalPanelAmount(event.amountMinor)
    : "";
  return materializeFields(PRIMAL_PANEL_TEXT_SLOTS.wheelSummaryJackpot, [
    "CONGRATULATIONS!",
    `You’ve won the ${prize} BONUS!`,
    "Total Win",
    value,
  ]);
}

export function formatPrimalPanelAmount(value: MoneyMinor): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) return "0.00";
  const digits = value.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function fitSpineTextToBounds(
  textWidth: number,
  textHeight: number,
  bounds: SpineTextBounds,
): number {
  if (!Number.isFinite(textWidth) || !Number.isFinite(textHeight)
    || textWidth <= 0 || textHeight <= 0) return 1;
  return Math.min(1, bounds[2] / textWidth, bounds[3] / textHeight);
}

interface BoundTextField {
  readonly definition: PrimalPanelTextField;
  readonly view: Text;
  fitScale: number;
}

export interface ReadableSpineTextTransform {
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * 将 Spine 骨骼矩阵分解为可读的 Pixi 文本字段。
 *
 * Spine 的 Y 向上到 Pixi 的 Y 向下转换使提供的面板骨骼具有负行列式（通常为 `d === -1`）。区域附件需要该反射，
 * 但将其应用于同级 Pixi 文本会镜像每个字形。动态文本遵循骨骼的动画旋转和缩放幅度，同时故意丢弃坐标系反射。
 */
export function readableSpineTextTransform(
  matrix: Readonly<{ a: number; b: number; c: number; d: number }>,
): ReadableSpineTextTransform {
  return {
    rotation: Math.atan2(matrix.b, matrix.a),
    scaleX: Math.hypot(matrix.a, matrix.b),
    scaleY: Math.hypot(matrix.c, matrix.d),
  };
}

class SpineTextBindingView extends Container {
  constructor(private readonly syncBeforeTransform: () => void) {
    super();
  }

  override updateTransform(): void {
    // AuthoredPanel在此视图之前添加Spine。因此，Pixi 首先推进 Spine 子项，然后此回调在 Text 子项计算其世界变换之前对同一渲染帧进行采样。
    this.syncBeforeTransform();
    super.updateTransform();
  }
}

/**
 * 运行时文本字段是原始引擎中单独的 Pixi 对象。这个桥将它们保持在提供的 Spine 插槽的活骨矩阵和 alpha 上；边界框附件提供精确的动画中心（如果可用）。
 */
export class SpineTextBinding {
  readonly view: Container;
  private readonly point = new Vector2();
  private readonly fields: readonly BoundTextField[];

  constructor(
    private readonly spine: Spine,
    definitions: readonly PrimalPanelTextField[],
  ) {
    this.view = new SpineTextBindingView(() => this.sync());
    this.fields = definitions.map((definition) => {
      const text = new Text(definition.text, primalPanelTextStyle(definition));
      text.anchor.set(0.5);
      text.visible = false;
      this.view.addChild(text);
      return {
        definition,
        view: text,
        fitScale: fitSpineTextToBounds(text.width, text.height, definition.bounds),
      };
    });
    this.sync();
  }

  sync(): void {
    const skeleton = this.spine.skeleton;
    skeleton.updateWorldTransform();
    for (const field of this.fields) {
      const slot = skeleton.findSlot(field.definition.name);
      if (!slot || slot.bone.data.name !== field.definition.bone) {
        field.view.visible = false;
        continue;
      }

      // 介绍文本槽故意没有设置附件。他们预设的边界仍然存在于 `bounds` 下的默认皮肤中，而显示/隐藏剪辑则对插槽 alpha 进行动画处理。解析该附件而不将其分配给插槽，
      // 以便 Pixi Spine 永远不会尝试渲染诊断边界多边形。
      const attachment = (slot.getAttachment()
        ?? skeleton.getAttachment(slot.data.index, "bounds")) as {
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
      } | null;
      if (field.definition.attachmentRequired && attachment === null) {
        field.view.visible = false;
        continue;
      }

      const worldVerticesLength = attachment?.worldVerticesLength ?? 0;
      if (worldVerticesLength >= 2 && attachment?.computeWorldVertices) {
        const worldVertices = new Array<number>(worldVerticesLength);
        attachment.computeWorldVertices(slot, 0, worldVerticesLength, worldVertices, 0, 2);
        const centre = centreOfVertices(worldVertices);
        field.view.position.set(centre.x, centre.y);
      } else if (attachment?.vertices && attachment.vertices.length >= 2) {
        const centre = centreOfVertices(attachment.vertices);
        this.point.set(centre.x, centre.y);
        slot.bone.localToWorld(this.point);
        field.view.position.set(this.point.x, this.point.y);
      } else {
        field.view.position.set(slot.bone.worldX, slot.bone.worldY);
      }

      const transform = readableSpineTextTransform(slot.bone.matrix);
      field.view.rotation = transform.rotation;
      field.view.scale.set(
        field.fitScale * transform.scaleX,
        field.fitScale * transform.scaleY,
      );
      field.view.alpha = slot.color.a * skeleton.color.a;
      field.view.visible = field.view.alpha > 0.001;
    }
  }

  setText(name: string, value: string): void {
    const field = this.fields.find(({ definition }) => definition.name === name);
    if (!field || field.view.text === value) return;
    field.view.text = value;
    field.view.scale.set(1);
    field.fitScale = fitSpineTextToBounds(
      field.view.width,
      field.view.height,
      field.definition.bounds,
    );
    this.sync();
  }
}

export function centreOfVertices(vertices: ArrayLike<number>): { x: number; y: number } {
  if (vertices.length < 2) return { x: 0, y: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < vertices.length; index += 2) {
    const x = vertices[index];
    const y = vertices[index + 1];
    if (x === undefined || y === undefined) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

function materializeFields(
  templates: readonly PrimalPanelTextFieldTemplate[],
  values: readonly string[],
): readonly PrimalPanelTextField[] {
  return Object.freeze(templates.map((template, index) => Object.freeze({
    ...template,
    text: values[index] ?? "",
  })));
}

function wheelPrizeLabel(event: WheelAwardedEvent): string {
  const raw = (event.prize ?? event.outcome).trim().toUpperCase().replace(/_2X$/, "");
  switch (raw.replace(/[\s-]+/g, "_")) {
    case "EXPANSION":
    case "KONG_QUEST":
      return "KONG QUEST";
    case "OVERDRIVE":
    case "KING_SPIN":
      return "KING SPIN";
    default:
      return raw.replace(/_/g, " ");
  }
}

function primalPanelTextStyle(fieldValue: PrimalPanelTextField): TextStyle {
  const base: Partial<ITextStyle> = {
    align: "center",
    fill: 0xffffff,
    fontFamily: "PrimalRampage, Kanit, Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
    fontSize: fieldValue.size,
    fontWeight: "900",
    lineJoin: "round",
    wordWrap: fieldValue.wrap,
    wordWrapWidth: fieldValue.bounds[2],
  };
  switch (fieldValue.style) {
    case "counter":
      return new TextStyle({ ...base, stroke: 0x000000, strokeThickness: 8 });
    case "description":
      return new TextStyle({ ...base, fill: 0x000000 });
    case "flame":
      return new TextStyle({
        ...base,
        fill: [0xca3727, 0xce7526],
        fillGradientStops: [0.55, 0.875],
        stroke: 0x000000,
        strokeThickness: 8,
        dropShadow: true,
        dropShadowColor: 0x170606,
        dropShadowAngle: Math.PI / 2,
        dropShadowDistance: 10,
        dropShadowBlur: 3,
      });
    case "silver-thick":
    case "silver":
      return new TextStyle({
        ...base,
        fill: [0xffffff, 0x727e9c, 0xffffff, 0x9fa6be, 0x94b1c3],
        fillGradientStops: [0.33, 0.38, 0.75, 0.8, 1],
        stroke: 0x22140e,
        strokeThickness: fieldValue.style === "silver-thick" ? 10 : 6,
        dropShadow: true,
        dropShadowColor: fieldValue.style === "silver-thick" ? 0x1d2f2f : 0x122f2f,
        dropShadowAngle: Math.PI / 2,
        dropShadowDistance: fieldValue.style === "silver-thick" ? 5 : 20,
        dropShadowBlur: 0,
      });
  }
}
