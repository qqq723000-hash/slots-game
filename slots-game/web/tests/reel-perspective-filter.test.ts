import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PRIMAL_REEL_PERSPECTIVE_ANGLE,
  PRIMAL_REEL_PERSPECTIVE_DEPTH,
  PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE,
  PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH,
  PRIMAL_REEL_PERSPECTIVE_FRAGMENT_SOURCE,
  PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE,
  PRIMAL_REEL_PERSPECTIVE_VERTEX_SOURCE,
  ReelPerspectiveFilter,
  primalReelPerspectiveCoordinateScale,
  primalReelPerspectiveEffectiveDepth,
} from "../src/reels/ReelPerspectiveFilter";

const previousDocument = Reflect.get(globalThis, "document");

beforeAll(() => {
  Reflect.set(globalThis, "document", {
    createElement: () => ({ getContext: () => null }),
  });
});

afterAll(() => {
  if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
  else Reflect.set(globalThis, "document", previousDocument);
});

describe("official Primal reel perspective filter", () => {
  it("uses the captured angle and depth defaults", () => {
    const filter = new ReelPerspectiveFilter();

    expect(PRIMAL_REEL_PERSPECTIVE_ANGLE).toEqual([0, -0.1]);
    expect(PRIMAL_REEL_PERSPECTIVE_DEPTH).toBe(1.5);
    expect(PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE).toBe(2);
    expect(PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH).toBe(3);
    expect(filter.uniforms.uAngle).toEqual([0, -0.1]);
    expect(filter.uniforms.uDepth).toBe(3);
    expect(filter.resolution).toBe(2);
    expect(primalReelPerspectiveEffectiveDepth(1)).toBe(1.5);
    expect(primalReelPerspectiveEffectiveDepth(2)).toBe(3);
    expect(primalReelPerspectiveEffectiveDepth(3)).toBe(3);
    expect(primalReelPerspectiveCoordinateScale(1)).toBe(1);
    expect(primalReelPerspectiveCoordinateScale(2)).toBe(2);
    expect(primalReelPerspectiveCoordinateScale(3)).toBe(2);
    expect(primalReelPerspectiveCoordinateScale(Number.NaN)).toBe(2);

    filter.setCoordinateScale(1);
    expect(filter.uniforms.uDepth).toBe(1.5);
    expect(filter.resolution).toBe(1);

    filter.setCoordinateScale(2);
    expect(filter.uniforms.uDepth).toBe(3);
    expect(filter.resolution).toBe(2);

    filter.setCoordinateScale(3);
    expect(filter.uniforms.uDepth).toBe(3);
    expect(filter.resolution).toBe(2);

    const nonFiniteScales = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const nonFiniteScale of nonFiniteScales) {
      filter.setCoordinateScale(nonFiniteScale);
      expect(filter.uniforms.uDepth).toBe(3);
      expect(filter.resolution).toBe(2);
    }
  });

  it("compiles the exact shared program as separate vertex and fragment stages", () => {
    expect(PRIMAL_REEL_PERSPECTIVE_VERTEX_SOURCE).toBe(
      `#define VERTEX\n${PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE}`,
    );
    expect(PRIMAL_REEL_PERSPECTIVE_FRAGMENT_SOURCE).toBe(
      `#define FRAGMENT\n${PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE}`,
    );

    expect(PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE).toContain("#define VIEWPORT 1");
    expect(PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE).toContain(
      "float depth = dot(position, 0.001 * uDepth * sin(uAngle));",
    );
    expect(PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE).toContain(
      "gl_Position = vec4(projected.xy, 0, 1.0 + depth);",
    );
    expect(PRIMAL_REEL_PERSPECTIVE_SHADER_SOURCE).toContain(
      "gl_FragColor = texture2D(uSampler, vTexCoord);",
    );

    const filter = new ReelPerspectiveFilter();
    expect(filter.program.vertexSrc).toContain(PRIMAL_REEL_PERSPECTIVE_VERTEX_SOURCE.trim());
    expect(filter.program.fragmentSrc).toContain(
      PRIMAL_REEL_PERSPECTIVE_FRAGMENT_SOURCE.trim(),
    );
  });

  it("does not share its mutable vec2 uniform between filter instances", () => {
    const first = new ReelPerspectiveFilter();
    const second = new ReelPerspectiveFilter();

    expect(first.uniforms.uAngle).not.toBe(second.uniforms.uAngle);
    first.uniforms.uAngle[1] = -0.25;
    expect(second.uniforms.uAngle).toEqual([0, -0.1]);
  });
});
