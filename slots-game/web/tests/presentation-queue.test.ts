import { describe, expect, it } from "vitest";
import { PresentationQueue } from "../src/presentation/PresentationQueue";

describe("PresentationQueue", () => {
  it("serializes tasks and continues after a rejected presentation", async () => {
    const queue = new PresentationQueue();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const failed = queue.enqueue(() => {
      order.push("failed");
      throw new Error("visual error");
    });
    const third = queue.enqueue(() => { order.push("third"); });

    expect(order).toEqual(["first:start"]);
    release?.();
    await first;
    await expect(failed).rejects.toThrow("visual error");
    await third;
    expect(order).toEqual(["first:start", "first:end", "failed", "third"]);
    expect(queue.size).toBe(0);
  });
});
