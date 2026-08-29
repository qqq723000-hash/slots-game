import { describe, expect, it, vi } from "vitest";
import { BLEND_MODES, Container } from "pixi.js";
import { SYMBOL_IDS } from "../src/app/state/types";
import {
  SymbolView,
  SYMBOL_DIMMED_TINT,
  SYMBOL_FULL_COLOUR_TINT,
  authoredCellIdleAnimation,
  authoredCellIdleDurationMs,
  authoredCellVariantAnimation,
  authoredVaultFreeSpinActivation,
  authoredSymbolSpineKeyForCell,
  authoredSymbolIdleAnimation,
  authoredSymbolRestAnimation,
  authoredSymbolWinAnimation,
  cellVariantFallbackLabel,
  nextSymbolDimStep,
  nextSymbolRestoreStep,
  symbolContentVisibility,
} from "../src/reels/SymbolView";
import {
  PRIMAL_BLURRED_SYMBOL_PLACEHOLDER,
  PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID,
  PRIMAL_SYMBOL_SPINE_KEYS,
  PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID,
} from "../src/reels/primalSymbolSpines";
import {
  PRIMAL_SPINE_SPECS,
  primalSpineSkeletonUrl,
} from "../src/renderer/spine/PrimalSpineAssets";

interface FakeAnimationEntry {
  mixDuration: number;
}

function rageSymbolHarness(
  symbol = "SURGE",
  animations: readonly string[] = ["wait_in", "wait", "eye_loop", "wait_out", "stop"],
) {
  const available = new Set(animations);
  const entries: FakeAnimationEntry[] = [];
  const makeEntry = (): FakeAnimationEntry => {
    const entry = { mixDuration: 0.15 };
    entries.push(entry);
    return entry;
  };
  const state = {
    hasAnimation: vi.fn((animation: string) => available.has(animation)),
    setAnimation: vi.fn((_track: number, _animation: string, _loop: boolean) => makeEntry()),
    addAnimation: vi.fn((
      _track: number,
      _animation: string,
      _loop: boolean,
      _delay: number,
    ) => makeEntry()),
    clearTrack: vi.fn(),
  };
  const update = vi.fn();
  const view = Object.create(SymbolView.prototype) as SymbolView;
  Object.assign(view as unknown as Record<string, unknown>, {
    currentCell: { symbol },
    authoredView: { state, update },
  });
  return { view, state, entries, update };
}

function wildSymbolHarness() {
  const available = new Set(["land", "reveal", "stop", "x_nomulti", "x2"]);
  const entries: FakeAnimationEntry[] = [];
  const makeEntry = (): FakeAnimationEntry => {
    const entry = { mixDuration: 0.15 };
    entries.push(entry);
    return entry;
  };
  const state = {
    timeScale: 1,
    hasAnimation: vi.fn((animation: string) => available.has(animation)),
    setAnimation: vi.fn((_track: number, _animation: string, _loop: boolean) => makeEntry()),
    addAnimation: vi.fn((
      _track: number,
      _animation: string,
      _loop: boolean,
      _delay: number,
    ) => makeEntry()),
    clearTrack: vi.fn(),
  };
  const update = vi.fn();
  const view = Object.create(SymbolView.prototype) as SymbolView;
  Object.assign(view as unknown as Record<string, unknown>, {
    currentCell: { symbol: "WILD", multiplier: 2 },
    authoredView: { state, update },
    deferredWildVariant: true,
    authoredPlaybackPaused: false,
    authoredResumeTimeScale: 1,
  });
  return { view, state, entries, update };
}

function ordinaryWinSymbolHarness() {
  const available = new Set(["stop", "win"]);
  const state = {
    hasAnimation: vi.fn((animation: string) => available.has(animation)),
    setAnimation: vi.fn(),
    addAnimation: vi.fn(),
    clearTracks: vi.fn(),
  };
  const skeleton = { setToSetupPose: vi.fn() };
  const update = vi.fn();
  const view = Object.create(SymbolView.prototype) as SymbolView;
  Object.assign(view as unknown as Record<string, unknown>, {
    currentCell: { symbol: "TANK" },
    highlighted: false,
    authoredView: { state, skeleton, update },
    deferredWildVariant: false,
  });
  return { view, state, skeleton, update };
}

interface CompositeRenderableStub {
  blendMode: number;
  renderable: boolean;
}

interface CompositeSlotStub {
  readonly data: { readonly blendMode: number };
  blendMode: number;
  readonly currentSprite: CompositeRenderableStub;
  getAttachment(): { readonly region: { readonly name: string } };
}

function copyPoint(x = 0, y = 0) {
  return {
    x,
    y,
    copyFrom(source: { readonly x: number; readonly y: number }) {
      this.x = source.x;
      this.y = source.y;
    },
  };
}

function compositeSlot(regionName: string, authoredBlend = BLEND_MODES.NORMAL): CompositeSlotStub {
  return {
    data: { blendMode: authoredBlend },
    blendMode: authoredBlend,
    currentSprite: { blendMode: authoredBlend, renderable: true },
    getAttachment: () => ({ region: { name: regionName } }),
  };
}

function compositeSpineStub(symbol: string) {
  const slots = symbol === "PRISM" || symbol === "ORBIT"
    ? [compositeSlot(`normal/${symbol.toLowerCase()}`)]
    : [
        compositeSlot(symbol === "WILD"
          ? "normal/normal_wild_pr_wild_txt_X50"
          : `normal/${symbol.toLowerCase()}`),
        compositeSlot(`add/${symbol.toLowerCase()}_glow`),
        compositeSlot(`normal/${symbol.toLowerCase()}_authored_add`, BLEND_MODES.ADD),
      ];
  const tracks = new Map<number, {
    animation: { name: string };
    trackTime: number;
    mixDuration: number;
  }>();
  const state = {
    timeScale: 1,
    hasAnimation: vi.fn((animation: string) => (
      animation === "stop"
        || animation === "win"
        || animation === "idle"
        || animation === "explosion"
        || animation === "x50"
    )),
    tracks: [] as Array<{
      animation: { name: string };
      trackTime: number;
      mixDuration: number;
      loop: boolean;
      next: null;
      mixingFrom: null;
      isComplete(): boolean;
    } | null>,
    clearTracks: vi.fn(() => {
      tracks.clear();
      state.tracks.fill(null);
    }),
    setAnimation: vi.fn((track: number, animation: string, loop = false) => {
      const duration = animation === "idle" || animation === "explosion"
        ? 0.05
        : animation === "win" ? 1 : 0;
      const entry = {
        animation: { name: animation },
        trackTime: 0,
        mixDuration: 0.15,
        loop,
        next: null,
        mixingFrom: null,
        isComplete() {
          return !this.loop && this.trackTime >= duration;
        },
      };
      tracks.set(track, entry);
      state.tracks[track] = entry;
      return entry;
    }),
    getCurrent: vi.fn((track: number) => tracks.get(track) ?? null),
  };
  const spine = {
    position: copyPoint(),
    scale: copyPoint(1, 1),
    pivot: copyPoint(),
    skew: copyPoint(),
    rotation: 0,
    alpha: 1,
    visible: true,
    renderable: true,
    tint: 0xffffff,
    state,
    skeleton: {
      slots,
      setToSetupPose: vi.fn(),
    },
    update: vi.fn((deltaSeconds: number) => {
      tracks.forEach((entry) => {
        entry.trackTime += deltaSeconds * state.timeScale;
      });
    }),
  };
  return { spine, slots, tracks };
}

function winningCompositeHarness(
  symbol: "PRISM" | "ORBIT" | "PULSE" | "NOVA" | "TANK" | "CIRCUIT" | "WILD",
) {
  const normal = compositeSpineStub(symbol);
  const additive = compositeSpineStub(symbol);
  const view = Object.setPrototypeOf(new Container(), SymbolView.prototype) as SymbolView;
  const winningAdditiveRoot = new Container();
  Object.assign(view as unknown as Record<string, unknown>, {
    currentCell: symbol === "WILD" ? { symbol, multiplier: 50 } : { symbol },
    authoredView: normal.spine,
    authoredAdditiveView: additive.spine,
    authoredLayer: { visible: true },
    winningAdditiveRoot,
    highlighted: false,
    additiveCompositeActive: false,
    additivePlaybackRunning: false,
    activeAdditiveAttachmentCount: 0,
    deferredWildVariant: false,
    forceLockedVault: false,
    authoredPlaybackPaused: false,
    authoredResumeTimeScale: 1,
  });
  view.position.set(14, 28);
  view.scale.set(0.8, 0.9);
  view.pivot.set(2, 3);
  view.skew.set(0.01, -0.02);
  view.rotation = 0.03;
  view.alpha = 0.75;
  return { view, normal, additive, winningAdditiveRoot };
}

function dimmedSymbolHarness() {
  const art = { tint: SYMBOL_FULL_COLOUR_TINT };
  const cellGlass = { tint: 0x123456 };
  const authoredView = {
    tint: SYMBOL_FULL_COLOUR_TINT,
    update: vi.fn(),
  };
  const view = Object.create(SymbolView.prototype) as SymbolView;
  Object.assign(view as unknown as Record<string, unknown>, {
    art,
    cellGlass,
    authoredView,
    dimmed: false,
    dimProgress: 0,
    presentationTint: SYMBOL_FULL_COLOUR_TINT,
    tintFrom: SYMBOL_FULL_COLOUR_TINT,
    tintTarget: SYMBOL_FULL_COLOUR_TINT,
    tintTransitionActive: false,
  });
  return { view, art, cellGlass, authoredView };
}

describe("captured Primal symbol skeleton mapping", () => {
  it("plays Rage anticipation across the captured body and eye tracks without mixes", () => {
    const { view, state, entries, update } = rageSymbolHarness();

    expect(view.startRageAnticipationAnimation()).toBe(true);
    expect(state.setAnimation).toHaveBeenNthCalledWith(1, 0, "wait_in", false);
    expect(state.setAnimation).toHaveBeenNthCalledWith(2, 1, "eye_loop", true);
    expect(state.addAnimation).toHaveBeenCalledWith(0, "wait", true, 0);
    expect(entries.map((entry) => entry.mixDuration)).toEqual([0, 0, 0]);
    expect(update).toHaveBeenCalledWith(0);
  });

  it("ends Rage anticipation on wait_out, clears the eye track, then restores stop", () => {
    const { view, state, entries, update } = rageSymbolHarness();

    expect(view.endRageAnticipationAnimation()).toBe(true);
    expect(state.setAnimation).toHaveBeenCalledWith(0, "wait_out", false);
    expect(state.clearTrack).toHaveBeenCalledWith(1);
    expect(state.addAnimation).toHaveBeenCalledWith(0, "stop", false, 0);
    expect(entries.map((entry) => entry.mixDuration)).toEqual([0, 0]);
    expect(update).toHaveBeenCalledWith(0);
    expect(state.setAnimation.mock.invocationCallOrder[0]!).toBeLessThan(
      state.clearTrack.mock.invocationCallOrder[0]!,
    );
    expect(state.clearTrack.mock.invocationCallOrder[0]!).toBeLessThan(
      state.addAnimation.mock.invocationCallOrder[0]!,
    );
  });

  it("queues Rage collect then hide and applies the authored collect zero-frame", () => {
    const { view, state, update } = rageSymbolHarness(
      "SURGE",
      ["collect", "hide", "stop"],
    );

    expect(view.playCollectAnimation()).toBe(true);
    expect(state.clearTrack).toHaveBeenCalledWith(1);
    expect(state.setAnimation).toHaveBeenCalledWith(0, "collect", false);
    expect(state.addAnimation).toHaveBeenCalledWith(0, "hide", false, 0);
    expect(update).toHaveBeenCalledWith(0);
  });

  it("plays all-Rage activation on body and eye tracks without an early stop mix", () => {
    const { view, state, entries, update } = rageSymbolHarness(
      "SURGE",
      ["feature_activation", "eye_loop", "stop"],
    );

    expect(view.playFeatureActivationAnimation()).toBe(true);
    expect(state.setAnimation).toHaveBeenNthCalledWith(1, 0, "feature_activation", false);
    expect(state.setAnimation).toHaveBeenNthCalledWith(2, 1, "eye_loop", true);
    expect(state.addAnimation).not.toHaveBeenCalled();
    expect(entries.map((entry) => entry.mixDuration)).toEqual([0, 0]);
    expect(update).toHaveBeenCalledWith(0);
  });

  it("holds an ordinary winning symbol on its terminal win pose until highlight clears", () => {
    const { view, state, skeleton, update } = ordinaryWinSymbolHarness();

    expect(view.setHighlighted(true)).toBe(true);
    expect(state.setAnimation).toHaveBeenCalledTimes(1);
    expect(state.setAnimation).toHaveBeenCalledWith(0, "win", false);
    expect(state.addAnimation).not.toHaveBeenCalled();
    expect(state.clearTracks).not.toHaveBeenCalled();

    expect(view.setHighlighted(false)).toBe(true);
    expect(state.clearTracks).toHaveBeenCalledTimes(1);
    expect(skeleton.setToSetupPose).toHaveBeenCalledTimes(1);
    expect(state.setAnimation).toHaveBeenNthCalledWith(2, 0, "stop", false);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("restarts an overlapping ordinary symbol for every authoritative win record", () => {
    const { view, state, update } = ordinaryWinSymbolHarness();

    expect(view.setHighlighted(true)).toBe(true);
    expect(view.setHighlighted(true)).toBe(true);

    expect(state.setAnimation).toHaveBeenCalledTimes(2);
    expect(state.setAnimation).toHaveBeenNthCalledWith(1, 0, "win", false);
    expect(state.setAnimation).toHaveBeenNthCalledWith(2, 0, "win", false);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it.each(["PRISM", "ORBIT", "PULSE", "NOVA", "TANK", "CIRCUIT", "WILD"] as const)(
    "%s restarts NORMAL and any authored ADD win pass on a consecutive record",
    (symbol) => {
      const { view, normal, additive } = winningCompositeHarness(symbol);

      expect(view.setHighlighted(true)).toBe(true);
      view.update(100);
      expect(normal.spine.state.getCurrent(0)?.trackTime).toBeGreaterThan(0);

      expect(view.setHighlighted(true)).toBe(true);
      expect(normal.spine.state.getCurrent(0)?.animation.name).toBe("win");
      expect(normal.spine.state.getCurrent(0)?.trackTime).toBe(0);

      if (symbol === "PRISM" || symbol === "ORBIT") {
        expect(additive.spine.state.getCurrent(0)).toBeNull();
      } else {
        expect(additive.spine.state.getCurrent(0)?.animation.name).toBe("win");
        expect(additive.spine.state.getCurrent(0)?.trackTime).toBe(0);
      }
    },
  );

  it.each(["PRISM", "ORBIT"] as const)(
    "%s wins never activate or advance the dormant ADD instance",
    (symbol) => {
      const { view, normal, additive, winningAdditiveRoot } = winningCompositeHarness(symbol);

      expect(view.setHighlighted(true)).toBe(true);
      view.update(100);

      expect(normal.spine.state.getCurrent(0)?.animation.name).toBe("win");
      expect(normal.spine.state.getCurrent(0)?.trackTime).toBeCloseTo(0.064, 8);
      expect(normal.spine.update).toHaveBeenCalledWith(0.064);
      expect(additive.spine.state.getCurrent(0)).toBeNull();
      expect(additive.spine.update).not.toHaveBeenCalled();
      expect(winningAdditiveRoot.visible).toBe(false);
      expect(winningAdditiveRoot.renderable).toBe(false);
      expect((view as unknown as { additiveCompositeActive: boolean }).additiveCompositeActive)
        .toBe(false);
    },
  );

  it.each(["PULSE", "NOVA", "TANK", "CIRCUIT", "WILD"] as const)(
    "%s wins keep NORMAL and ADD instances partitioned and frame-synchronized",
    (symbol) => {
      const { view, normal, additive, winningAdditiveRoot } = winningCompositeHarness(symbol);

      expect(view.setHighlighted(true)).toBe(true);
      view.update(100);

      const normalTrack0 = normal.spine.state.getCurrent(0);
      const additiveTrack0 = additive.spine.state.getCurrent(0);
      expect(normalTrack0?.animation.name).toBe("win");
      expect(additiveTrack0?.animation.name).toBe("win");
      expect(additiveTrack0?.trackTime).toBeCloseTo(normalTrack0?.trackTime ?? -1, 8);
      expect(normal.spine.state.timeScale).toBe(additive.spine.state.timeScale);
      expect(normal.spine.update.mock.calls).toEqual(additive.spine.update.mock.calls);

      expect(normal.slots.map((slot) => slot.currentSprite.renderable)).toEqual([
        true,
        false,
        false,
      ]);
      expect(additive.slots.map((slot) => slot.currentSprite.renderable)).toEqual([
        false,
        true,
        true,
      ]);
      expect(winningAdditiveRoot.visible).toBe(true);
      expect(winningAdditiveRoot.renderable).toBe(true);
      expect((view as unknown as { activeAdditiveAttachmentCount: number })
        .activeAdditiveAttachmentCount).toBe(2);

      expect(additive.spine.position).toMatchObject({
        x: normal.spine.position.x,
        y: normal.spine.position.y,
      });
      expect(additive.spine.scale).toMatchObject({
        x: normal.spine.scale.x,
        y: normal.spine.scale.y,
      });
      expect(additive.spine.pivot).toMatchObject({
        x: normal.spine.pivot.x,
        y: normal.spine.pivot.y,
      });
      expect(additive.spine.skew).toMatchObject({
        x: normal.spine.skew.x,
        y: normal.spine.skew.y,
      });
      expect(additive.spine.rotation).toBe(normal.spine.rotation);
      expect(additive.spine.alpha).toBe(normal.spine.alpha);
      expect(additive.spine.tint).toBe(normal.spine.tint);

      if (symbol === "WILD") {
        expect(normal.spine.state.getCurrent(1)?.animation.name).toBe("x50");
        expect(additive.spine.state.getCurrent(1)?.animation.name).toBe("x50");
        expect(normal.slots[0]?.getAttachment().region.name)
          .toBe("normal/normal_wild_pr_wild_txt_X50");
        expect(normal.slots[0]?.currentSprite.renderable).toBe(true);
        expect(additive.slots[0]?.currentSprite.renderable).toBe(false);
      }

      expect(view.setHighlighted(false)).toBe(true);
      expect(winningAdditiveRoot.visible).toBe(true);
      expect(winningAdditiveRoot.renderable).toBe(true);
      expect(normal.slots.map((slot) => slot.currentSprite.renderable)).toEqual([
        true,
        false,
        false,
      ]);
      expect((view as unknown as { additiveCompositeActive: boolean }).additiveCompositeActive)
        .toBe(true);
      expect((view as unknown as { additivePlaybackRunning: boolean }).additivePlaybackRunning)
        .toBe(false);
    },
  );

  it.each([
    ["Helmet", "PULSE"],
    ["Radio", "NOVA"],
    ["Tank", "TANK"],
    ["Jet", "CIRCUIT"],
    ["Wild", "WILD"],
  ] as const)(
    "routes %s idle NORMAL+ADD outside the reel Filter and freezes its second clock",
    (_label, symbol) => {
      const { view, normal, additive, winningAdditiveRoot } = winningCompositeHarness(symbol);

      expect(view.playIdleAnimation()).toBe(true);
      expect(normal.spine.state.getCurrent(0)?.animation.name).toBe("idle");
      expect(additive.spine.state.getCurrent(0)?.animation.name).toBe("idle");
      expect(normal.slots.map((slot) => slot.currentSprite.renderable)).toEqual([
        true,
        false,
        false,
      ]);
      expect(additive.slots.map((slot) => slot.currentSprite.renderable)).toEqual([
        false,
        true,
        true,
      ]);
      expect(winningAdditiveRoot.visible).toBe(true);
      expect(winningAdditiveRoot.renderable).toBe(true);

      view.update(100);
      expect(normal.spine.update.mock.calls).toEqual(additive.spine.update.mock.calls);
      expect((view as unknown as { additivePlaybackRunning: boolean }).additivePlaybackRunning)
        .toBe(false);
      const updatesAtCompletion = additive.spine.update.mock.calls.length;
      view.update(16);
      expect(additive.spine.update).toHaveBeenCalledTimes(updatesAtCompletion);
    },
  );

  it.each(["PRISM", "ORBIT"] as const)(
    "%s explosion starts the dynamic composite even though WIN is a zero-ADD control",
    (symbol) => {
      const { view, normal, additive } = winningCompositeHarness(symbol);

      expect(view.playExplosionAnimation()).toBe(true);
      expect(normal.spine.state.getCurrent(0)?.animation.name).toBe("explosion");
      expect(additive.spine.state.getCurrent(0)?.animation.name).toBe("explosion");
      expect((view as unknown as { additiveCompositeActive: boolean }).additiveCompositeActive)
        .toBe(true);
    },
  );

  it("matches the official nine-tick 0xffffff to 0x888888 fade recurrence", () => {
    let progress = 0;
    const tints: number[] = [];
    const completions: boolean[] = [];
    for (let tick = 0; tick < 9; tick += 1) {
      const step = nextSymbolDimStep(progress);
      progress = step.progress;
      tints.push(step.tint);
      completions.push(step.complete);
    }

    expect(tints).toEqual([
      0xdbdbdb,
      0xc2c2c2,
      0xb0b0b0,
      0xa4a4a4,
      0x9c9c9c,
      0x969696,
      0x919191,
      0x8e8e8e,
      SYMBOL_DIMMED_TINT,
    ]);
    expect(completions).toEqual([false, false, false, false, false, false, false, false, true]);
    expect(progress).toBeCloseTo(0.959646393);
  });

  it("matches the official nine-tick 0x888888 to 0xffffff restore recurrence", () => {
    let progress = 0;
    const tints: number[] = [];
    const completions: boolean[] = [];
    for (let tick = 0; tick < 9; tick += 1) {
      const step = nextSymbolRestoreStep(progress);
      progress = step.progress;
      tints.push(step.tint);
      completions.push(step.complete);
    }

    expect(tints).toEqual([
      0xababab,
      0xc4c4c4,
      0xd6d6d6,
      0xe2e2e2,
      0xeaeaea,
      0xf0f0f0,
      0xf5f5f5,
      0xf8f8f8,
      SYMBOL_FULL_COLOUR_TINT,
    ]);
    expect(completions).toEqual([false, false, false, false, false, false, false, false, true]);
    expect(progress).toBeCloseTo(0.959646393);
  });

  it("dims only symbol content, undims immediately, and resets on a new cell", () => {
    const { view, art, cellGlass, authoredView } = dimmedSymbolHarness();

    view.setDimmed(true);
    expect(art.tint).toBe(SYMBOL_FULL_COLOUR_TINT);
    for (let tick = 0; tick < 8; tick += 1) view.update(16);
    expect(art.tint).toBe(0x8e8e8e);
    expect(authoredView.tint).toBe(0x8e8e8e);
    expect(cellGlass.tint).toBe(0x123456);
    view.update(16);
    expect(art.tint).toBe(SYMBOL_DIMMED_TINT);

    view.setDimmed(false);
    expect(art.tint).toBe(SYMBOL_FULL_COLOUR_TINT);
    expect(authoredView.tint).toBe(SYMBOL_FULL_COLOUR_TINT);
    expect(cellGlass.tint).toBe(0x123456);

    const state = view as unknown as Record<string, unknown>;
    Object.assign(state, {
      dimmed: true,
      dimProgress: 0.657,
      presentationTint: 0xb0b0b0,
      tintFrom: SYMBOL_DIMMED_TINT,
      tintTarget: SYMBOL_FULL_COLOUR_TINT,
      tintTransitionActive: true,
      highlighted: true,
      idleBlocked: true,
      featureHidden: true,
      deferredWildVariant: false,
      redraw: vi.fn(),
      playRestingAnimation: vi.fn(),
    });
    view.setCell({ symbol: "TANK" });
    expect(state.dimmed).toBe(false);
    expect(state.dimProgress).toBe(0);
    expect(state.presentationTint).toBe(SYMBOL_FULL_COLOUR_TINT);
    expect(state.tintFrom).toBe(SYMBOL_FULL_COLOUR_TINT);
    expect(state.tintTarget).toBe(SYMBOL_FULL_COLOUR_TINT);
    expect(state.tintTransitionActive).toBe(false);
  });

  it("restores progressively only when requested and cancels restoration on re-dim", () => {
    const { view, art, cellGlass, authoredView } = dimmedSymbolHarness();

    view.setDimmed(true);
    for (let tick = 0; tick < 9; tick += 1) view.update(16);
    expect(art.tint).toBe(SYMBOL_DIMMED_TINT);

    view.setDimmed(false, true);
    expect(art.tint).toBe(SYMBOL_DIMMED_TINT);
    for (let tick = 0; tick < 8; tick += 1) view.update(16);
    expect(art.tint).toBe(0xf8f8f8);
    expect(authoredView.tint).toBe(0xf8f8f8);
    expect(cellGlass.tint).toBe(0x123456);
    view.update(16);
    expect(art.tint).toBe(SYMBOL_FULL_COLOUR_TINT);

    view.setDimmed(true);
    for (let tick = 0; tick < 9; tick += 1) view.update(16);
    view.setDimmed(false, true);
    view.update(16);
    expect(art.tint).toBe(0xababab);
    view.setDimmed(true);
    view.update(16);
    expect(art.tint).toBe(0xa0a0a0);
    for (let tick = 0; tick < 8; tick += 1) view.update(16);
    expect(art.tint).toBe(SYMBOL_DIMMED_TINT);
  });

  it("holds an authoritative Wild plain for 500ms before NORMAL reveal", () => {
    const { view, state, entries, update } = wildSymbolHarness();

    expect(view.playLandAnimation("NORMAL")).toBe(true);
    expect(state.setAnimation).toHaveBeenCalledWith(0, "land", false);
    expect(state.clearTrack).toHaveBeenCalledWith(1);
    expect(state.addAnimation).toHaveBeenNthCalledWith(1, 0, "reveal", false, 0.5);
    expect(state.addAnimation).toHaveBeenNthCalledWith(2, 1, "x2", false, 0.5);
    expect(entries.map((entry) => entry.mixDuration)).toEqual([0, 0, 0]);
    expect(update).toHaveBeenCalledWith(0);
  });

  it("keeps FAST generic land suppressed while retaining Wild reveal", () => {
    const { view, state } = wildSymbolHarness();

    expect(view.playLandAnimation("FAST")).toBe(true);
    expect(state.setAnimation).not.toHaveBeenCalledWith(0, "land", false);
    expect(state.addAnimation).toHaveBeenCalledWith(0, "reveal", false, 0.5);
    expect(state.addAnimation).toHaveBeenCalledWith(1, "x2", false, 0.5);
  });

  it("freezes and restores an authored Wild pose without rebuilding its tracks", () => {
    const { view, state } = wildSymbolHarness();

    view.setAuthoredPlaybackPaused(true);
    expect(state.timeScale).toBe(0);
    view.setAuthoredPlaybackPaused(true);
    expect(state.timeScale).toBe(0);

    view.setAuthoredPlaybackPaused(false);
    expect(state.timeScale).toBe(1);
    expect(state.setAnimation).not.toHaveBeenCalled();
    expect(state.addAnimation).not.toHaveBeenCalled();
    expect(state.clearTrack).not.toHaveBeenCalled();
  });

  it("rejects Rage anticipation for non-SURGE cells without touching Spine tracks", () => {
    const { view, state, update } = rageSymbolHarness("CIRCUIT");

    expect(view.startRageAnticipationAnimation()).toBe(false);
    expect(view.endRageAnticipationAnimation()).toBe(false);
    expect(state.hasAnimation).not.toHaveBeenCalled();
    expect(state.setAnimation).not.toHaveBeenCalled();
    expect(state.addAnimation).not.toHaveBeenCalled();
    expect(state.clearTrack).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("reports missing required Rage clips before mutating either track", () => {
    const start = rageSymbolHarness("SURGE", ["wait_in", "wait", "wait_out", "stop"]);
    expect(start.view.startRageAnticipationAnimation()).toBe(false);
    expect(start.state.setAnimation).not.toHaveBeenCalled();
    expect(start.state.addAnimation).not.toHaveBeenCalled();

    const end = rageSymbolHarness("SURGE", ["wait_in", "wait", "eye_loop", "wait_out"]);
    expect(end.view.endRageAnticipationAnimation()).toBe(false);
    expect(end.state.setAnimation).not.toHaveBeenCalled();
    expect(end.state.clearTrack).not.toHaveBeenCalled();
    expect(end.state.addAnimation).not.toHaveBeenCalled();
  });

  it("preserves the exact client LP/MP/HP and feature ids", () => {
    expect(PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID).toEqual({
      PRISM: 0,
      ORBIT: 1,
      PULSE: 2,
      NOVA: 3,
      TANK: 4,
      CIRCUIT: 5,
      WILD: 6,
      SURGE: 7,
      VAULT: 8,
    });
    expect(Object.keys(PRIMAL_CLIENT_SYMBOL_ID_BY_SERVER_ID).sort()).toEqual([...SYMBOL_IDS].sort());
    expect(Object.keys(PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID).sort()).toEqual([...SYMBOL_IDS].sort());
  });

  it("loads every supplied skeleton and keeps Symbol9 for unlocked vault state", () => {
    expect(PRIMAL_SYMBOL_SPINE_KEYS).toEqual([
      "symbol0",
      "symbol1",
      "symbol2",
      "symbol3",
      "symbol4",
      "symbol5",
      "symbol6",
      "symbol7",
      "symbol8",
      "symbol9",
    ]);
    PRIMAL_SYMBOL_SPINE_KEYS.forEach((key, index) => {
      expect(PRIMAL_SPINE_SPECS[key].skeleton).toBe(`Symbol${index}`);
      expect(primalSpineSkeletonUrl(key)).toBe(
        `/assets/primal-runtime/spine/spine_symbols/Symbol${index}.skel`,
      );
    });
    expect(new Set(Object.values(PRIMAL_SYMBOL_SPINE_KEY_BY_SERVER_ID)).has("symbol9")).toBe(false);
  });

  it("registers the captured blurred dummy but renders its custom-texture equivalent once", () => {
    expect(PRIMAL_SPINE_SPECS.symbolBlurredDummy).toEqual({
      group: "spine_symbols",
      skeleton: "Symbol_blurred_dummy",
      idleAnimation: "animation",
    });
    expect(primalSpineSkeletonUrl("symbolBlurredDummy"))
      .toBe("/assets/primal-runtime/spine/spine_symbols/Symbol_blurred_dummy.skel");
    expect(PRIMAL_BLURRED_SYMBOL_PLACEHOLDER).toEqual({
      spineKey: "symbolBlurredDummy",
      renderStrategy: "filtered-live-symbol-strip",
      instantiateSpine: false,
      blurStrength: 9,
      blurX: 0.32,
      blurY: 16,
      quality: 5,
      repeatEdgePixels: true,
    });
    // ReelView 将 `quality` 用作 BlurFilter 的处理次数。保持其大于一，可避免 / English: ReelView uses `quality` as the number of passes for the BlurFilter. Keep it greater than one to avoid
    // 单次处理的移动条带出现明显色带。 / English: Obvious color bands appear in the moving strips processed in a single time.
    expect(PRIMAL_BLURRED_SYMBOL_PLACEHOLDER.quality).toBeGreaterThan(1);
    expect(PRIMAL_SYMBOL_SPINE_KEYS).not.toContain("symbolBlurredDummy");
  });

  it("rests on stop and exposes idle only to the cabinet-wide one-shot scheduler", () => {
    for (const symbol of SYMBOL_IDS) expect(authoredSymbolRestAnimation(symbol)).toBe("stop");
    expect(authoredSymbolIdleAnimation("ORBIT")).toBeNull();
    expect(authoredSymbolIdleAnimation("PRISM")).toBeNull();
    for (const symbol of ["PULSE", "NOVA", "TANK", "CIRCUIT", "WILD", "SURGE", "VAULT"] as const) {
      expect(authoredSymbolIdleAnimation(symbol)).toBe("idle");
    }
    expect(authoredSymbolWinAnimation("TANK")).toBe("win");
    expect(authoredSymbolWinAnimation("WILD")).toBe("win");
    expect(authoredSymbolWinAnimation("SURGE")).toBeNull();
    expect(authoredSymbolWinAnimation("VAULT")).toBeNull();
    expect(authoredCellIdleAnimation({ symbol: "VAULT" })).toBe("idle");
    expect(authoredCellIdleDurationMs({ symbol: "VAULT" })).toBeCloseTo(1_766.667);
    expect(authoredCellIdleAnimation({ symbol: "VAULT", prize: "GRAND", multiplier: 1_000 }))
      .toBe("idle");
    expect(authoredCellIdleDurationMs({
      symbol: "VAULT", prize: "GRAND", multiplier: 1_000,
    })).toBeCloseTo(1_766.7);
  });

  it("uses original value-pose tracks for authoritative Wild and Vault cells", () => {
    expect(authoredSymbolSpineKeyForCell({ symbol: "VAULT" })).toBe("symbol8");
    expect(authoredCellVariantAnimation({ symbol: "VAULT" })).toBe("x1");
    expect(authoredSymbolSpineKeyForCell({
      symbol: "VAULT", prize: "GRAND", multiplier: 1_000,
    })).toBe("symbol9");
    expect(authoredCellVariantAnimation({ symbol: "WILD" })).toBe("x_nomulti");
    for (const multiplier of [1, 2, 3, 5, 10, 25, 50, 100]) {
      expect(authoredCellVariantAnimation({ symbol: "WILD", multiplier })).toBe(`x${multiplier}`);
    }
    expect(authoredCellVariantAnimation({
      symbol: "VAULT", prize: "MINI_2X", multiplier: 20,
    })).toBe("mini_2x");
    expect(authoredCellVariantAnimation({ symbol: "VAULT", prize: "FREE_SPIN" }))
      .toBe("free_spin");
    expect(authoredCellVariantAnimation({ symbol: "VAULT", prize: "X9", multiplier: 9 }))
      .toBe("x9");
  });

  it("reserves Symbol9 feature_activation for the extra-Free-Spin Vault", () => {
    expect(authoredVaultFreeSpinActivation({ symbol: "VAULT", prize: "FREE_SPIN" }))
      .toBe("feature_activation");
    expect(authoredVaultFreeSpinActivation({ symbol: "VAULT", prize: "MINI", multiplier: 10 }))
      .toBeNull();
    expect(authoredVaultFreeSpinActivation({ symbol: "WILD", multiplier: 2 }))
      .toBeNull();
  });

  it("reserves a label fallback only for values absent from the supplied tracks", () => {
    expect(authoredCellVariantAnimation({ symbol: "WILD", multiplier: 17 })).toBeNull();
    expect(cellVariantFallbackLabel({ symbol: "WILD", multiplier: 17 })).toBe("×17");
    expect(authoredCellVariantAnimation({
      symbol: "VAULT", prize: "CUSTOM_AWARD", multiplier: 777,
    })).toBeNull();
    expect(cellVariantFallbackLabel({
      symbol: "VAULT", prize: "CUSTOM_AWARD", multiplier: 777,
    })).toBe("CUSTOM AWARD");
  });

  it("registers the original 1.2-second collection trail skeleton", () => {
    expect(PRIMAL_SPINE_SPECS.trail).toMatchObject({
      group: "spine_ui",
      skeleton: "trail",
      idleAnimation: "hidden",
    });
    expect(primalSpineSkeletonUrl("trail"))
      .toBe("/assets/primal-runtime/spine/spine_ui/trail.skel");
  });

  it("hides Rage content without revealing a replacement cell-glass plate", () => {
    expect(symbolContentVisibility(false, false, false)).toEqual({
      authoredLayer: true,
      cellGlass: true,
      staticArt: true,
      scan: true,
    });
    expect(symbolContentVisibility(true, false, false)).toEqual({
      authoredLayer: true,
      cellGlass: false,
      staticArt: false,
      scan: false,
    });
    expect(symbolContentVisibility(false, true, false)).toEqual({
      authoredLayer: false,
      cellGlass: false,
      staticArt: false,
      scan: false,
    });
    expect(symbolContentVisibility(true, true, false).cellGlass).toBe(false);
    expect(symbolContentVisibility(false, false, true).cellGlass).toBe(false);
    expect(symbolContentVisibility(false, true, true).cellGlass).toBe(false);
  });

  it("registers the captured wheel hyperspin control effect", () => {
    expect(PRIMAL_SPINE_SPECS.wheelHyperspin).toMatchObject({
      group: "spine_ui",
      skeleton: "wheel_hyperspin",
      idleAnimation: "hidden",
    });
    expect(primalSpineSkeletonUrl("wheelHyperspin"))
      .toBe("/assets/primal-runtime/spine/spine_ui/wheel_hyperspin.skel");
  });
});
