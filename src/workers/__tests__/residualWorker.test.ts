import { afterAll, beforeAll, describe, expect, it } from "vitest";

type ComputeResidualFn = typeof import("../residualWorker")["__testComputeResidual"];
type MockWorkerScope = {
  addEventListener: (...args: unknown[]) => void;
  removeEventListener: (...args: unknown[]) => void;
  postMessage: (...args: unknown[]) => void;
};

let computeResidual: ComputeResidualFn;

beforeAll(async () => {
  const mockSelf: MockWorkerScope = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
  };
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    writable: true,
    value: mockSelf,
  });
  const module = await import("../residualWorker");
  computeResidual = module.__testComputeResidual;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "self");
});

const createPayload = (wet: Float32Array, dry: Float32Array, gains?: Float32Array, offset = 0) => ({
  wetChannels: [wet],
  dryChannels: [dry],
  gains: gains ?? new Float32Array([1]),
  offset,
  thresholdDb: 0,
  sampleRate: 48000,
  originalLength: wet.length,
  bandSoloEnabled: false,
  bandMinHz: 20,
  bandMaxHz: 20000,
});

const rms = (buffer: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i];
  }
  return buffer.length > 0 ? Math.sqrt(sum / buffer.length) : 0;
};

describe("residualWorker computeResidual", () => {
  it("nulls identical wet and dry signals below -80 dBFS", () => {
    const length = 2048;
    const dry = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      dry[i] = Math.sin((2 * Math.PI * i) / 64);
    }
    const wet = new Float32Array(dry);
    const result = computeResidual(createPayload(wet, dry));
    expect(rms(result)).toBeLessThan(1e-4);
  });

  it("captures differences when wet varies from dry", () => {
    const length = 2048;
    const dry = new Float32Array(length);
    const wet = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      wet[i] = Math.sin((2 * Math.PI * i) / 32);
    }
    const result = computeResidual(createPayload(wet, dry));
    expect(rms(result)).toBeGreaterThan(0.6);
  });
});
