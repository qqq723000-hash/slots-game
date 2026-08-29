import { BaseTexture, Texture } from "pixi.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadLegacySpine: vi.fn(),
  loadVerifiedSpine: vi.fn(),
  loadLegacyFont: vi.fn(),
  installVerifiedFont: vi.fn(),
  loadVerifiedTexture: vi.fn(),
  disposeTexture: vi.fn(),
  coinLoad: vi.fn(),
  coinClear: vi.fn(),
}));

vi.mock("pixi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("pixi.js")>();
  class MockText extends actual.Container {
    text = "";
    readonly anchor = { set: vi.fn() };
    override get width(): number { return 100; }
    override set width(_value: number) {}
    override get height(): number { return 40; }
    override set height(_value: number) {}
  }
  class MockTextStyle {
    constructor(readonly options: unknown) {}
  }
  return { ...actual, Text: MockText, TextStyle: MockTextStyle };
});

vi.mock("../src/renderer/spine/PrimalSpineAssets", () => ({
  loadPrimalSpineData: mocks.loadLegacySpine,
  loadPrimalSpineDataFromVerifiedBinary: mocks.loadVerifiedSpine,
  primalSpineSkeletonUrl: () => "/assets/primal-runtime/spine/spine_ui/BigWin.skel",
}));

vi.mock("../src/renderer/PrimalBitmapFont", () => ({
  installPrimalBitmapFontFromVerifiedDescriptor: mocks.installVerifiedFont,
  loadPrimalBitmapFont: mocks.loadLegacyFont,
  PRIMAL_BITMAP_FONT_BASE: 296,
  PRIMAL_BITMAP_FONT_LINE_HEIGHT: 541,
  PRIMAL_BITMAP_FONT_NAME: "PrimalRampage",
  PRIMAL_BITMAP_FONT_PAGE_URL: "/assets/primal-runtime/fonts/primal-rampage/PrimalRampage.png",
  PRIMAL_BITMAP_FONT_SIZE: 295,
  PRIMAL_BITMAP_FONT_URL: "/assets/primal-runtime/fonts/primal-rampage/PrimalRampage.fnt",
}));

vi.mock("../src/renderer/pixiTextureCleanup", () => ({
  disposePixiTextureAttempt: mocks.disposeTexture,
  loadPixiTextureFromVerifiedBytes: mocks.loadVerifiedTexture,
}));

vi.mock("../src/renderer/BigWinCoinShower", async () => {
  const { Container: PixiContainer } = await import("pixi.js");
  class MockBigWinCoinShower extends PixiContainer {
    private loaded = false;
    get artworkLoaded(): boolean { return this.loaded; }
    async load(signal?: AbortSignal, options?: unknown): Promise<void> {
      await mocks.coinLoad(signal, options);
      this.loaded = true;
    }
    clearArtwork(): void {
      this.loaded = false;
      mocks.coinClear();
    }
    setReducedMotion(): void {}
    setTier(): void {}
    stop(): void {}
    update(): void {}
    killAll(): void {}
  }
  return {
    BIG_WIN_COIN_MANIFEST_URL: "/assets/primal-runtime/interface/big-win-coins.json",
    BigWinCoinShower: MockBigWinCoinShower,
  };
});

vi.mock("../src/renderer/spine/SpineAdapter", async () => {
  const { Container: PixiContainer } = await import("pixi.js");
  return {
    createSpineView: () => Object.assign(new PixiContainer(), {
      autoUpdate: true,
      update: vi.fn(),
      skeleton: {
        color: { a: 1 },
        setSkinByName: vi.fn(),
        setSlotsToSetupPose: vi.fn(),
        setToSetupPose: vi.fn(),
        findSlot: vi.fn(() => null),
        findBone: vi.fn(() => null),
      },
      state: {
        clearTracks: vi.fn(),
        hasAnimation: vi.fn(() => true),
        setAnimation: vi.fn(),
        addAnimation: vi.fn(),
      },
    }),
  };
});

import {
  BigWinView,
  type BigWinVerifiedArtworkPayload,
} from "../src/renderer/BigWinView";

const payload: BigWinVerifiedArtworkPayload = Object.freeze({
  channel: "desktop",
  spineBinary: Uint8Array.of(1, 2, 3),
  fontDescriptor: "verified font",
  fontPageBytes: Uint8Array.of(137, 80, 78, 71),
  coinManifest: Object.freeze({ verified: true }),
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.loadVerifiedSpine.mockResolvedValue({ verifiedSpine: true });
  mocks.installVerifiedFont.mockReturnValue({ installed: false, adoptedPageTexture: false });
  mocks.coinLoad.mockResolvedValue(undefined);
});

describe("BigWinView verified event payload", () => {
  it("uses no legacy URL loader and keeps the adopted BaseTexture alive after lease release", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const texture = new Texture(new BaseTexture());
    mocks.loadVerifiedTexture.mockResolvedValue(texture);
    const controller = new AbortController();
    const view = new BigWinView();

    await expect(view.loadArtwork(controller.signal, undefined, payload)).resolves.toBeUndefined();
    expect(mocks.loadLegacySpine).not.toHaveBeenCalled();
    expect(mocks.loadLegacyFont).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.loadVerifiedSpine).toHaveBeenCalledWith(
      "bigWin",
      payload.spineBinary,
      "desktop",
      controller.signal,
    );
    expect(mocks.loadVerifiedTexture).toHaveBeenCalledWith(
      payload.fontPageBytes,
      "image/png",
      controller.signal,
    );
    expect(mocks.coinLoad).toHaveBeenCalledWith(
      controller.signal,
      expect.objectContaining({
        verifiedManifest: payload.coinManifest,
        verifiedAtlasTexture: texture,
      }),
    );

    // AppController.release() 会 abort 事件 signal；成功采用的 GPU owner 不再订阅它。 / English: AppController.release() aborts the event signal; the successfully adopted GPU owner no longer subscribes to it.
    controller.abort(new Error("presentation complete"));
    expect(mocks.disposeTexture).not.toHaveBeenCalled();
    expect(texture.baseTexture.destroyed).toBe(false);
    view.destroy({ children: true });
    expect(mocks.disposeTexture).toHaveBeenCalledOnce();
    expect(mocks.disposeTexture).toHaveBeenCalledWith(texture);
    vi.unstubAllGlobals();
  });

  it("disposes a failed generation and retries with a distinct verified texture", async () => {
    const oldTexture = new Texture(new BaseTexture());
    const newTexture = new Texture(new BaseTexture());
    mocks.loadVerifiedTexture
      .mockResolvedValueOnce(oldTexture)
      .mockResolvedValueOnce(newTexture);
    mocks.coinLoad
      .mockRejectedValueOnce(new Error("first generation failed"))
      .mockResolvedValueOnce(undefined);
    const view = new BigWinView();

    await expect(view.loadArtwork(undefined, undefined, payload))
      .rejects.toThrow("first generation failed");
    expect(mocks.disposeTexture).toHaveBeenCalledWith(oldTexture, [null]);
    await expect(view.loadArtwork(undefined, undefined, payload)).resolves.toBeUndefined();
    expect(mocks.loadVerifiedTexture).toHaveBeenCalledTimes(2);
    expect(mocks.coinLoad).toHaveBeenCalledTimes(2);
    expect(mocks.disposeTexture).not.toHaveBeenCalledWith(newTexture, [null]);

    view.destroy({ children: true });
    expect(mocks.disposeTexture).toHaveBeenCalledWith(newTexture);
  });
});
