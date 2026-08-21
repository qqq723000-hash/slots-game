import type { MoneyDisplayBinding, MoneyMinor } from "../app/state/types";

const CANONICAL_MONEY_MINOR = /^(0|[1-9]\d*)$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

export class MoneyDisplayBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyDisplayBindingError";
  }
}

export interface MinorUnitFormatter extends MoneyDisplayBinding {
  /** 面板/弹窗金额；可按需加入千位分隔符，但绝不经过浮点数。 */
  format(value: MoneyMinor, grouped?: boolean): string;
}

/**
 * 为一个已验证会话创建不可变格式器。闭包固定 currency/exponent，防止同一帧内
 * Balance、Bet、Win 分别读取到不同的可变配置。
 */
export function createMinorUnitFormatter(
  binding: Readonly<MoneyDisplayBinding>,
): MinorUnitFormatter {
  if (!CURRENCY_CODE.test(binding.currency)) {
    throw new MoneyDisplayBindingError("currency must be a three-letter uppercase code");
  }
  if (!Number.isSafeInteger(binding.currencyExponent)
    || binding.currencyExponent < 0
    || binding.currencyExponent > 6) {
    throw new MoneyDisplayBindingError("currencyExponent must be an integer from 0 to 6");
  }
  const currency = binding.currency;
  const currencyExponent = binding.currencyExponent;
  return Object.freeze({
    currency,
    currencyExponent,
    format(value: MoneyMinor, grouped = true): string {
      if (!CANONICAL_MONEY_MINOR.test(value)) {
        throw new MoneyDisplayBindingError("money must be a canonical non-negative minor-unit integer");
      }
      const minimumDigits = currencyExponent === 0 ? 1 : currencyExponent + 1;
      const normalized = value.padStart(minimumDigits, "0");
      const wholeDigits = currencyExponent === 0
        ? normalized
        : normalized.slice(0, -currencyExponent);
      const whole = grouped
        ? wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
        : wholeDigits;
      if (currencyExponent === 0) return whole;
      return `${whole}.${normalized.slice(-currencyExponent)}`;
    },
  });
}

/** 启动壳尚未取得权威会话时只用于不可交互占位；首个 SessionOpened 会替换它。 */
export const DEFAULT_MINOR_UNIT_FORMATTER = createMinorUnitFormatter({
  currency: "XXX",
  currencyExponent: 2,
});

export function sameMoneyDisplayBinding(
  left: Readonly<MoneyDisplayBinding>,
  right: Readonly<MoneyDisplayBinding>,
): boolean {
  return left.currency === right.currency
    && left.currencyExponent === right.currencyExponent;
}
