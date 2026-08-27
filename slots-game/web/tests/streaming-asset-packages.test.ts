import { describe, expect, it, vi } from "vitest";
import {
  AssetPackageAbortedError,
  AssetPackageCapacityError,
  AssetPackageIntegrityError,
  StreamingAssetPackageManager,
  validateAssetPackageManifest,
  type AssetPackageManifest,
  type AssetPackageProgress,
  type AssetResourceDecoder,
} from "../src/startup/StreamingAssetPackages";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const TEST_SHA256 = Object.freeze({
  a: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  b: "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
  "decoded later": "e5a009e0945682a7cd8766081877e0f63bb0c191935b543159d17302cee21214",
  feature: "2ad562319767157087dda0dec6391f4479f8a04869ab0cc8d3a9c3637dae73b5",
  shell: "ce635c4eabff5e4f56dba8fb1e39ca235530aa2b6b18533eef1af3862016c577",
  interaction: "167d4b09d014f218c42abf5ebb397a2fc819401fe709223fbd729f1f8e9e790e",
  base: "cae662172fd450bb0cd710a769079c05bfc5d8e35efa6576edc7d0377afdd4a2",
  wheel: "ba59926159d2aa256eb8739b8da7e2b574b960e1202c6d624cbe981cef996c91",
  one: "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed",
  two: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3",
  three: "8b5b9db0c13db24256c829aa364aa90c6d2eba318b9232a4ab9313b954d3555f",
  four: "04efaf080f5a3e74e1c29d1ca6a48569382cbbcd324e8d59d2b83ef21c039f00",
  ok: "2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df",
  good: "770e607624d689265ca6c44884d0807d9b054d23c473c106c72be9de08b7376c",
  cancel: "2374d91794b79f4fb4ec9587d2cf00aecc4f9953fab3ed1dd12ab147a0b721f9",
  coins: "62f014cb316258f89133bb263f1fa74f85b308430765a403fbc87e20b367c959",
} as const);

const sha256 = (value: string): string => {
  const digest = TEST_SHA256[value as keyof typeof TEST_SHA256];
  if (!digest) throw new Error(`Missing test SHA-256 for ${value}`);
  return digest;
};

function manifest(
  packages: AssetPackageManifest["packages"],
): AssetPackageManifest {
  return {
    schemaVersion: 1,
    assetSet: "test-assets",
    packages,
  };
}

function resource(id: string, value: string) {
  const body = bytes(value);
  return {
    id,
    url: `/assets/${id}.bin`,
    bytes: body.byteLength,
    sha256: sha256(value),
    decoder: "binary" as const,
  };
}

function response(value: string): Response {
  const body = bytes(value);
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(body.byteLength) },
  });
}

describe("asset package manifest validation", () => {
  it("freezes a stable dependency order", () => {
    const checked = validateAssetPackageManifest(manifest([
      {
        id: "feature-on-demand",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["interaction-ready"],
        resources: [resource("feature", "feature")],
      },
      {
        id: "startup-shell",
        version: "1",
        stage: "startup-shell",
        resources: [resource("shell", "shell")],
      },
      {
        id: "interaction-ready",
        version: "1",
        stage: "interaction-ready",
        dependsOn: ["startup-shell"],
        resources: [resource("interaction", "interaction")],
      },
    ]));

    expect(checked.dependencyOrder).toEqual([
      "startup-shell",
      "interaction-ready",
      "feature-on-demand",
    ]);
    expect(Object.isFrozen(checked.manifest.packages)).toBe(true);
  });

  it.each([
    {
      label: "cycle",
      value: manifest([
        { id: "a", version: "1", stage: "startup-shell", dependsOn: ["b"], resources: [resource("a", "a")] },
        { id: "b", version: "1", stage: "base-critical", dependsOn: ["a"], resources: [resource("b", "b")] },
      ]),
      message: /cycle/i,
    },
    {
      label: "duplicate URL",
      value: manifest([
        { id: "a", version: "1", stage: "startup-shell", resources: [resource("same", "a")] },
        { id: "b", version: "1", stage: "base-critical", resources: [{ ...resource("other", "b"), url: "/assets/same.bin" }] },
      ]),
      message: /duplicate asset resource URL/i,
    },
    {
      label: "unsafe URL",
      value: manifest([{
        id: "a",
        version: "1",
        stage: "startup-shell",
        resources: [{ ...resource("a", "a"), url: "javascript:alert(1)" }],
      }]),
      message: /root-relative/i,
    },
    {
      label: "invalid digest",
      value: manifest([{
        id: "a",
        version: "1",
        stage: "startup-shell",
        resources: [{ ...resource("a", "a"), sha256: "abc" }],
      }]),
      message: /SHA-256/i,
    },
  ])("rejects $label before a request starts", ({ value, message }) => {
    expect(() => validateAssetPackageManifest(value)).toThrow(message);
  });
});

describe("StreamingAssetPackageManager", () => {
  it("binds the default browser fetch receiver before loading a package", async () => {
    const fetcher = vi.fn(function (this: typeof globalThis): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(response("wheel"));
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      const manager = new StreamingAssetPackageManager(manifest([{
        id: "wheel",
        version: "1",
        stage: "feature-on-demand",
        resources: [resource("wheel", "wheel")],
      }]), { maxAttempts: 1 });

      await expect(manager.load("wheel")).resolves.toMatchObject({ id: "wheel" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.instances).toEqual([globalThis]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels a forged-length chunked resource on the first byte beyond its manifest size", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("base"));
        controller.enqueue(bytes("x"));
        controller.enqueue(bytes("must-not-be-retained"));
        controller.close();
      },
      cancel(reason) {
        cancelled(reason);
      },
    }), {
      status: 200,
      headers: { "content-length": "1" },
    }));
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "base",
      version: "1",
      stage: "base-critical",
      resources: [resource("base", "base")],
    }]), { fetch: fetcher, maxAttempts: 1 });

    await expect(manager.load("base")).rejects.toThrow(/4-byte safety limit/i);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(manager.snapshot("base")).toMatchObject({ state: "failed" });
  });

  it("deduplicates callers, verifies bytes and never reports ready before decode", async () => {
    const body = "decoded later";
    let releaseDecode!: () => void;
    const decoder: AssetResourceDecoder = vi.fn(async ({ report }) => {
      report(0.5);
      await new Promise<void>((resolve) => { releaseDecode = resolve; });
      report(1);
      return "decoded";
    });
    const events: AssetPackageProgress[] = [];
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "base",
      version: "1",
      stage: "base-critical",
      resources: [{ ...resource("base", body), decoder: "custom" }],
    }]), {
      fetch: vi.fn(async () => response(body)),
      decoders: { custom: decoder },
      onProgress: (event) => events.push(event),
    });

    const first = manager.load("base");
    const second = manager.load("base");
    // 每个调用方都持有一个取消操作相互隔离的外观层，而底层网络和解码工作
    // 仍会去重。
    expect(second).not.toBe(first);
    await vi.waitFor(() => expect(decoder).toHaveBeenCalledOnce());
    expect(manager.snapshot("base").state).toBe("decoding");
    expect(events.at(-1)?.progress).toBeLessThan(1);
    expect(events.every((event) => event.state !== "ready")).toBe(true);

    releaseDecode();
    const loaded = await first;
    expect(loaded.resources.get("base")?.decoded).toBe("decoded");
    expect(manager.snapshot("base")).toMatchObject({ state: "ready", progress: 1 });
    expect(events.at(-1)).toMatchObject({ state: "ready", progress: 1 });
  });

  it("isolates every shared-load caller abort while another caller still owns the load", async () => {
    let releaseFetch!: () => void;
    let fetchSignal: AbortSignal | null = null;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? null;
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return response("base");
    });
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "base",
      version: "1",
      stage: "base-critical",
      resources: [resource("base", "base")],
    }]), { fetch: fetcher, maxAttempts: 1 });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const thirdAbort = new AbortController();

    const first = manager.load("base", { signal: firstAbort.signal });
    const second = manager.load("base", { signal: secondAbort.signal });
    const survivor = manager.load("base", { signal: thirdAbort.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    firstAbort.abort(new Error("first caller left"));
    secondAbort.abort(new Error("second caller left"));
    await expect(first).rejects.toBeInstanceOf(AssetPackageAbortedError);
    await expect(second).rejects.toBeInstanceOf(AssetPackageAbortedError);
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(false);
    expect(manager.snapshot("base").state).toBe("fetching");

    releaseFetch();
    await expect(survivor).resolves.toMatchObject({ id: "base" });
    expect(manager.snapshot("base")).toMatchObject({ state: "ready", progress: 1 });
  });

  it("loads dependencies once in stable order", async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      order.push(url);
      return response(url.includes("shell") ? "shell" : url.includes("base") ? "base" : "wheel");
    });
    const manager = new StreamingAssetPackageManager(manifest([
      {
        id: "wheel",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["base"],
        resources: [resource("wheel", "wheel")],
      },
      {
        id: "shell",
        version: "1",
        stage: "startup-shell",
        resources: [resource("shell", "shell")],
      },
      {
        id: "base",
        version: "1",
        stage: "base-critical",
        dependsOn: ["shell"],
        resources: [resource("base", "base")],
      },
    ]), { fetch: fetcher });

    await manager.load("wheel");
    expect(order).toEqual([
      "/assets/shell.bin",
      "/assets/base.bin",
      "/assets/wheel.bin",
    ]);
    expect(manager.readyPackageIds()).toEqual(["shell", "base", "wheel"]);
  });

  it("rebases manifest resources under the configured Vite public subpath", async () => {
    const fetcher = vi.fn(async () => response("wheel"));
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "wheel",
      version: "1",
      stage: "feature-on-demand",
      resources: [resource("wheel", "wheel")],
    }]), {
      fetch: fetcher,
      publicAssetBaseUrl: "/casino/primal/",
    });

    await manager.load("wheel");

    expect(fetcher).toHaveBeenCalledWith(
      "/casino/primal/assets/wheel.bin",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("enforces the global resource concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const id = String(input).split("/").at(-1)!.replace(".bin", "");
      return response(id);
    });
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "many",
      version: "1",
      stage: "base-critical",
      resources: ["one", "two", "three", "four"].map((id) => resource(id, id)),
    }]), { fetch: fetcher, concurrency: 2 });

    const load = manager.load("many");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await load;
    expect(peak).toBe(2);
  });

  it("retries a bounded transient failure and commits only the successful attempt", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(response("ok"));
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "retry",
      version: "1",
      stage: "interaction-ready",
      resources: [resource("retry", "ok")],
    }]), {
      fetch: fetcher,
      maxAttempts: 2,
      retryBaseMs: 0,
    });

    await expect(manager.load("retry")).resolves.toMatchObject({ id: "retry" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(manager.snapshot("retry").state).toBe("ready");
  });

  it("fails closed on SHA mismatch and remains explicitly retryable", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response("evil"))
      .mockResolvedValueOnce(response("good"));
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "integrity",
      version: "1",
      stage: "base-critical",
      resources: [resource("integrity", "good")],
    }]), { fetch: fetcher, maxAttempts: 1 });

    await expect(manager.load("integrity")).rejects.toBeInstanceOf(AssetPackageIntegrityError);
    expect(manager.snapshot("integrity").state).toBe("failed");
    await expect(manager.load("integrity")).resolves.toMatchObject({ id: "integrity" });
    expect(manager.snapshot("integrity").state).toBe("ready");
  });

  it("cancels queued work, suppresses false completion and permits a fresh retry", async () => {
    const controller = new AbortController();
    let first = true;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!first) return response("cancel");
      first = false;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    });
    const events: AssetPackageProgress[] = [];
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "cancel",
      version: "1",
      stage: "feature-on-demand",
      resources: [resource("cancel", "cancel")],
    }]), { fetch: fetcher, onProgress: (event) => events.push(event), maxAttempts: 1 });

    const loading = manager.load("cancel", { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await expect(loading).rejects.toBeInstanceOf(AssetPackageAbortedError);
    expect(manager.snapshot("cancel").state).toBe("cancelled");
    expect(events.every((event) => event.progress < 1)).toBe(true);

    await expect(manager.load("cancel")).resolves.toMatchObject({ id: "cancel" });
    expect(manager.snapshot("cancel").state).toBe("ready");
  });

  it("releases feature instances without discarding verified decoded resources", async () => {
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "big-win",
      version: "1",
      stage: "feature-on-demand",
      resources: [resource("coins", "coins")],
    }]), { fetch: vi.fn(async () => response("coins")) });
    await manager.load("big-win");

    const dispose = vi.fn();
    const instance = manager.acquireInstance("big-win", "overlay", () => ({ dispose }));
    expect(manager.acquireInstance("big-win", "overlay", () => ({ dispose: vi.fn() })))
      .toBe(instance);
    expect(manager.releasePackageInstances("big-win")).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.snapshot("big-win").state).toBe("ready");
    expect(manager.getReadyPackage("big-win")?.resources.get("coins")).toBeDefined();
  });

  it("reference-counts ready package leases and releases only the final owner", async () => {
    const fetcher = vi.fn(async () => response("wheel"));
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "wheel",
      version: "1",
      stage: "feature-on-demand",
      resources: [resource("wheel", "wheel")],
    }]), { fetch: fetcher });

    const first = await manager.acquire("wheel");
    const second = await manager.acquire("wheel");

    expect(first).not.toBe(second);
    expect(first.package).toBe(second.package);
    expect(first.released).toBe(false);
    expect(manager.referenceCount("wheel")).toBe(2);
    expect(fetcher).toHaveBeenCalledOnce();

    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);
    expect(first.released).toBe(true);
    expect(manager.referenceCount("wheel")).toBe(1);
    expect(manager.getReadyPackage("wheel")).toBe(second.package);

    expect(second.release()).toBe(true);
    expect(manager.referenceCount("wheel")).toBe(0);
    expect(manager.getReadyPackage("wheel")).toBeNull();
    expect(manager.snapshot("wheel")).toMatchObject({
      state: "unrequested",
      progress: 0,
      error: null,
    });
  });

  it("isolates an aborted acquire caller while another caller owns the deduplicated load", async () => {
    let releaseFetch!: () => void;
    const fetcher = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseFetch = resolve; });
      return response("wheel");
    });
    const manager = new StreamingAssetPackageManager(manifest([{
      id: "wheel",
      version: "1",
      stage: "feature-on-demand",
      resources: [resource("wheel", "wheel")],
    }]), { fetch: fetcher });
    const aborted = new AbortController();
    const leaving = manager.acquire("wheel", { signal: aborted.signal });
    const survivor = manager.acquire("wheel");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    aborted.abort(new Error("consumer left"));
    await expect(leaving).rejects.toBeInstanceOf(AssetPackageAbortedError);
    expect(manager.referenceCount("wheel")).toBe(0);

    releaseFetch();
    const lease = await survivor;
    expect(manager.referenceCount("wheel")).toBe(1);
    expect(lease.package.id).toBe("wheel");
    expect(lease.release()).toBe(true);
    expect(manager.referenceCount("wheel")).toBe(0);
  });

  it("acquires every package in one stage with dependency leases and releases them idempotently", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return response(url.includes("base") ? "base" : url.includes("wheel") ? "wheel" : "coins");
    });
    const manager = new StreamingAssetPackageManager(manifest([
      {
        id: "base",
        version: "1",
        stage: "base-critical",
        resources: [resource("base", "base")],
      },
      {
        id: "wheel",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["base"],
        resources: [resource("wheel", "wheel")],
      },
      {
        id: "big-win",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["base"],
        resources: [resource("coins", "coins")],
      },
    ]), { fetch: fetcher });

    const stage = await manager.acquireStage("feature-on-demand");
    expect(stage.stage).toBe("feature-on-demand");
    expect(stage.packageIds).toEqual(["base", "wheel", "big-win"]);
    expect(stage.packages.map(({ id }) => id)).toEqual(["base", "wheel", "big-win"]);
    expect(manager.referenceCount("base")).toBe(1);
    expect(manager.referenceCount("wheel")).toBe(1);
    expect(manager.referenceCount("big-win")).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);

    expect(stage.release()).toBe(true);
    expect(stage.release()).toBe(false);
    expect(stage.released).toBe(true);
    expect(manager.readyPackageIds()).toEqual([]);
    expect(manager.referenceCount("base")).toBe(0);
  });

  it("rolls back already acquired stage leases if a later package is aborted", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("wheel")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return response("base");
    });
    const manager = new StreamingAssetPackageManager(manifest([
      {
        id: "base",
        version: "1",
        stage: "base-critical",
        resources: [resource("base", "base")],
      },
      {
        id: "wheel",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["base"],
        resources: [resource("wheel", "wheel")],
      },
    ]), { fetch: fetcher, maxAttempts: 1 });

    const acquiring = manager.acquireStage("feature-on-demand", { signal: abort.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(manager.getReadyPackage("base")).not.toBeNull();
    // 只有完整阶段就绪后，所有权才会对外可见；待定预留仍会阻止依赖项被提前淘汰。
    expect(manager.referenceCount("base")).toBe(0);
    abort.abort(new Error("feature exited"));

    await expect(acquiring).rejects.toBeInstanceOf(AssetPackageAbortedError);
    expect(manager.referenceCount("base")).toBe(0);
    expect(manager.getReadyPackage("base")).toBeNull();
    expect(manager.referenceCount("wheel")).toBe(0);
  });

  it("enforces the retained payload ceiling before fetch and counts shared dependencies once", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return response(url.includes("base") ? "base" : "wheel");
    });
    const definition = manifest([
      {
        id: "base",
        version: "1",
        stage: "base-critical",
        resources: [resource("base", "base")],
      },
      {
        id: "wheel",
        version: "1",
        stage: "feature-on-demand",
        dependsOn: ["base"],
        resources: [resource("wheel", "wheel")],
      },
    ]);
    const exactBytes = "base".length + "wheel".length;
    const manager = new StreamingAssetPackageManager(definition, {
      fetch: fetcher,
      maxRetainedBytes: exactBytes,
    });

    const first = await manager.acquire("wheel");
    const second = await manager.acquire("wheel");
    expect(manager.retainedPayloadBytes()).toBe(exactBytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
    first.release();
    expect(manager.retainedPayloadBytes()).toBe(exactBytes);
    second.release();
    expect(manager.retainedPayloadBytes()).toBe(0);

    const constrainedFetcher = vi.fn(async () => response("base"));
    const constrained = new StreamingAssetPackageManager(definition, {
      fetch: constrainedFetcher,
      maxRetainedBytes: exactBytes - 1,
    });
    await expect(constrained.acquire("wheel")).rejects.toBeInstanceOf(
      AssetPackageCapacityError,
    );
    expect(constrainedFetcher).not.toHaveBeenCalled();
    expect(constrained.retainedPayloadBytes()).toBe(0);
  });
});
