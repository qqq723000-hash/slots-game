export const OPERATOR_APPROVED_GAME_RULES_LIMITS = Object.freeze({
  localeLength: 16,
  versionLength: 64,
  sectionCount: 12,
  titleLength: 96,
  paragraphsPerSection: 16,
  paragraphLength: 1_000,
  totalTextLength: 24_000,
} as const);

export interface OperatorApprovedGameRulesSectionInput {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface OperatorApprovedGameRulesBundleInput {
  readonly locale: string;
  readonly version: string;
  readonly sections: readonly Readonly<OperatorApprovedGameRulesSectionInput>[];
}

export interface ApprovedPlayerGameRulesSection {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/** 仅面向玩家的投影；其中刻意不包含引擎或 RGS 元数据。 / English: A player-facing projection only; it intentionally does not include engine or RGS metadata. */
export interface ApprovedPlayerGameRulesProjection {
  readonly locale: string;
  readonly version: string;
  readonly sections: readonly Readonly<ApprovedPlayerGameRulesSection>[];
}

export type OperatorApprovedGameRulesValidationIssueCode =
  | "invalid-bundle-shape"
  | "invalid-locale"
  | "invalid-version"
  | "invalid-sections"
  | "invalid-section-shape"
  | "invalid-title"
  | "invalid-paragraphs"
  | "invalid-paragraph"
  | "total-text-oversized";

export interface OperatorApprovedGameRulesValidationIssue {
  readonly code: OperatorApprovedGameRulesValidationIssueCode;
  readonly path: string;
}

export type OperatorApprovedGameRulesValidationResult =
  | Readonly<{
    readonly ok: true;
    readonly projection: Readonly<ApprovedPlayerGameRulesProjection>;
  }>
  | Readonly<{
    readonly ok: false;
    readonly issues: readonly Readonly<OperatorApprovedGameRulesValidationIssue>[];
  }>;

const SAFE_LOCALE_PATTERN = /^[a-z]{2,3}(?:[_-](?:[A-Z]{2}|[0-9]{3}))?$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSAFE_PLAYER_TEXT_PATTERN = /[<>\p{Cc}\p{Cf}]/u;

function isPlainRecordWithExactDataKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== expectedKeys.length
      || !expectedKeys.every((key) => ownKeys.includes(key))) return false;
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isClosedDenseArray(value: unknown, maximumLength: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumLength) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) return false;
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      if (!ownKeys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isSafeBoundedText(value: unknown, maximumLength: number): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    return false;
  }
  if (value.trim() !== value || Array.from(value).length > maximumLength) return false;
  return !UNSAFE_PLAYER_TEXT_PATTERN.test(value);
}

function issue(
  code: OperatorApprovedGameRulesValidationIssueCode,
  path: string,
): Readonly<OperatorApprovedGameRulesValidationIssue> {
  return Object.freeze({ code, path });
}

function invalid(
  issues: readonly Readonly<OperatorApprovedGameRulesValidationIssue>[],
): OperatorApprovedGameRulesValidationResult {
  return Object.freeze({ ok: false, issues: Object.freeze([...issues]) });
}

/**
 * 校验操作方提供且已审批的玩家规则包，并仅投影可展示文本。
 * 模块不附带备用监管文案：校验失败时，调用方必须显示中性的不可用状态。
 *
 * 英文 / English: Validates the operator-provided and approved player rules package and projects only displayable text. The module does not come with backup supervision documentation: when verification fails, the caller must display a neutral unavailable status.
 */
export function validateOperatorApprovedGameRulesBundle(
  input: unknown,
): OperatorApprovedGameRulesValidationResult {
  try {
    if (!isPlainRecordWithExactDataKeys(input, ["locale", "version", "sections"])) {
      return invalid([issue("invalid-bundle-shape", "$")]);
    }

    const issues: Readonly<OperatorApprovedGameRulesValidationIssue>[] = [];
    const locale = input.locale;
    const version = input.version;
    const sections = input.sections;

    if (typeof locale !== "string"
      || locale.length > OPERATOR_APPROVED_GAME_RULES_LIMITS.localeLength
      || !SAFE_LOCALE_PATTERN.test(locale)) {
      issues.push(issue("invalid-locale", "$.locale"));
    }
    if (typeof version !== "string"
      || version.length > OPERATOR_APPROVED_GAME_RULES_LIMITS.versionLength
      || !SAFE_VERSION_PATTERN.test(version)) {
      issues.push(issue("invalid-version", "$.version"));
    }
    if (!isClosedDenseArray(
      sections,
      OPERATOR_APPROVED_GAME_RULES_LIMITS.sectionCount,
    )) {
      issues.push(issue("invalid-sections", "$.sections"));
      return invalid(issues);
    }

    let totalTextLength = typeof locale === "string"
      && locale.length <= OPERATOR_APPROVED_GAME_RULES_LIMITS.localeLength
      ? locale.length
      : 0;
    totalTextLength += typeof version === "string"
      && version.length <= OPERATOR_APPROVED_GAME_RULES_LIMITS.versionLength
      ? version.length
      : 0;
    const safeSections: Readonly<ApprovedPlayerGameRulesSection>[] = [];

    for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      const section = sections[sectionIndex];
      const sectionPath = `$.sections[${sectionIndex}]`;
      if (!isPlainRecordWithExactDataKeys(section, ["title", "paragraphs"])) {
        issues.push(issue("invalid-section-shape", sectionPath));
        continue;
      }

      const title = section.title;
      const paragraphs = section.paragraphs;
      const titleValid = isSafeBoundedText(
        title,
        OPERATOR_APPROVED_GAME_RULES_LIMITS.titleLength,
      );
      if (!titleValid) issues.push(issue("invalid-title", `${sectionPath}.title`));
      if (!isClosedDenseArray(
        paragraphs,
        OPERATOR_APPROVED_GAME_RULES_LIMITS.paragraphsPerSection,
      )) {
        issues.push(issue("invalid-paragraphs", `${sectionPath}.paragraphs`));
        continue;
      }

      const safeParagraphs: string[] = [];
      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
        const paragraph = paragraphs[paragraphIndex];
        if (!isSafeBoundedText(
          paragraph,
          OPERATOR_APPROVED_GAME_RULES_LIMITS.paragraphLength,
        )) {
          issues.push(issue(
            "invalid-paragraph",
            `${sectionPath}.paragraphs[${paragraphIndex}]`,
          ));
          continue;
        }
        totalTextLength += Array.from(paragraph).length;
        safeParagraphs.push(paragraph);
      }

      if (titleValid && safeParagraphs.length === paragraphs.length) {
        totalTextLength += Array.from(title).length;
        safeSections.push(Object.freeze({
          title,
          paragraphs: Object.freeze(safeParagraphs),
        }));
      }
    }

    if (totalTextLength > OPERATOR_APPROVED_GAME_RULES_LIMITS.totalTextLength) {
      issues.push(issue("total-text-oversized", "$"));
    }
    if (issues.length > 0) return invalid(issues);

    const projection: Readonly<ApprovedPlayerGameRulesProjection> = Object.freeze({
      locale: locale as string,
      version: version as string,
      sections: Object.freeze(safeSections),
    });
    return Object.freeze({ ok: true, projection });
  } catch {
    return invalid([issue("invalid-bundle-shape", "$")]);
  }
}
