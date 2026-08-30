import type {
  FeatureEvent,
  GridCell,
  MoneyMinor,
  SpinResult,
  SymbolId,
  Win,
} from "../app/state/types";

/** 后端拥有的条带修订版。浏览器从不使用它来结算回合。 / English: The stripe revision owned by the backend. The browser never uses it to settle rounds. */
export interface ReelStripSetReference {
  readonly stripSetId: string;
  readonly version: string;
  /** 可选的小写 64 字符 SHA-256 十六进制摘要。 / English: Optional lowercase 64-character SHA-256 hexadecimal digest. */
  readonly integritySha256?: string;
}

export interface AuthoritativeReelStop {
  readonly reel: 0 | 1 | 2;
  readonly stripId: string;
  readonly stopIndex: number;
}

/**
 * 保留协议-v2 表现数据。 `grid`保持权威可见结果；停止索引仅将渲染器与后端条对齐。
 *
 * 英文 / English: Protocol-v2 performance data preserved. `grid` keeps authoritative visible results; stopping indexing only aligns the renderer with the backend bar.
 */
export interface ReelPresentationData {
  readonly stripSet: ReelStripSetReference;
  readonly stops: readonly [
    AuthoritativeReelStop & { readonly reel: 0 },
    AuthoritativeReelStop & { readonly reel: 1 },
    AuthoritativeReelStop & { readonly reel: 2 },
  ];
}

/** 预留的版本 2 表现扩展；正式结算仍以服务端返回的 `grid` 为权威。 / English: Reserved version 2 representation extension; formal settlement is still based on the `grid` returned by the server as authoritative. */
export interface SpinResultJSONV2 extends Omit<SpinResult, "protocolVersion"> {
  readonly protocolVersion: 2;
  readonly reelPresentation: ReelPresentationData;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

/** 卷轴表现代码使用的与数学无关的视图。 / English: Scrolls represent a non-mathematical view used by the code. */
export interface AuthoritativeReelRound {
  readonly roundId: string;
  readonly rows: number;
  readonly grid: DeepReadonly<GridCell[][]>;
  readonly wins: DeepReadonly<Win[]>;
  readonly events: DeepReadonly<FeatureEvent[]>;
  readonly totalWinMinor: MoneyMinor;
  readonly reelPresentation?: ReelPresentationData;
}

/**
 * 可选后端/CDN 源，用于真实的机上条带订单。它仅供表现：客户绝不能尝试止损或计算赢利。
 *
 * 英文 / English: Optional backend/CDN origin for real onboard striping orders. It is for performance only: the client must never attempt to stop losses or calculate profits.
 */
export interface SpinStripVisualSource {
  loadStripSet(reference: ReelStripSetReference): Promise<{
    readonly reference: ReelStripSetReference;
    readonly reels: readonly [
      { readonly stripId: string; readonly symbols: readonly SymbolId[] },
      { readonly stripId: string; readonly symbols: readonly SymbolId[] },
      { readonly stripId: string; readonly symbols: readonly SymbolId[] },
    ];
  }>;
}

function cloneAndDeepFreeze<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    const clone = value.map((item) => cloneAndDeepFreeze(item));
    return Object.freeze(clone) as DeepReadonly<T>;
  }
  if (value !== null && typeof value === "object") {
    const clone = Object.fromEntries(Object.entries(value).map(([key, item]) => (
      [key, cloneAndDeepFreeze(item)]
    )));
    return Object.freeze(clone) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

/** 适应当今严格的协议 - v1 JSON，而不更改其线路模式。 / English: Adapt to today's strict protocol - v1 JSON without changing its wire mode. */
export function authoritativeReelRoundFromV1(result: SpinResult): AuthoritativeReelRound {
  const rows = result.grid[0]?.length ?? 0;
  if (result.grid.length !== 3
    || rows < 3
    || rows > 8
    || result.grid.some((reel) => reel.length !== rows)) {
    throw new Error("Cannot adapt malformed authoritative reel grid");
  }
  // 协议投影必须在不依赖浏览器 structuredClone 的环境中同样可用。 / English: Protocol projections must also be available in environments that do not rely on browser structuredClone.
  // 逐项复制保留已解码树中的 undefined 等值，同时避免 JSON 序列化的语义损失。 / English: Item-by-item copying preserves undefined equivalents in the decoded tree while avoiding the semantic loss of JSON serialization.
  const immutableProjection = cloneAndDeepFreeze({
    grid: result.grid,
    wins: result.wins,
    events: result.events,
  });
  return Object.freeze({
    roundId: result.roundId,
    rows,
    grid: immutableProjection.grid,
    wins: immutableProjection.wins,
    events: immutableProjection.events,
    totalWinMinor: result.totalWinMinor,
    // 协议 v1 没有 strip-set/stop-index 表示扩展。 / English: Protocol v1 does not have strip-set/stop-index representation extensions.
    reelPresentation: undefined,
  });
}
