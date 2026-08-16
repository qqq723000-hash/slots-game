import { describe, expect, it, vi } from "vitest";
import {
  createStagedGraphOwnershipTransfer,
  runStagedComponentConstruction,
  STAGED_COMPONENT_BATCH_CAP,
} from "../src/startup/stagedComponentConstruction";

describe("runStagedComponentConstruction", () => {
  it("constructs substantive owners on distinct frames with a one-component cap", async () => {
    let frame = 0;
    const builds: Array<{ id: string; frame: number }> = [];
    const events: Array<{ stage: string; frame: number; componentCount: number }> = [];
    const progress: number[] = [];
    const ownership = await runStagedComponentConstruction(
      ["reel-cabinet", "city-backdrop", "feature-effects"].map((id) => ({
        id,
        build: () => {
          builds.push({ id, frame });
          return () => undefined;
        },
      })),
      {
        requestFrame: async () => { frame += 1; },
        onStage: (event) => events.push(event),
        onProgress: (fraction) => progress.push(fraction),
      },
    );

    expect(STAGED_COMPONENT_BATCH_CAP).toBe(1);
    expect(builds).toEqual([
      { id: "reel-cabinet", frame: 1 },
      { id: "city-backdrop", frame: 2 },
      { id: "feature-effects", frame: 3 },
    ]);
    expect(new Set(events.map((event) => event.frame)).size).toBe(3);
    expect(events.every((event) => event.componentCount <= STAGED_COMPONENT_BATCH_CAP)).toBe(true);
    expect(Math.max(...progress)).toBeLessThan(1);
    ownership.release();
  });

  it("cancels between frames, disposes each completed owner once, and builds no tail", async () => {
    const abort = new AbortController();
    const frames: Array<() => void> = [];
    const built: string[] = [];
    const disposed = [vi.fn(), vi.fn(), vi.fn()];
    const run = runStagedComponentConstruction(
      ["one", "two", "three"].map((id, index) => ({
        id,
        build: () => {
          built.push(id);
          return disposed[index];
        },
      })),
      {
        signal: abort.signal,
        requestFrame: () => new Promise<void>((resolve) => frames.push(resolve)),
      },
    );

    frames.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(built).toEqual(["one"]);

    const reason = new Error("route disposed");
    abort.abort(reason);
    frames.shift()?.();
    await expect(run).rejects.toBe(reason);
    expect(built).toEqual(["one"]);
    expect(disposed[0]).toHaveBeenCalledTimes(1);
    expect(disposed[1]).not.toHaveBeenCalled();
    expect(disposed[2]).not.toHaveBeenCalled();
  });

  it("keeps the completion quantum reserved until the caller wires the final graph", async () => {
    const progress: number[] = [];
    const ownership = await runStagedComponentConstruction(
      [{ id: "renderer-shell", build: () => undefined }],
      {
        requestFrame: async () => undefined,
        onProgress: (fraction) => progress.push(fraction),
      },
    );

    expect(progress).toEqual([0, 0.5]);
    expect(progress).not.toContain(1);
    ownership.release();
  });
});

describe("createStagedGraphOwnershipTransfer", () => {
  it("makes the completed graph the sole disposer after atomic adoption", () => {
    const transfer = createStagedGraphOwnershipTransfer();
    const ownerOne = vi.fn();
    const ownerTwo = vi.fn();
    const graph = vi.fn();
    const disposeOne = transfer.componentDisposer(ownerOne);
    const disposeTwo = transfer.componentDisposer(ownerTwo);

    const disposeGraph = transfer.transferToGraph(graph);
    disposeGraph();
    disposeGraph();
    disposeTwo();
    disposeOne();

    expect(transfer.graphOwnsComponents).toBe(true);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(ownerOne).not.toHaveBeenCalled();
    expect(ownerTwo).not.toHaveBeenCalled();
  });

  it("disposes every partial owner exactly once when no graph was built", () => {
    const transfer = createStagedGraphOwnershipTransfer();
    const ownerOne = vi.fn();
    const ownerTwo = vi.fn();
    const disposeOne = transfer.componentDisposer(ownerOne);
    const disposeTwo = transfer.componentDisposer(ownerTwo);

    disposeTwo();
    disposeTwo();
    disposeOne();
    disposeOne();

    expect(transfer.graphOwnsComponents).toBe(false);
    expect(ownerOne).toHaveBeenCalledTimes(1);
    expect(ownerTwo).toHaveBeenCalledTimes(1);
  });
});
