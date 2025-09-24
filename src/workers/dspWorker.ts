/// <reference lib="webworker" />
// WHY: Offloads pink-noise spectral analysis into a worker to keep the UI responsive.
import FFT from "fft.js";
const ctx = self as DedicatedWorkerGlobalScope;

type SmoothingMode = "1/12" | "1/6" | "1/3";

type ComputeMessage = {
  type: "compute-fr";
  requestId: number;
  payload: {
    sampleRate: number;
    smoothing: SmoothingMode;
    ir?: {
      data: Float32Array;
      sampleRate: number;
      label: string;
    } | null;
  };
};

type ComputePlaybackMessage = {
  type: "compute-playback-fr";
  requestId: number;
  payload: {
    sampleRate: number;
    smoothing: SmoothingMode;
    music: {
      data: Float32Array;
      sampleRate: number;
      label: string;
    };
    ir: {
      data: Float32Array;
      sampleRate: number;
      label: string;
    } | null;
  };
};

type WorkerRequest = ComputeMessage | ComputePlaybackMessage;


type BaseSpectra = {
  freqs: Float32Array;
  pinkDb: Float32Array;
  convolvedDb: Float32Array | null;
  transferDb: Float32Array | null;
  hasIR: boolean;
  irLabel: string | null;
};

type SmoothedSpectra = BaseSpectra & { smoothing: SmoothingMode };

type PlaybackSpectra = {
  freqs: Float32Array;
  dryDb: Float32Array;
  wetDb: Float32Array | null;
  hasIR: boolean;
};

type SmoothedPlaybackSpectra = PlaybackSpectra & { smoothing: SmoothingMode };

const baseCache = new Map<string, BaseSpectra>();
const smoothingCache = new Map<string, SmoothedSpectra>();
const playbackBaseCache = new Map<string, PlaybackSpectra>();
const playbackSmoothingCache = new Map<string, SmoothedPlaybackSpectra>();

const EPS = 1e-20;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "compute-fr") {
    handleCompute(msg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown worker error";
      ctx.postMessage({
        type: "fr-error",
        requestId: msg.requestId,
        error: message,
      });
    });
  } else if (msg.type === "compute-playback-fr") {
    handlePlaybackCompute(msg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown worker error";
      ctx.postMessage({
        type: "playback-fr-error",
        requestId: msg.requestId,
        error: message,
      });
    });
  }
};

async function handleCompute(msg: ComputeMessage): Promise<void> {
  const { sampleRate, smoothing, ir = null } = msg.payload;
  const irHash = ir ? hashFloatArray(ir.data, ir.sampleRate) : "none";
  const baseKey = `${sampleRate}|${irHash}`;

  let base = baseCache.get(baseKey);
  if (!base) {
    base = await computeBaseSpectra(sampleRate, ir);
    baseCache.set(baseKey, base);
  }

  const smoothKey = `${baseKey}|${smoothing}`;
  let smoothed = smoothingCache.get(smoothKey);
  if (!smoothed) {
    smoothed = { ...applySmoothing(base, smoothing), smoothing };
    smoothingCache.set(smoothKey, smoothed);
  }

  const freqsCopy = smoothed.freqs.slice();
  const pinkCopy = smoothed.pinkDb.slice();
  const convCopy = smoothed.convolvedDb ? smoothed.convolvedDb.slice() : null;
  const transferCopy = smoothed.transferDb ? smoothed.transferDb.slice() : null;

  const transferables: Transferable[] = [freqsCopy.buffer, pinkCopy.buffer];
  if (convCopy) transferables.push(convCopy.buffer);
  if (transferCopy) transferables.push(transferCopy.buffer);

  ctx.postMessage(
    {
      type: "fr-result",
      requestId: msg.requestId,
      payload: {
        freqs: freqsCopy,
        pinkDb: pinkCopy,
        convolvedDb: convCopy,
        transferDb: transferCopy,
        hasIR: smoothed.hasIR,
        irLabel: smoothed.irLabel,
      },
    },
    transferables
  );
}

async function handlePlaybackCompute(msg: ComputePlaybackMessage): Promise<void> {
  const { sampleRate, smoothing, music, ir } = msg.payload;
  if (!music || music.data.length === 0) {
    ctx.postMessage({
      type: "playback-fr-error",
      requestId: msg.requestId,
      error: "Music buffer is empty.",
    });
    return;
  }

  const musicHash = hashFloatArray(music.data, music.sampleRate);
  const irHash = ir && ir.data.length > 0 ? hashFloatArray(ir.data, ir.sampleRate) : "none";
  const baseKey = `playback|${sampleRate}|${musicHash}|${irHash}`;

  let base = playbackBaseCache.get(baseKey);
  if (!base) {
    base = await computePlaybackSpectra(sampleRate, music, ir);
    playbackBaseCache.set(baseKey, base);
  }

  const smoothKey = `${baseKey}|${smoothing}`;
  let smoothed = playbackSmoothingCache.get(smoothKey);
  if (!smoothed) {
    smoothed = { ...applyPlaybackSmoothing(base, smoothing), smoothing };
    playbackSmoothingCache.set(smoothKey, smoothed);
  }

  const freqsCopy = smoothed.freqs.slice();
  const dryCopy = smoothed.dryDb.slice();
  const wetCopy = smoothed.wetDb ? smoothed.wetDb.slice() : null;

  const transferables: Transferable[] = [freqsCopy.buffer, dryCopy.buffer];
  if (wetCopy) transferables.push(wetCopy.buffer);

  ctx.postMessage(
    {
      type: "playback-fr-result",
      requestId: msg.requestId,
      payload: {
        freqs: freqsCopy,
        dryDb: dryCopy,
        wetDb: wetCopy,
        hasIR: smoothed.hasIR,
      },
    },
    transferables
  );
}


async function computeBaseSpectra(
  sampleRate: number,
  ir: { data: Float32Array; sampleRate: number; label: string } | null
): Promise<BaseSpectra> {
  const pink = generatePinkNoise(sampleRate, 30);
  if (!ir || ir.data.length === 0) {
    const single = welchSingle(pink, sampleRate);
    const limited = limitFrequencyRange(single.freqs, 20, 20000, [single.psd]);
    const pinkDb = powerArrayToDb(limited.arrays[0]);
    return {
      freqs: limited.freqs,
      pinkDb,
      convolvedDb: null,
      transferDb: null,
      hasIR: false,
      irLabel: null,
    };
  }

  let irData = ir.data;
  if (ir.sampleRate !== sampleRate) {
    irData = resampleLinear(irData, ir.sampleRate, sampleRate);
  } else {
    irData = irData.slice();
  }

  irData = normalizeImpulseResponse(irData);

  const convolvedFull = convolveFFT(pink, irData);
  const convolved =
    convolvedFull.length >= pink.length
      ? convolvedFull.subarray(0, pink.length)
      : padToLength(convolvedFull, pink.length);

  const pinkRms = computeRms(pink);
  const convRms = computeRms(convolved);
  if (convRms > EPS) {
    const gain = pinkRms / convRms;
    for (let i = 0; i < convolved.length; i++) {
      convolved[i] *= gain;
    }
  }

  const pair = welchPair(pink, convolved, sampleRate);
  const limited = limitFrequencyRange(pair.freqs, 20, 20000, [pair.psdX, pair.psdY, pair.transfer]);
  const pinkDb = powerArrayToDb(limited.arrays[0]);
  const convolvedDb = powerArrayToDb(limited.arrays[1]);
  const transferDb = amplitudeArrayToDb(limited.arrays[2]);

  return {
    freqs: limited.freqs,
    pinkDb,
    convolvedDb,
    transferDb,
    hasIR: true,
    irLabel: ir.label,
  };
}

async function computePlaybackSpectra(
  sampleRate: number,
  music: { data: Float32Array; sampleRate: number; label: string },
  ir: { data: Float32Array; sampleRate: number; label: string } | null
): Promise<PlaybackSpectra> {
  let dry = music.data;
  if (music.sampleRate !== sampleRate) {
    dry = resampleLinear(dry, music.sampleRate, sampleRate);
  } else {
    dry = dry.slice();
  }

  if (!ir || ir.data.length === 0) {
    const dryResult = welchSingle(dry, sampleRate);
    const limited = limitFrequencyRange(dryResult.freqs, 20, 20000, [dryResult.psd]);
    const dryDb = powerArrayToDb(limited.arrays[0]);
    return {
      freqs: limited.freqs,
      dryDb,
      wetDb: null,
      hasIR: false,
    };
  }

  let irData = ir.data;
  if (ir.sampleRate !== sampleRate) {
    irData = resampleLinear(irData, ir.sampleRate, sampleRate);
  } else {
    irData = irData.slice();
  }

  irData = normalizeImpulseResponse(irData);

  const wetFull = convolveFFT(dry, irData);
  const dryLength = dry.length;
  const wetTrimmed = new Float32Array(dryLength);
  wetTrimmed.set(wetFull.subarray(0, dryLength));

  const dryRms = computeRms(dry);
  const wetRms = computeRms(wetTrimmed);
  if (wetRms > EPS) {
    const gain = dryRms / wetRms;
    for (let i = 0; i < wetTrimmed.length; i++) {
      wetTrimmed[i] *= gain;
    }
  }

  const pair = welchPair(dry, wetTrimmed, sampleRate);
  const limited = limitFrequencyRange(pair.freqs, 20, 20000, [pair.psdX, pair.psdY]);
  const dryDb = powerArrayToDb(limited.arrays[0]);
  const wetDb = powerArrayToDb(limited.arrays[1]);

  return {
    freqs: limited.freqs,
    dryDb,
    wetDb,
    hasIR: true,
  };
}

function applySmoothing(base: BaseSpectra, smoothing: SmoothingMode): BaseSpectra {
  const fraction = smoothing === "1/12" ? 12 : smoothing === "1/6" ? 6 : 3;
  return {
    freqs: base.freqs,
    pinkDb: applyFractionalSmoothing(base.freqs, base.pinkDb, fraction),
    convolvedDb: base.convolvedDb
      ? applyFractionalSmoothing(base.freqs, base.convolvedDb, fraction)
      : null,
    transferDb: base.transferDb
      ? applyFractionalSmoothing(base.freqs, base.transferDb, fraction)
      : null,
    hasIR: base.hasIR,
    irLabel: base.irLabel,
  };
}

function applyPlaybackSmoothing(base: PlaybackSpectra, smoothing: SmoothingMode): PlaybackSpectra {
  const fraction = smoothing === "1/12" ? 12 : smoothing === "1/6" ? 6 : 3;
  return {
    freqs: base.freqs,
    dryDb: applyFractionalSmoothing(base.freqs, base.dryDb, fraction),
    wetDb: base.wetDb ? applyFractionalSmoothing(base.freqs, base.wetDb, fraction) : null,
    hasIR: base.hasIR,
  };
}

function generatePinkNoise(sampleRate: number, durationSeconds: number): Float32Array {
  const totalSamples = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const rows = 16;
  const rowsBuffer = new Float32Array(rows);
  let runningSum = 0;
  for (let i = 0; i < rows; i++) {
    const value = Math.random() * 2 - 1;
    rowsBuffer[i] = value;
    runningSum += value;
  }

  const output = new Float32Array(totalSamples);
  const maxKey = (1 << rows) - 1;
  let key = 0;
  for (let i = 0; i < totalSamples; i++) {
    key = (key + 1) & maxKey;
    let diff = key ^ ((key - 1) & maxKey);
    let bitIndex = 0;
    while (diff) {
      if (diff & 1) {
        runningSum -= rowsBuffer[bitIndex];
        const rand = Math.random() * 2 - 1;
        rowsBuffer[bitIndex] = rand;
        runningSum += rand;
      }
      diff >>= 1;
      bitIndex++;
    }
    const white = Math.random() * 2 - 1;
    output[i] = (runningSum + white) / (rows + 1);
  }

  return output;
}

const hannCache = new Map<number, { window: Float32Array; power: number }>();

function getHann(size: number): { window: Float32Array; power: number } {
  let cached = hannCache.get(size);
  if (!cached) {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    let power = 0;
    for (let i = 0; i < size; i++) {
      power += window[i] * window[i];
    }
    power /= size;
    cached = { window, power };
    hannCache.set(size, cached);
  }
  return cached;
}

function welchSingle(signal: Float32Array, sampleRate: number) {
  const result = welchCore(signal, null, sampleRate);
  return { freqs: result.freqs, psd: result.psdX };
}

function pickWelchSegmentSize(length: number): number {
  const MAX_SIZE = 65536;
  if (length >= MAX_SIZE) return MAX_SIZE;
  if (length <= 0) return 0;
  const power = Math.floor(Math.log2(length));
  if (power <= 0) return 0;
  return 1 << power;
}

function welchPair(x: Float32Array, y: Float32Array, sampleRate: number) {
  const result = welchCore(x, y, sampleRate);
  if (!result.psdY || !result.transfer) {
    throw new Error("Welch pair computation failed");
  }
  return { freqs: result.freqs, psdX: result.psdX, psdY: result.psdY, transfer: result.transfer };
}

function welchCore(x: Float32Array, y: Float32Array | null, sampleRate: number) {
  const nperseg = pickWelchSegmentSize(x.length);
  if (nperseg < 32) {
    throw new Error("Signal too short for Welch analysis");
  }
  const step = Math.max(1, nperseg >> 1);
  if (y && y.length < nperseg) {
    throw new Error("Signal too short for Welch analysis");
  }
  const segments = Math.floor((x.length - nperseg) / step) + 1;
  const { window, power } = getHann(nperseg);
  const fft = new FFT(nperseg);
  const specX = fft.createComplexArray();
  const specY = y ? fft.createComplexArray() : null;
  const segmentX = new Float32Array(nperseg);
  const segmentY = y ? new Float32Array(nperseg) : null;
  const half = nperseg >> 1;
  const bins = half + 1;
  const psdX = new Float32Array(bins);
  const psdY = y ? new Float32Array(bins) : null;
  const sxyReal = y ? new Float32Array(bins) : null;
  const sxyImag = y ? new Float32Array(bins) : null;

  for (let seg = 0; seg < segments; seg++) {
    const start = seg * step;
    for (let i = 0; i < nperseg; i++) {
      segmentX[i] = x[start + i] * window[i];
      if (segmentY) segmentY[i] = y![start + i] * window[i];
    }

    fft.realTransform(specX, segmentX);
    fft.completeSpectrum(specX);

    if (specY && segmentY) {
      fft.realTransform(specY, segmentY);
      fft.completeSpectrum(specY);
    }

    for (let k = 0; k < bins; k++) {
      const xr = specX[2 * k];
      const xi = specX[2 * k + 1];
      psdX[k] += xr * xr + xi * xi;
      if (specY && sxyReal && sxyImag && psdY) {
        const yr = specY[2 * k];
        const yi = specY[2 * k + 1];
        psdY[k] += yr * yr + yi * yi;
        sxyReal[k] += yr * xr + yi * xi;
        sxyImag[k] += yi * xr - yr * xi;
      }
    }
  }

  const norm = 1 / (power * segments * nperseg);
  for (let k = 0; k < psdX.length; k++) {
    psdX[k] *= norm;
    if (psdY) {
      psdY[k] *= norm;
    }
    if (sxyReal && sxyImag) {
      sxyReal[k] *= norm;
      sxyImag[k] *= norm;
    }
  }

  const freqs = new Float32Array(psdX.length);
  for (let k = 0; k < freqs.length; k++) {
    freqs[k] = (k * sampleRate) / nperseg;
  }

  const transfer = sxyReal && sxyImag ? new Float32Array(psdX.length) : null;
  if (
    transfer &&
    psdX.length === psdY?.length &&
    sxyReal !== null &&
    sxyImag !== null
  ) {
    for (let k = 0; k < transfer.length; k++) {
      const mag = Math.sqrt(sxyReal[k] * sxyReal[k] + sxyImag[k] * sxyImag[k]);
      transfer[k] = mag / (psdX[k] + EPS);
    }
  }

  return { freqs, psdX, psdY, transfer };
}

function limitFrequencyRange(
  freqs: Float32Array,
  minHz: number,
  maxHz: number,
  arrays: Float32Array[]
): { freqs: Float32Array; arrays: Float32Array[] } {
  let start = 0;
  while (start < freqs.length && freqs[start] < minHz) start++;
  let end = freqs.length - 1;
  while (end >= start && freqs[end] > maxHz) end--;
  const length = Math.max(0, end - start + 1);
  if (length <= 0) {
    return { freqs: new Float32Array(0), arrays: arrays.map(() => new Float32Array(0)) };
  }
  const freqSlice = freqs.slice(start, end + 1);
  const sliced = arrays.map((arr) => arr.slice(start, end + 1));
  return { freqs: freqSlice, arrays: sliced };
}

function powerArrayToDb(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = 10 * Math.log10(Math.max(arr[i], EPS));
  }
  return out;
}

function amplitudeArrayToDb(arr: Float32Array): Float32Array {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = 20 * Math.log10(Math.max(arr[i], EPS));
  }
  return out;
}

function applyFractionalSmoothing(
  freqs: Float32Array,
  valuesDb: Float32Array,
  fraction: number
): Float32Array {
  if (fraction <= 0 || freqs.length === 0) return valuesDb.slice();
  const len = freqs.length;
  const linear = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    linear[i] = Math.pow(10, valuesDb[i] / 20);
  }
  const result = new Float32Array(len);
  const half = 0.5 / fraction;
  let start = 0;
  let end = 0;
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const f = freqs[i];
    const minF = f * Math.pow(2, -half);
    const maxF = f * Math.pow(2, half);
    while (start < len && freqs[start] < minF) {
      sum -= linear[start];
      start++;
    }
    while (end < len && freqs[end] <= maxF) {
      sum += linear[end];
      end++;
    }
    const count = end - start;
    const mean = count > 0 ? sum / count : linear[i];
    result[i] = 20 * Math.log10(Math.max(mean, EPS));
  }
  return result;
}

const fftCache = new Map<number, FFT>();

function getFFT(size: number): FFT {
  let fft = fftCache.get(size);
  if (!fft) {
    fft = new FFT(size);
    fftCache.set(size, fft);
  }
  return fft;
}

function convolveFFT(signal: Float32Array, ir: Float32Array): Float32Array {
  const convLen = signal.length + ir.length - 1;
  const fftSize = nextPow2(convLen);
  const fft = getFFT(fftSize);

  const paddedSignal = new Float32Array(fftSize);
  paddedSignal.set(signal);
  const paddedIR = new Float32Array(fftSize);
  paddedIR.set(ir);

  const specSignal = fft.createComplexArray();
  fft.realTransform(specSignal, paddedSignal);
  fft.completeSpectrum(specSignal);

  const specIR = fft.createComplexArray();
  fft.realTransform(specIR, paddedIR);
  fft.completeSpectrum(specIR);

  for (let i = 0; i < specSignal.length; i += 2) {
    const sr = specSignal[i];
    const si = specSignal[i + 1];
    const irR = specIR[i];
    const irI = specIR[i + 1];
    specSignal[i] = sr * irR - si * irI;
    specSignal[i + 1] = sr * irI + si * irR;
  }

  const complexOut = fft.createComplexArray();
  fft.inverseTransform(complexOut, specSignal);
  const result = new Float32Array(convLen);
  fft.fromComplexArray(complexOut, result);
  const scale = 1 / fftSize;
  for (let i = 0; i < convLen; i++) {
    result[i] *= scale;
  }
  return result;
}

function padToLength(data: Float32Array, length: number): Float32Array {
  if (data.length >= length) return data.slice(0, length);
  const out = new Float32Array(length);
  out.set(data);
  return out;
}

function nextPow2(value: number): number {
  return 1 << Math.ceil(Math.log2(value));
}


function computeRms(data: Float32Array): number {
  if (data.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sumSquares += v * v;
  }
  return Math.sqrt(sumSquares / data.length);
}

function normalizeImpulseResponse(data: Float32Array): Float32Array {
  if (data.length === 0) return data;
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sumSquares += v * v;
  }
  if (sumSquares <= 0) {
    return data;
  }
  const l2Norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(l2Norm) || l2Norm <= 0) {
    return data;
  }
  const gain = 1 / l2Norm;
  for (let i = 0; i < data.length; i++) {
    data[i] *= gain;
  }
  return data;
}

function resampleLinear(data: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return data.slice();
  const duration = data.length / srcRate;
  const newLength = Math.max(1, Math.round(duration * dstRate));
  const out = new Float32Array(newLength);
  const ratio = srcRate / dstRate;
  for (let i = 0; i < newLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = data[Math.min(idx, data.length - 1)];
    const s1 = data[Math.min(idx + 1, data.length - 1)];
    out[i] = s0 + (s1 - s0) * frac;
  }
  return out;
}

function hashFloatArray(data: Float32Array, sampleRate: number): string {
  let hash = 2166136261 >>> 0;
  const len = data.length;
  const stride = Math.max(1, Math.floor(len / 8192));
  for (let i = 0; i < len; i += stride) {
    const val = data[i];
    const scaled = Math.floor((val + 1) * 32767) & 0xffff;
    hash ^= scaled;
    hash = Math.imul(hash, 16777619);
  }
  return `${sampleRate}-${len}-${hash >>> 0}`;
}

export {};
