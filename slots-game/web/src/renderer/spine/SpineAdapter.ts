import { Spine } from "@pixi-spine/runtime-4.1";
import { BLEND_MODES } from "pixi.js";

/**
 * 所提供的 Spine 4.1 动画数据的单个集成接口。将运行时导入保留在此处可以防止渲染器模块依赖于解析器内部，并避免通用加载器的全局插件副作用。
 *
 * 英文 / English: Provides a single integrated interface for Spine 4.1 animation data. Keeping the runtime imports here prevents the renderer module from relying on parser internals and avoids the global plugin side effects of the universal loader.
 */
export type SpineData = ConstructorParameters<typeof Spine>[0];

/** 原始共享 Spine 包装器默认值 (`defaultCrossfadeTime=.15`)。 / English: Raw shared Spine wrapper default value (`defaultCrossfadeTime=.15`). */
export const SPINE_DEFAULT_MIX_SECONDS = 0.15;

export interface PrimalAdditiveBlendOptions {
  /**
   * 符号导出有时仅在其地图集区域名称中编码 ADD，而预设的城市背景对普通 RGB 车牌使用 `add/normal_*` 名称。因此，
   * 后台调用者选择退出并信任 Spine 插槽数据。
   *
   * 英文 / English: Symbol exports sometimes only encode ADD in their atlas area names, while preset city backgrounds use `add/normal_*` names for normal RGB license plates. Therefore, the background caller opts out and trusts the Spine slot data.
   */
  regionAdditiveFallback?: boolean;
}

export interface SpineViewOptions extends PrimalAdditiveBlendOptions {
  animation?: string;
  loop?: boolean;
  timeScale?: number;
  defaultMix?: number;
}

type PrimalBlendSlot = Spine["skeleton"]["slots"][number];

function primalBlendSlots(view: Spine | null): readonly PrimalBlendSlot[] {
  if (!view) return [];
  const slots = view.skeleton?.slots;
  if (!slots || typeof slots[Symbol.iterator] !== "function") return [];
  return slots;
}

/**
 * 运送的图集路径对于不透明的黑色为零页面具有权威性，而一小部分普通页面附件（头盔文本/无线电屏幕）在插槽本身上声明 ADD。保持每个通道共享谓词，这样附件就不会被两个组合渲染。
 *
 * 英文 / English: The shipped gallery path is authoritative for opaque black zero pages, while a small set of normal page attachments (helmet text/radio screens) declare ADD on the slot itself. Keep each channel sharing the predicate so that attachments are not rendered by both combinations.
 */
export function isPrimalAdditiveSlot(
  slot: PrimalBlendSlot,
  options: PrimalAdditiveBlendOptions = {},
): boolean {
  const attachment = slot.getAttachment() as null | {
    region?: null | { name?: string };
  };
  return slot.data.blendMode === BLEND_MODES.ADD
    || (options.regionAdditiveFallback !== false
      && attachment?.region?.name?.startsWith("add/") === true);
}

export function createSpineView(data: SpineData, options: SpineViewOptions = {}): Spine {
  const view = new Spine(data);
  const blendOptions: PrimalAdditiveBlendOptions = {
    regionAdditiveFallback: options.regionAdditiveFallback,
  };
  // Spine 可以在*任何*更新期间交换附件，包括 Pixi 拥有的 autoUpdate 蜱。 / English: Spine can swap attachments during *any* update, including the autoUpdate tick that Pixi has.
  // 几张分派的 Primal 图集在不透明的黑色 RGB 页面 (`add/...`) 上保留附加光线， / English: Several assigned Primal albums retain additional rays on opaque black RGB pages (`add/...`),
  // 因此在 NORMAL 混合处留下一个新交换的插槽会在其他正确的闪电后面产生矩形黑色阴影。在适配器边界保持这一不变性， / English: So leaving a newly swapped slot at the NORMAL blend will create a rectangular black shadow behind the otherwise correct lightning. Keep this invariant across adapter boundaries,
  // 而不是依赖每个单独的庆祝活动、轮子、HUD 或角色调用者来记住更新后修复。 / English: Rather than relying on each individual celebration, wheel, HUD, or character caller to remember post-update fixes.
  const spineUpdate = view.update.bind(view);
  view.update = (deltaTime: number): void => {
    spineUpdate(deltaTime);
    enforcePrimalRegionBlendModes(view, blendOptions);
  };
  const requestedDefaultMix = options.defaultMix ?? SPINE_DEFAULT_MIX_SECONDS;
  view.stateData.defaultMix = Number.isFinite(requestedDefaultMix)
    ? Math.max(0, requestedDefaultMix)
    : SPINE_DEFAULT_MIX_SECONDS;
  view.state.timeScale = options.timeScale ?? 1;
  if (options.animation) view.state.setAnimation(0, options.animation, options.loop ?? true);
  // 在第一次显式更新或自动更新之前，还要覆盖设置姿势中已存在的附件。 / English: Attachments that already exist in the set pose are also overwritten before the first explicit update or automatic update.
  enforcePrimalRegionBlendModes(view, blendOptions);
  return view;
}

/**
 * 资产管线将叠加帧存储在不透明的 RGB 图集页面上，并通过 `add/` 区域路径编码预期材质。导出的二进制文件可以将这些插槽标记为 NORMAL，
 * 因此附件交换必须在绘制之前重新声明 Spine 插槽和 Pixi 的当前可渲染内容上的材质。
 *
 * 英文 / English: The asset pipeline stores the overlay frame on an opaque RGB atlas page and encodes the expected material via the `add/` zone path. Exported binaries can mark these slots as NORMAL, so attachment swapping must re-declare the Spine slots and materials on Pixi's current renderable content before drawing.
 */
export function enforcePrimalRegionBlendModes(
  view: Spine | null,
  options: PrimalAdditiveBlendOptions = {},
): number {
  let additive = 0;
  for (const slot of primalBlendSlots(view)) {
    const blendMode = isPrimalAdditiveSlot(slot, options)
      ? BLEND_MODES.ADD
      : slot.data.blendMode;
    slot.blendMode = blendMode;
    const renderSlot = slot as typeof slot & {
      currentSprite?: { blendMode: number };
      currentMesh?: { blendMode: number };
    };
    if (renderSlot.currentSprite) renderSlot.currentSprite.blendMode = blendMode;
    if (renderSlot.currentMesh) renderSlot.currentMesh.blendMode = blendMode;
    if (blendMode === BLEND_MODES.ADD) additive += 1;
  }
  return additive;
}

/**
 * 将共享 Spine 拆分为普通渲染通道和附加渲染通道。当不透明的黑色为零图集在其 ADD 混合到达场景帧缓冲区之前被 Pixi 过滤器展平时，将使用此方法。
 *
 * 英文 / English: Split the shared spine into normal and additional render passes. This method is used when the opaque black zero atlas is flattened by the Pixi filter before its ADD blend reaches the scene framebuffer.
 */
export function partitionPrimalAdditiveSlots(
  view: Spine | null,
  pass: "normal" | "additive",
  options: PrimalAdditiveBlendOptions = {},
): number {
  let visible = 0;
  for (const slot of primalBlendSlots(view)) {
    const attachment = slot.getAttachment() as null | {
      region?: null | { name?: string };
    };
    const additive = isPrimalAdditiveSlot(slot, options);
    // Pixi-Spine 可以在时间线清除其附件后保留最后一个 Sprite/Mesh 实例。 / English: Pixi-Spine can retain the last Sprite/Mesh instance after the timeline clears its attachments.
    // 永远不要仅仅因为它属于此通道而恢复陈旧的纹理：这样做会在动态过渡期间将完整的图集图块泄漏为明亮（或黑色）矩形。 / English: Never restore a stale texture just because it belongs to this channel: doing so will leak full atlas tiles as bright (or black) rectangles during dynamic transitions.
    const renderable = attachment !== null && (pass === "additive" ? additive : !additive);
    const renderSlot = slot as typeof slot & {
      currentSprite?: { blendMode: number; renderable: boolean };
      currentMesh?: { blendMode: number; renderable: boolean };
    };
    if (renderSlot.currentSprite) renderSlot.currentSprite.renderable = renderable;
    if (renderSlot.currentMesh) renderSlot.currentMesh.renderable = renderable;
    // 返回值描述活动附件，而不是休眠槽定义。因此，Q/K 正确报告零附加输出。 / English: The return value describes the active attachment, not the dormant slot definition. Therefore, Q/K correctly reports zero additional output.
    if (attachment && renderable) visible += 1;
  }
  return visible;
}

/** 将单个 Spine 恢复为其普通的单通道渲染能力。 / English: Returns a single Spine to its normal single-pass rendering capabilities. */
export function restorePrimalSlotRenderability(view: Spine | null): number {
  let visible = 0;
  for (const slot of primalBlendSlots(view)) {
    const attachment = slot.getAttachment();
    const renderSlot = slot as typeof slot & {
      currentSprite?: { renderable: boolean };
      currentMesh?: { renderable: boolean };
    };
    const renderable = attachment !== null;
    if (renderSlot.currentSprite) renderSlot.currentSprite.renderable = renderable;
    if (renderSlot.currentMesh) renderSlot.currentMesh.renderable = renderable;
    if (attachment) visible += 1;
  }
  return visible;
}

export { Spine };
