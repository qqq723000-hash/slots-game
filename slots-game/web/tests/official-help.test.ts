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
import { PAYTABLE_WILD_ENTRIES } from "../src/ui/DomOverlay";
import {
  PRIMAL_HELP_SECTIONS,
  PRIMAL_PRESENTATION_DEFINITION_BINDINGS,
  PRIMAL_PRESENTATION_RULES,
  PRIMAL_WAY_WINS_COPY,
  bindPrimalPresentationRules,
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
      version: "primal-rampage-help-en-gb-v1",
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
    expect(rgsSessionOpened(exchange, ["100"], "100").definitionBinding).toEqual(APPROVED);
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

  it("uses a desktop sidebar but top tabs for phone and tablet", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.game-menu\s*\{[^}]*grid-template-columns:\s*128px 1fr;/s);
    expect(css).toMatch(
      /\.game-frame\[data-channel="mobile"\] \.game-menu\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*grid-template-columns:\s*none;/s,
    );
    expect(css).toMatch(
      /data-mobile-layout="pt"\] \.base-paytable__grid\s*\{[^}]*repeat\(3,/s,
    );
    expect(css).toMatch(
      /data-mobile-layout="iPad_pt"\] \.base-paytable__grid,[^}]*repeat\(6,/s,
    );
  });
});
