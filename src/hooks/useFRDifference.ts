import { useEffect, useMemo, useRef, useState } from "react";

export type PlaybackBand = "full" | "low" | "mid" | "high" | { custom?: [number, number] };

export type DiffSettings = {
  align: "time" | "phase" | "none";
  windowMs: number;
  smoothing: number;
  threshold: number;
};

export type DiffRegion = {
  start: number;
  end: number;
  peak: number;
};

export type UseFRDifferenceInput = {
  a: Float32Array | number[] | null | undefined;
  b: Float32Array | number[] | null | undefined;
  sampleRate: number;
  band: PlaybackBand;
  settings: DiffSettings;
  active?: boolean;
};

export type UseFRDifferenceResult = {
  diffSignal: Float32Array | null;
  frDelta: number[] | null;
  regions: DiffRegion[];
  stats: { rms: number; peak: number; overThresholdPct: number } | null;
  state: "idle" | "computing" | "ready" | "error";
  error?: string;
};

const EPSILON = 1e-9;
const DEFAULT_RESULT: UseFRDifferenceResult = Object.freeze({
  diffSignal: null,
  frDelta: null,
  regions: [],
  stats: null,
  state: "idle" as const,
});

type ScheduledHandle = number | null;

export function useFRDifference({
  a,
  b,
  sampleRate,
  band,
  settings,
  active = true,
}: UseFRDifferenceInput): UseFRDifferenceResult {
  const normalizedA = useMemo(() => normalizeBuffer(a), [a]);
  const normalizedB = useMemo(() => normalizeBuffer(b), [b]);
  const { align, windowMs, smoothing, threshold } = settings;

  const [{ diffSignal, frDelta, regions, stats, state, error }, setResult] =
    useState<UseFRDifferenceResult>(DEFAULT_RESULT);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const hasInputs =
      normalizedA && normalizedB && normalizedA.length > 0 && normalizedB.length > 0;
    if (!hasInputs || sampleRate <= 0) {
      setResult(DEFAULT_RESULT);
      return;
    }
    if (!active) {
      setResult((prev) =>
        prev === DEFAULT_RESULT
          ? prev
          : {
              ...prev,
              state: "idle",
            },
      );
      return;
    }

    let cancelled = false;
    setResult((prev) => ({
      diffSignal: prev.diffSignal,
      frDelta: prev.frDelta,
      regions: prev.regions,
      stats: prev.stats,
      state: "computing",
      error: undefined,
    }));

    const job = () => {
      if (cancelled || !normalizedA || !normalizedB) {
        return;
      }
      try {
        const payload = computeDifferencePayload({
          a: normalizedA,
          b: normalizedB,
          sampleRate,
          band,
          align,
          windowMs,
          smoothing,
          threshold,
        });
        if (!cancelled && isMountedRef.current) {
          setResult({
            ...payload,
            state: "ready",
          });
        }
      } catch (err) {
        if (!cancelled && isMountedRef.current) {
          setResult({
            diffSignal: null,
            frDelta: null,
            regions: [],
            stats: null,
            state: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    let idleHandle: ScheduledHandle = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const idleScheduler =
      typeof window !== "undefined" && typeof (window as Window & { requestIdleCallback?: (cb: IdleRequestCallback) => number }).requestIdleCallback === "function"
        ? (window as Window & { requestIdleCallback: (cb: IdleRequestCallback) => number }).requestIdleCallback
        : undefined;
    const idleCanceller =
      typeof window !== "undefined" && typeof (window as Window & { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback === "function"
        ? (window as Window & { cancelIdleCallback: (handle: number) => void }).cancelIdleCallback
        : undefined;

    if (idleScheduler) {
      idleHandle = idleScheduler(() => {
        job();
      });
    } else {
      timeoutHandle = setTimeout(job, 0);
    }

    return () => {
      cancelled = true;
      if (idleHandle != null && idleCanceller) {
        idleCanceller(idleHandle);
      }
      if (timeoutHandle != null) {
        clearTimeout(timeoutHandle);
      }
    };
  }, [
    normalizedA,
    normalizedB,
    sampleRate,
    band,
    align,
    windowMs,
    smoothing,
    threshold,
    active,
  ]);

  return { diffSignal, frDelta, regions, stats, state, error };
}

type ComputePayload = {
  a: Float32Array;
  b: Float32Array;
  sampleRate: number;
  band: PlaybackBand;
  align: DiffSettings["align"];
  windowMs: number;
  smoothing: number;
  threshold: number;
};

function computeDifferencePayload({
  a,
  b,
  sampleRate,
  band,
  align,
  windowMs,
  smoothing,
  threshold,
}: ComputePayload) {
  const bandedA = applyBandpass(a, sampleRate, band);
  const bandedB = applyBandpass(b, sampleRate, band);
  const { alignedA, alignedB } = alignSignals(bandedA, bandedB, sampleRate, align);
  const diffSignal = subtract(alignedA, alignedB);
  const stats = computeStats(diffSignal, sampleRate, windowMs, smoothing, threshold);
  const frDelta = alignedA.length > 0 && alignedB.length > 0 ? computeFrDelta(alignedA, alignedB) : null;
  return {
    diffSignal,
    frDelta,
    regions: stats.regions,
    stats: {
      rms: stats.rms,
      peak: stats.peak,
      overThresholdPct: stats.overThresholdPct,
    },
  };
}

function normalizeBuffer(
  input: Float32Array | number[] | null | undefined,
): Float32Array | null {
  if (!input) return null;
  if (input instanceof Float32Array) {
    return input.length > 0 ? input : null;
  }
  if (Array.isArray(input)) {
    return input.length > 0 ? Float32Array.from(input) : null;
  }
  return null;
}

function resolveBandRange(
  band: PlaybackBand,
  sampleRate: number,
): [number, number] | null {
  if (!band || band === "full") {
    return null;
  }
  const nyquist = Math.max(10, sampleRate / 2);
  if (band === "low") {
    return [20, Math.min(200, nyquist)];
  }
  if (band === "mid") {
    return [200, Math.min(5000, nyquist)];
  }
  if (band === "high") {
    return [5000, Math.min(20000, nyquist)];
  }
  if (typeof band === "object" && band.custom && Array.isArray(band.custom)) {
    const [min, max] = band.custom;
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      return [clamp(min, 0, nyquist), clamp(max, 0, nyquist)];
    }
  }
  return null;
}

function applyBandpass(
  input: Float32Array,
  sampleRate: number,
  band: PlaybackBand,
): Float32Array {
  const range = resolveBandRange(band, sampleRate);
  if (!range) {
    return input;
  }
  const [minHz, maxHz] = range;
  let output = input;
  if (minHz > 20) {
    const hp = designBiquad("highpass", minHz, sampleRate);
    if (hp) {
      output = biquadFilter(output, hp);
    }
  }
  if (maxHz > 0 && maxHz < sampleRate / 2) {
    const lp = designBiquad("lowpass", maxHz, sampleRate);
    if (lp) {
      output = biquadFilter(output, lp);
    }
  }
  return output;
}

type BiquadType = "lowpass" | "highpass";

type BiquadCoefficients = {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
};

function designBiquad(
  type: BiquadType,
  cutoffHz: number,
  sampleRate: number,
  q = Math.SQRT1_2,
): BiquadCoefficients | null {
  if (!(cutoffHz > 0) || sampleRate <= 0 || cutoffHz >= sampleRate / 2) {
    return null;
  }
  const omega = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(omega);
  const sin = Math.sin(omega);
  const alpha = sin / (2 * q);
  const a0 = 1 + alpha;
  let b0: number;
  let b1: number;
  let b2: number;
  let a1: number;
  let a2: number;

  if (type === "lowpass") {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }

  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0,
  };
}

function biquadFilter(input: Float32Array, coeffs: BiquadCoefficients): Float32Array {
  const { b0, b1, b2, a1, a2 } = coeffs;
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function alignSignals(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
  mode: DiffSettings["align"],
): { alignedA: Float32Array; alignedB: Float32Array } {
  if (mode === "time" || mode === "phase") {
    const lag = findBestLag(a, b, sampleRate);
    const startA = lag > 0 ? lag : 0;
    const startB = lag < 0 ? -lag : 0;
    const maxLength = Math.min(a.length - startA, b.length - startB);
    if (maxLength <= 0) {
      return { alignedA: new Float32Array(0), alignedB: new Float32Array(0) };
    }
    return {
      alignedA: a.subarray(startA, startA + maxLength),
      alignedB: b.subarray(startB, startB + maxLength),
    };
  }
  const length = Math.min(a.length, b.length);
  return {
    alignedA: a.subarray(0, length),
    alignedB: b.subarray(0, length),
  };
}

function findBestLag(a: Float32Array, b: Float32Array, sampleRate: number): number {
  const maxLag = Math.min(Math.floor(sampleRate * 0.05), Math.min(a.length, b.length) - 1);
  if (maxLag <= 0) return 0;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let score = 0;
    if (lag >= 0) {
      for (let i = 0; i < a.length - lag; i++) {
        score += a[i + lag] * b[i];
      }
    } else {
      const offset = -lag;
      for (let i = 0; i < b.length - offset; i++) {
        score += a[i] * b[i + offset];
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return Math.trunc(bestLag);
}

function subtract(a: Float32Array, b: Float32Array): Float32Array {
  const length = Math.min(a.length, b.length);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = a[i] - b[i];
  }
  return out;
}

function computeStats(
  diff: Float32Array,
  sampleRate: number,
  windowMs: number,
  smoothing: number,
  threshold: number,
) {
  if (diff.length === 0) {
    return { rms: -Infinity, peak: -Infinity, overThresholdPct: 0, regions: [] as DiffRegion[] };
  }
  let sumSq = 0;
  let peakLinear = 0;
  for (let i = 0; i < diff.length; i++) {
    const v = diff[i];
    sumSq += v * v;
    const abs = Math.abs(v);
    if (abs > peakLinear) peakLinear = abs;
  }
  const rmsLinear = Math.sqrt(sumSq / diff.length);
  const rmsDb = linearToDb(rmsLinear);
  const peakDb = linearToDb(peakLinear);

  const analysis = analyzeRegions(diff, sampleRate, windowMs, smoothing, threshold);

  return {
    rms: rmsDb,
    peak: peakDb,
    overThresholdPct: analysis.overThresholdPct,
    regions: analysis.regions,
  };
}

function analyzeRegions(
  diff: Float32Array,
  sampleRate: number,
  windowMs: number,
  smoothing: number,
  threshold: number,
): { regions: DiffRegion[]; overThresholdPct: number } {
  const windowSeconds = Math.max(1, windowMs) / 1000;
  const windowSamples = Math.max(1, Math.round(windowSeconds * sampleRate));
  const hop = Math.max(1, Math.round(windowSamples / 2));
  const smoothedFactor = clamp01(smoothing);
  const regions: DiffRegion[] = [];
  let current: DiffRegion | null = null;
  let smoothedValue = -Infinity;
  let overCount = 0;
  let totalCount = 0;

  for (let start = 0; start < diff.length; start += hop) {
    const end = Math.min(diff.length, start + windowSamples);
    if (end <= start) break;
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = diff[i];
      sumSq += v * v;
    }
    const rmsLinear = Math.sqrt(sumSq / (end - start));
    const rmsDb = linearToDb(rmsLinear);
    smoothedValue =
      smoothedFactor > 0 && Number.isFinite(smoothedValue)
        ? smoothedFactor * smoothedValue + (1 - smoothedFactor) * rmsDb
        : rmsDb;
    const isOver = smoothedValue >= threshold;
    totalCount += 1;
    if (isOver) {
      overCount += 1;
      if (!current) {
        current = {
          start: start / sampleRate,
          end: end / sampleRate,
          peak: smoothedValue,
        };
      } else {
        current.end = end / sampleRate;
        if (smoothedValue > current.peak) {
          current.peak = smoothedValue;
        }
      }
    } else if (current) {
      regions.push(current);
      current = null;
    }
  }
  if (current) {
    regions.push(current);
  }
  const overThresholdPct = totalCount > 0 ? (overCount / totalCount) * 100 : 0;
  return { regions, overThresholdPct };
}

function computeFrDelta(a: Float32Array, b: Float32Array): number[] | null {
  const length = Math.min(a.length, b.length);
  if (length <= 0) return null;
  const fftSize = nextPow2(length);
  if (fftSize <= 0 || !Number.isFinite(fftSize)) {
    return null;
  }
  const realA = new Float32Array(fftSize);
  const imagA = new Float32Array(fftSize);
  const realB = new Float32Array(fftSize);
  const imagB = new Float32Array(fftSize);
  realA.set(a.subarray(0, Math.min(a.length, fftSize)));
  realB.set(b.subarray(0, Math.min(b.length, fftSize)));

  fftInPlace(realA, imagA, false);
  fftInPlace(realB, imagB, false);

  const half = Math.floor(fftSize / 2);
  const delta = new Array<number>(half);
  for (let i = 0; i < half; i++) {
    const magA = Math.hypot(realA[i], imagA[i]);
    const magB = Math.hypot(realB[i], imagB[i]);
    const ratio = (magB + EPSILON) / (magA + EPSILON);
    delta[i] = 20 * Math.log10(ratio);
  }
  return delta;
}

function fftInPlace(real: Float32Array, imag: Float32Array, inverse: boolean) {
  const n = real.length;
  if (n === 0) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error("FFT length must be power of two");
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tempReal = real[i];
      real[i] = real[j];
      real[j] = tempReal;
      const tempImag = imag[i];
      imag[i] = imag[j];
      imag[j] = tempImag;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const theta = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wpr = -2 * Math.sin(0.5 * theta) ** 2;
    const wpi = Math.sin(theta);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < halfLen; j++) {
        const evenReal = real[i + j];
        const evenImag = imag[i + j];
        const oddReal = real[i + j + halfLen];
        const oddImag = imag[i + j + halfLen];

        const xr = wr * oddReal - wi * oddImag;
        const xi = wr * oddImag + wi * oddReal;

        real[i + j] = evenReal + xr;
        imag[i + j] = evenImag + xi;
        real[i + j + halfLen] = evenReal - xr;
        imag[i + j + halfLen] = evenImag - xi;

        const wrNext = wr + wr * wpr - wi * wpi;
        const wiNext = wi + wi * wpr + wr * wpi;
        wr = wrNext;
        wi = wiNext;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function nextPow2(value: number): number {
  if (value <= 0) return 0;
  return 2 ** Math.ceil(Math.log2(value));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function linearToDb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return -Infinity;
  }
  return 20 * Math.log10(value + EPSILON);
}
