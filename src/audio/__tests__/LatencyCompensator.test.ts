import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { LatencyCompensator } from "../LatencyCompensator";

type DelayCall = { value: number; time: number; ramp: number };

class MockDelayNode {
  ctx: BaseAudioContext;
  delayTime: {
    setTargetAtTime: (value: number, time: number, ramp: number) => void;
  };
  calls: DelayCall[];
  last: number;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.calls = [];
    this.last = 0;
    this.delayTime = {
      setTargetAtTime: (value: number, time: number, ramp: number) => {
        this.calls.push({ value, time, ramp });
        this.last = value;
      },
    };
  }
}

describe("LatencyCompensator", () => {
  beforeEach(() => {
    (globalThis as unknown as { DelayNode: unknown }).DelayNode = MockDelayNode as unknown;
  });

  afterEach(() => {
    delete (globalThis as unknown as { DelayNode?: unknown }).DelayNode;
  });

  it("applies compensation relative to the slowest path", () => {
    const ctx = { currentTime: 1.25 } as unknown as BaseAudioContext;
    const compensator = new LatencyCompensator(ctx, 1);

    const latencies = { A: 0.1, B: 0.4, C: 0.25 };
    compensator.update(latencies, 0.05);

    const nodeA = compensator.getNode("A") as unknown as MockDelayNode;
    const nodeB = compensator.getNode("B") as unknown as MockDelayNode;
    const nodeC = compensator.getNode("C") as unknown as MockDelayNode;

    expect(nodeB.last).toBeCloseTo(0);
    expect(nodeA.last).toBeCloseTo(0.3);
    expect(nodeC.last).toBeCloseTo(0.15);

    expect(nodeA.calls[0]).toEqual({ value: nodeA.last, time: ctx.currentTime, ramp: 0.05 });
    expect(nodeB.calls[0]).toEqual({ value: 0, time: ctx.currentTime, ramp: 0.05 });
    expect(nodeC.calls[0]).toEqual({ value: nodeC.last, time: ctx.currentTime, ramp: 0.05 });
  });
});

