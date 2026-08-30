// @ts-nocheck -- 仅在 Node 中运行、可感知裁剪的真实 Spine 与滤镜帧校验器。 / English: @ts-nocheck -- A true clipping-aware Spine and filter frame checker that only runs in Node.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TextureAtlas } from "@pixi-spine/base";
import {
  AtlasAttachmentLoader,
  ClippingAttachment,
  SkeletonBinary,
  Spine,
} from "@pixi-spine/runtime-4.1";
import { BaseTexture, Container } from "pixi.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE,
  PRIMAL_REEL_PERSPECTIVE_DEPTH,
  PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH,
} from "../src/reels/ReelPerspectiveFilter";
import { REEL_STAGE_X, REEL_STAGE_Y } from "../src/reels/ReelSetView";

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

describe("Pass44 real Base-reel perspective runtime", () => {
  it("uses clip-aware stop bounds and the DPR2-equivalent local filter frame", async () => {
    const directory = resolve(process.cwd(), "public/assets/primal-runtime/spine/spine_symbols");
    const atlas = await loadAtlas(readFileSync(resolve(directory, "spine_symbols.atlas"), "utf8"));
    const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas)).readSkeletonData(
      new Uint8Array(readFileSync(resolve(directory, "reel_frame.skel"))),
    );
    const frame = new Spine(data);
    frame.stateData.defaultMix = 0.15;
    frame.state.setAnimation(0, "stop", false);
    frame.autoUpdate = false;
    frame.update(0);
    frame.skeleton.findBone("mover")!.y = 250;
    frame.skeleton.updateWorldTransform();

    const local = frame.getLocalBounds();
    expect(local.x).toBeCloseTo(-494.6100158691406, 5);
    expect(local.y).toBeCloseTo(-331.5799865722656, 5);
    expect(local.width).toBeCloseTo(989.2200317382812, 5);
    expect(local.height).toBeCloseTo(712.5199890136719, 5);

    const clipSlot = frame.skeleton.findSlot("reel_bg_mask")!;
    const clip = clipSlot.getAttachment() as ClippingAttachment;
    expect(clip.endSlot?.name).toBe("normal/reel/half_chain_bottom_right21");
    expect(frame.skeleton.drawOrder.indexOf(clipSlot)).toBe(7);
    expect(frame.skeleton.drawOrder.indexOf(frame.skeleton.slots[clip.endSlot!.index])).toBe(34);
    expect(clipSlot.clippingContainer.children.map((child: unknown) => (
      frame.slotContainers.indexOf(child as Container)
    ))).toEqual(Array.from({ length: 27 }, (_, index) => index + 8));

    frame.scale.set(0.57 * 1.01);
    frame.position.set((747 * 0.57) / 2, 240 * 0.57);
    const reel = new Container();
    reel.position.set(REEL_STAGE_X, REEL_STAGE_Y);
    reel.addChild(frame);
    const raw = reel.getBounds();
    expect(raw.x).toBeCloseTo(355.2530212402344, 5);
    expect(raw.y).toBeCloseTo(212.49749755859375, 5);
    expect(raw.width).toBeCloseTo(569.4939880371094, 5);
    expect(raw.height).toBeCloseTo(410.19775390625, 5);
    const sourceFrame = raw.clone().ceil(2);
    expect([
      sourceFrame.x,
      sourceFrame.y,
      sourceFrame.width,
      sourceFrame.height,
    ]).toEqual([355, 212, 570, 411]);

    expect(PRIMAL_REEL_PERSPECTIVE_DEPTH).toBe(1.5);
    expect(PRIMAL_REEL_PERSPECTIVE_COORDINATE_SCALE).toBe(2);
    expect(PRIMAL_REEL_PERSPECTIVE_EFFECTIVE_DEPTH).toBe(3);

    frame.destroy({ children: true });
    atlas.dispose();
  });
});
