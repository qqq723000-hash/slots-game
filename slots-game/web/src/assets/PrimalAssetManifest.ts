import type { SymbolId } from "../app/state/types";
import { publicAssetUrl } from "./publicAssetUrl";

const ROOT = publicAssetUrl("assets/primal-reference");
const RUNTIME_ROOT = publicAssetUrl("assets/primal-runtime");

export const PRIMAL_ASSETS = Object.freeze({
  controls: {
    spin: `${ROOT}/10001.svg`,
    spinGlow: `${ROOT}/10002.svg`,
    continue: `${ROOT}/10003.svg`,
    stop: `${ROOT}/10004.svg`,
    settings: `${ROOT}/10005.svg`,
    autoplay: `${ROOT}/10006.svg`,
    balance: `${ROOT}/10007.svg`,
    bet: `${ROOT}/10008.svg`,
    sound: `${ROOT}/10009.svg`,
  },
  symbols: {
    q: `${ROOT}/10012.png`,
    k: `${ROOT}/10013.png`,
    helmet: `${ROOT}/10014.png`,
    radio: `${ROOT}/10015.png`,
    tank: `${ROOT}/10016.png`,
    jet: `${ROOT}/10017.png`,
    rage: `${ROOT}/10028.png`,
    vault: `${ROOT}/10031.png`,
    wild: `${ROOT}/10038.png`,
    wildX2: `${ROOT}/10037.png`,
    wildX3: `${ROOT}/10036.png`,
    wildX5: `${ROOT}/10035.png`,
    wildX10: `${ROOT}/10034.png`,
    wildX25: `${ROOT}/10033.png`,
    wildX50: `${ROOT}/wild-x50.png`,
    wildX100: `${ROOT}/10032.png`,
  },
  features: {
    expandedReels: `${ROOT}/10025.png`,
    wheelBlue: `${ROOT}/10023.png`,
    wheelRed: `${ROOT}/10026.png`,
    wheelDual: `${ROOT}/10027.png`,
    vaultGrand: `${ROOT}/10020.png`,
    vaultX1: `${ROOT}/10021.png`,
    vaultOpen: `${ROOT}/10022.png`,
    vaultExtraSpin: `${ROOT}/10024.png`,
    vaultStrike: `${ROOT}/10029.png`,
    vaultGrab: `${ROOT}/10030.png`,
    energyFrames: `${ROOT}/10039.png`,
    smokeBurst: `${ROOT}/10018.png`,
  },
  atlases: {
    promotional: `${RUNTIME_ROOT}/interface/feature_preview_texture0_level1.avif`,
    environment: `${RUNTIME_ROOT}/spine/spine_background/spine_background_level1.avif`,
    environmentPieces: `${RUNTIME_ROOT}/spine/spine_background/spine_background_level1_2.avif`,
    characterAndSymbols: `${RUNTIME_ROOT}/spine/spine_symbols/spine_symbols_level1_3.avif`,
    particles: `${ROOT}/10059.avif`,
  },
});

/** 用户提供的 Primal Rampage 启动标志在图集中的精确帧。 / English: The exact frame at which the user-supplied Primal Rampage launch flag is in the atlas. */
export const PRIMAL_LOGO_REGION = Object.freeze({
  x: 0,
  y: 1_470,
  width: 260,
  height: 162,
});

export const SYMBOL_ASSET_BY_ID: Readonly<Record<SymbolId, string>> = Object.freeze({
  ORBIT: PRIMAL_ASSETS.symbols.k,
  PRISM: PRIMAL_ASSETS.symbols.q,
  PULSE: PRIMAL_ASSETS.symbols.helmet,
  NOVA: PRIMAL_ASSETS.symbols.radio,
  CIRCUIT: PRIMAL_ASSETS.symbols.jet,
  TANK: PRIMAL_ASSETS.symbols.tank,
  WILD: PRIMAL_ASSETS.symbols.wild,
  VAULT: PRIMAL_ASSETS.symbols.vault,
  SURGE: PRIMAL_ASSETS.symbols.rage,
});

/** 显示 Wild 前必须已驻留内存的全部官方倍率变体。 / English: All official multiplier variants that must be resident in memory before showing Wild. */
export const WILD_MULTIPLIER_ASSETS = Object.freeze([
  PRIMAL_ASSETS.symbols.wildX2,
  PRIMAL_ASSETS.symbols.wildX3,
  PRIMAL_ASSETS.symbols.wildX5,
  PRIMAL_ASSETS.symbols.wildX10,
  PRIMAL_ASSETS.symbols.wildX25,
  PRIMAL_ASSETS.symbols.wildX50,
  PRIMAL_ASSETS.symbols.wildX100,
]);

export function wildAssetForMultiplier(multiplier: number | undefined): string {
  switch (multiplier) {
    case 2: return PRIMAL_ASSETS.symbols.wildX2;
    case 3: return PRIMAL_ASSETS.symbols.wildX3;
    case 5: return PRIMAL_ASSETS.symbols.wildX5;
    case 10: return PRIMAL_ASSETS.symbols.wildX10;
    case 25: return PRIMAL_ASSETS.symbols.wildX25;
    case 50: return PRIMAL_ASSETS.symbols.wildX50;
    case 100: return PRIMAL_ASSETS.symbols.wildX100;
    default: return PRIMAL_ASSETS.symbols.wild;
  }
}

export const CRITICAL_PRIMAL_ASSETS = Object.freeze([
  PRIMAL_ASSETS.atlases.environment,
  ...Object.values(SYMBOL_ASSET_BY_ID),
]);

/** 背景图集的源空间区域；两张背景板共同组成垂直相机轨道。 / English: The source space area of ​​the background atlas; the two background plates together form the vertical camera track. */
export const ENVIRONMENT_REGIONS = Object.freeze({
  // 两张相机背景板之间保留了 2 像素的图集隔离带。 / English: A 2-pixel album buffer is maintained between the two camera background plates.
  daylight: Object.freeze({ x: 2, y: 0, width: 1_434, height: 2_676 }),
  destroyed: Object.freeze({ x: 1_438, y: 0, width: 1_434, height: 2_676 }),
});

/** 在角色与符号图集源空间中实测得到的角色裁剪区域。 / English: Measured character clipping areas in character and symbol atlas source space. */
export const CHARACTER_REGIONS = Object.freeze({
  torso: Object.freeze({ x: 0, y: 2_200, width: 420, height: 490 }),
  head: Object.freeze({ x: 2_525, y: 1_788, width: 180, height: 165 }),
});

/** 两张垂直环境背景板共用的源空间相机停靠位置。 / English: Source space camera docking position shared by two vertical environment background plates. */
export const ENVIRONMENT_VIEW = Object.freeze({
  baseSourceY: 720,
  expandedSourceY: 0,
});

export const ENERGY_FRAME_GRID = Object.freeze({
  columns: 8,
  rows: 6,
  frameWidth: 206,
  frameHeight: 206,
  firstVisibleFrame: 1,
  revealLastFrame: 29,
  loopFirstFrame: 30,
  loopLastFrame: 45,
});
