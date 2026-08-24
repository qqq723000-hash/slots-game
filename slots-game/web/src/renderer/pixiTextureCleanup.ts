import { BaseTexture, Texture, utils } from "pixi.js";

const verifiedTextureOwners = new WeakSet<Texture>();
const verifiedBaseOwnerCounts = new WeakMap<BaseTexture, number>();

/**
 * `Texture.fromURL` 会在返回 Promise 前同步登记 Texture/BaseTexture。调用者必须保存
 * 这一个对象，后续失败清理不得再按 URL 猜测，否则旧代晚到可能驱逐同 URL 的新代。
 */
export function cachedPixiTextureAttempt(cacheKey: string): Texture | null {
  return utils.TextureCache[cacheKey] ?? null;
}

/**
 * 从已经过清单大小/SHA-256 校验的编码图像字节建立 Pixi 纹理。正常路径只在
 * `Texture.fromURL` 完成浏览器解码后撤销 blob URL；取消路径按本 attempt 对象身份
 * 清理，晚到结果也不会驱逐下一代纹理。
 */
export function loadPixiTextureFromVerifiedBytes(
  bytes: Uint8Array,
  mimeType: string,
  signal?: AbortSignal,
): Promise<Texture> {
  if (signal?.aborted) return Promise.reject(textureAbortReason(signal));
  const objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }));
  let load: Promise<Texture>;
  let attemptedTexture: Texture | null = null;
  try {
    load = Texture.fromURL(objectUrl);
    attemptedTexture = cachedPixiTextureAttempt(objectUrl);
  } catch (error) {
    attemptedTexture = cachedPixiTextureAttempt(objectUrl);
    disposePixiTextureAttempt(attemptedTexture);
    URL.revokeObjectURL(objectUrl);
    return Promise.reject(error);
  }

  return new Promise<Texture>((resolve, reject) => {
    let settled = false;
    let revoked = false;
    const revoke = (): void => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(objectUrl);
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const disposeAttempt = (resolvedTexture?: Texture): void => {
      disposePixiTextureAttempt(attemptedTexture);
      if (resolvedTexture && resolvedTexture !== attemptedTexture) {
        disposePixiTextureAttempt(resolvedTexture);
      }
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // 先按对象身份断开 cache 并撤销 URL 以取消解码；对象/BaseTexture 的最终销毁
      // 延至底层 Promise 落定，避免旧代晚到误毁此间已采用的同 BaseTexture 新代。
      revoke();
      if (attemptedTexture) detachPixiTextureAttemptFromCache(attemptedTexture);
      reject(textureAbortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void load.then(
      (texture) => {
        if (settled) {
          disposeAttempt(texture);
          revoke();
          return;
        }
        settled = true;
        cleanup();
        // Texture.fromURL 的完成边界意味着源图像已加载/解码；从唯一 blob cache
        // 断开后再撤销 URL，BaseTexture 及后续 GPU 上传继续由返回对象拥有。
        detachPixiTextureAttemptFromCache(texture);
        adoptVerifiedPixiTexture(texture);
        revoke();
        resolve(texture);
      },
      (error: unknown) => {
        if (settled) {
          disposeAttempt();
          revoke();
          return;
        }
        settled = true;
        cleanup();
        disposeAttempt();
        revoke();
        reject(error);
      },
    );
    if (signal?.aborted) onAbort();
  });
}

/** 仅按对象身份断开临时 cache key；纹理/BaseTexture 的所有权转交给调用者。 */
export function detachPixiTextureAttemptFromCache(texture: Texture): void {
  try {
    Texture.removeFromCache(texture);
  } catch {
    // 对象仍可由调用者持有；继续断开 BaseTexture 的临时 key。
  }
  const baseTexture = texture.baseTexture;
  for (const cacheKey of Object.keys(utils.BaseTextureCache)) {
    if (utils.BaseTextureCache[cacheKey] !== baseTexture) continue;
    try {
      BaseTexture.removeFromCache(cacheKey);
    } catch {
      // 临时唯一 blob key 清理是 best-effort，不改变纹理所有权。
    }
  }
}

/**
 * 只处置一个已捕获的 Pixi texture attempt。Pixi 6 的 Texture 对象移除会检查身份，
 * 但 BaseTexture 对象移除和 destroy(true) 不会；这里显式保留仍被新代使用的 base，
 * 并在销毁旧 base 前清除其陈旧 cache id，避免误删后来写入相同 key 的对象。
 */
export function disposePixiTextureAttempt(
  texture: Texture | null,
  protectedTextures: readonly (Texture | null | undefined)[] = [],
): void {
  if (!texture || protectedTextures.includes(texture)) return;
  const baseTexture = texture.baseTexture;
  releaseVerifiedPixiTexture(texture);

  // Texture.removeFromCache(object) 在 Pixi 6.5.2 中逐 key 检查 cache 当前值的身份。
  try {
    Texture.removeFromCache(texture);
  } catch {
    // 继续尝试释放对象本身和不再被引用的 base。
  }
  try {
    texture.destroy(false);
  } catch {
    // 清理异常不得让 TextureAtlas 的 complete 回调永久悬挂。
  }

  if (!baseTexture
    || (verifiedBaseOwnerCounts.get(baseTexture) ?? 0) > 0
    || protectedTextures.some((candidate) => candidate?.baseTexture === baseTexture)
    || Object.values(utils.TextureCache).some((candidate) => (
      candidate.baseTexture === baseTexture
    ))) return;

  // BaseTexture.removeFromCache(object) 不检查身份，因此只按仍指向旧对象的 key 删除。
  for (const cacheKey of Object.keys(utils.BaseTextureCache)) {
    if (utils.BaseTextureCache[cacheKey] === baseTexture) {
      try {
        BaseTexture.removeFromCache(cacheKey);
      } catch {
        // 继续断开旧对象携带的其余 cache id。
      }
    }
  }
  // destroy() 会无条件使用 cacheId/textureCacheIds 删除条目；先断开旧代 key 能力。
  baseTexture.cacheId = "";
  baseTexture.textureCacheIds = [];
  try {
    baseTexture.destroy();
  } catch {
    // GPU/资源释放是 best-effort，绝不传播进 atlas/font 生命周期。
  }
}

function adoptVerifiedPixiTexture(texture: Texture): void {
  if (verifiedTextureOwners.has(texture)) return;
  verifiedTextureOwners.add(texture);
  const baseTexture = texture.baseTexture;
  verifiedBaseOwnerCounts.set(
    baseTexture,
    (verifiedBaseOwnerCounts.get(baseTexture) ?? 0) + 1,
  );
}

function releaseVerifiedPixiTexture(texture: Texture): void {
  if (!verifiedTextureOwners.has(texture)) return;
  verifiedTextureOwners.delete(texture);
  const baseTexture = texture.baseTexture;
  const remaining = Math.max(0, (verifiedBaseOwnerCounts.get(baseTexture) ?? 0) - 1);
  if (remaining === 0) verifiedBaseOwnerCounts.delete(baseTexture);
  else verifiedBaseOwnerCounts.set(baseTexture, remaining);
}

function textureAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Verified Pixi texture load was aborted");
  error.name = "AbortError";
  return error;
}
