import { describe, expect, it, vi } from "vitest";
import {
  CriticalDomResourceError,
  DEFAULT_CRITICAL_FONT_DESCRIPTORS,
  waitForCriticalDomReadiness,
  type CriticalDomReadinessProgress,
  type CriticalDomRoot,
  type CriticalFontFaceSet,
} from "../src/startup/criticalDomReadiness";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((pass, fail) => {
    resolve = pass;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class FakeImage extends EventTarget {
  currentSrc = "";
  complete = false;
  naturalWidth = 0;
  decode?: () => Promise<void>;

  constructor(readonly src: string) {
    super();
  }

  getAttribute(name: string): string | null {
    return name === "src" ? this.src : null;
  }
}

function rootWith(images: readonly FakeImage[]): CriticalDomRoot {
  return {
    querySelectorAll: (() => images) as unknown as CriticalDomRoot["querySelectorAll"],
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("waitForCriticalDomReadiness", () => {
  it("waits for every image decode, requested font and FontFaceSet.ready", async () => {
    const firstDecode = deferred<void>();
    const secondDecode = deferred<void>();
    const ready = deferred<unknown>();
    const first = new FakeImage("/first.png");
    const second = new FakeImage("/second.svg");
    first.decode = vi.fn(() => firstDecode.promise);
    second.decode = vi.fn(() => secondDecode.promise);
    const fontLoads = new Map<string, Deferred<readonly unknown[]>>();
    const load = vi.fn((descriptor: string) => {
      const gate = deferred<readonly unknown[]>();
      fontLoads.set(descriptor, gate);
      return gate.promise;
    });
    const progress: CriticalDomReadinessProgress[] = [];
    const run = waitForCriticalDomReadiness(rootWith([first, second]), {
      fontSet: { load, ready: ready.promise },
      onProgress: (event) => progress.push(event),
    });
    let settled = false;
    void run.then(() => { settled = true; });

    firstDecode.resolve();
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(load).not.toHaveBeenCalled();

    secondDecode.resolve();
    await flushMicrotasks();
    expect(load.mock.calls.map(([descriptor]) => descriptor))
      .toEqual(DEFAULT_CRITICAL_FONT_DESCRIPTORS);
    expect(settled).toBe(false);

    for (const gate of fontLoads.values()) gate.resolve([{}]);
    await flushMicrotasks();
    expect(settled).toBe(false);

    ready.resolve({});
    await run;
    expect(settled).toBe(true);
    expect(progress.at(-1)).toEqual({
      stage: "complete",
      stageCompleted: 1,
      stageTotal: 1,
      stageProgress: 1,
      progress: 1,
    });
    expect(progress.map(({ progress: value }) => value)).toEqual(
      [...progress.map(({ progress: value }) => value)].sort((left, right) => left - right),
    );
    expect(progress.some(({ stage, progress: value }) => stage === "images" && value === 0.4))
      .toBe(true);
    expect(progress.some(({ stage, progress: value }) => stage === "images" && value === 0.8))
      .toBe(true);
    expect(progress.every(Object.isFrozen)).toBe(true);
  });

  it("rejects a required image whose decoder fails without reporting completion", async () => {
    const image = new FakeImage("/broken.png");
    image.decode = vi.fn(async () => { throw new Error("corrupt image"); });
    const progress: CriticalDomReadinessProgress[] = [];

    await expect(waitForCriticalDomReadiness(rootWith([image]), {
      fontSet: null,
      onProgress: (event) => progress.push(event),
    })).rejects.toMatchObject({
      name: "CriticalDomResourceError",
      kind: "image",
      resource: "/broken.png",
    });
    expect(progress.some(({ stage }) => stage === "complete")).toBe(false);
  });

  it("uses load/error events when jsdom or a legacy browser has no image.decode", async () => {
    const image = new FakeImage("/event-loaded.png");
    const progress: CriticalDomReadinessProgress[] = [];
    const run = waitForCriticalDomReadiness(rootWith([image]), {
      fontSet: null,
      onProgress: (event) => progress.push(event),
    });

    await flushMicrotasks();
    image.complete = true;
    image.naturalWidth = 128;
    image.dispatchEvent(new Event("load"));
    await run;

    expect(progress.map(({ stage }) => stage)).toContain("images");
    expect(progress.at(-1)?.stage).toBe("complete");
  });

  it("accepts an already-complete cached image without decode", async () => {
    const image = new FakeImage("/cached.png");
    image.complete = true;
    image.naturalWidth = 256;

    await expect(waitForCriticalDomReadiness(rootWith([image]), { fontSet: null }))
      .resolves.toBeUndefined();
  });

  it("rejects an image error event and an empty required font result", async () => {
    const image = new FakeImage("/network-failure.png");
    const imageRun = waitForCriticalDomReadiness(rootWith([image]), { fontSet: null });
    image.dispatchEvent(new Event("error"));
    await expect(imageRun).rejects.toBeInstanceOf(CriticalDomResourceError);

    const fontSet: CriticalFontFaceSet = {
      load: async () => [],
      ready: Promise.resolve({}),
    };
    await expect(waitForCriticalDomReadiness(rootWith([]), {
      fontSet,
      fontDescriptors: ['700 16px "Missing"'],
    })).rejects.toMatchObject({
      kind: "font",
      resource: '700 16px "Missing"',
    });
  });

  it("propagates AbortSignal while decode is pending and never reports complete", async () => {
    const decode = deferred<void>();
    const image = new FakeImage("/slow.png");
    image.decode = () => decode.promise;
    const controller = new AbortController();
    const reason = new Error("route disposed");
    const progress: CriticalDomReadinessProgress[] = [];
    const run = waitForCriticalDomReadiness(rootWith([image]), {
      signal: controller.signal,
      fontSet: null,
      onProgress: (event) => progress.push(event),
    });

    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(progress.some(({ stage }) => stage === "complete")).toBe(false);
    decode.resolve();
  });

  it("is a safe no-op for the missing document.fonts surface used by node/jsdom", async () => {
    const progress: CriticalDomReadinessProgress[] = [];
    await expect(waitForCriticalDomReadiness(rootWith([]), {
      onProgress: (event) => progress.push(event),
    })).resolves.toBeUndefined();

    expect(progress.map(({ stage }) => stage)).toEqual([
      "images",
      "images",
      "fonts",
      "fonts",
      "complete",
    ]);
    expect(progress.map(({ progress: value }) => value)).toEqual([0, 0.8, 0.8, 1, 1]);
  });
});
