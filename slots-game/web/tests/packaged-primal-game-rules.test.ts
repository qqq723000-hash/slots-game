import { describe, expect, it } from "vitest";

import {
  PACKAGED_PRIMAL_GAME_RULES,
  PACKAGED_PRIMAL_GAME_RULES_EN_GB,
} from "../src/ui/packagedPrimalGameRules";

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("packaged Primal Rampage public Game Rules", () => {
  it("exports the exact en_GB page and section order for a neutral document renderer", () => {
    expect(PACKAGED_PRIMAL_GAME_RULES.en_GB).toBe(PACKAGED_PRIMAL_GAME_RULES_EN_GB);
    expect(PACKAGED_PRIMAL_GAME_RULES_EN_GB.locale).toBe("en_GB");
    expect(PACKAGED_PRIMAL_GAME_RULES_EN_GB.pageTitle).toBe("Primal Rampage");
    expect(PACKAGED_PRIMAL_GAME_RULES_EN_GB.sections.map(({ id, title }) => ({ id, title })))
      .toEqual([
        { id: "information", title: "Information" },
        { id: "game-rules", title: "Game Rules" },
        { id: "wild", title: "WILD" },
        { id: "vault-bonus", title: "VAULT BONUS" },
        { id: "rage-symbol", title: "RAGE SYMBOL" },
        { id: "primal-wheel", title: "PRIMAL WHEEL" },
        { id: "kong-quest-free-spins", title: "KONG QUEST FREE SPINS" },
        { id: "king-spin-free-spins", title: "KING SPIN FREE SPINS" },
        { id: "actions", title: "Actions" },
      ]);
  });

  it("preserves the captured public gameplay disclosures and feature limits", () => {
    const text = stringsIn(PACKAGED_PRIMAL_GAME_RULES_EN_GB).join("\n");
    expect(text).toContain(
      "Free Spin features are played with the same bet as the game round that triggered the feature – unless otherwise stated.",
    );
    expect(text).toContain("Only the highest win is paid per winning symbol combination.");
    expect(text).toContain(
      "The number of ways to win are 27 for 3x3, 64 for 3x4, 125 for 3x5, 216 for 3x6, 343 for 3x7 and 512 for 3x8.",
    );
    expect(text).toContain("Free Spins in Kong Quest are capped at 30.");
    expect(text).toContain("Free Spins in King Spin are capped at 8.");
    expect(text).toContain("The PRIMAL WHEEL presentation does not reflect real probabilities.");
    expect(text).toContain(
      "GRAND (X1000), MEGA (X250), MAJOR (X75), MINOR (X30), MINI (X10)",
    );
    expect(text).toContain(
      "GRAND (X1000), MEGA2X (X500), MEGA (X250), MAJOR2X (X150), MAJOR (X75), MINOR2X (X60), MINOR (X30), MINI2X (X20), MINI (X10), X9, X8, X7, X6, X5, X4, X3, X2, and X1.",
    );
    expect(text).toContain("King Spin\u00a0can only trigger from the\u00a0Primal Wheel!");
  });

  it("keeps the captured Actions copy as text-only structured entries", () => {
    const actions = PACKAGED_PRIMAL_GAME_RULES_EN_GB.sections.at(-1);
    expect(actions).toMatchObject({ id: "actions", title: "Actions" });
    expect(actions?.actions.map(({ title }) => title)).toEqual([
      "Paytable",
      "Auto Play",
      "Spin / Start / Spacebar",
      "Stop",
      "Fast Play",
    ]);
    expect(actions?.paragraphs).toEqual([
      "Bets are selected using the bet buttons. Click the plus and minus buttons to change the bet one step at a time. Way wins are awarded for left to right adjacent symbol combinations. To start the round, click SPIN. When the reels stop, the symbols displayed determine your prize according to the paytable.",
    ]);
    const text = stringsIn(actions).join("\n");
    expect(text).not.toContain("Hyper Spin");
    expect(text).not.toContain("holding down the SPACE button");
    expect(text).not.toContain("Auto adjust bet");
    expect(text).not.toContain("Automatically reduces the total bet");
  });

  it("is recursively frozen and contains no HTML-bearing shape or unsafe text", () => {
    expectDeepFrozen(PACKAGED_PRIMAL_GAME_RULES);
    const keys = Object.keys(PACKAGED_PRIMAL_GAME_RULES_EN_GB.sections)
      .concat(PACKAGED_PRIMAL_GAME_RULES_EN_GB.sections.flatMap((section) => Object.keys(section)))
      .concat(PACKAGED_PRIMAL_GAME_RULES_EN_GB.sections.flatMap((section) => (
        section.actions.flatMap((entry) => Object.keys(entry))
      )));
    expect(keys).not.toContain("html");
    expect(keys).not.toContain("markup");
    for (const text of stringsIn(PACKAGED_PRIMAL_GAME_RULES)) {
      expect(text).not.toMatch(/[<>]/u);
      expect(text).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u);
    }
  });

  it("excludes operator retention, malfunction and internal math-policy copy", () => {
    const text = stringsIn(PACKAGED_PRIMAL_GAME_RULES_EN_GB).join("\n");
    expect(text).not.toMatch(
      /unfinished games?|90 days|180 days|malfunction|voids all pays|collectibles|retention|operator|jurisdiction|regulat(?:or|ory)/iu,
    );
    expect(text).not.toMatch(
      /\bRTP\b|return to player|volatility|reel weights?|hit frequency|probability table|random number generator|\bRNG\b/iu,
    );
    expect(text.match(/\bprobabilit(?:y|ies)\b/giu)).toEqual(["probabilities"]);
  });
});
