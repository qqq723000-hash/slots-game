import { describe, expect, it } from "vitest";
import commonManifestJson from "../public/assets/primal-runtime/audio/common_sounds_desktop.json";
import delayedManifestJson from "../public/assets/primal-runtime/audio/snd_delayed_desktop_0.json";
import sounds0ManifestJson from "../public/assets/primal-runtime/audio/sounds_desktop_0.json";
import sounds1ManifestJson from "../public/assets/primal-runtime/audio/sounds_desktop_1.json";
import sounds2ManifestJson from "../public/assets/primal-runtime/audio/sounds_desktop_2.json";
import {
  PRIMAL_CUE_DEFINITIONS,
  type PrimalAudioPackId,
  type PrimalSpriteCueDefinition,
} from "../src/audio/primalSoundMap";

interface CapturedSpriteCue {
  readonly start: number;
  readonly end: number;
  readonly loopStart?: number;
  readonly loopEnd?: number;
}

interface CapturedSpriteManifest {
  readonly sounds: Readonly<Record<string, CapturedSpriteCue>>;
}

const LOAD_ORDER = [
  ["sounds0", sounds0ManifestJson],
  ["sounds1", sounds1ManifestJson],
  ["sounds2", sounds2ManifestJson],
  ["common", commonManifestJson],
    // 官方延迟加载器会在所有主清单之后运行，并按键覆盖 15 个重复计数器标题。 / English: The official lazy loader runs after all main manifests and overrides the 15 repeat counter titles by key.
  ["delayed", delayedManifestJson],
] as const satisfies readonly [PrimalAudioPackId, unknown][];

function resolveCapturedDefinitions(): Readonly<Record<string, PrimalSpriteCueDefinition>> {
  const resolved = new Map<string, PrimalSpriteCueDefinition>();
  for (const [pack, manifestJson] of LOAD_ORDER) {
    const manifest = manifestJson as CapturedSpriteManifest;
    for (const [title, cue] of Object.entries(manifest.sounds)) {
      if (title === "empty") continue;
      const definition: PrimalSpriteCueDefinition = {
        pack,
        startSample: Math.round(cue.start),
        endSample: Math.round(cue.end),
        ...(cue.loopStart === undefined
          ? {}
          : { loopStartSample: Math.round(cue.loopStart) }),
        ...(cue.loopEnd === undefined
          ? {}
          : { loopEndSample: Math.round(cue.loopEnd) }),
      };
      resolved.set(title, definition);
    }
  }
  return Object.fromEntries([...resolved.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

describe("captured Primal audio sprite manifest resolution", () => {
  it("retains every valid captured title after the delayed last-title-wins merge", () => {
    const resolved = resolveCapturedDefinitions();

    expect(Object.keys(resolved)).toHaveLength(105);
    expect(Object.keys(PRIMAL_CUE_DEFINITIONS)).toHaveLength(105);
    expect(PRIMAL_CUE_DEFINITIONS).toEqual(resolved);
  });

  it("retains exact coordinates for the four manifest-only cues", () => {
    expect(PRIMAL_CUE_DEFINITIONS["743UiLight"]).toEqual({
      pack: "sounds1",
      startSample: 639_450,
      endSample: 728_385,
    });
    expect(PRIMAL_CUE_DEFINITIONS["LandBasedJackpotLong"]).toEqual({
      pack: "sounds1",
      startSample: 3_638_250,
      endSample: 3_906_405,
    });
    expect(PRIMAL_CUE_DEFINITIONS["LandBasedJackpotShort"]).toEqual({
      pack: "sounds1",
      startSample: 4_211_550,
      endSample: 4_327_992,
    });
    expect(PRIMAL_CUE_DEFINITIONS["GenericWinLessSnd"]).toEqual({
      pack: "common",
      startSample: 202_724,
      endSample: 233_837,
    });
  });
});
