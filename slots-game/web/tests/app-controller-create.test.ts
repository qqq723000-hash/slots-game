import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface OverlayDouble {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setLaunchPhase: ReturnType<typeof vi.fn>;
  readonly mountLaunchLoading: ReturnType<typeof vi.fn>;
}

interface RendererDouble {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly app: {
    readonly renderer: {
      readonly screen: { readonly width: number; readonly height: number };
    };
  };
}

const startupDoubles = vi.hoisted(() => ({
  overlays: [] as OverlayDouble[],
  renderers: [] as RendererDouble[],
  stagedFactoryCalls: 0,
  stagedStages: [] as string[],
}));

vi.mock("../src/ui/DomOverlay", () => ({
  DomOverlay: class {
    readonly destroy = vi.fn();
    readonly setLaunchPhase = vi.fn();
    readonly mountLaunchLoading = vi.fn();

    constructor() {
      startupDoubles.overlays.push(this);
    }
  },
}));

vi.mock("../src/renderer/PixiRenderer", () => ({
  PixiRenderer: class {
    readonly destroy = vi.fn();
    readonly app = {
      renderer: {
        screen: { width: 960, height: 540 },
      },
    };

    constructor(_host: unknown) {
      startupDoubles.renderers.push(this);
    }

    static async createStaged(
      host: unknown,
      _options: unknown,
      construction: {
        requestFrame?: () => Promise<void>;
        onProgress?: (fraction: number) => void;
        onStage?: (event: {
          stage: string;
          frame: number;
          completed: number;
          total: number;
          componentCount: 1;
          durationMs: number;
        }) => void;
      } = {},
    ) {
      startupDoubles.stagedFactoryCalls += 1;
      construction.onProgress?.(0);
      await construction.requestFrame?.();
      construction.onStage?.({
        stage: "renderer-graph",
        frame: 1,
        completed: 1,
        total: 1,
        componentCount: 1,
        durationMs: 0,
      });
      startupDoubles.stagedStages.push("renderer-graph");
      const renderer = new this(host);
      construction.onProgress?.(1);
      return renderer;
    }
  },
}));

import { AppController } from "../src/app/AppController";

interface FakeRoot {
  readonly dataset: Record<string, string>;
  innerHTML: string;
  querySelector(selector: string): unknown;
}

function createRoot(): HTMLElement {
  const roles: Record<string, unknown> = {
    '[data-role="viewport"]': { clientWidth: 1_200, clientHeight: 900 },
    '[data-role="safe-area"]': { clientWidth: 1_200, clientHeight: 900 },
    '[data-role="frame"]': { dataset: {} },
    '[data-role="canvas"]': {},
    '[data-role="overlay"]': { appendChild: vi.fn() },
    '[data-role="launch-host"]': { appendChild: vi.fn() },
  };
  const root: FakeRoot = {
    dataset: {},
    innerHTML: "",
    querySelector: (selector) => roles[selector] ?? null,
  };
  return root as unknown as HTMLElement;
}

describe("AppController.create startup ownership", () => {
  beforeEach(() => {
    startupDoubles.overlays.length = 0;
    startupDoubles.renderers.length = 0;
    startupDoubles.stagedFactoryCalls = 0;
    startupDoubles.stagedStages.length = 0;
    vi.stubGlobal("window", {
      location: { search: "" },
      innerWidth: 1_200,
      innerHeight: 900,
      matchMedia: () => ({ matches: false }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { abortedStage: "overlay-mounted", rendererCount: 0, abortOnFactoryStage: false },
    { abortedStage: "renderer-mounted", rendererCount: 1, abortOnFactoryStage: true },
  ])(
    "destroys each built owner exactly once when $abortedStage paint is aborted",
    async ({ abortedStage, rendererCount, abortOnFactoryStage }) => {
      const root = createRoot();
      const abort = new AbortController();
      const reason = new Error(`abort after ${abortedStage} build`);
      const requestFrame = vi.fn(async () => {
        const reachedStage = root.dataset.startupAssemblyStage === abortedStage
          || (abortOnFactoryStage
            && root.dataset.startupAssemblyStage === "renderer-constructing"
            && startupDoubles.renderers.length === 1);
        if (reachedStage && !abort.signal.aborted) {
          abort.abort(reason);
        }
      });

      await expect(AppController.create(root, {}, {
        signal: abort.signal,
        requestFrame,
      })).rejects.toBe(reason);

      expect(startupDoubles.overlays).toHaveLength(1);
      expect(startupDoubles.overlays[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(startupDoubles.renderers).toHaveLength(rendererCount);
      expect(startupDoubles.stagedFactoryCalls).toBe(rendererCount);
      for (const renderer of startupDoubles.renderers) {
        expect(renderer.destroy).toHaveBeenCalledTimes(1);
      }
      expect(root.dataset.startupAssemblyStage).toBe("assembly-failed");
    },
  );
});
