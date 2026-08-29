import { publicAssetUrl } from "../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseBytes,
} from "../network/boundedResponse";

export type AssetPackageStage =
  | "startup-shell"
  | "base-critical"
  | "interaction-ready"
  | "feature-on-demand";

export type AssetDecoderId = "binary" | "text" | "json" | (string & {});

export interface AssetPackageResourceSpec {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly decoder: AssetDecoderId;
}

export interface AssetPackageSpec {
  readonly id: string;
  readonly version: string;
  readonly stage: AssetPackageStage;
  readonly dependsOn?: readonly string[];
  readonly resources: readonly AssetPackageResourceSpec[];
}

export interface AssetPackageManifest {
  readonly schemaVersion: 1;
  readonly assetSet: string;
  readonly packages: readonly AssetPackageSpec[];
}

export interface ValidatedAssetPackageManifest {
  readonly manifest: AssetPackageManifest;
  readonly dependencyOrder: readonly string[];
}

export type AssetPackageState =
  | "unrequested"
  | "fetching"
  | "decoding"
  | "ready"
  | "failed"
  | "cancelled";

export interface AssetPackageSnapshot {
  readonly id: string;
  readonly stage: AssetPackageStage;
  readonly state: AssetPackageState;
  readonly progress: number;
  readonly error: Error | null;
}

export interface AssetPackageProgress extends AssetPackageSnapshot {
  readonly resourceId: string | null;
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface AssetResourceDecodeContext {
  readonly bytes: Uint8Array;
  readonly resource: AssetPackageResourceSpec;
  readonly signal: AbortSignal;
  report(fraction: number): void;
}

export type AssetResourceDecoder = (
  context: AssetResourceDecodeContext,
) => unknown | Promise<unknown>;

export interface LoadedAssetResource {
  readonly spec: AssetPackageResourceSpec;
  readonly bytes: Uint8Array;
  readonly decoded: unknown;
}

export interface LoadedAssetPackage {
  readonly id: string;
  readonly version: string;
  readonly stage: AssetPackageStage;
  readonly resources: ReadonlyMap<string, LoadedAssetResource>;
}

export interface DisposableAssetInstance {
  dispose(): void;
}

export interface LoadAssetPackageOptions {
  readonly signal?: AbortSignal;
}

export interface AcquiredAssetPackage {
  readonly id: string;
  readonly package: LoadedAssetPackage;
  /** 目标加上依赖项，按稳定的依赖顺序。 / English: Target plus dependencies, in stable dependency order. */
  readonly packageIds: readonly string[];
  readonly released: boolean;
  /** 幂等。仅在过渡到已发布时返回 true。 / English: Idempotent. Returns true only when transitioning to published. */
  release(): boolean;
}

export interface AcquiredAssetPackageStage {
  readonly stage: AssetPackageStage;
  /** 完整的依赖关闭，以稳定的依赖顺序。 / English: Complete dependency closure, in stable dependency order. */
  readonly packageIds: readonly string[];
  readonly packages: readonly LoadedAssetPackage[];
  readonly released: boolean;
  /** 幂等。仅在过渡到已发布时返回 true。 / English: Idempotent. Returns true only when transitioning to published. */
  release(): boolean;
}

export interface StreamingAssetPackageManagerOptions {
  readonly fetch?: typeof fetch;
  /** 测试/宿主可显式绑定 Vite public base；正式构建默认使用 import.meta.env.BASE_URL。 / English: Test/host can explicitly bind Vite public base; official builds use import.meta.env.BASE_URL by default. */
  readonly publicAssetBaseUrl?: string;
  readonly decoders?: Readonly<Record<string, AssetResourceDecoder>>;
  readonly concurrency?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly onProgress?: (progress: Readonly<AssetPackageProgress>) => void;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
  /** 可选硬质天花板，用于消费者保留的独特包装。 / English: Optional hard ceiling for unique packaging reserved by consumers. */
  readonly maxRetainedBytes?: number;
}

export class AssetPackageManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetPackageManifestError";
  }
}

export class AssetPackageIntegrityError extends Error {
  constructor(readonly resourceId: string, expected: string, actual: string) {
    super(`Asset resource "${resourceId}" SHA-256 mismatch: expected ${expected}, received ${actual}`);
    this.name = "AssetPackageIntegrityError";
  }
}

export class AssetPackageAbortedError extends Error {
  constructor(message = "Asset package load was aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class AssetPackageTimeoutError extends Error {
  constructor(readonly resourceId: string, readonly timeoutMs: number) {
    super(`Asset resource "${resourceId}" timed out after ${timeoutMs}ms`);
    this.name = "AssetPackageTimeoutError";
  }
}

export class AssetPackageCapacityError extends Error {
  constructor(readonly requiredBytes: number, readonly limitBytes: number) {
    super(`Asset package acquisition requires ${requiredBytes} retained bytes; limit is ${limitBytes}`);
    this.name = "AssetPackageCapacityError";
  }
}

interface MutablePackageRuntime {
  state: AssetPackageState;
  progress: number;
  error: Error | null;
  inFlight: Promise<LoadedAssetPackage> | null;
  inFlightController: AbortController | null;
  callers: Set<symbol>;
  cancelWhenUnobserved: boolean;
  ready: LoadedAssetPackage | null;
  instances: Map<string, DisposableAssetInstance>;
  pendingReferences: number;
  activeReferences: number;
}

const PACKAGE_STAGES = new Set<AssetPackageStage>([
  "startup-shell",
  "base-critical",
  "interaction-ready",
  "feature-on-demand",
]);

const RUNNING_MAX = 1 - 1e-6;
const SHA256 = /^[a-f0-9]{64}$/;

export function validateAssetPackageManifest(
  input: AssetPackageManifest,
): ValidatedAssetPackageManifest {
  if (!input || input.schemaVersion !== 1) {
    throw new AssetPackageManifestError("Asset package manifest schemaVersion must equal 1");
  }
  if (!validToken(input.assetSet)) {
    throw new AssetPackageManifestError("Asset package manifest assetSet must not be empty");
  }
  if (!Array.isArray(input.packages)) {
    throw new AssetPackageManifestError("Asset package manifest packages must be an array");
  }

  const packageIds = new Set<string>();
  const resourceIds = new Set<string>();
  const urls = new Set<string>();
  const packages = input.packages.map((entry) => {
    if (!validToken(entry.id)) throw new AssetPackageManifestError("Asset package id must not be empty");
    if (packageIds.has(entry.id)) {
      throw new AssetPackageManifestError(`Duplicate asset package id "${entry.id}"`);
    }
    packageIds.add(entry.id);
    if (!validToken(entry.version)) {
      throw new AssetPackageManifestError(`Asset package "${entry.id}" version must not be empty`);
    }
    if (!PACKAGE_STAGES.has(entry.stage)) {
      throw new AssetPackageManifestError(`Asset package "${entry.id}" has an unknown stage`);
    }
    if (!Array.isArray(entry.resources) || entry.resources.length === 0) {
      throw new AssetPackageManifestError(`Asset package "${entry.id}" resources must not be empty`);
    }
    const dependencies = Object.freeze([...(entry.dependsOn ?? [])]);
    if (new Set(dependencies).size !== dependencies.length) {
      throw new AssetPackageManifestError(`Asset package "${entry.id}" has duplicate dependencies`);
    }
    const resources = entry.resources.map((resource: AssetPackageResourceSpec) => {
      if (!validToken(resource.id)) {
        throw new AssetPackageManifestError(`Asset package "${entry.id}" has an empty resource id`);
      }
      if (resourceIds.has(resource.id)) {
        throw new AssetPackageManifestError(`Duplicate asset resource id "${resource.id}"`);
      }
      resourceIds.add(resource.id);
      if (!isSafeAssetUrl(resource.url)) {
        throw new AssetPackageManifestError(
          `Asset resource "${resource.id}" URL must be a root-relative same-origin path`,
        );
      }
      if (urls.has(resource.url)) {
        throw new AssetPackageManifestError(`Duplicate asset resource URL "${resource.url}"`);
      }
      urls.add(resource.url);
      if (!Number.isSafeInteger(resource.bytes) || resource.bytes <= 0) {
        throw new AssetPackageManifestError(`Asset resource "${resource.id}" bytes must be positive`);
      }
      if (resource.bytes > NETWORK_RESPONSE_LIMITS.assetPackageResourceBytes) {
        throw new AssetPackageManifestError(
          `Asset resource "${resource.id}" exceeds the per-resource safety limit`,
        );
      }
      const digest = resource.sha256.toLowerCase();
      if (!SHA256.test(digest)) {
        throw new AssetPackageManifestError(`Asset resource "${resource.id}" has an invalid SHA-256`);
      }
      if (!validToken(resource.decoder)) {
        throw new AssetPackageManifestError(`Asset resource "${resource.id}" decoder must not be empty`);
      }
      return Object.freeze({ ...resource, sha256: digest });
    });
    return Object.freeze({
      ...entry,
      dependsOn: dependencies,
      resources: Object.freeze(resources),
    });
  });

  for (const entry of packages) {
    for (const dependency of entry.dependsOn) {
      if (!packageIds.has(dependency)) {
        throw new AssetPackageManifestError(
          `Asset package "${entry.id}" depends on unknown package "${dependency}"`,
        );
      }
      if (dependency === entry.id) {
        throw new AssetPackageManifestError(`Asset package "${entry.id}" dependency cycle`);
      }
    }
  }

  const order = topologicalPackageOrder(packages);
  const manifest = deepFreezeManifest({
    schemaVersion: 1,
    assetSet: input.assetSet,
    packages,
  });
  return Object.freeze({ manifest, dependencyOrder: Object.freeze(order) });
}

/**
 * Window.fetch 是 Web-IDL 方法；存储在类上时，不得继承包或运行时实例作为 receiver。
 * 注入的 fetch 实现保留调用方绑定；这里只规范化浏览器默认实现。
 *
 * 英文 / English: Window.fetch is a Web-IDL method; when stored on a class, it must not inherit a package or runtime instance as a receiver. The injected fetch implementation retains caller bindings; only the browser default implementation is normalized here.
 */
export function defaultStreamingAssetFetch(): typeof fetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Streaming asset fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis);
}

export class StreamingAssetPackageManager {
  readonly validated: ValidatedAssetPackageManifest;
  private readonly packages = new Map<string, AssetPackageSpec>();
  private readonly runtimes = new Map<string, MutablePackageRuntime>();
  private readonly fetcher: typeof fetch;
  private readonly publicAssetBaseUrl: string | undefined;
  private readonly decoders: Readonly<Record<string, AssetResourceDecoder>>;
  private readonly semaphore: AsyncSemaphore;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly onProgress: (progress: Readonly<AssetPackageProgress>) => void;
  private readonly digest: (bytes: Uint8Array) => Promise<string>;
  private readonly maxRetainedBytes: number | null;

  constructor(
    manifest: AssetPackageManifest,
    options: StreamingAssetPackageManagerOptions = {},
  ) {
    this.validated = validateAssetPackageManifest(manifest);
    this.fetcher = options.fetch ?? defaultStreamingAssetFetch();
    this.publicAssetBaseUrl = options.publicAssetBaseUrl;
    this.decoders = Object.freeze({
      binary: ({ bytes }) => bytes,
      text: ({ bytes }) => new TextDecoder().decode(bytes),
      json: ({ bytes }) => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      ...(options.decoders ?? {}),
    });
    this.semaphore = new AsyncSemaphore(positiveInteger(options.concurrency ?? 4, "concurrency"));
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 2, "maxAttempts");
    this.retryBaseMs = nonNegativeFinite(options.retryBaseMs ?? 120, "retryBaseMs");
    this.attemptTimeoutMs = positiveFinite(options.attemptTimeoutMs ?? 20_000, "attemptTimeoutMs");
    this.onProgress = options.onProgress ?? (() => undefined);
    this.digest = options.digest ?? browserSha256;
    this.maxRetainedBytes = options.maxRetainedBytes === undefined
      ? null
      : positiveInteger(options.maxRetainedBytes, "maxRetainedBytes");

    for (const entry of this.validated.manifest.packages) {
      this.packages.set(entry.id, entry);
      this.runtimes.set(entry.id, {
        state: "unrequested",
        progress: 0,
        error: null,
        inFlight: null,
        inFlightController: null,
        callers: new Set(),
        cancelWhenUnobserved: false,
        ready: null,
        instances: new Map(),
        pendingReferences: 0,
        activeReferences: 0,
      });
    }
  }

  load(id: string, options: LoadAssetPackageOptions = {}): Promise<LoadedAssetPackage> {
    const spec = this.requireSpec(id);
    const runtime = this.requireRuntime(id);
    if (runtime.ready) return awaitWithAbort(Promise.resolve(runtime.ready), options.signal);
    if (runtime.inFlight && !runtime.inFlightController?.signal.aborted) {
      return this.joinInFlight(runtime, options.signal);
    }
    if (runtime.inFlightController?.signal.aborted) {
      runtime.inFlight = null;
      runtime.inFlightController = null;
      runtime.callers.clear();
      runtime.cancelWhenUnobserved = false;
    }
    runtime.state = "unrequested";
    runtime.progress = 0;
    runtime.error = null;

    const controller = new AbortController();
    runtime.inFlightController = controller;
    runtime.cancelWhenUnobserved = options.signal !== undefined;
    const attempt = this.loadWithDependencies(spec, controller.signal)
      .then((loaded) => {
        throwIfAborted(controller.signal);
        runtime.ready = loaded;
        runtime.state = "ready";
        runtime.progress = 1;
        runtime.error = null;
        this.emit(spec, null, 1, 1, "ready");
        return loaded;
      })
      .catch((cause: unknown) => {
        const error = normalizeLoadError(cause, controller.signal);
        runtime.state = error instanceof AssetPackageAbortedError ? "cancelled" : "failed";
        runtime.error = error;
        runtime.progress = Math.min(runtime.progress, RUNNING_MAX);
        this.emit(spec, null, runtime.progress, runtime.progress, runtime.state);
        throw error;
      })
      .finally(() => {
        if (runtime.inFlight === attempt) {
          runtime.inFlight = null;
          runtime.inFlightController = null;
          runtime.callers.clear();
          runtime.cancelWhenUnobserved = false;
        }
      });
    runtime.inFlight = attempt;
    return this.joinInFlight(runtime, options.signal);
  }

  private joinInFlight(
    runtime: MutablePackageRuntime,
    signal?: AbortSignal,
  ): Promise<LoadedAssetPackage> {
    const inFlight = runtime.inFlight;
    if (!inFlight) throw new Error("Asset package in-flight owner is missing");
    const caller = Symbol("asset-package-caller");
    runtime.callers.add(caller);
    const joined = awaitWithAbort(inFlight, signal);
    return joined.finally(() => {
      const callerWasAborted = signal?.aborted === true;
      runtime.callers.delete(caller);
      if (
        runtime.inFlight === inFlight &&
        runtime.cancelWhenUnobserved &&
        callerWasAborted &&
        runtime.callers.size === 0 &&
        !runtime.inFlightController?.signal.aborted
      ) {
        runtime.inFlightController?.abort(
          new AssetPackageAbortedError("Asset package load has no remaining callers"),
        );
      }
    });
  }

  snapshot(id: string): AssetPackageSnapshot {
    const spec = this.requireSpec(id);
    const runtime = this.requireRuntime(id);
    return Object.freeze({
      id,
      stage: spec.stage,
      state: runtime.state,
      progress: runtime.progress,
      error: runtime.error,
    });
  }

  readyPackageIds(): readonly string[] {
    return Object.freeze(this.validated.dependencyOrder.filter((id) => (
      this.requireRuntime(id).state === "ready"
    )));
  }

  getReadyPackage(id: string): LoadedAssetPackage | null {
    this.requireSpec(id);
    return this.requireRuntime(id).ready;
  }

  /** 实时消费者句柄数。有意排除待定收购。 / English: The number of real-time consumer handles. Pending acquisitions intentionally excluded. */
  referenceCount(id: string): number {
    this.requireSpec(id);
    return this.requireRuntime(id).activeReferences;
  }

  /** 由待处理和实时消费者句柄保留的唯一清单字节。 / English: Unique manifest bytes reserved by pending and live consumer handles. */
  retainedPayloadBytes(): number {
    return this.validated.dependencyOrder.reduce((total, id) => {
      const runtime = this.requireRuntime(id);
      if (runtime.pendingReferences <= 0 && runtime.activeReferences <= 0) return total;
      return total + this.packageBytes(this.requireSpec(id));
    }, 0);
  }

  /**
   * 加载并保留一个包及其完整的依赖关系闭包。并发调用者共享获取/解码工作，但接收独立的、幂等可释放的句柄。
   *
   * 英文 / English: Loads and retains a package and its complete dependency closure. Concurrent callers share the fetch/decode work but receive independent, idempotent releasable handles.
   */
  async acquire(
    id: string,
    options: LoadAssetPackageOptions = {},
  ): Promise<AcquiredAssetPackage> {
    this.requireSpec(id);
    const packageIds = this.dependencyClosureIds([id]);
    this.reserveReferences(packageIds);
    try {
      const loaded = await this.load(id, options);
      throwIfAbortedSignal(options.signal);
      this.activateReferences(packageIds);
      return this.packageLease(id, loaded, packageIds);
    } catch (cause) {
      this.rollbackPendingReferences(packageIds);
      throw cause;
    }
  }

  /** 获取为一个阶段预设的所有包作为一个原子所有权单元。 / English: Gets all packages provisioned for a stage as an atomic ownership unit. */
  async acquireStage(
    stage: AssetPackageStage,
    options: LoadAssetPackageOptions = {},
  ): Promise<AcquiredAssetPackageStage> {
    if (!PACKAGE_STAGES.has(stage)) throw new Error(`Unknown asset package stage "${stage}"`);
    const targetIds = this.validated.dependencyOrder.filter(
      (id) => this.requireSpec(id).stage === stage,
    );
    if (targetIds.length === 0) throw new Error(`Asset package stage "${stage}" is empty`);
    const packageIds = this.dependencyClosureIds(targetIds);
    this.reserveReferences(packageIds);
    try {
      await Promise.all(targetIds.map((id) => this.load(id, options)));
      throwIfAbortedSignal(options.signal);
      const packages = packageIds.map((id) => {
        const loaded = this.requireRuntime(id).ready;
        if (!loaded) throw new Error(`Asset package "${id}" did not become ready`);
        return loaded;
      });
      this.activateReferences(packageIds);
      return this.stageLease(stage, packages, packageIds);
    } catch (cause) {
      this.rollbackPendingReferences(packageIds);
      throw cause;
    }
  }

  acquireInstance<T extends DisposableAssetInstance>(
    packageId: string,
    instanceId: string,
    create: () => T,
  ): T {
    if (!validToken(instanceId)) throw new Error("Asset instance id must not be empty");
    const runtime = this.requireRuntime(packageId);
    if (!runtime.ready) throw new Error(`Asset package "${packageId}" is not ready`);
    const existing = runtime.instances.get(instanceId);
    if (existing) return existing as T;
    const created = create();
    if (!created || typeof created.dispose !== "function") {
      throw new Error(`Asset instance "${instanceId}" must expose dispose()`);
    }
    runtime.instances.set(instanceId, created);
    return created;
  }

  releasePackageInstances(packageId: string): number {
    const runtime = this.requireRuntime(packageId);
    const instances = [...runtime.instances.values()];
    runtime.instances.clear();
    for (const instance of instances) {
      try {
        instance.dispose();
      } catch {
        // 拆卸必须通过同级实例继续。共享解码资源仍然驻留，不属于实例处置。 / English: Teardown must continue through the sibling instance. The shared decoding resource still resides and is not part of the instance's disposal.
      }
    }
    return instances.length;
  }

  private dependencyClosureIds(targetIds: readonly string[]): readonly string[] {
    const selected = new Set<string>();
    const visit = (id: string): void => {
      if (selected.has(id)) return;
      const spec = this.requireSpec(id);
      for (const dependency of spec.dependsOn ?? []) visit(dependency);
      selected.add(id);
    };
    for (const id of targetIds) visit(id);
    return Object.freeze(
      this.validated.dependencyOrder.filter((id) => selected.has(id)),
    );
  }

  private reserveReferences(ids: readonly string[]): void {
    if (this.maxRetainedBytes !== null) {
      const selected = new Set(ids);
      for (const id of this.validated.dependencyOrder) {
        const runtime = this.requireRuntime(id);
        if (runtime.pendingReferences > 0 || runtime.activeReferences > 0) selected.add(id);
      }
      const requiredBytes = [...selected].reduce(
        (total, id) => total + this.packageBytes(this.requireSpec(id)),
        0,
      );
      if (requiredBytes > this.maxRetainedBytes) {
        throw new AssetPackageCapacityError(requiredBytes, this.maxRetainedBytes);
      }
    }
    for (const id of ids) this.requireRuntime(id).pendingReferences += 1;
  }

  private packageBytes(spec: AssetPackageSpec): number {
    return spec.resources.reduce((total, resource) => total + resource.bytes, 0);
  }

  private activateReferences(ids: readonly string[]): void {
    for (const id of ids) {
      const runtime = this.requireRuntime(id);
      runtime.pendingReferences = Math.max(0, runtime.pendingReferences - 1);
      runtime.activeReferences += 1;
    }
  }

  private rollbackPendingReferences(ids: readonly string[]): void {
    for (const id of [...ids].reverse()) {
      const runtime = this.requireRuntime(id);
      runtime.pendingReferences = Math.max(0, runtime.pendingReferences - 1);
      if (runtime.ready) this.evictIfUnowned(id, runtime);
    }
  }

  private releaseReferences(ids: readonly string[]): void {
    for (const id of [...ids].reverse()) {
      const runtime = this.requireRuntime(id);
      if (runtime.activeReferences <= 0) {
        throw new Error(`Asset package "${id}" reference count underflow`);
      }
      runtime.activeReferences -= 1;
      this.evictIfUnowned(id, runtime);
    }
  }

  private evictIfUnowned(id: string, runtime: MutablePackageRuntime): void {
    if (runtime.activeReferences > 0 || runtime.pendingReferences > 0 || runtime.inFlight) return;
    this.releasePackageInstances(id);
    runtime.ready = null;
    runtime.state = "unrequested";
    runtime.progress = 0;
    runtime.error = null;
  }

  private packageLease(
    id: string,
    loaded: LoadedAssetPackage,
    packageIds: readonly string[],
  ): AcquiredAssetPackage {
    let released = false;
    const manager = this;
    return Object.freeze({
      id,
      package: loaded,
      packageIds,
      get released() { return released; },
      release(): boolean {
        if (released) return false;
        released = true;
        manager.releaseReferences(packageIds);
        return true;
      },
    });
  }

  private stageLease(
    stage: AssetPackageStage,
    packages: readonly LoadedAssetPackage[],
    packageIds: readonly string[],
  ): AcquiredAssetPackageStage {
    let released = false;
    const manager = this;
    return Object.freeze({
      stage,
      packageIds,
      packages: Object.freeze([...packages]),
      get released() { return released; },
      release(): boolean {
        if (released) return false;
        released = true;
        manager.releaseReferences(packageIds);
        return true;
      },
    });
  }

  private async loadWithDependencies(
    spec: AssetPackageSpec,
    signal: AbortSignal,
  ): Promise<LoadedAssetPackage> {
    for (const dependency of spec.dependsOn ?? []) {
      await this.load(dependency, { signal });
    }
    throwIfAborted(signal);
    return this.loadResources(spec, signal);
  }

  private async loadResources(
    spec: AssetPackageSpec,
    signal: AbortSignal,
  ): Promise<LoadedAssetPackage> {
    const runtime = this.requireRuntime(spec.id);
    runtime.state = "fetching";
    runtime.progress = 0;
    runtime.error = null;
    const totalBytes = spec.resources.reduce((sum, resource) => sum + resource.bytes, 0);
    const resourceFractions = new Map(spec.resources.map((resource) => [resource.id, 0]));
    const update = (
      resource: AssetPackageResourceSpec,
      state: "fetching" | "decoding",
      fraction: number,
    ): void => {
      const previous = resourceFractions.get(resource.id) ?? 0;
      const monotonic = Math.max(previous, clamp01(fraction));
      resourceFractions.set(resource.id, monotonic);
      const weighted = spec.resources.reduce(
        (sum, item) => sum + item.bytes * (resourceFractions.get(item.id) ?? 0),
        0,
      );
      runtime.state = state;
      runtime.progress = Math.min(RUNNING_MAX, weighted / totalBytes);
      this.emit(spec, resource.id, weighted, totalBytes, state);
    };

    const staged = await Promise.all(spec.resources.map(async (resource) => {
      const release = await this.semaphore.acquire(signal);
      try {
        const body = await this.fetchVerifiedResource(resource, signal, (fraction) => {
          update(resource, "fetching", fraction * 0.8);
        });
        update(resource, "decoding", 0.8);
        const decoder = this.decoders[resource.decoder];
        if (!decoder) throw new Error(`No decoder registered for "${resource.decoder}"`);
        let decodeFraction = 0;
        const decoded = await decoder({
          bytes: body,
          resource,
          signal,
          report: (fraction) => {
            if (signal.aborted) return;
            if (!Number.isFinite(fraction)) {
              throw new Error(`Asset decoder "${resource.decoder}" reported non-finite progress`);
            }
            decodeFraction = Math.max(decodeFraction, clamp01(fraction));
            update(resource, "decoding", 0.8 + decodeFraction * 0.2);
          },
        });
        throwIfAborted(signal);
        update(resource, "decoding", 1);
        return [resource.id, Object.freeze({ spec: resource, bytes: body, decoded })] as const;
      } finally {
        release();
      }
    }));

    throwIfAborted(signal);
    return Object.freeze({
      id: spec.id,
      version: spec.version,
      stage: spec.stage,
      resources: new Map(staged),
    });
  }

  private async fetchVerifiedResource(
    resource: AssetPackageResourceSpec,
    signal: AbortSignal,
    report: (fraction: number) => void,
  ): Promise<Uint8Array> {
    let latest: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        const body = await this.fetchOnce(resource, signal, report);
        const actual = await this.digest(body);
        throwIfAborted(signal);
        if (actual.toLowerCase() !== resource.sha256) {
          throw new AssetPackageIntegrityError(resource.id, resource.sha256, actual.toLowerCase());
        }
        return body;
      } catch (error) {
        if (signal.aborted) throw abortError(signal);
        latest = error;
        if (error instanceof AssetPackageIntegrityError || attempt === this.maxAttempts) throw error;
        await abortableDelay(this.retryBaseMs * 2 ** (attempt - 1), signal);
      }
    }
    throw latest;
  }

  private async fetchOnce(
    resource: AssetPackageResourceSpec,
    signal: AbortSignal,
    report: (fraction: number) => void,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    const timeout = setTimeout(() => {
      controller.abort(new AssetPackageTimeoutError(resource.id, this.attemptTimeoutMs));
    }, this.attemptTimeoutMs);
    const resolvedUrl = publicAssetUrl(resource.url, this.publicAssetBaseUrl);
    try {
      const response = await this.fetcher(resolvedUrl, {
        signal: controller.signal,
        credentials: "same-origin",
        cache: "default",
      });
      if (!response.ok) {
        const error = new Error(`Failed to load ${resolvedUrl}: HTTP ${response.status}`);
        cancelNetworkResponse(response, error);
        throw error;
      }
      const body = await readResponseBytes(response, resource.bytes, controller.signal, report);
      if (body.byteLength !== resource.bytes) {
        throw new Error(
          `Asset resource "${resource.id}" byte size mismatch: expected ${resource.bytes}, received ${body.byteLength}`,
        );
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal.aborted) throw abortError(signal);
        if (controller.signal.reason instanceof AssetPackageTimeoutError) throw controller.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  private emit(
    spec: AssetPackageSpec,
    resourceId: string | null,
    completedBytes: number,
    totalBytes: number,
    state: AssetPackageState,
  ): void {
    const runtime = this.requireRuntime(spec.id);
    this.onProgress(Object.freeze({
      id: spec.id,
      stage: spec.stage,
      state,
      progress: runtime.progress,
      error: runtime.error,
      resourceId,
      completedBytes,
      totalBytes,
    }));
  }

  private requireSpec(id: string): AssetPackageSpec {
    const spec = this.packages.get(id);
    if (!spec) throw new Error(`Unknown asset package "${id}"`);
    return spec;
  }

  private requireRuntime(id: string): MutablePackageRuntime {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw new Error(`Unknown asset package "${id}"`);
    return runtime;
  }
}

class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<{
    readonly signal: AbortSignal;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const queued = { signal, resolve, reject };
      this.queue.push(queued);
      const onAbort = (): void => {
        const index = this.queue.indexOf(queued);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const originalResolve = queued.resolve;
      (queued as { resolve: (release: () => void) => void }).resolve = (release) => {
        signal.removeEventListener("abort", onAbort);
        originalResolve(release);
      };
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.resolve(this.releaseHandle());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

async function readResponseBytes(
  response: Response,
  expectedBytes: number,
  signal: AbortSignal,
  report: (fraction: number) => void,
): Promise<Uint8Array> {
  // 清单的字节数是完整性契约而非 Content-Length 的替身；即使服务端采用分块传输或伪造声明长度，也在第一个越界分块到达时取消网络流。 / English: The number of bytes in the manifest is an integrity contract and not a stand-in for Content-Length; even if the server uses chunked transfers or forges declared lengths, the network flow will be canceled when the first out-of-bounds chunk arrives.
  return readBoundedResponseBytes(response, {
    label: "Streaming asset resource",
    maxBytes: expectedBytes,
    signal,
    onProgress: (receivedBytes) => {
      report(Math.min(1, receivedBytes / expectedBytes));
    },
  });
}

async function browserSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function topologicalPackageOrder(packages: readonly AssetPackageSpec[]): string[] {
  const byId = new Map(packages.map((entry) => [entry.id, entry]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new AssetPackageManifestError(`Asset package dependency cycle at "${id}"`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const entry of packages) visit(entry.id);
  return result;
}

function deepFreezeManifest(manifest: AssetPackageManifest): AssetPackageManifest {
  return Object.freeze({
    ...manifest,
    packages: Object.freeze(manifest.packages.map((entry) => Object.freeze({
      ...entry,
      dependsOn: Object.freeze([...(entry.dependsOn ?? [])]),
      resources: Object.freeze(entry.resources.map((resource) => Object.freeze({ ...resource }))),
    }))),
  });
}

function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => undefined;
  const abort = (): void => child.abort(parent.reason ?? new AssetPackageAbortedError());
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function throwIfAbortedSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): AssetPackageAbortedError {
  if (signal.reason instanceof AssetPackageAbortedError) return signal.reason;
  const detail = signal.reason instanceof Error ? `: ${signal.reason.message}` : "";
  return new AssetPackageAbortedError(`Asset package load was aborted${detail}`);
}

function normalizeLoadError(cause: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return abortError(signal);
  return cause instanceof Error ? cause : new Error(String(cause));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve().then(() => throwIfAborted(signal));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms);
    const onAbort = (): void => done(abortError(signal));
    function done(error?: Error): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeAssetUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") && !url.includes("\0");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must not be negative`);
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
