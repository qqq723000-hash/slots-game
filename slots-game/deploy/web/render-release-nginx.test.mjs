import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import { renderReleaseNginxConfig } from "./render-release-nginx.mjs";

const baseConfig = await readFile(new URL("./nginx.conf", import.meta.url), "utf8");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "slots-release-nginx-test-"));
after(() => rm(temporaryDirectory, { recursive: true, force: true }));

test("renders exact operator frame and RGS connect origins without X-Frame-Options", () => {
  const rendered = renderReleaseNginxConfig(baseConfig, {
    rgsBaseUrl: "https://rgs.example/api/v1",
    hostOrigin: "https://operator.example",
  });
  assert.match(rendered, /connect-src 'self' https:\/\/rgs\.example;/);
  assert.match(rendered, /frame-ancestors https:\/\/operator\.example/);
  assert.doesNotMatch(rendered, /X-Frame-Options|frame-ancestors \*|connect-src \*/);
  assert.equal((rendered.match(/add_header Content-Security-Policy/g) ?? []).length, 1);
  assert.equal((rendered.match(/connect-src/g) ?? []).length, 1);
  assert.equal((rendered.match(/frame-ancestors/g) ?? []).length, 1);
});

test("same reviewed inputs render byte-identically and rendered policy cannot be rendered again", () => {
  const options = {
    rgsBaseUrl: "https://rgs.example/api/v1",
    hostOrigin: "https://operator.example",
  };
  const first = renderReleaseNginxConfig(baseConfig, options);
  const second = renderReleaseNginxConfig(baseConfig, options);
  assert.equal(first, second);
  assert.throws(() => renderReleaseNginxConfig(first, options), /X-Frame-Options|frame-ancestors/);
});

for (const hostOrigin of [
  "*",
  "http://operator.example",
  "https://operator.example/",
  "https://operator.example/path",
  "https://operator.example?tenant=a",
  "https://operator.example#frame",
  "https://user@operator.example",
  "https://operator.example\nadd_header X-Test injected",
]) {
  test(`rejects unsafe operator host origin ${JSON.stringify(hostOrigin)}`, () => {
    assert.throws(() => renderReleaseNginxConfig(baseConfig, {
      rgsBaseUrl: "https://rgs.example/api",
      hostOrigin,
    }), /exact credential-free HTTPS origin/);
  });
}

for (const rgsBaseUrl of [
  "http://rgs.example",
  "https://user@rgs.example",
  "https://rgs.example/api?tenant=a",
  "https://rgs.example/api#fragment",
  "https://rgs.example\nconnect-src *",
]) {
  test(`rejects unsafe RGS base URL ${JSON.stringify(rgsBaseUrl)}`, () => {
    assert.throws(() => renderReleaseNginxConfig(baseConfig, {
      rgsBaseUrl,
      hostOrigin: "https://operator.example",
    }), /credential-free HTTPS origin\/path/);
  });
}

test("fails closed when the reviewed base policy drifts", () => {
  assert.throws(() => renderReleaseNginxConfig(
    baseConfig.replace("frame-ancestors 'self'", "frame-ancestors https://drift.invalid"),
    { rgsBaseUrl: "https://rgs.example", hostOrigin: "https://operator.example" },
  ), /exact frame-ancestors 'self'/);
});

for (const drift of [
  baseConfig.replace("connect-src 'self';", "connect-src https:; connect-src 'self';"),
  baseConfig.replace("frame-ancestors 'self'", "frame-ancestors https:; frame-ancestors 'self'"),
  baseConfig.replace(
    '  add_header Content-Security-Policy',
    '  add_header Content-Security-Policy "default-src \'none\'" always;\n  add_header Content-Security-Policy',
  ),
]) {
  test("rejects duplicate or shadowing CSP directives", () => {
    assert.throws(() => renderReleaseNginxConfig(drift, {
      rgsBaseUrl: "https://rgs.example",
      hostOrigin: "https://operator.example",
    }), /duplicate|exactly one Content-Security-Policy/);
  });
}

test("ignores comment bait but rejects a case-insensitive second X-Frame-Options header", () => {
  const bait = `# connect-src 'self'; frame-ancestors 'self'\n${baseConfig}`;
  assert.doesNotThrow(() => renderReleaseNginxConfig(bait, {
    rgsBaseUrl: "https://rgs.example",
    hostOrigin: "https://operator.example",
  }));
  const duplicated = baseConfig.replace(
    'add_header X-Frame-Options "SAMEORIGIN" always;',
    'add_header X-Frame-Options "SAMEORIGIN" always;\n  add_header x-frame-options "DENY" always;',
  );
  assert.throws(() => renderReleaseNginxConfig(duplicated, {
    rgsBaseUrl: "https://rgs.example",
    hostOrigin: "https://operator.example",
  }), /exactly one X-Frame-Options/);
});

test("CLI writes atomically and fails without leaving output for malformed input", async () => {
  const input = join(temporaryDirectory, "nginx.conf");
  const output = join(temporaryDirectory, "release.conf");
  await writeFile(input, baseConfig, "utf8");
  const script = new URL("./render-release-nginx.mjs", import.meta.url);
  const success = spawnSync(process.execPath, [
    script.pathname,
    "--input", input,
    "--output", output,
    "--rgs-base-url", "https://rgs.example/api",
    "--host-origin", "https://operator.example",
  ], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.match(await readFile(output, "utf8"), /frame-ancestors https:\/\/operator\.example/);

  const rejectedOutput = join(temporaryDirectory, "rejected.conf");
  const rejected = spawnSync(process.execPath, [
    script.pathname,
    "--input", input,
    "--output", rejectedOutput,
    "--rgs-base-url", "http://rgs.example",
    "--host-origin", "https://operator.example",
  ], { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  await assert.rejects(access(rejectedOutput));
});

for (const argumentsList of [
  [],
  ["--input"],
  ["--unknown", "value", "--output", "value", "--rgs-base-url", "value", "--host-origin", "value"],
  ["--input", "a", "--input", "b", "--output", "c", "--rgs-base-url", "d", "--host-origin", "e"],
]) {
  test(`CLI rejects malformed arguments ${JSON.stringify(argumentsList)}`, () => {
    const script = new URL("./render-release-nginx.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [script.pathname, ...argumentsList], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  });
}
