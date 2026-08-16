import { describe, expect, it, vi } from "vitest";

interface RuntimeSpineStub {
  readonly stateData: { defaultMix: number };
  readonly animationCalls: Array<{
    readonly track: number;
    readonly animation: string;
    readonly loop: boolean;
    readonly defaultMixAtCall: number;
  }>;
  readonly state: {
    timeScale: number;
    readonly setAnimation: ReturnType<typeof vi.fn>;
  };
  update(deltaTime: number): void;
}

vi.mock("@pixi-spine/runtime-4.1", () => ({
  Spine: class SpineStub implements RuntimeSpineStub {
    readonly stateData = { defaultMix: 0 };
    readonly animationCalls: RuntimeSpineStub["animationCalls"] = [];
    readonly state = {
      timeScale: 1,
      setAnimation: vi.fn((track: number, animation: string, loop: boolean) => {
        this.animationCalls.push({
          track,
          animation,
          loop,
          defaultMixAtCall: this.stateData.defaultMix,
        });
        return { mixDuration: this.stateData.defaultMix };
      }),
    };
    update(_deltaTime: number): void {}
    readonly skeleton = { slots: [] as unknown[] };
  },
}));

import {
  SPINE_DEFAULT_MIX_SECONDS,
  createSpineView,
  enforcePrimalRegionBlendModes,
  isPrimalAdditiveSlot,
  partitionPrimalAdditiveSlots,
  restorePrimalSlotRenderability,
} from "../src/renderer/spine/SpineAdapter";
import { BLEND_MODES } from "pixi.js";

describe("shared Spine adapter", () => {
  it("sets the official 150ms default mix before the first animation", () => {
    const view = createSpineView({} as never, {
      animation: "idle",
      loop: true,
      timeScale: 0.75,
    }) as unknown as RuntimeSpineStub;

    expect(SPINE_DEFAULT_MIX_SECONDS).toBe(0.15);
    expect(view.stateData.defaultMix).toBe(0.15);
    expect(view.state.timeScale).toBe(0.75);
    expect(view.animationCalls).toEqual([{
      track: 0,
      animation: "idle",
      loop: true,
      defaultMixAtCall: 0.15,
    }]);

    const setAnimation = view.state.setAnimation as unknown as (
      track: number,
      animation: string,
      loop: boolean,
    ) => { readonly mixDuration: number };
    const transitionEntry = setAnimation(0, "win", false);
    expect(transitionEntry.mixDuration).toBe(0.15);
  });

  it("allows an explicit non-negative mix override", () => {
    const immediate = createSpineView({} as never, { defaultMix: 0 }) as unknown as RuntimeSpineStub;
    const custom = createSpineView({} as never, { defaultMix: 0.4 }) as unknown as RuntimeSpineStub;
    const invalid = createSpineView(
      {} as never,
      { defaultMix: Number.NaN },
    ) as unknown as RuntimeSpineStub;

    expect(immediate.stateData.defaultMix).toBe(0);
    expect(custom.stateData.defaultMix).toBe(0.4);
    expect(invalid.stateData.defaultMix).toBe(SPINE_DEFAULT_MIX_SECONDS);
  });

  it("reasserts opaque add/ attachment materials after every Spine update", () => {
    const additiveSprite = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const view = createSpineView({} as never) as unknown as RuntimeSpineStub & {
      readonly skeleton: {
        readonly slots: Array<{
          readonly data: { blendMode: number };
          blendMode: number;
          readonly currentSprite: typeof additiveSprite;
          getAttachment(): { readonly region: { readonly name: string } };
        }>;
      };
    };
    view.skeleton.slots.push({
      data: { blendMode: BLEND_MODES.NORMAL },
      blendMode: BLEND_MODES.NORMAL,
      currentSprite: additiveSprite,
      getAttachment: () => ({ region: { name: "add/electric_001" } }),
    });

    view.update(1 / 60);

    expect(view.skeleton.slots[0]?.blendMode).toBe(BLEND_MODES.ADD);
    expect(additiveSprite.blendMode).toBe(BLEND_MODES.ADD);
  });

  it("allows background Spine to trust authored slot blend modes over add/ path names", () => {
    const normalCityPlate = { blendMode: BLEND_MODES.ADD, renderable: true };
    const authoredFire = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const view = createSpineView(
      {} as never,
      { regionAdditiveFallback: false },
    ) as unknown as RuntimeSpineStub & {
      readonly skeleton: {
        readonly slots: Array<{
          readonly data: { blendMode: number };
          blendMode: number;
          readonly currentSprite: { blendMode: number; renderable: boolean };
          getAttachment(): { readonly region: { readonly name: string } };
        }>;
      };
    };
    view.skeleton.slots.push(
      {
        data: { blendMode: BLEND_MODES.NORMAL },
        blendMode: BLEND_MODES.ADD,
        currentSprite: normalCityPlate,
        getAttachment: () => ({ region: { name: "add/normal_bg__jpg_sky_sm" } }),
      },
      {
        data: { blendMode: BLEND_MODES.ADD },
        blendMode: BLEND_MODES.NORMAL,
        currentSprite: authoredFire,
        getAttachment: () => ({ region: { name: "normal/add_bg_Fire_Trans_01" } }),
      },
    );

    view.update(1 / 60);

    expect(view.skeleton.slots[0]?.blendMode).toBe(BLEND_MODES.NORMAL);
    expect(normalCityPlate.blendMode).toBe(BLEND_MODES.NORMAL);
    expect(view.skeleton.slots[1]?.blendMode).toBe(BLEND_MODES.ADD);
    expect(authoredFire.blendMode).toBe(BLEND_MODES.ADD);
  });

  it("treats opaque add/ atlas regions as additive after attachment swaps", () => {
    const additiveSprite = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const additiveMesh = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const normalSprite = { blendMode: BLEND_MODES.ADD, renderable: true };
    const view = {
      skeleton: {
        slots: [
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            blendMode: BLEND_MODES.NORMAL,
            currentSprite: additiveSprite,
            currentMesh: additiveMesh,
            getAttachment: () => ({ region: { name: "add/electric_001" } }),
          },
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            blendMode: BLEND_MODES.ADD,
            currentSprite: normalSprite,
            getAttachment: () => ({ region: { name: "normal/frame" } }),
          },
        ],
      },
    };

    expect(enforcePrimalRegionBlendModes(view as never)).toBe(1);
    expect(view.skeleton.slots[0]?.blendMode).toBe(BLEND_MODES.ADD);
    expect(additiveSprite.blendMode).toBe(BLEND_MODES.ADD);
    expect(additiveMesh.blendMode).toBe(BLEND_MODES.ADD);
    expect(view.skeleton.slots[1]?.blendMode).toBe(BLEND_MODES.NORMAL);
    expect(normalSprite.blendMode).toBe(BLEND_MODES.NORMAL);

    expect(partitionPrimalAdditiveSlots(view as never, "normal")).toBe(1);
    expect(additiveSprite.renderable).toBe(false);
    expect(additiveMesh.renderable).toBe(false);
    expect(normalSprite.renderable).toBe(true);
    expect(partitionPrimalAdditiveSlots(view as never, "additive")).toBe(1);
    expect(additiveSprite.renderable).toBe(true);
    expect(additiveMesh.renderable).toBe(true);
    expect(normalSprite.renderable).toBe(false);
  });

  it("classifies authored ADD slots while keeping the Wild x50 plate in NORMAL", () => {
    const regionAdd = {
      data: { blendMode: BLEND_MODES.NORMAL },
      getAttachment: () => ({ region: { name: "add/wild_radar_glow" } }),
    };
    const authoredAdd = {
      data: { blendMode: BLEND_MODES.ADD },
      getAttachment: () => ({ region: { name: "normal/helmet_text" } }),
    };
    const x50 = {
      data: { blendMode: BLEND_MODES.NORMAL },
      getAttachment: () => ({
        region: { name: "normal/normal_wild_pr_wild_txt_X50" },
      }),
    };

    expect(isPrimalAdditiveSlot(regionAdd as never)).toBe(true);
    expect(isPrimalAdditiveSlot(authoredAdd as never)).toBe(true);
    expect(isPrimalAdditiveSlot(regionAdd as never, { regionAdditiveFallback: false })).toBe(false);
    expect(isPrimalAdditiveSlot(authoredAdd as never, { regionAdditiveFallback: false })).toBe(true);
    expect(isPrimalAdditiveSlot(x50 as never)).toBe(false);
  });

  it("restores every active renderable after a split composite is cleared", () => {
    const normalSprite = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const additiveSprite = { blendMode: BLEND_MODES.ADD, renderable: true };
    const view = {
      skeleton: {
        slots: [
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            currentSprite: normalSprite,
            getAttachment: () => ({ region: { name: "normal/tank" } }),
          },
          {
            data: { blendMode: BLEND_MODES.NORMAL },
            currentSprite: additiveSprite,
            getAttachment: () => ({ region: { name: "add/tank_flash" } }),
          },
        ],
      },
    };

    expect(partitionPrimalAdditiveSlots(view as never, "normal")).toBe(1);
    expect([normalSprite.renderable, additiveSprite.renderable]).toEqual([true, false]);
    expect(restorePrimalSlotRenderability(view as never)).toBe(2);
    expect([normalSprite.renderable, additiveSprite.renderable]).toEqual([true, true]);
  });

  it("never revives a stale Pixi Sprite after its Spine attachment clears", () => {
    const staleSprite = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    const view = {
      skeleton: {
        slots: [{
          data: { blendMode: BLEND_MODES.NORMAL },
          currentSprite: staleSprite,
          getAttachment: () => null,
        }],
      },
    };

    expect(partitionPrimalAdditiveSlots(view as never, "normal")).toBe(0);
    expect(staleSprite.renderable).toBe(false);
    staleSprite.renderable = true;
    expect(restorePrimalSlotRenderability(view as never)).toBe(0);
    expect(staleSprite.renderable).toBe(false);
  });
});
