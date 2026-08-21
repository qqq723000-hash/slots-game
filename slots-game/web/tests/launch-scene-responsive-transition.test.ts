import { describe, expect, it, vi } from "vitest";
import {
  LaunchScene,
  PRIMAL_MOBILE_TRANSITION_MIN_BOUNDS,
  resolveLaunchTransitionLayout,
} from "../src/renderer/intro/LaunchScene";
import type { MobileLayoutProfile } from "../src/renderer/ResponsiveLayout";

function pointStub() {
  return { set: vi.fn() };
}

function graphicsStub() {
  const graphics = {
    clear: vi.fn(),
    beginFill: vi.fn(),
    drawRect: vi.fn(),
    endFill: vi.fn(),
  };
  graphics.clear.mockReturnValue(graphics);
  graphics.beginFill.mockReturnValue(graphics);
  graphics.drawRect.mockReturnValue(graphics);
  graphics.endFill.mockReturnValue(graphics);
  return graphics;
}

function sceneHarness() {
  const transitionHost = {
    pivot: pointStub(),
    position: pointStub(),
    scale: pointStub(),
  };
  const blackout = graphicsStub();
  const activeEntry = { trackTime: 1.5 };
  const scene = Object.create(LaunchScene.prototype) as LaunchScene;
  Object.assign(scene as unknown as Record<string, unknown>, {
    transitionHost,
    blackout,
    authoredIntroTimelineControlled: true,
    authoredIntroTimeMs: 1_234,
    characterIntroActive: true,
    characterIntroElapsedMs: 987,
    authoredLogo: {
      alpha: 0.42,
      visible: true,
      state: {
        getCurrent: vi.fn(() => activeEntry),
        clearTracks: vi.fn(),
        setAnimation: vi.fn(),
      },
    },
  });
  return { scene, transitionHost, blackout };
}

describe("LaunchScene responsive transition", () => {
  it.each([
    ["ls", { left: -600, top: -450, width: 1_200, height: 900 }],
    ["pt", { left: -600, top: -250, width: 1_200, height: 900 }],
    ["iPad_pt", { left: -600, top: -250, width: 1_200, height: 900 }],
  ] satisfies readonly (readonly [MobileLayoutProfile, object])[])(
    "uses the captured %s transition minBound",
    (profile, minBound) => {
      expect(PRIMAL_MOBILE_TRANSITION_MIN_BOUNDS[profile]).toEqual(minBound);
    },
  );

  it("contains the official portrait transition in the full mobile viewport", () => {
    const transform = resolveLaunchTransitionLayout(
      { left: 0, top: 0, width: 390, height: 844 },
      "pt",
    );

    expect(transform).toEqual({ x: 195, y: 357, scale: 0.325 });
  });

  it("reprojects and fully redraws the overlay without mutating the active intro", () => {
    const { scene, transitionHost, blackout } = sceneHarness();
    const authoredLogo = (scene as unknown as {
      authoredLogo: {
        alpha: number;
        visible: boolean;
        state: {
          getCurrent: ReturnType<typeof vi.fn<(track: number) => { trackTime: number }>>;
          clearTracks: ReturnType<typeof vi.fn>;
          setAnimation: ReturnType<typeof vi.fn>;
        };
      };
    }).authoredLogo;
    const entry = authoredLogo.state.getCurrent(0);

    scene.setResponsiveTransitionLayout(
      { left: 0, top: 0, width: 390, height: 844 },
      "pt",
    );
    scene.setResponsiveTransitionLayout(
      { left: 0, top: 0, width: 844, height: 390 },
      "ls",
    );

    expect(blackout.drawRect.mock.calls).toEqual([
      [0, 0, 390, 844],
      [0, 0, 844, 390],
    ]);
    expect(transitionHost.pivot.set).toHaveBeenLastCalledWith(640, 360);
    expect(transitionHost.position.set).toHaveBeenLastCalledWith(422, 195);
    expect(transitionHost.scale.set).toHaveBeenLastCalledWith(390 / 900);
    expect(authoredLogo.alpha).toBe(0.42);
    expect(authoredLogo.visible).toBe(true);
    expect(authoredLogo.state.getCurrent(0)).toBe(entry);
    expect(authoredLogo.state.clearTracks).not.toHaveBeenCalled();
    expect(authoredLogo.state.setAnimation).not.toHaveBeenCalled();
    expect((scene as unknown as { authoredIntroTimeMs: number }).authoredIntroTimeMs).toBe(1_234);
    expect((scene as unknown as { characterIntroElapsedMs: number }).characterIntroElapsedMs).toBe(987);
  });
});
