const firefoxSoftwareRenderingEnvironmentVariable =
  "SLOTS_FIREFOX_XVFB_SOFTWARE_WEBGL";

const firefoxSoftwareRenderingEnvironment = Object.freeze({
  GALLIUM_DRIVER: "llvmpipe",
  LIBGL_ALWAYS_SOFTWARE: "true",
});

const firefoxSoftwareRenderingPreferences = Object.freeze({
  "gfx.webrender.software": true,
  "webgl.disabled": false,
  "webgl.force-enabled": true,
});

/**
 * GitHub 的 Linux Firefox runner 没有硬件显示器或 GPU。仅在该环境中，
 * 使用 Xvfb 运行有界面的 Firefox，并强制选择 Mesa llvmpipe。页面仍必须
 * 创建和查询真实 WebGL 上下文；这里仅选择渲染通道，不生成合成画布证据。
 */
export function resolveBrowserRenderingContract({
  browserName,
  environment = process.env,
  platform = process.platform,
}) {
  const optInValue = environment[firefoxSoftwareRenderingEnvironmentVariable];
  if (browserName === "firefox"
    && optInValue !== undefined
    && optInValue !== ""
    && optInValue !== "0"
    && optInValue !== "1") {
    throw new Error(
      `${firefoxSoftwareRenderingEnvironmentVariable} 只能为 0 或 1`,
    );
  }

  const softwareRenderingRequested = browserName === "firefox" && optInValue === "1";
  const linuxCiFirefox = browserName === "firefox"
    && platform === "linux"
    && environment.CI === "true";
  if (linuxCiFirefox && !softwareRenderingRequested) {
    throw new Error(
      `Linux CI Firefox 必须通过 ${firefoxSoftwareRenderingEnvironmentVariable}=1 `
      + "在 Xvfb 中启用真实 Mesa 软件 WebGL",
    );
  }

  if (softwareRenderingRequested) {
    if (platform !== "linux") {
      throw new Error("Firefox Xvfb 软件 WebGL 只允许在 Linux 启用");
    }
    if (typeof environment.DISPLAY !== "string" || environment.DISPLAY.trim() === "") {
      throw new Error("Firefox Xvfb 软件 WebGL 缺少 DISPLAY");
    }
    for (const [name, expected] of Object.entries(firefoxSoftwareRenderingEnvironment)) {
      if (environment[name] !== expected) {
        throw new Error(`Firefox Xvfb 软件 WebGL 要求 ${name}=${expected}`);
      }
    }
    return Object.freeze({
      launchOptions: Object.freeze({
        firefoxUserPrefs: firefoxSoftwareRenderingPreferences,
        headless: false,
      }),
      renderingMode: "linux-xvfb-mesa-llvmpipe",
    });
  }

  return Object.freeze({
    launchOptions: Object.freeze({
      headless: true,
      ...(browserName === "chromium"
        ? { channel: "chrome" }
        : browserName === "msedge"
          ? { channel: "msedge" }
          : {}),
    }),
    renderingMode: "browser-default",
  });
}

export function validateVisualFixtureTimingBudget({
  browserDeadlineMs,
  maximumBrowserBudgetMs,
  maximumBrowserScenarioBudgetMs,
  primaryActionTimeoutMs,
  scenarioCount,
  scenarioDeadlineMs,
}) {
  for (const [name, value] of Object.entries({
    browserDeadlineMs,
    maximumBrowserBudgetMs,
    maximumBrowserScenarioBudgetMs,
    primaryActionTimeoutMs,
    scenarioCount,
    scenarioDeadlineMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} 必须为正安全整数`);
    }
  }
  if (maximumBrowserScenarioBudgetMs !== scenarioCount * scenarioDeadlineMs) {
    throw new Error("特殊玩法最坏场景预算必须等于场景数乘以单场景硬截止");
  }
  if (primaryActionTimeoutMs >= scenarioDeadlineMs) {
    throw new Error("特殊玩法主控件动作预算必须小于单场景硬截止");
  }
  if (maximumBrowserScenarioBudgetMs >= maximumBrowserBudgetMs) {
    throw new Error("特殊玩法单浏览器最坏场景预算必须小于总预算");
  }
  if (browserDeadlineMs >= maximumBrowserBudgetMs) {
    throw new Error("特殊玩法浏览器级墙钟截止必须小于总预算");
  }
  if (maximumBrowserScenarioBudgetMs >= browserDeadlineMs) {
    throw new Error("特殊玩法场景预算必须为浏览器启动与清理保留时间");
  }
  return Object.freeze({ maximumBrowserScenarioBudgetMs });
}

export function validateProductionBrowserTimingBudget({
  featurePreviewStartupTimeoutMs,
  maximumFeaturePreviewStartupTimeoutMs,
}) {
  for (const [name, value] of Object.entries({
    featurePreviewStartupTimeoutMs,
    maximumFeaturePreviewStartupTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} 必须为正安全整数`);
    }
  }
  if (featurePreviewStartupTimeoutMs >= maximumFeaturePreviewStartupTimeoutMs) {
    throw new Error("生产 Feature Preview 启动截止必须小于两分钟上限");
  }
  return Object.freeze({ featurePreviewStartupTimeoutMs });
}
