interface Lane {
  tail: Promise<void>;
  current: AbortController | undefined;
  running: boolean;
  controllers: Set<AbortController>;
}

export class ThreadQueue {
  private lanes = new Map<string, Lane>();

  enqueue(threadId: string, job: (signal: AbortSignal) => Promise<void>): Promise<void> {
    let lane = this.lanes.get(threadId);
    if (lane === undefined) {
      lane = {
        tail: Promise.resolve(),
        current: undefined,
        running: false,
        controllers: new Set(),
      };
      this.lanes.set(threadId, lane);
    }

    const controller = new AbortController();
    lane.controllers.add(controller);
    const run = async (): Promise<void> => {
      lane.controllers.delete(controller);
      if (controller.signal.aborted) return;
      lane.current = controller;
      lane.running = true;
      try {
        await job(controller.signal);
      } finally {
        if (lane.current === controller) lane.current = undefined;
        lane.running = false;
      }
    };

    const next = lane.tail.then(run, run);
    lane.tail = next.catch(() => {});
    void next.finally(() => {
      if (this.lanes.get(threadId) === lane && !lane.running && lane.controllers.size === 0) {
        this.lanes.delete(threadId);
      }
    });
    return next;
  }

  abort(threadId: string): void {
    this.lanes.get(threadId)?.current?.abort();
  }

  /** 中止该线程正在运行的与排队中的全部任务 */
  abortThread(threadId: string): void {
    const lane = this.lanes.get(threadId);
    if (lane === undefined) return;
    for (const controller of lane.controllers) controller.abort();
    lane.current?.abort();
  }

  /** 等该线程已排队的任务全部结束 */
  async whenIdle(threadId: string): Promise<void> {
    for (;;) {
      const lane = this.lanes.get(threadId);
      if (lane === undefined) return;
      const tail = lane.tail;
      await tail;
      if (this.lanes.get(threadId) !== lane || lane.tail === tail) return;
    }
  }

  isRunning(threadId: string): boolean {
    return this.lanes.get(threadId)?.running === true;
  }

  abortAll(): void {
    for (const lane of this.lanes.values()) {
      for (const controller of lane.controllers) controller.abort();
      lane.current?.abort();
    }
  }
}
