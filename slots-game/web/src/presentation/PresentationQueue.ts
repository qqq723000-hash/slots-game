export type PresentationTask = () => void | Promise<void>;

interface QueueEntry {
  task: PresentationTask;
  resolve: () => void;
  reject: (reason: unknown) => void;
}

/** 将视觉工作序列化，不会让失败的任务影响到后续的工作。 */
export class PresentationQueue {
  private readonly entries: QueueEntry[] = [];
  private active = false;

  get size(): number {
    return this.entries.length + (this.active ? 1 : 0);
  }

  enqueue(task: PresentationTask): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this.entries.push({ task, resolve, reject });
    });
    void this.drain();
    return result;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    while (this.entries.length > 0) {
      const entry = this.entries.shift();
      if (!entry) continue;
      try {
        await entry.task();
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }
    this.active = false;
  }
}
