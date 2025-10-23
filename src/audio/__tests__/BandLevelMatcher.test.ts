import { describe, expect, it } from "vitest";
import { computeBufferRms, calculateGain } from "../BandLevelMatcher";

const createBuffer = (channels: number[][]): AudioBuffer =>
  ({
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate: 48000,
    getChannelData: (index: number) => Float32Array.from(channels[index] ?? []),
  }) as unknown as AudioBuffer;

describe("BandLevelMatcher helpers", () => {
  it("computes RMS across channels", () => {
    const buffer = createBuffer([
      [1, -1, 1, -1],
      [0.5, -0.5, 0.5, -0.5],
    ]);

    expect(computeBufferRms(buffer)).toBeCloseTo(Math.sqrt(0.625));
  });

  it("returns zero for empty buffers", () => {
    const buffer = createBuffer([[]]);
    expect(computeBufferRms(buffer)).toBe(0);
  });

  it("calculates gain ratios with clamping", () => {
    expect(calculateGain(1, 0.5)).toBeCloseTo(2);
    expect(calculateGain(0.1, 1)).toBeCloseTo(0.1);
    expect(calculateGain(100, 1)).toBeCloseTo(4);
    expect(calculateGain(0, 1)).toBe(1);
    expect(calculateGain(1, 0)).toBe(1);
  });
});
