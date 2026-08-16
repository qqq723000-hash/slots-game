import type {
  FeatureState,
  MoneyMinor,
  ServerError,
  SessionOpened,
  SpinResult,
} from "../app/state/types";

export type GatewayStatus = "idle" | "connecting" | "online" | "recovering" | "offline";

/**
 * 首次会话只能由运营商重新签发；浏览器不得重放已经消费的一次性启动凭据。
 */
export type InitialSessionRecoveryMode = "operator-session";

export interface GatewayCallbacks {
  onStatus(status: GatewayStatus): void;
  onSession(message: SessionOpened): void;
  /** 持久恢复返回结果时携带原始特性状态，继续由控制器完成语义校验。 */
  onSpinResult(message: SpinResult, originFeatureState?: Readonly<FeatureState>): void;
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
  requestSpin(roundId: string, betMinor: MoneyMinor): boolean;
  /** 持久传输在结果展示完成后确认消费，不得改变已经提交的经济结果。 */
  acknowledgeSpinResult?(roundId: string, sequence: number): boolean;
  close(): void;
}
