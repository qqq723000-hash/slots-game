import type {
  FeatureState,
  MoneyMinor,
  ServerError,
  SessionOpened,
  SpinResult,
} from "../app/state/types";
import type { RgsSpinDecodeStage } from "./rgsDecoder";

export type GatewayStatus = "idle" | "connecting" | "online" | "recovering" | "offline";

/** 只描述结果交付经过的固定边界，绝不携带响应、标识或异常内容。 */
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
 */
export type InitialSessionRecoveryMode = "operator-session";

/**
 * 浏览器运行时可用性只控制传输调度，不改变任何经济身份或服务端状态。
 * hidden 页面暂停非关键轮询；offline 页面还暂停需要网络的重试。
 */
export interface GatewayRuntimeAvailability {
  readonly online: boolean;
  readonly visible: boolean;
}

export interface GatewayCallbacks {
  onStatus(status: GatewayStatus): void;
  onSession(message: SessionOpened): void;
  /** 持久恢复返回结果时携带原始特性状态，继续由控制器完成语义校验。 */
  onSpinResult(message: SpinResult, originFeatureState?: Readonly<FeatureState>): void;
  /** 固定阶段码仅供本地生产诊断；观察者异常不得影响权威轮次。 */
  onResultDeliveryStage?(stage: ResultDeliveryStage): void;
  /** 服务端已经持久接受展示消费回执。 */
  onSpinResultAcknowledged?(roundId: string, sequence: number): void;
  /** 当前页无法安全恢复时，只请求运营商签发新会话，不暴露底层异常内容。 */
  onOperatorSessionRequired?(error: ServerError | Error): void;
  onError(error: ServerError | Error): void;
}

/**
 * 控制器与生产传输之间的最小边界。实现不得把余额、RNG 或结算职责下放到浏览器。
 */
export interface GameGateway {
  setCallbacks(callbacks: GatewayCallbacks): void;
  readonly hasPendingSpin: boolean;
  readonly initialSessionRecoveryMode?: InitialSessionRecoveryMode;
  /** 仅供故障关闭恢复通知使用的构建期精确运营商来源。 */
  readonly operatorHostOrigin?: string;
  connect(): void;
  /**
   * 可选浏览器生命周期端口。测试替身无需实现；生产 RGS 用它避免后台/离线
   * 消耗恢复预算，并在同一页恢复时继续既有 ledger。
   */
  setRuntimeAvailability?(availability: Readonly<GatewayRuntimeAvailability>): void;
  requestSpin(roundId: string, betMinor: MoneyMinor): boolean;
  /** 持久传输在结果展示完成后确认消费，不得改变已经提交的经济结果。 */
  acknowledgeSpinResult?(roundId: string, sequence: number): boolean;
  close(): void;
}
