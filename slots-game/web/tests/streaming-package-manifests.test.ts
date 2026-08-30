// @ts-nocheck -- 清单一致性测试使用 Node 标准库 API，而浏览器应用的 TypeScript / English: @ts-nocheck -- Manifest conformance testing uses the Node standard library API and the browser application's TypeScript
// 配置排除了 Node 类型。 / English: Configuration excludes Node type.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  validateAudioSpriteDescriptorBinding,
  verifyAudioSpriteDescriptorBindings,
} from "../scripts/audio-sprite-descriptor-contract.mjs";
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
  desktop: 13_700_382,
  mobile: 13_353_241,
} as const;
const EXPECTED_BIG_WIN_EXCLUSIVE_BYTES = 4_044_706;
const expectedBigWinClosureBytes = {
  desktop: 5_411_960,
  mobile: 5_050_531,
} as const;
const EXPECTED_WHEEL_EXCLUSIVE_BYTES = 1_507_291;
const EXPECTED_FREE_SPINS_EXCLUSIVE_BYTES = 117_536;
const expectedWheelClosureBytes = {
  desktop: 9_538_140,
  mobile: 9_190_999,
} as const;
const expectedFreeSpinsClosureBytes = {
  desktop: 8_148_385,
  mobile: 7_801_244,
} as const;
const WHEEL_REFERENCE_URLS = Object.freeze([
  "/assets/primal-reference/10023.png",
  "/assets/primal-reference/10026.png",
  "/assets/primal-reference/10027.png",
]);
const FORBIDDEN_PUBLIC_MANIFEST_BRAND = /playngonetwork|play(?:\s|['’])*n\s*go|playngo|containerlauncher|\bg\s*['’]?\s*m(?:[\s_-]+)go\b/iu;

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
  expect(publicUrl).toMatch(/^\/assets\/(?:primal-runtime|primal-reference)\//);
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

interface Mp4TopLevelAtom {
  readonly offset: number;
  readonly size: number;
  readonly type: string;
}

function mp4TopLevelAtoms(path: string): readonly Mp4TopLevelAtom[] {
  const bytes = readFileSync(path);
  const atoms: Mp4TopLevelAtom[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) {
      throw new Error(`${path} has a truncated MP4 atom header`);
    }
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    let headerBytes = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) {
        throw new Error(`${path} has a truncated extended MP4 atom header`);
      }
      size = Number(bytes.readBigUInt64BE(offset + 8));
      headerBytes = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (!Number.isSafeInteger(size)
      || size < headerBytes
      || offset + size > bytes.byteLength) {
      throw new Error(`${path} has an invalid ${type} MP4 atom size`);
    }
    atoms.push(Object.freeze({ offset, size, type }));
    offset += size;
  }
  return Object.freeze(atoms);
}

describe("checked-in streaming package manifests", () => {
  it("publishes neutral fail-closed provenance without source locators or brand residue", () => {
    const runtimeSource = readFileSync(runtimeManifestPath, "utf8");
    const runtime = JSON.parse(runtimeSource);
    expect(runtimeSource).not.toMatch(FORBIDDEN_PUBLIC_MANIFEST_BRAND);
    expect(runtime.provenance).toEqual({
      package: "iron-colossus-runtime-2026.08",
      repositoryEvidence: "UNVERIFIED_IN_REPOSITORY",
      releaseDisposition: "EXTERNAL_APPROVAL_REQUIRED",
      sourceLocator: "not-published-and-not-resolvable",
    });
    expect(runtime.mobile).not.toHaveProperty("exclusions");
    expect(runtime.mobile).not.toHaveProperty("sourceInventory");
    expect(runtimeSource).not.toMatch(/"source"\s*:/u);

    expect(runtime.interface.files).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "runtime-badge" }),
    ]));
    expect(existsSync(filePath("/assets/primal-runtime/interface/runtime-badge.png")))
      .toBe(false);
    expect(existsSync(filePath("/assets/primal-runtime/interface/powered-by-playngo.png")))
      .toBe(false);

    for (const channel of channels) {
      const serialized = readFileSync(
        join(runtimeDirectory, `streaming-packages.${channel}.json`),
        "utf8",
      );
      expect(serialized).not.toMatch(FORBIDDEN_PUBLIC_MANIFEST_BRAND);
      const manifest = JSON.parse(serialized) as AssetPackageManifest;
      const resources = manifest.packages.flatMap((entry) => entry.resources);
      expect(resources).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `${channel}:shell:shared:runtime-badge` }),
      ]));
    }
  });

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
    "binds every %s sprite descriptor M4A size to runtime bytes and the real file",
    async (channel) => {
      const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
      await expect(verifyAudioSpriteDescriptorBindings({
        audio: channel === "desktop" ? runtime.audio : runtime.mobile.audio,
        channel,
        publicRoot: publicDirectory,
      })).resolves.toBeUndefined();
    },
  );

  it("rejects stale embedded M4A byte metadata even when outer runtime bytes are current", () => {
    const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
    const sprite = runtime.audio.sprites.find(
      (entry: { codec?: string }) => entry.codec === "audio/mp4",
    );
    const descriptor = JSON.parse(readFileSync(filePath(sprite.manifest), "utf8"));
    const staleDescriptor = {
      ...descriptor,
      files: {
        ...descriptor.files,
        m4a: { ...descriptor.files.m4a, size: sprite.bytes - 1 },
      },
    };

    expect(() => validateAudioSpriteDescriptorBinding({
      actualBytes: sprite.bytes,
      channel: "desktop",
      descriptor: staleDescriptor,
      descriptorUrl: sprite.manifest,
      sprite,
    })).toThrow(/files\.m4a\.size mismatch/u);
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
      expected.push(...WHEEL_REFERENCE_URLS);

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
    "keeps every %s MP4 audio sprite fast-started for WebKit decodeAudioData",
    (channel) => {
      const runtime = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
      const audio = channel === "desktop" ? runtime.audio : runtime.mobile.audio;
      const mp4Sprites = audio.sprites.filter(
        (entry: { codec?: string }) => entry.codec === "audio/mp4",
      );
      expect(mp4Sprites).toHaveLength(4);

      for (const sprite of mp4Sprites) {
        const path = filePath(sprite.publicUrl);
        const atoms = mp4TopLevelAtoms(path);
        const moov = atoms.find((entry) => entry.type === "moov");
        const mdat = atoms.find((entry) => entry.type === "mdat");
        expect(atoms[0]?.type, sprite.publicUrl).toBe("ftyp");
        expect(moov, sprite.publicUrl).toBeDefined();
        expect(mdat, sprite.publicUrl).toBeDefined();
        expect(moov!.offset, sprite.publicUrl).toBeLessThan(mdat!.offset);
        expect(moov!.offset + moov!.size, sprite.publicUrl).toBeLessThanOrEqual(64 * 1024);
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
        wheel.resources.filter((entry) => WHEEL_REFERENCE_URLS.includes(entry.url)),
      ).toHaveLength(3);
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

      const exclusiveBytes = (entry: typeof wheel): number => entry.resources.reduce(
        (total, resource) => total + resource.bytes,
        0,
      );
      expect(exclusiveBytes(wheel)).toBe(EXPECTED_WHEEL_EXCLUSIVE_BYTES);
      expect(exclusiveBytes(freeSpins)).toBe(EXPECTED_FREE_SPINS_EXCLUSIVE_BYTES);

      const closureBytes = (id: string): number => {
        const selected = new Set<string>();
        const visit = (packageId: string): void => {
          if (selected.has(packageId)) return;
          const entry = packages.get(packageId)!;
          for (const dependency of entry.dependsOn ?? []) visit(dependency);
          selected.add(packageId);
        };
        visit(id);
        return [...selected].reduce(
          (total, packageId) => total + exclusiveBytes(packages.get(packageId)!),
          0,
        );
      };
      expect(closureBytes(wheel.id)).toBe(expectedWheelClosureBytes[channel]);
      expect(closureBytes(freeSpins.id)).toBe(expectedFreeSpinsClosureBytes[channel]);
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
      const exclusiveBytes = byId.get(`${channel}-feature-big-win`)!.resources.reduce(
        (total, resource) => total + resource.bytes,
        0,
      );
      expect(exclusiveBytes).toBe(EXPECTED_BIG_WIN_EXCLUSIVE_BYTES);
      expect(bytes).toBe(expectedBigWinClosureBytes[channel]);
      expect(bytes).toBeLessThan(expectedFeatureClosureBytes[channel]);
    },
  );
});
