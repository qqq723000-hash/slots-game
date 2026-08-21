import type { GameDefinitionBinding, SessionOpened } from "../app/state/types";
import { ENGINE_RULES_VERSION } from "../protocol/messages";

export const PRIMAL_PRESENTATION_RULES_VERSION = "primal-rampage-help-en-gb-v1" as const;

/**
 * 这份白名单只批准固定玩法文案的展示，不批准数学定义本身。
 * 数学定义每次变更都必须显式增加新的表现规则版本或重新审阅后扩充该列表。
 */
export const PRIMAL_PRESENTATION_DEFINITION_BINDINGS = Object.freeze([
  Object.freeze({
    gameId: "iron-colossus",
    definitionVersion: "local-production-2026-08-16.1",
    definitionHash: "96caac1ea4f82292ba96e0e0397459687638d6ff904471a8363e69f6e824d35d",
  }),
] as const satisfies readonly GameDefinitionBinding[]);

export interface PrimalHelpArtwork {
  readonly asset: string;
  readonly alt: string;
}

export interface PrimalHelpSection {
  readonly id:
    | "wild"
    | "vault"
    | "rage"
    | "primal-wheel"
    | "kong-quest"
    | "king-spin";
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly artwork: readonly PrimalHelpArtwork[];
}

/**
 * 仅抄录官方 en_GB locale 中的短玩法文案；顺序来自移动端 paytable 的作者时间线。
 * 保留原文的大小写、标点和语法，以便证据测试逐字核对。
 */
export const PRIMAL_HELP_SECTIONS = Object.freeze([
  Object.freeze({
    id: "wild",
    title: "WILD",
    paragraphs: Object.freeze([
      "Wild can land on reel 2.",
      "It substitute for all symbols except Vault Bonus and Rage Symbols.",
      "Wild can have a Multiplier of X2, X3, X5, X10, X25, X50 or X100.",
      "Only win combinations with Multiplier Wild is affected by the win Multiplier.",
    ]),
    artwork: Object.freeze([]),
  }),
  Object.freeze({
    id: "vault",
    title: "VAULT BONUS",
    paragraphs: Object.freeze([
      "Vault Bonus can land on reel 2.",
      "When Vault Bonus land, the Ape can smash the reels to unlock all the Vaults.",
      "Each Vault Bonus can award anywhere between GRAND, MEGA, MAJOR, MINOR, MINI, X9, X8, X7, X6, X5, X4, X3, X2 or X1",
    ]),
    artwork: Object.freeze([
      Object.freeze({ asset: "10031.png", alt: "Vault Bonus" }),
      Object.freeze({ asset: "10029.png", alt: "The Ape striking the Vaults" }),
      Object.freeze({ asset: "10030.png", alt: "The Ape collecting Vault rewards" }),
    ]),
  }),
  Object.freeze({
    id: "rage",
    title: "RAGE SYMBOL",
    paragraphs: Object.freeze([
      "Rage Symbols can land on any reel in the Base Game.",
      "Land 3 Rage Symbols to trigger the Primal Wheel!",
      "If 1 or 2 Rage Symbols have landed, the Ape collects it for a chance to trigger the Primal Wheel!",
    ]),
    artwork: Object.freeze([
      Object.freeze({ asset: "10028.png", alt: "Rage Symbols" }),
    ]),
  }),
  Object.freeze({
    id: "primal-wheel",
    title: "PRIMAL WHEEL",
    paragraphs: Object.freeze([
      "Spin the wheel for a chance to win GRAND X1000, MEGA X250, MAJOR X75, MINOR X30 or MINI X10 Bonus, or to trigger KONG QUEST or KING SPIN.",
      "The GRAND, MEGA, MAJOR, MINOR and MINI Bonuses are instantly rewarded if won.",
      "If the wheel stops at KONG QUEST or KING SPIN, the game proceeds to a Free Spin feature.",
    ]),
    artwork: Object.freeze([
      Object.freeze({ asset: "10027.png", alt: "Primal Wheel" }),
    ]),
  }),
  Object.freeze({
    id: "kong-quest",
    title: "KONG QUEST",
    paragraphs: Object.freeze([
      "Kong Quest can only trigger from the Primal Wheel!",
      "Starts with 8 initial Free Spins.",
      "Any spin during Kong Quest, the Ape stretches the reels, this makes the reel size different each spin.",
      "The reel sizes are random between 3x3, 3x4, 3x5, 3x6, 3x7, and up to 3x8.",
      "Vault Bonus contains the same reward as the Base Game but in Kong Quest, it can contain Free Spin.",
      "Unlock Vault Bonus with Free Spin to get 1 extra for each.",
    ]),
    artwork: Object.freeze([
      Object.freeze({ asset: "10026.png", alt: "Kong Quest on the Primal Wheel" }),
      Object.freeze({ asset: "10025.png", alt: "Expanded Kong Quest reels" }),
      Object.freeze({ asset: "10024.png", alt: "Kong Quest extra Free Spin reward" }),
    ]),
  }),
  Object.freeze({
    id: "king-spin",
    title: "KING SPIN",
    paragraphs: Object.freeze([
      "King Spin can only trigger from the Primal Wheel!",
      "Starts with 8 Free Spins.",
      "All Vault Bonus are instantly unlocked!",
      "When Vault Bonus land, the Ape can smash the reels multiple times to upgrade all the Vaults up to GRAND.",
      "Vaults during King Spin can reward MEGA2X, MAJOR2X, MINOR2X, and MINI2X which rewards double value of MEGA, MAJOR, MINOR and MINI.",
    ]),
    artwork: Object.freeze([
      Object.freeze({ asset: "10023.png", alt: "King Spin on the Primal Wheel" }),
      Object.freeze({ asset: "10022.png", alt: "Unlocked King Spin Vault" }),
      Object.freeze({ asset: "10020.png", alt: "Grand Vault reward" }),
    ]),
  }),
] as const satisfies readonly PrimalHelpSection[]);

export const PRIMAL_WAY_WINS_COPY =
  "Way Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols." as const;

export const PRIMAL_PRESENTATION_RULES = Object.freeze({
  schema: "slots-game-presentation-rules-v1",
  version: PRIMAL_PRESENTATION_RULES_VERSION,
  locale: "en_GB",
  sourceRevision: "1.2.1-primalrampage.471",
  scope: Object.freeze({
    engineRulesVersion: ENGINE_RULES_VERSION,
    definitionBindings: PRIMAL_PRESENTATION_DEFINITION_BINDINGS,
  }),
  sections: PRIMAL_HELP_SECTIONS,
  wayWins: PRIMAL_WAY_WINS_COPY,
});

export type PresentationRulesBindingStatus =
  | "bound"
  | "missing-binding"
  | "unsupported-binding"
  | "binding-drift";

export interface PresentationRulesSessionRecord {
  readonly sessionId: string;
  readonly engineRulesVersion: string | null;
  readonly definitionBinding: Readonly<GameDefinitionBinding> | null;
}

export interface PresentationRulesBindingResult {
  readonly status: PresentationRulesBindingStatus;
  /** 首次观察记录在同一 sessionId 内保持冻结；漂移时不会被新值覆盖。 */
  readonly record: Readonly<PresentationRulesSessionRecord>;
}

const DEFINITION_HASH_PATTERN = /^[a-f0-9]{64}$/;

function observedSessionRecord(session: Readonly<SessionOpened>): PresentationRulesSessionRecord {
  const rawBinding = session.definitionBinding;
  const definitionBinding = rawBinding
    && typeof rawBinding.gameId === "string"
    && typeof rawBinding.definitionVersion === "string"
    && typeof rawBinding.definitionHash === "string"
    && DEFINITION_HASH_PATTERN.test(rawBinding.definitionHash)
    ? Object.freeze({
        gameId: rawBinding.gameId,
        definitionVersion: rawBinding.definitionVersion,
        definitionHash: rawBinding.definitionHash,
      })
    : null;
  return Object.freeze({
    sessionId: session.sessionId,
    engineRulesVersion: typeof session.engineRulesVersion === "string"
      ? session.engineRulesVersion
      : null,
    definitionBinding,
  });
}

function sameDefinitionBinding(
  left: Readonly<GameDefinitionBinding> | null,
  right: Readonly<GameDefinitionBinding> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.gameId === right.gameId
    && left.definitionVersion === right.definitionVersion
    && left.definitionHash === right.definitionHash;
}

function sameObservedRecord(
  left: Readonly<PresentationRulesSessionRecord>,
  right: Readonly<PresentationRulesSessionRecord>,
): boolean {
  return left.sessionId === right.sessionId
    && left.engineRulesVersion === right.engineRulesVersion
    && sameDefinitionBinding(left.definitionBinding, right.definitionBinding);
}

function isApprovedDefinitionBinding(binding: Readonly<GameDefinitionBinding>): boolean {
  return PRIMAL_PRESENTATION_DEFINITION_BINDINGS.some((approved) => (
    approved.gameId === binding.gameId
    && approved.definitionVersion === binding.definitionVersion
    && approved.definitionHash === binding.definitionHash
  ));
}

/**
 * 固定玩法文案只有在完整会话绑定逐项匹配时才启用；缺失、未批准和同会话漂移均失败闭合。
 */
export function bindPrimalPresentationRules(
  previous: Readonly<PresentationRulesBindingResult> | null,
  session: Readonly<SessionOpened>,
): PresentationRulesBindingResult {
  const observed = observedSessionRecord(session);
  if (previous?.record.sessionId === observed.sessionId) {
    if (previous.status === "binding-drift") return previous;
    if (!sameObservedRecord(previous.record, observed)) {
      return Object.freeze({ status: "binding-drift", record: previous.record });
    }
  }
  if (observed.engineRulesVersion === null || observed.definitionBinding === null) {
    return Object.freeze({ status: "missing-binding", record: observed });
  }
  if (observed.engineRulesVersion !== PRIMAL_PRESENTATION_RULES.scope.engineRulesVersion
    || !isApprovedDefinitionBinding(observed.definitionBinding)) {
    return Object.freeze({ status: "unsupported-binding", record: observed });
  }
  return Object.freeze({ status: "bound", record: observed });
}
