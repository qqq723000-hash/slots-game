// @ts-nocheck -- 仅在 Node 中运行，用于校验冻结版 Jackpot Spine 二进制文件。 / English: @ts-nocheck -- Runs in Node only, used to check frozen Jackpot Spine binaries.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { TextureAtlas } from "@pixi-spine/base";
import {
  AnimationState,
  AnimationStateData,
  AtlasAttachmentLoader,
  Skeleton,
  SkeletonBinary,
} from "@pixi-spine/runtime-4.1";
import { BaseTexture } from "pixi.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SPINE_DIRECTORY = resolve(
  process.cwd(),
  "public/assets/primal-runtime/spine/spine_ui",
);
const TIERS = ["grand", "mega", "major", "minor", "mini"] as const;

let atlas: TextureAtlas;

function loadAtlas(text: string): Promise<TextureAtlas> {
  return new Promise((resolveAtlas, reject) => {
    new TextureAtlas(
      text,
      (_page, complete) => complete(new BaseTexture()),
      (loaded) => loaded
        ? resolveAtlas(loaded)
        : reject(new Error("Jackpot Spine atlas parse failed")),
    );
  });
}

function readTier(tier: typeof TIERS[number]) {
  const bytes = readFileSync(resolve(SPINE_DIRECTORY, `${tier}_jackpot.skel`));
  return new SkeletonBinary(new AtlasAttachmentLoader(atlas))
    .readSkeletonData(new Uint8Array(bytes));
}

function advance(
  state: AnimationState,
  skeleton: Skeleton,
  durationSeconds: number,
): void {
  for (let elapsed = 0; elapsed < durationSeconds; elapsed += 1 / 60) {
    state.update(1 / 60);
    state.apply(skeleton);
    skeleton.updateWorldTransform({ x: 0, y: 0 });
  }
}

function visibleAttachments(skeleton: Skeleton): readonly string[] {
  return skeleton.slots.flatMap((slot, index) => {
    const attachment = slot.getAttachment();
    return attachment && slot.color.a > 0.0001
      ? [`${index}:${slot.data.name}:${attachment.name}`]
      : [];
  });
}

function recoveredAttachments(
  tier: typeof TIERS[number],
  replacement: "clear" | "empty",
): readonly string[] {
  const data = readTier(tier);
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));

  state.setAnimation(0, "win_shooting", false);
  state.addAnimation(0, "loop", true, 0);
  advance(state, skeleton, 2.5);

  if (replacement === "empty") state.setEmptyAnimation(0, 0.15);
  else state.clearTrack(0);
  const show = state.setAnimation(0, "show", false);
  show.mixDuration = 0.8;
  advance(state, skeleton, 3);

  return visibleAttachments(skeleton);
}

function cleanShowAttachments(tier: typeof TIERS[number]): readonly string[] {
  const data = readTier(tier);
  const skeleton = new Skeleton(data);
  const state = new AnimationState(new AnimationStateData(data));
  const show = state.setAnimation(0, "show", false);
  show.mixDuration = 0.8;
  advance(state, skeleton, 3);
  return visibleAttachments(skeleton);
}

describe("Pass 92 real Jackpot track-replacement evidence", () => {
  beforeAll(async () => {
    atlas = await loadAtlas(readFileSync(
      resolve(SPINE_DIRECTORY, "spine_ui.atlas"),
      "utf8",
    ));
  });

  afterAll(() => atlas.dispose());

  it.each(TIERS)(
    "%s replaces every award-only attachment through the official empty-track seam",
    (tier) => {
      expect(recoveredAttachments(tier, "empty"))
        .toEqual(cleanShowAttachments(tier));
    },
  );

  it("freezes the clearTrack defect that left Grand broken-plate/glow pixels resident", () => {
    const stale = recoveredAttachments("grand", "clear");
    const recovered = recoveredAttachments("grand", "empty");

    expect(stale).not.toEqual(recovered);
    expect(stale.some((attachment) => (
      attachment.startsWith("9:pr_jackpots_broken_jackpots_step_2:")
    ))).toBe(true);
    expect(stale.some((attachment) => attachment.startsWith("24:glow (179)5:")))
      .toBe(true);
    expect(recovered.some((attachment) => attachment.startsWith("9:")))
      .toBe(false);
    expect(recovered.some((attachment) => attachment.startsWith("24:")))
      .toBe(false);
  });
});
