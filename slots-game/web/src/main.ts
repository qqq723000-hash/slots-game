import type { AppController } from "./app/AppController";
import {
  PLAYER_FACING_ERROR_CODES,
  playerFacingErrorFor,
  type OperatorSessionRequest,
  type PlayerFacingError,
} from "./app/playerFacingError";
import {
  isWindowFramed,
  notifyOperatorSessionRequired,
  parseExactHttpsHostOrigin,
} from "./app/operatorSessionBridge";
import type { GameGateway } from "./protocol/GameGateway";
import { RgsGatewayConfigurationError } from "./protocol/RgsGateway";
import {
  createConfiguredGameGateway,
  optionalWindowSessionStorage,
} from "./protocol/configuredGateway";
import { configurePixiTextMetricsReadbackCanvas } from "./renderer/configurePixiTextMetricsReadbackCanvas";
import { configurePixiContentSecurityPolicy } from "./startup/configurePixiContentSecurityPolicy";
import { waitForPaintedFrame } from "./startup/frameSlicedInitialization";
import {
  finishStartupPerformanceMonitor,
  startStartupPerformanceMonitor,
} from "./startup/startupPerformanceMonitor";

export function startApplication(launchPageUrl: string): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("Application root is missing");
  const applicationRoot = root;

  let configuredGateway: GameGateway | null = null;
  try {
    // 引导程序已先清除地址栏；此不透明 URL 只在网关同步接管一次性值时使用。 / English: Bootstrap has cleared the address bar first; this opaque URL is only used when the gateway synchronizes to take over the one-time value.
    configuredGateway = createConfiguredGameGateway({
      env: import.meta.env,
      pageUrl: launchPageUrl,
      history: window.history,
      isFramed: isWindowFramed(window),
      sessionStorage: optionalWindowSessionStorage(window),
    });
  } catch (error) {
    presentStartupFailure(
      error,
      error instanceof RgsGatewayConfigurationError,
      configuredOperatorHostOrigin(),
    );
  }
  // 配置/恢复存储在任何网络或渲染工作前失败时，页面已是终态。不要为一个没有 / English: When configure/restore storage fails before any network or rendering work, the page is already in a final state. Don't worry about someone who doesn't have one
  // 网关的失败页注册全局监听器，也不要保留后续装配闭包。 / English: The gateway's failure page registers a global listener and does not retain subsequent assembly closures.
  if (!configuredGateway) return;

  let app: AppController | null = null;
  let disposed = false;
  let runtimeFailureBoundaryArmed = false;
  let runtimeFailureHandled = false;
  const assemblyController = new AbortController();

  function bestEffortMainLifecycle(action: () => void): void {
    try {
      action();
    } catch {
      // 全局故障边界和拆卸路径必须保持不抛错；任一宿主/DOM 清理失败不拥有后续步骤。 / English: Global fault boundaries and teardown paths must remain error-free; any host/DOM cleanup failure has no follow-up steps.
    }
  }

  function runtimeAvailability(visible = document.visibilityState !== "hidden") {
    return Object.freeze({
      online: window.navigator.onLine !== false,
      visible,
    });
  }

  function syncRuntimeAvailability(): void {
    configuredGateway?.setRuntimeAvailability?.(runtimeAvailability());
  }

  function handlePageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      // BFCache 会冻结本页；不销毁一次性会话，只暂停非关键轮询，pageshow 再续跑。 / English: BFCache will freeze this page; it will not destroy the one-time session, only pause non-critical polling, and pageshow will continue running.
      configuredGateway?.setRuntimeAvailability?.(runtimeAvailability(false));
      return;
    }
    disposeApplication("Application page was unloaded");
  }

  function handlePageShow(): void {
    syncRuntimeAvailability();
  }

  function disposeApplication(reason: string): void {
    if (disposed) return;
    disposed = true;
    runtimeFailureBoundaryArmed = false;
    bestEffortMainLifecycle(() => window.removeEventListener("online", syncRuntimeAvailability));
    bestEffortMainLifecycle(() => window.removeEventListener("offline", syncRuntimeAvailability));
    bestEffortMainLifecycle(() => window.removeEventListener("pageshow", handlePageShow));
    bestEffortMainLifecycle(() => window.removeEventListener("pagehide", handlePageHide));
    bestEffortMainLifecycle(() => window.removeEventListener("error", handleWindowError));
    bestEffortMainLifecycle(() => (
      window.removeEventListener("unhandledrejection", handleUnhandledRejection)
    ));
    bestEffortMainLifecycle(() => (
      document.removeEventListener("visibilitychange", syncRuntimeAvailability)
    ));
    bestEffortMainLifecycle(() => finishStartupPerformanceMonitor(applicationRoot));
    bestEffortMainLifecycle(() => assemblyController.abort(new Error(reason)));

    // 先转移引用，避免 destroy/close 内部回调重入后重新取得仍存活的经济或渲染所有者。 / English: Transfer the reference first to avoid re-acquiring the surviving economy or rendering owner after the destroy/close internal callback re-enters.
    const ownedApp = app;
    const ownedGateway = configuredGateway;
    app = null;
    configuredGateway = null;
    bestEffortMainLifecycle(() => ownedApp?.destroy());
    // AppController.destroy() 已关闭网关；幂等 close 兜住中途装配或拆卸异常。 / English: AppController.destroy() has closed the gateway; idempotent close will catch exceptions during assembly or disassembly.
    // RgsGateway.close() 只释放内存所有权，不会清除 sessionStorage 中的 pending ledger。 / English: RgsGateway.close() only releases memory ownership and does not clear the pending ledger in sessionStorage.
    bestEffortMainLifecycle(() => ownedGateway?.close());
  }

  function handleWindowError(event: ErrorEvent): void {
    handleRuntimeFailure(event);
  }

  function handleUnhandledRejection(event: PromiseRejectionEvent): void {
    handleRuntimeFailure(event);
  }

  /**
   * 生产运行期最后一道故障关闭边界。它刻意不读取 event.error/reason/message，避免将
   * 服务端响应、URL、令牌或堆栈带入 DOM/宿主通知；旧会话只拆卸，不重提任何下注。
   *
   * 英文 / English: The last fault during the production run closes the boundary. It deliberately does not read event.error/reason/message to avoid bringing server responses, URLs, tokens or stacks into the DOM/host notifications; old sessions are only torn down without retrieving any bets.
   */
  function handleRuntimeFailure(event: Event): void {
    try {
      if (!runtimeFailureBoundaryArmed || runtimeFailureHandled || disposed) return;
      runtimeFailureHandled = true;
      bestEffortMainLifecycle(() => event.preventDefault());
      let operatorHostOrigin: string | null = null;
      bestEffortMainLifecycle(() => {
        operatorHostOrigin = configuredGateway?.operatorHostOrigin ?? null;
      });
      disposeApplication("Application runtime failed");
      presentRuntimeFailure(operatorHostOrigin);
    } catch {
      // 故障边界本身绝不能成为第二个未处理异常或重新启动旧会话。 / English: The fault boundary itself must not become a second unhandled exception or restart an old session.
    }
  }

  function presentRuntimeFailure(operatorHostOrigin?: string | null): void {
    const publicError = playerFacingErrorFor(undefined, "initial-rgs-session");
    bestEffortMainLifecycle(() => {
      applicationRoot.dataset.runtimeFailure = "operator-session-required";
      const loading = applicationRoot.querySelector<HTMLElement>('[data-role="launch-loading"]');
      if (!loading) return;
      loading.dataset.visible = "true";
      loading.dataset.stage = "runtime-failed";
      loading.setAttribute("aria-hidden", "false");
      loading.removeAttribute("inert");
      const status = loading.querySelector<HTMLElement>(".launch-loading__status");
      if (status) status.textContent = publicError.message;
    });
    bestEffortMainLifecycle(() => requestFreshOperatorSession(
      publicError,
      operatorHostOrigin,
      "committed-result-recovery-required",
    ));
  }

  window.addEventListener("online", syncRuntimeAvailability);
  window.addEventListener("offline", syncRuntimeAvailability);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("error", handleWindowError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);
  document.addEventListener("visibilitychange", syncRuntimeAvailability);
  syncRuntimeAvailability();

  if (configuredGateway) {
    const launchGateway = configuredGateway;
    try {
      startStartupPerformanceMonitor(root);
      configurePixiContentSecurityPolicy();
      applicationRoot.dataset.pixiCspMode = "static-uniform-sync";
      configurePixiTextMetricsReadbackCanvas();
      // 首个加载画面由 HTML 外壳负责。先跨过两个绘制帧，确保蓝色加载页真实上屏， / English: The first loading screen is taken care of by the HTML shell. First, cross two drawing frames to ensure that the blue loading page is actually on the screen.
      // 再开始 WebGL 和场景构造，避免首帧被同步初始化吞掉而出现白屏或明显卡顿。 / English: Start WebGL and scene construction again to avoid the first frame being swallowed up by synchronous initialization and causing a white screen or obvious lag.
      void waitForPaintedFrame().then(async () => {
        if (disposed) return;
        const { AppController: ApplicationController } = await import("./app/AppController");
        if (disposed) return;
        root.dataset.startupShell = "painted";
        app = await ApplicationController.create(root, { gateway: launchGateway }, {
          signal: assemblyController.signal,
        });
        if (disposed) {
          try {
            app.destroy();
          } catch {
            // 晚到的已装配视图仍属于已终止页面；拆卸异常不能重新进入失败展示路径。 / English: The late assembled view still belongs to the terminated page; the disassembly exception cannot re-enter the failed display path.
          } finally {
            app = null;
          }
          return;
        }
        app.start();
        // app.start() 的同步启动异常仍由上方 Promise catch 处理；只有成功返回后才接管 / English: The synchronous start exception of app.start() is still handled by the Promise catch above; it will only be taken over after successful return
        // 未被应用自身捕获的运行期 error/unhandledrejection。 / English: Runtime error/unhandledrejection not caught by the application itself.
        runtimeFailureBoundaryArmed = true;
      }).catch((error: unknown) => failConfiguredLaunch(error, launchGateway));
    } catch (error) {
      failConfiguredLaunch(error, launchGateway);
    }
  }

  function failConfiguredLaunch(error: unknown, launchGateway: GameGateway): void {
    if (disposed || assemblyController.signal.aborted) return;
    const operatorHostOrigin = launchGateway.operatorHostOrigin;
    disposeApplication("Application launch failed");
    presentStartupFailure(
      error,
      false,
      operatorHostOrigin,
    );
  }

  function presentStartupFailure(
    error: unknown,
    requiresOperatorSession: boolean,
    operatorHostOrigin?: string | null,
  ): void {
    finishStartupPerformanceMonitor(applicationRoot);
    applicationRoot.dataset.startupAssemblyStage = "assembly-failed";
    const loading = applicationRoot.querySelector<HTMLElement>('[data-role="launch-loading"]');
    const status = loading?.querySelector<HTMLElement>(".launch-loading__status");
    // 入口装配失败同样是玩家表面：异常文本可能来自网络、资源或宿主，不能直出。 / English: Entry assembly failure is also a player problem: the abnormal text may come from the network, resources or host, and cannot be exported directly.
    const publicError = requiresOperatorSession
      ? playerFacingErrorFor(error, "initial-rgs-session")
      : playerFacingErrorFor(error, "launch");
    if (status) status.textContent = publicError.message;
    if (requiresOperatorSession) requestFreshOperatorSession(publicError, operatorHostOrigin);
  }

  function configuredOperatorHostOrigin(): string | null {
    try {
      return parseExactHttpsHostOrigin(import.meta.env.VITE_RGS_HOST_ORIGIN);
    } catch {
      return null;
    }
  }

  function requestFreshOperatorSession(
    publicError: PlayerFacingError,
    operatorHostOrigin?: string | null,
    reason: OperatorSessionRequest["reason"] = "initial-session-failed",
  ): void {
    const request = Object.freeze({
      reason,
      code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      ...(publicError.correlationId ? { correlationId: publicError.correlationId } : {}),
    } satisfies OperatorSessionRequest);
    notifyOperatorSessionRequired(window, request, operatorHostOrigin);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      disposeApplication("Application module was disposed");
    });
  }
}
