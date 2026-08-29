// @ts-nocheck -- 仅在 Node 中运行的真实 Spine 材质与时间线证据校验器。 / English: @ts-nocheck -- A true Spine material and timeline evidence checker that only runs in Node.
import { createHash } from "node:crypto";
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
import { BaseTexture, BLEND_MODES } from "pixi.js";
import { describe, expect, it } from "vitest";
import {
  enforcePrimalRegionBlendModes,
  partitionPrimalAdditiveSlots,
} from "../src/renderer/spine/SpineAdapter";

const DIRECTORY = resolve(
  process.cwd(),
  "public/assets/primal-runtime/spine/spine_symbols",
);
const SAMPLE_MS = Object.freeze([0, 100, 200, 500, 750]);
const SYMBOLS = Object.freeze([
  Object.freeze({ name: "Q", file: "Symbol0.skel", sha256: "8f4085066093431f45e14847783265d70b8241e91425d3fda668e640526acd18", expected: [[4, 0], [4, 0], [4, 0], [5, 0], [5, 0]] }),
  Object.freeze({ name: "K", file: "Symbol1.skel", sha256: "807ff06105f31f1702d0df3d94612f862cd5b68a207d49e730137f4f8489ab4b", expected: [[6, 0], [6, 0], [6, 0], [7, 0], [7, 0]] }),
  Object.freeze({ name: "Helmet", file: "Symbol2.skel", sha256: "45443fd00e66109bc0a24d99d33539c284e8ea2dd2a36393ceabcc87d7b85922", expected: [[1, 1], [9, 1], [9, 4], [9, 5], [9, 5]] }),
  Object.freeze({ name: "Radio", file: "Symbol3.skel", sha256: "f9a5fb119d5e4a1b2597bfc41a27ec3eb47d2416d335a8be4b1ac18190a114dd", expected: [[1, 0], [9, 0], [9, 2], [9, 3], [9, 3]] }),
  Object.freeze({ name: "Tank", file: "Symbol4.skel", sha256: "73b6c53598756d8bef9ea7f9377c4e3fa47791760354180dd0187dce93bddec9", expected: [[39, 0], [39, 2], [39, 2], [40, 4], [40, 3]] }),
  Object.freeze({ name: "Jet", file: "Symbol5.skel", sha256: "db5c84e80ab35321cb1d1c05315ff4f5f345287d9bfc24b00ce40ef4987a3f52", expected: [[15, 1], [15, 2], [15, 2], [18, 5], [18, 5]] }),
  Object.freeze({ name: "Wild x50", file: "Symbol6.skel", sha256: "22b6ccae468e3d04b7c0dabf2a59c3dfcf00ed1d4f96fc4ee6a15c10ef3fc87d", expected: [[23, 5], [24, 7], [24, 8], [27, 10], [26, 7]] }),
]);

/** 官方四个低标的 stop -> idle NORMAL/ADD 附件矩阵，采样时间与 WIN 证据一致。 / English: The official four low-standard stop -> idle NORMAL/ADD attachment matrices, the sampling time is consistent with the WIN evidence. */
const IDLE_SYMBOLS = Object.freeze([
  Object.freeze({ name: "Helmet", file: "Symbol2.skel", sha256: "45443fd00e66109bc0a24d99d33539c284e8ea2dd2a36393ceabcc87d7b85922", expected: [[1, 1], [9, 2], [9, 2], [9, 3], [9, 3]] }),
  Object.freeze({ name: "Radio", file: "Symbol3.skel", sha256: "f9a5fb119d5e4a1b2597bfc41a27ec3eb47d2416d335a8be4b1ac18190a114dd", expected: [[1, 0], [9, 1], [9, 1], [9, 1], [9, 1]] }),
  Object.freeze({ name: "Tank", file: "Symbol4.skel", sha256: "73b6c53598756d8bef9ea7f9377c4e3fa47791760354180dd0187dce93bddec9", expected: [[41, 0], [41, 1], [41, 1], [41, 1], [41, 1]] }),
  Object.freeze({ name: "Jet", file: "Symbol5.skel", sha256: "db5c84e80ab35321cb1d1c05315ff4f5f345287d9bfc24b00ce40ef4987a3f52", expected: [[15, 2], [15, 3], [15, 3], [15, 3], [15, 3]] }),
]);

/**
 * Pass58 原本验证了普通符号和 Wild 的 WIN 路径。以下是 SymbolView 中实际的
 * 特殊符号命令形态：转轴透视滤镜启用时，每种情况都可能暴露一个不透明且
 * 以黑色为零值的 add/ 图集附件。将二进制标识与时间线用例放在一起，避免
 * 源资源变化后悄无声息地让此验证失去意义。
 *
 * 英文 / English: Pass58 originally verified WIN paths for normal symbols and Wild. Here's what the special symbol command looks like in SymbolView in action: When the pivot perspective filter is enabled, each case may expose an add/gallery attachment that is opaque and has a black value of zero. Place the binary identifier together with the timeline use case to avoid silently rendering this validation meaningless if the source resource changes.
 */
const SPECIAL_SYMBOLS = Object.freeze({
  rage: Object.freeze({
    file: "Symbol7.skel",
    sha256: "249dfd4d317b4f36718752c92ccf4025da9b923d3b20f04f55db33ae9045d3a4",
  }),
  lockedVault: Object.freeze({
    file: "Symbol8.skel",
    sha256: "7ecbc13a0dd2017a6f6f5daef4a6d1c432455709811b86101c12b21d48c8a490",
  }),
  unlockedVault: Object.freeze({
    file: "Symbol9.skel",
    sha256: "ce0130943965b328f5d9c895a5f7d46662a5e20067f614d55eafee9202eae2b6",
  }),
});

/**
 * 每条生产环境动态特殊符号路径都恰好覆盖一次。样本既包含时间线刻意从暗态
 * 开始的零 ADD 姿态，也包含后续 add/ 帧；每个样本都会执行拆分断言。
 *
 * 英文 / English: Each production environment dynamic special symbol path is covered exactly once. Samples contain both the zero ADD pose where the timeline deliberately starts from the dark state and subsequent add/ frames; split assertions are performed for each sample.
 */
const SPECIAL_DYNAMIC_CASES = Object.freeze([
  Object.freeze({
    name: "Rage anticipation wait_in -> wait plus eye_loop",
    symbol: "rage",
    samples: [0, 84, 250, 900],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "wait_in", false).mixDuration = 0;
      state.setAnimation(1, "eye_loop", true).mixDuration = 0;
      state.addAnimation(0, "wait", true, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage anticipation wait_out",
    symbol: "rage",
    samples: [0, 84, 150],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "wait_out", false).mixDuration = 0;
      state.addAnimation(0, "stop", false, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage collect -> hide",
    symbol: "rage",
    samples: [0, 250, 500, 983, 1_083],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "collect", false).mixDuration = 0;
      state.addAnimation(0, "hide", false, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage temporary show",
    symbol: "rage",
    samples: [0, 333, 667, 1_317],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "show", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage feature activation plus eye_loop",
    symbol: "rage",
    samples: [0, 500, 1_000, 1_983],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "feature_activation", false).mixDuration = 0;
      state.setAnimation(1, "eye_loop", true).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage feature activation -> hide",
    symbol: "rage",
    samples: [0, 1_000, 2_083],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "feature_activation", false).mixDuration = 0;
      state.addAnimation(0, "hide", false, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "Rage cascade explosion",
    symbol: "rage",
    samples: [0, 192, 383, 750],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "explosion", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "locked Vault idle",
    symbol: "lockedVault",
    samples: [0, 442, 883, 1_750],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "idle", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "locked Vault unlock_backup",
    symbol: "lockedVault",
    samples: [0, 375, 750, 1_483],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "unlock_backup", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "locked Vault tease_in -> tease_loop -> tease_out",
    symbol: "lockedVault",
    samples: [0, 333, 667, 1_100, 1_567, 2_633],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "tease_in", false).mixDuration = 0;
      state.addAnimation(0, "tease_loop", false, 0).mixDuration = 0;
      state.addAnimation(0, "tease_out", false, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "locked Vault cascade explosion",
    symbol: "lockedVault",
    samples: [0, 192, 383, 750],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "explosion", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault idle",
    symbol: "unlockedVault",
    samples: [0, 442, 883, 1_750],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "idle", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault land",
    symbol: "unlockedVault",
    samples: [0, 125, 250, 483],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "land", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault Free Spin activation",
    symbol: "unlockedVault",
    samples: [0, 383, 767, 1_517],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "feature_activation", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault upgrade plus 2x glow",
    symbol: "unlockedVault",
    samples: [0, 133, 417, 817],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "upgrade", false).mixDuration = 0;
      state.setAnimation(2, "2x_glow", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault tease_in -> tease_loop -> tease_out",
    symbol: "unlockedVault",
    samples: [0, 333, 667, 1_100, 1_567, 2_633],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "tease_in", false).mixDuration = 0;
      state.addAnimation(0, "tease_loop", false, 0).mixDuration = 0;
      state.addAnimation(0, "tease_out", false, 0).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault win",
    symbol: "unlockedVault",
    samples: [0, 383, 767, 1_517],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "win", false).mixDuration = 0;
    },
  }),
  Object.freeze({
    name: "unlocked Vault cascade explosion",
    symbol: "unlockedVault",
    samples: [0, 192, 383, 750],
    configure: (state: AnimationState) => {
      state.setAnimation(0, "explosion", false).mixDuration = 0;
    },
  }),
]);

function loadAtlas(text: string): Promise<TextureAtlas> {
  return new Promise((resolveAtlas, reject) => {
    new TextureAtlas(
      text,
      (_page, complete) => complete(new BaseTexture()),
      (atlas) => atlas ? resolveAtlas(atlas) : reject(new Error("atlas parse failed")),
    );
  });
}

function isAuthoredAdd(slot: Skeleton["slots"][number]): boolean {
  const attachment = slot.getAttachment() as null | { region?: null | { name?: string } };
  return attachment?.region?.name?.startsWith("add/") === true
    || slot.data.blendMode === BLEND_MODES.ADD;
}

function activeMatrix(skeleton: Skeleton): [number, number] {
  let normal = 0;
  let additive = 0;
  for (const slot of skeleton.slots) {
    if (!slot.getAttachment()) continue;
    if (isAuthoredAdd(slot)) additive += 1;
    else normal += 1;
  }
  return [normal, additive];
}

function advanceAt60Hz(
  state: AnimationState,
  skeleton: Skeleton,
  _fromMs: number,
  toMs: number,
): void {
  const target = toMs / 1_000;
  const maxStep = 1 / 60;
  while ((state.getCurrent(0)?.trackTime ?? target) < target) {
    const current = state.getCurrent(0)?.trackTime ?? target;
    const step = Math.min(maxStep, target - current);
    state.update(step);
    state.apply(skeleton);
  }
}

/** 推进墙上时钟时间而非单条轨道，确保排队片段和多轨片段反映真实行为。 / English: Advance wall clock time instead of individual tracks to ensure queued and multi-track clips reflect real behavior. */
function advanceByMs(
  state: AnimationState,
  skeleton: Skeleton,
  milliseconds: number,
): void {
  let remaining = Math.max(0, milliseconds) / 1_000;
  const maxStep = 1 / 60;
  while (remaining > 0) {
    const step = Math.min(maxStep, remaining);
    state.update(step);
    state.apply(skeleton);
    remaining -= step;
  }
}

/**
 * 用一个真实 Skeleton 姿态模拟 SymbolView 的两次实时渲染。Pixi 会在渲染时
 * 创建 Sprite/Mesh 对象，因此这个仅在 Node 中运行的证据工具会先为每个真实
 * Spine Slot 附加最小可渲染记录，再执行生产材质辅助函数。
 *
 * 英文 / English: Simulate two real-time renderings of SymbolView with a real Skeleton pose. Pixi creates Sprite/Mesh objects at render time, so this Node-only evidence tool appends a minimum renderable record to each real Spine Slot before executing the production material helper function.
 */
function assertRealPoseSplitsIntoNormalAndAdditivePasses(
  skeleton: Skeleton,
  label: string,
): [number, number] {
  const activeSlots = skeleton.slots.filter((slot) => slot.getAttachment());
  const sprites = new Map();
  for (const slot of activeSlots) {
    const sprite = { blendMode: BLEND_MODES.NORMAL, renderable: true };
    (slot as unknown as { currentSprite?: typeof sprite }).currentSprite = sprite;
    sprites.set(slot, sprite);
  }

  const expected = activeMatrix(skeleton);
  const view = { skeleton };
  enforcePrimalRegionBlendModes(view as never);

  expect(partitionPrimalAdditiveSlots(view as never, "normal"), `${label} normal count`)
    .toBe(expected[0]);
  for (const slot of activeSlots) {
    expect(sprites.get(slot)?.renderable, `${label} normal renderability`)
      .toBe(!isAuthoredAdd(slot));
  }

  expect(partitionPrimalAdditiveSlots(view as never, "additive"), `${label} ADD count`)
    .toBe(expected[1]);
  for (const slot of activeSlots) {
    expect(sprites.get(slot)?.renderable, `${label} ADD renderability`)
      .toBe(isAuthoredAdd(slot));
  }
  return expected;
}

describe("Pass57 real symbol win additive evidence", () => {
  it("matches the frozen NORMAL/ADD matrix and keeps Wild x50 normal", async () => {
    const atlasBytes = readFileSync(resolve(DIRECTORY, "spine_symbols.atlas"));
    expect(createHash("sha256").update(atlasBytes).digest("hex"))
      .toBe("dfb243e5f91182705bbd06266cb865984d6ab4e43ac3c9dd1b98102cdbdea6bc");
    const atlas = await loadAtlas(atlasBytes.toString("utf8"));

    try {
      let sawRegionAdd = false;
      let sawAuthoredAddOnNormalRegion = false;
      for (const symbol of SYMBOLS) {
        const bytes = readFileSync(resolve(DIRECTORY, symbol.file));
        expect(createHash("sha256").update(bytes).digest("hex"), symbol.file)
          .toBe(symbol.sha256);
        const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
          .readSkeletonData(new Uint8Array(bytes));
        const skeleton = new Skeleton(data);
        const stateData = new AnimationStateData(data);
        stateData.defaultMix = 0.15;
        const state = new AnimationState(stateData);

        state.setAnimation(0, "stop", false);
        state.apply(skeleton);
        const win = state.setAnimation(0, "win", false);
        expect(win.mixDuration, `${symbol.name} stop -> win mix`).toBe(0.15);
        if (symbol.name === "Wild x50") {
          const x50 = state.setAnimation(1, "x50", false);
          x50.mixDuration = 0;
        }
        state.apply(skeleton);

        const actual: Array<[number, number]> = [activeMatrix(skeleton)];
        const x50Passes: string[][] = [];
        const recordMaterialEvidence = (): void => {
          const passes: string[] = [];
          for (const slot of skeleton.slots) {
            const attachment = slot.getAttachment() as null | { region?: null | { name?: string } };
            const regionName = attachment?.region?.name;
            if (!regionName) continue;
            sawRegionAdd ||= regionName.startsWith("add/");
            sawAuthoredAddOnNormalRegion ||= !regionName.startsWith("add/")
              && slot.data.blendMode === BLEND_MODES.ADD;
            if (regionName === "normal/normal_wild_pr_wild_txt_X50") {
              passes.push(isAuthoredAdd(slot) ? "additive" : "normal");
            }
          }
          if (symbol.name === "Wild x50") x50Passes.push(passes);
        };
        recordMaterialEvidence();
        for (let index = 1; index < SAMPLE_MS.length; index += 1) {
          advanceAt60Hz(state, skeleton, SAMPLE_MS[index - 1], SAMPLE_MS[index]);
          actual.push(activeMatrix(skeleton));
          recordMaterialEvidence();
        }
        expect(actual, `${symbol.name} NORMAL/ADD at ${SAMPLE_MS.join("/")}ms`)
          .toEqual(symbol.expected);

        if (symbol.name === "Q" || symbol.name === "K") {
          expect(actual.every(([, additive]) => additive === 0)).toBe(true);
        }
        if (symbol.name === "Wild x50") {
          expect(x50Passes, "Wild x50 pass at every sample")
            .toEqual(SAMPLE_MS.map(() => ["normal"]));
        }
      }
      expect(sawRegionAdd, "region add/ classification evidence").toBe(true);
      expect(sawAuthoredAddOnNormalRegion, "authored ADD classification evidence").toBe(true);
    } finally {
      atlas.dispose();
    }
  });

  it("keeps every real Helmet/Radio/Tank/Jet idle pose split across NORMAL and ADD", async () => {
    const atlasBytes = readFileSync(resolve(DIRECTORY, "spine_symbols.atlas"));
    expect(createHash("sha256").update(atlasBytes).digest("hex"))
      .toBe("dfb243e5f91182705bbd06266cb865984d6ab4e43ac3c9dd1b98102cdbdea6bc");
    const atlas = await loadAtlas(atlasBytes.toString("utf8"));

    try {
      for (const symbol of IDLE_SYMBOLS) {
        const bytes = readFileSync(resolve(DIRECTORY, symbol.file));
        expect(createHash("sha256").update(bytes).digest("hex"), symbol.file)
          .toBe(symbol.sha256);
        const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
          .readSkeletonData(new Uint8Array(bytes));
        const skeleton = new Skeleton(data);
        const stateData = new AnimationStateData(data);
        stateData.defaultMix = 0.15;
        const state = new AnimationState(stateData);

        state.setAnimation(0, "stop", false);
        state.apply(skeleton);
        const idle = state.setAnimation(0, "idle", false);
        expect(idle.mixDuration, `${symbol.name} stop -> idle mix`).toBe(0.15);
        state.apply(skeleton);

        const actual: Array<[number, number]> = [
          assertRealPoseSplitsIntoNormalAndAdditivePasses(skeleton, `${symbol.name} idle 0ms`),
        ];
        for (let index = 1; index < SAMPLE_MS.length; index += 1) {
          advanceAt60Hz(state, skeleton, SAMPLE_MS[index - 1], SAMPLE_MS[index]);
          actual.push(assertRealPoseSplitsIntoNormalAndAdditivePasses(
            skeleton,
            `${symbol.name} idle ${SAMPLE_MS[index]}ms`,
          ));
        }

        expect(actual, `${symbol.name} idle NORMAL/ADD at ${SAMPLE_MS.join("/")}ms`)
          .toEqual(symbol.expected);
        expect(Math.max(...actual.map(([, additive]) => additive)), `${symbol.name} idle ADD`)
          .toBeGreaterThan(0);
      }
    } finally {
      atlas.dispose();
    }
  });

  it("keeps every real Rage and Vault dynamic pose split across NORMAL and ADD passes", async () => {
    const atlasBytes = readFileSync(resolve(DIRECTORY, "spine_symbols.atlas"));
    expect(createHash("sha256").update(atlasBytes).digest("hex"))
      .toBe("dfb243e5f91182705bbd06266cb865984d6ab4e43ac3c9dd1b98102cdbdea6bc");
    const atlas = await loadAtlas(atlasBytes.toString("utf8"));

    try {
      const dataBySymbol = new Map();
      for (const [key, source] of Object.entries(SPECIAL_SYMBOLS)) {
        const bytes = readFileSync(resolve(DIRECTORY, source.file));
        expect(createHash("sha256").update(bytes).digest("hex"), source.file)
          .toBe(source.sha256);
        dataBySymbol.set(
          key,
          new SkeletonBinary(new AtlasAttachmentLoader(atlas))
            .readSkeletonData(new Uint8Array(bytes)),
        );
      }

      let sawRegionAdd = false;
      let sawAuthoredAddOnNormalRegion = false;
      for (const dynamicCase of SPECIAL_DYNAMIC_CASES) {
        const data = dataBySymbol.get(dynamicCase.symbol);
        expect(data, `${dynamicCase.name} skeleton`).toBeDefined();
        const skeleton = new Skeleton(data);
        const state = new AnimationState(new AnimationStateData(data));
        dynamicCase.configure(state);
        state.apply(skeleton);

        let elapsed = 0;
        let largestAddPass = 0;
        for (const sampleMs of dynamicCase.samples) {
          advanceByMs(state, skeleton, sampleMs - elapsed);
          elapsed = sampleMs;
          for (const slot of skeleton.slots) {
            const attachment = slot.getAttachment() as null | { region?: null | { name?: string } };
            const regionName = attachment?.region?.name;
            if (!regionName) continue;
            sawRegionAdd ||= regionName.startsWith("add/");
            sawAuthoredAddOnNormalRegion ||= !regionName.startsWith("add/")
              && slot.data.blendMode === BLEND_MODES.ADD;
          }
          const [, additive] = assertRealPoseSplitsIntoNormalAndAdditivePasses(
            skeleton,
            `${dynamicCase.name}@${sampleMs}ms`,
          );
          largestAddPass = Math.max(largestAddPass, additive);
        }
        expect(largestAddPass, `${dynamicCase.name} exposes an ADD frame`).toBeGreaterThan(0);
      }
      expect(sawRegionAdd, "special-symbol add/ attachment evidence").toBe(true);
      expect(sawAuthoredAddOnNormalRegion, "special-symbol slot ADD evidence").toBe(true);
    } finally {
      atlas.dispose();
    }
  });
});
