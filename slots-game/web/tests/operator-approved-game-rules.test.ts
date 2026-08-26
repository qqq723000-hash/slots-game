import { describe, expect, it } from "vitest";

import {
  OPERATOR_APPROVED_GAME_RULES_LIMITS,
  validateOperatorApprovedGameRulesBundle,
} from "../src/ui/operatorApprovedGameRules";

function validBundle(): unknown {
  return {
    locale: "en_GB",
    version: "operator-reviewed-2026.08",
    sections: [
      {
        title: "Game Rules",
        paragraphs: [
          "The operator supplies approved player-facing rules for this release.",
          "Each paragraph is rendered as plain text.",
        ],
      },
      {
        title: "Session",
        paragraphs: ["Return to the operator when the session ends."],
      },
    ],
  };
}

describe("operator-approved player Game Rules", () => {
  it("returns a deeply immutable player-only projection for a closed bundle", () => {
    const result = validateOperatorApprovedGameRulesBundle(validBundle());

    expect(result).toMatchObject({
      ok: true,
      projection: {
        locale: "en_GB",
        version: "operator-reviewed-2026.08",
        sections: [
          {
            title: "Game Rules",
            paragraphs: [
              "The operator supplies approved player-facing rules for this release.",
              "Each paragraph is rendered as plain text.",
            ],
          },
          {
            title: "Session",
            paragraphs: ["Return to the operator when the session ends."],
          },
        ],
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok) throw new Error("expected valid rules projection");
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.sections)).toBe(true);
    expect(Object.isFrozen(result.projection.sections[0])).toBe(true);
    expect(Object.isFrozen(result.projection.sections[0]?.paragraphs)).toBe(true);
    expect(JSON.stringify(result.projection)).not.toMatch(
      /definitionHash|engine|RGS|allow-list|error|token|secret/i,
    );
  });

  it.each([
    ["root extra", { ...validBundle() as object, definitionHash: "private-diagnostic" }],
    ["wrong locale", { ...validBundle() as object, locale: "../../en_GB" }],
    ["wrong version", { ...validBundle() as object, version: "reviewed version" }],
    ["empty sections", { ...validBundle() as object, sections: [] }],
    ["non-array sections", { ...validBundle() as object, sections: "rules" }],
    ["section extra", {
      ...validBundle() as object,
      sections: [{ title: "Rules", paragraphs: ["Approved."], html: "<p>secret</p>" }],
    }],
    ["empty title", {
      ...validBundle() as object,
      sections: [{ title: " ", paragraphs: ["Approved."] }],
    }],
    ["empty paragraphs", {
      ...validBundle() as object,
      sections: [{ title: "Rules", paragraphs: [] }],
    }],
  ])("fails closed for invalid shape: %s", (_label, input) => {
    const result = validateOperatorApprovedGameRulesBundle(input);

    expect(result.ok).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) throw new Error("expected validation failure");
    expect(Object.isFrozen(result.issues)).toBe(true);
    expect(JSON.stringify(result.issues)).not.toContain("private-diagnostic");
  });

  it.each([
    ["HTML", "Use <strong>approved</strong> rules."],
    ["tag fragment", "A result is > the stated limit."],
    ["C0 control", "Visible\u0000hidden"],
    ["line break", "First line\nsecond line"],
    ["format control", "left\u202Etxt"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects %s in player paragraphs", (_label, paragraph) => {
    const input = validBundle() as {
      sections: Array<{ title: string; paragraphs: string[] }>;
    };
    input.sections[0]!.paragraphs = [paragraph];

    const result = validateOperatorApprovedGameRulesBundle(input);

    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-paragraph", path: "$.sections[0].paragraphs[0]" }],
    });
  });

  it("rejects oversized values and aggregate text without echoing the text", () => {
    const oversizedParagraphInput = validBundle() as {
      sections: Array<{ title: string; paragraphs: string[] }>;
    };
    oversizedParagraphInput.sections[0]!.paragraphs = [
      "S".repeat(OPERATOR_APPROVED_GAME_RULES_LIMITS.paragraphLength + 1),
    ];
    const oversizedParagraph = validateOperatorApprovedGameRulesBundle(
      oversizedParagraphInput,
    );
    expect(oversizedParagraph).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-paragraph" }],
    });

    const aggregateInput = {
      locale: "en_GB",
      version: "approved-1",
      sections: Array.from(
        { length: OPERATOR_APPROVED_GAME_RULES_LIMITS.sectionCount },
        (_, sectionIndex) => ({
          title: `Section-${sectionIndex}`,
          paragraphs: Array.from(
            { length: OPERATOR_APPROVED_GAME_RULES_LIMITS.paragraphsPerSection },
            () => "P".repeat(OPERATOR_APPROVED_GAME_RULES_LIMITS.paragraphLength),
          ),
        }),
      ),
    };
    const aggregate = validateOperatorApprovedGameRulesBundle(aggregateInput);
    expect(aggregate).toMatchObject({
      ok: false,
      issues: [{ code: "total-text-oversized", path: "$" }],
    });
    expect(JSON.stringify(aggregate)).not.toContain("P".repeat(100));
  });

  it("rejects accessors and sparse or decorated arrays at the external boundary", () => {
    const accessorBundle = validBundle() as Record<string, unknown>;
    Object.defineProperty(accessorBundle, "locale", {
      enumerable: true,
      get: () => "en_GB",
    });
    expect(validateOperatorApprovedGameRulesBundle(accessorBundle)).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-bundle-shape" }],
    });

    const decoratedSections = (validBundle() as { sections: unknown[] }).sections;
    Object.assign(decoratedSections, { rawError: "secret" });
    expect(validateOperatorApprovedGameRulesBundle({
      locale: "en_GB",
      version: "approved-1",
      sections: decoratedSections,
    })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-sections" }],
    });
  });
});
