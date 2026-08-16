import { createReadStream } from "node:fs";
import { access, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = resolve(webRoot, "dist");
const bootstrapFailureText = "The game could not start. Please try again.";
const startupTimeoutMs = 15_000;

const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

await access(resolve(distributionRoot, "index.html"));
const distributionRealRoot = await realpath(distributionRoot);
const modulePaths = await productionModulePaths(distributionRoot);
const chromeExecutable = findChromeExecutable();
const profileDirectory = await mkdtemp(join(tmpdir(), "slots-production-browser-"));
const server = createDistributionServer();
const chrome = await launchChrome(chromeExecutable, profileDirectory);
let pageSocket;

try {
  const address = await listenOnLoopback(server);
  const pageUrl = `http://127.0.0.1:${address.port}/`;
  const debuggingPort = await chrome.debuggingPort;
  const target = await waitForPageTarget(debuggingPort, pageUrl);
  pageSocket = await connectDevTools(target.webSocketDebuggerUrl);
  const result = await verifyBootstrap(pageSocket, pageUrl, modulePaths);
  if (result.moduleFailures.length > 0) {
    const detail = result.moduleFailures
      .map(({ path, name, message, stack }) => [path, name, message, stack].filter(Boolean).join("\n"))
      .join("\n\n");
    throw new Error(`生产入口在真实浏览器中求值失败：\n${detail}`);
  }
  if (result.status === bootstrapFailureText) {
    throw new Error("生产入口被启动边界判定为模块加载失败");
  }
  process.stdout.write(`生产浏览器启动门禁通过：${basename(result.entryPath)} 已完成模块求值。\n`);
} finally {
  pageSocket?.close();
  await closeServer(server);
  await stopChrome(chrome.process);
  // Chrome 主进程退出后，Linux 上的短命子进程仍可能在极短时间内关闭配置文件。
  // 使用有界重试清理专用临时目录，既避免 CI 的 ENOTEMPTY 竞态，也不遗留浏览器状态。
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function createDistributionServer() {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
      const candidate = resolve(distributionRoot, `.${requestedPath}`);
      const relativePath = relative(distributionRoot, candidate);
      if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
        response.writeHead(404).end();
        return;
      }
      const filePath = await realpath(candidate);
      const realRelativePath = relative(distributionRealRoot, filePath);
      if (realRelativePath.startsWith(`..${sep}`) || realRelativePath === "..") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function productionModulePaths(root, parent = root) {
  const paths = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    const path = resolve(parent, entry.name);
    if (entry.isDirectory()) paths.push(...await productionModulePaths(root, path));
    else if (entry.isFile() && entry.name.endsWith(".js")) {
      paths.push(`/${relative(root, path).split(sep).join("/")}`);
    }
  }
  return paths.sort((left, right) => {
    const leftMain = /(^|\/)main-[^/]+\.js$/.test(left);
    const rightMain = /(^|\/)main-[^/]+\.js$/.test(right);
    if (leftMain !== rightMain) return leftMain ? -1 : 1;
    return left.localeCompare(right);
  });
}

function listenOnLoopback(serverValue) {
  return new Promise((resolvePromise, rejectPromise) => {
    serverValue.once("error", rejectPromise);
    serverValue.listen(0, "127.0.0.1", () => {
      serverValue.off("error", rejectPromise);
      resolvePromise(serverValue.address());
    });
  });
}

function closeServer(serverValue) {
  return new Promise((resolvePromise) => serverValue.close(() => resolvePromise()));
}

function findChromeExecutable() {
  const configured = process.env.CHROME_BIN;
  const candidates = [
    configured,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("未找到可执行的 Chrome/Chromium；可通过 CHROME_BIN 指定固定路径");
}

function launchChrome(executable, profileDirectoryValue) {
  const browser = spawn(executable, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-gpu",
    "--disable-sync",
    "--no-first-run",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectoryValue}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const debuggingPort = new Promise((resolvePromise, rejectPromise) => {
    let diagnostics = "";
    const timer = setTimeout(() => {
      rejectPromise(new Error("等待浏览器调试端口超时"));
    }, startupTimeoutMs);
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

async function waitForPageTarget(debuggingPort, pageUrl) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const createResponse = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(pageUrl)}`,
        { method: "PUT" },
      );
      if (!createResponse.ok) throw new Error(`DevTools target HTTP ${createResponse.status}`);
      const target = await createResponse.json();
      if (typeof target.webSocketDebuggerUrl === "string") return target;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error("无法创建生产浏览器测试页");
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

async function verifyBootstrap(socket, pageUrl, productionModules) {
  let identifier = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
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
      }, startupTimeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };

  await Promise.all([send("Page.enable"), send("Runtime.enable")]);
  await send("Page.navigate", { url: pageUrl });
  await waitForDocumentReady(send);
  const evaluation = await send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      (async () => {
        const entry = document.querySelector('script[type="module"][src]');
        if (!entry) return {
          entryPath: "missing",
          moduleFailures: [{ message: "missing production module entry" }],
          status: null,
        };
        const productionModules = ${JSON.stringify(productionModules)};
        const moduleFailures = [];
        for (const path of productionModules) {
          const url = new URL(path, location.href).href;
          try {
            await import(url);
          } catch (error) {
            moduleFailures.push({
              path: new URL(url).pathname,
              name: error?.name,
              message: error?.message,
              stack: error?.stack,
            });
          }
        }
        return {
          entryPath: new URL(entry.src).pathname,
          moduleFailures,
          status: document.querySelector('.launch-loading__status')?.textContent ?? null,
        };
      })()
    `,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.exception?.description
      ?? evaluation.exceptionDetails.text
      ?? "浏览器求值失败");
  }
  return evaluation.result.value;
}

async function waitForDocumentReady(send) {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const evaluation = await send("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    if (evaluation.result.value === "complete") return;
    await delay(50);
  }
  throw new Error("生产页面加载超时");
}

async function stopChrome(browser) {
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGTERM");
  if (await waitForProcessExit(browser, 2_000)) return;
  if (browser.exitCode !== null || browser.signalCode !== null) return;
  browser.kill("SIGKILL");
  if (!await waitForProcessExit(browser, 2_000)) {
    throw new Error("浏览器进程在强制终止后仍未退出");
  }
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
