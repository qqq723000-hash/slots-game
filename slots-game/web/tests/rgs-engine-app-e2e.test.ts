// @ts-nocheck -- 此跨运行时 E2E 会刻意控制 Go 测试进程和绑定 CA 的 Node HTTPS
// 客户端；浏览器 tsconfig 省略了 Node 类型。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AppController,
  type AppPresentationObserver,
  type RoundPresentationState,
} from "../src/app/AppController";
import type {
  FeatureEvent,
  SpinResult,
} from "../src/app/state/types";
import type { AudioBackend } from "../src/audio/AudioManager";
import { AudioManager } from "../src/audio/AudioManager";
import type { ReelRoundState } from "../src/reels/ReelRoundStateMachine";
import {
  RgsGateway,
  type RgsRecoveryLedger,
  type RgsRecoveryLedgerStorage,
} from "../src/protocol/RgsGateway";
import type { LaunchPhase } from "../src/startup/LaunchStateMachine";

const TEST_ORIGIN = "https://game.e2e";
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../server");
// 全新执行器会在这里完成 Go 夹具的冷编译；进程级超时必须先于 Vitest hook，
// 避免同步子进程失去控制，同时给受限 CI 留出有界余量。
const FIXTURE_BUILD_PROCESS_TIMEOUT_MS = 180_000;
const FIXTURE_BUILD_HOOK_TIMEOUT_MS = 190_000;
// 在共享 CI 工作进程上，编译后的 Go 夹具可能排在并发 `go test -race` 之后执行。
// 启动时间窗口要足以容纳这种资源竞争，但仍需保持有限；下方进程退出和生成错误
// 仍会立即失败，而不会耗尽全部允许时间。
const FIXTURE_BOOTSTRAP_TIMEOUT_MS = 15_000;

interface FixtureBootstrap {
  readonly baseUrl: string;
  readonly certificateDerBase64: string;
  readonly launchCode: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly gameId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly currency: string;
  readonly currencyExponent: number;
  readonly jurisdiction: string;
  readonly betMinor: string;
  readonly expectedRngCalls: number;
  readonly expectedRounds: number;
}

interface FixtureMetrics {
  readonly rngConsumed: number;
  readonly rngExpected: number;
  readonly engineSpins: number;
  readonly walletApplyCalls: number;
  readonly walletLookupCalls: number;
  readonly walletEconomicApplies: number;
  readonly walletBalanceMinor: number;
  readonly spinHttpCalls: number;
  readonly statusHttpCalls: number;
  readonly sessionRevision: number;
  readonly sessionSequence: number;
  readonly sessionBalanceMinor: number;
  readonly pendingRound: boolean;
  readonly featureMode: "" | "NONE" | "EXPANSION" | "OVERDRIVE";
  readonly featureRemaining: number;
  readonly featureAwarded: number;
}

interface TestFixture {
  readonly process: ChildProcess;
  readonly bootstrap: FixtureBootstrap;
}

interface TrustedFetch {
  readonly fetch: typeof fetch;
  readonly responseHeaders: Headers[];
  readonly droppedSpinResponses: () => number;
  close(): void;
}

class MemoryLedger implements RgsRecoveryLedgerStorage {
  value: unknown | null = null;
  readonly saved: RgsRecoveryLedger[] = [];
  clearCalls = 0;

  load(): unknown | null {
    return this.value;
  }

  save(ledger: Readonly<RgsRecoveryLedger>): void {
    const stored = Object.freeze({
      ...ledger,
      originFeatureState: Object.freeze({ ...ledger.originFeatureState }),
    });
    this.value = stored;
    this.saved.push(stored);
  }

  clear(): void {
    this.value = null;
    this.clearCalls += 1;
  }
}

interface BrowserHarness {
  readonly controller: AppController;
  readonly gateway: RgsGateway;
  readonly ledger: MemoryLedger;
  readonly applied: SpinResult[];
  readonly errors: string[];
  readonly featureEvents: FeatureEvent[];
  readonly roundStates: ReelRoundState[];
  readonly gamePhases: string[];
  readonly launchPhases: LaunchPhase[];
  readonly roundPresentationStates: RoundPresentationState[];
  readonly transport: TrustedFetch;
  readonly ui: ReturnType<typeof createUiBoundary>;
  readonly renderer: ReturnType<typeof createRendererBoundary>;
  readonly audioBackend: AudioBackend & { readonly destroy: ReturnType<typeof vi.fn> };
  readonly callbackWiring: ReturnType<typeof vi.spyOn>;
  readonly resizeRemovals: ReturnType<typeof vi.fn>;
}

let buildDirectory = "";
let fixtureBinary = "";
let activeFixture: TestFixture | null = null;
let activeGateway: RgsGateway | null = null;
let activeTransport: TrustedFetch | null = null;
let activeController: AppController | null = null;

beforeAll(() => {
  buildDirectory = mkdtempSync(join(tmpdir(), "primal-rgs-e2e-"));
  fixtureBinary = join(buildDirectory, "rgse2e.test");
  const built = spawnSync(
    "go",
    ["test", "-p=1", "-c", "-o", fixtureBinary, "./internal/rgse2e"],
    {
      cwd: SERVER_ROOT,
      encoding: "utf8",
      // Vitest 会并行执行文件。应避免跨运行时链接器在小型 CI 执行器上挤占资源，
      // 导致现有的短超时资源工具测试无法运行。
      env: { ...process.env, GOMAXPROCS: "1" },
      timeout: FIXTURE_BUILD_PROCESS_TIMEOUT_MS,
    },
  );
  if (built.error) {
    const reason = built.error.code === "ETIMEDOUT" ? "timed out" : "could not start";
    throw new Error(`could not build the loopback RGS fixture: ${reason}`);
  }
  if (built.signal) {
    throw new Error(`could not build the loopback RGS fixture: terminated by ${built.signal}`);
  }
  if (built.status !== 0) {
    throw new Error(`could not build the loopback RGS fixture:\n${built.stdout}${built.stderr}`);
  }
}, FIXTURE_BUILD_HOOK_TIMEOUT_MS);

afterEach(async () => {
  activeController?.destroy();
  activeController = null;
  activeGateway?.close();
  activeGateway = null;
  activeTransport?.close();
  activeTransport = null;
  if (activeFixture) await stopFixture(activeFixture);
  activeFixture = null;
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (buildDirectory) rmSync(buildDirectory, { recursive: true, force: true });
});

describe.sequential("signed engine -> durable RGS -> guarded AppController rare-feature E2E", () => {
  it("keeps fixture build and bootstrap allowances bounded for contended CI workers", () => {
    expect(FIXTURE_BUILD_PROCESS_TIMEOUT_MS).toBe(180_000);
    expect(FIXTURE_BUILD_HOOK_TIMEOUT_MS).toBe(190_000);
    expect(FIXTURE_BOOTSTRAP_TIMEOUT_MS).toBe(15_000);
  });

  it("reports an early fixture process failure without waiting for bootstrap", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(23), 25)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await expect(firstLine(child)).rejects.toThrow(
      "fixture exited before bootstrap (code 23, signal none)",
    );
  });

  it("settles the guaranteed three-Rage Wheel MINI through the complete chain", async () => {
    const runtime = await startScenario("wheel");
    const result = await startPaidRound(runtime.browser);

    expect(result.grid.flat().filter(({ symbol }) => symbol === "SURGE")).toHaveLength(3);
    expect(result.wins).toEqual([]);
    expect(result.totalWinMinor).toBe("1000");
    expect(result.balanceMinor).toBe("10900");
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "surge.collected",
      count: 3,
      triggered: true,
      guaranteed: true,
      total: 0,
    }));
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1000",
    }));
    expect(runtime.browser.featureEvents.map(({ type }) => type)).toEqual(expect.arrayContaining([
      "surge.collected", "wheel.started", "wheel.awarded",
    ]));
    expect(runtime.browser.ui.clearTransientSpinMessage).toHaveBeenCalledOnce();
    expect(runtime.browser.ui.clearTransientSpinMessage.mock.invocationCallOrder[0])
      .toBeLessThan(runtime.browser.renderer.playPostStopSurgeActivation.mock.invocationCallOrder[0]);

    assertCompletedPresentation(runtime.browser, 1);
    const metrics = await readMetrics(runtime);
    expect(metrics).toMatchObject({
      rngConsumed: 10,
      rngExpected: 10,
      engineSpins: 1,
      walletApplyCalls: 1,
      walletEconomicApplies: 1,
      walletBalanceMinor: 10_900,
      spinHttpCalls: 1,
      statusHttpCalls: 0,
      sessionRevision: 1,
      sessionSequence: 1,
      sessionBalanceMinor: 10_900,
      pendingRound: false,
      featureRemaining: 0,
      featureAwarded: 0,
    });
    await assertSecurityBoundary(runtime);
    assertNormalDestroy(runtime.browser);
  }, 30_000);

  it("runs Kong Quest 3x8/512, applies one Vault retrigger, and completes nine Free Spins", async () => {
    const runtime = await startScenario("kong");
    const base = await startPaidRound(runtime.browser);
    expect(base.events).toContainEqual(expect.objectContaining({
      type: "wheel.awarded",
      outcome: "EXPANSION",
    }));
    expect(base.featureState).toMatchObject({
      mode: "EXPANSION",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 0,
      baseBetMinor: "100",
    });

    const firstFreeSpin = await startPaidRound(runtime.browser, 10_000);
    expect(firstFreeSpin.chargedBetMinor).toBe("0");
    expect(firstFreeSpin.grid).toHaveLength(3);
    expect(firstFreeSpin.grid.every((reel) => reel.length === 8)).toBe(true);
    expect(firstFreeSpin.events[0]).toEqual(expect.objectContaining({
      type: "grid.expanded",
      rows: 8,
      ways: 512,
    }));
    expect(firstFreeSpin.grid[1]?.[0]).toEqual(expect.objectContaining({
      symbol: "VAULT",
      prize: "FREE_SPIN",
    }));
    expect(firstFreeSpin.events).toContainEqual(expect.objectContaining({
      type: "free_spin.awarded",
      count: 1,
      reel: 1,
      row: 0,
    }));
    expect(firstFreeSpin.featureState).toMatchObject({
      mode: "EXPANSION",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 1,
    });

    for (let round = 2; round < 10; round += 1) {
      await startPaidRound(runtime.browser, 10_000);
    }
    const terminal = runtime.browser.applied.at(-1)!;
    expect(terminal.sequence).toBe(10);
    expect(terminal.featureState).toMatchObject({ mode: "BASE", freeSpinsRemaining: 0 });
    expect(terminal.events).toContainEqual(expect.objectContaining({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 9,
    }));
    expect(runtime.browser.applied).toHaveLength(10);

    assertCompletedPresentation(runtime.browser, 10);
    const metrics = await readMetrics(runtime);
    expect(metrics).toMatchObject({
      rngConsumed: 116,
      rngExpected: 116,
      engineSpins: 10,
      walletApplyCalls: 10,
      walletEconomicApplies: 10,
      spinHttpCalls: 10,
      statusHttpCalls: 0,
      sessionRevision: 10,
      sessionSequence: 10,
      pendingRound: false,
      featureRemaining: 0,
      featureAwarded: 0,
    });
    assertNormalDestroy(runtime.browser);
  }, 30_000);

  it("recovers a dropped terminal King Spin response exactly once through round status", async () => {
    const runtime = await startScenario("king", { dropSpinResponseNumber: 9 });
    const base = await startPaidRound(runtime.browser);
    expect(base.events).toContainEqual(expect.objectContaining({
      type: "wheel.awarded",
      outcome: "OVERDRIVE",
    }));
    expect(base.featureState).toMatchObject({
      mode: "OVERDRIVE",
      freeSpinsRemaining: 8,
      freeSpinsPlayed: 0,
    });

    for (let round = 1; round < 9; round += 1) {
      await startPaidRound(runtime.browser, 10_000);
    }
    const terminal = runtime.browser.applied.at(-1)!;
    const middleVaults = terminal.grid[1] ?? [];
    expect(runtime.browser.transport.droppedSpinResponses()).toBe(1);
    expect(terminal.sequence).toBe(9);
    expect(terminal.totalWinMinor).toBe("3000");
    expect(terminal.balanceMinor).toBe("12900");
    expect(terminal.featureState.mode).toBe("BASE");
    expect(middleVaults).toHaveLength(3);
    expect(middleVaults.every((cell) => (
      cell.symbol === "VAULT" && cell.multiplier === 10 && cell.prize === "MINI"
    ))).toBe(true);
    expect(terminal.events.filter(({ type }) => type === "vaults.upgrade.started")).toHaveLength(2);
    expect(terminal.events.filter(({ type }) => type === "vault.upgraded")).toHaveLength(6);
    expect(terminal.events.filter(({ type }) => type === "vault.awarded")).toHaveLength(3);
    expect(terminal.events).toContainEqual(expect.objectContaining({
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor: "3000",
    }));
    expect(runtime.browser.applied.filter(({ sequence }) => sequence === 9)).toHaveLength(1);
    expect(runtime.browser.featureEvents.filter(({ type }) => type === "free_spins.completed")).toHaveLength(1);
    expect(runtime.browser.errors).toContain(
      "This request could not be completed. Please try again.",
    );
    expect(runtime.browser.ledger.saved.at(-1)?.roundId).toBe(terminal.roundId);

    assertCompletedPresentation(runtime.browser, 9);
    const metrics = await readMetrics(runtime);
    expect(metrics).toMatchObject({
      rngConsumed: 91,
      rngExpected: 91,
      engineSpins: 9,
      walletApplyCalls: 9,
      walletEconomicApplies: 9,
      walletBalanceMinor: 12_900,
      spinHttpCalls: 9,
      statusHttpCalls: 1,
      sessionRevision: 9,
      sessionSequence: 9,
      sessionBalanceMinor: 12_900,
      pendingRound: false,
      featureRemaining: 0,
      featureAwarded: 0,
    });
    assertNormalDestroy(runtime.browser);
  }, 30_000);

  it("redacts malformed bootstrap credentials from every validation error", () => {
    const launchCode = `lc_${"s".repeat(43)}`;
    const accessToken = "secret-access-token-value";
    const malformed = [
      `{"launchCode":"${launchCode}","accessToken":"${accessToken}"`,
      JSON.stringify({
        baseUrl: "https://127.0.0.1:1",
        certificateDerBase64: "Y2VydA==",
        launchCode,
        operatorId: "operator-e2e",
        sessionId: "session-e2e",
        gameId: "primal-rampage-e2e",
        definitionVersion: "e2e-wheel",
        definitionHash: "a".repeat(64),
        currency: "USD",
        currencyExponent: 2,
        jurisdiction: "GB",
        betMinor: "100",
        expectedRngCalls: 10,
        expectedRounds: 1,
        accessToken,
      }),
    ];
    for (const encoded of malformed) {
      let message = "";
      try {
        parseFixtureBootstrap(encoded);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/^fixture bootstrap (JSON decoding|public-field validation) failed$/);
      expect(message).not.toContain(encoded);
      expect(message).not.toContain(launchCode);
      expect(message).not.toContain(accessToken);
      expect(message).not.toContain("Y2VydA==");
    }
  });
});

async function startScenario(
  scenario: "wheel" | "kong" | "king",
  fetchOptions: { readonly dropSpinResponseNumber?: number } = {},
): Promise<{ fixture: TestFixture; browser: BrowserHarness }> {
  const fixture = await startFixture(scenario);
  activeFixture = fixture;
  const transport = createTrustedFetch(
    fixture.bootstrap.certificateDerBase64,
    TEST_ORIGIN,
    fetchOptions,
  );
  activeTransport = transport;
  const browser = createBrowserHarness(fixture.bootstrap, transport);
  activeController = browser.controller;
  activeGateway = browser.gateway;
  browser.controller.start();
  await waitFor(
    () => browser.launchPhases.at(-1) === "ready"
      && browser.gamePhases.at(-1) === "ready",
    `AppController launch and RGS session exchange (${scenario})`,
  );
  expect(browser.controller).toBeInstanceOf(AppController);
  expect(browser.callbackWiring).toHaveBeenCalledTimes(1);
  expect(browser.callbackWiring).toHaveBeenCalledWith(expect.objectContaining({
    onResultDeliveryStage: expect.any(Function),
  }));
  expect(browser.ui.setLaunchPhase).toHaveBeenCalledWith("boot", false);
  expect(browser.launchPhases).toEqual(expect.arrayContaining([
    "preloading", "intro", "ready",
  ]));
  return { fixture, browser };
}

function createBrowserHarness(
  bootstrap: FixtureBootstrap,
  transport: TrustedFetch,
): BrowserHarness {
  const ledger = new MemoryLedger();
  let requestSequence = 0;
  const gateway = new RgsGateway({
    baseUrl: bootstrap.baseUrl,
    launchCode: bootstrap.launchCode,
    operatorId: bootstrap.operatorId,
    sessionId: bootstrap.sessionId,
    betOptionsMinor: [bootstrap.betMinor],
    defaultBetMinor: bootstrap.betMinor,
    fetch: transport.fetch,
    ledgerStorage: ledger,
    requestId: () => `browser-request-${++requestSequence}`,
    pollDelayMs: 10,
    maxPollAttempts: 10,
    requestTimeoutMs: 5_000,
  });
  const roundStates: ReelRoundState[] = [];
  const applied: SpinResult[] = [];
  const errors: string[] = [];
  const featureEvents: FeatureEvent[] = [];
  const gamePhases: string[] = [];
  const launchPhases: LaunchPhase[] = [];
  const roundPresentationStates: RoundPresentationState[] = [];
  const observer: AppPresentationObserver = {
    onFeatureEvent: (_type, event) => {
      if (event) featureEvents.push(event as FeatureEvent);
    },
    onRoundPresentationState: (state) => roundPresentationStates.push(state),
    onLaunchPhase: (phase) => launchPhases.push(phase),
  };

  const ui = createUiBoundary(applied, errors, gamePhases);
  const renderer = createRendererBoundary(ui);
  const audioBoundary = createAudioBoundary();
  const dom = createDomBoundary(roundStates);
  const resizeRemovals = installBrowserGlobals();
  const callbackWiring = vi.spyOn(gateway, "setCallbacks");
  const controller = new AppController(
    dom.root,
    {
      gateway,
      presentationObserver: observer,
      audioManager: audioBoundary.manager,
      skipFeaturePreview: true,
    },
    {
      viewport: dom.viewport,
      frame: dom.frame,
      canvasHost: dom.canvasHost,
      overlayHost: dom.overlayHost,
      assetChannel: "desktop",
      ui,
      renderer,
      startupFrameRequest: async () => undefined,
    } as never,
  );

  return {
    controller,
    gateway,
    ledger,
    applied,
    errors,
    featureEvents,
    roundStates,
    gamePhases,
    launchPhases,
    roundPresentationStates,
    transport,
    ui,
    renderer,
    audioBackend: audioBoundary.backend,
    callbackWiring,
    resizeRemovals,
  };
}

function createUiBoundary(
  applied: SpinResult[],
  errors: string[],
  gamePhases: string[],
) {
  let spinHandler = (): void => undefined;
  let fastStopHandler = (): void => undefined;
  const target: Record<PropertyKey, unknown> = {
    pressSpin: (): void => spinHandler(),
    pressFastStop: (): void => fastStopHandler(),
    onSpin: vi.fn((handler: () => void) => { spinHandler = handler; }),
    onFastStop: vi.fn((handler: () => void) => { fastStopHandler = handler; }),
    onBet: vi.fn(),
    onSkip: vi.fn(),
    onPreviewContinue: vi.fn(),
    onSoundToggle: vi.fn(),
    onPanelOpen: vi.fn(),
    onPanelClose: vi.fn(),
    onFastPlayChange: vi.fn(),
    getFeaturePreviewCanvasHost: vi.fn(() => null),
    isFeaturePreviewDismissed: vi.fn(() => true),
    setPhase: vi.fn((phase: string) => gamePhases.push(phase)),
    applyResult: vi.fn((result: SpinResult) => applied.push(result)),
    showError: vi.fn((message: string) => errors.push(message)),
    announceEvent: vi.fn(async () => undefined),
    presentWinCounter: vi.fn(async () => undefined),
    destroy: vi.fn(),
  };
  return new Proxy(target, {
    get(object, property) {
      if (!(property in object)) object[property] = vi.fn();
      return object[property];
    },
  }) as Record<PropertyKey, unknown> & {
    pressSpin(): void;
    pressFastStop(): void;
    destroy: ReturnType<typeof vi.fn>;
    onSpin: ReturnType<typeof vi.fn>;
  };
}

function createRendererBoundary(ui: ReturnType<typeof createUiBoundary>) {
  const reels = {
    activeRows: 3,
    setRows: vi.fn((rows: number) => {
      reels.activeRows = rows;
      // 等待边界只会在真实 StopSequencer 持有回合后请求公开的快速停止操作。
      // 其严格钩子仍按生产顺序驱动真实 ReelRoundStateMachine。
      ui.pressFastStop();
    }),
    stopReel: vi.fn(async () => undefined),
    playPostStopActivation: vi.fn(),
    requestFastForward: vi.fn(),
    cancelPresentation: vi.fn(),
    setGrid: vi.fn((grid: SpinResult["grid"]) => {
      if (grid[0]) reels.activeRows = grid[0].length;
    }),
    prepareFeaturePresentation: vi.fn(),
    highlight: vi.fn(),
    clearHighlights: vi.fn(),
  };
  return {
    reels,
    launchScene: { applyFrame: vi.fn() },
    featureEffects: {
      presentBeforeReels: vi.fn(async () => undefined),
      presentVaultTease: vi.fn(async () => undefined),
      presentAfterReels: vi.fn(async () => undefined),
    },
    winCelebration: {
      present: vi.fn(async () => undefined),
      requestFinish: vi.fn(),
    },
    bigWin: { present: vi.fn(async () => undefined) },
    attachFeaturePreviewCanvasHost: vi.fn(),
    setCharacterAnimationListener: vi.fn(),
    setFeaturePresentationMilestoneListener: vi.fn(),
    setFeaturePresentationBranchListener: vi.fn(),
    setRageCollectionPresentationMilestoneListener: vi.fn(),
    setFeaturePresentationInputCheckpointListener: vi.fn(),
    setFeaturePresentationSemanticCheckpointListener: vi.fn(),
    setBigWinMilestoneListener: vi.fn(),
    setVisualTelemetryListener: vi.fn(),
    setWheelFastPlay: vi.fn(),
    setResponsiveLayout: vi.fn(),
    loadCriticalAssets: vi.fn(async ({ onProgress }) => onProgress?.(1)),
    warmCriticalAssets: vi.fn(async ({ onProgress }) => onProgress?.(1)),
    restoreFeatureState: vi.fn(),
    beginSpinPresentation: vi.fn(),
    finishSpinPresentation: vi.fn(),
    cancelSpinPresentation: vi.fn(),
    markFastStop: vi.fn(),
    reconcileReelRows: vi.fn(async (rows: number) => {
      reels.activeRows = rows;
    }),
    requestFreeSpinCapContinue: vi.fn(() => false),
    requestFreeSpinSummaryContinue: vi.fn(() => false),
    requestFreeSpinContinue: vi.fn(() => false),
    requestWheelSummaryContinue: vi.fn(() => false),
    requestWheelInteraction: vi.fn(() => undefined),
    requestBigWinInteraction: vi.fn(() => false),
    cueFeatureEnvironment: vi.fn(),
    setRageAuraLevel: vi.fn(),
    updateFreeSpinHud: vi.fn(),
    showFreeSpinHud: vi.fn(async () => undefined),
    hideFreeSpinHud: vi.fn(async () => undefined),
    presentFreeSpinAwardBatch: vi.fn(async () => undefined),
    presentFreeSpinCap: vi.fn(async () => undefined),
    highlightVaultMutationBatch: vi.fn(),
    completeWheelPresentation: vi.fn(),
    abortWheelPresentation: vi.fn(),
    beginFeatureExitAtSummaryHide: vi.fn(),
    exitFeatureMode: vi.fn(async () => undefined),
    reactToWin: vi.fn(async () => undefined),
    reelImpact: vi.fn(),
    startReelAnticipation: vi.fn(),
    stopReelAnticipation: vi.fn(),
    playPostStopSurgeActivation: vi.fn(),
    setJackpotBet: vi.fn(),
    setJackpotHudReveal: vi.fn(),
    seekAuthoredIntro: vi.fn(),
    cueIntro: vi.fn(),
    completeIntro: vi.fn(),
    setFeaturePreviewVisible: vi.fn(),
    hasAuthoredFeaturePreview: false,
    destroy: vi.fn(),
  };
}

function createAudioBoundary(): {
  readonly manager: AudioManager;
  readonly backend: AudioBackend & { readonly destroy: ReturnType<typeof vi.fn> };
} {
  const backend = {
    available: true,
    state: "running",
    prime: vi.fn(async () => undefined),
    primeForLaunch: vi.fn(async () => undefined),
    unlock: vi.fn(async () => true),
    retryDeferredLoads: vi.fn(),
    setMuted: vi.fn(),
    playOneShot: vi.fn(),
    stopOneShot: vi.fn(),
    startLoop: vi.fn(),
    setBaseMusicStemLevel: vi.fn(),
    quickStopReelMotor: vi.fn(),
    finishReelMotorNaturally: vi.fn(),
    stopLoop: vi.fn(),
    suspend: vi.fn(async () => undefined),
    destroy: vi.fn(),
  } as unknown as AudioBackend & { readonly destroy: ReturnType<typeof vi.fn> };
  return {
    manager: new AudioManager({
      backend,
      storage: null,
      visibilitySource: null,
      initialMuted: false,
    }),
    backend,
  };
}

function createDomBoundary(roundStates: ReelRoundState[]) {
  const style = (): Record<PropertyKey, unknown> => {
    const values: Record<string, string> = {};
    return new Proxy({
      setProperty: (name: string, value: string) => { values[name] = value; },
      removeProperty: (name: string) => { delete values[name]; },
    } as Record<PropertyKey, unknown>, {
      set(object, property, value) {
        object[property] = value;
        return true;
      },
    });
  };
  const frameDataset = new Proxy({} as Record<string, string>, {
    set(object, property, value) {
      object[String(property)] = String(value);
      if (property === "reelState") roundStates.push(value as ReelRoundState);
      return true;
    },
    deleteProperty(object, property) {
      delete object[String(property)];
      return true;
    },
  });
  const eventHandlers = new Map<string, Set<EventListener>>();
  const root = {
    dataset: {} as Record<string, string>,
    ownerDocument: null,
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn((type: string, handler: EventListener) => {
      const handlers = eventHandlers.get(type) ?? new Set<EventListener>();
      handlers.add(handler);
      eventHandlers.set(type, handlers);
    }),
    removeEventListener: vi.fn((type: string, handler: EventListener) => {
      eventHandlers.get(type)?.delete(handler);
    }),
  } as unknown as HTMLElement;
  const viewport = {
    clientWidth: 1_280,
    clientHeight: 720,
    dataset: {} as Record<string, string>,
    querySelector: vi.fn(() => null),
  } as unknown as HTMLElement;
  const frame = {
    dataset: frameDataset,
    style: style(),
    inert: false,
  } as unknown as HTMLElement;
  return {
    root,
    viewport,
    frame,
    canvasHost: {} as HTMLElement,
    overlayHost: {} as HTMLElement,
  };
}

function installBrowserGlobals(): ReturnType<typeof vi.fn> {
  const resizeRemovals = vi.fn();
  const matchMedia = vi.fn((query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const browserWindow = {
    location: { href: "https://game.e2e/", search: "" },
    history: { state: null, replaceState: vi.fn() },
    innerWidth: 1_280,
    innerHeight: 720,
    matchMedia,
    addEventListener: vi.fn(),
    removeEventListener: resizeRemovals,
  };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("location", browserWindow.location);
  vi.stubGlobal("matchMedia", matchMedia);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
    setTimeout(() => callback(performance.now() + 10_000), 0)
  ));
  vi.stubGlobal("cancelAnimationFrame", (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle));
  return resizeRemovals;
}

async function startPaidRound(browser: BrowserHarness, timeoutMs = 5_000): Promise<SpinResult> {
  const previousCount = browser.applied.length;
  browser.ui.pressSpin();
  await waitFor(() => (
    browser.applied.length === previousCount + 1
    && browser.gamePhases.at(-1) === "ready"
    && browser.roundStates.at(-1) === "Idle"
    && !browser.gateway.hasPendingSpin
  ), `round ${previousCount + 1} presentation`, timeoutMs);
  const result = browser.applied[previousCount];
  if (!result) throw new Error(`round ${previousCount + 1} did not reach the UI balance barrier`);
  assertLastReelCycle(browser.roundStates);
  return result;
}

function assertLastReelCycle(states: readonly ReelRoundState[]): void {
  const compressed = states.filter((state, index) => state !== states[index - 1]);
  expect(compressed.slice(-8)).toEqual([
    "Idle",
    "Spin_Start",
    "Spinning",
    "Spin_Stopping",
    "Reel_Stop_One_By_One",
    "Result_Show",
    "Win_Line_Animation",
    "Idle",
  ]);
}

function assertCompletedPresentation(browser: BrowserHarness, expectedRounds: number): void {
  expect(browser.applied).toHaveLength(expectedRounds);
  expect(browser.gamePhases.at(-1)).toBe("ready");
  expect(browser.roundStates.at(-1)).toBe("Idle");
  expect(browser.roundStates.filter((state) => state === "Spin_Start")).toHaveLength(expectedRounds);
  expect(browser.roundPresentationStates.filter((state) => state === "complete")).toHaveLength(expectedRounds);
  expect(browser.gateway.hasPendingSpin).toBe(false);
  expect(browser.ledger.value).toBeNull();
  expect(browser.ledger.saved).toHaveLength(expectedRounds);
  for (const record of browser.ledger.saved) {
    expect(Object.keys(record).sort()).toEqual([
      "betMinor",
      "bindingFingerprint",
      "originFeatureState",
      "roundId",
      "startRevision",
      "version",
    ]);
    expect(record.version).toBe(2);
    expect(Object.keys(record.originFeatureState).sort()).toEqual(
      record.originFeatureState.mode === "BASE"
        ? [
            "freeSpinsPlayed",
            "freeSpinsRemaining",
            "mode",
            "rageCollected",
            "rageLevel",
          ]
        : [
            "baseBetMinor",
            "freeSpinsPlayed",
            "freeSpinsRemaining",
            "freeSpinsWinMinor",
            "mode",
            "rageCollected",
            "rageLevel",
          ],
    );
    expect(JSON.stringify(record)).not.toMatch(/token|launch|wallet|player|outcome|result/i);
  }
}

function assertNormalDestroy(browser: BrowserHarness): void {
  browser.controller.destroy();
  activeController = null;
  activeGateway = null;
  expect(browser.callbackWiring).toHaveBeenCalledTimes(1);
  expect(browser.ui.onSpin).toHaveBeenCalledTimes(1);
  expect(browser.ui.destroy).toHaveBeenCalledTimes(1);
  expect(browser.renderer.destroy).toHaveBeenCalledTimes(1);
  expect(browser.audioBackend.destroy).toHaveBeenCalledTimes(1);
  expect(browser.resizeRemovals).toHaveBeenCalledWith("resize", expect.any(Function));
  expect(browser.gateway.hasPendingSpin).toBe(false);
  expect(browser.roundStates.at(-1)).toBe("Idle");
}

async function assertSecurityBoundary(runtime: {
  fixture: TestFixture;
  browser: BrowserHarness;
}): Promise<void> {
  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe("0");
  expect(JSON.stringify(runtime.fixture.bootstrap)).not.toMatch(/accessToken|walletAccount|walletSession|playerId/i);
  expect(runtime.browser.transport.responseHeaders.length).toBeGreaterThan(0);
  for (const headers of runtime.browser.transport.responseHeaders) {
    expect(headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  }

  const foreign = createTrustedFetch(
    runtime.fixture.bootstrap.certificateDerBase64,
    "https://foreign-origin.e2e",
    { requireAllowedCors: false },
  );
  try {
    const response = await foreign.fetch(`${runtime.fixture.bootstrap.baseUrl}/__e2e/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  } finally {
    foreign.close();
  }
}

async function readMetrics(runtime: {
  fixture: TestFixture;
  browser: BrowserHarness;
}): Promise<FixtureMetrics> {
  const response = await runtime.browser.transport.fetch(
    `${runtime.fixture.bootstrap.baseUrl}/__e2e/metrics`,
  );
  expect(response.status).toBe(200);
  return await response.json() as FixtureMetrics;
}

async function startFixture(scenario: string): Promise<TestFixture> {
  const child = spawn(fixtureBinary, [], {
    cwd: SERVER_ROOT,
    env: { ...process.env, RGS_E2E_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!child.stdout || !child.stderr) throw new Error("fixture process did not expose output pipes");
  child.stderr.setEncoding("utf8");
  child.stderr.resume();
  const line = await firstLine(child);
  let bootstrap: FixtureBootstrap;
  try {
    bootstrap = parseFixtureBootstrap(line);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  return { process: child, bootstrap };
}

function parseFixtureBootstrap(encoded: string): FixtureBootstrap {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error("fixture bootstrap JSON decoding failed");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("fixture bootstrap public-field validation failed");
  }
  const value = decoded as Record<string, unknown>;
  const expectedKeys = [
    "baseUrl", "certificateDerBase64", "launchCode", "operatorId", "sessionId",
    "gameId", "definitionVersion", "definitionHash", "currency",
    "currencyExponent", "jurisdiction", "betMinor", "expectedRngCalls",
    "expectedRounds",
  ];
  const valid = Object.keys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key))
    && typeof value.baseUrl === "string"
    && value.baseUrl.startsWith("https://127.0.0.1:")
    && typeof value.certificateDerBase64 === "string"
    && value.certificateDerBase64.length > 0
    && typeof value.launchCode === "string"
    && /^lc_[A-Za-z0-9_-]{43}$/.test(value.launchCode)
    && typeof value.operatorId === "string"
    && typeof value.sessionId === "string"
    && typeof value.gameId === "string"
    && typeof value.definitionVersion === "string"
    && typeof value.definitionHash === "string"
    && /^[a-f0-9]{64}$/.test(value.definitionHash)
    && value.currency === "USD"
    && value.currencyExponent === 2
    && value.jurisdiction === "GB"
    && value.betMinor === "100"
    && Number.isSafeInteger(value.expectedRngCalls)
    && Number.isSafeInteger(value.expectedRounds);
  if (!valid) throw new Error("fixture bootstrap public-field validation failed");
  return value as unknown as FixtureBootstrap;
}

async function firstLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("fixture stdout is unavailable");
  stdout.setEncoding("utf8");
  return await new Promise<string>((resolveLine, rejectLine) => {
    let buffered = "";
    const startupTimeout = setTimeout(() => {
      cleanup();
      child.kill("SIGTERM");
      rejectLine(new Error(`fixture bootstrap timed out after ${FIXTURE_BOOTSTRAP_TIMEOUT_MS}ms`));
    }, FIXTURE_BOOTSTRAP_TIMEOUT_MS);
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolveLine(buffered.slice(0, newline));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectLine(new Error(
        `fixture exited before bootstrap (code ${code ?? "none"}, signal ${signal ?? "none"})`,
      ));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectLine(new Error(`fixture failed to start before bootstrap: ${error.message}`));
    };
    const cleanup = (): void => {
      clearTimeout(startupTimeout);
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
    }
  });
}

async function stopFixture(fixture: TestFixture): Promise<void> {
  const child = fixture.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const completed = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
  ]);
  if (!completed && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function createTrustedFetch(
  certificateDerBase64: string,
  origin: string,
  options: {
    readonly dropSpinResponseNumber?: number;
    readonly requireAllowedCors?: boolean;
  } = {},
): TrustedFetch {
  const certificateLines = certificateDerBase64.match(/.{1,64}/g);
  if (!certificateLines) throw new Error("fixture certificate is empty");
  const certificate = `-----BEGIN CERTIFICATE-----\n${certificateLines.join("\n")}\n-----END CERTIFICATE-----\n`;
  const agent = new Agent({ ca: certificate, rejectUnauthorized: true });
  const responseHeaders: Headers[] = [];
  let spinResponses = 0;
  let droppedSpinResponses = 0;

  const trustedFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set("Origin", origin);
    const body = typeof init.body === "string" ? init.body : undefined;
    const response = await new Promise<Response>((resolveResponse, rejectResponse) => {
      const request = httpsRequest(url, {
        method: init.method ?? "GET",
        headers: Object.fromEntries(requestHeaders.entries()),
        agent,
      }, (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        incoming.on("error", rejectResponse);
        incoming.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value !== undefined) headers.set(name, value);
          }
          responseHeaders.push(headers);
          if ((options.requireAllowedCors ?? true)
            && headers.get("access-control-allow-origin") !== origin) {
            rejectResponse(new TypeError("loopback RGS response failed the browser CORS boundary"));
            return;
          }
          if (url.pathname === "/client/v1/spins") {
            spinResponses += 1;
            if (spinResponses === options.dropSpinResponseNumber) {
          // 完整消费真实的已提交响应，再模拟网络边界与浏览器解码器之间的丢失。
              droppedSpinResponses += 1;
              rejectResponse(new TypeError("simulated post-commit response loss"));
              return;
            }
          }
          const payload = Buffer.concat(chunks);
          resolveResponse(new Response(payload, {
            status: incoming.statusCode ?? 500,
            statusText: incoming.statusMessage,
            headers,
          }));
        });
      });
      request.on("error", rejectResponse);
      const abort = (): void => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        request.destroy(error);
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      request.on("close", () => init.signal?.removeEventListener("abort", abort));
      if (body !== undefined) request.write(body);
      request.end();
    });
    return response;
  };

  return {
    fetch: trustedFetch,
    responseHeaders,
    droppedSpinResponses: () => droppedSpinResponses,
    close: () => agent.destroy(),
  };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}
