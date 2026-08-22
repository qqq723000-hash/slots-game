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
    // 引导程序已先清除地址栏；此不透明 URL 只在网关同步接管一次性值时使用。
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

  let app: AppController | null = null;
  let disposed = false;
  const assemblyController = new AbortController();

  if (configuredGateway) {
    const launchGateway = configuredGateway;
    try {
      startStartupPerformanceMonitor(root);
      configurePixiContentSecurityPolicy();
      applicationRoot.dataset.pixiCspMode = "static-uniform-sync";
      configurePixiTextMetricsReadbackCanvas();
      // 首个加载画面由 HTML 外壳负责。先跨过两个绘制帧，确保蓝色加载页真实上屏，
      // 再开始 WebGL 和场景构造，避免首帧被同步初始化吞掉而出现白屏或明显卡顿。
      void waitForPaintedFrame().then(async () => {
        if (disposed) return;
        const { AppController: ApplicationController } = await import("./app/AppController");
        if (disposed) return;
        root.dataset.startupShell = "painted";
        app = await ApplicationController.create(root, { gateway: launchGateway }, {
          signal: assemblyController.signal,
        });
        if (disposed) {
          app.destroy();
          app = null;
          return;
        }
        app.start();
      }).catch((error: unknown) => failConfiguredLaunch(error, launchGateway));
    } catch (error) {
      failConfiguredLaunch(error, launchGateway);
    }
  }

  function failConfiguredLaunch(error: unknown, launchGateway: GameGateway): void {
    if (disposed || assemblyController.signal.aborted) return;
    app?.destroy();
    app = null;
    launchGateway.close();
    presentStartupFailure(
      error,
      false,
      launchGateway.operatorHostOrigin,
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
    // 入口装配失败同样是玩家表面：异常文本可能来自网络、资源或宿主，不能直出。
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
  ): void {
    const request = Object.freeze({
      reason: "initial-session-failed",
      code: PLAYER_FACING_ERROR_CODES.OPERATOR_SESSION_REQUIRED,
      ...(publicError.correlationId ? { correlationId: publicError.correlationId } : {}),
    } satisfies OperatorSessionRequest);
    notifyOperatorSessionRequired(window, request, operatorHostOrigin);
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      disposed = true;
      finishStartupPerformanceMonitor(root);
      assemblyController.abort(new Error("Application module was disposed"));
      app?.destroy();
      if (!app) configuredGateway?.close();
    });
  }
}
