const RUNTIME_EVENT_LIMIT = 16;

export const BROWSER_RUNTIME_PHASES = Object.freeze([
  "document-start",
  "bootstrap",
  "opening-overlay",
  "ready",
  "mobile-matrix",
  "help-matrix",
  "desktop-matrix",
  "transaction-active",
  "transaction-settle",
]);

/**
 * 把浏览器异常压缩为固定低基数代码。原始 message/name/stack/URL 只参与本地
 * 分类，永远不会进入公开 CI 结果。
 *
 * 英文 / English: Compress browser exceptions into fixed low-radix code. The original message/name/stack/URL only participates in local classification and never enters public CI results.
 */
export function classifyBrowserRuntimeFailure(input) {
  const kind = input?.kind === "unhandled-rejection"
    ? "unhandled-rejection"
    : "window-error";
  const safeCodes = {
    AbortError: "ABORT_ERROR",
    Error: "ERROR",
    InvalidStateError: "INVALID_STATE_ERROR",
    NetworkError: "NETWORK_ERROR",
    NotAllowedError: "NOT_ALLOWED_ERROR",
    NotFoundError: "NOT_FOUND_ERROR",
    NotSupportedError: "NOT_SUPPORTED_ERROR",
    QuotaExceededError: "QUOTA_EXCEEDED_ERROR",
    RangeError: "RANGE_ERROR",
    ReferenceError: "REFERENCE_ERROR",
    SecurityError: "SECURITY_ERROR",
    SyntaxError: "SYNTAX_ERROR",
    TypeError: "TYPE_ERROR",
  };
  const resizeObserverMessage = input?.message === "ResizeObserver loop limit exceeded"
    || input?.message === "ResizeObserver loop completed with undelivered notifications.";
  if (kind === "window-error"
    && input?.isTrusted === true
    && input?.errorPresent === false
    && resizeObserverMessage) {
    // 仍按 fatal 处理：应用必须消除同步观察循环，不能用浏览器警告掩盖布局竞态。 / English: Still treated as fatal: the application must eliminate the synchronized observation loop and cannot use browser warnings to cover up layout races.
    return { kind, code: "RESIZE_OBSERVER_LOOP", severity: "fatal" };
  }
  if (kind === "unhandled-rejection" && input?.reasonPresent === false) {
    return { kind, code: "NON_ERROR_REJECTION", severity: "fatal" };
  }
  const name = typeof input?.errorName === "string" ? input.errorName : "";
  return {
    kind,
    code: safeCodes[name]
      ?? (kind === "unhandled-rejection"
        ? "UNKNOWN_UNHANDLED_REJECTION"
        : "UNKNOWN_RUNTIME_ERROR"),
    severity: "fatal",
  };
}

/** 在写入时合并并限制事件，避免异常风暴把 CI 输出或页面内存撑大。 / English: Consolidate and limit events on write to avoid abnormal storms from bloating CI output or page memory. */
export function recordBrowserRuntimeEvent(state, event, phase, limit = 16) {
  const existing = state.events.find((candidate) => (
    candidate.kind === event.kind
    && candidate.code === event.code
    && candidate.phase === phase
    && candidate.severity === event.severity
  ));
  if (existing) {
    existing.count += 1;
    return;
  }
  if (state.events.length >= limit) {
    state.droppedCount += 1;
    return;
  }
  state.events.push({ ...event, phase, count: 1 });
}

/** 对页面内对象再次执行白名单投影，防止被测代码污染公开诊断。 / English: Perform whitelist projection again on the objects in the page to prevent the tested code from contaminating the public diagnosis. */
export function browserRuntimeDiagnosticSummary(state) {
  const allowedKinds = new Set(["window-error", "unhandled-rejection", "probe-warning"]);
  const allowedCodes = new Set([
    "ABORT_ERROR",
    "ERROR",
    "FEATURE_PREVIEW_STORAGE_UNAVAILABLE",
    "INVALID_STATE_ERROR",
    "NETWORK_ERROR",
    "NON_ERROR_REJECTION",
    "NOT_ALLOWED_ERROR",
    "NOT_FOUND_ERROR",
    "NOT_SUPPORTED_ERROR",
    "QUOTA_EXCEEDED_ERROR",
    "RANGE_ERROR",
    "REFERENCE_ERROR",
    "RESIZE_OBSERVER_LOOP",
    "SECURITY_ERROR",
    "SYNTAX_ERROR",
    "TYPE_ERROR",
    "UNKNOWN_RUNTIME_ERROR",
    "UNKNOWN_UNHANDLED_REJECTION",
  ]);
  const allowedPhases = new Set([
    "document-start",
    "bootstrap",
    "opening-overlay",
    "ready",
    "mobile-matrix",
    "help-matrix",
    "desktop-matrix",
    "transaction-active",
    "transaction-settle",
  ]);
  const events = Array.isArray(state?.events)
    ? state.events.slice(0, 16).map((event) => {
        const kind = allowedKinds.has(event?.kind) ? event.kind : "window-error";
        const severity = event?.severity === "warning" ? "warning" : "fatal";
        return {
          kind,
          code: allowedCodes.has(event?.code)
            ? event.code
            : (kind === "unhandled-rejection"
              ? "UNKNOWN_UNHANDLED_REJECTION"
              : "UNKNOWN_RUNTIME_ERROR"),
          phase: allowedPhases.has(event?.phase) ? event.phase : "document-start",
          severity,
          count: Number.isSafeInteger(event?.count) && event.count > 0 ? event.count : 1,
        };
      })
    : [{
        kind: "window-error",
        code: "UNKNOWN_RUNTIME_ERROR",
        phase: "document-start",
        severity: "fatal",
        count: 1,
      }];
  return {
    schema: 1,
    fatalCount: events.reduce(
      (total, event) => total + (event.severity === "fatal" ? event.count : 0),
      0,
    ),
    warningCount: events.reduce(
      (total, event) => total + (event.severity === "warning" ? event.count : 0),
      0,
    ),
    droppedCount: Number.isSafeInteger(state?.droppedCount) && state.droppedCount > 0
      ? state.droppedCount
      : 0,
    events,
  };
}

const classifierSource = classifyBrowserRuntimeFailure.toString();
const recorderSource = recordBrowserRuntimeEvent.toString();
const summarySource = browserRuntimeDiagnosticSummary.toString();

export const BROWSER_TRANSACTION_PROBE_SOURCE = `
  (() => {
    const classifyBrowserRuntimeFailure = ${classifierSource};
    const recordBrowserRuntimeEvent = ${recorderSource};
    const browserRuntimeDiagnosticSummary = ${summarySource};
    const allowedPhases = new Set(${JSON.stringify(BROWSER_RUNTIME_PHASES)});
    const runtimeState = { events: [], droppedCount: 0 };
    const probe = {
      operatorSessionRequests: [],
      playerErrors: [],
      transaction: null,
      phase: "document-start",
      setPhase(value) {
        if (allowedPhases.has(value)) this.phase = value;
      },
    };
    Object.defineProperty(probe, "runtimeDiagnostics", {
      enumerable: true,
      get: () => browserRuntimeDiagnosticSummary(runtimeState),
    });
    Object.defineProperty(globalThis, "__slotsProductionTransactionProbe", {
      configurable: false,
      enumerable: false,
      value: probe,
      writable: false,
    });
    addEventListener("slots-game:operator-session-required", (event) => {
      probe.operatorSessionRequests.push({
        code: String(event?.detail?.code ?? "unknown").slice(0, 64),
        reason: String(event?.detail?.reason ?? "unknown").slice(0, 64),
      });
    });
    addEventListener("slots-game:player-error", (event) => {
      probe.playerErrors.push(String(event?.detail?.code ?? "unknown").slice(0, 64));
    });
    addEventListener("error", (event) => {
      recordBrowserRuntimeEvent(runtimeState, classifyBrowserRuntimeFailure({
        kind: "window-error",
        errorName: typeof event?.error?.name === "string" ? event.error.name : "",
        errorPresent: event?.error !== null && event?.error !== undefined,
        isTrusted: event?.isTrusted === true,
        message: typeof event?.message === "string" ? event.message : "",
      }), probe.phase);
    });
    addEventListener("unhandledrejection", (event) => {
      recordBrowserRuntimeEvent(runtimeState, classifyBrowserRuntimeFailure({
        kind: "unhandled-rejection",
        errorName: typeof event?.reason?.name === "string" ? event.reason.name : "",
        reasonPresent: event?.reason !== null && event?.reason !== undefined
          && (typeof event.reason === "object" || typeof event.reason === "function"),
      }), probe.phase);
    });
    try {
      localStorage.setItem("primal-rampage.feature-preview.dismissed.v1", "1");
    } catch {
      recordBrowserRuntimeEvent(runtimeState, {
        kind: "probe-warning",
        code: "FEATURE_PREVIEW_STORAGE_UNAVAILABLE",
        severity: "warning",
      }, probe.phase);
    }
    // document-start 只覆盖探针自身的最早初始化；生产模块随后立即进入 bootstrap。 / English: document-start only overrides the earliest initialization of the probe itself; the production module enters bootstrap immediately thereafter.
    probe.setPhase("bootstrap");
  })();
`;
