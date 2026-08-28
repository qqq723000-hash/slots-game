(function () {
  "use strict";

  var BOOTSTRAP_HANDOFF_TIMEOUT_MS = 15000;
  var originalPageUrl = "";
  var hadLaunchHandoff = false;
  var earlyState = window.__slotsEarlyLaunchHandoff;
  var earlyDetail = null;
  var earlyDetailValid = false;
  try {
    var earlyKeys = earlyState && typeof earlyState === "object"
      ? Object.keys(earlyState)
      : [];
    if (earlyState
      && Object.isFrozen(earlyState)
      && earlyKeys.length === 3
      && earlyKeys.indexOf("schema") >= 0
      && earlyKeys.indexOf("hadLaunchHandoff") >= 0
      && earlyKeys.indexOf("take") >= 0
      && earlyState.schema === 1
      && typeof earlyState.hadLaunchHandoff === "boolean"
      && typeof earlyState.take === "function") {
      earlyDetail = earlyState.take();
      var earlyDetailKeys = earlyDetail && typeof earlyDetail === "object"
        ? Object.keys(earlyDetail)
        : [];
      earlyDetailValid = !!earlyDetail
        && typeof earlyDetail === "object"
        && Object.isFrozen(earlyDetail)
        && earlyDetailKeys.length === 3
        && earlyDetailKeys.indexOf("schema") >= 0
        && earlyDetailKeys.indexOf("pageUrl") >= 0
        && earlyDetailKeys.indexOf("hadLaunchHandoff") >= 0
        && earlyDetail.schema === 1
        && typeof earlyDetail.pageUrl === "string"
        && !!earlyDetail.pageUrl
        && typeof earlyDetail.hadLaunchHandoff === "boolean"
        && earlyDetail.hadLaunchHandoff === earlyState.hadLaunchHandoff;
    }
  } catch (_) {
    earlyDetail = null;
    earlyDetailValid = false;
  }
  if (!earlyDetailValid) {
    earlyDetail = null;
    earlyState = null;
    if (!scrubFallbackLaunchFragment()) return;
    publishPreflight(false, false, function () { return null; });
    presentBootstrapFailure();
    return;
  }
  originalPageUrl = earlyDetail.pageUrl;
  hadLaunchHandoff = earlyDetail.hadLaunchHandoff;
  earlyDetail = null;
  earlyState = null;

  var supported = supportsRequiredBrowser();
  var handoffAvailable = supported;
  var handoffTimeout = null;
  var takeLaunchHandoff = function () {
    if (!handoffAvailable) return null;
    handoffAvailable = false;
    if (handoffTimeout !== null) {
      window.clearTimeout(handoffTimeout);
      handoffTimeout = null;
    }
    var pageUrl = originalPageUrl;
    originalPageUrl = "";
    if (!pageUrl) return null;
    return Object.freeze({
      pageUrl: pageUrl,
      hadLaunchHandoff: hadLaunchHandoff
    });
  };
  publishPreflight(supported, hadLaunchHandoff, takeLaunchHandoff);
  if (!supported) {
    presentUnsupportedBrowser();
    originalPageUrl = "";
    return;
  }

  // 模块入口应紧随本脚本执行。若其下载、解析或执行被阻断，最多保留一次性
  // 不透明 URL 15 秒；超时后焚毁交接并显示固定失败文案。
  handoffTimeout = window.setTimeout(function () {
    if (!handoffAvailable) return;
    handoffAvailable = false;
    handoffTimeout = null;
    originalPageUrl = "";
    presentBootstrapFailure();
  }, BOOTSTRAP_HANDOFF_TIMEOUT_MS);

  // 仅在受 CSP 保护的内联清理器没有交付有效状态时读取当前片段。这里不复制完整 URL，
  // 也不保留启动字段值；正常交接路径绝不会二次读取 location。
  function scrubFallbackLaunchFragment() {
    try {
      var fragment = String(window.location.hash || "");
      var retained = [];
      var containedLaunchKey = false;
      var entries = [];
      var entry = "";
      var separator = -1;
      var encodedKey = "";
      var decodedKey = "";
      if (fragment.charAt(0) === "#") fragment = fragment.slice(1);
      if (fragment) {
        entries = fragment.split("&");
        for (var index = 0; index < entries.length; index += 1) {
          entry = entries[index];
          separator = entry.indexOf("=");
          encodedKey = separator < 0 ? entry : entry.slice(0, separator);
          decodedKey = encodedKey;
          try {
            decodedKey = decodeURIComponent(encodedKey.replace(/\+/g, " "));
          } catch (_) {
            decodedKey = encodedKey;
          }
          if (decodedKey === "rgsLaunchCode"
            || decodedKey === "rgsOperatorId"
            || decodedKey === "rgsSessionId") containedLaunchKey = true;
          else retained.push(entry);
        }
      }
      if (!containedLaunchKey) return true;
      var sanitizedUrl = String(window.location.pathname || "/")
        + String(window.location.search || "")
        + (retained.length ? "#" + retained.join("&") : "");
      fragment = "";
      entries = [];
      entry = "";
      encodedKey = "";
      decodedKey = "";
      try {
        window.history.replaceState(window.history.state, "", sanitizedUrl);
        return true;
      } catch (_) {
        try { window.location.replace(sanitizedUrl); } catch (_) {}
        return false;
      }
    } catch (_) {
      return false;
    }
  }

  function supportsRequiredBrowser() {
    try {
      if (typeof BigInt !== "function"
        || typeof Promise !== "function" || typeof Promise.any !== "function"
        || typeof Object.hasOwn !== "function"
        || typeof Array.prototype.at !== "function"
        || typeof AbortController !== "function"
        || typeof MutationObserver !== "function"
        || typeof TextDecoder !== "function"
        || typeof TextEncoder !== "function"
        || typeof URL !== "function"
        || typeof URLSearchParams !== "function"
        || typeof fetch !== "function"
        || typeof queueMicrotask !== "function"
        || typeof requestAnimationFrame !== "function"
        || typeof crypto !== "object" || typeof crypto.getRandomValues !== "function"
        || !crypto.subtle || typeof crypto.subtle.digest !== "function"
        || (typeof AudioContext !== "function" && typeof webkitAudioContext !== "function")
        || typeof CSS !== "object" || typeof CSS.supports !== "function"
        || !CSS.supports("container-type", "size")
        || !CSS.supports("height", "1cqh")) return false;
      var canvas = document.createElement("canvas");
      var context = canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        depth: false,
        failIfMajorPerformanceCaveat: false,
        stencil: true
      });
      return !!context
        && Number(context.getParameter(context.MAX_TEXTURE_SIZE)) >= 4096;
    } catch (_) {
      return false;
    }
  }

  function publishPreflight(supportedValue, handoffValue, takeValue) {
    var state = Object.freeze({
      schema: 1,
      supported: supportedValue === true,
      hadLaunchHandoff: handoffValue === true,
      takeLaunchHandoff: takeValue
    });
    try {
      Object.defineProperty(window, "__slotsBrowserPreflight", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: state
      });
    } catch (_) {
      window.__slotsBrowserPreflight = state;
    }
  }

  function presentUnsupportedBrowser() {
    presentFixedFailure(
      "unsupported-browser",
      "unsupported",
      "This browser cannot run the game. Update Chrome, Edge, Firefox, or Safari and enable WebGL."
    );
  }

  function presentBootstrapFailure() {
    presentFixedFailure(
      "bootstrap-failed",
      "bootstrap-failed",
      "The game could not start. Please try again."
    );
  }

  function presentFixedFailure(stage, compatibility, message) {
    var retry;
    document.removeEventListener("DOMContentLoaded", presentUnsupportedBrowser, false);
    document.removeEventListener("DOMContentLoaded", presentBootstrapFailure, false);
    var root = document.querySelector("#app");
    if (!root && document.readyState === "loading") {
      retry = function () {
        document.removeEventListener("DOMContentLoaded", retry, false);
        presentFixedFailure(stage, compatibility, message);
      };
      document.addEventListener("DOMContentLoaded", retry, false);
      return;
    }
    var loading = root && root.querySelector('[data-role="launch-loading"]');
    var status = loading && loading.querySelector(".launch-loading__status");
    if (root) root.setAttribute("data-browser-compatibility", compatibility);
    if (loading) {
      loading.setAttribute("data-visible", "true");
      loading.setAttribute("data-stage", stage);
      loading.setAttribute("aria-hidden", "false");
      loading.removeAttribute("inert");
    }
    if (status) status.textContent = message;
  }
}());
