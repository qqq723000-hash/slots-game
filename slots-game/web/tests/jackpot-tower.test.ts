// @ts-nocheck -- 仅在 Node 中运行的真实 Spine 材质与绘制顺序证据校验器。
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
import {
  BaseTexture,
  BLEND_MODES,
  Container,
  Matrix,
  TEXT_GRADIENT,
} from "pixi.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const jackpotTowerSpines = vi.hoisted(() => ({
  create: vi.fn(),
  enforceBlendModes: vi.fn(),
  load: vi.fn(),
}));

vi.mock("../src/renderer/spine/PrimalSpineAssets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/spine/PrimalSpineAssets")>()),
  loadPrimalSpineSet: jackpotTowerSpines.load,
}));

vi.mock("../src/renderer/spine/SpineAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/spine/SpineAdapter")>()),
  createSpineView: jackpotTowerSpines.create,
  enforcePrimalRegionBlendModes: jackpotTowerSpines.enforceBlendModes,
}));

import {
  JACKPOT_AUTHORED_TIME_SCALE,
  JACKPOT_COLLECTION_REACTION_STEP_MS,
  JACKPOT_FONT_DESCRIPTOR,
  JACKPOT_FONT_FAMILY,
  JACKPOT_TIER_LAYOUTS,
  JackpotTowerView,
  jackpotCollectionReactionPlan,
  jackpotDisplayValue,
  jackpotTierResponsiveLayout,
  jackpotTierFromAward,
} from "../src/renderer/JackpotTowerView";
import { readableSpineTextTransform } from "../src/renderer/PrimalPanelText";
import { computeResponsiveFrameGeometry } from "../src/renderer/ResponsiveLayout";

const JACKPOT_SPINE_DIRECTORY = resolve(
  process.cwd(),
  "public/assets/primal-runtime/spine/spine_ui",
);

interface MockJackpotSpine extends Container {
  autoUpdate: boolean;
  readonly slotContainers: Container[];
  readonly skeleton: {
    findSlot: ReturnType<typeof vi.fn>;
    slots: Array<{
      data: { index: number };
      bone: {
        matrix: { a: number; b: number; c: number; d: number };
        localToWorld: ReturnType<typeof vi.fn>;
        worldX: number;
        worldY: number;
      };
      currentMesh: { renderable: boolean };
      currentSprite: { renderable: boolean };
      color: { a: number };
      getAttachment: ReturnType<typeof vi.fn>;
    }>;
  };
  readonly state: {
    hasAnimation: ReturnType<typeof vi.fn>;
    setAnimation: ReturnType<typeof vi.fn>;
    addAnimation: ReturnType<typeof vi.fn>;
    setEmptyAnimation: ReturnType<typeof vi.fn>;
    clearTrack: ReturnType<typeof vi.fn>;
  };
  readonly update: ReturnType<typeof vi.fn>;
}

let loadedSpines: MockJackpotSpine[] = [];

class TestCanvas {
  width = 0;
  height = 0;

  getContext(): object {
    return {
      clearRect: () => undefined,
      createLinearGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      fillText: () => undefined,
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(Math.max(4, width * height * 4)),
      }),
      measureText: (text: string) => ({ width: Math.max(1, text.length * 10) }),
      putImageData: () => undefined,
      scale: () => undefined,
      strokeText: () => undefined,
    };
  }
}

class TestElement {}
class TestImageElement extends TestElement {}
class TestImageBitmap extends TestElement {}
class TestSvgElement extends TestElement {}

const shimKeys = [
  "HTMLCanvasElement",
  "HTMLImageElement",
  "ImageBitmap",
  "SVGElement",
  "document",
] as const;
const previousGlobals = new Map(shimKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const fontLoad = vi.fn(async () => [JACKPOT_FONT_FAMILY]);

function createMockJackpotSpine(name: string): MockJackpotSpine {
  const view = new Container() as MockJackpotSpine;
  view.name = name;
  view.autoUpdate = true;
  const slotContainers = Array.from({ length: 74 }, (_, index) => {
    const slotContainer = new Container();
    slotContainer.name = `slot-${index}`;
    vi.spyOn(slotContainer.transform, "setFromMatrix");
    return slotContainer;
  });
  view.addChild(...slotContainers);
  const slots = Array.from({ length: 74 }, (_, index) => ({
    data: { index },
    bone: {
      matrix: new Matrix(1, 0, 0, -1, 0, 0),
      localToWorld: vi.fn(),
      worldX: 0,
      worldY: 0,
    },
    currentMesh: { renderable: true },
    currentSprite: { renderable: true },
    color: { a: 1 },
    getAttachment: vi.fn(() => index === 44 || index === 46
      ? { vertices: [-80, -20, 80, -20, 80, 20, -80, 20] }
      : { region: { name: "normal/mock" } }),
  }));
  const slotFor = (slotName: string) => {
    const index = slotName.endsWith("Title") ? 44 : slotName.endsWith("Value") ? 46 : -1;
    return index < 0 ? null : slots[index];
  };
  Object.defineProperties(view, {
    skeleton: {
      value: { findSlot: vi.fn(slotFor), slots },
    },
    slotContainers: {
      value: slotContainers,
    },
    state: {
      value: {
        hasAnimation: vi.fn(() => true),
        setAnimation: vi.fn(() => ({ mixDuration: 0 })),
        addAnimation: vi.fn(() => ({ mixDuration: 0 })),
        setEmptyAnimation: vi.fn(() => ({ mixDuration: 0 })),
        clearTrack: vi.fn(),
      },
    },
    update: {
      value: vi.fn(),
    },
  });
  return view;
}

function panelSpine(tier: "grand" | "mega" | "major" | "minor" | "mini"): MockJackpotSpine {
  const index = JACKPOT_TIER_LAYOUTS.findIndex((layout) => layout.tier === tier);
  const spine = loadedSpines[index];
  if (!spine) throw new Error(`missing mocked ${tier} jackpot Spine`);
  return spine;
}

async function loadTower(): Promise<JackpotTowerView> {
  const tower = new JackpotTowerView();
  await tower.loadArtwork();
  expect(loadedSpines).toHaveLength(JACKPOT_TIER_LAYOUTS.length);
  return tower;
}

function panelText(
  tier: "grand" | "mega" | "major" | "minor" | "mini",
  slotIndex: 44 | 46,
): { readonly host: Container; readonly text: { style: Record<string, unknown> } } {
  const host = panelSpine(tier).slotContainers[slotIndex]?.children[0] as Container | undefined;
  const text = host?.children[0] as { style: Record<string, unknown> } | undefined;
  if (!host || !text) throw new Error(`missing mocked ${tier} text host at slot ${slotIndex}`);
  return { host, text };
}

function animationNames(view: MockJackpotSpine): string[] {
  return view.state.setAnimation.mock.calls.map(([, animation]) => animation as string);
}

function loadAtlas(text: string): Promise<TextureAtlas> {
  return new Promise((resolveAtlas, reject) => {
    new TextureAtlas(
      text,
      (_page, complete) => complete(new BaseTexture()),
      (atlas) => atlas ? resolveAtlas(atlas) : reject(new Error("jackpot Spine atlas parse failed")),
    );
  });
}

beforeAll(() => {
  Object.assign(globalThis, {
    HTMLCanvasElement: TestCanvas,
    HTMLImageElement: TestImageElement,
    ImageBitmap: TestImageBitmap,
    SVGElement: TestSvgElement,
    document: { createElement: () => new TestCanvas(), fonts: { load: fontLoad } },
  });
});

afterAll(() => {
  for (const key of shimKeys) {
    const previous = previousGlobals.get(key);
    if (previous === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, previous);
  }
});

beforeEach(() => {
  fontLoad.mockClear();
  loadedSpines = [];
  jackpotTowerSpines.load.mockReset().mockResolvedValue(
    Object.fromEntries(JACKPOT_TIER_LAYOUTS.map(({ key }) => [key, { key }])),
  );
  jackpotTowerSpines.create.mockReset().mockImplementation((data: { key: string }) => {
    const spine = createMockJackpotSpine(data.key);
    loadedSpines.push(spine);
    return spine;
  });
  jackpotTowerSpines.enforceBlendModes.mockReset().mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authored jackpot tower", () => {
  it("uses the original five desktop transforms", () => {
    expect(JACKPOT_TIER_LAYOUTS.map(({ key, x, y, scale }) => ({ key, x, y, scale }))).toEqual([
      { key: "jackpotGrand", x: 244, y: 280, scale: 0.8 },
      { key: "jackpotMega", x: 244, y: 367.2, scale: 0.72 },
      { key: "jackpotMajor", x: 244, y: 445.090909, scale: 720 / 1_100 },
      { key: "jackpotMinor", x: 244, y: 516, scale: 0.6 },
      { key: "jackpotMini", x: 244, y: 581.538462, scale: 720 / 1_300 },
    ]);
  });

  it("reprojects every official jackpot minBound at tablet and portrait widths", () => {
    const cases = [
      { viewport: [1_024, 768] as const, x: 109.714, miniY: 609.055 },
      { viewport: [390, 844] as const, x: 41.786, miniY: 507.714 },
    ];

    for (const { viewport: [width, height], x, miniY } of cases) {
      const frame = computeResponsiveFrameGeometry(width, height);
      const projected = JACKPOT_TIER_LAYOUTS.map((layout) => {
        const transform = jackpotTierResponsiveLayout(layout, frame.visibleInsetX);
        return {
          key: layout.key,
          x: frame.x + transform.x * frame.scale,
          y: frame.y + transform.y * frame.scale,
          scale: transform.scale * frame.scale,
        };
      });

      for (const panel of projected) expect(panel.x).toBeCloseTo(x, 3);
      expect(projected.at(-1)?.y).toBeCloseTo(miniY, 3);
      for (let index = 0; index < projected.length; index += 1) {
        expect(projected[index]?.scale).toBeLessThanOrEqual(
          JACKPOT_TIER_LAYOUTS[index]!.scale * frame.scale,
        );
      }
    }
  });

  it("retains every height-limited desktop transform", () => {
    for (const layout of JACKPOT_TIER_LAYOUTS) {
      expect(jackpotTierResponsiveLayout(layout, 64).x).toBeCloseTo(layout.x, 10);
      expect(jackpotTierResponsiveLayout(layout, 64).y).toBeCloseTo(layout.y, 6);
      expect(jackpotTierResponsiveLayout(layout, 64).scale).toBeCloseTo(layout.scale, 10);
    }
  });

  it("projects wager values using integer minor units", () => {
    expect(jackpotDisplayValue("100", 1_000n)).toBe("1000.00");
    expect(jackpotDisplayValue("100", 250n)).toBe("250.00");
    expect(jackpotDisplayValue("100", 75n)).toBe("75.00");
    expect(jackpotDisplayValue("100", 30n)).toBe("30.00");
    expect(jackpotDisplayValue("100", 10n)).toBe("10.00");
  });

  it("uses the captured KANIT_BOLD title and value style instead of synthetic heavy text", async () => {
    await loadTower();
    const { text: title } = panelText("grand", 44);
    const { text: value } = panelText("grand", 46);
    const lightGradient = [
      "#ffffff",
      "#727e9c",
      "#ffffff",
      "#9fa6be",
      "#94b1c3",
    ];
    const gradientStops = [0.33, 0.38, 0.75, 0.8, 1];
    const fields = ["grand", "mega", "major", "minor", "mini"].flatMap((tier) => [
      panelText(tier, 44).text,
      panelText(tier, 46).text,
    ]);

    for (const field of fields) {
      expect(field.style.fontFamily).toContain(JACKPOT_FONT_FAMILY);
      expect(field.style.fontWeight).toBe("normal");
      expect(field.style.stroke).toBe("#22140e");
      expect(field.style.strokeThickness).toBe(6);
      expect(field.style.dropShadow).toBe(true);
      expect(field.style.dropShadowAlpha).toBe(10);
      expect(field.style.dropShadowAngle).toBe(1.57);
      expect(field.style.dropShadowBlur).toBe(0);
      expect(field.style.dropShadowColor).toBe("#1d2f2f");
      expect(field.style.dropShadowDistance).toBe(5);
      expect(field.style.fill).toEqual(lightGradient);
      expect(field.style.fillGradientType).toBe(TEXT_GRADIENT.LINEAR_VERTICAL);
      expect(field.style.fillGradientStops).toEqual(gradientStops);
    }
    expect(title.style.fontSize).toBe(45);
    expect(value.style.fontSize).toBe(48);
    expect(fontLoad).toHaveBeenCalledWith(JACKPOT_FONT_DESCRIPTOR, "GRAND 1000.00");
  });

  it("does not rasterize any Jackpot Text before KANIT_BOLD is ready", async () => {
    let releaseFont!: (loaded: readonly string[]) => void;
    fontLoad.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFont = resolve;
    }));
    const tower = new JackpotTowerView();
    const loading = tower.loadArtwork();

    await Promise.resolve();
    expect(fontLoad).toHaveBeenCalledWith(JACKPOT_FONT_DESCRIPTOR, "GRAND 1000.00");
    expect(jackpotTowerSpines.create).not.toHaveBeenCalled();

    releaseFont([JACKPOT_FONT_FAMILY]);
    await loading;
    expect(jackpotTowerSpines.create).toHaveBeenCalledTimes(5);
  });

  it("locks every Jackpot Spine to the source timeScale", async () => {
    await loadTower();
    expect(JACKPOT_AUTHORED_TIME_SCALE).toBe(1);
    expect(jackpotTowerSpines.create).toHaveBeenCalledTimes(5);
    for (const [, options] of jackpotTowerSpines.create.mock.calls) {
      expect(options).toMatchObject({
        animation: "idle",
        loop: true,
        timeScale: JACKPOT_AUTHORED_TIME_SCALE,
      });
    }
  });

  it("keeps the official light/dark gradients through award and show recovery", async () => {
    const tower = await loadTower();
    const lightGradient = [
      "#ffffff",
      "#727e9c",
      "#ffffff",
      "#9fa6be",
      "#94b1c3",
    ];
    const darkGradient = [
      "#474747",
      "#505972",
      "#474747",
      "#717c9f",
      "#474747",
    ];
    const gradientStops = [0.33, 0.38, 0.75, 0.8, 1];

    tower.highlightAwards(["grand"]);

    for (const slot of [44, 46] as const) {
      expect(panelText("grand", slot).text.style.fill).toEqual(lightGradient);
      expect(panelText("mega", slot).text.style.fill).toEqual(darkGradient);
      expect(panelText("grand", slot).text.style.fillGradientStops).toEqual(gradientStops);
      expect(panelText("mega", slot).text.style.fillGradientStops).toEqual(gradientStops);
    }

    tower.resetPanelAnimations();

    for (const tier of ["grand", "mega", "major", "minor", "mini"] as const) {
      for (const slot of [44, 46] as const) {
        expect(panelText(tier, slot).text.style.fill).toEqual(lightGradient);
        expect(panelText(tier, slot).text.style.fillGradientStops).toEqual(gradientStops);
      }
    }
  });

  it("fails closed for malformed monetary input", () => {
    expect(jackpotDisplayValue("1.00", 1_000n)).toBe("0.00");
  });

  it("maps only authored jackpot award identifiers", () => {
    expect(jackpotTierFromAward("GRAND")).toBe("grand");
    expect(jackpotTierFromAward("major_2x")).toBe("major");
    expect(jackpotTierFromAward("FREE_SPIN")).toBeNull();
    expect(jackpotTierFromAward(undefined)).toBeNull();
  });

  it("reacts from MINI to GRAND in exact 200ms steps", () => {
    expect(JACKPOT_COLLECTION_REACTION_STEP_MS).toBe(200);
    expect(jackpotCollectionReactionPlan()).toEqual([
      { tier: "mini", atMs: 0 },
      { tier: "minor", atMs: 200 },
      { tier: "major", atMs: 400 },
      { tier: "mega", atMs: 600 },
      { tier: "grand", atMs: 800 },
    ]);
  });

  it("locks all five 74-slot Jackpot rigs and their authored animation durations", async () => {
    const atlasBytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, "spine_ui.atlas"));
    const atlas = await loadAtlas(atlasBytes.toString("utf8"));
    try {
      for (const tier of ["grand", "mega", "major", "minor", "mini"] as const) {
        const bytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, `${tier}_jackpot.skel`));
        const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
          .readSkeletonData(new Uint8Array(bytes));
        const durations = Object.fromEntries(
          data.animations.map((animation) => [animation.name, animation.duration]),
        );

        expect(data.slots).toHaveLength(74);
        expect(data.findSlot(`${tier}Title`)?.index).toBe(44);
        expect(data.findSlot(`${tier}Value`)?.index).toBe(46);
        expect(durations.trail_reaction).toBeCloseTo(1.0667, 4);
        expect(durations.win_shooting).toBeCloseTo(1.3333, 4);
        expect(durations.loop).toBeCloseTo(1.3333, 4);
        expect(durations.show).toBeCloseTo(0.3333, 4);
      }
    } finally {
      atlas.dispose();
    }
  });

  it("locks the real Grand title/value draw slots around live post-text FX", async () => {
    const atlasBytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, "spine_ui.atlas"));
    const grandBytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, "grand_jackpot.skel"));
    expect(createHash("sha256").update(grandBytes).digest("hex"))
      .toBe("60b4b2689e577b1b0bb46b60c8d1ca07cce992d0a24c0a60eea23cd72ea69f5e");

    const atlas = await loadAtlas(atlasBytes.toString("utf8"));
    try {
      const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
        .readSkeletonData(new Uint8Array(grandBytes));
      const names = data.slots.map((slot) => slot.name);

      expect(data.slots).toHaveLength(74);
      expect(data.slots.slice(44, 47).map((slot) => slot.blendMode))
        .toEqual([BLEND_MODES.NORMAL, BLEND_MODES.NORMAL, BLEND_MODES.NORMAL]);
      expect(data.slots.slice(47, 59).every((slot) => slot.blendMode === BLEND_MODES.ADD))
        .toBe(true);
      expect(data.slots.slice(59, 74).every((slot) => slot.blendMode === BLEND_MODES.NORMAL))
        .toBe(true);

      // 数值是注入两个预设边界槽位的原生 Pixi 文本，因此 Spine 自身会保持
      // 标题 → 火焰 → 数值 → 前景的顺序。
      expect(names.slice(44, 47)).toEqual([
        "grandTitle",
        "fire_fx/fire_fx_02",
        "grandValue",
      ]);
      const boundingCentre = (slotName: string) => {
        const vertices = (new Skeleton(data).findSlot(slotName)!.getAttachment() as {
          vertices: number[];
        }).vertices;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index < vertices.length; index += 2) {
          minX = Math.min(minX, vertices[index]!);
          maxX = Math.max(maxX, vertices[index]!);
          minY = Math.min(minY, vertices[index + 1]!);
          maxY = Math.max(maxY, vertices[index + 1]!);
        }
        return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      };
      // 这些是新槽位宿主使用的预设局部原点。它们刻意保留在 Spine 局部空间中；
      // 每次脉冲和倾斜都由实时骨骼矩阵处理，无需用同级节点位置近似。
      expect(boundingCentre("grandTitle").x).toBeCloseTo(-1.875, 5);
      expect(boundingCentre("grandTitle").y).toBeCloseTo(1.515, 5);
      expect(boundingCentre("grandValue").x).toBeCloseTo(-4.67, 5);
      expect(boundingCentre("grandValue").y).toBeCloseTo(1.575, 5);
      expect(names.slice(47, 59)).toEqual([
        "line_storm7",
        "line_storm8",
        "line_storm9",
        "line_storm10",
        "line_storm6",
        "line_storm11",
        "line_storm12",
        "glow (179)",
        "glow (179)6",
        "glow (179)3",
        "glow (179)4",
        "glow (179)2",
      ]);

      const skeleton = new Skeleton(data);
      const state = new AnimationState(new AnimationStateData(data));
      state.setAnimation(0, "win_shooting", false);
      state.update(0.2);
      state.apply(skeleton);

      const activePostText = skeleton.slots
        .map((slot, index) => ({
          index,
          name: slot.data.name,
          attachment: slot.getAttachment(),
          additive: slot.data.blendMode === BLEND_MODES.ADD,
        }))
        .filter((slot) => slot.index > 46 && slot.attachment);
      expect(activePostText.map(({ index }) => index)).toEqual(expect.arrayContaining([
        54, // ADD glow after title/value.
        59, // Normal fire after title/value.
        60, // Debris after title/value.
        62, // Smoke after title/value.
        64, // Broken-panel pieces after title/value.
      ]));
      expect(activePostText.some(({ index, additive }) => index === 54 && additive)).toBe(true);
    } finally {
      atlas.dispose();
    }
  });

  it("injects Grand title/fire/value into the original one-Spine slot order", async () => {
    const tower = await loadTower();
    const base = panelSpine("grand");
    const panel = tower.children[0]!;
    const titleSlot = base.slotContainers[44]!;
    const fireSlot = base.slotContainers[45]!;
    const valueSlot = base.slotContainers[46]!;
    const titleHost = titleSlot.children[0] as Container;
    const valueHost = valueSlot.children[0] as Container;

    expect(panel.children).toHaveLength(1);
    expect(panel.children[0]).toBe(base);
    expect((titleHost.children[0] as { text?: string }).text).toBe("GRAND");
    expect((valueHost.children[0] as { text?: string }).text).toBe("0.00");
    expect(titleHost.parent).toBe(titleSlot);
    expect(valueHost.parent).toBe(valueSlot);
    // Spine 按骨架绘制顺序更新 `children`，因此火焰槽位 45 始终严格位于
    // 外部提供的原生标题和数值文本字段之间。
    expect(base.children.indexOf(titleSlot)).toBeLessThan(base.children.indexOf(fireSlot));
    expect(base.children.indexOf(fireSlot)).toBeLessThan(base.children.indexOf(valueSlot));
    expect(titleHost.scale.y).toBe(-1);
    expect(valueHost.scale.y).toBe(-1);

    // 槽位 44/46 是运行时 BoundingBox 占位符。修复后，其容器仍对文本可见，
    // 但绝不允许过期的图集切片泄漏到任一字段后方；槽位 45 仍是正常的预设
    // FX 槽位。
    expect(base.skeleton.slots[44]?.currentSprite.renderable).toBe(false);
    expect(base.skeleton.slots[46]?.currentSprite.renderable).toBe(false);
    expect(base.skeleton.slots[45]?.currentSprite.renderable).toBe(true);
  });

  it("restores BoundingBox text-slot matrices after every live Jackpot pose", async () => {
    const tower = await loadTower();
    const base = panelSpine("grand");
    const { host: titleHost, text: title } = panelText("grand", 44);
    const { host: valueHost, text: value } = panelText("grand", 46);
    base.skeleton.slots[44]!.bone.matrix = new Matrix(0.96, 0.72, 0.72, -0.96, 0, 0);
    base.skeleton.slots[46]!.bone.matrix = new Matrix(1.2, -0.9, -0.45, -0.6, 0, 0);
    base.skeleton.slots[44]!.color.a = 0.42;
    base.skeleton.slots[46]!.color.a = 0.75;
    base.update.mockImplementationOnce(() => {
      base.slotContainers[44]!.visible = false;
      base.slotContainers[46]!.visible = false;
      base.skeleton.slots[44]!.currentSprite.renderable = true;
      base.skeleton.slots[44]!.currentMesh.renderable = true;
      base.skeleton.slots[46]!.currentSprite.renderable = true;
      base.skeleton.slots[46]!.currentMesh.renderable = true;
    });

    tower.setHudReveal(1);
    tower.update(16);

    expect(base.slotContainers[44]!.transform.setFromMatrix)
      .toHaveBeenLastCalledWith(base.skeleton.slots[44]!.bone.matrix);
    expect(base.slotContainers[46]!.transform.setFromMatrix)
      .toHaveBeenLastCalledWith(base.skeleton.slots[46]!.bone.matrix);
    expect(base.slotContainers[44]!.visible).toBe(true);
    expect(base.slotContainers[46]!.visible).toBe(true);
    expect(base.slotContainers[44]!.alpha).toBeCloseTo(0.42);
    expect(base.slotContainers[46]!.alpha).toBeCloseTo(0.75);
    expect(base.skeleton.slots[44]!.currentSprite.renderable).toBe(false);
    expect(base.skeleton.slots[44]!.currentMesh.renderable).toBe(false);
    expect(base.skeleton.slots[46]!.currentSprite.renderable).toBe(false);
    expect(base.skeleton.slots[46]!.currentMesh.renderable).toBe(false);
    // 嵌套宿主只抵消 Spine 的 Y 轴镜像。缩放和旋转仍保留在原生槽位矩阵上，
    // 渲染出的 Text 会继承该矩阵。
    expect(titleHost.scale.y).toBe(-1);
    expect(valueHost.scale.y).toBe(-1);
    expect((title as { rotation: number }).rotation).toBe(0);
    expect((value as { rotation: number }).rotation).toBe(0);
  });

  it("reads the captured Grand trail pulse from the original Spine matrices", async () => {
    const atlasBytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, "spine_ui.atlas"));
    const grandBytes = readFileSync(resolve(JACKPOT_SPINE_DIRECTORY, "grand_jackpot.skel"));
    const atlas = await loadAtlas(atlasBytes.toString("utf8"));
    try {
      const data = new SkeletonBinary(new AtlasAttachmentLoader(atlas))
        .readSkeletonData(new Uint8Array(grandBytes));
      const skeleton = new Skeleton(data);
      const state = new AnimationState(new AnimationStateData(data));
      state.setAnimation(0, "trail_reaction", false);
      const sample = (deltaSeconds: number) => {
        state.update(deltaSeconds);
        state.apply(skeleton);
        skeleton.updateWorldTransform({ x: 0, y: 0 });
        return {
          title: readableSpineTextTransform(skeleton.findSlot("grandTitle")!.bone.matrix),
          value: readableSpineTextTransform(skeleton.findSlot("grandValue")!.bone.matrix),
        };
      };

      const shrink = sample(0.2);
      expect(shrink.title.scaleX).toBeCloseTo(0.878, 5);
      expect(shrink.value.scaleX).toBeCloseTo(0.880386, 5);
      expect(shrink.title.rotation).toBeCloseTo(0, 7);
      expect(shrink.value.rotation).toBeCloseTo(0, 7);

      const pulse = sample(0.4);
      expect(pulse.title.scaleX).toBeCloseTo(1.073657, 5);
      expect(pulse.value.scaleX).toBeCloseTo(1.186261, 5);

      const settled = sample(0.466667);
      expect(settled.title.scaleX).toBeCloseTo(1, 4);
      expect(settled.value.scaleX).toBeCloseTo(1, 4);
    } finally {
      atlas.dispose();
    }
  });

  it("enforces ADD materials immediately after every newly loaded Jackpot Spine view", async () => {
    await loadTower();

    expect(jackpotTowerSpines.enforceBlendModes).toHaveBeenCalledTimes(5);
    expect(jackpotTowerSpines.enforceBlendModes.mock.calls.map(([view]) => view))
      .toEqual(loadedSpines);
  });

  it("re-enforces the ADD material when a collection or award changes a live pose", async () => {
    const tower = await loadTower();
    jackpotTowerSpines.enforceBlendModes.mockClear();

    tower.reactToCollection();
    const mini = panelSpine("mini");
    expect(mini.state.setAnimation).toHaveBeenCalledWith(0, "trail_reaction", false);
    expect(jackpotTowerSpines.enforceBlendModes.mock.calls.map(([view]) => view))
      .toEqual([mini]);

    jackpotTowerSpines.enforceBlendModes.mockClear();
    tower.highlightAwards(["grand"]);
    const grand = panelSpine("grand");
    expect(grand.state.setAnimation).toHaveBeenCalledWith(0, "win_shooting", false);
    expect(grand.state.addAnimation).toHaveBeenCalledWith(0, "loop", true, 0);
    expect(jackpotTowerSpines.enforceBlendModes.mock.calls.map(([view]) => view))
      .toEqual(loadedSpines);
  });

  it("does not reset a never-highlighted Jackpot tower", async () => {
    const tower = await loadTower();
    jackpotTowerSpines.enforceBlendModes.mockClear();

    tower.resetPanelAnimations();

    for (const spine of loadedSpines) {
      expect(spine.state.clearTrack).not.toHaveBeenCalled();
      expect(animationNames(spine)).not.toContain("show");
    }
    expect(jackpotTowerSpines.enforceBlendModes).not.toHaveBeenCalled();
  });

  it("resets an already highlighted tower exactly once", async () => {
    const tower = await loadTower();
    tower.highlightAwards(["grand"]);

    tower.resetPanelAnimations();
    tower.resetPanelAnimations();

    for (const spine of loadedSpines) {
      expect(animationNames(spine).filter((animation) => animation === "show")).toHaveLength(1);
    }
  });

  it("mixes out every award track before replacement without clearing attachments", async () => {
    const tower = await loadTower();
    tower.highlightAwards(["grand"]);
    tower.resetPanelAnimations();

    for (const spine of loadedSpines) {
      const awardAnimation = spine === panelSpine("grand") ? "win_shooting" : "darkness";
      expect(spine.state.setEmptyAnimation.mock.calls).toEqual([
        [0, 0.15],
        [0, 0.15],
      ]);
      expect(animationNames(spine)).toEqual([awardAnimation, "show"]);
      expect(spine.state.clearTrack).not.toHaveBeenCalled();

      const emptyOrders = spine.state.setEmptyAnimation.mock.invocationCallOrder;
      const replacementOrders = spine.state.setAnimation.mock.invocationCallOrder;
      expect(emptyOrders[0]).toBeLessThan(replacementOrders[0]!);
      expect(replacementOrders[0]).toBeLessThan(emptyOrders[1]!);
      expect(emptyOrders[1]).toBeLessThan(replacementOrders[1]!);

      const awardEntry = spine.state.setAnimation.mock.results[0]?.value as {
        mixDuration: number;
      };
      const showEntry = spine.state.setAnimation.mock.results[1]?.value as {
        mixDuration: number;
      };
      expect(awardEntry.mixDuration).toBe(awardAnimation === "darkness" ? 0.8 : 0);
      expect(showEntry.mixDuration).toBe(0.8);
    }
  });

  it("darkens every panel for a Wheel feature slice and restores only once", async () => {
    const tower = await loadTower();

    tower.darkenAllPanels();

    for (const spine of loadedSpines) {
      expect(animationNames(spine)).toContain("darkness");
      expect(animationNames(spine)).not.toContain("win_shooting");
      expect(spine.state.setAnimation).toHaveBeenCalledWith(0, "darkness", false);
    }

    tower.resetPanelAnimations();
    tower.resetPanelAnimations();

    for (const spine of loadedSpines) {
      expect(animationNames(spine).filter((animation) => animation === "show")).toHaveLength(1);
    }
  });
});
