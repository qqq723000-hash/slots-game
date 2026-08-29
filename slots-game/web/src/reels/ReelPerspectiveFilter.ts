import { Filter } from "pixi.js";

export interface ReelPerspectiveFilterDiagnostics {
  readonly appliedFrames: number;
  readonly sourceFrame: Readonly<{ x: number; y: number; width: number; height: number }> | null;
}

/** Primal Rampage 的 `Bg` 卷轴过滤器提供精确透视默认值。 / English: Primal Rampage's `Bg` scroll filter provides precise perspective defaults. */
export const PRIMAL_REEL_PERSPECTIVE_ANGLE = [0, -0.1] as const;
export const PRIMAL_REEL_PERSPECTIVE_DEPTH = 1.5;
/** 官方场景/滤镜坐标加倍为 DPR2；本地 Pixi 保留 CSS 单位。 / English: Official scene/filter coordinates doubled to DPR2; native Pixi retains CSS units. */
export const PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE = 2;
export const PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH =
  PRIMAL_REEL_PERSPECTIVE_DEPTH * PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE;

export function primalReelPerspectiveCoordinateScale(coordinateScale: number): number {
  return Number.isFinite(coordinateScale)
    ? Math.min(PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE, Math.max(1, coordinateScale))
    : PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE;
}

export function primalReelPerspectiveEffectiveDepth(coordinateScale: number): number {
  return PRIMAL_REEL_PERSPECTIVE_DEPTH
    * primalReelPerspectiveCoordinateScale(coordinateScale);
}

/**
 * 捕获的游戏包中两个着色器阶段使用的共享源。保持VIEWPORT分支完整：它是官方运行时启用的路径，并产生箱体的窄顶/宽底投影。
 *
 * 英文 / English: Captured shared source used by two shader stages in the game package. Keep the VIEWPORT branch intact: it is the official runtime-enabled path and produces the narrow top/wide bottom projection of the box.
 */
export const PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE = `// @render filter
precision lowp float;
varying vec2 vTexCoord;
#ifdef VERTEX
attribute vec2 aVertexPosition;
uniform vec4 inputSize;
uniform vec4 outputFrame;
uniform mat3 projectionMatrix;
// @slider -3.15 3.15 0.01 (0 0.8) angle
uniform vec2 uAngle;
// @slider 0 10 0.01 1.5 depth
uniform float uDepth;
#define VIEWPORT 1
void main() {
	#if VIEWPORT
		vec2 position = aVertexPosition * outputFrame.zw;
		vTexCoord = position * inputSize.zw;
		position += outputFrame.xy;
		float depth = dot(position, 0.001 * uDepth * sin(uAngle));
		position = position * cos(uAngle);
		vec3 projected = projectionMatrix * vec3(position, 1);
		gl_Position = vec4(projected.xy, 0, 1.0 + depth);
	#else // VIEWPORT
		vec2 position = aVertexPosition * outputFrame.zw;
		vTexCoord = position * inputSize.zw;
		position -= 0.5 * outputFrame.zw;
		// 以画面中心为基准手动计算透视效果 / English: Manually calculate the perspective effect based on the center of the screen
		float depth = 1.0 + dot(position, 0.001 * uDepth * sin(uAngle));
		position = position * cos(uAngle) / depth;
		position = position + 0.5 * outputFrame.zw + outputFrame.xy;
		vec3 projected = projectionMatrix * vec3(position, 1);
		// 右侧插值依赖该深度修正 / English: The right interpolation relies on this depth correction
		gl_Position = vec4(projected.xy * depth, 0, depth);
	#endif // VIEWPORT
}
#else // VERTEX
// @image clamp clamp linear ../images/Symbols.png
uniform sampler2D uSampler;
void main() {
	gl_FragColor = texture2D(uSampler, vTexCoord);
}
#endif // VERTEX

`;

export const PRIMAL_REEL_PERSPECTIVE_VERTEX_SOURCE =
  `#define VERTEX\n${PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE}`;

export const PRIMAL_REEL_PERSPECTIVE_FRAGMENT_SOURCE =
  `#define FRAGMENT\n${PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE}`;

/**
 * 完整卷轴层次结构使用的官方后合成投影。调用者拥有它的安装位置；该类有意没有显示树知识，因此它不会意外地投影各个卷轴层。
 *
 * 英文 / English: The official post-compositing projection used by the full reel hierarchy. The caller owns where it is mounted; the class intentionally does not show tree knowledge so it does not accidentally project individual scroll layers.
 */
export class ReelPerspectiveFilter extends Filter {
  private appliedFrames = 0;
  private sourceFrame: ReelPerspectiveFilterDiagnostics["sourceFrame"] = null;

  constructor() {
    super(
      PRIMAL_REEL_PERSPECTIVE_VERTEX_SOURCE,
      PRIMAL_REEL_PERSPECTIVE_FRAGMENT_SOURCE,
      {
        uAngle: [...PRIMAL_REEL_PERSPECTIVE_ANGLE],
        uDepth: PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH,
      },
    );
    this.setCoordinateScale(PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE);
  }

  /** 将投影数学和离屏目标与物理 DPR 域相匹配。 / English: Match projection math and off-screen targets to physical DPR domains. */
  setCoordinateScale(coordinateScale: number): void {
    const safeScale = primalReelPerspectiveCoordinateScale(coordinateScale);
    this.uniforms.uDepth = PRIMAL_REEL_PERSPECTIVE_DEPTH * safeScale;
    this.resolution = safeScale;
  }

  override apply(...args: Parameters<Filter["apply"]>): void {
    this.appliedFrames += 1;
    const state = args[4];
    if (state) {
      const { x, y, width, height } = state.sourceFrame;
      this.sourceFrame = Object.freeze({ x, y, width, height });
    }
    super.apply(...args);
  }

  diagnostics(): ReelPerspectiveFilterDiagnostics {
    return Object.freeze({
      appliedFrames: this.appliedFrames,
      sourceFrame: this.sourceFrame,
    });
  }
}
