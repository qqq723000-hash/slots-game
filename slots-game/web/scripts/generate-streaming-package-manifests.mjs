#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyAudioSpriteDescriptorBindings } from "./audio-sprite-descriptor-contract.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const PUBLIC_ROOT = join(WEB_ROOT, "public");
const RUNTIME_ROOT = join(PUBLIC_ROOT, "assets/primal-runtime");
const RUNTIME_MANIFEST_PATH = join(RUNTIME_ROOT, "runtime-manifest.json");
const OUTPUTS = Object.freeze({
  desktop: join(RUNTIME_ROOT, "streaming-packages.desktop.json"),
  mobile: join(RUNTIME_ROOT, "streaming-packages.mobile.json"),
});
const FORBIDDEN_PUBLIC_MANIFEST_BRAND = /playngonetwork|play(?:\s|['’])*n\s*go|playngo|containerlauncher|\bg\s*['’]?\s*m(?:[\s_-]+)go\b/iu;
const EXPECTED_PROVENANCE = Object.freeze({
  package: "iron-colossus-runtime-2026.08",
  repositoryEvidence: "UNVERIFIED_IN_REPOSITORY",
  releaseDisposition: "EXTERNAL_APPROVAL_REQUIRED",
  sourceLocator: "not-published-and-not-resolvable",
});

/**
 * Wheel 的三张实际展示纹理来自已审查的本地参考资源，而不是旧 runtime-manifest。
 * 在构建事件清单时现场绑定大小与摘要，避免把它们留在未校验的首启 URL 路径。
 *
 * 英文 / English: The three actual display textures for Wheel are from censored local reference sources, not the old runtime-manifest. Bind sizes and digests in-place when building event manifests to avoid leaving them in unvalidated initial URL paths.
 */
const WHEEL_REFERENCE_FILES = Object.freeze([
  Object.freeze({ id: "wheel-blue", publicUrl: "/assets/primal-reference/10023.png" }),
  Object.freeze({ id: "wheel-red", publicUrl: "/assets/primal-reference/10026.png" }),
  Object.freeze({ id: "wheel-dual", publicUrl: "/assets/primal-reference/10027.png" }),
]);

const UI_SKELETON_PACKAGES = Object.freeze({
  base: Object.freeze([
    "grand_jackpot",
    "logo_game",
    "logo_intro",
    "major_jackpot",
    "mega_jackpot",
    "mini_jackpot",
    "minor_jackpot",
  ]),
  interaction: Object.freeze(["anticipation", "trail", "winbox", "winlabel"]),
  wheel: Object.freeze([
    "wheel",
    "wheel_hyperspin",
    "wheel_popup_start",
    "wheel_summary_freespins",
    "wheel_summary_jackpot",
  ]),
  freeSpins: Object.freeze([
    "freespin_counter",
    "freespin_retrigger",
    "fs_intro_1",
    "fs_intro_2",
    "fs_summary",
  ]),
  bigWin: Object.freeze(["BigWin"]),
});

const BIG_WIN_INTERFACE_IDS = new Set([
  "big-win-coin-atlas-data",
  "primal-rampage-bitmap-font",
  "primal-rampage-bitmap-font-page",
]);

const argv = new Set(process.argv.slice(2));
for (const option of argv) {
  if (option !== "--check") throw new Error(`Unknown option ${option}`);
}

const runtimeBytes = await readFile(RUNTIME_MANIFEST_PATH);
rejectPublicManifestBrandResidue(runtimeBytes.toString("utf8"), RUNTIME_MANIFEST_PATH);
const runtimeManifest = JSON.parse(runtimeBytes.toString("utf8"));
validateRuntimeManifestProvenance(runtimeManifest);
const wheelReferenceEntries = Object.freeze(await Promise.all(
  WHEEL_REFERENCE_FILES.map(async (entry) => {
    const bytes = await readFile(publicPath(entry.publicUrl));
    return Object.freeze({
      ...entry,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }),
));
const authorityDigest = createHash("sha256")
  .update(runtimeBytes)
  .update(JSON.stringify(wheelReferenceEntries))
  .digest("hex");
const version = `${requiredString(runtimeManifest?.provenance?.package, "provenance.package")}+${authorityDigest.slice(0, 16)}`;

const manifests = Object.freeze({
  desktop: buildChannelManifest("desktop", runtimeManifest, version),
  mobile: buildChannelManifest("mobile", runtimeManifest, version),
});

for (const channel of ["desktop", "mobile"]) {
  const manifest = manifests[channel];
  validateGeneratedManifest(manifest, channel, runtimeManifest);
  await verifyLocalResources(manifest);
  await verifyAudioSpriteDescriptorBindings({
    audio: channel === "desktop" ? runtimeManifest.audio : runtimeManifest.mobile.audio,
    channel,
    publicRoot: PUBLIC_ROOT,
  });
  await verifyAtlasBindings(manifest, channel, runtimeManifest);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  rejectPublicManifestBrandResidue(serialized, OUTPUTS[channel]);
  if (argv.has("--check")) {
    const checkedIn = await readFile(OUTPUTS[channel], "utf8").catch(() => null);
    if (checkedIn !== serialized) {
      throw new Error(
        `${OUTPUTS[channel]} is stale; run npm run assets:generate-streaming-packages`,
      );
    }
  } else {
    await writeFile(OUTPUTS[channel], serialized, "utf8");
  }
}

console.log(
  `${argv.has("--check") ? "Verified" : "Generated"} deterministic streaming package manifests: `
    + `${manifests.desktop.packages.length} desktop packages, `
    + `${manifests.mobile.packages.length} mobile packages.`,
);

function buildChannelManifest(channel, authority, packageVersion) {
  const desktopSpineGroups = mapById(requiredArray(authority?.spine?.groups, "spine.groups"));
  const channelSpineGroups = channel === "desktop"
    ? desktopSpineGroups
    : mapById(requiredArray(authority?.mobile?.spine?.groups, "mobile.spine.groups"));
  const packages = [];
  const sharedInterface = requiredArray(authority?.interface?.files, "interface.files");
  const shellInterface = sharedInterface.filter((entry) => !BIG_WIN_INTERFACE_IDS.has(entry.id));
  const bigWinInterface = sharedInterface.filter((entry) => BIG_WIN_INTERFACE_IDS.has(entry.id));
  assertExactIds(
    bigWinInterface,
    BIG_WIN_INTERFACE_IDS,
    "shared Big Win interface resources",
  );

  const channelShell = channel === "mobile"
    ? [
        ...requiredArray(authority?.mobile?.configuration?.files, "mobile.configuration.files"),
        ...requiredArray(authority?.mobile?.interface?.files, "mobile.interface.files"),
      ]
    : [];

  packages.push(assetPackage(
    `${channel}-startup-shell`,
    "startup-shell",
    [
      ...shellInterface.map((entry) => resource(
        entry,
        `${channel}:shell:shared:${slug(entry.id)}`,
      )),
      ...channelShell.map((entry) => resource(
        entry,
        `${channel}:shell:channel:${slug(entry.id)}`,
      )),
    ],
    packageVersion,
  ));

  for (const groupId of ["spine_fps", "spine_background", "spine_symbols", "spine_ui"]) {
    const textureGroup = requiredEntry(channelSpineGroups, groupId, `${channel} Spine group`);
    const skeletonGroup = requiredEntry(desktopSpineGroups, groupId, "shared skeleton group");
    const groupSlug = slug(groupId.replace(/^spine_/, ""));
    const sharedPackageId = `${channel}-spine-${groupSlug}-shared`;
    const stage = groupId === "spine_fps" ? "startup-shell" : "base-critical";
    packages.push(assetPackage(
      sharedPackageId,
      stage,
      [
        resource(textureGroup.atlas, `${channel}:${groupSlug}:atlas`),
        ...requiredArray(textureGroup.pages, `${channel}.${groupId}.pages`).map((entry) => resource(
          entry,
          `${channel}:${groupSlug}:page:${slug(entry.name)}`,
        )),
      ],
      packageVersion,
    ));

    if (groupId !== "spine_ui") {
      packages.push(assetPackage(
        `${channel}-spine-${groupSlug}-base`,
        stage,
        requiredArray(skeletonGroup.skeletons, `${groupId}.skeletons`).map((entry) => resource(
          entry,
          `${channel}:${groupSlug}:skeleton:${slug(entry.name)}`,
        )),
        packageVersion,
        [sharedPackageId],
      ));
      continue;
    }

    const skeletons = mapByName(requiredArray(skeletonGroup.skeletons, "spine_ui.skeletons"));
    assertUiSkeletonClassification(skeletons);
    packages.push(assetPackage(
      `${channel}-spine-ui-base`,
      "base-critical",
      selectSkeletons(skeletons, UI_SKELETON_PACKAGES.base, channel),
      packageVersion,
      [sharedPackageId],
    ));
    packages.push(assetPackage(
      `${channel}-interaction-visuals`,
      "interaction-ready",
      selectSkeletons(skeletons, UI_SKELETON_PACKAGES.interaction, channel),
      packageVersion,
      [sharedPackageId],
    ));
    packages.push(assetPackage(
      `${channel}-feature-wheel`,
      "feature-on-demand",
      [
        ...selectSkeletons(skeletons, UI_SKELETON_PACKAGES.wheel, channel),
        ...wheelReferenceEntries.map((entry) => resource(
          entry,
          `${channel}:wheel:reference:${slug(entry.id)}`,
        )),
      ],
      packageVersion,
      [sharedPackageId, `${channel}-interaction-audio`],
    ));
    packages.push(assetPackage(
      `${channel}-feature-free-spins`,
      "feature-on-demand",
      selectSkeletons(skeletons, UI_SKELETON_PACKAGES.freeSpins, channel),
      packageVersion,
      [sharedPackageId, `${channel}-interaction-audio`],
    ));
    packages.push(assetPackage(
      `${channel}-feature-big-win`,
      "feature-on-demand",
      [
        ...selectSkeletons(skeletons, UI_SKELETON_PACKAGES.bigWin, channel),
        ...bigWinInterface.map((entry) => resource(
          entry,
          `${channel}:big-win:interface:${slug(entry.id)}`,
        )),
      ],
      packageVersion,
      // Big Win 音频已由严格的交互就绪音频预加载负责。未来的按需视觉资源不得再次保留并解码完整音频图。 / English: Big Win audio has been taken care of by strict interaction-ready audio preloading. Future on-demand visual resources may not retain and decode the full audio map again.
      [sharedPackageId],
    ));
  }

  const audio = channel === "desktop" ? authority.audio : authority?.mobile?.audio;
  packages.push(assetPackage(
    `${channel}-interaction-audio`,
    "interaction-ready",
    [
      ...requiredArray(audio?.aggregateManifests, `${channel}.audio.aggregateManifests`),
      ...requiredArray(audio?.spriteManifests, `${channel}.audio.spriteManifests`),
      ...requiredArray(audio?.sprites, `${channel}.audio.sprites`),
    ].map((entry) => resource(entry, `${channel}:audio:${slug(entry.id)}`)),
    packageVersion,
  ));

  return {
    schemaVersion: 1,
    assetSet: `${requiredString(authority.assetSet, "assetSet")}:${channel}`,
    packages,
  };
}

function validateRuntimeManifestProvenance(manifest) {
  const provenance = manifest?.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("runtime provenance must be an object");
  }
  const actualKeys = Object.keys(provenance).sort();
  const expectedKeys = Object.keys(EXPECTED_PROVENANCE).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some((key) => provenance[key] !== EXPECTED_PROVENANCE[key])) {
    throw new Error("runtime provenance must remain neutral, non-resolvable, and fail-closed");
  }
  if (manifest?.mobile?.exclusions !== undefined) {
    throw new Error("non-runtime mobile source exclusions must not be published");
  }
  if (manifest?.mobile?.sourceInventory !== undefined) {
    throw new Error("non-runtime mobile source inventory must not be published");
  }
  rejectSourceMetadata(manifest, "runtime-manifest");
}

function rejectSourceMetadata(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSourceMetadata(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Object.hasOwn(value, "source")) {
    throw new Error(`${path}.source is non-runtime provenance metadata`);
  }
  for (const [key, entry] of Object.entries(value)) {
    rejectSourceMetadata(entry, `${path}.${key}`);
  }
}

function rejectPublicManifestBrandResidue(serialized, path) {
  if (FORBIDDEN_PUBLIC_MANIFEST_BRAND.test(serialized)) {
    throw new Error(`${path} contains forbidden public brand residue`);
  }
}

function assetPackage(id, stage, resources, packageVersion, dependsOn = []) {
  if (resources.length === 0) throw new Error(`Package ${id} cannot be empty`);
  return {
    id,
    version: packageVersion,
    stage,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    resources,
  };
}

function resource(entry, id) {
  const url = requiredString(entry?.publicUrl, `${id}.publicUrl`);
  const bytes = entry?.bytes;
  const sha256 = requiredString(entry?.sha256, `${id}.sha256`).toLowerCase();
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`${id}.bytes must be positive`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${id}.sha256 is invalid`);
  return { id, url, bytes, sha256, decoder: decoderFor(url) };
}

function decoderFor(url) {
  if (url.endsWith(".json")) return "json";
  if (url.endsWith(".atlas") || url.endsWith(".fnt")) return "text";
  return "binary";
}

function selectSkeletons(byName, names, channel) {
  return names.map((name) => resource(
    requiredEntry(byName, name, "Spine UI skeleton"),
    `${channel}:ui:skeleton:${slug(name)}`,
  ));
}

function assertUiSkeletonClassification(skeletons) {
  const classified = Object.values(UI_SKELETON_PACKAGES).flat();
  if (new Set(classified).size !== classified.length) {
    throw new Error("Spine UI skeleton classification contains duplicates");
  }
  const actual = [...skeletons.keys()].sort();
  const expected = [...classified].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Spine UI skeleton classification is incomplete: expected ${actual.join(", ")}; `
        + `classified ${expected.join(", ")}`,
    );
  }
}

function validateGeneratedManifest(manifest, channel, authority) {
  const packages = requiredArray(manifest.packages, `${channel}.packages`);
  const packageIds = new Set();
  const resourceIds = new Set();
  const urls = new Set();
  for (const entry of packages) {
    if (packageIds.has(entry.id)) throw new Error(`Duplicate package ${entry.id}`);
    packageIds.add(entry.id);
    for (const item of entry.resources) {
      if (resourceIds.has(item.id)) throw new Error(`Duplicate resource id ${item.id}`);
      if (urls.has(item.url)) throw new Error(`Duplicate resource URL ${item.url}`);
      resourceIds.add(item.id);
      urls.add(item.url);
    }
  }
  for (const entry of packages) {
    for (const dependency of entry.dependsOn ?? []) {
      if (!packageIds.has(dependency)) throw new Error(`${entry.id} has unknown dependency ${dependency}`);
    }
  }
  topologicalOrder(packages);

  const expected = expectedAuthorityUrls(channel, authority);
  const actual = [...urls].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const missing = expected.filter((url) => !urls.has(url));
    const extra = actual.filter((url) => !expected.includes(url));
    throw new Error(
      `${channel} resource coverage mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`,
    );
  }
}

function expectedAuthorityUrls(channel, authority) {
  const urls = [];
  const desktopGroups = requiredArray(authority?.spine?.groups, "spine.groups");
  const textureGroups = channel === "desktop"
    ? desktopGroups
    : requiredArray(authority?.mobile?.spine?.groups, "mobile.spine.groups");
  for (const group of textureGroups) {
    urls.push(group.atlas.publicUrl, ...group.pages.map((entry) => entry.publicUrl));
  }
  for (const group of desktopGroups) {
    urls.push(...group.skeletons.map((entry) => entry.publicUrl));
  }
  const audio = channel === "desktop" ? authority.audio : authority.mobile.audio;
  urls.push(
    ...audio.aggregateManifests.map((entry) => entry.publicUrl),
    ...audio.spriteManifests.map((entry) => entry.publicUrl),
    ...audio.sprites.map((entry) => entry.publicUrl),
    ...authority.interface.files.map((entry) => entry.publicUrl),
  );
  if (channel === "mobile") {
    urls.push(
      ...authority.mobile.configuration.files.map((entry) => entry.publicUrl),
      ...authority.mobile.interface.files.map((entry) => entry.publicUrl),
    );
  }
  urls.push(...wheelReferenceEntries.map((entry) => entry.publicUrl));
  const unique = [...new Set(urls)].sort();
  if (unique.length !== urls.length) throw new Error(`${channel} authority contains duplicate URLs`);
  return unique;
}

async function verifyLocalResources(manifest) {
  for (const entry of manifest.packages) {
    for (const item of entry.resources) {
      const path = publicPath(item.url);
      const metadata = await stat(path).catch(() => null);
      if (!metadata?.isFile()) throw new Error(`${item.url} does not resolve to a public file`);
      if (metadata.size !== item.bytes) {
        throw new Error(`${item.url} bytes mismatch: manifest=${item.bytes}, file=${metadata.size}`);
      }
      const digest = createHash("sha256").update(await readFile(path)).digest("hex");
      if (digest !== item.sha256) {
        throw new Error(`${item.url} SHA-256 mismatch: manifest=${item.sha256}, file=${digest}`);
      }
    }
  }
}

async function verifyAtlasBindings(manifest, channel, authority) {
  const groups = channel === "desktop" ? authority.spine.groups : authority.mobile.spine.groups;
  const packages = new Map(manifest.packages.map((entry) => [entry.id, entry]));
  for (const group of groups) {
    const groupSlug = slug(group.id.replace(/^spine_/, ""));
    const sharedId = `${channel}-spine-${groupSlug}-shared`;
    const shared = requiredEntry(packages, sharedId, "generated atlas package");
    const expectedUrls = [group.atlas.publicUrl, ...group.pages.map((entry) => entry.publicUrl)].sort();
    const actualUrls = shared.resources.map((entry) => entry.url).sort();
    if (JSON.stringify(actualUrls) !== JSON.stringify(expectedUrls)) {
      throw new Error(`${sharedId} must contain exactly its atlas and atlas pages`);
    }
    const atlas = await readFile(publicPath(group.atlas.publicUrl), "utf8");
    const imageLines = atlas.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\.(?:avif|png|jpe?g|webp)$/i.test(line))
      .sort();
    const expectedPages = group.pages.map((entry) => basename(entry.publicUrl)).sort();
    if (JSON.stringify(imageLines) !== JSON.stringify(expectedPages)) {
      throw new Error(
        `${group.atlas.publicUrl} page bindings differ: atlas=${imageLines.join(",")}; `
          + `manifest=${expectedPages.join(",")}`,
      );
    }
  }

  for (const entry of manifest.packages) {
    for (const item of entry.resources.filter((candidate) => candidate.url.endsWith(".skel"))) {
      const group = item.url.split("/").at(-2);
      const sharedId = `${channel}-spine-${slug(group.replace(/^spine_/, ""))}-shared`;
      if (!(entry.dependsOn ?? []).includes(sharedId)) {
        throw new Error(`${entry.id} skeleton ${item.url} must depend on ${sharedId}`);
      }
    }
  }
}

function publicPath(publicUrl) {
  if (!publicUrl.startsWith("/") || publicUrl.startsWith("//")) {
    throw new Error(`Unsafe public URL ${publicUrl}`);
  }
  const path = resolve(PUBLIC_ROOT, `.${publicUrl}`);
  if (!path.startsWith(`${PUBLIC_ROOT}/`)) throw new Error(`Public URL escapes root: ${publicUrl}`);
  return path;
}

function topologicalOrder(packages) {
  const byId = new Map(packages.map((entry) => [entry.id, entry]));
  const visited = new Set();
  const visiting = new Set();
  const result = [];
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Package dependency cycle at ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const entry of packages) visit(entry.id);
  return result;
}

function mapById(entries) {
  return new Map(entries.map((entry) => [requiredString(entry.id, "entry.id"), entry]));
}

function mapByName(entries) {
  return new Map(entries.map((entry) => [requiredString(entry.name, "entry.name"), entry]));
}

function requiredEntry(map, key, label) {
  const value = map.get(key);
  if (!value) throw new Error(`${label} ${key} is missing`);
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a string`);
  return value;
}

function assertExactIds(entries, expected, label) {
  const actual = new Set(entries.map((entry) => entry.id));
  if (actual.size !== expected.size || [...expected].some((id) => !actual.has(id))) {
    throw new Error(`${label} are incomplete`);
  }
}

function slug(value) {
  const normalized = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error(`Cannot derive resource id from ${value}`);
  return normalized;
}
