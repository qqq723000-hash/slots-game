import { describe, expect, it, vi } from "vitest";
import type { AssetPackageManifest } from "../src/startup/StreamingAssetPackages";
import {
  StreamingAssetRuntime,
  assetStreamingMode,
  beginStreamingAssetEventLease,
  publishStreamingAssetDiagnostics,
  streamingPackageManifestUrl,
} from "../src/startup/StreamingAssetRuntime";

const SHA = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
const ZERO_SHA = "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9";

function manifest(channel: "desktop" | "mobile"): AssetPackageManifest {
  return {
    schemaVersion: 1,
    assetSet: `primal-rampage-runtime:${channel}`,
    packages: [
      {
        id: `${channel}-shared`,
        version: "1",
        stage: "base-critical",
        resources: [
          {
            id: `${channel}:shared`,
            url: `/assets/${channel}-shared.bin`,
            bytes: 1,
            sha256: SHA,
            decoder: "binary",
          },
        ],
      },
      {
        id: `${channel}-feature-wheel`,
        version: "1",
        stage: "feature-on-demand",
        dependsOn: [`${channel}-shared`],
        resources: [
          {
            id: `${channel}:wheel`,
            url: `/assets/${channel}-wheel.bin`,
            bytes: 1,
            sha256: SHA,
            decoder: "binary",
          },
        ],
      },
      {
        id: `${channel}-feature-free-spins`,
        version: "1",
        stage: "feature-on-demand",
        dependsOn: [`${channel}-shared`],
        resources: [
          {
            id: `${channel}:free-spins`,
            url: `/assets/${channel}-free-spins.bin`,
            bytes: 1,
            sha256: SHA,
            decoder: "binary",
          },
        ],
      },
    ],
  };
}

function manifestResponse(channel: "desktop" | "mobile"): Response {
  return new Response(JSON.stringify(manifest(channel)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bigWinManifest(channel: "desktop" | "mobile"): AssetPackageManifest {
  const resource = (id: string, url: string, decoder: "binary" | "text" | "json") => ({
    id: `${channel}:${id}`,
    url,
    bytes: 1,
    sha256: ZERO_SHA,
    decoder,
  });
  return {
    schemaVersion: 1,
    assetSet: `primal-rampage-runtime:${channel}`,
    packages: [
      {
        id: `${channel}-spine-ui-shared`,
        version: "1",
        stage: "base-critical",
        resources: [resource("ui-atlas", `/assets/${channel}-ui-atlas.bin`, "binary")],
      },
      {
        id: `${channel}-feature-big-win`,
        version: "1",
        stage: "feature-on-demand",
        dependsOn: [`${channel}-spine-ui-shared`],
        resources: [
          resource("big-win-skel", "/assets/BigWin.skel", "binary"),
          resource("big-win-font", "/assets/PrimalRampage.fnt", "text"),
          resource("big-win-page", "/assets/PrimalRampage.png", "binary"),
          resource("big-win-coins", "/assets/big-win-coins.json", "json"),
        ],
      },
    ],
  };
}

function binaryResponse(): Response {
  return new Response(new TextEncoder().encode("a"), {
    status: 200,
    headers: { "content-length": "1" },
  });
}

function zeroResponse(): Response {
  return new Response(new TextEncoder().encode("0"), {
    status: 200,
    headers: { "content-length": "1" },
  });
}

describe("StreamingAssetRuntime Phase-B shadow bridge", () => {
  it("cancels a chunked manifest as soon as accumulated bytes cross the hard limit", async () => {
    const cancelled = vi.fn();
    const fullChunk = new Uint8Array(2 * 1024 * 1024);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fullChunk);
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.close();
      },
      cancel(reason) {
        cancelled(reason);
      },
    }), {
      status: 200,
      headers: { "content-length": "1" },
    });
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: vi.fn(async () => response),
    });

    await expect(runtime.validateManifest()).rejects.toThrow(/2 MiB|2097152/i);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(runtime.diagnostics().manifestState).toBe("failed");
    runtime.destroy();
  });

  it("defaults to on-demand, fails unknown modes closed, and maps the boot-frozen manifest", () => {
    expect(assetStreamingMode(undefined)).toBe("on-demand");
    expect(assetStreamingMode("")).toBe("on-demand");
    expect(assetStreamingMode("on-demand")).toBe("on-demand");
    expect(assetStreamingMode("future-mode")).toBe("off");
    expect(assetStreamingMode("shadow")).toBe("shadow");
    expect(streamingPackageManifestUrl("desktop")).toContain(
      "streaming-packages.desktop.json",
    );
    expect(streamingPackageManifestUrl("mobile")).toContain(
      "streaming-packages.mobile.json",
    );
  });

  it("acquires a verified event package in on-demand mode without scheduling the shadow stage", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes("streaming-packages")
        ? manifestResponse("desktop")
        : binaryResponse()
    ));
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "on-demand",
      fetch: fetcher,
    });

    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(false);
    const eventLease = beginStreamingAssetEventLease(
      runtime,
      "desktop-feature-wheel",
    );
    const packageLease = await eventLease.ready;

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(packageLease.packageIds).toEqual([
      "desktop-shared",
      "desktop-feature-wheel",
    ]);
    expect(runtime.diagnostics()).toMatchObject({
      mode: "on-demand",
      manifestState: "validated",
      retainedPayloadBytes: 2,
    });
    expect(eventLease.release()).toBe(true);
    expect(eventLease.release()).toBe(false);
    expect(packageLease.released).toBe(true);
    expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
    runtime.destroy();
  });

  it("performs zero Big Win requests before the event and fetches every closure resource once", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => (
      String(input).includes("streaming-packages")
        ? new Response(JSON.stringify(bigWinManifest("desktop")), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : zeroResponse()
    ));
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "on-demand",
      fetch: fetcher,
    });

    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(false);
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();

    const eventLease = beginStreamingAssetEventLease(runtime, "desktop-feature-big-win");
    await eventLease.ready;
    const urls = fetcher.mock.calls.map(([input]) => String(input));
    expect(urls).toHaveLength(6);
    expect(new Set(urls).size).toBe(6);
    for (const url of urls) {
      expect(urls.filter((candidate) => candidate === url)).toHaveLength(1);
    }
    expect(urls.filter((url) => /BigWin|PrimalRampage|big-win-coins/u.test(url)))
      .toHaveLength(4);

    eventLease.release();
    runtime.destroy();
  });

  it("releases a late package when an event ends before a non-cooperative source resolves", async () => {
    let resolveAcquire!: (lease: import("../src/startup/StreamingAssetPackages").AcquiredAssetPackage) => void;
    const release = vi.fn(() => true);
    const acquirePackage = vi.fn(() => new Promise<
      import("../src/startup/StreamingAssetPackages").AcquiredAssetPackage
    >((resolve) => {
      resolveAcquire = resolve;
    }));
    const eventLease = beginStreamingAssetEventLease(
      { acquirePackage },
      "desktop-feature-big-win",
    );
    await Promise.resolve();

    expect(acquirePackage).toHaveBeenCalledWith(
      "desktop-feature-big-win",
      eventLease.signal,
    );
    expect(eventLease.release()).toBe(true);
    expect(eventLease.signal.aborted).toBe(true);
    resolveAcquire({
      id: "desktop-feature-big-win",
      packageIds: ["desktop-feature-big-win"],
      package: {} as never,
      released: false,
      release,
    });

    await expect(eventLease.ready).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("publishes bounded non-authoritative diagnostics without resource payloads", () => {
    const dataset: DOMStringMap = {};
    publishStreamingAssetDiagnostics({ dataset } as HTMLElement, {
      mode: "shadow",
      channel: "desktop",
      manifestUrl: "/assets/streaming-packages.desktop.json",
      manifestState: "failed",
      backgroundScheduled: true,
      backgroundRunning: false,
      featureStageVerified: false,
      retainedPayloadBytes: 0,
      peakOperationPayloadBytes: 3,
      lastError: "x".repeat(300),
      packages: [],
    });

    expect(dataset.assetStreamingMode).toBe("shadow");
    expect(dataset.assetStreamingFeatureStageVerified).toBe("false");
    expect(dataset.assetStreamingRetainedPayloadBytes).toBe("0");
    expect(dataset.assetStreamingLastError).toHaveLength(256);
    expect(Object.keys(dataset)).not.toContain("assetStreamingPackages");
  });

  it.each(["desktop", "mobile"] as const)(
    "loads and validates only the %s manifest selected at boot",
    async (channel) => {
      const fetcher = vi.fn(async () => manifestResponse(channel));
      const runtime = new StreamingAssetRuntime({
        channel,
        mode: "shadow",
        fetch: fetcher,
      });

      await expect(runtime.validateManifest()).resolves.toMatchObject({
        assetSet: `primal-rampage-runtime:${channel}`,
      });
      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining(`streaming-packages.${channel}.json`),
        expect.objectContaining({
          cache: "no-cache",
          credentials: "same-origin",
        }),
      );
      expect(runtime.diagnostics()).toMatchObject({
        channel,
        manifestState: "validated",
        featureStageVerified: false,
        retainedPayloadBytes: 0,
      });
      runtime.destroy();
    },
  );

  it("isolates shared manifest callers so either caller aborts immediately without cancelling fetch", async () => {
    let releaseManifest!: () => void;
    let fetchSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? null;
      await new Promise<void>((resolve) => { releaseManifest = resolve; });
      return manifestResponse("desktop");
    });
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const survivorAbort = new AbortController();
    const first = runtime.validateManifest(firstAbort.signal);
    const second = runtime.validateManifest(secondAbort.signal);
    const survivor = runtime.validateManifest(survivorAbort.signal);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    firstAbort.abort(new Error("first manifest caller left"));
    secondAbort.abort(new Error("second manifest caller left"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(false);
    expect(runtime.diagnostics().manifestState).toBe("loading");

    releaseManifest();
    await expect(survivor).resolves.toMatchObject({
      assetSet: "primal-rampage-runtime:desktop",
    });
    expect(runtime.diagnostics().manifestState).toBe("validated");
    runtime.destroy();
  });

  it("rejects a valid manifest for the other channel before any package fetch", async () => {
    const fetcher = vi.fn(async () => manifestResponse("mobile"));
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
    });

    await expect(runtime.validateManifest()).rejects.toThrow(
      /channel mismatch/i,
    );
    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "failed",
      featureStageVerified: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });

  it("fails before package fetch when a future dependency closure exceeds the heap guard", async () => {
    const fetcher = vi.fn(async () => manifestResponse("desktop"));
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
      maxOperationPayloadBytes: 2,
    });

    await expect(runtime.preloadStage("feature-on-demand")).rejects.toThrow(
      /limit is 2/i,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.diagnostics()).toMatchObject({
      featureStageVerified: false,
      retainedPayloadBytes: 0,
      peakOperationPayloadBytes: 0,
    });
    runtime.destroy();
  });

  it("keeps feature diagnostics below ready until every serial package verifies", async () => {
    let releaseLast!: () => void;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("streaming-packages"))
        return manifestResponse("desktop");
      if (url.endsWith("desktop-free-spins.bin")) {
        await new Promise<void>((resolve) => {
          releaseLast = resolve;
        });
      }
      return binaryResponse();
    });
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
    });

    const loading = runtime.preloadStage("feature-on-demand");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    const pending = runtime.diagnostics();
    expect(pending.featureStageVerified).toBe(false);
    expect(
      pending.packages
        .filter((entry) => entry.state !== "verified")
        .every((entry) => entry.progress < 1),
    ).toBe(true);

    releaseLast();
    await loading;
    expect(runtime.diagnostics()).toMatchObject({
      featureStageVerified: true,
      retainedPayloadBytes: 0,
      peakOperationPayloadBytes: 3,
    });
    runtime.destroy();
  });

  it("aborts an in-flight package, never reports false ready, and permits retry", async () => {
    let block = true;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("streaming-packages"))
          return manifestResponse("desktop");
        if (block && String(input).endsWith("desktop-wheel.bin")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        }
        return binaryResponse();
      },
    );
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
      managerOptions: { maxAttempts: 1 },
    });
    const controller = new AbortController();
    const loading = runtime.preloadPackage(
      "desktop-feature-wheel",
      controller.signal,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    controller.abort(new Error("leave page"));

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.diagnostics()).toMatchObject({
      featureStageVerified: false,
    });
    expect(
      runtime
        .diagnostics()
        .packages.find((entry) => entry.id === "desktop-feature-wheel"),
    ).toMatchObject({ state: "cancelled", progress: expect.any(Number) });

    block = false;
    await expect(
      runtime.preloadPackage("desktop-feature-wheel"),
    ).resolves.toHaveLength(1);
    expect(
      runtime
        .diagnostics()
        .packages.find((entry) => entry.id === "desktop-feature-wheel"),
    ).toMatchObject({ state: "verified", progress: 1 });
    runtime.destroy();
  });

  it("fails open in scheduled shadow mode without throwing into game launch", async () => {
    let idleCallback: (() => void) | null = null;
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: vi.fn(async () => new Response("offline", { status: 503 })),
      scheduleIdle: (callback) => {
        idleCallback = callback;
        return 7;
      },
      cancelIdle: vi.fn(),
      managerOptions: { maxAttempts: 1 },
    });

    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(true);
    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(false);
    expect(() => idleCallback?.()).not.toThrow();
    await vi.waitFor(() =>
      expect(runtime.diagnostics().backgroundRunning).toBe(false),
    );
    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "failed",
      featureStageVerified: false,
      backgroundScheduled: true,
    });
    runtime.destroy();
  });

  it("destroy cancels scheduled idle work and suppresses all late diagnostics", async () => {
    let idleCallback: (() => void) | null = null;
    const cancelIdle = vi.fn();
    const onDiagnostics = vi.fn();
    const fetcher = vi.fn(async () => manifestResponse("desktop"));
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
      scheduleIdle: (callback) => {
        idleCallback = callback;
        return 11;
      },
      cancelIdle,
      onDiagnostics,
    });

    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(true);
    const callsBeforeDestroy = onDiagnostics.mock.calls.length;
    runtime.destroy();
    expect(cancelIdle).toHaveBeenCalledWith(11);
    const lateIdleCallback = idleCallback as (() => void) | null;
    lateIdleCallback?.();
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    expect(onDiagnostics).toHaveBeenCalledTimes(callsBeforeDestroy);
    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "destroyed",
      backgroundScheduled: false,
      backgroundRunning: false,
    });
  });

  it("destroy synchronously settles active background diagnostics", async () => {
    let idleCallback: (() => void) | null = null;
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("streaming-packages"))
          return manifestResponse("desktop");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
      scheduleIdle: (callback) => {
        idleCallback = callback;
        return 17;
      },
      managerOptions: { maxAttempts: 1 },
    });

    expect(runtime.scheduleFeatureShadowPrefetch()).toBe(true);
    const runIdle = idleCallback as (() => void) | null;
    runIdle?.();
    await vi.waitFor(() => expect(runtime.diagnostics().backgroundRunning).toBe(true));
    runtime.destroy();

    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "destroyed",
      backgroundScheduled: false,
      backgroundRunning: false,
      featureStageVerified: false,
    });
    await expect(runtime.whenBackgroundSettled()).resolves.toBeUndefined();
  });

  it("treats throwing diagnostics observers as fail-open shadow telemetry", async () => {
    let idleCallback: (() => void) | null = null;
    const observer = vi.fn(() => {
      throw new Error("diagnostics sink unavailable");
    });
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: vi.fn(async (input: RequestInfo | URL) => (
        String(input).includes("streaming-packages")
          ? manifestResponse("desktop")
          : binaryResponse()
      )),
      scheduleIdle: (callback) => {
        idleCallback = callback;
        return 19;
      },
      onDiagnostics: observer,
    });

    expect(() => runtime.scheduleFeatureShadowPrefetch()).not.toThrow();
    expect(() => idleCallback?.()).not.toThrow();
    await expect(runtime.whenBackgroundSettled()).resolves.toBeUndefined();
    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "validated",
      backgroundRunning: false,
      featureStageVerified: true,
    });
    expect(observer).toHaveBeenCalled();
    runtime.destroy();
  });

  it("destroy aborts active fetches and prevents late verified/ready callbacks", async () => {
    const onDiagnostics = vi.fn();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("streaming-packages"))
          return manifestResponse("desktop");
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    );
    const runtime = new StreamingAssetRuntime({
      channel: "desktop",
      mode: "shadow",
      fetch: fetcher,
      onDiagnostics,
      managerOptions: { maxAttempts: 1 },
    });
    const loading = runtime.preloadPackage("desktop-feature-wheel");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const callsBeforeDestroy = onDiagnostics.mock.calls.length;
    runtime.destroy();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(onDiagnostics).toHaveBeenCalledTimes(callsBeforeDestroy);
    expect(runtime.diagnostics()).toMatchObject({
      manifestState: "destroyed",
      featureStageVerified: false,
      packages: [],
    });
  });

  describe("experimental consumer lease lifetime", () => {
    it("synchronously releases active package leases on destroy", async () => {
      const runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: vi.fn(async (input: RequestInfo | URL) => (
          String(input).includes("streaming-packages")
            ? manifestResponse("desktop")
            : binaryResponse()
        )),
      });
      const lease = await runtime.acquirePackage("desktop-feature-wheel");

      expect(lease.released).toBe(false);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(2);
      runtime.destroy();

      expect(lease.released).toBe(true);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
      expect(() => lease.package).toThrow(/released/i);
      expect(lease.release()).toBe(false);
      expect(lease.release()).toBe(false);
    });

    it("synchronously releases active stage leases on destroy", async () => {
      const runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: vi.fn(async (input: RequestInfo | URL) => (
          String(input).includes("streaming-packages")
            ? manifestResponse("desktop")
            : binaryResponse()
        )),
      });
      const lease = await runtime.acquireStage("feature-on-demand");

      expect(lease.released).toBe(false);
      expect(lease.packages).toHaveLength(3);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(3);
      runtime.destroy();

      expect(lease.released).toBe(true);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
      expect(() => lease.packages).toThrow(/released/i);
      expect(lease.release()).toBe(false);
    });

    it("rolls back an acquire that is destroyed while the manager completes", async () => {
      let runtime!: StreamingAssetRuntime;
      let destroyOnReady = false;
      runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: vi.fn(async (input: RequestInfo | URL) => (
          String(input).includes("streaming-packages")
            ? manifestResponse("desktop")
            : binaryResponse()
        )),
        onDiagnostics: (diagnostics) => {
          if (
            destroyOnReady &&
            diagnostics.packages.some((entry) => entry.state === "verified")
          ) {
            runtime.destroy();
          }
        },
      });
      destroyOnReady = true;

      await expect(
        runtime.acquirePackage("desktop-feature-wheel"),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(runtime.diagnostics()).toMatchObject({
        manifestState: "destroyed",
        retainedPayloadBytes: 0,
      });
    });

    it("isolates an aborted package caller from a surviving shared acquire", async () => {
      let releaseWheel!: () => void;
      let wheelSignal: AbortSignal | null = null;
      const fetcher = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("streaming-packages")) {
            return manifestResponse("desktop");
          }
          if (url.endsWith("desktop-wheel.bin")) {
            wheelSignal = init?.signal ?? null;
            await new Promise<void>((resolve) => {
              releaseWheel = resolve;
            });
          }
          return binaryResponse();
        },
      );
      const runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: fetcher,
      });
      const abandoned = new AbortController();
      const survivor = new AbortController();
      const first = runtime.acquirePackage(
        "desktop-feature-wheel",
        abandoned.signal,
      );
      const second = runtime.acquirePackage(
        "desktop-feature-wheel",
        survivor.signal,
      );
      await vi.waitFor(() => expect(releaseWheel).toBeTypeOf("function"));

      abandoned.abort(new Error("first consumer left"));
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      expect((wheelSignal as AbortSignal | null)?.aborted).toBe(false);

      releaseWheel();
      const lease = await second;
      expect(lease.released).toBe(false);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(2);
      expect(lease.release()).toBe(true);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
      runtime.destroy();
    });

    it("aborts in-flight consumer fetches at the runtime lifetime boundary", async () => {
      let resourceSignal: AbortSignal | null = null;
      const fetcher = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("streaming-packages")) {
            return manifestResponse("desktop");
          }
          resourceSignal = init?.signal ?? null;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      );
      const runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: fetcher,
        managerOptions: { maxAttempts: 1 },
      });
      const acquiring = runtime.acquirePackage("desktop-feature-wheel");
      await vi.waitFor(() => expect(resourceSignal).not.toBeNull());

      runtime.destroy();

      await expect(acquiring).rejects.toMatchObject({ name: "AbortError" });
      expect((resourceSignal as AbortSignal | null)?.aborted).toBe(true);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
    });

    it("unregisters a manually released lease exactly once without underflow", async () => {
      const runtime = new StreamingAssetRuntime({
        channel: "desktop",
        mode: "shadow",
        fetch: vi.fn(async (input: RequestInfo | URL) => (
          String(input).includes("streaming-packages")
            ? manifestResponse("desktop")
            : binaryResponse()
        )),
      });
      const lease = await runtime.acquirePackage("desktop-feature-wheel");

      expect(lease.release()).toBe(true);
      expect(lease.released).toBe(true);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
      expect(lease.release()).toBe(false);
      expect(() => runtime.destroy()).not.toThrow();
      expect(lease.release()).toBe(false);
      expect(runtime.diagnostics().retainedPayloadBytes).toBe(0);
    });
  });
});
