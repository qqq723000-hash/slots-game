// @ts-nocheck -- 清单一致性测试使用 Node 标准库 API，而浏览器应用的 TypeScript
// 配置排除了 Node 类型。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  validateAssetPackageManifest,
  type AssetPackageManifest,
} from "../src/startup/StreamingAssetPackages";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(testDirectory, "..");
const publicDirectory = join(webDirectory, "public");
const runtimeDirectory = join(publicDirectory, "assets/primal-runtime");
const runtimeManifestPath = join(runtimeDirectory, "runtime-manifest.json");
const generatorPath = join(
  webDirectory,
  "scripts/generate-streaming-package-manifests.mjs",
);

const channels = ["desktop", "mobile"] as const;
const PHASE_B_MAX_OPERATION_BYTES = 16 * 1024 * 1024;
const expectedFeatureClosureBytes = {
  desktop: 12_499_819,
  mobile: 12_152_678,
} as const;

function loadPackageManifest(
  channel: (typeof channels)[number],
): AssetPackageManifest {
  return JSON.parse(
    readFileSync(
      join(runtimeDirectory, `streaming-packages.${channel}.json`),
      "utf8",
    ),
  ) as AssetPackageManifest;
}

function filePath(publicUrl: string): string {
  expect(publicUrl).toMatch(/^\/assets\/primal-runtime\//);
  const path = resolve(publicDirectory, `.${publicUrl}`);
  expect(path.startsWith(`${publicDirectory}/`)).toBe(true);
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function atlasPageNames(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.(?:avif|png|jpe?g|webp)$/i.test(line))
    .sort();
}

describe("checked-in streaming package manifests", () => {
  it("are reproducible from the checked runtime manifest without network access", () => {
    const source = readFileSync(generatorPath, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("node:http");
    expect(source).not.toContain("node:https");

    const result = spawnSync(process.execPath, [generatorPath, "--check"], {
      cwd: webDirectory,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Verified deterministic streaming package manifests",
    );
  });

  it.each(channels)(
    "validates the %s dependency graph and covers every authoritative URL once",
    (channel) => {
      const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
      const manifest = loadPackageManifest(channel);
      const validated = validateAssetPackageManifest(manifest);
      expect(validated.manifest.assetSet).toBe(
        `primal-rampage-runtime:${channel}`,
      );
      expect(validated.manifest.packages).toHaveLength(14);
      expect(validated.dependencyOrder).toHaveLength(14);

      const actual = new Set(
        validated.manifest.packages.flatMap((entry) =>
          entry.resources.map((resource) => resource.url),
        ),
      );
      const expected: string[] = [];
      const textureGroups =
        channel === "desktop"
          ? runtime.spine.groups
          : runtime.mobile.spine.groups;
      for (const group of textureGroups) {
        expected.push(
          group.atlas.publicUrl,
          ...group.pages.map((entry) => entry.publicUrl),
        );
      }
      for (const group of runtime.spine.groups) {
        expected.push(...group.skeletons.map((entry) => entry.publicUrl));
      }
      const audio =
        channel === "desktop" ? runtime.audio : runtime.mobile.audio;
      expected.push(
        ...audio.aggregateManifests.map((entry) => entry.publicUrl),
        ...audio.spriteManifests.map((entry) => entry.publicUrl),
        ...audio.sprites.map((entry) => entry.publicUrl),
        ...runtime.interface.files.map((entry) => entry.publicUrl),
      );
      if (channel === "mobile") {
        expected.push(
          ...runtime.mobile.configuration.files.map((entry) => entry.publicUrl),
          ...runtime.mobile.interface.files.map((entry) => entry.publicUrl),
        );
      }

      expect(actual.size).toBe(expected.length);
      expect([...actual].sort()).toEqual([...expected].sort());
    },
  );

  it.each(channels)(
    "binds every %s descriptor to an existing file with exact bytes and SHA-256",
    (channel) => {
      const manifest = loadPackageManifest(channel);
      for (const entry of manifest.packages) {
        for (const resource of entry.resources) {
          const path = filePath(resource.url);
          expect(statSync(path).isFile(), resource.url).toBe(true);
          expect(statSync(path).size, resource.url).toBe(resource.bytes);
          expect(sha256(path), resource.url).toBe(resource.sha256);
        }
      }
    },
  );

  it.each(channels)(
    "keeps %s atlas, pages and skeleton dependencies atomic",
    (channel) => {
      const manifest = loadPackageManifest(channel);
      const packages = new Map(
        manifest.packages.map((entry) => [entry.id, entry]),
      );
      const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
      const groups =
        channel === "desktop"
          ? runtime.spine.groups
          : runtime.mobile.spine.groups;

      for (const group of groups) {
        const short = group.id.replace(/^spine_/, "");
        const sharedId = `${channel}-spine-${short}-shared`;
        const shared = packages.get(sharedId)!;
        expect(shared, sharedId).toBeDefined();
        expect(shared.resources.map((entry) => entry.url).sort()).toEqual(
          [
            group.atlas.publicUrl,
            ...group.pages.map((entry) => entry.publicUrl),
          ].sort(),
        );
        expect(atlasPageNames(filePath(group.atlas.publicUrl))).toEqual(
          group.pages.map((entry) => basename(entry.publicUrl)).sort(),
        );
      }

      for (const entry of manifest.packages) {
        for (const resource of entry.resources.filter((candidate) =>
          candidate.url.endsWith(".skel"),
        )) {
          const group = resource.url.split("/").at(-2)!;
          const sharedId = `${channel}-spine-${group.replace(/^spine_/, "")}-shared`;
          expect(entry.dependsOn, `${entry.id}:${resource.url}`).toContain(
            sharedId,
          );
        }
      }
    },
  );

  it.each(channels)(
    "exposes independent %s Wheel, Free Spins and Big Win skeleton gates",
    (channel) => {
      const packages = new Map(
        loadPackageManifest(channel).packages.map((entry) => [entry.id, entry]),
      );
      const wheel = packages.get(`${channel}-feature-wheel`)!;
      const freeSpins = packages.get(`${channel}-feature-free-spins`)!;
      const bigWin = packages.get(`${channel}-feature-big-win`)!;

      expect(
        wheel.resources.filter((entry) => entry.url.endsWith(".skel")),
      ).toHaveLength(5);
      expect(
        freeSpins.resources.filter((entry) => entry.url.endsWith(".skel")),
      ).toHaveLength(5);
      expect(
        bigWin.resources.filter((entry) => entry.url.endsWith(".skel")),
      ).toHaveLength(1);
      expect(
        bigWin.resources.some((entry) => entry.url.endsWith("/BigWin.skel")),
      ).toBe(true);
      expect(
        bigWin.resources.some((entry) =>
          entry.url.endsWith("/big-win-coins.json"),
        ),
      ).toBe(true);
      for (const entry of [wheel, freeSpins]) {
        expect(entry.stage).toBe("feature-on-demand");
        expect(entry.dependsOn).toEqual([
          `${channel}-spine-ui-shared`,
          `${channel}-interaction-audio`,
        ]);
      }
      expect(bigWin.stage).toBe("feature-on-demand");
      expect(bigWin.dependsOn).toEqual([
        `${channel}-spine-ui-shared`,
      ]);
    },
  );

  it.each(channels)(
    "keeps the real %s Phase-B feature closure below the 16 MiB heap guard",
    (channel) => {
      const manifest = loadPackageManifest(channel);
      const byId = new Map(manifest.packages.map((entry) => [entry.id, entry]));
      const selected = new Set<string>();
      const visit = (id: string): void => {
        if (selected.has(id)) return;
        const entry = byId.get(id)!;
        expect(entry, id).toBeDefined();
        for (const dependency of entry.dependsOn ?? []) visit(dependency);
        selected.add(id);
      };
      for (const entry of manifest.packages.filter(
        (candidate) => candidate.stage === "feature-on-demand",
      ))
        visit(entry.id);

      const bytes = [...selected].reduce(
        (total, id) =>
          total +
          byId
            .get(id)!
            .resources.reduce((sum, resource) => sum + resource.bytes, 0),
        0,
      );
      expect(bytes).toBe(expectedFeatureClosureBytes[channel]);
      expect(bytes).toBeLessThanOrEqual(PHASE_B_MAX_OPERATION_BYTES);
    },
  );

  it.each(channels)(
    "keeps the %s Big Win visual lease independent from strict audio ownership",
    (channel) => {
      const manifest = loadPackageManifest(channel);
      const byId = new Map(manifest.packages.map((entry) => [entry.id, entry]));
      const selected = new Set<string>();
      const visit = (id: string): void => {
        if (selected.has(id)) return;
        const entry = byId.get(id)!;
        expect(entry, id).toBeDefined();
        for (const dependency of entry.dependsOn ?? []) visit(dependency);
        selected.add(id);
      };
      visit(`${channel}-feature-big-win`);

      expect(selected.has(`${channel}-interaction-audio`)).toBe(false);
      const bytes = [...selected].reduce(
        (total, id) => total + byId.get(id)!.resources.reduce(
          (sum, resource) => sum + resource.bytes,
          0,
        ),
        0,
      );
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(expectedFeatureClosureBytes[channel]);
    },
  );
});
