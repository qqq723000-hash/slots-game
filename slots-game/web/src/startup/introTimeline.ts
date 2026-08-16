import type { TimelineCue } from "./Timeline";

// 当 300ms 镀铬显示在 5 秒结束时，GameTransition 解锁桌面控件。背景、角色和预混音频自然地继续。
export const INTRO_DURATION_MS = 5_000;
export const REDUCED_INTRO_DURATION_MS = 200;

/**
 * 计时是根据提供的 Spine/音频源测量的，而不是根据屏幕记录推断的。角色的骨盆拥有完整的下落、冲击和反弹；播放该曲目时，主持人必须保持固定。
 */
export const AUTHORED_INTRO_TIMING_MS = Object.freeze({
  logoEnd: 4_700,
  characterOffscreenEnd: 3_066.667,
  characterImpact: 3_233.3,
  characterCompression: 3_566.667,
  characterSettled: 3_866.667,
  characterEnd: 8_066.701,
  backgroundEnd: 7_300,
  audioEnd: 10_086.19,
  chromeRevealStart: 4_700,
  chromeRevealEnd: 5_000,
} as const);

export const INTRO_CUES: readonly TimelineCue[] = [
  { name: "audio.game-intro", atMs: 0 },
  { name: "city.establish", atMs: 0 },
  { name: "colossus.descent", atMs: AUTHORED_INTRO_TIMING_MS.characterOffscreenEnd },
  { name: "city.impact", atMs: AUTHORED_INTRO_TIMING_MS.characterImpact },
  { name: "colossus.settled", atMs: AUTHORED_INTRO_TIMING_MS.characterSettled },
  { name: "hud.reveal", atMs: AUTHORED_INTRO_TIMING_MS.chromeRevealStart },
  { name: "launch.ready", atMs: AUTHORED_INTRO_TIMING_MS.chromeRevealEnd },
] as const;

export interface IntroFrame {
  worldAlpha: number;
  cameraZoom: number;
  cameraY: number;
  logoAlpha: number;
  logoX: number;
  logoY: number;
  logoScale: number;
  colossusAlpha: number;
  colossusX: number;
  colossusY: number;
  colossusScale: number;
  monsterRevealProgress: number;
  atmosphereProgress: number;
  shockwave: number;
  reelProgress: number;
  hudProgress: number;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));
const progress = (timeMs: number, from: number, to: number): number => clamp((timeMs - from) / (to - from));
const smooth = (value: number): number => value * value * (3 - 2 * value);
export function introFrameAt(timeMs: number): IntroFrame {
  const world = 1;
  const chrome = smooth(progress(
    timeMs,
    AUTHORED_INTRO_TIMING_MS.chromeRevealStart,
    AUTHORED_INTRO_TIMING_MS.chromeRevealEnd,
  ));
  const logoVisible = timeMs < AUTHORED_INTRO_TIMING_MS.logoEnd ? world : 0;

  return {
    worldAlpha: world,
    cameraZoom: 1,
    cameraY: 0,
    logoAlpha: logoVisible,
    logoX: 640,
    logoY: 360,
    logoScale: 0.8,
    // 制作好的 `intro` 身体轨迹从视口上方开始，并自行执行下落。
    // 这些参数刻意不再叠加第二套位移。
    colossusAlpha: world,
    colossusX: 640,
    colossusY: 0,
    colossusScale: 1,
    monsterRevealProgress: world,
    atmosphereProgress: world,
    // 背景/正面 Spine `intro` 包含本机缩放和影响。
    shockwave: 0,
    reelProgress: chrome,
    hudProgress: chrome,
  };
}

export function reducedIntroFrame(progressValue: number): IntroFrame {
  const alpha = smooth(clamp(progressValue));
  const finalFrame = introFrameAt(INTRO_DURATION_MS);
  return {
    ...finalFrame,
    worldAlpha: alpha,
    reelProgress: alpha,
    hudProgress: alpha,
    monsterRevealProgress: finalFrame.monsterRevealProgress * alpha,
    atmosphereProgress: finalFrame.atmosphereProgress * alpha,
    colossusAlpha: finalFrame.colossusAlpha * alpha,
    logoAlpha: finalFrame.logoAlpha * alpha,
    shockwave: finalFrame.shockwave,
  };
}
