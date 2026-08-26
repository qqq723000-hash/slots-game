import "../style.css";
import "./static-demo.css";
import { AppController } from "../app/AppController";
import { configurePixiTextMetricsReadbackCanvas } from "../renderer/configurePixiTextMetricsReadbackCanvas";
import { configurePixiContentSecurityPolicy } from "../startup/configurePixiContentSecurityPolicy";
import { waitForPaintedFrame } from "../startup/frameSlicedInitialization";
import { finishStartupPerformanceMonitor, startStartupPerformanceMonitor } from "../startup/startupPerformanceMonitor";
import { PublicStaticDemoGateway } from "./PublicStaticDemoGateway";

declare const __PRIMAL_STATIC_DEMO__: boolean;

const PUBLIC_DEMO_FAILURE = "The static demo could not start. Please reload this page.";
if (typeof __PRIMAL_STATIC_DEMO__ === "undefined"
  || __PRIMAL_STATIC_DEMO__ !== true
  || import.meta.env.MODE !== "demo") {
  throw new Error("Static demo entry requires the dedicated demo build");
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Static demo root is missing");

const assemblyController = new AbortController();
const gateway = new PublicStaticDemoGateway();
let app: AppController | null = null;
let disposed = false;

function disposeStaticDemo(): void {
  if (disposed) return;
  disposed = true;
  assemblyController.abort(new Error("Static demo page was unloaded"));
  finishStartupPerformanceMonitor(root!);
  try {
    app?.destroy();
  } catch {
    gateway.close();
  } finally {
    app = null;
  }
}

function presentStaticDemoFailure(): void {
  if (disposed) return;
  finishStartupPerformanceMonitor(root!);
  root!.dataset.staticDemoStatus = "failed";
  const loading = root!.querySelector<HTMLElement>('[data-role="launch-loading"]');
  if (loading) {
    loading.dataset.visible = "true";
    loading.dataset.stage = "demo-failed";
    loading.setAttribute("aria-hidden", "false");
  }
  const status = loading?.querySelector<HTMLElement>(
    ".launch-loading__status, [data-role=\"loading-status\"]",
  );
  if (status) status.textContent = PUBLIC_DEMO_FAILURE;
  gateway.close();
}

window.addEventListener("pagehide", disposeStaticDemo, { once: true });
if (import.meta.hot) import.meta.hot.dispose(disposeStaticDemo);

void (async () => {
  try {
    root.dataset.staticDemoStatus = "starting";
    startStartupPerformanceMonitor(root);
    configurePixiContentSecurityPolicy();
    configurePixiTextMetricsReadbackCanvas();
    await waitForPaintedFrame();
    if (disposed) return;
    app = await AppController.create(root, {
      gateway,
      skipFeaturePreview: false,
      // 仅装饰用途的选择固定不变，避免重复公开演示暗示客户端 RNG 或可变经济结果。
      characterCollectRandomSource: () => 0,
    }, {
      signal: assemblyController.signal,
    });
    if (disposed) {
      app.destroy();
      app = null;
      return;
    }
    app.start();
    root.dataset.staticDemoStatus = "running";
  } catch {
    presentStaticDemoFailure();
  }
})();
