import type {
  FeatureEvent,
  FeatureState,
  GridCell,
  MoneyMinor,
  SessionOpened,
  SpinResult,
  Win,
} from "../app/state/types";
import type { GameGateway, GatewayCallbacks } from "../protocol/GameGateway";
import { ENGINE_RULES_VERSION, createRequestId } from "../protocol/messages";
import { PRIMAL_PRESENTATION_DEFINITION_BINDINGS } from "../ui/presentationRules";

const DEMO_BET_MINOR = "100" as const;
const DEMO_STARTING_BALANCE_MINOR = "100000" as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const BASE_FEATURE: FeatureState = Object.freeze({
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
});

interface PublicDemoRound {
  readonly chargedBetMinor: MoneyMinor;
  readonly totalWinMinor: MoneyMinor;
  readonly grid: GridCell[][];
  readonly wins: Win[];
  readonly events: readonly FeatureEvent[];
  readonly featureState: FeatureState;
}

const cell = (symbol: GridCell["symbol"], extras: Omit<GridCell, "symbol"> = {}): GridCell => ({
  symbol,
  ...extras,
});

const PAYING_SYMBOLS = [
  "ORBIT", "PRISM", "PULSE", "NOVA", "CIRCUIT", "TANK",
] as const;
type PayingSymbol = typeof PAYING_SYMBOLS[number];

function publicWinRound(
  id: string,
  symbol: PayingSymbol,
  amountMinor: MoneyMinor,
  wildMultiplier = 1,
): PublicDemoRound {
  const fillers = PAYING_SYMBOLS.filter((candidate) => candidate !== symbol);
  const path = [
    { reel: 0, row: 0 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const baseAmountMinor = (BigInt(amountMinor) / BigInt(wildMultiplier)).toString();
  return {
    chargedBetMinor: DEMO_BET_MINOR,
    totalWinMinor: amountMinor,
    grid: [
      [cell(symbol), cell(fillers[0]!), cell(fillers[1]!)],
      [wildMultiplier > 1
        ? cell("WILD", { multiplier: wildMultiplier })
        : cell(symbol), cell(fillers[2]!), cell(fillers[3]!)],
      [cell(symbol), cell(fillers[2]!), cell(fillers[3]!)],
    ],
    wins: [{
      id,
      symbol,
      ways: 1,
      nominalAmountMinor: amountMinor,
      amountMinor,
      multiplier: wildMultiplier,
      cells: path,
      pathAwards: [{
        cells: path,
        multiplier: wildMultiplier,
        baseAmountMinor,
        nominalAmountMinor: amountMinor,
        amountMinor,
      }],
    }],
    events: [],
    featureState: BASE_FEATURE,
  };
}

function publicMultiWayWildRound(): PublicDemoRound {
  const prismCells = [
    { reel: 0, row: 0 },
    { reel: 0, row: 1 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const prismPaths = [
    [{ reel: 0, row: 0 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
    [{ reel: 0, row: 1 }, { reel: 1, row: 0 }, { reel: 2, row: 0 }],
  ];
  const orbitCells = [
    { reel: 0, row: 2 },
    { reel: 1, row: 0 },
    { reel: 2, row: 2 },
  ];
  return {
    chargedBetMinor: DEMO_BET_MINOR,
    totalWinMinor: "100",
    grid: [
      [cell("PRISM"), cell("PRISM"), cell("ORBIT")],
      [cell("WILD", { multiplier: 2 }), cell("NOVA"), cell("TANK")],
      [cell("PRISM"), cell("NOVA"), cell("ORBIT")],
    ],
    wins: [
      {
        id: "public-demo-prism-wild-x2",
        symbol: "PRISM",
        ways: 2,
        nominalAmountMinor: "40",
        amountMinor: "40",
        multiplier: 2,
        cells: prismCells,
        pathAwards: prismPaths.map((cells) => ({
          cells,
          multiplier: 2,
          baseAmountMinor: "10",
          nominalAmountMinor: "20",
          amountMinor: "20",
        })),
      },
      {
        id: "public-demo-orbit-wild-x2",
        symbol: "ORBIT",
        ways: 1,
        nominalAmountMinor: "60",
        amountMinor: "60",
        multiplier: 2,
        cells: orbitCells,
        pathAwards: [{
          cells: orbitCells,
          multiplier: 2,
          baseAmountMinor: "30",
          nominalAmountMinor: "60",
          amountMinor: "60",
        }],
      },
    ],
    events: [],
    featureState: BASE_FEATURE,
  };
}

function activeFeatureState(
  mode: Exclude<FeatureState["mode"], "BASE">,
  remaining: number,
  cumulativeWinMinor: MoneyMinor,
): FeatureState {
  return {
    mode,
    freeSpinsRemaining: remaining,
    freeSpinsPlayed: 8 - remaining,
    baseBetMinor: DEMO_BET_MINOR,
    freeSpinsWinMinor: cumulativeWinMinor,
    rageLevel: 1,
    rageCollected: 0,
  };
}

const PUBLIC_RAGE_CELLS = Object.freeze([
  { reel: 0, row: 1 },
  { reel: 1, row: 1 },
  { reel: 2, row: 1 },
]);
const PUBLIC_FEATURE_TRIGGER_GRID: GridCell[][] = [
  [cell("PRISM"), cell("SURGE"), cell("PULSE")],
  [cell("ORBIT"), cell("SURGE"), cell("NOVA")],
  [cell("CIRCUIT"), cell("SURGE"), cell("TANK")],
];
const PUBLIC_FEATURE_IDLE_GRID: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("PRISM")],
  [cell("ORBIT"), cell("NOVA"), cell("ORBIT")],
  [cell("CIRCUIT"), cell("TANK"), cell("CIRCUIT")],
];

function publicFeatureTriggerRound(
  mode: Exclude<FeatureState["mode"], "BASE">,
): PublicDemoRound {
  return {
    chargedBetMinor: DEMO_BET_MINOR,
    totalWinMinor: "0",
    grid: PUBLIC_FEATURE_TRIGGER_GRID,
    wins: [],
    events: [
      {
        type: "surge.collected",
        count: 3,
        cells: PUBLIC_RAGE_CELLS,
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      mode === "EXPANSION"
        ? { type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" }
        : { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
      { type: "free_spins.started", mode, awarded: 8 },
    ],
    featureState: activeFeatureState(mode, 8, "0"),
  };
}

function publicExpandedGrid(rows: number): GridCell[][] {
  return [
    Array.from({ length: rows }, (_, row) => cell(row % 2 === 0 ? "PRISM" : "PULSE")),
    Array.from({ length: rows }, (_, row) => cell(row % 2 === 0 ? "ORBIT" : "NOVA")),
    Array.from({ length: rows }, (_, row) => cell(row % 2 === 0 ? "CIRCUIT" : "TANK")),
  ];
}

function publicKongRound(
  rows: number,
  remaining: number,
  completed = false,
): PublicDemoRound {
  return {
    chargedBetMinor: "0",
    totalWinMinor: "0",
    grid: publicExpandedGrid(rows),
    wins: [],
    events: [
      { type: "grid.expanded", rows, ways: rows ** 3 },
      ...(completed ? [{
        type: "free_spins.completed" as const,
        mode: "EXPANSION" as const,
        awarded: 8,
        cumulativeWinMinor: "0",
      }] : []),
    ],
    featureState: completed ? BASE_FEATURE : activeFeatureState("EXPANSION", remaining, "0"),
  };
}

function publicKingIdleRound(
  remaining: number,
  cumulativeWinMinor: MoneyMinor,
  completed = false,
): PublicDemoRound {
  return {
    chargedBetMinor: "0",
    totalWinMinor: "0",
    grid: PUBLIC_FEATURE_IDLE_GRID,
    wins: [],
    events: completed ? [{
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor,
    }] : [],
    featureState: completed
      ? BASE_FEATURE
      : activeFeatureState("OVERDRIVE", remaining, cumulativeWinMinor),
  };
}

const PUBLIC_BASE_VAULT_CELL = Object.freeze([{ reel: 1, row: 2 }]);
function publicBaseVaultRound(): PublicDemoRound {
  return {
    chargedBetMinor: DEMO_BET_MINOR,
    totalWinMinor: "200",
    grid: [
      [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
      [cell("NOVA"), cell("TANK"), cell("VAULT", { prize: "X2", multiplier: 2 })],
      [cell("CIRCUIT"), cell("NOVA"), cell("TANK")],
    ],
    wins: [],
    events: [
      { type: "vaults.landed", count: 1, cells: PUBLIC_BASE_VAULT_CELL },
      { type: "vaults.unlock.started", count: 1, cells: PUBLIC_BASE_VAULT_CELL },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "X2", multiplier: 2 },
      {
        type: "vault.awarded",
        reel: 1,
        row: 2,
        prize: "X2",
        multiplier: 2,
        amountMinor: "200",
      },
      { type: "vaults.unlock.completed", count: 1, cells: PUBLIC_BASE_VAULT_CELL },
    ],
    featureState: BASE_FEATURE,
  };
}

const PUBLIC_KING_VAULT_CELLS = Object.freeze([
  { reel: 1, row: 0 },
  { reel: 1, row: 1 },
  { reel: 1, row: 2 },
]);
function publicKingVaultRound(): PublicDemoRound {
  return {
    chargedBetMinor: "0",
    totalWinMinor: "12500",
    grid: [
      [cell("PRISM"), cell("ORBIT"), cell("PULSE")],
      [
        cell("VAULT", { prize: "MINI_2X", multiplier: 20 }),
        cell("VAULT", { prize: "MINOR", multiplier: 30 }),
        cell("VAULT", { prize: "MAJOR", multiplier: 75 }),
      ],
      [cell("CIRCUIT"), cell("TANK"), cell("NOVA")],
    ],
    wins: [],
    events: [
      { type: "vaults.landed", count: 3, cells: PUBLIC_KING_VAULT_CELLS },
      { type: "vaults.unlock.started", count: 3, cells: PUBLIC_KING_VAULT_CELLS },
      { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
      { type: "vault.unlocked", reel: 1, row: 1, prize: "MINOR", multiplier: 30 },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "MAJOR", multiplier: 75 },
      { type: "vaults.unlock.completed", count: 3, cells: PUBLIC_KING_VAULT_CELLS },
      { type: "vaults.upgrade.started", count: 1, step: 1 },
      {
        type: "vault.upgraded",
        reel: 1,
        row: 0,
        fromMultiplier: 10,
        toMultiplier: 20,
        prize: "MINI_2X",
        step: 1,
      },
      {
        type: "vault.awarded",
        reel: 1,
        row: 0,
        prize: "MINI_2X",
        multiplier: 20,
        amountMinor: "2000",
      },
      {
        type: "vault.awarded",
        reel: 1,
        row: 1,
        prize: "MINOR",
        multiplier: 30,
        amountMinor: "3000",
      },
      {
        type: "vault.awarded",
        reel: 1,
        row: 2,
        prize: "MAJOR",
        multiplier: 75,
        amountMinor: "7500",
      },
    ],
    featureState: activeFeatureState("OVERDRIVE", 6, "12500"),
  };
}

// 这是公开结果脚本的完整集合。它在所有结果固定的前提下覆盖 Rage、Wheel、
// Kong Quest、King Spin 与 Vault 表现，并阻止内部测试注册表进入 Pages。
const PUBLIC_ROUNDS: readonly PublicDemoRound[] = Object.freeze([
  publicWinRound("public-demo-low-win", "PRISM", "10"),
  publicBaseVaultRound(),
  publicFeatureTriggerRound("EXPANSION"),
  publicKongRound(3, 7),
  publicKongRound(5, 6),
  publicKongRound(8, 5),
  publicKongRound(6, 4),
  publicKongRound(7, 3),
  publicKongRound(4, 2),
  publicKongRound(8, 1),
  publicKongRound(3, 0, true),
  publicWinRound("public-demo-equal-bet", "NOVA", "100"),
  publicFeatureTriggerRound("OVERDRIVE"),
  publicKingIdleRound(7, "0"),
  publicKingVaultRound(),
  publicKingIdleRound(5, "12500"),
  publicKingIdleRound(4, "12500"),
  publicKingIdleRound(3, "12500"),
  publicKingIdleRound(2, "12500"),
  publicKingIdleRound(1, "12500"),
  publicKingIdleRound(0, "12500", true),
  publicMultiWayWildRound(),
  publicWinRound("public-demo-big-win", "CIRCUIT", "2000", 10),
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/** 供公开非经济 Demo 使用的专用有限数据协议端。 */
export class PublicStaticDemoGateway implements GameGateway {
  private callbacks: GatewayCallbacks = {
    onStatus: () => undefined,
    onSession: () => undefined,
    onSpinResult: () => undefined,
    onError: () => undefined,
  };
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sessionId = createRequestId("static-demo-session");
  private balanceMinor = BigInt(DEMO_STARTING_BALANCE_MINOR);
  private roundCursor = 0;
  private sequence = 0;
  private online = false;
  private closed = false;
  private pending = false;

  setCallbacks(callbacks: GatewayCallbacks): void {
    this.callbacks = callbacks;
  }

  get hasPendingSpin(): boolean {
    return this.pending;
  }

  connect(): void {
    if (this.online || this.timers.size > 0) return;
    this.closed = false;
    this.callbacks.onStatus("connecting");
    this.schedule(() => {
      this.online = true;
      this.callbacks.onStatus("online");
      const session: SessionOpened = immutableClone({
        type: "session.opened",
        protocolVersion: 1,
        engineRulesVersion: ENGINE_RULES_VERSION,
        definitionBinding: PRIMAL_PRESENTATION_DEFINITION_BINDINGS[0],
        requestId: createRequestId("static-demo-open"),
        sessionId: this.sessionId,
        currency: "XTS",
        currencyExponent: 2,
        balanceMinor: this.balanceMinor.toString(),
        betOptionsMinor: [DEMO_BET_MINOR],
        defaultBetMinor: DEMO_BET_MINOR,
        featureState: BASE_FEATURE,
      });
      this.callbacks.onSession(session);
    });
  }

  requestSpin(roundId: string, betMinor: MoneyMinor): boolean {
    const template = PUBLIC_ROUNDS[this.roundCursor % PUBLIC_ROUNDS.length];
    if (!this.online || this.closed || this.pending || !template
      || betMinor !== DEMO_BET_MINOR
      || !IDENTIFIER_PATTERN.test(roundId)
      || roundId.length > 128) return false;

    const settledBalance = this.balanceMinor - BigInt(template.chargedBetMinor)
      + BigInt(template.totalWinMinor);
    const result: SpinResult = immutableClone({
      type: "spin.result",
      protocolVersion: 1,
      requestId: createRequestId("static-demo-spin"),
      sessionId: this.sessionId,
      roundId,
      sequence: ++this.sequence,
      betMinor: DEMO_BET_MINOR,
      chargedBetMinor: template.chargedBetMinor,
      balanceMinor: settledBalance.toString(),
      totalWinMinor: template.totalWinMinor,
      grid: template.grid,
      wins: template.wins,
      events: template.events,
      featureState: template.featureState,
    });
    this.roundCursor += 1;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.balanceMinor = settledBalance;
      this.callbacks.onSpinResult(result);
    });
    return true;
  }

  close(): void {
    this.closed = true;
    this.online = false;
    this.pending = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.callbacks.onStatus("offline");
  }

  private schedule(deliver: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) deliver();
    }, 0);
    this.timers.add(timer);
  }
}
