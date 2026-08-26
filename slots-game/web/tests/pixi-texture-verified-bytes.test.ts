import { BaseTexture, Texture, utils } from "pixi.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  disposePixiTextureAttempt,
  loadPixiTextureFromVerifiedBytes,
} from "../src/renderer/pixiTextureCleanup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cacheTexture(url: string, base = new BaseTexture()): Texture {
  const texture = new Texture(base);
  BaseTexture.addToCache(base, url);
  Texture.addToCache(texture, url);
  return texture;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("verified Pixi texture bytes", () => {
  it("keeps the blob URL alive through Pixi decode then transfers exact texture ownership", async () => {
    const decoded = deferred<Texture>();
    const objectUrl = "blob:verified-big-win-1";
    const revoke = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockReturnValue(objectUrl);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
    let attempted!: Texture;
    vi.spyOn(Texture, "fromURL").mockImplementation((url) => {
      attempted = cacheTexture(String(url));
      return decoded.promise;
    });

    const loading = loadPixiTextureFromVerifiedBytes(
      Uint8Array.of(137, 80, 78, 71),
      "image/png",
    );
    expect(revoke).not.toHaveBeenCalled();
    expect(utils.TextureCache[objectUrl]).toBe(attempted);
    const destroyTexture = vi.spyOn(attempted, "destroy");
    const destroyBase = vi.spyOn(attempted.baseTexture, "destroy");

    decoded.resolve(attempted);
    await expect(loading).resolves.toBe(attempted);
    expect(revoke).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(objectUrl);
    expect(utils.TextureCache[objectUrl]).toBeUndefined();
    expect(utils.BaseTextureCache[objectUrl]).toBeUndefined();
    expect(destroyTexture).not.toHaveBeenCalled();
    expect(destroyBase).not.toHaveBeenCalled();

    disposePixiTextureAttempt(attempted);
    expect(destroyTexture).toHaveBeenCalledOnce();
  });

  it("cleans an aborted generation by identity and never reuses it for retry", async () => {
    const first = deferred<Texture>();
    const second = deferred<Texture>();
    const urls = ["blob:verified-big-win-old", "blob:verified-big-win-new"];
    const revoke = vi.fn();
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce(urls[0]!)
      .mockReturnValueOnce(urls[1]!);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
    const attempts: Texture[] = [];
    vi.spyOn(Texture, "fromURL").mockImplementation((url) => {
      const texture = cacheTexture(String(url));
      attempts.push(texture);
      return attempts.length === 1 ? first.promise : second.promise;
    });

    const controller = new AbortController();
    const oldLoading = loadPixiTextureFromVerifiedBytes(
      Uint8Array.of(1),
      "image/png",
      controller.signal,
    );
    const destroyOld = vi.spyOn(attempts[0]!, "destroy");
    const sharedBase = attempts[0]!.baseTexture;
    const destroySharedBase = vi.spyOn(sharedBase, "destroy");
    const reason = new Error("event ended");
    controller.abort(reason);
    await expect(oldLoading).rejects.toBe(reason);
    expect(destroyOld).not.toHaveBeenCalled();
    expect(destroySharedBase).not.toHaveBeenCalled();
    expect(utils.TextureCache[urls[0]!]).toBeUndefined();

    vi.mocked(Texture.fromURL).mockImplementationOnce((url) => {
      const texture = cacheTexture(String(url), sharedBase);
      attempts.push(texture);
      return second.promise;
    });
    const newLoading = loadPixiTextureFromVerifiedBytes(Uint8Array.of(2), "image/png");
    expect(attempts[1]).not.toBe(attempts[0]);
    const destroyNew = vi.spyOn(attempts[1]!, "destroy");
    second.resolve(attempts[1]!);
    await expect(newLoading).resolves.toBe(attempts[1]);
    first.resolve(attempts[0]!);
    await Promise.resolve();

    expect(destroyOld).toHaveBeenCalledOnce();
    expect(destroyNew).not.toHaveBeenCalled();
    expect(destroySharedBase).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(urls[0]);
    expect(revoke).toHaveBeenCalledWith(urls[1]);
    disposePixiTextureAttempt(attempts[1] ?? null);
    expect(destroyNew).toHaveBeenCalledOnce();
    expect(destroySharedBase).toHaveBeenCalledOnce();
  });
});
