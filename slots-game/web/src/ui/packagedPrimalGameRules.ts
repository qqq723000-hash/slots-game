/**
 * 从原版 en_GB Game Rules 页面获取并随包提供的 Primal Rampage 公开玩法文案。
 * 这只是客户端展示数据：不代表操作方审批或监管条款，也不是游戏数学的权威来源。
 */

export type PackagedPrimalGameRulesSectionId =
  | "information"
  | "game-rules"
  | "wild"
  | "vault-bonus"
  | "rage-symbol"
  | "primal-wheel"
  | "kong-quest-free-spins"
  | "king-spin-free-spins"
  | "actions";

export interface PackagedPrimalGameRulesAction {
  readonly title: string;
  readonly description: string;
}

export interface PackagedPrimalGameRulesSection {
  readonly id: PackagedPrimalGameRulesSectionId;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly actions: readonly PackagedPrimalGameRulesAction[];
}

export interface PackagedPrimalGameRulesPage {
  readonly locale: "en_GB";
  readonly pageTitle: "Primal Rampage";
  readonly sections: readonly PackagedPrimalGameRulesSection[];
}

const NO_ACTIONS = Object.freeze([]) as readonly PackagedPrimalGameRulesAction[];

function rulesSection(
  id: Exclude<PackagedPrimalGameRulesSectionId, "actions">,
  title: string,
  paragraphs: readonly string[],
): PackagedPrimalGameRulesSection {
  return Object.freeze({
    id,
    title,
    paragraphs: Object.freeze([...paragraphs]),
    actions: NO_ACTIONS,
  });
}

function action(
  title: string,
  description: string,
): PackagedPrimalGameRulesAction {
  return Object.freeze({ title, description });
}

const ACTIONS = Object.freeze([
  action("Paytable", "Toggles the display of the paytable."),
  action(
    "Auto Play",
    "Click the AUTO PLAY button to enable/disable the Auto Play feature. In Auto Play mode, a number of consecutive game rounds are initiated automatically using your current bet settings. The Auto Play mode is automatically disabled depending on your settings or if your balance becomes too low.",
  ),
  action(
    "Spin / Start / Spacebar",
    "Starts the game round with the currently selected bet. Press Spin to begin.",
  ),
  action("Stop", "Stops the reels more quickly."),
  action("Fast Play", "Toggle on for a significantly faster gameplay."),
]);

const SECTIONS = Object.freeze([
  rulesSection(
    "information",
    "Information",
    [
      "Way wins are awarded for adjacent symbol combinations, according to the information in the paytable and game rules. When winning on multiple ways in a single game round, all winnings are added together. All winnings from Features (such as Free Spins), Bonus Games and/or Scatters (if applicable) are also added to way wins. All winning combinations are paid out at the end of a game round. Free Spin features are played with the same bet as the game round that triggered the feature – unless otherwise stated. The bet cannot be changed during a currently running game round. Please refer to the game rules for more information. All wins pay left to right, beginning with the left-most reel. Only the highest win is paid per winning symbol combination.",
    ],
  ),
  rulesSection(
    "game-rules",
    "Game Rules",
    [
      "Primal Rampage is a 3-Reel Video Slot without paylines. Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols.",
    ],
  ),
  rulesSection(
    "wild",
    "WILD",
    [
      "Wild can land on reel 2. It substitute for all symbols except Vault Bonus and Rage Symbols. Wild can have a Multiplier of X2, X3, X5, X10, X25, X50 or X100. Only win combinations with Multiplier Wild is affected by the win Multiplier.",
    ],
  ),
  rulesSection(
    "vault-bonus",
    "VAULT BONUS",
    [
      "Vault Bonus can land on reel 2. When Vault Bonus land, the Ape can smash the reels to unlock all the Vaults. Each Vault Bonus can award anywhere between GRAND (X1000), MEGA (X250), MAJOR (X75), MINOR (X30), MINI (X10), X9, X8, X7, X6, X5, X4, X3, X2 or X1. The winnings from the Vault Bonus is equivalent to its Multiplier times the Total Bet.",
    ],
  ),
  rulesSection(
    "rage-symbol",
    "RAGE SYMBOL",
    [
      "Rage Symbols can land on any reel in the Base Game. Land 3 Rage Symbols to trigger the Primal Wheel! If 1 or 2 Rage Symbols have landed, the Ape collects it for a chance to trigger the Primal Wheel!",
    ],
  ),
  rulesSection(
    "primal-wheel",
    "PRIMAL WHEEL",
    [
      "Spin the wheel for a chance to win GRAND (X1000), MEGA (X250), MAJOR (X75), MINOR (X30) or MINI (X10) Bonus, or to trigger KONG QUEST or KING SPIN. The GRAND, MEGA, MAJOR, MINOR and MINI Bonuses are instantly rewarded if won. The winnings from GRAND, MEGA, MAJOR, MINOR and MINI Bonuses is equivalent to its Multiplier times the Total Bet. If the wheel stops at KONG QUEST or KING SPIN, the game proceeds to a Free Spin feature. The PRIMAL WHEEL presentation does not reflect real probabilities.",
    ],
  ),
  rulesSection(
    "kong-quest-free-spins",
    "KONG QUEST FREE SPINS",
    [
      "Kong Quest can only trigger from the Primal Wheel! Starts with 8 initial Free Spins. Any spin during Kong Quest, the Ape stretches the reels, this makes the reel size different each spin. The reel sizes are random between 3x3, 3x4, 3x5, 3x6, 3x7, and up to 3x8. The number of ways to win are 27 for 3x3, 64 for 3x4, 125 for 3x5, 216 for 3x6, 343 for 3x7 and 512 for 3x8. Vault Bonus contains the same reward as the Base Game but in Kong Quest, it can contain Free Spin. Unlock Vault Bonus with Free Spin to get 1 extra for each. Free Spins in Kong Quest are capped at 30.",
    ],
  ),
  rulesSection(
    "king-spin-free-spins",
    "KING SPIN FREE SPINS",
    [
      "King Spin\u00a0can only trigger from the\u00a0Primal Wheel! Starts with 8\u00a0Free Spins. All\u00a0Vault Bonus\u00a0are instantly unlocked! When\u00a0Vault Bonus\u00a0land, the\u00a0Ape\u00a0can smash the reels multiple times to upgrade all the\u00a0Vaults\u00a0up to\u00a0GRAND. Vaults\u00a0during\u00a0King Spin\u00a0can reward special\u00a0Bonuses\u00a0like\u00a0MEGA2X, MAJOR2X, MINOR2X,\u00a0and\u00a0MINI2X. The potential values of the Vault Bonus are GRAND (X1000), MEGA2X (X500), MEGA (X250), MAJOR2X (X150), MAJOR (X75), MINOR2X (X60), MINOR (X30), MINI2X (X20), MINI (X10), X9, X8, X7, X6, X5, X4, X3, X2, and X1. The winnings from the Vault Bonus is equivalent to its Multiplier times the Total Bet. Free Spins in King Spin are capped at 8.",
    ],
  ),
  Object.freeze({
    id: "actions",
    title: "Actions",
    paragraphs: Object.freeze([
      "Bets are selected using the bet buttons. Click the plus and minus buttons to change the bet one step at a time. Way wins are awarded for left to right adjacent symbol combinations. To start the round, click SPIN. When the reels stop, the symbols displayed determine your prize according to the paytable.",
    ]),
    actions: ACTIONS,
  }),
] satisfies readonly PackagedPrimalGameRulesSection[]);

export const PACKAGED_PRIMAL_GAME_RULES_EN_GB: PackagedPrimalGameRulesPage = Object.freeze({
  locale: "en_GB",
  pageTitle: "Primal Rampage",
  sections: SECTIONS,
});

export const PACKAGED_PRIMAL_GAME_RULES = Object.freeze({
  en_GB: PACKAGED_PRIMAL_GAME_RULES_EN_GB,
});
