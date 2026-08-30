import { pathToFileURL } from "node:url";

const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;
const REQUIRED_NAMES = [
  "VITE_RGS_BASE_URL",
  "VITE_RGS_BET_OPTIONS_MINOR",
  "VITE_RGS_DEFAULT_BET_MINOR",
  "VITE_RGS_HOST_ORIGIN",
];

function configurationError(message) {
  return new Error(message);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value === "") {
    throw configurationError(`${name} is required`);
  }
  return value;
}

function canonicalPositiveInt64(value, name) {
  if (!/^[1-9][0-9]*$/.test(value) || value.length > 19 || BigInt(value) > MAX_SIGNED_INT64) {
    throw configurationError(`${name} must contain canonical positive int64 values`);
  }
  return value;
}

/**
 * 发布构建在 Vite 内联配置前校验全部非秘密 RGS 参数。错误只报告字段契约，
 * 禁止回显配置值，以免未来字段演进时把宿主信息带入构建日志。
 *
 * 英文 / English: Release builds verify all non-secret RGS parameters before Vite inline configuration. Errors only report field contracts, and echoing of configuration values ​​is prohibited to avoid bringing host information into the build log when fields evolve in the future.
 */
export function validateReleaseRgsBuildEnvironment(environment) {
  const baseUrl = required(environment, "VITE_RGS_BASE_URL");
  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw configurationError("VITE_RGS_BASE_URL must be a credential-free HTTPS URL");
  }
  if (baseUrl.trim() !== baseUrl || parsedBase.protocol !== "https:"
    || parsedBase.username !== "" || parsedBase.password !== ""
    || parsedBase.search !== "" || parsedBase.hash !== "") {
    throw configurationError("VITE_RGS_BASE_URL must be a credential-free HTTPS URL");
  }

  const configuredBets = required(environment, "VITE_RGS_BET_OPTIONS_MINOR").split(",");
  if (configuredBets.length < 1 || configuredBets.length > 100) {
    throw configurationError("VITE_RGS_BET_OPTIONS_MINOR must contain 1-100 values");
  }
  configuredBets.forEach((value) => canonicalPositiveInt64(
    value,
    "VITE_RGS_BET_OPTIONS_MINOR",
  ));
  if (new Set(configuredBets).size !== configuredBets.length) {
    throw configurationError("VITE_RGS_BET_OPTIONS_MINOR values must be unique");
  }

  const defaultBet = canonicalPositiveInt64(
    required(environment, "VITE_RGS_DEFAULT_BET_MINOR"),
    "VITE_RGS_DEFAULT_BET_MINOR",
  );
  if (!configuredBets.includes(defaultBet)) {
    throw configurationError(
      "VITE_RGS_DEFAULT_BET_MINOR must occur in VITE_RGS_BET_OPTIONS_MINOR",
    );
  }

  const hostOrigin = required(environment, "VITE_RGS_HOST_ORIGIN");
  let parsedHost;
  try {
    parsedHost = new URL(hostOrigin);
  } catch {
    throw configurationError(
      "VITE_RGS_HOST_ORIGIN must be an exact credential-free HTTPS origin",
    );
  }
  if (hostOrigin === "*" || parsedHost.protocol !== "https:"
    || parsedHost.username !== "" || parsedHost.password !== ""
    || parsedHost.pathname !== "/" || parsedHost.search !== "" || parsedHost.hash !== ""
    || parsedHost.origin !== hostOrigin) {
    throw configurationError(
      "VITE_RGS_HOST_ORIGIN must be an exact credential-free HTTPS origin",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateReleaseRgsBuildEnvironment(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "release RGS configuration is invalid";
    process.stderr.write(`release RGS build configuration: ${message}\n`);
    process.exitCode = 2;
  }
}
