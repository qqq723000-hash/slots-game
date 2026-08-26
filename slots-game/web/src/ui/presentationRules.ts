import type { GameDefinitionBinding, SessionOpened } from "../app/state/types";
import { ENGINE_RULES_VERSION } from "../protocol/messages";

export const PRIMAL_PRESENTATION_RULES_VERSION = "primal-rampage-help-en-gb-v3" as const;

/**
 * 这份白名单只批准固定玩法文案的展示，不批准数学定义本身。
 * 数学定义每次变更都必须显式增加新的表现规则版本或重新审阅后扩充该列表。
 */
export const PRIMAL_PRESENTATION_DEFINITION_BINDINGS = Object.freeze([
  Object.freeze({
    gameId: "iron-colossus",
    definitionVersion: "local-production-2026-08-26.3",
    definitionHash: "9e9b9b5f23f0f2cfed0a4a5ff5961dbc76a91ba9e614f3cfadb47824a46d2205",
  }),
] as const satisfies readonly GameDefinitionBinding[]);

/**
 * `config_mobile.json` 保存的是字体字段的原始颜色；最终官方客户端还会叠加
 * paytableHeaderStyle。这里记录合成后的玩家可见结果，避免再次把原始黄字误当成最终画面。
 */
export const PRIMAL_HELP_AUTHORING = Object.freeze({
  logicalWidthPx: 750,
  logicalHeightPx: 7_565,
  title: Object.freeze({
    fontFamily: "KANIT_BOLD",
    fontSizePx: 45,
    lineHeightPx: 60,
    gradientColors: Object.freeze(["#ff250a", "#ff710a"] as const),
    strokeColor: "#5c0001",
    strokeThicknessPx: 10,
    textAlign: "center",
  }),
  body: Object.freeze({
    fontFamily: "ROBOTO_CONDENSED_REGULAR",
    fontSizePx: 30,
    lineHeightPx: 40,
    color: "#FFFFFF",
    textAlign: "center",
  }),
});

/** 实时 `config_mobile.json` 编排坐标；浏览器布局最多可相差 1px。 */
export const PRIMAL_HELP_AUTHOR_Y = Object.freeze({
  maximumWinTop: 51.5,
  wild: 176,
  vault: 868,
  rage: 1_718.25,
  primalWheel: 2_384.1,
  kongQuestPage1: 3_178.15,
  kongQuestPage2: 3_902.2,
  kingSpinPage1: 4_735.9,
  kingSpinPage2: 5_563.85,
  payingSymbols: 6_153.65,
  wayWins: 6_848.9,
  maximumWinBottom: 7_445,
} as const);

/** 捕获的九个 T0AB 帧界定编排的 PAYTABLE 章节。 */
export const PRIMAL_HELP_SEPARATOR_AUTHOR_Y = Object.freeze([
  159,
  858.05,
  1_699.3,
  2_371.5,
  3_154.45,
  4_720.6,
  6_131.35,
  6_825.75,
  7_527.6,
] as const);

export const PRIMAL_HELP_REQUIRED_LOCALE_KEYS = Object.freeze([
  "IDS_WINUPTO_YOURBET",
  "IDS_PR_WILD",
  "IDS_PR_PT1",
  "IDS_PR_PT2",
  "IDS_PR_PT3",
  "IDS_PR_PT4",
  "IDS_PR_VAULTBONUS",
  "IDS_PR_PT5",
  "IDS_PR_PT6",
  "IDS_PR_PT7",
  "IDS_PR_RAGESYMBOL",
  "IDS_PR_PT8",
  "IDS_PR_PT9",
  "IDS_PR_PT10",
  "IDS_PR_PRIMALWHEEL",
  "IDS_PR_PT11",
  "IDS_PR_PT12",
  "IDS_PR_PT13",
  "IDS_PR_KONGQUEST",
  "IDS_PR_PT14",
  "IDS_PR_PT15",
  "IDS_PR_PT16",
  "IDS_PR_PT17",
  "IDS_PR_PT18",
  "IDS_PR_PT19",
  "IDS_PR_KINGSPIN",
  "IDS_PR_PT20",
  "IDS_PR_PT21",
  "IDS_PR_PT22",
  "IDS_PR_PT23",
  "IDS_PR_PT24",
  "IDS_PAYINGSYMBOLS_UC",
  "IDS_PR_PAYWAYS",
  "IDS_PR_WW_LR",
] as const);

export type PrimalHelpLocaleKey = typeof PRIMAL_HELP_REQUIRED_LOCALE_KEYS[number];

export interface PrimalHelpFontRoute {
  readonly titleFamily: string;
  readonly bodyFamily: string;
  /** 只有这些本地官方字体全部存在时，bundle 才允许进入可广告列表。 */
  readonly requiredFamilies: readonly string[];
  /** CSS 最后防线；release 校验失败时玩法文案仍保持关闭，不能靠回退字体冒充官方版。 */
  readonly cssFallbacks: readonly string[];
}

export interface PrimalHelpLocaleBundle {
  readonly locale: string;
  readonly messages: Readonly<Record<PrimalHelpLocaleKey, string>>;
  readonly fontRoute: Readonly<PrimalHelpFontRoute>;
}

type PrimalHelpLocaleBundleValidationInput = Readonly<{
  locale: string;
  messages: Readonly<Partial<Record<PrimalHelpLocaleKey, string>>>;
  fontRoute: Readonly<PrimalHelpFontRoute>;
}>;

export const PRIMAL_HELP_PACKAGED_FONT_FAMILIES = Object.freeze([
  "KANIT_BOLD",
  "ROBOTO_CONDENSED_BOLD",
  "ROBOTO_CONDENSED_REGULAR",
] as const);

const EN_GB_HELP_MESSAGES = Object.freeze({
  IDS_WINUPTO_YOURBET: "Win up to 2500x your bet!",
  IDS_PR_WILD: "WILD",
  IDS_PR_PT1: "Wild can land on reel 2.",
  IDS_PR_PT2: "It substitute for all symbols except Vault Bonus and Rage Symbols.",
  IDS_PR_PT3: "Wild can have a Multiplier of X2, X3, X5, X10, X25, X50 or X100.",
  IDS_PR_PT4: "Only win combinations with Multiplier Wild is affected by the win Multiplier.",
  IDS_PR_VAULTBONUS: "VAULT BONUS",
  IDS_PR_PT5: "Vault Bonus can land on reel 2.",
  IDS_PR_PT6: "When Vault Bonus land, the Ape can smash the reels to unlock all the Vaults.",
  IDS_PR_PT7: "Each Vault Bonus can award anywhere between GRAND, MEGA, MAJOR, MINOR, MINI, X9, X8, X7, X6, X5, X4, X3, X2 or X1",
  IDS_PR_RAGESYMBOL: "RAGE SYMBOL",
  IDS_PR_PT8: "Rage Symbols can land on any reel in the Base Game.",
  IDS_PR_PT9: "Land 3 Rage Symbols to trigger the Primal Wheel!",
  IDS_PR_PT10: "If 1 or 2 Rage Symbols have landed, the Ape collects it for a chance to trigger the Primal Wheel!",
  IDS_PR_PRIMALWHEEL: "PRIMAL WHEEL",
  IDS_PR_PT11: "Spin the wheel for a chance to win GRAND X1000, MEGA X250, MAJOR X75, MINOR X30 or MINI X10 Bonus, or to trigger KONG QUEST or KING SPIN.",
  IDS_PR_PT12: "The GRAND, MEGA, MAJOR, MINOR and MINI Bonuses are instantly rewarded if won.",
  IDS_PR_PT13: "If the wheel stops at KONG QUEST or KING SPIN, the game proceeds to a Free Spin feature.",
  IDS_PR_KONGQUEST: "KONG QUEST",
  IDS_PR_PT14: "Kong Quest can only trigger from the Primal Wheel!",
  IDS_PR_PT15: "Starts with 8 initial Free Spins.",
  IDS_PR_PT16: "Any spin during Kong Quest, the Ape stretches the reels, this makes the reel size different each spin.",
  IDS_PR_PT17: "The reel sizes are random between 3x3, 3x4, 3x5, 3x6, 3x7, and up to 3x8.",
  IDS_PR_PT18: "Vault Bonus contains the same reward as the Base Game but in Kong Quest, it can contain Free Spin.",
  IDS_PR_PT19: "Unlock Vault Bonus with Free Spin to get 1 extra for each.",
  IDS_PR_KINGSPIN: "KING SPIN",
  IDS_PR_PT20: "King Spin can only trigger from the Primal Wheel!",
  IDS_PR_PT21: "Starts with 8 Free Spins.",
  IDS_PR_PT22: "All Vault Bonus are instantly unlocked!",
  IDS_PR_PT23: "When Vault Bonus land, the Ape can smash the reels multiple times to upgrade all the Vaults up to GRAND.",
  IDS_PR_PT24: "Vaults during King Spin can reward MEGA2X, MAJOR2X, MINOR2X, and MINI2X which rewards double value of MEGA, MAJOR, MINOR and MINI.",
  IDS_PAYINGSYMBOLS_UC: "PAYING SYMBOLS",
  IDS_PR_PAYWAYS: "WAY WINS",
  IDS_PR_WW_LR: "Way Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols.",
} satisfies Record<PrimalHelpLocaleKey, string>);

const EN_GB_HELP_BUNDLE = Object.freeze({
  locale: "en_GB",
  messages: EN_GB_HELP_MESSAGES,
  fontRoute: Object.freeze({
    titleFamily: PRIMAL_HELP_AUTHORING.title.fontFamily,
    bodyFamily: PRIMAL_HELP_AUTHORING.body.fontFamily,
    requiredFamilies: PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
    cssFallbacks: Object.freeze(["Arial Narrow", "sans-serif"] as const),
  }),
} satisfies PrimalHelpLocaleBundle);

/**
 * 这里只有经过证据逐字核对的 en_GB。未来 locale 必须以完整 bundle 加入，禁止以机器翻译补洞。
 */
export const PRIMAL_HELP_LOCALE_BUNDLES = Object.freeze({
  en_GB: EN_GB_HELP_BUNDLE,
});

export function validatePrimalHelpLocaleBundle(
  bundle: PrimalHelpLocaleBundleValidationInput,
  availableFontFamilies: readonly string[] = PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
): readonly string[] {
  const failures: string[] = [];
  for (const key of PRIMAL_HELP_REQUIRED_LOCALE_KEYS) {
    const message = bundle.messages[key];
    if (typeof message !== "string" || message.trim().length === 0) {
      failures.push(`missing-message:${key}`);
    }
  }
  const available = new Set(availableFontFamilies);
  for (const family of bundle.fontRoute.requiredFamilies) {
    if (!available.has(family)) failures.push(`missing-font:${family}`);
  }
  if (!bundle.fontRoute.requiredFamilies.includes(bundle.fontRoute.titleFamily)) {
    failures.push(`unrouted-title-font:${bundle.fontRoute.titleFamily}`);
  }
  if (!bundle.fontRoute.requiredFamilies.includes(bundle.fontRoute.bodyFamily)) {
    failures.push(`unrouted-body-font:${bundle.fontRoute.bodyFamily}`);
  }
  return Object.freeze(failures);
}

const RELEASE_COMPLETE_HELP_LOCALES = Object.values(PRIMAL_HELP_LOCALE_BUNDLES)
  .filter((bundle) => validatePrimalHelpLocaleBundle(bundle).length === 0)
  .map(({ locale }) => locale);

export const PRIMAL_HELP_ADVERTISED_LOCALES = Object.freeze(RELEASE_COMPLETE_HELP_LOCALES);

if (!PRIMAL_HELP_ADVERTISED_LOCALES.includes("en_GB")) {
  throw new Error("approved en_GB help bundle is not release-complete");
}

export interface PrimalHelpLocaleResolution {
  readonly requestedLocale: string;
  readonly locale: string;
  readonly fallback: boolean;
  readonly bundle: Readonly<PrimalHelpLocaleBundle>;
}

export interface PrimalHelpLocaleRequestSource {
  readonly search?: string;
  readonly documentLanguage?: string;
}

/**
 * 运营商显式 query 参数优先于文档语言；两者都没有时才使用经过批准的 en_GB。
 * 这里只选择请求值，规范化与完整 bundle 回退仍由 resolvePrimalHelpLocale 统一负责。
 */
export function requestedPrimalHelpLocale(
  source: Readonly<PrimalHelpLocaleRequestSource> = {},
): string {
  const queryLocale = new URLSearchParams(source.search ?? "").get("lang")?.trim();
  if (queryLocale) return queryLocale;
  const documentLocale = source.documentLanguage?.trim();
  return documentLocale || "en_GB";
}

function normalizePrimalHelpLocale(locale: string): string {
  const match = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}|[0-9]{3}))?$/.exec(locale.trim());
  if (!match) return "en_GB";
  const language = match[1]!.toLowerCase();
  const region = match[2];
  if (!region) return language === "en" ? "en_GB" : language;
  return `${language}_${/^[0-9]{3}$/.test(region) ? region : region.toUpperCase()}`;
}

/**
 * Unsupported locale 以完整 en_GB bundle 回退；字体不完整时抛错，让调用方隐藏玩法文案。
 */
export function resolvePrimalHelpLocale(
  requestedLocale: string,
  availableFontFamilies: readonly string[] = PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
): PrimalHelpLocaleResolution {
  const normalized = normalizePrimalHelpLocale(requestedLocale);
  const bundlesByLocale: Readonly<Record<string, Readonly<PrimalHelpLocaleBundle>>> =
    PRIMAL_HELP_LOCALE_BUNDLES;
  const advertised = PRIMAL_HELP_ADVERTISED_LOCALES.includes(normalized);
  const bundle = advertised
    ? bundlesByLocale[normalized] ?? PRIMAL_HELP_LOCALE_BUNDLES.en_GB
    : PRIMAL_HELP_LOCALE_BUNDLES.en_GB;
  const failures = validatePrimalHelpLocaleBundle(bundle, availableFontFamilies);
  if (failures.length > 0) {
    throw new Error(
      `approved ${bundle.locale} help bundle is not release-complete: ${failures.join(",")}`,
    );
  }
  return Object.freeze({
    requestedLocale: normalized,
    locale: bundle.locale,
    fallback: normalized !== bundle.locale,
    bundle,
  });
}

/**
 * 完整 locale bundle 的 DOM 提交边界。先验证白名单、bundle 和全部 DOM key，
 * 再一次性写入，避免缺键时留下混合语言或半更新的帮助页。
 */
export function applyPrimalHelpLocaleBundle(
  root: ParentNode,
  resolution: Readonly<PrimalHelpLocaleResolution>,
): number {
  const bundlesByLocale: Readonly<Record<string, Readonly<PrimalHelpLocaleBundle>>> =
    PRIMAL_HELP_LOCALE_BUNDLES;
  const canonicalBundle = bundlesByLocale[resolution.locale];
  if (!PRIMAL_HELP_ADVERTISED_LOCALES.includes(resolution.locale)
    || canonicalBundle === undefined
    || canonicalBundle !== resolution.bundle
    || resolution.bundle.locale !== resolution.locale) {
    throw new Error(`help locale ${resolution.locale} is not an advertised canonical bundle`);
  }

  const bundleFailures = validatePrimalHelpLocaleBundle(resolution.bundle);
  if (bundleFailures.length > 0) {
    throw new Error(
      `approved ${resolution.locale} help bundle is not release-complete: ${bundleFailures.join(",")}`,
    );
  }

  const requiredKeys = new Set<string>(PRIMAL_HELP_REQUIRED_LOCALE_KEYS);
  const coveredKeys = new Set<PrimalHelpLocaleKey>();
  const stagedWrites: Array<Readonly<{ element: HTMLElement; message: string }>> = [];
  const domFailures: string[] = [];
  for (const element of root.querySelectorAll<HTMLElement>("[data-locale-key]")) {
    const rawKey = element.getAttribute("data-locale-key");
    if (rawKey === null || !requiredKeys.has(rawKey)) {
      domFailures.push(`unknown-dom-key:${rawKey ?? ""}`);
      continue;
    }
    const key = rawKey as PrimalHelpLocaleKey;
    coveredKeys.add(key);
    stagedWrites.push(Object.freeze({ element, message: resolution.bundle.messages[key] }));
  }
  for (const key of PRIMAL_HELP_REQUIRED_LOCALE_KEYS) {
    if (!coveredKeys.has(key)) domFailures.push(`missing-dom-key:${key}`);
  }
  if (domFailures.length > 0) {
    throw new Error(`help locale DOM is incomplete: ${domFailures.join(",")}`);
  }

  for (const { element, message } of stagedWrites) element.textContent = message;
  return stagedWrites.length;
}

export interface PrimalHelpArtwork {
  readonly asset: string;
  readonly alt: string;
  readonly authoredWidthPx: number;
  readonly authoredHeightPx: number;
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
  readonly titleKey: PrimalHelpLocaleKey;
  readonly paragraphs: readonly string[];
  readonly paragraphKeys: readonly PrimalHelpLocaleKey[];
  readonly paragraphBoxHeightsPx: readonly number[];
  readonly artwork: readonly PrimalHelpArtwork[];
}

/**
 * 仅抄录官方 en_GB locale 中的短玩法文案；顺序来自移动端 paytable 的作者时间线。
 * 保留原文的大小写、标点和语法，以便证据测试逐字核对。
 */
export const PRIMAL_HELP_SECTIONS = Object.freeze([
  Object.freeze({
    id: "wild",
    title: EN_GB_HELP_MESSAGES.IDS_PR_WILD,
    titleKey: "IDS_PR_WILD",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT1,
      EN_GB_HELP_MESSAGES.IDS_PR_PT2,
      EN_GB_HELP_MESSAGES.IDS_PR_PT3,
      EN_GB_HELP_MESSAGES.IDS_PR_PT4,
    ]),
    paragraphKeys: Object.freeze(["IDS_PR_PT1", "IDS_PR_PT2", "IDS_PR_PT3", "IDS_PR_PT4"] as const),
    paragraphBoxHeightsPx: Object.freeze([40, 80, 80, 80]),
    artwork: Object.freeze([]),
  }),
  Object.freeze({
    id: "vault",
    title: EN_GB_HELP_MESSAGES.IDS_PR_VAULTBONUS,
    titleKey: "IDS_PR_VAULTBONUS",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT5,
      EN_GB_HELP_MESSAGES.IDS_PR_PT6,
      EN_GB_HELP_MESSAGES.IDS_PR_PT7,
    ]),
    paragraphKeys: Object.freeze(["IDS_PR_PT5", "IDS_PR_PT6", "IDS_PR_PT7"] as const),
    paragraphBoxHeightsPx: Object.freeze([40, 120, 120]),
    artwork: Object.freeze([
      Object.freeze({
        asset: "10031.png", alt: "Vault Bonus", authoredWidthPx: 200, authoredHeightPx: 140,
      }),
      Object.freeze({
        asset: "10029.png", alt: "The Ape striking the Vaults", authoredWidthPx: 250.25, authoredHeightPx: 281.05,
      }),
      Object.freeze({
        asset: "10030.png", alt: "The Ape collecting Vault rewards", authoredWidthPx: 269.8, authoredHeightPx: 281.2,
      }),
    ]),
  }),
  Object.freeze({
    id: "rage",
    title: EN_GB_HELP_MESSAGES.IDS_PR_RAGESYMBOL,
    titleKey: "IDS_PR_RAGESYMBOL",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT8,
      EN_GB_HELP_MESSAGES.IDS_PR_PT9,
      EN_GB_HELP_MESSAGES.IDS_PR_PT10,
    ]),
    paragraphKeys: Object.freeze(["IDS_PR_PT8", "IDS_PR_PT9", "IDS_PR_PT10"] as const),
    paragraphBoxHeightsPx: Object.freeze([80, 80, 120]),
    artwork: Object.freeze([
      Object.freeze({
        asset: "10028.png", alt: "Rage Symbols", authoredWidthPx: 348.75, authoredHeightPx: 262.5,
      }),
    ]),
  }),
  Object.freeze({
    id: "primal-wheel",
    title: EN_GB_HELP_MESSAGES.IDS_PR_PRIMALWHEEL,
    titleKey: "IDS_PR_PRIMALWHEEL",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT11,
      EN_GB_HELP_MESSAGES.IDS_PR_PT12,
      EN_GB_HELP_MESSAGES.IDS_PR_PT13,
    ]),
    paragraphKeys: Object.freeze(["IDS_PR_PT11", "IDS_PR_PT12", "IDS_PR_PT13"] as const),
    paragraphBoxHeightsPx: Object.freeze([160, 120, 120]),
    artwork: Object.freeze([
      Object.freeze({
        asset: "10027.png", alt: "Primal Wheel", authoredWidthPx: 264, authoredHeightPx: 267,
      }),
    ]),
  }),
  Object.freeze({
    id: "kong-quest",
    title: EN_GB_HELP_MESSAGES.IDS_PR_KONGQUEST,
    titleKey: "IDS_PR_KONGQUEST",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT14,
      EN_GB_HELP_MESSAGES.IDS_PR_PT15,
      EN_GB_HELP_MESSAGES.IDS_PR_PT16,
      EN_GB_HELP_MESSAGES.IDS_PR_PT17,
      EN_GB_HELP_MESSAGES.IDS_PR_PT18,
      EN_GB_HELP_MESSAGES.IDS_PR_PT19,
    ]),
    paragraphKeys: Object.freeze([
      "IDS_PR_PT14", "IDS_PR_PT15", "IDS_PR_PT16",
      "IDS_PR_PT17", "IDS_PR_PT18", "IDS_PR_PT19",
    ] as const),
    paragraphBoxHeightsPx: Object.freeze([80, 40, 120, 80, 120, 80]),
    artwork: Object.freeze([
      Object.freeze({
        asset: "10026.png", alt: "Kong Quest on the Primal Wheel", authoredWidthPx: 262.55, authoredHeightPx: 262.55,
      }),
      Object.freeze({
        asset: "10025.png", alt: "Expanded Kong Quest reels", authoredWidthPx: 353.8, authoredHeightPx: 445.3,
      }),
      Object.freeze({
        asset: "10024.png", alt: "Kong Quest extra Free Spin reward", authoredWidthPx: 217.6, authoredHeightPx: 149.6,
      }),
    ]),
  }),
  Object.freeze({
    id: "king-spin",
    title: EN_GB_HELP_MESSAGES.IDS_PR_KINGSPIN,
    titleKey: "IDS_PR_KINGSPIN",
    paragraphs: Object.freeze([
      EN_GB_HELP_MESSAGES.IDS_PR_PT20,
      EN_GB_HELP_MESSAGES.IDS_PR_PT21,
      EN_GB_HELP_MESSAGES.IDS_PR_PT22,
      EN_GB_HELP_MESSAGES.IDS_PR_PT23,
      EN_GB_HELP_MESSAGES.IDS_PR_PT24,
    ]),
    paragraphKeys: Object.freeze([
      "IDS_PR_PT20", "IDS_PR_PT21", "IDS_PR_PT22", "IDS_PR_PT23", "IDS_PR_PT24",
    ] as const),
    paragraphBoxHeightsPx: Object.freeze([80, 40, 40, 120, 160]),
    artwork: Object.freeze([
      Object.freeze({
        asset: "10023.png", alt: "King Spin on the Primal Wheel", authoredWidthPx: 262.55, authoredHeightPx: 262.55,
      }),
      Object.freeze({
        asset: "10022.png", alt: "Unlocked King Spin Vault", authoredWidthPx: 282.9, authoredHeightPx: 272.55,
      }),
      Object.freeze({
        asset: "10020.png", alt: "Grand Vault reward", authoredWidthPx: 198.4, authoredHeightPx: 136.4,
      }),
      Object.freeze({
        asset: "10021.png", alt: "Vault X1 reward", authoredWidthPx: 234.9, authoredHeightPx: 145,
      }),
    ]),
  }),
] as const satisfies readonly PrimalHelpSection[]);

export const PRIMAL_WAY_WINS_COPY =
  EN_GB_HELP_MESSAGES.IDS_PR_WW_LR;

export const PRIMAL_MAXIMUM_WIN_COPY =
  EN_GB_HELP_MESSAGES.IDS_WINUPTO_YOURBET;

export const PRIMAL_PRESENTATION_RULES = Object.freeze({
  schema: "slots-game-presentation-rules-v1",
  version: PRIMAL_PRESENTATION_RULES_VERSION,
  locale: "en_GB",
  advertisedLocales: PRIMAL_HELP_ADVERTISED_LOCALES,
  sourceRevision: "1.2.1-primalrampage.471",
  scope: Object.freeze({
    engineRulesVersion: ENGINE_RULES_VERSION,
    definitionBindings: PRIMAL_PRESENTATION_DEFINITION_BINDINGS,
  }),
  sections: PRIMAL_HELP_SECTIONS,
  wayWins: PRIMAL_WAY_WINS_COPY,
  maximumWin: PRIMAL_MAXIMUM_WIN_COPY,
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
  /** 运营商请求与最终完整 bundle 都被冻结；同一会话不得静默切换语言。 */
  readonly requestedLocale: string;
  readonly locale: string;
}

export interface PresentationRulesBindingResult {
  readonly status: PresentationRulesBindingStatus;
  /** 首次观察记录在同一 sessionId 内保持冻结；漂移时不会被新值覆盖。 */
  readonly record: Readonly<PresentationRulesSessionRecord>;
}

const DEFINITION_HASH_PATTERN = /^[a-f0-9]{64}$/;

function observedSessionRecord(
  session: Readonly<SessionOpened>,
  locale: Readonly<PrimalHelpLocaleResolution>,
): PresentationRulesSessionRecord {
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
    requestedLocale: locale.requestedLocale,
    locale: locale.locale,
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
    && sameDefinitionBinding(left.definitionBinding, right.definitionBinding)
    && left.requestedLocale === right.requestedLocale
    && left.locale === right.locale;
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
  requestedLocale: string = PRIMAL_PRESENTATION_RULES.locale,
): PresentationRulesBindingResult {
  const locale = resolvePrimalHelpLocale(requestedLocale);
  const observed = observedSessionRecord(session, locale);
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
