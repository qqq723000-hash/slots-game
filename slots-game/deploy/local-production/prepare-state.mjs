import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const configuredRoot = process.argv[2];
const validateOnly = process.argv[3] === "--validate-only";
if (!configuredRoot || (process.argv[3] && !validateOnly) || process.argv.length > 4) {
  throw new Error("usage: prepare-state.mjs STATE_ROOT [--validate-only]");
}
const stateRoot = resolve(configuredRoot);
const secretsRoot = resolve(stateRoot, "secrets");
const renderedRoot = resolve(stateRoot, "rendered");

for (const directory of [stateRoot, secretsRoot, renderedRoot, resolve(stateRoot, "backups"), resolve(stateRoot, "artifacts")]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${directory} must be a real directory`);
  chmodSync(directory, 0o700);
}

function secretPath(name) {
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(name)) throw new Error("invalid derived secret name");
  return resolve(secretsRoot, name);
}

function required(name) {
  const path = secretPath(name);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o137) !== 0) {
    throw new Error(`${name} must be a restricted regular file`);
  }
  return readFileSync(path, "utf8").trim();
}

function writeDerived(name, contents) {
  const path = secretPath(name);
  if (existsSync(path)) {
    if (required(name) === contents.trim()) return;
  }
  // 派生 DSN/环境文件可在同一代初始材料上原子式重渲染；原始密钥从不经过此函数。
  // English: Derived DSN/environment files can be atomically re-rendered on the same generation of the original
  // assets; the original key never goes through this function.
  const temporary = resolve(
    secretsRoot,
    `.${name}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    temporaryExists = true;
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    temporaryExists = false;
    chmodSync(path, 0o600);
    const directory = openSync(secretsRoot, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* cleanup continues */ }
    }
    if (temporaryExists) {
      try { unlinkSync(temporary); } catch { /* exclusive temporary may already be gone */ }
    }
  }
}

function readJSON(name) {
  return JSON.parse(required(name));
}

function requiredEnvironment(name, expression) {
  const value = process.env[name] ?? "";
  if (value !== value.trim()) throw new Error(`${name} must not contain surrounding whitespace`);
  if (!expression.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

for (const name of [
  "definition.json", "definition-approval.json", "operators.json", "deployment-metadata.json",
  "postgres-admin.password", "rgs-migrator.password", "rgs-runtime.password",
  "local-operator-owner.password", "local-operator-runtime.password",
  "local-production-root-ca.pem",
]) required(name);

const approval = readJSON("definition-approval.json");
const definitionIdentity = approval.approval;
if (approval.schema !== "rgs-definition-approval-v2" || !definitionIdentity?.sha256) {
  throw new Error("definition approval is not a production v2 envelope");
}
const operators = readJSON("operators.json");
const configuredOperator = operators.operators?.[0];
if (operators.schema !== "rgs-operators-v2" || !configuredOperator?.operatorId) {
  throw new Error("operators.json is not rgs-operators-v2");
}

// 镜像元数据由 bootstrap 在构建前注入；这里先拒绝伪造格式或带凭据的来源地址。
// English: Image metadata is injected by bootstrap before building; here, forged or credentialed source
// addresses are rejected.
const imageCreated = requiredEnvironment(
  "LOCAL_PRODUCTION_IMAGE_CREATED",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
);
if (Number.isNaN(Date.parse(imageCreated))) throw new Error("LOCAL_PRODUCTION_IMAGE_CREATED is invalid");
const imageRevision = requiredEnvironment(
  "LOCAL_PRODUCTION_IMAGE_REVISION",
  /^[0-9a-f]{40,64}(?:-dirty)?$/,
);
const imageVersion = requiredEnvironment(
  "LOCAL_PRODUCTION_IMAGE_VERSION",
  /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/,
);
const imageTag = requiredEnvironment(
  "LOCAL_PRODUCTION_IMAGE_TAG",
  /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
);
const assetApprovalHash = requiredEnvironment(
  "LOCAL_PRODUCTION_ASSET_APPROVAL_HASH",
  /^[a-f0-9]{64}$/,
);
const imageSource = requiredEnvironment(
  "LOCAL_PRODUCTION_IMAGE_SOURCE",
  /^https:\/\/[^\s]+$/,
);
const imageSourceURL = new URL(imageSource);
if (imageSourceURL.username || imageSourceURL.password || imageSourceURL.search || imageSourceURL.hash) {
  throw new Error("LOCAL_PRODUCTION_IMAGE_SOURCE must be a credential-free stable HTTPS URL");
}
if (validateOnly) {
  process.stdout.write("local production image metadata: valid\n");
  process.exit(0);
}

if (!existsSync(secretPath("postgres-backup.password"))) {
  writeFileSync(secretPath("postgres-backup.password"), `${randomBytes(32).toString("base64url")}\n`, {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
}
const rootCA = "/run/local-production/local-production-root-ca.pem";
const databaseURL = (role, passwordFile, database, certificatePath = rootCA) => (
  `postgres://${role}:${required(passwordFile)}@postgres:5432/${database}?sslmode=verify-full&sslrootcert=${certificatePath}\n`
);
writeDerived("rgs-runtime-database.url", databaseURL("rgs_runtime", "rgs-runtime.password", "rgs"));
writeDerived("rgs-migrator-database.url", databaseURL("rgs_migrator", "rgs-migrator.password", "rgs"));
writeDerived(
  "postgres-admin-local-operator.url",
  databaseURL("postgres", "postgres-admin.password", "local_operator"),
);

const environment = [
  `LOCAL_PRODUCTION_STATE_ROOT=${stateRoot}`,
  `LOCAL_PRODUCTION_GAME_ID=${definitionIdentity.gameId}`,
  `LOCAL_PRODUCTION_DEFINITION_VERSION=${definitionIdentity.version}`,
  `LOCAL_PRODUCTION_DEFINITION_HASH=${definitionIdentity.sha256}`,
  `LOCAL_PRODUCTION_OPERATOR_ID=${configuredOperator.operatorId}`,
  `LOCAL_PRODUCTION_IMAGE_CREATED=${imageCreated}`,
  `LOCAL_PRODUCTION_IMAGE_REVISION=${imageRevision}`,
  `LOCAL_PRODUCTION_IMAGE_SOURCE=${imageSourceURL.href.replace(/\/$/, "")}`,
  `LOCAL_PRODUCTION_IMAGE_VERSION=${imageVersion}`,
  `LOCAL_PRODUCTION_IMAGE_TAG=${imageTag}`,
  `LOCAL_PRODUCTION_ASSET_APPROVAL_HASH=${assetApprovalHash}`,
  "",
].join("\n");
writeDerived("compose.env", environment);
process.stdout.write("local production derived state: ready\n");
