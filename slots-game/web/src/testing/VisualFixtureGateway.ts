import type {
  FeatureEvent,
  FeatureState,
  GridCell,
  MoneyMinor,
  SessionOpened,
  SpinResult,
  Win,
} from "../app/state/types";
import {
  type GameGateway,
  type GatewayCallbacks,
} from "../protocol/GameGateway";
import { createRequestId } from "../protocol/messages";

const FIXTURE_BET_MINOR = "100" as const;
const FIXTURE_BALANCE_MINOR = "100000" as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

interface FixtureRound {
  readonly chargedBetMinor: MoneyMinor;
  readonly totalWinMinor: MoneyMinor;
  readonly grid: GridCell[][];
  readonly wins: Win[];
  readonly events: readonly FeatureEvent[];
  readonly featureState: FeatureState;
}

interface FixtureScenario {
  readonly initialFeatureState: FeatureState;
  readonly rounds: readonly FixtureRound[];
}

export const VISUAL_FIXTURE_SCENARIOS = [
  "big-win",
  "base-wild-reveal-x100",
  "base-vault-unlock-x2",
  "base-vault-locked-x6",
  "base-single-rage-no-wheel",
  "base-two-rage-no-wheel",
  "base-one-rage-trigger-transform",
  "base-rage-level-two-persistent-aura",
  "base-launch-level-two-intro",
  "base-rgs-recovered-level-up",
  "base-three-rage-wheel-entry",
  "win-effects-matrix",
  "normal-win-continue",
  "wheel-mini-flow",
  "autoplay-wheel-mini-resume",
  "king-flow",
  "high-pps-probability-king-exit",
  "king-upgrade-ladder",
  "kong-flow",
  "cap-summary",
  "summary-no-panel",
  "summary-no-panel-equal",
] as const;

export type VisualFixtureScenarioName = typeof VISUAL_FIXTURE_SCENARIOS[number];

const BASE_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};

const BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 2,
  rageCollected: 12,
};

// 当第四个 PPS 光环已激活时，概率性一 Rage Wheel 触发器的回归原点。官方RESET合约将每个触发器/Free Spins/终端状态预测为1级/总计0；因此，
// 从视觉上看，该装置暴露了任何 aura-4 或功能效果所有权，这些所有权在 Free Spins 摘要关闭后会泄漏回 Base 中。
const BASE_RAGE_LEVEL_FOUR_TRIGGER_ORIGIN_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 4,
  rageCollected: 36,
};

const BASE_RGS_RECOVERED_LEVEL_UP_ORIGIN_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 1,
  rageCollected: 11,
};

const BASE_RGS_RECOVERED_LEVEL_UP_FINAL_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  freeSpinsPlayed: 0,
  rageLevel: 2,
  rageCollected: 12,
};

const cell = (symbol: GridCell["symbol"], extras: Omit<GridCell, "symbol"> = {}): GridCell => ({
  symbol,
  ...extras,
});

const bigWinGrid: GridCell[][] = [
  [cell("PRISM"), cell("TANK"), cell("ORBIT")],
  [cell("PULSE"), cell("WILD", { multiplier: 100 }), cell("NOVA")],
  [cell("PRISM"), cell("TANK"), cell("CIRCUIT")],
];

// 外卷轴故意不共享付费符号。因此，Wild 的单一作者在没有创造中奖的情况下发挥了其真实的揭示路径。
const baseWildRevealX100Grid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
  [cell("NOVA"), cell("WILD", { multiplier: 100 }), cell("TANK")],
  [cell("CIRCUIT"), cell("NOVA"), cell("TANK")],
];
const baseVaultUnlockX2Grid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
  [cell("NOVA"), cell("TANK"), cell("VAULT", { prize: "X2", multiplier: 2 })],
  [cell("CIRCUIT"), cell("NOVA"), cell("TANK")],
];
const baseVaultUnlockX2Cell = [{ reel: 1, row: 2 }] as const;
// 官方 Fiddler 响应 43 证明服务端 ID 22 可以稳定存在并保持锁定。周围的静默网格仅供测试夹具使用；x6 牌面是准确的。
const baseVaultLockedX6Grid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
  [cell("NOVA"), cell("TANK"), cell("VAULT", { lockedVaultFace: "x6" })],
  [cell("CIRCUIT"), cell("NOVA"), cell("TANK")],
];
const baseVaultLockedX6Cell = [{ reel: 1, row: 2 }] as const;
const autoplayWheelResumeGrid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
  [cell("NOVA"), cell("TANK"), cell("CIRCUIT")],
  [cell("ORBIT"), cell("NOVA"), cell("TANK")],
];
const baseSingleRageNoWheelGrid: GridCell[][] = [
  // 官方预设的身份是 ORBIT = K / Symbol1 和 PRISM = Q / Symbol0，
  // 因此该测试场景逐像素渲染捕获的 K/Jet/K ... Tank/Tank/Q 板。
  [cell("ORBIT"), cell("CIRCUIT"), cell("ORBIT")],
  [cell("SURGE"), cell("PULSE"), cell("CIRCUIT")],
  [cell("TANK"), cell("TANK"), cell("PRISM")],
];
const baseTwoRageNoWheelGrid: GridCell[][] = [
  // Pass46 保留了自然视觉样本的两行 Rage 和最终的坦克卷轴，同时用免费喷气机替换了其上下文 X7 Wild。这将双源收集批次与 Wild 揭示/支付行为隔离开来。
  [cell("ORBIT"), cell("SURGE"), cell("PULSE")],
  [cell("PULSE"), cell("SURGE"), cell("CIRCUIT")],
  [cell("TANK"), cell("TANK"), cell("TANK")],
];
const baseTwoRageNoWheelCells = [
  { reel: 0, row: 1 },
  { reel: 1, row: 1 },
];
const baseOneRageTriggerTransformGrid: GridCell[][] = [
  // Pass47 冻结自然一Rage触发板。两个替换地址仍保留权威事件数据；它们永远不会在这里被选择，也不会被渲染器的修饰遍历顺序选择。
  [cell("ORBIT"), cell("SURGE"), cell("PULSE")],
  [cell("PULSE"), cell("CIRCUIT"), cell("PULSE")],
  [cell("NOVA"), cell("ORBIT"), cell("ORBIT")],
];
const baseOneRageTriggerSourceCells = [{ reel: 0, row: 1 }];
const baseOneRageTriggerTransformCells = [
  { reel: 1, row: 1 },
  { reel: 2, row: 1 },
];
const baseRageLevelTwoPersistentAuraGrid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("PRISM")],
  [cell("ORBIT"), cell("NOVA"), cell("ORBIT")],
  [cell("CIRCUIT"), cell("TANK"), cell("CIRCUIT")],
];
// 唯一的 Rage 符号是准确恢复的收集源。独特的外卷轴特性使灯具在经济上保持安静，同时耐用的表现执行权威的 1/11 -> 2/12 过渡。
const baseRgsRecoveredLevelUpGrid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("ORBIT")],
  [cell("SURGE"), cell("NOVA"), cell("TANK")],
  [cell("CIRCUIT"), cell("NOVA"), cell("TANK")],
];
const baseThreeRageWheelEntryGrid: GridCell[][] = [
  // 与冷冻 Pass45 自然视觉圆形相同的零基 Rage 单元格。卷轴2排3保留官方锁定的x1 Vault面。其余的非 Rage 单元格仍然不包含支付线中奖，
  // 因此 Wheel 条目遵循 1250ms 停止结尾，没有不相关的正常中奖覆盖。
  [cell("PRISM"), cell("SURGE"), cell("PULSE")],
  [cell("SURGE"), cell("NOVA"), cell("VAULT")],
  [cell("TANK"), cell("TANK"), cell("SURGE")],
];
const baseThreeRageWheelEntryCells = [
  { reel: 0, row: 1 },
  { reel: 1, row: 0 },
  { reel: 2, row: 2 },
];
const bigWinCells = [
  { reel: 0, row: 1 },
  { reel: 1, row: 1 },
  { reel: 2, row: 1 },
];

const kingTriggerGrid: GridCell[][] = [
  [cell("PRISM"), cell("SURGE"), cell("PULSE")],
  [cell("ORBIT"), cell("SURGE"), cell("NOVA")],
  [cell("CIRCUIT"), cell("SURGE"), cell("TANK")],
];
const rageCells = [
  { reel: 0, row: 1 },
  { reel: 1, row: 1 },
  { reel: 2, row: 1 },
];

const wheelMiniGrid: GridCell[][] = [
  [cell("CIRCUIT"), cell("SURGE"), cell("PRISM")],
  [cell("CIRCUIT"), cell("SURGE"), cell("NOVA")],
  [cell("CIRCUIT"), cell("SURGE"), cell("TANK")],
];

const kingVaultGrid: GridCell[][] = [
  [cell("PRISM"), cell("ORBIT"), cell("PULSE")],
  [
    cell("VAULT", { prize: "MINI_2X", multiplier: 20 }),
    cell("VAULT", { prize: "MINOR", multiplier: 30 }),
    cell("VAULT", { prize: "MAJOR", multiplier: 75 }),
  ],
  [cell("CIRCUIT"), cell("TANK"), cell("NOVA")],
];
const kingVaultCells = [
  { reel: 1, row: 0 },
  { reel: 1, row: 1 },
  { reel: 1, row: 2 },
];

const kingGrandVaultGrid: GridCell[][] = [
  [cell("PRISM"), cell("ORBIT"), cell("PULSE")],
  [
    cell("VAULT", { prize: "GRAND", multiplier: 1_000 }),
    cell("VAULT", { prize: "GRAND", multiplier: 1_000 }),
    cell("VAULT", { prize: "GRAND", multiplier: 1_000 }),
  ],
  [cell("CIRCUIT"), cell("TANK"), cell("NOVA")],
];

const featureIdleGrid: GridCell[][] = [
  [cell("PRISM"), cell("PULSE"), cell("PRISM")],
  [cell("ORBIT"), cell("NOVA"), cell("ORBIT")],
  [cell("CIRCUIT"), cell("TANK"), cell("CIRCUIT")],
];

function activeFeatureState(
  mode: Exclude<FeatureState["mode"], "BASE">,
  remaining: number,
  awarded: number,
  cumulativeWinMinor: MoneyMinor,
): FeatureState {
  return {
    mode,
    freeSpinsRemaining: remaining,
    freeSpinsPlayed: awarded - remaining,
    baseBetMinor: FIXTURE_BET_MINOR,
    freeSpinsWinMinor: cumulativeWinMinor,
    rageLevel: 1,
    rageCollected: 0,
  };
}

function kingIdleRound(
  remaining: number,
  cumulativeWinMinor: MoneyMinor,
  completed = false,
): FixtureRound {
  return {
    chargedBetMinor: "0",
    totalWinMinor: "0",
    grid: featureIdleGrid,
    wins: [],
    events: completed ? [{
      type: "free_spins.completed",
      mode: "OVERDRIVE",
      awarded: 8,
      cumulativeWinMinor,
    }] : [],
    featureState: completed
      ? BASE_FEATURE
      : activeFeatureState("OVERDRIVE", remaining, 8, cumulativeWinMinor),
  };
}

function kingUpgradeLadderRound(): FixtureRound {
  const events: FeatureEvent[] = [
    { type: "vaults.landed", count: 3, cells: kingVaultCells },
    { type: "vaults.unlock.started", count: 3, cells: kingVaultCells },
    { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
    { type: "vault.unlocked", reel: 1, row: 1, prize: "MINI", multiplier: 10 },
    { type: "vault.unlocked", reel: 1, row: 2, prize: "MINI", multiplier: 10 },
    { type: "vaults.unlock.completed", count: 3, cells: kingVaultCells },
    { type: "vaults.upgrade.started", count: 3, step: 1 },
    {
      type: "vault.upgraded", reel: 1, row: 0,
      fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
    },
    {
      type: "vault.upgraded", reel: 1, row: 1,
      fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
    },
    {
      type: "vault.upgraded", reel: 1, row: 2,
      fromMultiplier: 10, toMultiplier: 250, prize: "MEGA", step: 1,
    },
    { type: "vaults.upgrade.started", count: 3, step: 2 },
    {
      type: "vault.upgraded", reel: 1, row: 0,
      fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
    },
    {
      type: "vault.upgraded", reel: 1, row: 1,
      fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
    },
    {
      type: "vault.upgraded", reel: 1, row: 2,
      fromMultiplier: 250, toMultiplier: 1_000, prize: "GRAND", step: 2,
    },
    {
      type: "vault.awarded", reel: 1, row: 0,
      prize: "GRAND", multiplier: 1_000, amountMinor: "100000",
    },
    {
      type: "vault.awarded", reel: 1, row: 1,
      prize: "GRAND", multiplier: 1_000, amountMinor: "100000",
    },
    {
      type: "vault.awarded", reel: 1, row: 2,
      prize: "GRAND", multiplier: 1_000, amountMinor: "100000",
    },
  ];
  return {
    chargedBetMinor: "0",
    totalWinMinor: "300000",
    grid: kingGrandVaultGrid,
    wins: [],
    events,
    featureState: activeFeatureState("OVERDRIVE", 6, 8, "300000"),
  };
}

function expandedNoWinGrid(rows: number, freeSpinVaultRow?: number): GridCell[][] {
  return [
    Array.from({ length: rows }, (_, row) => cell(row % 2 === 0 ? "PRISM" : "PULSE")),
    Array.from({ length: rows }, (_, row) => (
      row === freeSpinVaultRow
        ? cell("VAULT", { prize: "FREE_SPIN" })
        : cell(row % 2 === 0 ? "ORBIT" : "NOVA")
    )),
    Array.from({ length: rows }, (_, row) => cell(row % 2 === 0 ? "CIRCUIT" : "TANK")),
  ];
}

const orbit512Grid: GridCell[][] = Array.from(
  { length: 3 },
  () => Array.from({ length: 8 }, () => cell("ORBIT")),
);
const orbit512Cells = Array.from({ length: 3 }, (_, reel) => (
  Array.from({ length: 8 }, (_, row) => ({ reel, row }))
)).flat();
const orbit512PathAwards = Array.from({ length: 8 }, (_, left) => (
  Array.from({ length: 8 }, (_, middle) => (
    Array.from({ length: 8 }, (_, right) => ({
      cells: [
        { reel: 0, row: left },
        { reel: 1, row: middle },
        { reel: 2, row: right },
      ],
      multiplier: 1,
      baseAmountMinor: "30",
      amountMinor: "30",
    }))
  )).flat()
)).flat();
const orbit512Win: Win = {
  id: "orbit-512-ways",
  symbol: "ORBIT",
  ways: 512,
  amountMinor: "15360",
  multiplier: 1,
  cells: orbit512Cells,
  pathAwards: orbit512PathAwards,
};

function kongRound(
  rows: number,
  remaining: number,
  awarded: number,
  cumulativeWinMinor: MoneyMinor,
  options: {
    readonly win512?: boolean;
    readonly retrigger?: boolean;
    readonly completed?: boolean;
  } = {},
): FixtureRound {
  const vaultRow = options.retrigger ? 2 : undefined;
  const grid = options.win512 ? orbit512Grid : expandedNoWinGrid(rows, vaultRow);
  const events: FeatureEvent[] = [{ type: "grid.expanded", rows, ways: rows ** 3 }];
  if (options.retrigger) {
    const cells = [{ reel: 1, row: 2 }] as const;
    events.push(
      { type: "vaults.landed", count: 1, cells },
      { type: "vaults.unlock.started", count: 1, cells },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
      { type: "vaults.unlock.completed", count: 1, cells },
    );
  }
  if (options.completed) {
    events.push({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded,
      cumulativeWinMinor,
    });
  }
  return {
    chargedBetMinor: "0",
    totalWinMinor: options.win512 ? "15360" : "0",
    grid,
    wins: options.win512 ? [orbit512Win] : [],
    events,
    featureState: options.completed
      ? BASE_FEATURE
      : activeFeatureState("EXPANSION", remaining, awarded, cumulativeWinMinor),
  };
}

function expandedGrid(withVault = false, rows = 8): GridCell[][] {
  const grid: GridCell[][] = [
    [cell("TANK"), cell("PRISM"), cell("ORBIT"), cell("PULSE"), cell("NOVA"), cell("CIRCUIT"), cell("PRISM"), cell("ORBIT")],
    [cell("TANK"), cell("PULSE"), cell(withVault ? "VAULT" : "NOVA", withVault ? { prize: "FREE_SPIN" } : {}), cell("ORBIT"), cell("PRISM"), cell("CIRCUIT"), cell("NOVA"), cell("PULSE")],
    [cell("TANK"), cell("ORBIT"), cell("PRISM"), cell("NOVA"), cell("PULSE"), cell("CIRCUIT"), cell("ORBIT"), cell("PRISM")],
  ];
  return grid.map((reel) => reel.slice(0, rows));
}

const tankWin = (amountMinor: MoneyMinor): Win => ({
  id: "tank-path",
  symbol: "TANK",
  ways: 1,
  amountMinor,
  cells: [
    { reel: 0, row: 0 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ],
  pathAwards: [{
    cells: [
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
    ],
    multiplier: 1,
    baseAmountMinor: amountMinor,
    amountMinor,
  }],
});

/** 捕获的 Base 赔率表：Jet/CIRCUIT 为三卷轴路径支付 2 倍总投注额。 */
const jetWin = (amountMinor: MoneyMinor): Win => ({
  id: "jet-path",
  symbol: "CIRCUIT",
  ways: 1,
  amountMinor,
  cells: [
    { reel: 0, row: 0 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ],
  pathAwards: [{
    cells: [
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
    ],
    multiplier: 1,
    baseAmountMinor: amountMinor,
    amountMinor,
  }],
});

const FIXTURE_PAYING_SYMBOLS = [
  "ORBIT", "PRISM", "PULSE", "NOVA", "CIRCUIT", "TANK",
] as const;
type FixturePayingSymbol = typeof FIXTURE_PAYING_SYMBOLS[number];

function ordinaryWinGrid(symbol: FixturePayingSymbol, middle: GridCell): GridCell[][] {
  const fillers = FIXTURE_PAYING_SYMBOLS.filter((candidate) => candidate !== symbol);
  return [
    [cell(symbol), cell(fillers[0]!), cell(fillers[1]!)],
    [middle, cell(fillers[2]!), cell(fillers[3]!)],
    [cell(symbol), cell(fillers[2]!), cell(fillers[3]!)],
  ];
}

function ordinaryBaseWinRound(
  id: string,
  symbol: FixturePayingSymbol,
  amountMinor: MoneyMinor,
  wildMultiplier = 1,
): FixtureRound {
  const multiplier = wildMultiplier;
  const baseAmountMinor = (BigInt(amountMinor) / BigInt(multiplier)).toString();
  const pathCells = [
    { reel: 0, row: 0 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const win: Win = {
    id,
    symbol,
    ways: 1,
    amountMinor,
    multiplier,
    cells: pathCells,
    pathAwards: [{
      cells: pathCells,
      multiplier,
      baseAmountMinor,
      amountMinor,
    }],
  };
  return {
    chargedBetMinor: FIXTURE_BET_MINOR,
    totalWinMinor: amountMinor,
    grid: ordinaryWinGrid(symbol, multiplier > 1
      ? cell("WILD", { multiplier })
      : cell(symbol)),
    wins: [win],
    events: [],
    featureState: BASE_FEATURE,
  };
}

function multiRecordWildRound(): FixtureRound {
  const prismCells = [
    { reel: 0, row: 0 },
    { reel: 0, row: 1 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const firstPrismPath = [
    { reel: 0, row: 0 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const secondPrismPath = [
    { reel: 0, row: 1 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const orbitCells = [
    { reel: 0, row: 2 },
    { reel: 1, row: 0 },
    { reel: 2, row: 2 },
  ];
  return {
    chargedBetMinor: FIXTURE_BET_MINOR,
    totalWinMinor: "100",
    grid: [
      [cell("PRISM"), cell("PRISM"), cell("ORBIT")],
      [cell("WILD", { multiplier: 2 }), cell("NOVA"), cell("TANK")],
      [cell("PRISM"), cell("NOVA"), cell("ORBIT")],
    ],
    wins: [
      {
        id: "matrix-prism-wild-x2-two-ways",
        symbol: "PRISM",
        ways: 2,
        amountMinor: "40",
        multiplier: 2,
        cells: prismCells,
        pathAwards: [firstPrismPath, secondPrismPath].map((cells) => ({
          cells,
          multiplier: 2,
          baseAmountMinor: "10",
          amountMinor: "20",
        })),
      },
      {
        id: "matrix-orbit-wild-x2",
        symbol: "ORBIT",
        ways: 1,
        amountMinor: "60",
        multiplier: 2,
        cells: orbitCells,
        pathAwards: [{
          cells: orbitCells,
          multiplier: 2,
          baseAmountMinor: "30",
          amountMinor: "60",
        }],
      },
    ],
    events: [],
    featureState: BASE_FEATURE,
  };
}

/**
 * Pass 40：1个普通Base成绩，有2个权威中奖记录。
 *
 * 记录 0 故意输入 SEPARATE_DELAYED 乘数与四个唯一突出显示的单元格合并。
 * 浏览器测试场景在 `merge-start` 之后立即单击真正的主 Continue 控件；记录 1 是在接受的交互之后绝不能变得可见的哨兵。
 */
function normalWinContinueRound(): FixtureRound {
  const firstCells = [
    { reel: 0, row: 0 },
    { reel: 0, row: 1 },
    { reel: 1, row: 0 },
    { reel: 2, row: 0 },
  ];
  const firstPaths = [
    [
      { reel: 0, row: 0 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
    ],
    [
      { reel: 0, row: 1 },
      { reel: 1, row: 0 },
      { reel: 2, row: 0 },
    ],
  ];
  const secondCells = [
    { reel: 0, row: 2 },
    { reel: 1, row: 1 },
    { reel: 2, row: 2 },
  ];
  return {
    chargedBetMinor: FIXTURE_BET_MINOR,
    totalWinMinor: "800",
    grid: [
      [cell("PRISM"), cell("PRISM"), cell("ORBIT")],
      [cell("WILD", { multiplier: 5 }), cell("ORBIT"), cell("TANK")],
      [cell("PRISM"), cell("NOVA"), cell("ORBIT")],
    ],
    wins: [
      {
        id: "continue-prism-wild-x5-four-boxes",
        symbol: "PRISM",
        ways: 2,
        amountMinor: "500",
        multiplier: 5,
        cells: firstCells,
        pathAwards: firstPaths.map((cells) => ({
          cells,
          multiplier: 5,
          baseAmountMinor: "50",
          amountMinor: "250",
        })),
      },
      {
        id: "continue-orbit-plain-sentinel",
        symbol: "ORBIT",
        ways: 1,
        amountMinor: "300",
        multiplier: 1,
        cells: secondCells,
        pathAwards: [{
          cells: secondCells,
          multiplier: 1,
          baseAmountMinor: "300",
          amountMinor: "300",
        }],
      },
    ],
    events: [],
    featureState: BASE_FEATURE,
  };
}

function expansionTriggerRound(): FixtureRound {
  return {
    chargedBetMinor: "100",
    totalWinMinor: "0",
    grid: kingTriggerGrid,
    wins: [],
    events: [
      {
        type: "surge.collected",
        count: 3,
        cells: rageCells,
        triggered: true,
        guaranteed: true,
        level: 1,
        total: 0,
      },
      { type: "wheel.started" },
      { type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" },
      { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
    ],
    featureState: activeFeatureState("EXPANSION", 8, 8, "0"),
  };
}

function cappedVaultRound(remaining: number): FixtureRound {
  const cells = [{ reel: 1, row: 2 }] as const;
  return {
    chargedBetMinor: "0",
    totalWinMinor: "0",
    grid: expandedGrid(true),
    wins: [],
    events: [
      { type: "grid.expanded", rows: 8, ways: 512 },
      { type: "vaults.landed", count: 1, cells },
      { type: "vaults.unlock.started", count: 1, cells },
      { type: "vault.unlocked", reel: 1, row: 2, prize: "FREE_SPIN" },
      { type: "free_spin.cap_reached", reel: 1, row: 2 },
      { type: "vaults.unlock.completed", count: 1, cells },
    ],
    featureState: activeFeatureState("EXPANSION", remaining, 8, "0"),
  };
}

function kongTankWinRound(
  rows: number,
  remaining: number,
  amountMinor: MoneyMinor,
  cumulativeWinMinor: MoneyMinor,
  completed = false,
): FixtureRound {
  const events: FeatureEvent[] = [{ type: "grid.expanded", rows, ways: rows ** 3 }];
  if (completed) {
    events.push({
      type: "free_spins.completed",
      mode: "EXPANSION",
      awarded: 8,
      cumulativeWinMinor,
    });
  }
  return {
    chargedBetMinor: "0",
    totalWinMinor: amountMinor,
    grid: expandedGrid(false, rows),
    wins: [tankWin(amountMinor)],
    events,
    featureState: completed
      ? BASE_FEATURE
      : activeFeatureState("EXPANSION", remaining, 8, cumulativeWinMinor),
  };
}

const SCENARIOS: Readonly<Record<VisualFixtureScenarioName, FixtureScenario>> = {
  "big-win": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "15000",
      grid: bigWinGrid,
      wins: [{
        id: "tank-wild-x100",
        symbol: "TANK",
        ways: 1,
        amountMinor: "15000",
        multiplier: 100,
        cells: bigWinCells,
        pathAwards: [{
          cells: bigWinCells,
          multiplier: 100,
          baseAmountMinor: "150",
          amountMinor: "15000",
        }],
      }],
      events: [],
      featureState: BASE_FEATURE,
    }],
  },
  "base-wild-reveal-x100": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseWildRevealX100Grid,
      wins: [],
      events: [],
      featureState: BASE_FEATURE,
    }],
  },
  "base-vault-unlock-x2": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "200",
      grid: baseVaultUnlockX2Grid,
      wins: [],
      events: [
        { type: "vaults.landed", count: 1, cells: baseVaultUnlockX2Cell },
        { type: "vaults.unlock.started", count: 1, cells: baseVaultUnlockX2Cell },
        { type: "vault.unlocked", reel: 1, row: 2, prize: "X2", multiplier: 2 },
        {
          type: "vault.awarded",
          reel: 1,
          row: 2,
          prize: "X2",
          multiplier: 2,
          amountMinor: "200",
        },
        { type: "vaults.unlock.completed", count: 1, cells: baseVaultUnlockX2Cell },
      ],
      featureState: BASE_FEATURE,
    }],
  },
  "base-vault-locked-x6": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseVaultLockedX6Grid,
      wins: [],
      events: [
        { type: "vaults.landed", count: 1, cells: baseVaultLockedX6Cell },
        { type: "vaults.locked", count: 1, cells: baseVaultLockedX6Cell },
      ],
      featureState: BASE_FEATURE,
    }],
  },
  "base-single-rage-no-wheel": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseSingleRageNoWheelGrid,
      wins: [],
      events: [{
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 1, row: 0 }],
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 1,
      }],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 1,
      },
    }],
  },
  "base-two-rage-no-wheel": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseTwoRageNoWheelGrid,
      wins: [],
      events: [{
        type: "surge.collected",
        count: 2,
        cells: baseTwoRageNoWheelCells,
        triggered: false,
        guaranteed: false,
        level: 1,
        total: 2,
      }],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 2,
      },
    }],
  },
  "base-one-rage-trigger-transform": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "1000",
      grid: baseOneRageTriggerTransformGrid,
      wins: [],
      events: [
        {
          type: "surge.collected",
          count: 1,
          cells: baseOneRageTriggerSourceCells,
          triggered: true,
          guaranteed: false,
          level: 1,
          total: 0,
        },
        {
          type: "rage.transformed",
          count: 2,
          cells: baseOneRageTriggerTransformCells,
          level: 1,
          total: 0,
        },
        { type: "wheel.started" },
        {
          type: "wheel.awarded",
          outcome: "INSTANT",
          prize: "MINI",
          multiplier: 10,
          amountMinor: "1000",
        },
      ],
      featureState: {
        mode: "BASE",
        freeSpinsRemaining: 0,
        rageLevel: 1,
        rageCollected: 0,
      },
    }],
  },
  "base-rage-level-two-persistent-aura": {
    initialFeatureState: BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseRageLevelTwoPersistentAuraGrid,
      wins: [],
      events: [],
      featureState: BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_FEATURE,
    }],
  },
  "base-launch-level-two-intro": {
    initialFeatureState: BASE_RAGE_LEVEL_TWO_PERSISTENT_AURA_FEATURE,
    // Pass50 仅观察预设的启动 INTRO -> LOOP 切换。将回合脚本保持为空会使意外旋转在协议边界处失败，而不是为屏幕截图制作游戏逻辑。
    rounds: [],
  },
  "base-rgs-recovered-level-up": {
    initialFeatureState: BASE_RGS_RECOVERED_LEVEL_UP_ORIGIN_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "0",
      grid: baseRgsRecoveredLevelUpGrid,
      wins: [],
      events: [{
        type: "surge.collected",
        count: 1,
        cells: [{ reel: 1, row: 0 }],
        triggered: false,
        guaranteed: false,
        level: 2,
        total: 12,
      }],
      featureState: BASE_RGS_RECOVERED_LEVEL_UP_FINAL_FEATURE,
    }],
  },
  "base-three-rage-wheel-entry": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "1000",
      grid: baseThreeRageWheelEntryGrid,
      wins: [],
      events: [
        { type: "vaults.landed", count: 1, cells: [{ reel: 1, row: 2 }] },
        { type: "vaults.locked", count: 1, cells: [{ reel: 1, row: 2 }] },
        {
          type: "surge.collected",
          count: 3,
          cells: baseThreeRageWheelEntryCells,
          triggered: true,
          guaranteed: true,
          level: 1,
          total: 0,
        },
        { type: "wheel.started" },
        {
          type: "wheel.awarded",
          outcome: "INSTANT",
          prize: "MINI",
          multiplier: 10,
          amountMinor: "1000",
        },
      ],
      featureState: BASE_FEATURE,
    }],
  },
  "win-effects-matrix": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      ordinaryBaseWinRound("matrix-below-bet", "PRISM", "10"),
      ordinaryBaseWinRound("matrix-equal-bet", "NOVA", "100"),
      ordinaryBaseWinRound("matrix-strict-celebratory", "TANK", "150"),
      ordinaryBaseWinRound("matrix-payout-ladder-start", "CIRCUIT", "200"),
      multiRecordWildRound(),
      ordinaryBaseWinRound("matrix-big-win-boundary", "CIRCUIT", "2000", 10),
    ],
  },
  "normal-win-continue": {
    initialFeatureState: BASE_FEATURE,
    rounds: [normalWinContinueRound()],
  },
  "wheel-mini-flow": {
    initialFeatureState: BASE_FEATURE,
    rounds: [{
      chargedBetMinor: "100",
      totalWinMinor: "1200",
      grid: wheelMiniGrid,
      wins: [jetWin("200")],
      events: [
        {
          type: "surge.collected",
          count: 3,
          cells: rageCells,
          triggered: true,
          guaranteed: true,
          level: 1,
          total: 0,
        },
        { type: "wheel.started" },
        {
          type: "wheel.awarded",
          outcome: "INSTANT",
          prize: "MINI",
          multiplier: 10,
          amountMinor: "1000",
        },
      ],
      featureState: BASE_FEATURE,
    }],
  },
  "autoplay-wheel-mini-resume": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      {
        chargedBetMinor: "100",
        totalWinMinor: "1200",
        grid: wheelMiniGrid,
        wins: [jetWin("200")],
        events: [
          {
            type: "surge.collected",
            count: 3,
            cells: rageCells,
            triggered: true,
            guaranteed: true,
            level: 1,
            total: 0,
          },
          { type: "wheel.started" },
          {
            type: "wheel.awarded",
            outcome: "INSTANT",
            prize: "MINI",
            multiplier: 10,
            amountMinor: "1000",
          },
        ],
        featureState: BASE_FEATURE,
      },
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: autoplayWheelResumeGrid,
        wins: [],
        events: [],
        featureState: BASE_FEATURE,
      },
    ],
  },
  "king-flow": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: kingTriggerGrid,
        wins: [],
        events: [
          {
            type: "surge.collected",
            count: 3,
            cells: rageCells,
            triggered: true,
            guaranteed: true,
            level: 1,
            total: 0,
          },
          { type: "wheel.started" },
          { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
          { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
        ],
        featureState: {
          mode: "OVERDRIVE",
          freeSpinsRemaining: 8,
          freeSpinsPlayed: 0,
          baseBetMinor: "100",
          freeSpinsWinMinor: "0",
          rageLevel: 1,
          rageCollected: 0,
        },
      },
      kingIdleRound(7, "0"),
      {
        chargedBetMinor: "0",
        totalWinMinor: "12500",
        grid: kingVaultGrid,
        wins: [],
        events: [
          { type: "vaults.landed", count: 3, cells: kingVaultCells },
          { type: "vaults.unlock.started", count: 3, cells: kingVaultCells },
          { type: "vault.unlocked", reel: 1, row: 0, prize: "MINI", multiplier: 10 },
          { type: "vault.unlocked", reel: 1, row: 1, prize: "MINOR", multiplier: 30 },
          { type: "vault.unlocked", reel: 1, row: 2, prize: "MAJOR", multiplier: 75 },
          { type: "vaults.unlock.completed", count: 3, cells: kingVaultCells },
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
        featureState: activeFeatureState("OVERDRIVE", 6, 8, "12500"),
      },
      kingIdleRound(5, "12500"),
      kingIdleRound(4, "12500"),
      kingIdleRound(3, "12500"),
      kingIdleRound(2, "12500"),
      kingIdleRound(1, "12500"),
      kingIdleRound(0, "12500", true),
    ],
  },
  "high-pps-probability-king-exit": {
    initialFeatureState: BASE_RAGE_LEVEL_FOUR_TRIGGER_ORIGIN_FEATURE,
    rounds: [
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: baseOneRageTriggerTransformGrid,
        wins: [],
        events: [
          {
            type: "surge.collected",
            count: 1,
            cells: baseOneRageTriggerSourceCells,
            triggered: true,
            guaranteed: false,
            level: 1,
            total: 0,
          },
          {
            type: "rage.transformed",
            count: 2,
            cells: baseOneRageTriggerTransformCells,
            level: 1,
            total: 0,
          },
          { type: "wheel.started" },
          { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
          { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
        ],
        featureState: activeFeatureState("OVERDRIVE", 8, 8, "0"),
      },
      kingIdleRound(7, "0"),
      kingIdleRound(6, "0"),
      kingIdleRound(5, "0"),
      kingIdleRound(4, "0"),
      kingIdleRound(3, "0"),
      kingIdleRound(2, "0"),
      kingIdleRound(1, "0"),
      kingIdleRound(0, "0", true),
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: featureIdleGrid,
        wins: [],
        events: [],
        featureState: BASE_FEATURE,
      },
    ],
  },
  "king-upgrade-ladder": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: kingTriggerGrid,
        wins: [],
        events: [
          {
            type: "surge.collected",
            count: 3,
            cells: rageCells,
            triggered: true,
            guaranteed: true,
            level: 1,
            total: 0,
          },
          { type: "wheel.started" },
          { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" },
          { type: "free_spins.started", mode: "OVERDRIVE", awarded: 8 },
        ],
        featureState: activeFeatureState("OVERDRIVE", 8, 8, "0"),
      },
      kingIdleRound(7, "0"),
      kingUpgradeLadderRound(),
      kingIdleRound(5, "300000"),
      kingIdleRound(4, "300000"),
      kingIdleRound(3, "300000"),
      kingIdleRound(2, "300000"),
      kingIdleRound(1, "300000"),
      kingIdleRound(0, "300000", true),
    ],
  },
  "kong-flow": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      {
        chargedBetMinor: "100",
        totalWinMinor: "0",
        grid: kingTriggerGrid,
        wins: [],
        events: [
          {
            type: "surge.collected",
            count: 3,
            cells: rageCells,
            triggered: true,
            guaranteed: true,
            level: 1,
            total: 0,
          },
          { type: "wheel.started" },
          { type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" },
          { type: "free_spins.started", mode: "EXPANSION", awarded: 8 },
        ],
        featureState: activeFeatureState("EXPANSION", 8, 8, "0"),
      },
      kongRound(3, 7, 8, "0"),
      kongRound(5, 6, 8, "0"),
      kongRound(8, 5, 8, "15360", { win512: true }),
      kongRound(8, 5, 9, "15360", { retrigger: true }),
      kongRound(6, 4, 9, "15360"),
      kongRound(7, 3, 9, "15360"),
      kongRound(4, 2, 9, "15360"),
      kongRound(8, 1, 9, "15360"),
      kongRound(3, 0, 9, "15360", { completed: true }),
    ],
  },
  "cap-summary": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      expansionTriggerRound(),
      cappedVaultRound(7),
      cappedVaultRound(6),
      kongRound(3, 5, 8, "0"),
      kongRound(3, 4, 8, "0"),
      kongRound(3, 3, 8, "0"),
      kongRound(3, 2, 8, "0"),
      kongRound(3, 1, 8, "0"),
      kongTankWinRound(8, 0, "350", "350", true),
    ],
  },
  "summary-no-panel": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      expansionTriggerRound(),
      kongRound(3, 7, 8, "0"),
      kongRound(3, 6, 8, "0"),
      kongRound(3, 5, 8, "0"),
      kongRound(3, 4, 8, "0"),
      kongRound(3, 3, 8, "0"),
      kongRound(3, 2, 8, "0"),
      kongRound(3, 1, 8, "0"),
      kongRound(8, 0, 8, "0", { completed: true }),
    ],
  },
  "summary-no-panel-equal": {
    initialFeatureState: BASE_FEATURE,
    rounds: [
      expansionTriggerRound(),
      kongRound(3, 7, 8, "0"),
      kongRound(3, 6, 8, "0"),
      kongRound(3, 5, 8, "0"),
      kongRound(3, 4, 8, "0"),
      kongRound(3, 3, 8, "0"),
      kongRound(3, 2, 8, "0"),
      kongTankWinRound(3, 1, "100", "100"),
      kongRound(8, 0, 8, "100", { completed: true }),
    ],
  },
};

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function isVisualFixtureScenario(value: string): value is VisualFixtureScenarioName {
  return (VISUAL_FIXTURE_SCENARIOS as readonly string[]).includes(value);
}

/** 仅由 visual-fixtures.html 使用的确定性协议对等体。 */
export class VisualFixtureGateway implements GameGateway {
  private callbacks: GatewayCallbacks = {
    onStatus: () => undefined,
    onSession: () => undefined,
    onSpinResult: () => undefined,
    onError: () => undefined,
  };
  private readonly scenario: FixtureScenario;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sessionId = createRequestId("fixture-session");
  private balanceMinor = BigInt(FIXTURE_BALANCE_MINOR);
  private roundCursor = 0;
  private sequence = 0;
  private online = false;
  private closed = false;
  private pending = false;

  constructor(readonly scenarioName: VisualFixtureScenarioName) {
    this.scenario = SCENARIOS[scenarioName];
  }

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
        requestId: createRequestId("fixture-open"),
        sessionId: this.sessionId,
        balanceMinor: this.balanceMinor.toString(),
        betOptionsMinor: [FIXTURE_BET_MINOR],
        defaultBetMinor: FIXTURE_BET_MINOR,
        featureState: this.scenario.initialFeatureState,
      });
      this.callbacks.onSession(session);
    });
  }

  requestSpin(roundId: string, betMinor: MoneyMinor): boolean {
    const template = this.scenario.rounds[this.roundCursor];
    if (!this.online || this.closed || this.pending || !template
      || betMinor !== FIXTURE_BET_MINOR
      || !IDENTIFIER_PATTERN.test(roundId)
      || roundId.length > 128) return false;

    const charged = BigInt(template.chargedBetMinor);
    const totalWin = BigInt(template.totalWinMinor);
    if (charged > this.balanceMinor) return false;
    const settledBalance = this.balanceMinor - charged + totalWin;
    const result: SpinResult = immutableClone({
      type: "spin.result",
      protocolVersion: 1,
      requestId: createRequestId("fixture-spin"),
      sessionId: this.sessionId,
      roundId,
      sequence: ++this.sequence,
      betMinor: FIXTURE_BET_MINOR,
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
