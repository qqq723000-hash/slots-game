import { readFile, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

/**
 * 将已发布 sprite JSON 内嵌的 M4A 元数据绑定到运行时权威条目与真实文件。
 * 这条合同独立于流式包的外层哈希，避免容器重封装后留下看似完整但大小过期的描述。
 *
 * 英文 / English: Bind M4A metadata embedded in published sprite JSON to runtime authoritative entries and real files. This contract is independent of the outer hash of the streaming package, preventing the container from being repackaged and leaving a description that appears to be complete but has an expired size.
 */
export async function verifyAudioSpriteDescriptorBindings({
  audio,
  channel,
  publicRoot,
}) {
  const spriteManifests = requiredArray(
    audio?.spriteManifests,
    `${channel}.audio.spriteManifests`,
  );
  const m4aSprites = requiredArray(audio?.sprites, `${channel}.audio.sprites`)
    .filter((entry) => entry?.codec === "audio/mp4");
  const spritesByManifest = new Map();
  for (const sprite of m4aSprites) {
    const manifestUrl = requiredString(
      sprite?.manifest,
      `${channel}.audio sprite manifest`,
    );
    if (spritesByManifest.has(manifestUrl)) {
      throw new Error(`${channel} has duplicate M4A sprite binding for ${manifestUrl}`);
    }
    spritesByManifest.set(manifestUrl, sprite);
  }
  if (spritesByManifest.size !== spriteManifests.length) {
    throw new Error(
      `${channel} M4A sprite descriptor coverage differs: `
        + `descriptors=${spriteManifests.length}, sprites=${spritesByManifest.size}`,
    );
  }

  for (const manifestEntry of spriteManifests) {
    const descriptorUrl = requiredString(
      manifestEntry?.publicUrl,
      `${channel}.audio sprite descriptor URL`,
    );
    const sprite = spritesByManifest.get(descriptorUrl);
    if (!sprite) {
      throw new Error(`${channel} sprite descriptor ${descriptorUrl} has no M4A sprite`);
    }
    let descriptor;
    try {
      descriptor = JSON.parse(await readFile(publicPath(publicRoot, descriptorUrl), "utf8"));
    } catch (cause) {
      throw new Error(`${descriptorUrl} is not a readable JSON sprite descriptor`, { cause });
    }
    const spriteMetadata = await stat(
      publicPath(publicRoot, requiredString(sprite.publicUrl, `${descriptorUrl} sprite URL`)),
    ).catch(() => null);
    if (!spriteMetadata?.isFile()) {
      throw new Error(`${sprite.publicUrl} does not resolve to an M4A sprite file`);
    }
    validateAudioSpriteDescriptorBinding({
      actualBytes: spriteMetadata.size,
      channel,
      descriptor,
      descriptorUrl,
      sprite,
    });
  }
}

export function validateAudioSpriteDescriptorBinding({
  actualBytes,
  channel,
  descriptor,
  descriptorUrl,
  sprite,
}) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`${descriptorUrl} must contain a JSON object`);
  }
  const expectedId = requiredString(sprite?.id, `${descriptorUrl} sprite id`);
  if (descriptor.soundBufferId !== expectedId) {
    throw new Error(
      `${descriptorUrl} soundBufferId mismatch: `
        + `descriptor=${String(descriptor.soundBufferId)}, sprite=${expectedId}`,
    );
  }
  const embedded = descriptor?.files?.m4a;
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) {
    throw new Error(`${descriptorUrl} must declare files.m4a`);
  }
  const spriteUrl = requiredString(sprite?.publicUrl, `${descriptorUrl} sprite URL`);
  const embeddedUrl = requiredString(embedded.url, `${descriptorUrl} files.m4a.url`);
  if (embeddedUrl !== basename(spriteUrl)) {
    throw new Error(
      `${descriptorUrl} files.m4a.url mismatch: descriptor=${embeddedUrl}, sprite=${spriteUrl}`,
    );
  }
  const manifestBytes = sprite?.bytes;
  const embeddedBytes = embedded.size;
  if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0
    || !Number.isSafeInteger(manifestBytes) || manifestBytes <= 0
    || !Number.isSafeInteger(embeddedBytes) || embeddedBytes <= 0
    || embeddedBytes !== manifestBytes
    || embeddedBytes !== actualBytes) {
    throw new Error(
      `${channel} ${descriptorUrl} files.m4a.size mismatch: `
        + `descriptor=${String(embeddedBytes)}, runtime=${String(manifestBytes)}, `
        + `file=${String(actualBytes)}`,
    );
  }
}

function publicPath(publicRoot, publicUrl) {
  const root = resolve(publicRoot);
  if (!publicUrl.startsWith("/") || publicUrl.startsWith("//")) {
    throw new Error(`Unsafe public URL ${publicUrl}`);
  }
  const path = resolve(root, `.${publicUrl}`);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error(`Public URL escapes root: ${publicUrl}`);
  }
  return path;
}

function requiredArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}
