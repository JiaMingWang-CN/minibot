import type { DiagEvent } from './log.ts';

// 模型请求的本地聚合：每小时把 p50/p95 生成一条 metric 事件，避免逐条上传。

interface Group {
  presetId: string;
  model: string;
  count: number;
  failures: number;
  durations: number[];
}

const MAX_GROUPS = 50;
const MAX_SAMPLES = 200;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[index]!;
}

export class ModelMetrics {
  private readonly groups = new Map<string, Group>();

  record(presetId: string, model: string, ok: boolean, durationMs: number): void {
    const key = `${presetId}\u0000${model}`;
    let group = this.groups.get(key);
    if (group === undefined) {
      if (this.groups.size >= MAX_GROUPS) return;
      group = { presetId, model, count: 0, failures: 0, durations: [] };
      this.groups.set(key, group);
    }
    group.count += 1;
    if (!ok) group.failures += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      group.durations.push(Math.round(durationMs));
      if (group.durations.length > MAX_SAMPLES) group.durations.shift();
    }
  }

  /** 取出并清空聚合结果；每个分组一条事件 */
  flush(): DiagEvent[] {
    const events: DiagEvent[] = [];
    for (const group of this.groups.values()) {
      const sorted = [...group.durations].sort((a, b) => a - b);
      events.push({
        kind: 'metric',
        name: 'metric/model.latency',
        data: {
          presetId: group.presetId.slice(0, 64),
          model: group.model.slice(0, 64),
          count: group.count,
          failures: group.failures,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
        },
      });
    }
    this.groups.clear();
    return events;
  }
}
