import { Container, Texture } from "pixi.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  loadSpines: vi.fn(),
  createSpine: vi.fn(),
}));

vi.mock("../src/renderer/spine/PrimalSpineAssets", () => ({
  loadPrimalSpineSet: loaders.loadSpines,
}));

vi.mock("../src/renderer/spine/SpineAdapter", () => ({
  createSpineView: loaders.createSpine,
  enforcePrimalRegionBlendModes: vi.fn(),
  SPINE_DEFAULT_MIX_SECONDS: 0.15,
}));

import { LaunchScene } from "../src/renderer/intro/LaunchScene";

interface MockSpine extends Container {
  autoUpdate: boolean;
  readonly state: {
    timeScale: number;
    hasAnimation(name: string): boolean;
    setAnimation: ReturnType<typeof vi.fn>;
    addAnimation: ReturnType<typeof vi.fn>;
    getCurrent: ReturnType<typeof vi.fn>;
    setEmptyAnimation: ReturnType<typeof vi.fn>;
    clearTrack: ReturnType<typeof vi.fn>;
    clearTracks: ReturnType<typeof vi.fn>;
  };
  update: ReturnType<typeof vi.fn>;
}

function createMockSpine(name: string): MockSpine {
  const spine = new Container() as MockSpine;
  spine.name = name;
  spine.autoUpdate = true;
  const current = new Map<number, object>();
  Object.defineProperty(spine, "state", {
    value: {
      timeScale: 1,
      hasAnimation: () => true,
      setAnimation: vi.fn((track: number) => {
        const entry = { animationEnd: 1, mixDuration: 0.15, trackTime: 0 };
        current.set(track, entry);
        return entry;
      }),
      addAnimation: vi.fn(),
      getCurrent: vi.fn((track: number) => current.get(track) ?? null),
      setEmptyAnimation: vi.fn((track: number) => {
        const entry = { animationEnd: 0, mixDuration: 0.15, trackTime: 0 };
        current.set(track, entry);
        return entry;
      }),
      clearTrack: vi.fn((track: number) => current.delete(track)),
      clearTracks: vi.fn(() => current.clear()),
    },
  });
  spine.update = vi.fn();
  return spine;
}

function createHarness(): {
  readonly scene: LaunchScene;
  readonly monsterHost: Container;
  readonly overlay: Container;
  readonly monsterFallback: {
    visible: boolean;
    setAtlasTexture: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
} {
  const scene = Object.create(LaunchScene.prototype) as LaunchScene;
  const monsterHost = new Container();
  const overlay = new Container();
  const monsterFallback = { visible: true, setAtlasTexture: vi.fn(), update: vi.fn() };
  const position = () => ({ set: vi.fn() });
  Object.assign(scene as unknown as Record<string, unknown>, {
    artworkLoad: null,
    authoredMonster: null,
    authoredLogo: null,
    characterIntroActive: false,
    authoredIntroTimelineControlled: false,
    authoredIntroTimeMs: 0,
    characterIntroElapsedMs: 0,
    characterBodyReleased: false,
    characterAuraReleased: false,
    characterIntroCapturePaused: false,
    idleLoopElapsedMs: 0,
    idleResumeRemainingMs: 0,
    idleResumeToBase: true,
    idleSchedulerActive: false,
    logo: { alpha: 1, visible: true, setAtlasTexture: vi.fn() },
    monsterFallback,
    monsterHost,
    overlay,
    transitionHost: overlay,
    leftTank: { texture: Texture.EMPTY, position: position(), width: 0, height: 0, alpha: 0 },
    rightTank: { texture: Texture.EMPTY, position: position(), width: 0, height: 0, alpha: 0 },
    persistentPresentation: { body: "base", auraLevel: null, palette: "main" },
    reducedMotion: false,
    wheelChestPoundElapsedMs: null,
  });
  return { scene, monsterHost, overlay, monsterFallback };
}

beforeEach(() => {
  loaders.loadSpines.mockReset().mockResolvedValue({
    character: { id: "character" },
    logoIntro: { id: "logo-intro" },
  });
  loaders.createSpine.mockReset();
  vi.spyOn(Texture, "fromURL").mockResolvedValue(Texture.EMPTY);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LaunchScene authored artwork ownership", () => {
  it("keeps ARTWORK_READY hidden with persistent body and aura projections gated", async () => {
    const { scene } = createHarness();
    const monster = createMockSpine("level-two-monster");
    const logo = createMockSpine("level-two-logo");
    loaders.createSpine
      .mockReturnValueOnce(monster)
      .mockReturnValueOnce(logo);

    scene.setCharacterPersistentPresentation({
      body: "base",
      auraLevel: 2,
      palette: "main",
    });
    expect(monster.state.setAnimation).not.toHaveBeenCalled();

    await scene.loadArtwork();

    expect(monster.state.setAnimation.mock.calls).toEqual([[1, "hidden", false]]);
    expect(monster.state.setAnimation).not.toHaveBeenCalledWith(1, "idle", true);
    expect(monster.state.setAnimation.mock.calls.some(
      ([track]) => track === 2 || track === 3,
    )).toBe(false);
    expect(monster.state.clearTrack.mock.calls).toEqual([[1]]);
    expect(monster.state.setEmptyAnimation).not.toHaveBeenCalled();
    expect(monster.state.setAnimation.mock.calls.some(([track]) => track === 4)).toBe(false);
    expect(monster.update).toHaveBeenCalledWith(0);
    expect(scene.getCharacterIntroLifecycleDiagnostics()).toMatchObject({
      introActive: false,
      introElapsedMs: 0,
      bodyReleased: false,
      auraReleased: false,
      idleSchedulerActive: false,
    });

    const callsAtArtworkReady = monster.state.setAnimation.mock.calls.length;
    for (let elapsedMs = 0; elapsedMs < 10_500; elapsedMs += 64) scene.update(64);
    expect(monster.state.setAnimation).toHaveBeenCalledTimes(callsAtArtworkReady);
    expect(monster.state.setAnimation).not.toHaveBeenCalledWith(1, "idle_breaker", false);
  });

  it("rolls back a partially created pair and retries without caching fallback success", async () => {
    const { scene, monsterHost, overlay, monsterFallback } = createHarness();
    const logoFailure = new Error("logo Spine create failed");
    const firstMonster = createMockSpine("first-monster");
    const retryMonster = createMockSpine("retry-monster");
    const retryLogo = createMockSpine("retry-logo");
    loaders.createSpine
      .mockReturnValueOnce(firstMonster)
      .mockImplementationOnce(() => { throw logoFailure; })
      .mockReturnValueOnce(retryMonster)
      .mockReturnValueOnce(retryLogo);

    await expect(scene.loadArtwork()).rejects.toBe(logoFailure);
    await Promise.resolve();

    expect(firstMonster.destroyed).toBe(true);
    expect(monsterHost.children).toHaveLength(0);
    expect(overlay.children).toHaveLength(0);
    expect(scene.hasAuthoredCharacter).toBe(false);
    expect(scene.hasAuthoredIntroLogo).toBe(false);
    expect(monsterFallback.visible).toBe(true);

    await expect(scene.loadArtwork()).resolves.toBeUndefined();

    expect(loaders.loadSpines).toHaveBeenCalledTimes(2);
    expect(monsterHost.children).toEqual([retryMonster]);
    expect(overlay.children).toEqual([retryLogo]);
    expect(scene.hasAuthoredCharacter).toBe(true);
    expect(scene.hasAuthoredIntroLogo).toBe(true);
    expect(monsterFallback.visible).toBe(false);
  });

  it("destroys staged Spine views when a sibling bitmap load fails", async () => {
    const { scene, monsterHost, overlay } = createHarness();
    const bitmapFailure = new Error("promotional atlas unavailable");
    vi.mocked(Texture.fromURL)
      .mockRejectedValueOnce(bitmapFailure)
      .mockResolvedValue(Texture.EMPTY);
    const stagedMonster = createMockSpine("staged-monster");
    const stagedLogo = createMockSpine("staged-logo");
    loaders.createSpine
      .mockReturnValueOnce(stagedMonster)
      .mockReturnValueOnce(stagedLogo);

    await expect(scene.loadArtwork()).rejects.toBe(bitmapFailure);

    expect(stagedMonster.destroyed).toBe(true);
    expect(stagedLogo.destroyed).toBe(true);
    expect(monsterHost.children).toHaveLength(0);
    expect(overlay.children).toHaveLength(0);
    expect(scene.hasAuthoredCharacter).toBe(false);
    expect(scene.hasAuthoredIntroLogo).toBe(false);
  });

  it("does not cache an already-aborted load as completed artwork", async () => {
    const { scene } = createHarness();
    const controller = new AbortController();
    const abortReason = new Error("test abort");
    controller.abort(abortReason);

    await expect(scene.loadArtwork(controller.signal)).rejects.toBe(abortReason);
    await Promise.resolve();
    expect(loaders.loadSpines).not.toHaveBeenCalled();

    loaders.createSpine
      .mockReturnValueOnce(createMockSpine("monster"))
      .mockReturnValueOnce(createMockSpine("logo"));
    await expect(scene.loadArtwork()).resolves.toBeUndefined();
    expect(loaders.loadSpines).toHaveBeenCalledTimes(1);
  });
});
