// @ts-nocheck -- 仅在 Node 中运行的真实 Spine 几何校验器。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TextureAtlas } from "@pixi-spine/base";
import { AtlasAttachmentLoader, SkeletonBinary, Spine } from "@pixi-spine/runtime-4.1";
import { BaseTexture } from "pixi.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  authoredCollectTrailRotation,
  resolveAuthoredCollectTrailEndpoint,
} from "../src/renderer/FeatureEffects";

class NodeCanvas {
  width = 0;
  height = 0;
  getContext(kind: string): { fillStyle: string; fillRect(): void } | null {
    return kind === "2d" ? { fillStyle: "", fillRect() {} } : null;
  }
}

beforeAll(() => {
  vi.stubGlobal("HTMLCanvasElement", NodeCanvas);
  vi.stubGlobal("HTMLImageElement", class {});
  vi.stubGlobal("HTMLVideoElement", class {});
  vi.stubGlobal("ImageBitmap", class {});
  vi.stubGlobal("SVGElement", class {});
  vi.stubGlobal("document", { createElement: () => new NodeCanvas() });
});

afterAll(() => vi.unstubAllGlobals());

function loadAtlas(text: string): Promise<TextureAtlas> {
  return new Promise((resolveAtlas, reject) => {
    new TextureAtlas(
      text,
      (_page, complete) => complete(new BaseTexture()),
      (atlas) => atlas ? resolveAtlas(atlas) : reject(new Error("atlas parse failed")),
    );
  });
}

describe("Pass44 real Rage collect-trail geometry", () => {
  it("converts Pixi Y through Bone.worldToLocal and keeps the mouth-to-symbol bolt on screen", async () => {
    const directory = resolve(process.cwd(), "public/assets/primal-runtime/spine/spine_ui");
    const atlas = await loadAtlas(readFileSync(resolve(directory, "spine_ui.atlas"), "utf8"));
    const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas)).readSkeletonData(
      new Uint8Array(readFileSync(resolve(directory, "trail.skel"))),
    );
    const trail = new Spine(data);
    trail.autoUpdate = false;
    const source = trail.skeleton.findBone("symbol");
    const target = trail.skeleton.findBone("pps");
    expect(source).toBeTruthy();
    expect(target).toBeTruthy();

    const updateWorld = (): void => trail.skeleton.updateWorldTransform();
    resolveAuthoredCollectTrailEndpoint(source!, { x: 640, y: 306 }, updateWorld);
    resolveAuthoredCollectTrailEndpoint(target!, { x: 640, y: 110 }, updateWorld);
    const rotation = authoredCollectTrailRotation(
      { x: 640, y: 306 },
      { x: 640, y: 110 },
    );
    source!.rotation = rotation;
    target!.rotation = rotation;
    updateWorld();

    expect(source!.x).toBeCloseTo(640, 4);
    expect(source!.y).toBeCloseTo(-306, 4);
    expect(source!.worldX).toBeCloseTo(640, 4);
    expect(source!.worldY).toBeCloseTo(306, 4);
    expect(target!.x).toBeCloseTo(640, 4);
    expect(target!.y).toBeCloseTo(-110, 4);
    expect(target!.worldX).toBeCloseTo(640, 4);
    expect(target!.worldY).toBeCloseTo(110, 4);
    expect(rotation).toBe(90);

    trail.state.setAnimation(0, "collect", false);
    trail.update(0);
    trail.update(0.5);
    const bounds = trail.getLocalBounds();
    expect(bounds.x).toBeCloseTo(520.048767, 5);
    expect(bounds.y).toBeCloseTo(88.130318, 5);
    expect(bounds.width).toBeCloseTo(241.776611, 5);
    expect(bounds.height).toBeCloseTo(239.425926, 5);
    expect(bounds.top).toBeLessThan(110);
    expect(bounds.bottom).toBeGreaterThan(306);

    trail.destroy({ children: true });
    atlas.dispose();
  });
});
