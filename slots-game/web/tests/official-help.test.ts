// @ts-expect-error Vitest 在 Node 中运行；浏览器生产版 tsconfig 刻意省略 Node 全局类型。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionOpened } from "../src/app/state/types";
import { mobileLayoutProfile } from "../src/renderer/ResponsiveLayout";
import { ENGINE_RULES_VERSION } from "../src/protocol/messages";
import {
  rgsSessionOpened,
  type DecodedRgsExchange,
} from "../src/protocol/rgsDecoder";
import {
  PAYTABLE_WILD_ENTRIES,
  officialHelpProjectionGeometry,
} from "../src/ui/DomOverlay";
import {
  PRIMAL_HELP_ADVERTISED_LOCALES,
  PRIMAL_HELP_AUTHORING,
  PRIMAL_HELP_LOCALE_BUNDLES,
  PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
  PRIMAL_HELP_REQUIRED_LOCALE_KEYS,
  PRIMAL_HELP_SECTIONS,
  PRIMAL_PRESENTATION_DEFINITION_BINDINGS,
  PRIMAL_PRESENTATION_RULES,
  PRIMAL_WAY_WINS_COPY,
  applyPrimalHelpLocaleBundle,
  bindPrimalPresentationRules,
  requestedPrimalHelpLocale,
  resolvePrimalHelpLocale,
  validatePrimalHelpLocaleBundle,
} from "../src/ui/presentationRules";

const APPROVED = PRIMAL_PRESENTATION_DEFINITION_BINDINGS[0];

function session(
  overrides: Partial<SessionOpened> = {},
): SessionOpened {
  return {
    type: "session.opened",
    protocolVersion: 1,
    engineRulesVersion: ENGINE_RULES_VERSION,
    definitionBinding: { ...APPROVED },
    requestId: "request-help",
    sessionId: "session-help",
    currency: "EUR",
    currencyExponent: 2,
    balanceMinor: "10000",
    betOptionsMinor: ["100"],
    defaultBetMinor: "100",
    featureState: {
      mode: "BASE",
      freeSpinsRemaining: 0,
      rageLevel: 1,
      rageCollected: 0,
    },
    ...overrides,
  };
}

describe("official Primal Rampage help copy", () => {
  it("publishes the captured 750px authoring and final composed typography contract", () => {
    expect(PRIMAL_HELP_AUTHORING).toEqual({
      logicalWidthPx: 750,
      title: {
        fontFamily: "ROBOTO_CONDENSED_BOLD",
        fontSizePx: 45,
        lineHeightPx: 60,
        gradientColors: ["#ff250a", "#ff710a"],
        strokeColor: "#5c0001",
        strokeThicknessPx: 10,
        textAlign: "center",
      },
      body: {
        fontFamily: "ROBOTO_CONDENSED_REGULAR",
        fontSizePx: 30,
        lineHeightPx: 40,
        color: "#FFFFFF",
        textAlign: "center",
      },
    });
  });

  it("keeps the captured chapter order and en_GB PT1-PT24 copy exact", () => {
    expect(PRIMAL_HELP_SECTIONS.map(({ id }) => id)).toEqual([
      "wild",
      "vault",
      "rage",
      "primal-wheel",
      "kong-quest",
      "king-spin",
    ]);
    expect(PRIMAL_HELP_SECTIONS.map(({ title, paragraphs }) => ({ title, paragraphs })))
      .toEqual([
        {
          title: "WILD",
          paragraphs: [
            "Wild can land on reel 2.",
            "It substitute for all symbols except Vault Bonus and Rage Symbols.",
            "Wild can have a Multiplier of X2, X3, X5, X10, X25, X50 or X100.",
            "Only win combinations with Multiplier Wild is affected by the win Multiplier.",
          ],
        },
        {
          title: "VAULT BONUS",
          paragraphs: [
            "Vault Bonus can land on reel 2.",
            "When Vault Bonus land, the Ape can smash the reels to unlock all the Vaults.",
            "Each Vault Bonus can award anywhere between GRAND, MEGA, MAJOR, MINOR, MINI, X9, X8, X7, X6, X5, X4, X3, X2 or X1",
          ],
        },
        {
          title: "RAGE SYMBOL",
          paragraphs: [
            "Rage Symbols can land on any reel in the Base Game.",
            "Land 3 Rage Symbols to trigger the Primal Wheel!",
            "If 1 or 2 Rage Symbols have landed, the Ape collects it for a chance to trigger the Primal Wheel!",
          ],
        },
        {
          title: "PRIMAL WHEEL",
          paragraphs: [
            "Spin the wheel for a chance to win GRAND X1000, MEGA X250, MAJOR X75, MINOR X30 or MINI X10 Bonus, or to trigger KONG QUEST or KING SPIN.",
            "The GRAND, MEGA, MAJOR, MINOR and MINI Bonuses are instantly rewarded if won.",
            "If the wheel stops at KONG QUEST or KING SPIN, the game proceeds to a Free Spin feature.",
          ],
        },
        {
          title: "KONG QUEST",
          paragraphs: [
            "Kong Quest can only trigger from the Primal Wheel!",
            "Starts with 8 initial Free Spins.",
            "Any spin during Kong Quest, the Ape stretches the reels, this makes the reel size different each spin.",
            "The reel sizes are random between 3x3, 3x4, 3x5, 3x6, 3x7, and up to 3x8.",
            "Vault Bonus contains the same reward as the Base Game but in Kong Quest, it can contain Free Spin.",
            "Unlock Vault Bonus with Free Spin to get 1 extra for each.",
          ],
        },
        {
          title: "KING SPIN",
          paragraphs: [
            "King Spin can only trigger from the Primal Wheel!",
            "Starts with 8 Free Spins.",
            "All Vault Bonus are instantly unlocked!",
            "When Vault Bonus land, the Ape can smash the reels multiple times to upgrade all the Vaults up to GRAND.",
            "Vaults during King Spin can reward MEGA2X, MAJOR2X, MINOR2X, and MINI2X which rewards double value of MEGA, MAJOR, MINOR and MINI.",
          ],
        },
      ]);
    expect(PRIMAL_WAY_WINS_COPY).toBe(
      "Way Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols.",
    );
    expect([
      ...PRIMAL_HELP_SECTIONS.map(({ id }) => id),
      "paying-symbols",
      "way-wins",
    ]).toEqual([
      "wild",
      "vault",
      "rage",
      "primal-wheel",
      "kong-quest",
      "king-spin",
      "paying-symbols",
      "way-wins",
    ]);
    expect([
      ...PRIMAL_HELP_SECTIONS.flatMap(({ titleKey, paragraphKeys }) => [
        titleKey,
        ...paragraphKeys,
      ]),
      "IDS_PAYINGSYMBOLS_UC",
      "IDS_PR_PAYWAYS",
      "IDS_PR_WW_LR",
    ]).toEqual(PRIMAL_HELP_REQUIRED_LOCALE_KEYS);
    expect(PRIMAL_HELP_SECTIONS.map(({ paragraphBoxHeightsPx }) => paragraphBoxHeightsPx))
      .toEqual([
        [40, 80, 80, 80],
        [40, 120, 120],
        [80, 80, 120],
        [160, 120, 120],
        [80, 40, 120, 80, 120, 80],
        [80, 40, 40, 120, 160],
      ]);
    expect(PRIMAL_HELP_SECTIONS.find(({ id }) => id === "king-spin")?.artwork)
      .toMatchObject([
        { asset: "10023.png", authoredWidthPx: 262.55, authoredHeightPx: 262.55 },
        { asset: "10022.png", authoredWidthPx: 282.9, authoredHeightPx: 272.55 },
        { asset: "10020.png", authoredWidthPx: 198.4, authoredHeightPx: 136.4 },
        { asset: "10021.png", authoredWidthPx: 234.9, authoredHeightPx: 145 },
      ]);
  });

  it("keeps the seven official multiplier Wilds plus plain Wild and excludes X1 art", () => {
    expect(PAYTABLE_WILD_ENTRIES.map(({ label }) => label)).toEqual([
      "X100", "X50", "X25", "X10", "X5", "X3", "X2", "WILD",
    ]);
    expect(PAYTABLE_WILD_ENTRIES.map(({ label }) => String(label))).not.toContain("X1");
  });

  it("does not publish the removed maximum-win or math-policy claims", () => {
    const source = readFileSync(new URL("../src/ui/DomOverlay.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Win up to 2500x your bet!/i);
    expect(source).not.toMatch(/RTP, volatility, reel weights/i);
    expect(source).not.toMatch(/probability|probabilities/i);
  });
});

describe("official help locale release contract", () => {
  it("selects explicit ?lang= before document language and otherwise uses en_GB", () => {
    expect(requestedPrimalHelpLocale({
      search: "?operator=demo&lang=fr-FR",
      documentLanguage: "de-DE",
    })).toBe("fr-FR");
    expect(requestedPrimalHelpLocale({
      search: "?operator=demo",
      documentLanguage: "pt-BR",
    })).toBe("pt-BR");
    expect(requestedPrimalHelpLocale({
      search: "?lang=%20",
      documentLanguage: "",
    })).toBe("en_GB");
    expect(requestedPrimalHelpLocale()).toBe("en_GB");
  });

  it("advertises only the complete authoritative en_GB bundle and every required official key", () => {
    expect(PRIMAL_HELP_ADVERTISED_LOCALES).toEqual(["en_GB"]);
    expect(Object.keys(PRIMAL_HELP_LOCALE_BUNDLES)).toEqual(["en_GB"]);
    expect(PRIMAL_HELP_REQUIRED_LOCALE_KEYS).toHaveLength(33);
    expect(validatePrimalHelpLocaleBundle(
      PRIMAL_HELP_LOCALE_BUNDLES.en_GB,
      PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
    )).toEqual([]);
    expect(Object.keys(PRIMAL_HELP_LOCALE_BUNDLES.en_GB.messages).sort()).toEqual(
      [...PRIMAL_HELP_REQUIRED_LOCALE_KEYS].sort(),
    );
    expect(PRIMAL_HELP_LOCALE_BUNDLES.en_GB.fontRoute).toEqual({
      titleFamily: "ROBOTO_CONDENSED_BOLD",
      bodyFamily: "ROBOTO_CONDENSED_REGULAR",
      requiredFamilies: ["ROBOTO_CONDENSED_BOLD", "ROBOTO_CONDENSED_REGULAR"],
      cssFallbacks: ["Arial Narrow", "sans-serif"],
    });
    const source = readFileSync(new URL("../src/ui/presentationRules.ts", import.meta.url), "utf8");
    expect(source).not.toContain("PNG_VNTH");
  });

  it("fails an incomplete bundle or missing official font closed instead of advertising it", () => {
    const incomplete = {
      ...PRIMAL_HELP_LOCALE_BUNDLES.en_GB,
      messages: {
        ...PRIMAL_HELP_LOCALE_BUNDLES.en_GB.messages,
        IDS_PR_PT24: "",
      },
    };
    expect(validatePrimalHelpLocaleBundle(
      incomplete,
      PRIMAL_HELP_PACKAGED_FONT_FAMILIES,
    )).toContain("missing-message:IDS_PR_PT24");
    expect(validatePrimalHelpLocaleBundle(
      PRIMAL_HELP_LOCALE_BUNDLES.en_GB,
      ["ROBOTO_CONDENSED_BOLD"],
    )).toContain("missing-font:ROBOTO_CONDENSED_REGULAR");
    expect(() => resolvePrimalHelpLocale(
      "en_GB",
      ["ROBOTO_CONDENSED_BOLD"],
    )).toThrow(/approved en_GB help bundle is not release-complete/i);
  });

  it("normalizes an operator locale, falls back as one complete bundle, and never invents copy", () => {
    expect(resolvePrimalHelpLocale("en-gb")).toMatchObject({
      requestedLocale: "en_GB",
      locale: "en_GB",
      fallback: false,
    });
    expect(resolvePrimalHelpLocale("fr-FR")).toMatchObject({
      requestedLocale: "fr_FR",
      locale: "en_GB",
      fallback: true,
      bundle: PRIMAL_HELP_LOCALE_BUNDLES.en_GB,
    });
  });

  it("atomically writes the resolved complete bundle by data-locale-key and fails missing DOM closed", () => {
    const elements = PRIMAL_HELP_REQUIRED_LOCALE_KEYS.map((key) => ({
      key,
      textContent: "stale",
      getAttribute(name: string): string | null {
        return name === "data-locale-key" ? this.key : null;
      },
    }));
    const completeRoot = {
      querySelectorAll: () => elements,
    } as unknown as ParentNode;
    const fallback = resolvePrimalHelpLocale("fr-FR");

    expect(applyPrimalHelpLocaleBundle(completeRoot, fallback))
      .toBe(PRIMAL_HELP_REQUIRED_LOCALE_KEYS.length);
    for (const element of elements) {
      expect(element.textContent).toBe(fallback.bundle.messages[element.key]);
    }

    for (const element of elements) element.textContent = "unchanged";
    const incompleteRoot = {
      querySelectorAll: () => elements.slice(1),
    } as unknown as ParentNode;
    expect(() => applyPrimalHelpLocaleBundle(incompleteRoot, fallback))
      .toThrow(`missing-dom-key:${PRIMAL_HELP_REQUIRED_LOCALE_KEYS[0]}`);
    expect(elements.every(({ textContent }) => textContent === "unchanged")).toBe(true);
  });
});

describe("presentationRules session binding", () => {
  it("opens the guide only for the exact approved engine and definition identity", () => {
    const bound = bindPrimalPresentationRules(null, session());
    expect(bound).toMatchObject({
      status: "bound",
      record: {
        sessionId: "session-help",
        engineRulesVersion: ENGINE_RULES_VERSION,
        definitionBinding: APPROVED,
      },
    });
    expect(PRIMAL_PRESENTATION_RULES).toMatchObject({
      schema: "slots-game-presentation-rules-v1",
      version: "primal-rampage-help-en-gb-v2",
      locale: "en_GB",
      sourceRevision: "1.2.1-primalrampage.471",
    });
  });

  it.each([
    {
      name: "missing binding",
      value: session({ definitionBinding: undefined }),
      status: "missing-binding",
    },
    {
      name: "different game",
      value: session({ definitionBinding: { ...APPROVED, gameId: "another-game" } }),
      status: "unsupported-binding",
    },
    {
      name: "different definition version",
      value: session({
        definitionBinding: { ...APPROVED, definitionVersion: "local-production-2026-08-16.2" },
      }),
      status: "unsupported-binding",
    },
    {
      name: "different complete hash",
      value: session({ definitionBinding: { ...APPROVED, definitionHash: "b".repeat(64) } }),
      status: "unsupported-binding",
    },
  ])("fails closed for $name", ({ value, status }) => {
    expect(bindPrimalPresentationRules(null, value).status).toBe(status);
  });

  it("locks a detected same-session drift until a new session is established", () => {
    const bound = bindPrimalPresentationRules(null, session());
    const drifted = bindPrimalPresentationRules(bound, session({
      definitionBinding: { ...APPROVED, definitionHash: "c".repeat(64) },
    }));
    expect(drifted.status).toBe("binding-drift");
    expect(drifted.record).toBe(bound.record);
    expect(bindPrimalPresentationRules(drifted, session()).status).toBe("binding-drift");
    expect(bindPrimalPresentationRules(drifted, session({ sessionId: "session-help-new" })).status)
      .toBe("bound");
  });

  it("locks locale selection for the connected session even when both requests resolve to en_GB", () => {
    const fallback = bindPrimalPresentationRules(null, session(), "fr-FR");
    expect(fallback).toMatchObject({
      status: "bound",
      record: { requestedLocale: "fr_FR", locale: "en_GB" },
    });
    expect(bindPrimalPresentationRules(fallback, session(), "en_GB").status)
      .toBe("binding-drift");
    expect(bindPrimalPresentationRules(
      fallback,
      session({ sessionId: "session-help-new" }),
      "en_GB",
    ).status).toBe("bound");
  });

  it("carries the verified RGS definition identity into the session projection", () => {
    const exchange: DecodedRgsExchange = {
      requestId: "request-rgs-help",
      accessToken: "token",
      session: {
        binding: {
          operatorId: "operator-help",
          sessionId: "session-help",
          gameId: APPROVED.gameId,
          definitionVersion: APPROVED.definitionVersion,
          definitionHash: APPROVED.definitionHash,
          currency: "EUR",
          currencyExponent: 2,
          jurisdiction: "GB",
        },
        status: "ACTIVE",
        expiresAt: "2030-01-01T00:00:00Z",
        balanceMinor: "10000",
        revision: "0",
        sequence: 0,
        featureState: session().featureState,
      },
    };
    const projected = rgsSessionOpened(exchange, ["100"], "100");
    expect(projected.definitionBinding).toEqual(APPROVED);

    const fallback = bindPrimalPresentationRules(null, projected, "fr-FR");
    expect(fallback).toMatchObject({
      status: "bound",
      record: { requestedLocale: "fr_FR", locale: "en_GB" },
    });
    const drifted = bindPrimalPresentationRules(
      fallback,
      rgsSessionOpened(exchange, ["100"], "100"),
      "en_GB",
    );
    expect(drifted.status).toBe("binding-drift");
    expect(drifted.record).toBe(fallback.record);
  });
});

describe("PC, phone, and tablet help layout", () => {
  it("routes the accepted portrait endpoints and keeps both rotations reversible", () => {
    expect(mobileLayoutProfile(390, 844)).toBe("pt");
    expect(mobileLayoutProfile(844, 390)).toBe("ls");
    expect(mobileLayoutProfile(390, 844)).toBe("pt");

    expect(mobileLayoutProfile(633, 844)).toBe("iPad_pt");
    expect(mobileLayoutProfile(844, 633)).toBe("ls");
    expect(mobileLayoutProfile(633, 844)).toBe("iPad_pt");
  });

  it.each([
    { name: "phone portrait", width: 390 },
    { name: "tablet portrait", width: 633 },
    { name: "phone/tablet landscape", width: 844 },
  ])("projects the 750px authoring isotropically without horizontal overflow on $name", ({
    width,
  }) => {
    const authoredHeight = 4_800;
    const geometry = officialHelpProjectionGeometry(width, authoredHeight);
    expect(geometry.authoredWidthPx).toBe(750);
    expect(geometry.scaleX).toBe(geometry.scaleY);
    expect(geometry.projectedWidthPx).toBeLessThanOrEqual(width);
    expect(geometry.scrollWidthPx).toBeLessThanOrEqual(width);
    expect(geometry.projectedHeightPx).toBe(authoredHeight * geometry.scaleY);
    // 30/40 与 45/60 都留在作者层，绝不按 viewport 改字号或行盒。
    expect(PRIMAL_HELP_AUTHORING.body).toMatchObject({ fontSizePx: 30, lineHeightPx: 40 });
    expect(PRIMAL_HELP_AUTHORING.title).toMatchObject({ fontSizePx: 45, lineHeightPx: 60 });
  });

  it("uses a desktop sidebar but top tabs for phone and tablet", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.game-menu\s*\{[^}]*grid-template-columns:\s*128px 1fr;/s);
    expect(css).toMatch(
      /\.game-frame\[data-channel="mobile"\] \.game-menu\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*grid-template-columns:\s*none;/s,
    );
    expect(css).toMatch(/\.official-help\s*\{[^}]*width:\s*750px;[^}]*max-width:\s*none;/s);
    expect(css).toMatch(
      /\.official-help__section\s*>\s*h4\s*\{[^}]*ROBOTO_CONDENSED_BOLD[^}]*font-size:\s*45px;[^}]*line-height:\s*60px;/s,
    );
    expect(css).toMatch(
      /\.official-help__copy p\s*\{[^}]*height:\s*var\(--official-help-line-box-height,\s*40px\);[^}]*ROBOTO_CONDENSED_REGULAR[^}]*font-size:\s*30px;[^}]*line-height:\s*40px;/s,
    );
    expect(css).toMatch(/linear-gradient\(180deg,\s*#ff250a,\s*#ff710a\)/i);
    expect(css).toMatch(/-webkit-text-stroke:\s*10px\s+#5c0001/i);
    expect(css).toMatch(
      /\.official-help__artwork img\s*\{[^}]*width:\s*var\(--official-help-art-width\);[^}]*height:\s*var\(--official-help-art-height\);/s,
    );
    expect(css).toMatch(
      /\.official-help\s*\{[^}]*transform:\s*scale\(var\(--official-help-scale,\s*1\)\);[^}]*transform-origin:\s*top left;/s,
    );
    expect(css).toMatch(/\.official-help-viewport\s*\{[^}]*overflow-x:\s*clip;/s);
    expect(css).toMatch(
      /\.official-help-projection\s*\{[^}]*overflow:\s*clip;[^}]*contain:\s*layout size paint;/s,
    );
    expect(css).not.toMatch(/\.official-help__section\s*\{[^}]*grid-template-columns:\s*minmax\(/s);
  });
});
