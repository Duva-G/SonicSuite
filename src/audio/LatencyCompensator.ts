export type PathKey = "A" | "B" | "C";

export type LatencySecondsMap = Partial<Record<PathKey, number>>;

const DEFAULT_MAX_DELAY = 8;

export class LatencyCompensator {
  private ctx: BaseAudioContext;
  private nodes: Record<PathKey, DelayNode>;
  private readonly maxDelaySeconds: number;

  constructor(ctx: BaseAudioContext, maxDelaySeconds = DEFAULT_MAX_DELAY) {
    this.ctx = ctx;
    this.maxDelaySeconds = Math.max(0.5, maxDelaySeconds);
    this.nodes = {
      A: new DelayNode(ctx, { maxDelayTime: this.maxDelaySeconds }),
      B: new DelayNode(ctx, { maxDelayTime: this.maxDelaySeconds }),
      C: new DelayNode(ctx, { maxDelayTime: this.maxDelaySeconds }),
    };
  }

  getNode(path: PathKey): DelayNode {
    return this.nodes[path];
  }

  update(latencies: LatencySecondsMap, rampSeconds = 0.01) {
    const values = (Object.keys(this.nodes) as PathKey[])
      .map((key) => latencies[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);

    const maxLatency = values.length > 0 ? Math.max(...values) : 0;
    const limit = this.maxDelaySeconds - 0.001;
    const now = this.ctx.currentTime;

    (Object.keys(this.nodes) as PathKey[]).forEach((key) => {
      const latency = latencies[key] ?? 0;
      const compensation = Math.min(Math.max(maxLatency - latency, 0), limit);
      this.nodes[key].delayTime.setTargetAtTime(compensation, now, rampSeconds);
    });
  }
}
