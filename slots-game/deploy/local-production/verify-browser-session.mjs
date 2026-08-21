import { createHash, X509Certificate } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserSessionProbeSource } from "./browser-session-probe.mjs";

const startupTimeoutMs = 90_000;
const commandTimeoutMs = 15_000;
const expectedRgsOrigin = "https://rgs.localhost:8443";
const launchResponseFile = process.argv[2];
const certificateFile = process.env.LOCAL_BROWSER_CERT_FILE;

if (!launchResponseFile || !certificateFile) {
  throw new Error("本机浏览器验收缺少启动响应或证书路径");
}

const launchResponse = JSON.parse(await readFile(launchResponseFile, "utf8"));
const launchURL = new URL(launchResponse.url);
if (launchURL.origin !== "https://slots.localhost:8443"
  || !launchURL.hash.includes("rgsLaunchCode=")) {
  throw new Error("一次性启动响应不符合本机 HTTPS 契约");
}

const certificate = new X509Certificate(await readFile(certificateFile));
const subjectPublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
const allowedCertificateKey = createHash("sha256").update(subjectPublicKey).digest("base64");
const chromeExecutable = findChromeExecutable();
const profileDirectory = await mkdtemp(join(tmpdir(), "slots-local-browser-session-"));
const chrome = launchChrome(chromeExecutable, profileDirectory, allowedCertificateKey);
let pageSocket;
let cleanupPromise;

const cleanup = () => {
  cleanupPromise ??= (async () => {
    try {
      pageSocket?.close();
    } finally {
      try {
        await stopChrome(chrome.process);
      } finally {
        await rm(profileDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    }
  })();
  return cleanupPromise;
};
const handleInterrupt = (signal) => {
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
};
const handleSigint = () => handleInterrupt("SIGINT");
const handleSigterm = () => handleInterrupt("SIGTERM");
process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);

try {
  const debuggingPort = await chrome.debuggingPort;
  const target = await createPageTarget(debuggingPort);
  pageSocket = await connectDevTools(target.webSocketDebuggerUrl);
  await verifyGameSession(pageSocket, launchURL.href);
  process.stdout.write("本机真实浏览器会话验收通过：严格 CSP 无违规、RGS 交换成功且游戏画布已就绪。\n");
} finally {
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
  await cleanup();
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  throw new Error("未找到可执行的 Chrome/Chromium");
}

function launchChrome(executable, profileDirectoryValue, certificateKey) {
  const browser = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    `--ignore-certificate-errors-spki-list=${certificateKey}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectoryValue}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const debuggingPort = new Promise((resolvePromise, rejectPromise) => {
    let diagnostics = "";
    const timer = setTimeout(() => rejectPromise(new Error("等待浏览器调试端口超时")), commandTimeoutMs);
    browser.stderr.setEncoding("utf8");
    browser.stderr.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_096);
      const match = diagnostics.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match) return;
      clearTimeout(timer);
      resolvePromise(Number(match[1]));
    });
    browser.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    browser.once("exit", (code, signal) => {
      clearTimeout(timer);
      rejectPromise(new Error(`浏览器提前退出：code=${code ?? "none"}, signal=${signal ?? "none"}`));
    });
  });
  return { process: browser, debuggingPort };
}

async function createPageTarget(debuggingPort) {
  const deadline = Date.now() + commandTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent("about:blank")}`,
        { method: "PUT" },
      );
      if (!response.ok) throw new Error(`DevTools target HTTP ${response.status}`);
      const target = await response.json();
      if (typeof target.webSocketDebuggerUrl === "string") return target;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("无法创建本机浏览器测试页");
}

function connectDevTools(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolvePromise(socket), { once: true });
    socket.addEventListener("error", () => rejectPromise(new Error("无法连接浏览器调试协议")), {
      once: true,
    });
  });
}

async function verifyGameSession(socket, sensitiveLaunchURL) {
  let identifier = 0;
  let exchangeStatus = 0;
  let exchangeMethod = "";
  const pending = new Map();
  const failures = [];
  const requestDetails = new Map();
  const pausedExceptions = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      const detail = message.params?.exceptionDetails;
      failures.push(redactDiagnostic(detail?.exception?.description ?? detail?.text ?? "页面脚本异常"));
      return;
    }
    if (message.method === "Debugger.paused") {
      const description = message.params?.data?.description;
      if (typeof description === "string") {
        pausedExceptions.push(redactDiagnostic(description));
      }
      void send("Debugger.resume").catch(() => {});
      return;
    }
    if (message.method === "Network.responseReceived") {
      const response = message.params?.response;
      if (!response || typeof response.url !== "string") return;
      const responseURL = new URL(response.url);
      const request = requestDetails.get(message.params?.requestId);
      if (responseURL.origin === expectedRgsOrigin
        && responseURL.pathname === "/client/v1/sessions/exchange"
        && request?.method === "POST"
        && request?.url === `${expectedRgsOrigin}/client/v1/sessions/exchange`) {
        exchangeStatus = response.status;
        exchangeMethod = request.method;
      }
      if (response.status >= 400 && ["Document", "Script", "Stylesheet", "Fetch", "XHR"].includes(message.params.type)) {
        failures.push(`${responseURL.origin}${responseURL.pathname} 返回 HTTP ${response.status}`);
      }
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params?.request;
      const requestURL = request?.url;
      if (typeof requestURL === "string") {
        const parsed = new URL(requestURL);
        requestDetails.set(message.params.requestId, {
          method: request.method,
          url: `${parsed.origin}${parsed.pathname}`,
        });
      }
      return;
    }
    if (message.method === "Network.loadingFailed") {
      const request = requestDetails.get(message.params?.requestId);
      failures.push(`${request?.url ?? "未知请求"} 加载失败：${message.params?.errorText ?? "未知网络错误"}`);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("浏览器调试连接提前关闭"));
    }
    pending.clear();
  }, { once: true });

  const send = (method, params = {}) => {
    const id = ++identifier;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`浏览器调试命令超时：${method}`));
      }, commandTimeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  await Promise.all([
    send("Page.enable"),
    send("Runtime.enable"),
    send("Network.enable"),
    send("Debugger.enable"),
  ]);
  await send("Debugger.setPauseOnExceptions", { state: "all" });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: browserSessionProbeSource,
  });
  await send("Page.navigate", { url: sensitiveLaunchURL });

  const deadline = Date.now() + startupTimeoutMs;
  let latestState;
  while (Date.now() < deadline) {
    const evaluation = await send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector('#app');
        const loading = document.querySelector('[data-role="launch-loading"]');
        return {
          origin: location.origin,
          fragmentCleared: location.hash === '',
          readyState: document.readyState,
          assemblyStage: root?.dataset?.startupAssemblyStage ?? '',
          startupShell: root?.dataset?.startupShell ?? '',
          rgsSession: root?.dataset?.rgsSession ?? '',
          canvasCount: document.querySelectorAll('canvas').length,
          balance: document.querySelector('[data-role="balance"]')?.textContent?.trim() ?? '',
          loadingVisible: loading?.getAttribute('data-visible') ?? '',
          status: document.querySelector('.launch-loading__status')?.textContent ?? '',
          launchProbe: globalThis.__localSessionProbe ?? null,
          cspViolations: Array.isArray(globalThis.__localSessionProbe?.cspViolations)
            ? globalThis.__localSessionProbe.cspViolations.slice(0, 16).map((violation) => ({
                effectiveDirective: String(violation?.effectiveDirective ?? '').slice(0, 64),
                violatedDirective: String(violation?.violatedDirective ?? '').slice(0, 64),
                disposition: String(violation?.disposition ?? '').slice(0, 32),
                blockedTarget: String(violation?.blockedTarget ?? '').split(/[?#]/u, 1)[0].slice(0, 256),
              }))
            : [],
        };
      })()`,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.exception?.description
        ?? evaluation.exceptionDetails.text
        ?? "浏览器页面状态读取失败");
    }
    latestState = evaluation.result.value;
    if (latestState.cspViolations.length > 0) {
      throw new Error(`浏览器检测到 CSP 违规：${redactDiagnostic(JSON.stringify(latestState.cspViolations))}`);
    }
    if (latestState.assemblyStage === "assembly-failed") {
      const safeFailureState = {
        status: latestState.status || "无公开错误信息",
        launchProbe: latestState.launchProbe,
        exchangeStatus,
        exchangeMethod,
        networkFailures: failures,
        pausedExceptions: pausedExceptions.slice(-8),
      };
      throw new Error(`游戏入口装配失败：${JSON.stringify(safeFailureState)}`);
    }
    if (failures.length > 0) throw new Error(`浏览器运行失败：${failures.join("；")}`);
    if (exchangeStatus === 200
      && exchangeMethod === "POST"
      && latestState.fragmentCleared
      && latestState.canvasCount > 0
      && latestState.rgsSession === "online"
      && latestState.balance !== ""
      && latestState.balance !== "—"
      && latestState.assemblyStage === "readiness-complete-painted") return;
    await delay(200);
  }
  const safeState = {
    readyState: latestState?.readyState,
    assemblyStage: latestState?.assemblyStage,
    startupShell: latestState?.startupShell,
    canvasCount: latestState?.canvasCount,
    fragmentCleared: latestState?.fragmentCleared,
    rgsSession: latestState?.rgsSession,
    balanceApplied: latestState?.balance !== "" && latestState?.balance !== "—",
    exchangeStatus,
    exchangeMethod,
    cspViolationCount: latestState?.cspViolations?.length ?? 0,
  };
  throw new Error(`游戏在九十秒内未完成启动：${JSON.stringify(safeState)}`);
}

async function stopChrome(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGTERM");
  if (await waitForProcessExit(browser, 2_000)) return;
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGKILL");
  if (!await waitForProcessExit(browser, 2_000)) throw new Error("浏览器进程无法停止");
}

function waitForProcessExit(browser, timeoutMs) {
  if (browser.exitCode !== null || browser.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const handleExit = () => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      browser.off("exit", handleExit);
      resolvePromise(false);
    }, timeoutMs);
    browser.once("exit", handleExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function redactDiagnostic(value) {
  return String(value)
    .replace(/lc_[A-Za-z0-9_-]{43}/g, "[一次性启动码已删除]")
    .replace(/Bearer\s+[^\s"'<>]+/giu, "Bearer [访问凭据已删除]")
    .replace(/(authorization|access[_-]?token|launch[_-]?code|secret)(\s*[:=]\s*)[^\s,;"'<>]+/giu,
      "$1$2[敏感值已删除]");
}
