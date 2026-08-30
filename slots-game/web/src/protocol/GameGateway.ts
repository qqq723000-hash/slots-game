import type {
  FeatureState,
  MoneyMinor,
  ServerError,
  SessionOpened,
  SpinResult,
} from "../app/state/types";
import type { RgsSpinDecodeStage } from "./rgsDecoder";

export type GatewayStatus = "idle" | "connecting" | "online" | "recovering" | "offline";

/** 只描述结果交付经过的固定边界，绝不携带响应、标识或异常内容。 / English: It only describes the fixed boundaries through which results are delivered, and never carries response, flag, or exception content. */
export type ResultDeliveryStage =
  | RgsSpinDecodeStage
  | "post-response-before-decode"
  | "decoded"
  | "economic-identity"
  | "sequence-guard"
  | "origin-reconstructed"
  | "origin-validated"
  | "controller-dispatch"
  | "delivered";

/**
 * 首次会话只能由运营商重新签发；浏览器不得重放已经消费的一次性启动凭据。
 *
 * 英文 / English: First-time sessions can only be re-issued by the operator; browsers may not replay one-time startup credentials that have already been consumed.
 */
export type InitialSessionRecoveryMode = "operator-session";

/**
 * 浏览器运行时可用性只控制传输调度，不改变任何经济身份或服务端状态。
 * hidden 页面暂停非关键轮询；offline 页面还暂停需要网络的重试。
 *
 * 英文 / English: Browser runtime availability only controls transfer scheduling and does not change any economic identity or server state. Hidden pages pause non-critical polling; offline pages also pause retries that require network.
 */
export interface GatewayRuntimeAvailability {
  readonly online: boolean;
  readonly visible: boolean;
}

/**
 * 服务端权威空闲截止时间的终态通知。浏览器只能按绝对时间投影该状态，
 * 不能通过本地指针、键盘或可见性事件延长它。
 *
 * 英文 / English: Final notification of the server's authoritative idle deadline. The browser can only project this state in absolute time; it cannot extend it through local pointer, keyboard, or visibility events.
 */
export interface GatewaySessionTimeout {
  readonly code: "SESSION_TIMEOUT";
  readonly idleDisconnectAt: string;
}

export interface GatewayCallbacks {
  onStatus(status: GatewayStatus): void;
  onSession(message: SessionOpened): void;
  /** 持久恢复返回结果时携带原始特性状态，继续由控制器完成语义校验。 / English: The return result of persistent recovery carries the original feature state, and the controller continues to complete semantic verification. */
  onSpinResult(message: SpinResult, originFeatureState?: Readonly<FeatureState>): void;
  /** 固定阶段码仅供本地生产诊断；观察者异常不得影响权威轮次。 / English: Fixed stage codes are for local production diagnostics only; observer exceptions must not affect authoritative rounds. */
  onResultDeliveryStage?(stage: ResultDeliveryStage): void;
  /** 服务端已经持久接受展示消费回执。 / English: The server has persistently accepted display consumption receipts. */
  onSpinResultAcknowledged?(roundId: string, sequence: number): void;
  /** 当前页无法安全恢复时，只请求运营商签发新会话，不暴露底层异常内容。 / English: When the current page cannot be restored safely, the operator is only requested to issue a new session without exposing the underlying abnormal content. */
  onOperatorSessionRequired?(error: ServerError | Error): void;
  /** 服务端空闲会话已经终止；调用方必须停止下注且不得自动重连。 / English: The server idle session has been terminated; the caller must stop placing bets and must not automatically reconnect. */
  onSessionTimeout?(timeout: Readonly<GatewaySessionTimeout>): void;
  onError(error: ServerError | Error): void;
}

/**
 * 控制器与生产传输之间的最小边界。实现不得把余额、RNG 或结算职责下放到浏览器。
 *
 * 英文 / English: Minimal boundary between controller and production transfer. Implementations MUST NOT delegate balance, RNG, or settlement responsibilities to the browser.
 */
export interface GameGateway {
  setCallbacks(callbacks: GatewayCallbacks): void;
  readonly hasPendingSpin: boolean;
  readonly initialSessionRecoveryMode?: InitialSessionRecoveryMode;
  /** 仅供故障关闭恢复通知使用的构建期精确运营商来源。 / English: Build-time accurate operator source used only for fail-down recovery notifications. */
  readonly operatorHostOrigin?: string;
  connect(): void;
  /**
   * 可选浏览器生命周期端口。测试替身无需实现；生产 RGS 用它避免后台/离线
   * 消耗恢复预算，并在同一页恢复时继续既有 ledger。
   *
   * 英文 / English: Optional browser lifecycle port. Test doubles do not need to be implemented; production RGS uses it to avoid background/offline consumption of recovery budget and continue the existing ledger when the same page is recovered.
   */
  setRuntimeAvailability?(availability: Readonly<GatewayRuntimeAvailability>): void;
  requestSpin(roundId: string, betMinor: MoneyMinor): boolean;
  /** 持久传输在结果展示完成后确认消费，不得改变已经提交的经济结果。 / English: Persistent transfer confirms consumption after the result display is completed and must not change the economic results that have been submitted. */
  acknowledgeSpinResult?(roundId: string, sequence: number): boolean;
  close(): void;
}
