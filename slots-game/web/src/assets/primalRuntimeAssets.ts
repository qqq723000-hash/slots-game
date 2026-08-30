import { publicAssetUrl } from "./publicAssetUrl";

export type PrimalRuntimeAssetChannel = "desktop" | "mobile";
export type PrimalRuntimeSpineGroup =
  | "spine_background"
  | "spine_fps"
  | "spine_symbols"
  | "spine_ui";
export type PrimalRuntimeAudioPackId =
  | "sounds0"
  | "sounds1"
  | "sounds2"
  | "delayed"
  | "common";

export interface PrimalRuntimeAssetProfile {
  readonly channel: PrimalRuntimeAssetChannel;
  readonly textureLevel: 1 | 2;
  readonly spineRoot: string;
  readonly audioRoot: string;
  readonly interfaceRoot: string;
  readonly audioPacks: Readonly<Record<PrimalRuntimeAudioPackId, string>>;
}

const desktopProfile: PrimalRuntimeAssetProfile = Object.freeze({
  channel: "desktop",
  textureLevel: 1,
  spineRoot: publicAssetUrl("assets/primal-runtime/spine"),
  audioRoot: publicAssetUrl("assets/primal-runtime/audio"),
  interfaceRoot: publicAssetUrl("assets/primal-runtime/interface"),
  audioPacks: Object.freeze({
    sounds0: "sounds_desktop_0.m4a",
    sounds1: "sounds_desktop_1.m4a",
    sounds2: "sounds_desktop_2.m4a",
    delayed: "snd_delayed_desktop_0.m4a",
    common: "common_sounds_desktop.mp3",
  }),
});

const mobileProfile: PrimalRuntimeAssetProfile = Object.freeze({
  channel: "mobile",
  textureLevel: 2,
  spineRoot: publicAssetUrl("assets/primal-runtime/mobile/spine"),
  audioRoot: publicAssetUrl("assets/primal-runtime/mobile/audio"),
  interfaceRoot: publicAssetUrl("assets/primal-runtime/mobile/interface"),
  audioPacks: Object.freeze({
    sounds0: "sounds_mobile_0.m4a",
    sounds1: "sounds_mobile_1.m4a",
    sounds2: "sounds_mobile_2.m4a",
    delayed: "snd_delayed_mobile_0.m4a",
    common: "common_sounds_mobile.mp3",
  }),
});

export const PRIMAL_RUNTIME_ASSET_PROFILES = Object.freeze({
  desktop: desktopProfile,
  mobile: mobileProfile,
});

let activeAssetChannel: PrimalRuntimeAssetChannel = "desktop";

/** 启动阶段一次性选择；必须在任何 Spine 或音频加载开始前完成。 / English: A one-time selection during startup; must be completed before any Spine or audio loading begins. */
export function setPrimalRuntimeAssetChannel(channel: PrimalRuntimeAssetChannel): void {
  activeAssetChannel = channel;
}

export function activePrimalRuntimeAssetChannel(): PrimalRuntimeAssetChannel {
  return activeAssetChannel;
}

/**
 * 资产通道必须显式选择。响应式布局可以选用移动配置，但资源加载不得隐式依赖
 * 全局视口状态或初始化先后顺序，否则 DevTools 设备模式切换会混用两套资产。
 *
 * 英文 / English: Asset channels must be selected explicitly. Responsive layout can use mobile configuration, but resource loading must not implicitly depend on the global viewport state or initialization sequence, otherwise DevTools device mode switching will mix two sets of assets.
 */
export function primalRuntimeAssetProfile(
  channel: PrimalRuntimeAssetChannel,
): PrimalRuntimeAssetProfile {
  return PRIMAL_RUNTIME_ASSET_PROFILES[channel];
}

export function primalSpineTextureAtlasUrl(
  group: PrimalRuntimeSpineGroup,
  channel: PrimalRuntimeAssetChannel = "desktop",
): string {
  const profile = primalRuntimeAssetProfile(channel);
  const fileName = channel === "mobile" ? `${group}_level2.atlas` : `${group}.atlas`;
  return `${profile.spineRoot}/${group}/${fileName}`;
}
