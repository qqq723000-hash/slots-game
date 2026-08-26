import type { PrimalRuntimeAssetChannel } from "../assets/primalRuntimeAssets";
import { publicAssetUrl } from "../assets/publicAssetUrl";
import {
  cancelNetworkResponse,
  NETWORK_RESPONSE_LIMITS,
  readBoundedResponseText,
} from "../network/boundedResponse";
import {
  AssetPackageAbortedError,
  StreamingAssetPackageManager,
  defaultStreamingAssetFetch,
  validateAssetPackageManifest,
  type AssetPackageManifest,
  type AssetPackageSnapshot,
  type AssetPackageStage,
  type AcquiredAssetPackage,
  type AcquiredAssetPackageStage,
  type StreamingAssetPackageManagerOptions,
} from "./StreamingAssetPackages";

export type AssetStreamingMode = "off" | "on-demand" | "shadow";
export type StreamingManifestState =
  "off" | "unrequested" | "loading" | "validated" | "failed" | "destroyed";
export type ShadowPackageState =
  "unrequested" | "loading" | "verified" | "failed" | "cancelled";

export interface ShadowPackageDiagnostic {
  readonly id: string;
  readonly stage: AssetPackageStage;
  readonly state: ShadowPackageState;
  readonly progress: number;
  readonly error: string | null;
}

export interface StreamingAssetRuntimeDiagnostics {
  readonly mode: AssetStreamingMode;
  readonly channel: PrimalRuntimeAssetChannel;
  readonly manifestUrl: string;
  readonly manifestState: StreamingManifestState;
  readonly backgroundScheduled: boolean;
  readonly backgroundRunning: boolean;
  readonly featureStageVerified: boolean;
  /** 旧影子校验始终为零；只有真实消费者租约持有载荷时才允许非零。 */
  readonly retainedPayloadBytes: number;
  readonly peakOperationPayloadBytes: number;
  readonly lastError: string | null;
  readonly packages: readonly ShadowPackageDiagnostic[];
}

export interface StreamingAssetRuntimeDataset {
  assetStreamingMode?: string;
  assetStreamingChannel?: string;
  assetStreamingManifest?: string;
  assetStreamingManifestState?: string;
  assetStreamingBackgroundScheduled?: string;
  assetStreamingBackgroundRunning?: string;
  assetStreamingFeatureStageVerified?: string;
  assetStreamingRetainedPayloadBytes?: string;
  assetStreamingPeakOperationPayloadBytes?: string;
  assetStreamingLastError?: string;
}

export interface StreamingAssetRuntimePort {
  scheduleFeatureShadowPrefetch(): boolean;
  /**
   * 可选是为了兼容旧宿主；生产 StreamingAssetRuntime 在 on-demand/shadow 模式下
   * 始终提供经过清单大小与 SHA-256 校验的消费者租约。
   */
  acquirePackage?(
    id: string,
    signal?: AbortSignal,
  ): Promise<AcquiredAssetPackage>;
  diagnostics(): StreamingAssetRuntimeDiagnostics;
  destroy(): void;
}

/** 消费者所有权扩展；永远不能成为权威功能、结果或金额决策输入。 */
export interface StreamingAssetConsumerPort {
  acquirePackage(id: string, signal?: AbortSignal): Promise<AcquiredAssetPackage>;
  acquireStage(stage: AssetPackageStage, signal?: AbortSignal): Promise<AcquiredAssetPackageStage>;
}

export interface StreamingAssetRuntimeEnvironment {
  readonly VITE_ASSET_STREAMING_MODE?: string;
}

export interface StreamingAssetRuntimeOptions {
  readonly channel: PrimalRuntimeAssetChannel;
  readonly mode?: AssetStreamingMode | string;
  readonly fetch?: typeof fetch;
  readonly manifestUrl?: string;
  /** 一个串行影子操作或真实消费者租约允许保留的已验证响应字节。 */
  readonly maxOperationPayloadBytes?: number;
  readonly managerOptions?: Omit<
    StreamingAssetPackageManagerOptions,
    "fetch" | "concurrency" | "onProgress"
  >;
  readonly scheduleIdle?: (callback: () => void) => number;
  readonly cancelIdle?: (handle: number) => void;
  readonly onDiagnostics?: (
    diagnostics: StreamingAssetRuntimeDiagnostics,
  ) => void;
}

const DEFAULT_MAX_OPERATION_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * 未显式配置时启用真实事件租约；未知构建值仍故障关闭为 off。shadow 保留
 * 启动后全功能包校验，而 on-demand 只在真实消费事件发生后取包。
 */
export function assetStreamingMode(value: unknown): AssetStreamingMode {
  if (value === undefined || value === "") return "on-demand";
  if (value === "on-demand" || value === "shadow") return value;
  return "off";
}

export function streamingFeaturePackageId(
  channel: PrimalRuntimeAssetChannel,
  feature: "big-win" | "free-spins" | "wheel",
): string {
  return `${channel}-feature-${feature}`;
}

export interface StreamingAssetEventLease {
  readonly signal: AbortSignal;
  readonly ready: Promise<AcquiredAssetPackage>;
  readonly released: boolean;
  /** 幂等；取消尚未完成的获取，并释放已经采用的包引用。 */
  release(): boolean;
}

/**
 * 将消费者包租约绑定到单次功能事件。状态只由调用者动作驱动，不读取玩法或服务端
 * 结果；先 release 后晚到的错误实现也无法泄漏底层包引用。
 */
export function beginStreamingAssetEventLease(
  consumer: Pick<StreamingAssetConsumerPort, "acquirePackage">,
  packageId: string,
): StreamingAssetEventLease {
  const controller = new AbortController();
  let acquired: AcquiredAssetPackage | null = null;
  let released = false;
  let eventLease!: StreamingAssetEventLease;
  let acquisition: Promise<AcquiredAssetPackage>;
  try {
    // 调用本身必须发生在权威结果进入对应表现状态之前；底层网络/校验仍异步，
    // 同步异常则转换为同一个 ready 拒绝边界。
    acquisition = Promise.resolve(consumer.acquirePackage(packageId, controller.signal));
  } catch (error) {
    acquisition = Promise.reject(error);
  }
  const ready = acquisition
    .then((lease) => {
      if (released) {
        lease.release();
        throw new AssetPackageAbortedError("Feature asset event lease was released");
      }
      acquired = lease;
      return lease;
    });
  // 事件可能先进入制作好的 lead-in；立即登记拒绝观察者，避免弱网失败在正式
  // await 边界前形成 unhandledrejection。调用方随后 await ready 仍会收到原错误。
  void ready.catch(() => undefined);
  eventLease = Object.freeze({
    signal: controller.signal,
    ready,
    get released() {
      return released;
    },
    release(): boolean {
      if (released) return false;
      released = true;
      controller.abort(new AssetPackageAbortedError("Feature asset event lease was released"));
      const lease = acquired;
      acquired = null;
      if (lease) lease.release();
      else void ready.then((lateLease) => lateLease.release(), () => undefined);
      return true;
    },
  });
  return eventLease;
}

export function streamingPackageManifestUrl(
  channel: PrimalRuntimeAssetChannel,
): string {
  return publicAssetUrl(
    `assets/primal-runtime/streaming-packages.${channel}.json`,
  );
}

export function createStreamingAssetRuntime(
  channel: PrimalRuntimeAssetChannel,
  env: StreamingAssetRuntimeEnvironment = import.meta.env,
  onDiagnostics?: (diagnostics: StreamingAssetRuntimeDiagnostics) => void,
): StreamingAssetRuntime {
  return new StreamingAssetRuntime({
    channel,
    mode: assetStreamingMode(env.VITE_ASSET_STREAMING_MODE),
    onDiagnostics,
  });
}

/** 只发布有界 DOM 遥测；禁止暴露文件名、原始字节、凭据或个人信息。 */
export function publishStreamingAssetDiagnostics(
  root: Pick<HTMLElement, "dataset">,
  diagnostics: Readonly<StreamingAssetRuntimeDiagnostics>,
): void {
  const dataset = root.dataset as StreamingAssetRuntimeDataset;
  dataset.assetStreamingMode = diagnostics.mode;
  dataset.assetStreamingChannel = diagnostics.channel;
  dataset.assetStreamingManifest = diagnostics.manifestUrl;
  dataset.assetStreamingManifestState = diagnostics.manifestState;
  dataset.assetStreamingBackgroundScheduled = String(
    diagnostics.backgroundScheduled,
  );
  dataset.assetStreamingBackgroundRunning = String(
    diagnostics.backgroundRunning,
  );
  dataset.assetStreamingFeatureStageVerified = String(
    diagnostics.featureStageVerified,
  );
  dataset.assetStreamingRetainedPayloadBytes = String(
    diagnostics.retainedPayloadBytes,
  );
  dataset.assetStreamingPeakOperationPayloadBytes = String(
    diagnostics.peakOperationPayloadBytes,
  );
  if (diagnostics.lastError)
    dataset.assetStreamingLastError = diagnostics.lastError.slice(0, 256);
  else delete dataset.assetStreamingLastError;
}

/**
 * 流式资源运行时。shadow 操作只保留诊断；on-demand 消费者可在有界租约内把
 * 已校验负载交给 Pixi。两种模式都不能参与权威功能、结果或金额决策。
 */
export class StreamingAssetRuntime implements StreamingAssetRuntimePort {
  private readonly channel: PrimalRuntimeAssetChannel;
  private readonly mode: AssetStreamingMode;
  private readonly fetcher: typeof fetch;
  private readonly manifestUrl: string;
  private readonly maxOperationPayloadBytes: number;
  private readonly managerOptions: StreamingAssetRuntimeOptions["managerOptions"];
  private readonly scheduleIdle: (callback: () => void) => number;
  private readonly cancelIdle: (handle: number) => void;
  private readonly onDiagnostics: (
    diagnostics: StreamingAssetRuntimeDiagnostics,
  ) => void;
  private readonly lifetime = new AbortController();
  private readonly packageDiagnostics = new Map<
    string,
    ShadowPackageDiagnostic
  >();
  private manifest: AssetPackageManifest | null = null;
  private manifestPromise: Promise<AssetPackageManifest> | null = null;
  private manifestState: StreamingManifestState;
  private manifestError: string | null = null;
  private backgroundScheduled = false;
  private backgroundRunning = false;
  private backgroundHandle: number | null = null;
  private backgroundPromise: Promise<void> = Promise.resolve();
  private operationTail: Promise<void> = Promise.resolve();
  private peakOperationPayloadBytes = 0;
  private consumerManager: StreamingAssetPackageManager | null = null;
  private consumerManagerPromise: Promise<StreamingAssetPackageManager> | null = null;
  private readonly activeConsumerLeases = new Set<{
    release(): boolean;
  }>();
  private destroyed = false;

  constructor(options: StreamingAssetRuntimeOptions) {
    this.channel = options.channel;
    this.mode = assetStreamingMode(options.mode);
    this.fetcher = options.fetch ?? defaultStreamingAssetFetch();
    this.manifestUrl =
      options.manifestUrl ?? streamingPackageManifestUrl(options.channel);
    this.maxOperationPayloadBytes = positiveInteger(
      options.maxOperationPayloadBytes ?? DEFAULT_MAX_OPERATION_PAYLOAD_BYTES,
      "maxOperationPayloadBytes",
    );
    this.managerOptions = options.managerOptions;
    this.scheduleIdle = options.scheduleIdle ?? defaultScheduleIdle;
    this.cancelIdle = options.cancelIdle ?? defaultCancelIdle;
    this.onDiagnostics = options.onDiagnostics ?? (() => undefined);
    this.manifestState = this.mode === "off" ? "off" : "unrequested";
  }

  async validateManifest(signal?: AbortSignal): Promise<AssetPackageManifest> {
    this.assertUsable();
    if (this.mode === "off")
      throw new Error("Asset streaming mode is disabled");
    if (this.manifest) return this.manifest;
    if (this.manifestPromise)
      return this.awaitWithCallerAbort(this.manifestPromise, signal);

    const operation = this.linkOperation();
    const generationSignal = operation.controller.signal;
    this.manifestState = "loading";
    this.manifestError = null;
    this.publish();
    const pending = this.fetchManifest(generationSignal)
      .then((manifest) => {
        this.throwIfInactive(generationSignal);
        this.manifest = manifest;
        this.manifestState = "validated";
        this.seedPackageDiagnostics(manifest);
        this.publish();
        return manifest;
      })
      .catch((cause: unknown) => {
        const error = normalizeError(cause, generationSignal);
        if (!this.destroyed) {
          this.manifestState = isAbortError(error) ? "unrequested" : "failed";
          this.manifestError = isAbortError(error) ? null : error.message;
          this.publish();
        }
        throw error;
      })
      .finally(() => {
        operation.unlink();
        if (this.manifestPromise === pending) this.manifestPromise = null;
      });
    this.manifestPromise = pending;
    return this.awaitWithCallerAbort(pending, signal);
  }

  preloadPackage(
    id: string,
    signal?: AbortSignal,
  ): Promise<readonly ShadowPackageDiagnostic[]> {
    return this.enqueue(async () => {
      const manifest = await this.validateManifest(signal);
      const target = manifest.packages.find((entry) => entry.id === id);
      if (!target) throw new Error(`Unknown asset package "${id}"`);
      return this.verifyTargets(manifest, [id], signal);
    });
  }

  preloadStage(
    stage: AssetPackageStage,
    signal?: AbortSignal,
  ): Promise<readonly ShadowPackageDiagnostic[]> {
    return this.enqueue(async () => {
      const manifest = await this.validateManifest(signal);
      const ids = manifest.packages
        .filter((entry) => entry.stage === stage)
        .map((entry) => entry.id);
      if (ids.length === 0)
        throw new Error(`Asset package stage "${stage}" is empty`);
      return this.verifyTargets(manifest, ids, signal);
    });
  }

  /** Big Win 等真实功能事件使用的大小/SHA-256 已验证消费者所有权 API。 */
  async acquirePackage(
    id: string,
    signal?: AbortSignal,
  ): Promise<AcquiredAssetPackage> {
    return this.acquireConsumerLease(
      signal,
      (manager, operationSignal) => manager.acquire(id, {
        signal: operationSignal,
      }),
      (lease) => this.wrapPackageLease(lease),
    );
  }

  /** 原子阶段所有权 API；shadow 诊断与未来整阶段消费者参见 acquirePackage()。 */
  async acquireStage(
    stage: AssetPackageStage,
    signal?: AbortSignal,
  ): Promise<AcquiredAssetPackageStage> {
    return this.acquireConsumerLease(
      signal,
      (manager, operationSignal) => manager.acquireStage(stage, {
        signal: operationSignal,
      }),
      (lease) => this.wrapStageLease(lease),
    );
  }

  scheduleFeatureShadowPrefetch(): boolean {
    if (this.mode !== "shadow" || this.destroyed || this.backgroundScheduled)
      return false;
    this.backgroundScheduled = true;
    this.publish();
    this.backgroundHandle = this.scheduleIdle(() => {
      this.backgroundHandle = null;
      if (this.destroyed) return;
      this.backgroundRunning = true;
      this.publish();
      // 在公开承诺之前同步解析，以便测试和主机可以从空闲回调边界加入实际操作。
      this.backgroundPromise = this.preloadStage("feature-on-demand")
        .then(() => undefined)
        .catch((cause: unknown) => {
          if (this.destroyed || isAbortError(cause)) return;
          this.manifestError = normalizeError(cause).message;
          this.publish();
        })
        .finally(() => {
          if (this.destroyed) return;
          this.backgroundRunning = false;
          this.publish();
        });
    });
    return true;
  }

  /** 用于观察故障开放后台操作的测试/主机接口。 */
  whenBackgroundSettled(): Promise<void> {
    return this.backgroundPromise;
  }

  diagnostics(): StreamingAssetRuntimeDiagnostics {
    const featurePackages = [...this.packageDiagnostics.values()].filter(
      (entry) => entry.stage === "feature-on-demand",
    );
    return Object.freeze({
      mode: this.mode,
      channel: this.channel,
      manifestUrl: this.manifestUrl,
      manifestState: this.manifestState,
      backgroundScheduled: this.backgroundScheduled,
      backgroundRunning: this.backgroundRunning,
      featureStageVerified:
        featurePackages.length > 0 &&
        featurePackages.every((entry) => entry.state === "verified"),
      // 仅当运行时拥有的租约有效时才会保留实验性消费者有效负载。浏览器缓存所有权位于 JS 堆合约之外。
      retainedPayloadBytes: this.consumerManager?.retainedPayloadBytes() ?? 0,
      peakOperationPayloadBytes: this.peakOperationPayloadBytes,
      lastError: this.manifestError,
      packages: Object.freeze(
        [...this.packageDiagnostics.values()].map((entry) =>
          Object.freeze({ ...entry }),
        ),
      ),
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.backgroundHandle !== null) this.cancelIdle(this.backgroundHandle);
    this.backgroundHandle = null;
    this.backgroundScheduled = false;
    this.backgroundRunning = false;
    this.lifetime.abort(
      new AssetPackageAbortedError("Streaming asset runtime was destroyed"),
    );
    for (const lease of [...this.activeConsumerLeases]) {
      try {
        lease.release();
      } catch {
        // 一个格式错误的消费者无法阻止同级租约在运行时生命周期边界丢弃其解码的有效负载。
      }
    }
    this.activeConsumerLeases.clear();
    this.manifest = null;
    this.manifestPromise = null;
    this.packageDiagnostics.clear();
    this.consumerManager = null;
    this.consumerManagerPromise = null;
    this.manifestState = "destroyed";
    this.manifestError = null;
    // 故意不要在这里发布：被销毁的所有者没有有效的 DOM 或遥测接收器，并且此生命周期禁止延迟回调。
  }

  private async acquireConsumerLease<
    TUnderlying extends { release(): boolean },
    TWrapped extends { release(): boolean },
  >(
    callerSignal: AbortSignal | undefined,
    acquire: (
      manager: StreamingAssetPackageManager,
      operationSignal: AbortSignal,
    ) => Promise<TUnderlying>,
    wrap: (lease: TUnderlying) => TWrapped,
  ): Promise<TWrapped> {
    const operation = this.linkOperation(callerSignal);
    const signal = operation.controller.signal;
    let underlying: TUnderlying | null = null;
    let wrapped: TWrapped | null = null;
    try {
      this.throwIfInactive(signal);
      const manager = await this.consumerPackageManager(signal);
      this.throwIfInactive(signal);
      underlying = await acquire(manager, signal);
      this.throwIfInactive(signal);
      wrapped = wrap(underlying);
      underlying = null;
      // 即使管理器获取与运行时或调用者取消同时解决，也要捍卫完成/采用边界。
      this.throwIfInactive(signal);
      return wrapped;
    } catch (cause: unknown) {
      if (wrapped) wrapped.release();
      else underlying?.release();
      throw normalizeError(cause, signal);
    } finally {
      operation.unlink();
    }
  }

  private wrapPackageLease(
    underlyingLease: AcquiredAssetPackage,
  ): AcquiredAssetPackage {
    let underlying: AcquiredAssetPackage | null = underlyingLease;
    const registry = this.activeConsumerLeases;
    const publish = (): void => this.publish();
    const id = underlyingLease.id;
    const packageIds = Object.freeze([...underlyingLease.packageIds]);
    let wrapper!: AcquiredAssetPackage;
    wrapper = Object.freeze({
      id,
      get package() {
        const lease = underlying;
        if (!lease) throw new Error(`Asset package lease "${id}" was released`);
        return lease.package;
      },
      packageIds,
      get released() {
        return underlying === null;
      },
      release(): boolean {
        const lease = underlying;
        if (!lease) return false;
        underlying = null;
        registry.delete(wrapper);
        const released = lease.release();
        publish();
        return released;
      },
    });
    registry.add(wrapper);
    publish();
    return wrapper;
  }

  private wrapStageLease(
    underlyingLease: AcquiredAssetPackageStage,
  ): AcquiredAssetPackageStage {
    let underlying: AcquiredAssetPackageStage | null = underlyingLease;
    const registry = this.activeConsumerLeases;
    const publish = (): void => this.publish();
    const stage = underlyingLease.stage;
    const packageIds = Object.freeze([...underlyingLease.packageIds]);
    let wrapper!: AcquiredAssetPackageStage;
    wrapper = Object.freeze({
      stage,
      packageIds,
      get packages() {
        const lease = underlying;
        if (!lease) throw new Error(`Asset package stage lease "${stage}" was released`);
        return lease.packages;
      },
      get released() {
        return underlying === null;
      },
      release(): boolean {
        const lease = underlying;
        if (!lease) return false;
        underlying = null;
        registry.delete(wrapper);
        const released = lease.release();
        publish();
        return released;
      },
    });
    registry.add(wrapper);
    publish();
    return wrapper;
  }

  private async fetchManifest(
    signal: AbortSignal,
  ): Promise<AssetPackageManifest> {
    const response = await this.fetcher(this.manifestUrl, {
      signal,
      credentials: "same-origin",
      cache: "no-cache",
    });
    this.throwIfInactive(signal);
    if (!response.ok) {
      const error = new Error(
        `Failed to load streaming manifest: HTTP ${response.status}`,
      );
      cancelNetworkResponse(response, error);
      throw error;
    }
    const text = await readBoundedResponseText(response, {
      label: "Streaming manifest",
      maxBytes: NETWORK_RESPONSE_LIMITS.streamingManifestBytes,
      signal,
    });
    this.throwIfInactive(signal);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new Error("Streaming manifest is not valid JSON", { cause });
    }
    const validated = validateAssetPackageManifest(
      parsed as AssetPackageManifest,
    ).manifest;
    const expectedAssetSet = `primal-rampage-runtime:${this.channel}`;
    if (validated.assetSet !== expectedAssetSet) {
      throw new Error(
        `Streaming manifest channel mismatch: expected ${expectedAssetSet}, received ${validated.assetSet}`,
      );
    }
    return validated;
  }

  private async consumerPackageManager(
    signal?: AbortSignal,
  ): Promise<StreamingAssetPackageManager> {
    this.assertUsable();
    if (this.mode === "off") {
      throw new Error("Asset streaming mode is disabled");
    }
    if (this.consumerManager) return this.consumerManager;
    if (this.consumerManagerPromise) {
      return this.awaitWithCallerAbort(this.consumerManagerPromise, signal);
    }
    const pending = this.validateManifest()
      .then((manifest) => {
        this.assertUsable();
        const manager = new StreamingAssetPackageManager(manifest, {
          ...this.managerOptions,
          fetch: this.fetcher,
          concurrency: 1,
          maxRetainedBytes: this.maxOperationPayloadBytes,
          onProgress: (progress) => this.observeConsumerProgress(progress),
        });
        this.consumerManager = manager;
        return manager;
      })
      .finally(() => {
        if (this.consumerManagerPromise === pending) {
          this.consumerManagerPromise = null;
        }
      });
    this.consumerManagerPromise = pending;
    return this.awaitWithCallerAbort(pending, signal);
  }

  private observeConsumerProgress(
    progress: Readonly<AssetPackageSnapshot>,
  ): void {
    if (this.destroyed) return;
    const current = this.packageDiagnostics.get(progress.id);
    if (!current) return;
    const state: ShadowPackageState = progress.state === "ready"
      ? "verified"
      : progress.state === "failed"
        ? "failed"
        : progress.state === "cancelled"
          ? "cancelled"
          : "loading";
    const error = state === "failed" ? progress.error?.message ?? "Asset package failed" : null;
    this.updatePackage(progress.id, state, progress.progress, error);
    if (state === "verified") {
      this.peakOperationPayloadBytes = Math.max(
        this.peakOperationPayloadBytes,
        this.consumerManager?.retainedPayloadBytes() ?? 0,
      );
    }
  }

  private async verifyTargets(
    manifest: AssetPackageManifest,
    targetIds: readonly string[],
    callerSignal?: AbortSignal,
  ): Promise<readonly ShadowPackageDiagnostic[]> {
    this.assertUsable();
    const operation = this.linkOperation(callerSignal);
    const signal = operation.controller.signal;
    const closure = dependencyClosure(manifest, targetIds);
    const operationBytes = closure.reduce(
      (total, entry) =>
        total +
        entry.resources.reduce((sum, resource) => sum + resource.bytes, 0),
      0,
    );
    if (operationBytes > this.maxOperationPayloadBytes) {
      operation.unlink();
      const error = new Error(
        `Shadow asset operation requires ${operationBytes} bytes; limit is ${this.maxOperationPayloadBytes}`,
      );
      this.markTargets(targetIds, "failed", 0, error.message);
      throw error;
    }
    this.peakOperationPayloadBytes = Math.max(
      this.peakOperationPayloadBytes,
      operationBytes,
    );
    this.markTargets(targetIds, "loading", 0, null);

    // 一个网络/解码通道可在低内存手机上保持瞬态响应、摘要复制和 JSON 解析开销。最后这个管理者被抛弃了；它的字节图永远不会交给渲染器/音频消费者。
    let manager: StreamingAssetPackageManager | null =
      new StreamingAssetPackageManager(manifest, {
        ...this.managerOptions,
        fetch: this.fetcher,
        concurrency: 1,
        onProgress: (progress) => this.observeManagerProgress(progress, signal),
      });
    try {
      for (const id of targetIds) {
        this.throwIfInactive(signal);
        await manager.load(id, { signal });
        this.throwIfInactive(signal);
        this.updatePackage(id, "verified", 1, null);
      }
      return Object.freeze(
        targetIds.map((id) =>
          Object.freeze({
            ...this.requirePackageDiagnostic(id),
          }),
        ),
      );
    } catch (cause: unknown) {
      const error = normalizeError(cause, signal);
      const state: ShadowPackageState = isAbortError(error)
        ? "cancelled"
        : "failed";
      for (const id of targetIds) {
        if (this.packageDiagnostics.get(id)?.state !== "verified") {
          this.updatePackage(
            id,
            state,
            0,
            isAbortError(error) ? null : error.message,
          );
        }
      }
      throw error;
    } finally {
      operation.unlink();
      // 显式破坏 LoadedAssetPackage 字节和解码图的唯一强所有者。未制作 Spine、纹理、过滤器或音频实例。
      manager = null;
    }
  }

  private observeManagerProgress(
    progress: Readonly<AssetPackageSnapshot>,
    signal: AbortSignal,
  ): void {
    if (this.destroyed || signal.aborted) return;
    const current = this.packageDiagnostics.get(progress.id);
    if (!current) return;
    const bounded = Math.min(progress.progress, 1 - 1e-6);
    this.updatePackage(
      progress.id,
      "loading",
      Math.max(current.progress, bounded),
      null,
    );
  }

  private seedPackageDiagnostics(manifest: AssetPackageManifest): void {
    for (const entry of manifest.packages) {
      if (this.packageDiagnostics.has(entry.id)) continue;
      this.packageDiagnostics.set(
        entry.id,
        Object.freeze({
          id: entry.id,
          stage: entry.stage,
          state: "unrequested",
          progress: 0,
          error: null,
        }),
      );
    }
  }

  private markTargets(
    ids: readonly string[],
    state: ShadowPackageState,
    progress: number,
    error: string | null,
  ): void {
    for (const id of ids) this.updatePackage(id, state, progress, error);
  }

  private updatePackage(
    id: string,
    state: ShadowPackageState,
    progress: number,
    error: string | null,
  ): void {
    if (this.destroyed) return;
    const current = this.requirePackageDiagnostic(id);
    this.packageDiagnostics.set(
      id,
      Object.freeze({
        ...current,
        state,
        progress: state === "verified" ? 1 : Math.min(progress, 1 - 1e-6),
        error,
      }),
    );
    this.publish();
  }

  private requirePackageDiagnostic(id: string): ShadowPackageDiagnostic {
    const diagnostic = this.packageDiagnostics.get(id);
    if (!diagnostic)
      throw new Error(`Unknown asset package diagnostic "${id}"`);
    return diagnostic;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private linkOperation(callerSignal?: AbortSignal): {
    readonly controller: AbortController;
    readonly unlink: () => void;
  } {
    const controller = new AbortController();
    const sources = [this.lifetime.signal, callerSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const abort = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    const listeners = sources.map((source) => {
      const listener = (): void => abort(source);
      if (source.aborted) listener();
      else source.addEventListener("abort", listener, { once: true });
      return { source, listener };
    });
    return {
      controller,
      unlink: () => {
        for (const { source, listener } of listeners) {
          source.removeEventListener("abort", listener);
        }
      },
    };
  }

  private async awaitWithCallerAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) throw normalizeError(signal.reason, signal);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => finish(() => reject(normalizeError(signal.reason, signal)));
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private assertUsable(): void {
    if (this.destroyed)
      throw new AssetPackageAbortedError(
        "Streaming asset runtime was destroyed",
      );
  }

  private throwIfInactive(signal: AbortSignal): void {
    if (this.destroyed || signal.aborted)
      throw normalizeError(signal.reason, signal);
  }

  private publish(): void {
    if (this.destroyed) return;
    try {
      this.onDiagnostics(this.diagnostics());
    } catch {
      // 诊断仅是观察。损坏的 DOM/遥测接收器不能失败、取消或重新安排完整性影子工作。
    }
  }
}

function dependencyClosure(
  manifest: AssetPackageManifest,
  targetIds: readonly string[],
): readonly AssetPackageManifest["packages"][number][] {
  const byId = new Map(manifest.packages.map((entry) => [entry.id, entry]));
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const entry = byId.get(id);
    if (!entry) throw new Error(`Unknown asset package "${id}"`);
    for (const dependency of entry.dependsOn ?? []) visit(dependency);
    selected.add(id);
  };
  for (const id of targetIds) visit(id);
  return Object.freeze(
    manifest.packages.filter((entry) => selected.has(entry.id)),
  );
}

function defaultScheduleIdle(callback: () => void): number {
  const idle = (
    globalThis as typeof globalThis & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
    }
  ).requestIdleCallback;
  if (idle) return idle(callback, { timeout: 2_000 });
  return globalThis.setTimeout(callback, 32) as unknown as number;
}

function defaultCancelIdle(handle: number): void {
  const cancel = (
    globalThis as typeof globalThis & {
      cancelIdleCallback?: (handle: number) => void;
    }
  ).cancelIdleCallback;
  if (cancel) cancel(handle);
  else globalThis.clearTimeout(handle);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeError(cause: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) {
    const detail =
      signal.reason instanceof Error ? `: ${signal.reason.message}` : "";
    return new AssetPackageAbortedError(
      `Streaming asset operation was aborted${detail}`,
    );
  }
  return cause instanceof Error ? cause : new Error(String(cause));
}

function isAbortError(cause: unknown): boolean {
  return (
    cause instanceof AssetPackageAbortedError ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}
